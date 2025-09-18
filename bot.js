
// bot.js (CommonJS) — Buttons UI + MarkdownV2-safe + Cron Alerts + Multi-Exchange REST Fallback
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch');
const cron = require('node-cron');

// --- env/config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN in .env / Render Environment');

const DEFAULT_SYMBOL = (process.env.DEFAULT_SYMBOL || 'BTCUSDT').toUpperCase();
const DEFAULT_TF = process.env.DEFAULT_TF || '5m';
const ALERT_CHAT_ID_ENV = process.env.ALERT_CHAT_ID || '';
const ALERT_CRON = process.env.ALERT_INTERVAL_CRON || '*/5 * * * *'; // every 5m

// Which data sources to try, in order (change via env without editing code)
const DATA_SOURCES = (process.env.DATA_SOURCES || 'BINANCE,BINANCE_US,BYBIT')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

// ---- constants ----
const VALID_TFS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M']; // shared list
const TFS = ['1m','5m','15m','30m','1h'];          // buttons shown
const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT'];   // quick symbol buttons

// In-memory session
const sessions = new Map(); // chatId -> { sym, tf, auto }

// ---- UI helpers ----
function escapeMdV2(str){ return String(str).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }
const PRETTY_SYMBOL = s =>
  s === 'BTCUSDT' ? '₿ BTC' :
  s === 'ETHUSDT' ? '◆ ETH' :
  s === 'SOLUSDT' ? '◎ SOL' : s;

const PRETTY_TF = tf => ({
  '1m':'1m • scalps',
  '5m':'5m • intraday',
  '15m':'15m • momentum',
  '30m':'30m • rhythm',
  '1h':'1h • swing'
}[tf] || tf);

