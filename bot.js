// bot.js — Full-stack scanner with Binance-safe timeframes + MarkdownV2 escaping
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch'); // v2
const WebSocket = require('ws');

// ========= CONFIG =========
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");

const DEFAULT_TF = process.env.DEFAULT_TF || '5m';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];   // Binance symbols
const TFS = ['1m','5m','15m','1h','4h'];  // only valid Binance intervals
const VALID_TFS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];

// ========= TELEGRAM =========
const bot = new Telegraf(BOT_TOKEN);
const chatPrefs = new Map();
function prefs(chatId){
  if (!chatPrefs.has(chatId)) chatPrefs.set(chatId, { sym: 'BTCUSDT', tf: DEFAULT_TF });
  return chatPrefs.get(chatId);
}

// ========= STATE =========
const state = {};
function S(sym){
  if(!state[sym]) state[sym] = {
    spot:{ cvd:0, delta1s:0, lastSec:null },
    perp:{ cvd:0, delta1s:0, lastSec:null },
    spotMid:null, perpMid:null, premium:0,
    imbSpot:0, imbPerp:0,
    liq:{ longUsd5m:0, shortUsd5m:0, lastPrice:null, window:[] }
  };
  return state[sym];
}
const safeJSON = x=>{ try{return JSON.parse(x);}catch{return null;} };
function pruneLiqWindow(s){
  const now=Date.now();
  s.liq.window = s.liq.window.filter(x => now-x.ts <= 5*60*1000);
  s.liq.longUsd5m = s.liq.window.filter(x=>x.side==='long').reduce((a,b)=>a+b.usd,0);
  s.liq.shortUsd5m= s.liq.window.filter(x=>x.side==='short').reduce((a,b)=>a+b.usd,0);
}

// ========= WS CONNECTORS =========
function connectBinanceSpot(sym){
  const s=S(sym);
  new WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@aggTrade`)
    .on('message',buf=>{
      const t=safeJSON(buf.toString()); if(!t)return;
      const q=+t.q, isSell=t.m, sec=Math.floor(t.T/1000);
      if(s.spot.lastSec===null) s.spot.lastSec=sec;
      if(sec!==s.spot.lastSec){s.spot.delta1s=0;s.spot.lastSec=sec;}
      s.spot.delta1s+=(isSell?-q:+q); s.spot.cvd+=(isSell?-q:+q);
    });
  new WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@depth5@100ms`)
    .on('message',buf=>{
      const d=safeJSON(buf.toString()); if(!d)return;
      const bid=+d.bids?.[0]?.[0], ask=+d.asks?.[0]?.[0];
      if(bid&&ask) s.spotMid=(bid+ask)/2;
      const sum=a=>a.reduce((x,[,q])=>x+ +q,0);
      const tb=sum(d.bids||[]), ta=sum(d.asks||[]);
      s.imbSpot=(tb-ta)/Math.max(tb+ta,1e-9);
      if(s.spotMid&&s.perpMid) s.premium=s.perpMid-s.spotMid;
    });
}
function connectBinancePerp(sym){
  const s=S(sym);
  new WebSocket(`wss://fstream.binance.com/ws/${sym.toLowerCase()}@aggTrade`)
    .on('message',buf=>{
      const t=safeJSON(buf.toString()); if(!t)return;
      const q=+t.q,isSell=t.m,sec=Math.floor(t.T/1000);
      if(s.perp.lastSec===null) s.perp.lastSec=sec;
      if(sec!==s.perp.lastSec){s.perp.delta1s=0;s.perp.lastSec=sec;}
      s.perp.delta1s+=(isSell?-q:+q); s.perp.cvd+=(isSell?-q:+q);
    });
  new WebSocket(`wss://fstream.binance.com/ws/${sym.toLowerCase()}@depth5@100ms`)
    .on('message',buf=>{
      const d=safeJSON(buf.toString()); if(!d)return;
      const bid=+d.bids?.[0]?.[0], ask=+d.asks?.[0]?.[0];
      if(bid&&ask) s.perpMid=(bid+ask)/2;
      const sum=a=>a.reduce((x,[,q])=>x+ +q,0);
      const tb=sum(d.bids||[]), ta=sum(d.asks||[]);
      s.imbPerp=(tb-ta)/Math.max(tb+ta,1e-9);
      if(s.spotMid&&s.perpMid) s.premium=s.perpMid-s.spotMid;
    });
}
function connectBybitLiq(sym){
  const s=S(sym);
  const ws=new WebSocket('wss://stream.bybit.com/v5/public/linear');
  ws.on('open',()=>ws.send(JSON.stringify({op:'subscribe',args:[{topic:'liquidation',symbol:sym}]})));
  ws.on('message',buf=>{
    const m=safeJSON(buf.toString()); if(!m)return;
    const arr=Array.isArray(m.data)?m.data:m.data?.data||[];
    for(const it of arr){
      const price=+it.price||+it.p, qty=+it.qty||+it.size||0;
      const usd=price*qty, side=(it.side||'').toLowerCase().startsWith('sell')?'long':'short';
      s.liq.window.push({ts:Date.now(),side,usd,price});
      s.liq.lastPrice=price; pruneLiqWindow(s);
    }
  });
}
SYMBOLS.forEach(sym=>{connectBinanceSpot(sym);connectBinancePerp(sym);connectBybitLiq(sym);});

// ========= REST KLINES (safe) =========
async function fetchKlines(sym,tf,limit=300){
  if(!VALID_TFS.includes(tf)){
    throw new Error(`Invalid timeframe: ${tf}. Must be one of: ${VALID_TFS.join(', ')}`);
  }
  const url=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`;
  console.log("Fetching:", url);
  const res=await fetch(url);
  if(!res.ok){
    const txt = await res.text();
    throw new Error(`Binance API error: ${res.status} → ${txt}`);
  }
  const data=await res.json();
  if(!Array.isArray(data)){
    throw new Error(`Binance returned error: ${JSON.stringify(data)}`);
  }
  return data.map(r=>({o:+r[1],h:+r[2],l:+r[3],c:+r[4]}));
}

// ========= TA =========
// (ema, rsi, atr, swings, orderBlocks, fvg, sweeps) same as before…
// [omitted here for brevity but keep your existing implementations]

// ========= SIGNAL =========
// same generateSignal() as before (uses fetchKlines safely now)

// ========= FORMAT =========
// fmt(), escapeMd(), format() same as before

// ========= BUTTON UI =========
function symbolKeyboard(chatId){
  const p=prefs(chatId);
  return Markup.inlineKeyboard([
    SYMBOLS.map(s=>Markup.button.callback(`${s===p.sym?'✅ ':''}${s}`,`sym:${s}`)),
    [Markup.button.callback('⏱ Timeframe','tf:open'),Markup.button.callback('🔄 Scan','scan')]
  ]);
}
function timeframeKeyboard(chatId){
  const p=prefs(chatId);
  return Markup.inlineKeyboard([
    TFS.map(t=>Markup.button.callback(`${t===p.tf?'✅ ':''}${t}`,`tf:${t}`)),
    [Markup.button.callback('⬅️ Back','tf:back')]
  ]);
}

// start + actions… same as before
// with safe guards for symbol/timeframe selection
// and scan button using generateSignal()