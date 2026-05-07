require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const fetch       = require('node-fetch');
const path        = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// -- CONFIG --
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const GROQ_KEY       = process.env.GROQ_KEY;
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const GROQ_MODELS    = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

// -- MAVERICK MATH ENGINE v3.5 --
function calculateMMR(quote, tf1d, news) {
  let score = 0;
  const floatShares = quote.floatShares || 10000000;
  const floatRotation = quote.volume / floatShares;
  const rvol = tf1d ? tf1d.relVolume : (quote.volume / (quote.avgVolume || 1));
  score += Math.min(floatRotation, 3) * 10;
  score += Math.min(rvol / 5, 1) * 30;
  score += Math.min(Math.abs(quote.changePct || 0) / 20, 1) * 20;
  if (news && news.some(n => n.ageH < 2)) score += 20;
  return {
    total: Math.round(score),
    rotation: floatRotation.toFixed(2),
    rvol: rvol.toFixed(2)
  };
}

// -- DATA LAYER --
async function getQuote(symbol) {
  const sym = symbol.toUpperCase();
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`, { headers:{'User-Agent':'Mozilla/5.0'} });
    const d = await r.json(); const q = d?.quoteResponse?.result?.[0];
    if (q) return { price:q.regularMarketPrice, changePct:q.regularMarketChangePercent, volume:q.regularMarketVolume, avgVolume:q.averageDailyVolume3Month, floatShares:q.floatShares };
  } catch (e) { return null; }
}

async function getFreshNews(symbol) {
  const news = [];
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=3`,{headers:{'User-Agent':'Mozilla/5.0'}});
    const d=await r.json();
    (d?.news||[]).forEach(n=>news.push({headline:n.title, ageH:+((Date.now()/1000-(n.providerPublishTime||0))/3600).toFixed(1)}));
  } catch {}
  return news;
}

// -- API ROUTES --
app.post('/api/maverick-scan', async (req, res) => {
  const type = req.body.type || 'supernova';
  try {
    const screener = type === 'supernova' ? 'day_gainers' : 'most_actives';
    const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=15&scrIds=${screener}`, { headers:{'User-Agent':'Mozilla/5.0'} });
    const d = await r.json();
    const rawList = d?.finance?.result?.[0]?.quotes || [];
    const results = [];
    for (const q of rawList) {
      const news = await getFreshNews(q.symbol);
      const quote = await getQuote(q.symbol);
      if (!quote) continue;
      const mmr = calculateMMR(quote, null, news);
      if (type === 'supernova' && mmr.total < 40) continue;
      results.push({ symbol: q.symbol, price: quote.price, change: quote.changePct, mmr: mmr.total, rotation: mmr.rotation, rvol: mmr.rvol, catalyst: news[0]?.headline || "No fresh news" });
    }
    res.json({ results: results.sort((a,b) => b.mmr - a.mmr) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  const reply = await groqCall("You are MAVERICK, a decisive stock advisor. Be brief.", message);
  res.json({ reply });
});

async function groqCall(system, user) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODELS[0], messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content;
  } catch (e) { return "AI Brain offline."; }
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Maverick v3.5 Live`));
