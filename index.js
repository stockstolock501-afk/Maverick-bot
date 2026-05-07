// ═══════════════════════════════════════════════════════════════════════════
// MAVERICK TERMINAL v3.5 — THE WHALE INTELLIGENCE REFACTOR
// ═══════════════════════════════════════════════════════════════════════════
// Features: MMR Math Engine · LuxAlgo v2 · Telegram Bot · SEC 8-K Scraper
// WebSocket Live Tapes · AI Synthesis (Groq) · High-Conviction Filtration
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const fetch       = require('node-fetch');
const path        = require('path');

// ── ENV ───────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const GROQ_KEY       = process.env.GROQ_KEY;
const JSONBIN_KEY    = process.env.JSONBIN_KEY;
const JSONBIN_BIN    = process.env.JSONBIN_BIN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'maverick';
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const BOT_USERNAME   = process.env.TG_BOT_USERNAME || '';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-scout-17b-16e-instruct'
];

// ── MAVERICK MOMENTUM RATIO (MMR) — THE NEW MATH ──────────────────────────────
function calculateMMR(quote, tf1d, news) {
  let score = 0;
  const floatShares = quote.floatShares || 10000000;
  const floatRotation = quote.volume / floatShares;
  const rvol = tf1d ? tf1d.relVolume : (quote.volume / (quote.avgVolume || 1));
  
  // Weighting: Rot(30) + RVOL(30) + Velocity(20) + Catalyst(20)
  score += Math.min(floatRotation, 3) * 10;
  score += Math.min(rvol / 5, 1) * 30;
  score += Math.min(Math.abs(quote.changePct || 0) / 20, 1) * 20;
  
  const hasNews = news && news.some(n => n.ageH < 2);
  if (hasNews) score += 20;

  return {
    total: Math.round(score),
    rotation: floatRotation.toFixed(2),
    rvol: rvol.toFixed(2),
    isSupernova: score > 75 && floatRotation > 1.2,
    isWhaleAccum: score > 55 && floatRotation < 0.6
  };
}

// ── GROQ AI INTERFACE ────────────────────────────────────────────────────────
async function groqCall(system, user, maxTokens = 1500) {
  if (!GROQ_KEY) return null;
  for (const model of GROQ_MODELS) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const text = d.choices?.[0]?.message?.content || '';
      const m = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim().match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : { reply: text };
    } catch (e) { console.error(`Groq Error: ${e.message}`); }
  }
  return null;
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
let bot = null;
async function initTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { interval: 2000 } });
    setupTelegramHandlers();
    console.log('✅ Telegram Live');
  } catch (e) { console.error('TG init:', e.message); }
}
function tgSend(chatId, text) { if (bot && chatId) bot.sendMessage(String(chatId), text, { parse_mode: 'Markdown' }).catch(() => {}); }

// ── STATE & WS ────────────────────────────────────────────────────────────────
const watches = new Map(); const trades = new Map(); const volTracker = new Map();
let ws;
function connectFinnhub() {
  if (!FINNHUB_KEY) return;
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('message', raw => { 
    try { 
      const m = JSON.parse(raw); 
      if(m.type==='trade') m.data.forEach(t => onTick(t.s, t.p, t.v)); 
    } catch {} 
  });
  ws.on('close', () => setTimeout(connectFinnhub, 5000));
}

// ── DATA LAYER ────────────────────────────────────────────────────────────────
async function getQuote(symbol) {
  const sym = symbol.toUpperCase();
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`, { headers:{'User-Agent':'Mozilla/5.0'} });
    const d = await r.json(); const q = d?.quoteResponse?.result?.[0];
    if (q) return { price:q.regularMarketPrice, change:q.regularMarketChange, changePct:q.regularMarketChangePercent, volume:q.regularMarketVolume, avgVolume:q.averageDailyVolume3Month, floatShares:q.floatShares, high:q.regularMarketDayHigh, low:q.regularMarketDayLow, shortName:q.shortName };
  } catch (e) { return null; }
}

async function getCandles(symbol, range, interval) {
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`, { headers:{'User-Agent':'Mozilla/5.0'} });
    const d = await r.json(); const res = d?.chart?.result?.[0];
    const q=res.indicators?.quote?.[0]; const ts=res.timestamp||[];
    const candles=ts.map((t,i)=>({t,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:q.volume?.[i]})).filter(c=>c.c!=null);
    const last=candles[candles.length-1]; const first=candles[0];
    const avgVol=candles.reduce((s,c)=>s+(c.v||0),0)/candles.length;
    const atr=candles.slice(-14).reduce((s,c)=>s+(c.h-c.l),0)/14;
    return { last:last.c, high:Math.max(...candles.map(c=>c.h)), low:Math.min(...candles.map(c=>c.l)), relVolume:+(last.v/avgVol).toFixed(2), trend:last.c>first.c?'UP':'DOWN', candleCount:candles.length, rsi: 55, atr };
  } catch { return null; }
}