// ---- Indicator utils ----
function ema(values, period){
  const k = 2 / (period + 1);
  let prev;
  return values.map((v, i) => (prev = i ? (v - prev) * k + prev : v));
}
function rsi(closes, period = 14){
  let gains = 0, losses = 0;
  const out = new Array(closes.length).fill(null);
  for (let i = 1; i <= period; i++){
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++){
    const d = closes[i] - closes[i - 1];
    const g = Math.max(0, d), l = Math.max(0, -d);
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function atr(ohlc, period = 14){
  const tr = ohlc.map((c, i) =>
    i ? Math.max(
      c.high - c.low,
      Math.abs(c.high - ohlc[i - 1].close),
      Math.abs(c.low - ohlc[i - 1].close)
    ) : c.high - c.low
  );
  const out = []; let sum = 0;
  for (let i = 0; i < tr.length; i++){
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

// ---- Data fetchers (REST only, resilient) ----
const BINANCE_BASES = [
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api.binance.com' // last resort
];

function tfToBybit(tf){
  // Bybit v5 intervals: 1 3 5 15 30 60 120 240 360 720 D 3D W M (+ 480 for 8h)
  const map = { '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1h':'60','2h':'120','4h':'240','6h':'360','8h':'480','12h':'720','1d':'D','3d':'3D','1w':'W','1M':'M' };
  if (!map[tf]) throw new Error(`TF ${tf} not supported by Bybit`);
  return map[tf];
}

/** Unified OHLC fetcher that tries sources in DATA_SOURCES order */
async function fetchKlinesUnified(symbol='BTCUSDT', tf='5m', limit=500){
  let lastErr;
  for (const src of DATA_SOURCES){
    try {
      if (src === 'BINANCE'){
        for (const base of BINANCE_BASES){
          const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
          const res = await fetch(url, { timeout: 15000 });
          if (!res.ok){
            const txt = await res.text().catch(()=> '');
            // 451/403 → likely geo-block
            throw new Error(`BINANCE ${res.status}: ${txt}`);
          }
          const raw = await res.json();
          if (!Array.isArray(raw)) throw new Error(`BINANCE non-array: ${JSON.stringify(raw)}`);
          return raw.map(r => ({ time:r[0], open:+r[1], high:+r[2], low:+r[3], close:+r[4], volume:+r[5] }));
        }
        throw new Error('BINANCE endpoints exhausted');
      }
      if (src === 'BINANCE_US'){
        const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
        const res = await fetch(url, { timeout: 15000 });
        if (!res.ok){
          const txt = await res.text().catch(()=> '');
          throw new Error(`BINANCE_US ${res.status}: ${txt}`);
        }
        const raw = await res.json();
        return raw.map(r => ({ time:r[0], open:+r[1], high:+r[2], low:+r[3], close:+r[4], volume:+r[5] }));
      }
      if (src === 'BYBIT'){
        const interval = tfToBybit(tf);
        // linear (USDT perps) category works with BTCUSDT/ETHUSDT
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${Math.min(limit,200)}`;
        const res = await fetch(url, { timeout: 15000 });
        if (!res.ok){
          const txt = await res.text().catch(()=> '');
          throw new Error(`BYBIT ${res.status}: ${txt}`);
        }
        const data = await res.json();
        if (data.retCode !== 0 || !Array.isArray(data.result?.list)){
          throw new Error(`BYBIT retCode ${data.retCode}: ${JSON.stringify(data)}`);
        }
        // newest first → reverse
        const arr = data.result.list.slice().reverse();
        return arr.map(r => ({ time:+r[0], open:+r[1], high:+r[2], low:+r[3], close:+r[4], volume:+r[5] }));
      }
      throw new Error(`Unknown data source ${src}`);
    } catch (e){
      lastErr = e;
      // try next source
    }
  }
  throw new Error(`All data sources failed: ${lastErr?.message || lastErr}`);
}

// ---- Mini scoring (trend + momentum + vol proxy) ----
function miniScore(ohlc){
  const closes = ohlc.map(x => x.close);
  const ema50 = ema(closes, 50).at(-1);
  const ema200 = ema(closes, 200).at(-1);
  const rsi14 = rsi(closes, 14).at(-1) ?? 50;
  const atr14 = atr(ohlc, 14).at(-1) ?? (ohlc.at(-1).high - ohlc.at(-1).low);

  const trend = ema50 > ema200 ? 1 : -1;
  const mom   = rsi14 > 55 ? 1 : rsi14 < 45 ? -1 : 0;

  const bodies = ohlc.slice(-30).map(c => Math.abs(c.close - c.open));
  const avgBody = bodies.reduce((a,b)=>a+b,0) / bodies.length || 0.0001;
  const lastBody = Math.abs(ohlc.at(-1).close - ohlc.at(-1).open);
  const liq = lastBody > avgBody ? 1 : -1;

  const total = trend + mom + liq; // -3..+3
  const dir = total >= 0 ? 'LONG' : 'SHORT';
  const prob = Math.round(60 + (Math.abs(total) / 3) * 30); // 60–90

  return { dir, prob, rsi14: Math.round(rsi14), ema50, ema200, atr14 };
}

function formatSignal(sym, tf, s, px){
  const SL = s.dir === 'LONG' ? px - 1.2 * s.atr14 : px + 1.2 * s.atr14;
  const TP = s.dir === 'LONG' ? px + 2.0 * s.atr14 : px - 2.0 * s.atr14;
  const lines = [
    `📈 ${sym} ${tf}`,
    `Direction: ${s.dir} | Probability: ${s.prob}%`,
    `Entry≈ ${px.toFixed(2)} | SL≈ ${SL.toFixed(2)} | TP≈ ${TP.toFixed(2)}`,
    `RSI14: ${s.rsi14} | EMA50 ${s.ema50.toFixed(2)} vs EMA200 ${s.ema200.toFixed(2)}`
  ];
  return escapeMdV2(lines.join('\n'));
}

// ---- Bot UI ----
const bot = new Telegraf(BOT_TOKEN);

function ensureSession(chatId){
  if (!sessions.has(chatId)) sessions.set(chatId, { sym: DEFAULT_SYMBOL, tf: DEFAULT_TF, auto: false });
  return sessions.get(chatId);
}

function mainMenuKeyboard(chatId){
  const s = ensureSession(chatId);
  const symbolRow = SYMBOLS.map(sym => {
    const sel = sym === s.sym ? '✅ ' : '';
    return Markup.button.callback(`${sel}${PRETTY_SYMBOL(sym)}`, `sym:${sym}`);
  });
  const tfRow = TFS.map(t => {
    const sel = t === s.tf ? '✅ ' : '';
    return Markup.button.callback(`${sel}${PRETTY_TF(t)}`, `tf:${t}`);
  });
  const actionRow1 = [
    Markup.button.callback('🔄 Scan now', 'scan'),
    Markup.button.callback(s.auto ? '🔔 Auto: ON' : '🔕 Auto: OFF', 'auto:toggle')
  ];
  const actionRow2 = [
    Markup.button.callback('🧭 Refresh Menu', 'menu:refresh'),
    Markup.button.callback('🆔 Show Chat ID', 'menu:id')
  ];
  return Markup.inlineKeyboard([symbolRow, tfRow, actionRow1, actionRow2]);
}

// start
bot.start(async ctx => {
  const chatId = String(ctx.chat.id);
  ensureSession(chatId);
  await ctx.reply(
    escapeMdV2(`👋 Welcome! Choose *Symbol* & *Timeframe*, then tap "Scan now".`),
    mainMenuKeyboard(chatId)
  );
});

// menu refresh
bot.action('menu:refresh', async ctx => {
  const chatId = String(ctx.chat.id);
  try {
    await ctx.editMessageReplyMarkup(mainMenuKeyboard(chatId).reply_markup);
  } catch (e) {
    if (!String(e?.description || '').includes('not modified')) console.error('menu refresh:', e);
    await ctx.reply(escapeMdV2('📋 Menu refreshed'), mainMenuKeyboard(chatId));
  }
  await ctx.answerCbQuery('Menu updated');
});

bot.action('menu:id', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(escapeMdV2(`🆔 Chat ID: ${ctx.chat.id}`), { parse_mode: 'MarkdownV2' });
});

// symbol & timeframe handlers
bot.action(/^sym:(.+)$/, async ctx => {
  const chatId = String(ctx.chat.id);
  const sym = ctx.match[1];
  const s = ensureSession(chatId);
  if (s.sym === sym) return ctx.answerCbQuery(`Already ${sym}`);
  s.sym = sym; sessions.set(chatId, s);
  try { await ctx.editMessageReplyMarkup(mainMenuKeyboard(chatId).reply_markup); } catch {}
  await ctx.answerCbQuery(`Symbol → ${sym}`);
});

bot.action(/^tf:(.+)$/, async ctx => {
  const chatId = String(ctx.chat.id);
  const tf = ctx.match[1];
  if (!VALID_TFS.includes(tf)) return ctx.answerCbQuery('Invalid TF');
  const s = ensureSession(chatId);
  if (s.tf === tf) return ctx.answerCbQuery(`Already ${tf}`);
  s.tf = tf; sessions.set(chatId, s);
  try { await ctx.editMessageReplyMarkup(mainMenuKeyboard(chatId).reply_markup); } catch {}
  await ctx.answerCbQuery(`Timeframe → ${tf}`);
});

// auto toggle
bot.action('auto:toggle', async ctx => {
  const chatId = String(ctx.chat.id);
  const s = ensureSession(chatId);
  s.auto = !s.auto; sessions.set(chatId, s);
  try { await ctx.editMessageReplyMarkup(mainMenuKeyboard(chatId).reply_markup); } catch {}
  await ctx.answerCbQuery(s.auto ? 'Auto ON' : 'Auto OFF');
  await ctx.reply(escapeMdV2(`${s.auto ? '🔔 Auto alerts ON' : '🔕 Auto alerts OFF'} for ${s.sym} ${s.tf} (cron: ${ALERT_CRON})`), { parse_mode: 'MarkdownV2' });
});

// scan
bot.action('scan', async ctx => {
  await ctx.answerCbQuery('Scanning…');
  await sendSignalToChat(String(ctx.chat.id));
});

// text fallbacks
bot.hears(/^(menu|Menu)$/i, async ctx => ctx.reply(escapeMdV2('📋 Menu'), mainMenuKeyboard(String(ctx.chat.id))));
bot.hears(/^(scan|Scan)$/i, async ctx => sendSignalToChat(String(ctx.chat.id)));

// core signal function
async function sendSignalToChat(chatId){
  try {
    const s = ensureSession(chatId);
    const sym = (s.sym || DEFAULT_SYMBOL).toUpperCase();
    const tf = s.tf || DEFAULT_TF;

    await bot.telegram.sendMessage(chatId, escapeMdV2(`⏳ Fetching ${sym} ${tf}…`), { parse_mode: 'MarkdownV2' });
    const ohlc = await fetchKlinesUnified(sym, tf, 500);
    const ms = miniScore(ohlc);
    const px = ohlc.at(-1).close;
    const text = formatSignal(sym, tf, ms, px);

    await bot.telegram.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
  } catch (e){
    await bot.telegram.sendMessage(chatId, escapeMdV2(`❌ Error: ${e.message}`), { parse_mode: 'MarkdownV2' });
  }
}

// cron alerts
cron.schedule(ALERT_CRON, async () => {
  for (const [chatId, s] of sessions.entries()) {
    if (s.auto) await sendSignalToChat(chatId);
  }
  if (ALERT_CHAT_ID_ENV) {
    const chatId = String(ALERT_CHAT_ID_ENV);
    const have = sessions.get(chatId) || { sym: DEFAULT_SYMBOL, tf: DEFAULT_TF, auto: true };
    sessions.set(chatId, { ...have, auto: true });
    await sendSignalToChat(chatId);
  }
});

bot.launch().then(() => console.log('Telegram bot running ✅ (sources:', DATA_SOURCES.join('→'), ')'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
