require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const fetch       = require('node-fetch');
const path        = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── ENV ───────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const GROQ_KEY       = process.env.GROQ_KEY;
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const GROQ_MODELS    = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

// ── MAVERICK MATH ENGINE (v3.5 ADDITION) ──────────────────────────────────────
function calculateMMR(quote, tf1d, news) {
  let score = 0;
  const floatShares = quote.floatShares || 10000000;
  const floatRotation = quote.volume / floatShares;
  const rvol = tf1d ? tf1d.relVolume : (quote.volume / (quote.avgVolume || 1));
  
  score += Math.min(floatRotation, 3) * 15; // Float Rot Weight
  score += Math.min(rvol / 5, 1) * 35;      // Whale Intensity
  score += Math.min(Math.abs(quote.changePct || 0) / 20, 1) * 25; // Velocity
  if (news && news.some(n => n.ageH < 2)) score += 25; // Catalyst

  return {
    total: Math.round(score),
    rotation: floatRotation.toFixed(2),
    rvol: rvol.toFixed(2),
    isSupernova: score > 75 && floatRotation > 1.2
  };
}

// ── LUXALGO SIGNAL ENGINE (RESTORED) ─────────────────────────────────────────
function luxAlgoSignal(candles) {
  if(!candles||candles.candleCount<20)return null;
  const{last:price,high,low,ema9,rsi,atr,relVolume,trend,pctChange}=candles;
  const atrVal=atr||(high-low)*0.5;
  const ema21=ema9*(trend==='UP'?0.985:1.015);
  const bullishPts=[price>ema21,rsi>45&&rsi<70,relVolume>1.5,trend==='UP'].filter(Boolean).length;
  return {
    signalType: bullishPts >= 3 ? 'BUY' : 'NEUTRAL',
    strength: Math.round((bullishPts/4)*100),
    tp: +(price + atrVal*2).toFixed(2),
    sl: +(price - atrVal*1.5).toFixed(2),
    confluence: bullishPts+'/4'
  };
}

// ── DATA LAYER (RESTORED & IMPROVED) ──────────────────────────────────────────
async function getQuote(symbol) {
  const sym = symbol.toUpperCase();
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`, { headers:{'User-Agent':'Mozilla/5.0'} });
    const d = await r.json(); const q = d?.quoteResponse?.result?.[0];
    if (q) return { price:q.regularMarketPrice, changePct:q.regularMarketChangePercent, volume:q.regularMarketVolume, avgVolume:q.averageDailyVolume3Month, floatShares:q.floatShares, marketCap:q.marketCap, high:q.regularMarketDayHigh, low:q.regularMarketDayLow };
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
    return { last:last.c, high:Math.max(...candles.map(c=>c.h)), low:Math.min(...candles.map(c=>c.l)), relVolume:+(last.v/avgVol).toFixed(2), trend:last.c>first.c?'UP':'DOWN', candleCount:candles.length, rsi: 55, atr: (last.h-last.l), pctChange: +((last.c-first.c)/first.c*100).toFixed(2) };
  } catch(e){return null;}
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
    const r=await fetch(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom`,{headers:{'User-Agent':'MaverickBot/1.0'}});
    const text=await r.text(); const items=[]; const regex=/<entry>([\s\S]*?)<\/entry>/g; let m;
    while((m=regex.exec(text))!==null){
      const entry=m[1]; const title=(/<title>(.*?)<\/title>/.exec(entry)||[])[1]||'';
      const ageH=(Date.now()-new Date((/<updated>(.*?)<\/updated>/.exec(entry)||[])[1]).getTime())/3600000;
      items.push({headline:title, source:'SEC', ageH: +ageH.toFixed(1)});
    }
    return items.slice(0,10);
  } catch{return[];}
}

// ── API ROUTES (ALL FEATURES) ─────────────────────────────────────────────────
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
      if (type === 'supernova' && mmr.total < 30) continue;
      results.push({ 
        symbol: q.symbol, price: quote.price, change: quote.changePct, 
        mmr: mmr.total, rotation: mmr.rotation, rvol: mmr.rvol, 
        catalyst: news[0]?.headline || "No fresh news",
        luxSignal: lux?.signalType || 'NEUTRAL'
      });
    }
    res.json({ results: results.sort((a,b) => b.mmr - a.mmr) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze', async (req, res) => {
  const { ticker } = req.body; const sym = ticker.toUpperCase();
  const [quote, tf1d, news] = await Promise.all([getQuote(sym), getCandles(sym,'3mo','1d'), getFreshNews(sym)]);
  const mmr = calculateMMR(quote, tf1d, news);
  const lux = luxAlgoSignal(tf1d);
  res.json({ ticker:sym, quote, mmr, lux, news });
});

// ── TELEGRAM BOT (RESTORED) ──────────────────────────────────────────────────
if (TELEGRAM_TOKEN) {
  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  bot.on('message', async (msg) => {
    const text = msg.text.toUpperCase();
    if (text.length <= 5) {
      const q = await getQuote(text);
      if (q) bot.sendMessage(msg.chat.id, `📊 ${text}: $${q.price} (${q.changePct.toFixed(2)}%)\nVol: ${(q.volume/1e6).toFixed(1)}M\nMMR Score: ${calculateMMR(q, null, null).total}`);
    }
  });
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(process.env.PORT || 3000, () => console.log(`Maverick v3.5 Master Engine Live`));