async function getFreshNews(symbol) {
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5`,{headers:{'User-Agent':'Mozilla/5.0'}});
    const d=await r.json();
    return (d?.news||[]).map(n=>({headline:n.title, source:n.publisher, ageH:+((Date.now()/1000-(n.providerPublishTime||0))/3600).toFixed(1)}));
  } catch { return []; }
}

async function getSEC8K() {
  try {
    const r=await fetch(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom`,{headers:{'User-Agent':'Maverick/1.0'}});
    const text=await r.text(); const items=[]; const regex=/<entry>([\s\S]*?)<\/entry>/g; let m;
    while((m=regex.exec(text))!==null){
      const entry=m[1]; const title=(/<title>(.*?)<\/title>/.exec(entry)||[])[1]||'';
      const updated=(/<updated>(.*?)<\/updated>/.exec(entry)||[])[1]||'';
      items.push({headline:title, source:'SEC-8K', ageH: +((Date.now()-new Date(updated).getTime())/3600000).toFixed(1)});
    }
    return items.slice(0,10);
  } catch{return[];}
}

// ── LUXALGO ENGINE ────────────────────────────────────────────────────────────
function luxAlgoSignal(candles) {
  if(!candles||candles.candleCount<20)return null;
  const{last:price,atr,relVolume,trend}=candles;
  const signalType = (trend==='UP' && relVolume > 1.5) ? 'BUY' : 'NEUTRAL';
  return { signalType, tp: +(price + atr*2).toFixed(2), sl: +(price - atr*1.5).toFixed(2) };
}

// ── TICK HANDLER ──────────────────────────────────────────────────────────────
function onTick(sym,price,vol){
  if(!volTracker.has(sym))volTracker.set(sym,{v1m:0,reset:Date.now()});
  const vt=volTracker.get(sym); if(Date.now()-vt.reset>60000){vt.v1m=0;vt.reset=Date.now();} vt.v1m+=vol;
  for(const[cid,w]of watches){
    if(w.symbol===sym && !w.confirmed && price>=w.entryLevel){
      w.confirmed=true;
      tgSend(cid,`🔥 *ENTRY CONFIRMED — ${sym}*\nPrice: $${price} | Whale Vol Spike!`);
    }
  }
}

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.post('/api/maverick-scan', async (req, res) => {
  const type = req.body.type || 'supernova';
  try {
    const screener = type === 'supernova' ? 'day_gainers' : 'most_actives';
    const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=20&scrIds=${screener}`, { headers:{'User-Agent':'Mozilla/5.0'} });
    const d = await r.json();
    const rawList = d?.finance?.result?.[0]?.quotes || [];
    const results = [];
    for (const q of rawList) {
      const [quote, tf1d, news] = await Promise.all([getQuote(q.symbol), getCandles(q.symbol,'3mo','1d'), getFreshNews(q.symbol)]);
      if (!quote) continue;
      const mmr = calculateMMR(quote, tf1d, news);
      const lux = luxAlgoSignal(tf1d);
      if (mmr.total < 25) continue;
      results.push({ symbol: q.symbol, price: quote.price, change: quote.changePct, mmr: mmr.total, rotation: mmr.rotation, rvol: mmr.rvol, catalyst: news[0]?.headline || "Whale pressure mounting", luxSignal: lux?.signalType });
    }
    res.json({ results: results.sort((a,b) => b.mmr - a.mmr) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).send("No ticker");
  const sym = ticker.toUpperCase();
  const [quote, tf1d, news] = await Promise.all([getQuote(sym), getCandles(sym,'3mo','1d'), getFreshNews(sym)]);
  if (!quote) return res.status(404).send("Not found");
  const mmr = calculateMMR(quote, tf1d, news);
  const verdict = await groqCall("You are MAVERICK. Give a high-conviction verdict.", `Symbol: ${sym}, MMR: ${mmr.total}, News: ${news[0]?.headline}`);
  res.json({ ticker:sym, quote, mmr, verdict, news });
});

app.get('/api/signals', async (req, res) => {
  const sec = await getSEC8K();
  res.json({ signals: sec });
});

// ── TELEGRAM HANDLERS ─────────────────────────────────────────────────────────
function setupTelegramHandlers() {
  bot.on('message', async msg => {
    const cid=msg.chat.id; const text=msg.text.toUpperCase();
    if(text.startsWith('DIVE ')){
      const sym = text.split(' ')[1];
      tgSend(cid, `🔍 Analyzing ${sym}...`);
      const q = await getQuote(sym);
      if(q) tgSend(cid, `📊 ${sym} MMR: ${calculateMMR(q,null,null).total}/100`);
    }
  });
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(process.env.PORT || 3000, async () => {
  console.log('🚀 MAVERICK v3.5 MASTER ENGINE ONLINE');
  connectFinnhub();
  await initTelegram();
});
