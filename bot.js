// bot.js (CommonJS) — Beautiful Buttons UI + MarkdownV2-safe + Cron Alerts
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch');
const cron = require('node-cron');

// --- env/config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN in .env');

const DEFAULT_SYMBOL = (process.env.DEFAULT_SYMBOL || 'BTCUSDT').toUpperCase();
const DEFAULT_TF = process.env.DEFAULT_TF || '5m';
const ALERT_CHAT_ID_ENV = process.env.ALERT_CHAT_ID || '';
const ALERT_CRON = process.env.ALERT_INTERVAL_CRON || '*/5 * * * *'; // every 5m

// Binance-supported intervals (whitelist)
const VALID_TFS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];
// Show these nice timeframes as buttons
const TFS = ['1m','5m','15m','30m','1h'];
// Quick symbols as buttons (you can add more)
const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT'];

// In-memory session (simple)
const sessions = new Map(); // key: chatId -> { sym, tf, auto }

// ---- helpers: UI prettifiers & MarkdownV2 ----
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

function escapeMdV2(str){
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ---- data & indicators ----
async function fetchKlinesBinance(symbol='BTCUSDT', tf='5m', limit=500) {
  if (!VALID_TFS.includes(tf)) {
    throw new Error(`Invalid TF: ${tf}. Use one of: ${VALID_TFS.join(', ')}`);
  }
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Binance error ${res.status} → ${txt}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error(`Binance returned: ${JSON.stringify(raw)}`);
  return raw.map(r => ({
    time: r[0],
    open: +r[1],
    high: +r[2],
    low: +r[3],
    close: +r[4],
    volume: +r[5]
  }));
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev;
  return values.map((v, i) => (prev = i ? (v - prev) * k + prev : v));
}
function rsi(closes, period = 14) {
  let gains = 0, losses = 0;
  const out = new Array(closes.length).fill(null);
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(0, d), l = Math.max(0, -d);
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function atr(ohlc, period = 14) {
  const tr = ohlc.map((c, i) =>
    i
      ? Math.max(
          c.high - c.low,
          Math.abs(c.high - ohlc[i - 1].close),
          Math.abs(c.low - ohlc[i - 1].close)
        )
      : c.high - c.low
  );
  const out = [];
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

// Compact mini-score (TA proxy). (You already plan OF/liq later.)
function miniScore(ohlc) {
  const closes = ohlc.map(x => x.close);
  const ema50 = ema(closes, 50).at(-1);
  const ema200 = ema(closes, 200).at(-1);
  const rsi14 = rsi(closes, 14).at(-1) ?? 50;
  const atr14 = atr(ohlc, 14).at(-1) ?? (ohlc.at(-1).high - ohlc.at(-1).low);

  const trend = ema50 > ema200 ? 1 : -1;
  const mom   = rsi14 > 55 ? 1 : rsi14 < 45 ? -1 : 0;

  const bodies = ohlc.slice(-30).map(c => Math.abs(c.close - c.open));
  const avgBody = bodies.reduce((a,b)=>a+b,0) / bodies.length;
  const lastBody = Math.abs(ohlc.at(-1).close - ohlc.at(-1).open);
  const liq = lastBody > avgBody ? 1 : -1;

  const total = trend + mom + liq; // -3..+3
  const dir = total >= 0 ? 'LONG' : 'SHORT';
  const prob = Math.round(60 + (Math.abs(total) / 3) * 30); // 60–90

  return { dir, prob, rsi14: Math.round(rsi14), ema50, ema200, atr14 };
}

// Signal formatter (MarkdownV2)
function formatSignal(sym, tf, s, px) {
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

// ---- Telegram bot ----
const bot = new Telegraf(BOT_TOKEN);

// Session helper
function ensureSession(chatId){
  if (!sessions.has(chatId)) sessions.set(chatId, { sym: DEFAULT_SYMBOL, tf: DEFAULT_TF, auto: false });
  return sessions.get(chatId);
}

// Keyboards
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

// Start
bot.start(async ctx => {
  const chatId = String(ctx.chat.id);
  ensureSession(chatId);
  await ctx.reply(
    escapeMdV2(`👋 Welcome! Tap buttons to choose *Symbol* & *Timeframe*, then "Scan now".`),
    mainMenuKeyboard(chatId)
  );
});

// Menu refresh (useful if markup mismatch)
bot.action('menu:refresh', async ctx => {
  const chatId = String(ctx.chat.id);
  try {
    await ctx.editMessageReplyMarkup(mainMenuKeyboard(chatId).reply_markup);
  } catch (e) {
    // If "message is not modified", just ignore; otherwise log
    if (!String(e?.description || '').includes('message is not modified')) {
      console.error('editMessageReplyMarkup error:', e);
    }
    // Fallback: send a new menu
    await ctx.reply(escapeMdV2('📋 Menu refreshed'), mainMenuKeyboard(chatId));
  }
  await ctx.answerCbQuery('Menu updated');
});

// Show chat id
bot.action('menu:id', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(escapeMdV2(`🆔 Chat ID: ${ctx.chat.id}`), { parse_mode: 'MarkdownV2' });
});

// Symbol selector
bot.action(/^sym:(.+)$/, async ctx => {
  const chatId = String(ctx.chat.id);
  const sym = ctx.match[1];
  const s = ensureSession(chatId);
  if (s.sym === sym) {
    await ctx.answerCbQuery(`Already ${sym}`);
    return;
  }
  s.sym = sym;
  sessions.set(chatId, s);
  try {
    await ctx.editMessageReplyMarkup(mainMenuKeyboard(chatId).reply_markup);
  } catch (e) {
    if (!String(e?.description || '').includes('message is not modified')) {
      console.error('symbol edit error:', e);
    }
  }
  await ctx.answerCbQuery(`Symbol → ${sym}`);
});

// Timeframe selector
bot.action(/^tf:(.+)$/, async ctx => {
  const chatId = String(ctx.chat.id);
  const tf = ctx.match[1];
  if (!VALID_TFS.includes(tf)) {
    await ctx.answerCbQuery('Invalid TF');
    return;
  }
  const s = ensureSession(chatId);
  if (s.tf === tf) {
    await ctx.answerCbQuery(`Already ${tf}`);
    return;
  }
  s.tf = tf;
  sessions.set(chatId, s);
  try {
    await ctx.editMessageReplyMarkup(mainMenuKeyboard(chatId).reply_markup);
  } catch (e) {
    if (!String(e?.description || '').includes('message is not modified')) {
      console.error('tf edit error:', e);
    }
  }
  await ctx.answerCbQuery(`Timeframe → ${tf}`);
});

// Auto toggle
bot.action('auto:toggle', async ctx => {
  const chatId = String(ctx.chat.id);
  const s = ensureSession(chatId);
  s.auto = !s.auto;
  sessions.set(chatId, s);
  try {
    await ctx.editMessageReplyMarkup(mainMenuKeyboard(chatId).reply_markup);
  } catch (e) {
    if (!String(e?.description || '').includes('message is not modified')) {
      console.error('auto toggle edit error:', e);
    }
  }
  await ctx.answerCbQuery(s.auto ? 'Auto ON' : 'Auto OFF');
  await ctx.reply(escapeMdV2(`${s.auto ? '🔔 Auto alerts ON' : '🔕 Auto alerts OFF'} for ${s.sym} ${s.tf} (cron: ${ALERT_CRON})`), { parse_mode: 'MarkdownV2' });
});

// Scan button
bot.action('scan', async ctx => {
  const chatId = String(ctx.chat.id);
  await ctx.answerCbQuery('Scanning…');
  await sendSignalToChat(chatId);
});

// (Optional) text fallback: "menu" or "scan"
bot.hears(/^(menu|Menu)$/i, async ctx => {
  const chatId = String(ctx.chat.id);
  await ctx.reply(escapeMdV2('📋 Menu'), mainMenuKeyboard(chatId));
});
bot.hears(/^(scan|Scan)$/i, async ctx => {
  await sendSignalToChat(String(ctx.chat.id));
});

// ---- Core sending function ----
async function sendSignalToChat(chatId) {
  try {
    const s = ensureSession(chatId);
    const sym = (s.sym || DEFAULT_SYMBOL).toUpperCase();
    const tf = s.tf || DEFAULT_TF;

    await bot.telegram.sendMessage(chatId, escapeMdV2(`⏳ Fetching ${sym} ${tf}…`), { parse_mode: 'MarkdownV2' });
    const ohlc = await fetchKlinesBinance(sym, tf, 500);
    const ms = miniScore(ohlc);
    const px = ohlc.at(-1).close;
    const text = formatSignal(sym, tf, ms, px);

    await bot.telegram.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.telegram.sendMessage(chatId, escapeMdV2(`❌ Error: ${e.message}`), { parse_mode: 'MarkdownV2' });
  }
}

// ---- Cron: periodic alerts to opted-in chats ----
cron.schedule(ALERT_CRON, async () => {
  for (const [chatId, s] of sessions.entries()) {
    if (s.auto) await sendSignalToChat(chatId);
  }
  // optional single target via .env (e.g., your private chat id)
  if (ALERT_CHAT_ID_ENV) {
    const chatId = String(ALERT_CHAT_ID_ENV);
    const have = sessions.get(chatId) || { sym: DEFAULT_SYMBOL, tf: DEFAULT_TF, auto: true };
    sessions.set(chatId, { ...have, auto: true });
    await sendSignalToChat(chatId);
  }
});

bot.launch().then(() => console.log('Telegram bot running ✅'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
