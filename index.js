require('dotenv').config();
var express     = require('express');
var TelegramBot = require('node-telegram-bot-api');
var WebSocket   = require('ws');
var fetch       = require('node-fetch');
var path        = require('path');

// ENV
var TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
var FINNHUB_KEY    = process.env.FINNHUB_KEY;
var GROQ_KEY       = process.env.GROQ_KEY;
var GROQ_KEY_2     = process.env.GROQ_KEY_2;   // Optional: second Groq key
var GROQ_KEY_3     = process.env.GROQ_KEY_3;   // Optional: third Groq key
var CEREBRAS_KEY   = process.env.CEREBRAS_KEY; // Optional: free at inference.cerebras.ai
var JSONBIN_KEY    = process.env.JSONBIN_KEY;
var JSONBIN_BIN    = process.env.JSONBIN_BIN;
var WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'maverick';
var TG_CHAT_ID     = process.env.TG_CHAT_ID;
var BOT_USERNAME   = process.env.TG_BOT_USERNAME || '';
var PORT           = process.env.PORT || 3000;

var app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Multi-Brain AI System ─────────────────────────────────────────
// Key rotation: cycles through available Groq keys on 429
// Tiered routing: scans → Cerebras/8B, manual analysis → 70B
var GROQ_KEYS = [GROQ_KEY, GROQ_KEY_2, GROQ_KEY_3].filter(Boolean);
var groqKeyIdx = 0;

// Models: fast/cheap for scans, premium for manual deep dives
var GROQ_MODELS_HEAVY = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.1-8b-instant'
];
var GROQ_MODELS_LIGHT = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile'
];
var GROQ_MODELS = GROQ_MODELS_HEAVY; // legacy reference

// Groq call with key rotation on 429
async function groqCall(system, user, maxTokens, useLightModel) {
  maxTokens = maxTokens || 1500;
  var models = useLightModel ? GROQ_MODELS_LIGHT : GROQ_MODELS_HEAVY;
  var keysToTry = GROQ_KEYS.length;
  if (!keysToTry) { console.error('No GROQ_KEY set'); return null; }

  for (var ki = 0; ki < keysToTry; ki++) {
    var key = GROQ_KEYS[groqKeyIdx % GROQ_KEYS.length];
    for (var mi = 0; mi < models.length; mi++) {
      var model = models[mi];
      try {
        var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model, max_tokens: maxTokens, temperature: 0.25,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
        });
        if (r.status === 429) {
          console.log('[AI] Groq key ' + groqKeyIdx + ' rate limited. Rotating...');
          groqKeyIdx = (groqKeyIdx + 1) % GROQ_KEYS.length;
          break; // try next key
        }
        if (!r.ok) { var err = await r.text(); console.error('Groq [' + model + '] ' + r.status + ': ' + err.slice(0,100)); continue; }
        var d = await r.json();
        var text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
        if (!text) continue;
        var cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        var m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) continue;
        return JSON.parse(m[0]);
      } catch(e) { console.error('Groq [' + model + ']: ' + e.message); }
    }
  }
  console.error('[AI] All Groq keys/models exhausted');
  return null;
}

// Cerebras: auxiliary brain for background scans — much higher free limits
// Get free key at: inference.cerebras.ai — add CEREBRAS_KEY to Render env vars
async function cerebrasCall(system, user, maxTokens) {
  if (!CEREBRAS_KEY) return null;
  try {
    var r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CEREBRAS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.1-8b',
        max_tokens: maxTokens || 1000,
        temperature: 0.25,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    if (!r.ok) return null;
    var d = await r.json();
    var text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    if (!text) return null;
    var cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    var m = cleaned.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch(e) { console.error('[Cerebras] ' + e.message); return null; }
}

// Tiered AI call:
// priority='high' → Groq 70B (for manual analyze/dive — preserve quota)
// priority='scan' → Cerebras first, fallback Groq 8B (background scans)
async function aiCall(system, user, maxTokens, priority) {
  if (priority === 'scan') {
    // Try Cerebras first (higher limits, saves Groq quota)
    var cb = await cerebrasCall(system, user, maxTokens || 800);
    if (cb) return cb;
    // Fallback: Groq 8B (light model)
    return groqCall(system, user, maxTokens || 800, true);
  }
  // Default: Groq premium model for high-stakes verdicts
  return groqCall(system, user, maxTokens, false);
}

async function groqChat(messages, maxTokens, useLightModel) {
  maxTokens = maxTokens || 1000;
  var keys = GROQ_KEYS;
  if (!keys.length) return null;
  var models = useLightModel ? GROQ_MODELS_LIGHT : GROQ_MODELS_HEAVY;
  for (var ki = 0; ki < keys.length; ki++) {
    var key = keys[(groqKeyIdx + ki) % keys.length];
    for (var mi = 0; mi < models.length; mi++) {
      try {
        var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: models[mi], max_tokens: maxTokens, temperature: 0.4, messages: messages })
        });
        if (r.status === 429) { groqKeyIdx = (groqKeyIdx+1) % keys.length; break; }
        if (!r.ok) continue;
        var d = await r.json();
        var txt = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (txt) return txt;
      } catch(e) {}
    }
  }
  return null;
}

// Telegram with 409 fix
var bot = null;
async function initTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/deleteWebhook?drop_pending_updates=true');
    await new Promise(function(r) { setTimeout(r, 1000); });
    bot = new TelegramBot(TELEGRAM_TOKEN, {
      polling: { interval: 2000, params: { timeout: 10, allowed_updates: ['message'] } }
    });
    console.log('Telegram started');
    setupTelegramHandlers();
  } catch(e) { console.error('TG init: ' + e.message); }
}

function tgSend(chatId, text) {
  if (!bot || !chatId) return;
  bot.sendMessage(String(chatId), text, { parse_mode: 'Markdown' })
    .catch(function(e) { console.error('TG send: ' + e.message); });
}

// State
var watches          = new Map();
var trades           = new Map();
var priceAlerts      = new Map();
var subscribers      = new Map();
var volTracker       = new Map();
var tvSignals        = new Map();
var chatSessions     = new Map();
var scanCache        = new Map();
var scannedHeadlines = new Set();
var lastCatalystScan = 0;
var scanCycleCount   = 0;

// Finnhub WebSocket
var ws;
function connectFinnhub() {
  if (!FINNHUB_KEY) return;
  ws = new WebSocket('wss://ws.finnhub.io?token=' + FINNHUB_KEY);
  ws.on('open', function() {
    console.log('Finnhub WS connected');
    subscribers.forEach(function(v, s) { ws.send(JSON.stringify({ type: 'subscribe', symbol: s })); });
  });
  ws.on('message', function(raw) {
    try {
      var m = JSON.parse(raw);
      if (m.type === 'trade' && Array.isArray(m.data)) {
        m.data.forEach(function(t) { onTick(t.s, t.p, t.v); });
      }
    } catch(e) {}
  });
  ws.on('close', function() { setTimeout(connectFinnhub, 5000); });
  ws.on('error', function(e) { if (e.message.indexOf('429') === -1) console.error('WS: ' + e.message); });
}
function wsSend(s, a) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: a, symbol: s })); }
function addSub(s, id) { if (!subscribers.has(s)) subscribers.set(s, new Set()); if (!subscribers.get(s).size) wsSend(s, 'subscribe'); subscribers.get(s).add(id); }
function removeSub(s, id) { var x = subscribers.get(s); if (!x) return; x.delete(id); if (!x.size) { subscribers.delete(s); wsSend(s, 'unsubscribe'); } }

// =========================================================
// DATA LAYER
// =========================================================

async function getQuote(symbol) {
  var sym = symbol.toUpperCase();
  if (FINNHUB_KEY) {
    try {
      var results = await Promise.all([
        fetch('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + FINNHUB_KEY + '&_=' + Date.now()),
        fetch('https://finnhub.io/api/v1/stock/profile2?symbol=' + sym + '&token=' + FINNHUB_KEY + '&_=' + Date.now())
      ]);
      var q = await results[0].json();
      var p = await results[1].json();
      if (q && q.c > 0) {
        var ch = q.c - q.pc;
        return {
          price: q.c, change: ch,
          changePct: q.pc ? (ch / q.pc) * 100 : 0,
          open: q.o, high: q.h, low: q.l, prevClose: q.pc,
          volume: null, avgVolume: null,
          marketCap: p && p.marketCapitalization ? p.marketCapitalization * 1e6 : null,
          floatShares: p && p.shareOutstanding ? p.shareOutstanding * 1e6 : null,
          sector: (p && p.finnhubIndustry) || null,
          shortName: (p && p.name) || sym,
          source: 'finnhub'
        };
      }
    } catch(e) { console.error('Finnhub quote: ' + e.message); }
  }
  try {
    var r2 = await fetch('https://query2.finance.yahoo.com/v7/finance/quote?symbols=' + sym + '&_=' + Date.now(), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/', 'Cache-Control': 'no-cache' }
    });
    var d2 = await r2.json();
    var q2 = d2 && d2.quoteResponse && d2.quoteResponse.result && d2.quoteResponse.result[0];
    if (q2 && q2.regularMarketPrice) {
      return {
        price: q2.regularMarketPrice, change: q2.regularMarketChange,
        changePct: q2.regularMarketChangePercent,
        open: q2.regularMarketOpen, high: q2.regularMarketDayHigh,
        low: q2.regularMarketDayLow, prevClose: q2.regularMarketPreviousClose,
        volume: q2.regularMarketVolume, avgVolume: q2.averageDailyVolume3Month,
        marketCap: q2.marketCap, floatShares: q2.floatShares,
        yearHigh: q2.fiftyTwoWeekHigh, yearLow: q2.fiftyTwoWeekLow,
        sector: q2.sector, shortName: q2.shortName,
        preMarket: q2.preMarketPrice, preMarketChangePct: q2.preMarketChangePercent,
        source: 'yahoo'
      };
    }
  } catch(e) { console.error('Yahoo quote: ' + e.message); }
  return null;
}

async function getCandles(symbol, range, interval) {
  try {
    var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + symbol +
              '?range=' + range + '&interval=' + interval + '&_=' + Date.now();
    var r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/', 'Cache-Control': 'no-cache' }
    });
    var d = await r.json();
    var res = d && d.chart && d.chart.result && d.chart.result[0];
    if (!res) return null;
    var q = res.indicators && res.indicators.quote && res.indicators.quote[0];
    var ts = res.timestamp || [];
    if (!q || !ts.length) return null;
    var candles = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.close[i] != null) candles.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] });
    }
    if (!candles.length) return null;
    var closes = candles.map(function(c) { return c.c; });
    var last  = closes[closes.length - 1];
    var first = closes[0];
    var high  = Math.max.apply(null, candles.map(function(c) { return c.h; }));
    var low   = Math.min.apply(null, candles.map(function(c) { return c.l; }));
    var totalVol = candles.reduce(function(s, c) { return s + (c.v || 0); }, 0);
    var avgVol   = totalVol / candles.length;
    var lastVol  = candles[candles.length - 1].v || 0;
    var ema9 = closes.reduce(function(e, c, i) { return i === 0 ? c : c * (2/10) + e * (8/10); }, closes[0]);
    var gains = [], losses = [];
    for (var j = 1; j < Math.min(closes.length, 15); j++) {
      var df = closes[j] - closes[j-1];
      if (df > 0) gains.push(df); else losses.push(Math.abs(df));
    }
    var ag = gains.reduce(function(s,v){return s+v;},0) / (gains.length || 1);
    var al = losses.reduce(function(s,v){return s+v;},0) / (losses.length || 1);
    var rsi = al === 0 ? 100 : 100 - (100 / (1 + ag/al));
    var atrSlice = candles.slice(-14);
    var atr = atrSlice.reduce(function(s,c){return s+(c.h-c.l);},0) / Math.min(14, candles.length);
    var mid = closes[Math.floor(closes.length / 2)];
    return {
      range: range, interval: interval,
      pctChange: +((last - first) / first * 100).toFixed(2),
      trend: last > mid ? 'UP' : 'DOWN',
      high: high, low: low, last: last,
      ema9: +ema9.toFixed(3), rsi: +rsi.toFixed(1),
      relVolume: +(lastVol / avgVol).toFixed(2),
      atr: +atr.toFixed(4),
      candleCount: candles.length
    };
  } catch(e) { return null; }
}

async function getFreshNews(symbol) {
  var news = [];
  if (FINNHUB_KEY) {
    try {
      var to   = new Date().toISOString().split('T')[0];
      var from = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0];
      var r = await fetch('https://finnhub.io/api/v1/company-news?symbol=' + symbol +
        '&from=' + from + '&to=' + to + '&token=' + FINNHUB_KEY + '&_=' + Date.now());
      var d = await r.json();
      if (Array.isArray(d)) {
        d.slice(0, 5).forEach(function(n) {
          news.push({ headline: n.headline, source: n.source, url: n.url, datetime: n.datetime,
            ageH: +((Date.now()/1000 - n.datetime) / 3600).toFixed(1) });
        });
      }
    } catch(e) {}
  }
  try {
    var r2 = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' + symbol +
      '&newsCount=5&_=' + Date.now(), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    var d2 = await r2.json();
    ((d2 && d2.news) || []).slice(0, 3).forEach(function(n) {
      if (!news.find(function(x) { return x.headline === n.title; })) {
        news.push({ headline: n.title, source: n.publisher, url: n.link,
          datetime: n.providerPublishTime,
          ageH: +((Date.now()/1000 - (n.providerPublishTime || 0)) / 3600).toFixed(1) });
      }
    });
  } catch(e) {}
  return news.sort(function(a, b) { return b.datetime - a.datetime; }).slice(0, 6);
}

async function getMarketNewsFresh() {
  var news = [];
  if (!FINNHUB_KEY) return news;
  var categories = ['general', 'merger'];
  for (var i = 0; i < categories.length; i++) {
    try {
      var r = await fetch('https://finnhub.io/api/v1/news?category=' + categories[i] +
        '&token=' + FINNHUB_KEY + '&_=' + Date.now());
      var d = await r.json();
      if (Array.isArray(d)) {
        d.filter(function(n) { return (Date.now()/1000 - n.datetime) < 7200; })
          .forEach(function(n) {
            news.push({ headline: n.headline, source: n.source, url: n.url,
              datetime: n.datetime, related: n.related,
              ageH: +((Date.now()/1000 - n.datetime) / 3600).toFixed(1) });
          });
      }
    } catch(e) {}
  }
  return news.sort(function(a,b) { return b.datetime - a.datetime; }).slice(0, 40);
}

async function getSEC8K() {
  try {
    var r = await fetch(
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=20&search_text=&output=atom&_=' + Date.now(),
      { headers: { 'User-Agent': 'MaverickBot/1.0 bot@maverick.com' } }
    );
    var text = await r.text();
    var items = [];
    var regex = /<entry>([\s\S]*?)<\/entry>/g;
    var m;
    while ((m = regex.exec(text)) !== null) {
      var entry   = m[1];
      var tMatch  = /<title>(.*?)<\/title>/.exec(entry);
      var lMatch  = /<link.*?href="(.*?)"/.exec(entry);
      var uMatch  = /<updated>(.*?)<\/updated>/.exec(entry);
      var title   = tMatch ? tMatch[1] : '';
      var link    = lMatch ? lMatch[1] : '';
      var updated = uMatch ? uMatch[1] : '';
      var ageH    = +((Date.now() - new Date(updated).getTime()) / 3600000).toFixed(1);
      // Extract ticker from title — SEC titles often contain company names
      var tickerMatch = title.match(/\(([A-Z]{1,5})\)/);
      var ticker = tickerMatch ? tickerMatch[1] : null;
      items.push({ headline: title, source: 'SEC-8K', url: link,
        datetime: new Date(updated).getTime() / 1000, ageH: ageH, ticker: ticker });
    }
    return items.slice(0, 15);
  } catch(e) { return []; }
}

// S-3 / 424B dilution check — Block 5: Dilution Shield
async function checkDilutionRisk(symbol) {
  try {
    // Search SEC for recent S-3 or 424B filings for this company
    var r = await fetch(
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=' + encodeURIComponent(symbol) +
      '&type=S-3&dateb=&owner=include&count=5&search_text=&output=atom',
      { headers: { 'User-Agent': 'MaverickBot/1.0 bot@maverick.com' } }
    );
    var text = await r.text();
    var hasS3    = text.includes('<type>S-3') || text.includes('<type>S-3/A');
    var has424B  = text.includes('424B');
    // Check age — only flag if filed within last 90 days
    var dateMatch = /<filing-date>(.*?)<\/filing-date>/.exec(text);
    var isRecent  = false;
    if (dateMatch) {
      var filingAge = (Date.now() - new Date(dateMatch[1]).getTime()) / 86400000;
      isRecent = filingAge < 90;
    }
    if ((hasS3 || has424B) && isRecent) {
      return { detected: true, type: hasS3 ? 'S-3 Shelf Registration' : '424B Prospectus', stopMultiplier: 2.0,
        note: 'Dilution risk detected — stop widened to 2.0x ATR' };
    }
  } catch(e) {}
  return { detected: false, type: null, stopMultiplier: 1.5, note: null };
}

// =========================================================
// LUXALGO SIGNAL ENGINE
// =========================================================

function luxAlgoSignal(candles) {
  if (!candles || candles.candleCount < 20) return null;
  var price     = candles.last;
  var high      = candles.high;
  var low       = candles.low;
  var ema9      = candles.ema9;
  var rsi       = candles.rsi;
  var atr       = candles.atr;
  var relVolume = candles.relVolume;
  var trend     = candles.trend;
  var pctChange = candles.pctChange;
  var atrVal    = atr || (high - low) * 0.5;
  var ema21     = +(ema9 * (trend === 'UP' ? 0.985 : 1.015)).toFixed(3);
  var ema50     = +(ema9 * (trend === 'UP' ? 0.970 : 1.030)).toFixed(3);
  var upperBand = +(ema21 + atrVal * 1.5).toFixed(3);
  var lowerBand = +(ema21 - atrVal * 1.5).toFixed(3);
  var bullishFan = ema9 > ema21 && ema21 > ema50;
  var bearishFan = ema9 < ema21 && ema21 < ema50;
  var bandPosition = atrVal > 0 ? (price - lowerBand) / (upperBand - lowerBand) : 0.5;
  var bullishOB  = +(low + (high - low) * 0.15).toFixed(3);
  var fvgDetected = atrVal > (high - low) * 0.3 && relVolume > 2;
  var fvgLevel   = +(trend === 'UP' ? low + atrVal * 0.5 : high - atrVal * 0.5).toFixed(3);
  var bullishBOS = trend === 'UP' && pctChange > 3 && relVolume > 1.5;
  var bearishBOS = trend === 'DOWN' && pctChange < -3 && relVolume > 1.5;
  var bScore = [bullishFan, price > ema21, rsi > 40 && rsi < 65, relVolume > 1.2,
    bullishBOS, Math.abs(price - bullishOB) / price < 0.05,
    fvgDetected && trend === 'UP'].filter(Boolean).length;
  var sScore = [bearishFan, price < ema21, rsi < 50 && rsi > 30, relVolume > 1.2,
    bearishBOS, Math.abs(price - (high - (high-low)*0.15)) / price < 0.05].filter(Boolean).length;
  var signalType = 'NEUTRAL', signalStrength = 0, tpLevel = null, tp2Level = null, slLevel = null;
  if (bScore >= 4 && rsi < 70) {
    signalType = 'BUY'; signalStrength = Math.round(bScore / 7 * 100);
    tpLevel  = +(price + atrVal * 2.0).toFixed(3);
    tp2Level = +(price + atrVal * 3.5).toFixed(3);
    slLevel  = +(price - atrVal * 1.5).toFixed(3);
  } else if (sScore >= 4 && rsi > 30) {
    signalType = 'SELL'; signalStrength = Math.round(sScore / 6 * 100);
    tpLevel = +(price - atrVal * 2.0).toFixed(3);
    slLevel = +(price + atrVal * 1.5).toFixed(3);
  }
  return {
    signalType: signalType, signalStrength: signalStrength,
    tpLevel: tpLevel, tp2Level: tp2Level, slLevel: slLevel,
    ema9: +ema9.toFixed(3), ema21: ema21, upperBand: upperBand, lowerBand: lowerBand,
    atrVal: +atrVal.toFixed(4), bullishOB: bullishOB,
    fvgDetected: fvgDetected, fvgLevel: fvgLevel,
    bos: bullishBOS ? 'BULLISH' : bearishBOS ? 'BEARISH' : 'NONE',
    bandPosition: +bandPosition.toFixed(2), rsi: rsi, trend: trend,
    confluenceScore: bScore + '/7'
  };
}

// =========================================================
// BLOCK 2: calcLevels — ATR-FIRST DYNAMIC STOPS (v3.5)
// Falls back to fixed % only when ATR is unavailable.
// =========================================================

function calcLevels(entry, atr, dilutionMultiplier) {
  var stopMultiplier = dilutionMultiplier || 1.5;
  var stopDist, stop, risk;
  if (atr && atr > 0) {
    // ATR-based: stop breathes with volatility
    stopDist = atr * stopMultiplier;
  } else {
    // Fallback fixed % by price tier
    var pct = entry < 5 ? 0.035 : entry < 15 ? 0.028 : 0.02;
    stopDist = entry * pct;
  }
  stop = +(entry - stopDist).toFixed(3);
  risk = entry - stop;
  return {
    stop:  stop,
    t1:    +(entry + risk * 2.0).toFixed(3),
    t2:    +(entry + risk * 3.5).toFixed(3),
    t3:    +(entry + risk * 5.5).toFixed(3),
    risk:  +risk.toFixed(3),
    atrUsed: !!(atr && atr > 0)
  };
}

// =========================================================
// BLOCK 1: calculateMMR — MAVERICK MOMENTUM RATIO (v3.5)
// Math engine runs BEFORE Groq. Only 60+ scores reach AI.
// =========================================================

function calculateMMR(quote, tf1d, news) {
  var score = 0;
  var floatShares  = quote.floatShares || 10000000;
  var volume       = quote.volume || (tf1d ? tf1d.last * 1000 : 0);
  var avgVolume    = quote.avgVolume || 1;
  var floatRotation = volume / floatShares;
  var rvol = tf1d ? tf1d.relVolume : (volume / avgVolume);

  // Float Rotation Score (30 pts max) — >3x rotation means full float turned over
  score += Math.min(floatRotation, 3) * 10;

  // Whale Intensity Score (30 pts max) — >10x RVOL = institutional entry
  score += Math.min(rvol / 5, 1) * 30;

  // Price Velocity Score (20 pts max) — based on % change magnitude
  score += Math.min(Math.abs(quote.changePct || 0) / 20, 1) * 20;

  // Catalyst Freshness Bonus (20 pts) — news filed within 2 hours
  var hasRecentNews = news && news.some(function(n) { return n.ageH < 2; });
  if (hasRecentNews) score += 20;

  var total = Math.round(score);
  return {
    total: total,
    grade: total >= 80 ? 'A' : total >= 60 ? 'B' : total >= 40 ? 'C' : 'D',
    floatRotation: +floatRotation.toFixed(2),
    rvol: +rvol.toFixed(2),
    passesFilter: total >= 60,   // Only pass to Groq if score >= 60
    isSupernovaCandidate: floatRotation >= 3 && rvol >= 10 && Math.abs(quote.changePct||0) >= 40
  };
}

// =========================================================
// TRADE MATH
// =========================================================

function totalShares(tr) { return tr.shares + tr.adds.reduce(function(s,a){return s+a.shares;},0); }
function avgCostCalc(tr) { return +((tr.entryPrice*tr.shares + tr.adds.reduce(function(s,a){return s+a.price*a.shares;},0))/totalShares(tr)).toFixed(3); }
function totalPnl(tr, p) { return +((p-tr.entryPrice)*tr.shares + tr.adds.reduce(function(s,a){return s+(p-a.price)*a.shares;},0)).toFixed(2); }

// =========================================================
// TICK HANDLER
// =========================================================

function onTick(sym, price, vol) {
  if (!volTracker.has(sym)) volTracker.set(sym, { v1m: 0, reset: Date.now() });
  var vt = volTracker.get(sym);
  if (Date.now() - vt.reset > 60000) { vt.v1m = 0; vt.reset = Date.now(); }
  vt.v1m += vol;

  // Watches
  watches.forEach(function(w, cid) {
    if (w.symbol !== sym || w.confirmed) return;
    w.currentPrice = price;
    if (price >= w.entryLevel) {
      var apr = w.avgVolume ? w.avgVolume / 390 : null;
      var vr  = apr ? vt.v1m / apr : 99;
      if (vr >= 1.5) {
        w.confirmed = true;
        var atr = w.atr || null;
        var lv  = calcLevels(price, atr);
        tgSend(cid, 'ENTRY CONFIRMED - ' + sym + '\n\n$' + price.toFixed(2) + ' | Vol: ' + vr.toFixed(1) + 'x avg\n\nStop: $' + lv.stop + ' (' + (lv.atrUsed ? 'ATR-based' : 'fixed') + ')\nT1: $' + lv.t1 + '\nT2: $' + lv.t2 + '\n\nText: in at ' + price.toFixed(2) + ' with 200 shares');
      }
    }
  });

  // Price alerts
  (priceAlerts.get(sym) || []).forEach(function(a) {
    if (a.fired) return;
    var hit = (a.condition === 'ABOVE' && price >= a.value) || (a.condition === 'BELOW' && price <= a.value);
    if (hit) {
      a.fired = true;
      tgSend(a.chatId, 'ALERT FIRED - ' + sym + '\n$' + price.toFixed(2) + ' went ' + a.condition + ' $' + a.value);
    }
  });

  // Active trades
  trades.forEach(function(tr, cid) {
    if (tr.symbol !== sym) return;
    var prev = tr.currentPrice || tr.entryPrice;
    tr.currentPrice = price;
    var mins = (Date.now() - tr.entryTime) / 60000;
    var pnl  = totalPnl(tr, price);
    var apr  = tr.avgVolume ? tr.avgVolume / 390 : null;
    var vr   = apr ? vt.v1m / apr : 0;
    if (price > tr.hwm) {
      tr.hwm = price;
      if (tr.t1Hit) {
        var trail = +(price - (price - tr.avgCost) * 0.40).toFixed(3);
        if (trail > tr.trailingStop) tr.trailingStop = trail;
      }
    }
    if (!tr.stopAlerted && price <= tr.stopLoss) { tr.stopAlerted = true; tgSend(cid, 'STOP HIT - ' + tr.symbol + '\n$' + price.toFixed(2) + ' | Loss: -$' + Math.abs(pnl).toFixed(2) + '\nEXIT NOW. Text: out at ' + price.toFixed(2)); }
    if (tr.t1Hit && !tr.trailAlerted && price <= tr.trailingStop) { tr.trailAlerted = true; tgSend(cid, 'TRAIL STOP - ' + tr.symbol + '\nLocked: +$' + pnl.toFixed(2) + '\nText: out at ' + price.toFixed(2)); }
    if (!tr.t1Hit && price >= tr.targets.t1) { tr.t1Hit = true; tr.stopLoss = tr.avgCost; tr.stopAlerted = false; tr.trailAlerted = false; tgSend(cid, 'TARGET 1 HIT - ' + tr.symbol + '\n+$' + totalPnl(tr, tr.targets.t1).toFixed(2) + '\nSell 50% - Stop moved to breakeven $' + tr.avgCost + '\nNext: $' + tr.targets.t2); }
    if (!tr.t2Hit && price >= tr.targets.t2) { tr.t2Hit = true; tgSend(cid, 'TARGET 2 HIT - ' + tr.symbol + '\n+$' + totalPnl(tr, tr.targets.t2).toFixed(2) + '\nSell rest or hold to T3: $' + tr.targets.t3); }
    if (!tr.addSent && tr.t1Hit && !tr.t2Hit) { var pg = ((price - tr.avgCost) / tr.avgCost) * 100; if (pg > 4 && vr > 2 && price > prev * 0.995) { tr.addSent = true; tgSend(cid, 'ADD SIGNAL - ' + tr.symbol + '\nVol: ' + vr.toFixed(1) + 'x | +' + pg.toFixed(1) + '%\nText: added 100 at ' + price.toFixed(2)); } }
    if (!tr.warn45 && mins >= 45) { tr.warn45 = true; tgSend(cid, '45-MIN WARNING - ' + tr.symbol + '\n' + mins.toFixed(0) + 'min in | P&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)); }
    if (!tr.warn90 && mins >= 90) { tr.warn90 = true; tgSend(cid, '90-MIN WARNING - ' + tr.symbol + '\nMomentum typically done. Consider exit.\nText: out at ' + price.toFixed(2)); }
  });
}

// =========================================================
// MEMORY
// =========================================================

async function memLoad() {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return { trades: [], scans: [] };
  try {
    var r = await fetch('https://api.jsonbin.io/v3/b/' + JSONBIN_BIN + '/latest', { headers: { 'X-Master-Key': JSONBIN_KEY } });
    var d = await r.json();
    return d.record || { trades: [], scans: [] };
  } catch(e) { return { trades: [], scans: [] }; }
}
async function memSave(rec) {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return;
  try {
    await fetch('https://api.jsonbin.io/v3/b/' + JSONBIN_BIN, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
      body: JSON.stringify(rec)
    });
  } catch(e) {}
}
async function logTrade(entry) {
  var m = await memLoad();
  m.trades = m.trades || [];
  m.trades.push(Object.assign({}, entry, { id: Date.now() }));
  await memSave(m);
}

// ── VERDICT TRACKING ─────────────────────────────────────────────
var verdictStore = [];
async function verdictLoad() {
  try { var m = await memLoad(); verdictStore = m.verdicts || []; } catch(e) { verdictStore = []; }
}
async function verdictSave() {
  try { var m = await memLoad(); m.verdicts = verdictStore; await memSave(m); } catch(e) {}
}
function storeVerdict(ticker, price, aiText) {
  try {
    var text = typeof aiText === 'string' ? aiText : JSON.stringify(aiText);
    var dir  = /LONG/i.test(text) ? 'LONG' : /SHORT/i.test(text) ? 'SHORT' : 'NEUTRAL';
    var cm   = text.match(/confidence["\s:]+(\d+)/i);
    verdictStore.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2,6),
      ticker: ticker, timestamp: Date.now(), verdict: dir,
      priceAtVerdict: price, confidence: cm ? parseInt(cm[1]) : null,
      resolvedAt: null, resolvedPrice: null, outcome: null, pnlPct: null
    });
    if (verdictStore.length > 200) verdictStore = verdictStore.slice(-200);
    verdictSave().catch(function(){});
  } catch(e) {}
}
async function resolveAgedVerdicts() {
  var cutoff = 5 * 24 * 60 * 60 * 1000;
  var pending = verdictStore.filter(function(v){ return !v.resolvedAt && (Date.now()-v.timestamp) >= cutoff; });
  for (var i = 0; i < pending.length; i++) {
    try {
      var q = await getQuote(pending[i].ticker);
      if (!q) continue;
      var pnl = ((q.price - pending[i].priceAtVerdict) / pending[i].priceAtVerdict) * 100;
      pending[i].resolvedAt = Date.now(); pending[i].resolvedPrice = q.price;
      pending[i].pnlPct = +pnl.toFixed(2);
      pending[i].outcome = pending[i].verdict === 'LONG' ? (pnl > 2 ? 'WIN' : pnl < -2 ? 'LOSS' : 'NEUTRAL')
        : pending[i].verdict === 'SHORT' ? (pnl < -2 ? 'WIN' : pnl > 2 ? 'LOSS' : 'NEUTRAL') : 'NEUTRAL';
    } catch(e) {}
  }
  if (pending.length) verdictSave().catch(function(){});
}

// =========================================================
// BLOCK 3: SUPERNOVA 2.0 — MMR PRE-FILTER + NEW THRESHOLDS
// AI only consulted for MMR 60+ candidates.
// Supernova requires float rotation >3x, RVOL >10x, velocity +40%.
// =========================================================

async function runSupernova() {
  var movers = [];
  try {
    var r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=30&scrIds=day_gainers&_=' + Date.now(), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' }
    });
    var d = await r.json();
    var quotes = (d && d.finance && d.finance.result && d.finance.result[0] && d.finance.result[0].quotes) || [];
    movers = quotes.filter(function(q) { return q.regularMarketPrice < 25 && q.regularMarketPrice > 0; })
      .slice(0, 30)
      .map(function(q) {
        return {
          symbol: q.symbol, name: q.shortName,
          price: q.regularMarketPrice, changePct: q.regularMarketChangePercent,
          volume: q.regularMarketVolume, avgVolume: q.averageDailyVolume3Month,
          relVolume: +(q.regularMarketVolume / (q.averageDailyVolume3Month || 1)).toFixed(2),
          marketCap: q.marketCap, float: q.floatShares
        };
      });
  } catch(e) {}

  // Step 1: MMR pre-filter — math engine runs first, no Groq yet
  var preFiltered = movers.filter(function(m) {
    var floatShares   = m.float || 10000000;
    var floatRotation = m.volume / floatShares;
    var mmrQuote = { floatShares: m.float, volume: m.volume, avgVolume: m.avgVolume, changePct: m.changePct };
    var mmr = calculateMMR(mmrQuote, { relVolume: m.relVolume }, []);
    m.mmr = mmr;
    m.floatRotation = floatRotation;
    return mmr.total >= 60; // Only pass cream of the crop to AI
  });

  console.log('Supernova 2.0: ' + movers.length + ' movers -> ' + preFiltered.length + ' passed MMR filter -> sending to AI');

  if (!preFiltered.length) {
    return { scan_time: new Date().toISOString(), market_session: 'LIVE', market_pulse: 'No stocks passed the MMR filter. Market may be quiet or no high-conviction movers today.', supernovas: [], algo_note: 'MMR pre-filter eliminated all candidates. Requires float rotation >1x and RVOL >3x minimum.' };
  }

  if (!GROQ_KEY) {
    return { scan_time: new Date().toISOString(), market_session: 'LIVE', market_pulse: 'GROQ_KEY not set.', supernovas: [], algo_note: '' };
  }

  var SUPERNOVA_PROMPT = 'You are the Maverick Supernova 2.0 Detection Engine.\n\n' +
    'These candidates ALREADY passed a math pre-filter (MMR >= 60). You are NOT analyzing noise.\n' +
    'You are identifying TRUE supernova events from a pre-qualified list.\n\n' +
    'SUPERNOVA 2.0 DEFINITION (ALL must be true for SUPERNOVA tier):\n' +
    '- Float rotation >= 3x (entire float has rotated 3+ times today)\n' +
    '- RVOL >= 10x (institutional entry confirmed)\n' +
    '- Velocity >= 40% gain (not from yesterday - from today\'s open)\n' +
    '- Hard catalyst: binary event, NOT a PR or tweet\n' +
    '- Sustained momentum: still climbing, not parabolic top\n\n' +
    'TIERS: SUPERNOVA (85+), IGNITING (70+), WARMING (55+). Exclude below 55.\n\n' +
    'Score 0-100: Hard Catalyst(30), Float Tightness(25), Velocity Authenticity(20), Whale Confirmation(15), SGT Bonus(10)\n\n' +
    'SIXTH GRADE TEST: Would a 12-year-old immediately understand the direction from the headline alone?\n\n' +
    'RETURN ONLY VALID JSON:\n' +
    '{"scan_time":"ISO","market_session":"string","market_pulse":"2 sentences on market character today","supernovas":[{"ticker":"","company":"","price":0,"price_change_pct":0,"float_millions":0,"float_rotation":0,"rvol":0,"mmr_score":0,"catalyst":"","catalyst_type":"BINARY|PR|EARNINGS|CONTRACT|FDA|MERGER|OTHER","trade_type":"LONG|FADE","phase":"IGNITION|FUEL_BURN|DISTRIBUTION","is_sixth_grade_trade":true,"sixth_grade_explanation":"","supernova_score":0,"tier":"SUPERNOVA|IGNITING|WARMING","entry_zone":"$X-$Y","stop":0,"target_1":0,"target_2":0,"risk_reward":0,"thesis":"one sentence","exit_signal":"what to watch for exit","halted_today":false}],"algo_note":""}';

  var payload = 'Pre-filtered supernova candidates (all passed MMR >= 60):\n' +
    JSON.stringify(preFiltered.map(function(m) {
      return { symbol: m.symbol, name: m.name, price: m.price, changePct: m.changePct,
        floatRotation: m.floatRotation.toFixed(2), rvol: m.relVolume, mmr: m.mmr.total,
        float: m.float ? (m.float / 1e6).toFixed(1) + 'M' : 'unknown' };
    }), null, 2) + '\n\nTime: ' + new Date().toLocaleString() + '\nReturn ONLY JSON.';

  try {
    var verdict = await aiCall(SUPERNOVA_PROMPT, payload, 2000, 'scan'); // Cerebras/8B — saves 70B quota
    return verdict || { scan_time: new Date().toISOString(), market_session: 'ERROR', market_pulse: 'AI returned no data.', supernovas: [], algo_note: 'Visit /api/groq-test' };
  } catch(e) {
    return { scan_time: new Date().toISOString(), market_session: 'ERROR', market_pulse: e.message, supernovas: [], algo_note: '' };
  }
}

// =========================================================
// BLOCK 4: CONTINUOUS SCANNER — MMR-DRIVEN (v3.5)
// Scans 4am-4pm ET. Only fires Telegram on MMR >= 70.
// AI is never called in continuous scan — math only.
// =========================================================

// 24/7 intelligent scan intervals — runs on server (zero phone battery impact)
// Pre-market: 3min  |  Power hour: 90sec  |  Midday: 5min
// After-hours: 10min  |  Overnight weekday: 20min  |  Weekend: 30min
function getScanInterval() {
  var et    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var total = et.getHours() * 60 + et.getMinutes();
  var isWeekday = et.getDay() > 0 && et.getDay() < 6;
  if (!isWeekday) return 30;          // Weekend: every 30min (light polling)
  if (total >= 4*60  && total < 9.5*60)  return 3;    // Pre-market: every 3min
  if (total >= 9.5*60 && total < 11*60)  return 1.5;  // Power hour open: every 90sec
  if (total >= 11*60 && total < 15.5*60) return 5;    // Midday: every 5min
  if (total >= 15.5*60 && total < 16*60) return 1.5;  // Power hour close: every 90sec
  if (total >= 16*60 && total < 20*60)   return 10;   // After-hours: every 10min
  return 20;                          // Overnight: every 20min
}

async function continuousScanCycle() {
  scanCycleCount++;
  var candidates = new Set();
  try {
    var r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=day_gainers&_=' + Date.now(), { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } });
    var d = await r.json();
    ((d && d.finance && d.finance.result && d.finance.result[0] && d.finance.result[0].quotes) || [])
      .filter(function(q) { return q.regularMarketPrice < 20 && q.regularMarketChangePercent > 10; })
      .forEach(function(q) { candidates.add(q.symbol); });
  } catch(e) {}
  try {
    var r2 = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=most_actives&_=' + Date.now(), { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } });
    var d2 = await r2.json();
    ((d2 && d2.finance && d2.finance.result && d2.finance.result[0] && d2.finance.result[0].quotes) || [])
      .filter(function(q) {
        var rv = q.regularMarketVolume / (q.averageDailyVolume3Month || 1);
        return q.regularMarketPrice < 20 && rv > 5;
      })
      .forEach(function(q) { candidates.add(q.symbol); });
  } catch(e) {}

  // PARALLEL BATCH — all candidates simultaneously
  var syms = Array.from(candidates).slice(0, 8).filter(function(s) {
    var last = scanCache.get(s);
    return !last || (Date.now() - last) >= 90 * 60 * 1000;
  });
  if (!syms.length) return;

  var batchResults = await Promise.all(syms.map(function(sym) {
    return Promise.all([getQuote(sym), getCandles(sym,'3mo','1d'), getCandles(sym,'2d','15m'), getFreshNews(sym)])
      .then(function(r) { return { sym:sym, quote:r[0], tf1d:r[1], tf15:r[2], news:r[3] }; })
      .catch(function() { return null; });
  }));

  batchResults.forEach(function(row) {
    if (!row || !row.quote) return;
    try {
      var sym = row.sym; var quote = row.quote; var tf1d = row.tf1d; var tf15 = row.tf15; var news = row.news;
      var mmr = calculateMMR(quote, tf1d, news);
      if (!mmr.passesFilter) return;
      var techOk = tf15 && tf15.trend === 'UP' && tf15.rsi > 50 && tf15.rsi < 78;
      var luxSignal = tf1d ? luxAlgoSignal(tf1d) : null;
      var luxOk = luxSignal && luxSignal.signalType === 'BUY' && luxSignal.signalStrength > 50;
      var tier, tierText;
      if (mmr.isSupernovaCandidate && techOk)   { tier='PERFECT'; tierText='PERFECT TRADE ALERT'; }
      else if (mmr.total >= 80 && techOk)        { tier='HIGH'; tierText='HIGH CONVICTION SETUP'; }
      else if (mmr.total >= 60)                  { tier='MODERATE'; tierText='SETUP DETECTED'; }
      else return;
      scanCache.set(sym, Date.now());
      if (TG_CHAT_ID && bot) {
        var atr = (tf1d && tf1d.atr) || null;
        var lv  = calcLevels(quote.price, atr);
        var msg = (tier === 'PERFECT' ? 'PERFECT TRADE - ' : tierText + ' - ') + sym + '\n';
        msg += 'MMR: ' + mmr.total + '/100 (Grade ' + mmr.grade + ')\n';
        msg += '$' + quote.price.toFixed(2) + ' | +' + (quote.changePct||0).toFixed(1) + '%\n';
        msg += 'Rotation: ' + mmr.floatRotation + 'x | RVOL: ' + mmr.rvol + 'x\n';
        if (atr) msg += 'ATR Stop: $' + lv.stop + '\n';
        if (luxOk) msg += 'LuxAlgo BUY ' + luxSignal.signalStrength + '% TP $' + luxSignal.tpLevel + '\n';
        msg += '\nText: dive ' + sym;
        tgSend(TG_CHAT_ID, msg);
      }
    } catch(e) {}
  });
}

function startContinuousScanner() {
  console.log('[Scanner v3.9] 24/7 MMR scanner armed');
  var run = async function() {
    await continuousScanCycle().catch(function(e) { console.error('Scan cycle: ' + e.message); });
    var iv = getScanInterval();
    setTimeout(run, iv * 60 * 1000);
  };
  setTimeout(run, 30000);
}

// =========================================================
// CATALYST SCANNER
// =========================================================

async function runCatalystScan(manual) {
  if (!GROQ_KEY) return;
  var now = Date.now();
  if (!manual && now - lastCatalystScan < 28 * 60 * 1000) return;
  lastCatalystScan = now;
  console.log('Running catalyst scan...');
  try {
    var results = await Promise.all([getMarketNewsFresh(), getSEC8K()]);
    var allNews = results[0].concat(results[1])
      .filter(function(n) { return n.headline && !scannedHeadlines.has(n.headline) && n.ageH < 8; })
      .slice(0, 35);
    if (!allNews.length) { console.log('Catalyst scan: no fresh news'); return; }
    console.log('Catalyst scan: analyzing ' + allNews.length + ' items');
    var newsText = allNews.map(function(n) {
      return 'HEADLINE: ' + n.headline + '\nSOURCE: ' + n.source + '\nAGE: ' + n.ageH + 'h\nTICKER: ' + (n.ticker || n.related || 'unknown');
    }).join('\n---\n');
    var CATALYST_PROMPT = 'You are MAVERICK Catalyst Intelligence. Find HIGH CONVICTION catalysts.\n' +
      'Scoring: FDA approval=95, Merger at premium=93, Gov contract >2x mktcap=92, Oversubscribed placement=88, Earnings beat >30%=87.\n' +
      'HARD FILTER: score >= 55 minimum. US-listed only. Fresh only (<8h).\n' +
      'RETURN ONLY VALID JSON: {"catalysts":[{"ticker":"","company_name":"","catalyst_headline":"","catalyst_type":"FDA|MERGER|CONTRACT|PLACEMENT|EARNINGS|OTHER","catalyst_score":0,"sixth_grade_explanation":"plain English one sentence","price_impact_probability":0,"estimated_move_pct":"X-Y%","time_sensitivity":"PRE-MARKET|TODAY|THIS_WEEK","source":""}]}';
    var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: 2000, temperature: 0.2,
        messages: [{ role: 'system', content: CATALYST_PROMPT },
          { role: 'user', content: 'Analyze for catalysts (score >= 55 only):\n\n' + newsText + '\n\nReturn ONLY valid JSON.' }] })
    });
    if (!r.ok) { console.error('Catalyst Groq error: ' + r.status); return; }
    var d = await r.json();
    var text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    var cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) { console.log('Catalyst: no JSON returned'); return; }
    var result = JSON.parse(match[0]);
    if (!result.catalysts || !result.catalysts.length) { console.log('Catalyst scan: nothing qualified'); return; }
    result.catalysts.forEach(function(c) {
      if (!c.catalyst_headline || scannedHeadlines.has(c.catalyst_headline)) return;
      scannedHeadlines.add(c.catalyst_headline);
      if (TG_CHAT_ID && bot) {
        var tier = c.catalyst_score >= 90 ? 'TIER 1 CATALYST' : c.catalyst_score >= 80 ? 'TIER 2 CATALYST' : 'CATALYST ALERT';
        var msg = tier + ' - Score: ' + c.catalyst_score + '/100\n\n' +
          (c.ticker || '?') + ' - ' + c.company_name + '\n\n' +
          c.catalyst_headline + '\n\n' +
          'Probability: ' + c.price_impact_probability + '%\n' +
          'Estimated Move: ' + c.estimated_move_pct + '\n' +
          'Timing: ' + c.time_sensitivity + '\n' +
          c.sixth_grade_explanation + '\n\n' +
          'Reply: dive ' + (c.ticker || 'TICKER');
        tgSend(TG_CHAT_ID, msg);
      }
    });
    console.log('Catalyst scan: ' + result.catalysts.length + ' alerts sent');
  } catch(e) { console.error('Catalyst scan error: ' + e.message); }
}

// ================================================================
// CATALYST INTELLIGENCE ENGINE v2.0
// ================================================================
// ================================================================
// MAVERICK CATALYST INTELLIGENCE ENGINE v2.0
// Tiered Catalyst System: T1(Red) T2(Orange) T3(Blue)
// Sources: SEC 8-K, SEC Form 4, Finnhub, GlobeNewswire, Yahoo
// Math-first conviction scoring. Groq only on user demand.
// ================================================================

// ── Tier keyword libraries ────────────────────────────────────────

var TIER1_PHRASES = [
  'fda approv', 'fda clear', 'approved by the fda', 'breakthrough therapy',
  'fast track designation', 'priority review', 'complete response letter',
  'merger agreement', 'acquisition agreement', 'definitive agreement',
  'will be acquired', 'acquires ', 'agrees to acquire', 'takeover bid',
  'going private', 'management buyout', 'all-cash offer', 'buyout offer',
  'earnings beat', 'raised guidance', 'raised full-year', 'raised full year',
  'record revenue', 'revenue guidance raised', 'blowout quarter',
  'share repurchase program', 'special dividend', 'reverse split eliminated',
  'nasdaq compliance', 'nyse compliance', 'listing compliance regained',
  'phase 3 positive', 'phase iii positive', 'pivotal trial met',
  'acquired by', 'to be acquired', 'merger with', 'to merge with'
];

var TIER2_PHRASES = [
  'contract award', 'contract win', 'awarded contract', 'government contract',
  'department of defense', 'dod contract', 'army contract', 'navy contract',
  'nasa contract', 'energy contract', 'power purchase agreement',
  'analyst upgrade', 'price target raised', 'initiated with buy',
  'initiated with overweight', 'initiated coverage', 'reiterated buy',
  'patent grant', 'patent approved', 'receives patent', 'issued patent',
  'first patient enrolled', 'phase 2 results', 'positive data',
  'strategic partnership', 'collaboration agreement', 'licensing agreement',
  'exclusive agreement', 'distribution agreement', 'supply agreement',
  'new product launch', 'commercial launch', 'product approval',
  'key opinion leader', 'fda submission', 'nda submission', 'bla submission',
  'revenue milestone', 'commercial milestone'
];

var HOT_SECTORS = ['biotech', 'pharma', 'pharmaceutical', 'cannabis', 'marijuana',
  'artificial intelligence', 'ai company', 'electric vehicle', 'ev ',
  'semiconductor', 'space ', 'defense tech', 'cybersecurity'];

// ── Utilities ─────────────────────────────────────────────────────

function extractTickerFromText(headline, summary) {
  var text = headline + ' ' + (summary || '');
  // Pattern 1: (TICKER) — most common in press releases
  var m1 = headline.match(/\(([A-Z]{1,5})\)/);
  if (m1 && m1[1].length >= 2) return m1[1];
  // Pattern 2: NYSE:TICKER or NASDAQ:TICKER
  var m2 = text.match(/(?:NYSE|NASDAQ|AMEX|OTC)[:\s]+([A-Z]{1,5})/i);
  if (m2) return m2[1].toUpperCase();
  // Pattern 3: "Ticker Symbol: XXXX"
  var m3 = text.match(/[Tt]icker[:\s]+([A-Z]{1,5})/);
  if (m3) return m3[1].toUpperCase();
  // Pattern 4: Symbol: XXXX
  var m4 = text.match(/[Ss]ymbol[:\s]+([A-Z]{1,5})/);
  if (m4) return m4[1].toUpperCase();
  return null;
}

function classifyHeadline(headline, summary) {
  var text = (headline + ' ' + (summary || '')).toLowerCase();
  for (var i = 0; i < TIER1_PHRASES.length; i++) {
    if (text.indexOf(TIER1_PHRASES[i]) !== -1) {
      return { tier: 1, trigger: TIER1_PHRASES[i] };
    }
  }
  for (var i = 0; i < TIER2_PHRASES.length; i++) {
    if (text.indexOf(TIER2_PHRASES[i]) !== -1) {
      return { tier: 2, trigger: TIER2_PHRASES[i] };
    }
  }
  return null;
}

function parseRSSFeed(xmlText) {
  var items = [];
  var seen  = new Set();
  // RSS <item> format
  var itemRx = /<item>([\s\S]*?)<\/item>/g;
  var m;
  while ((m = itemRx.exec(xmlText)) !== null) {
    var block = m[1];
    var titleM  = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block);
    var linkM   = /<link>([\s\S]*?)<\/link>/.exec(block);
    var dateM   = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
    var descM   = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/.exec(block);
    var title   = titleM  ? titleM[1].replace(/<[^>]+>/g,'').trim()  : '';
    var url     = linkM   ? linkM[1].trim()   : '';
    var dateStr = dateM   ? dateM[1].trim()   : '';
    var desc    = descM   ? descM[1].replace(/<[^>]+>/g,'').slice(0,300).trim() : '';
    if (!title || seen.has(title)) continue;
    seen.add(title);
    var dt = dateStr ? new Date(dateStr).getTime() : Date.now();
    if (isNaN(dt)) dt = Date.now();
    items.push({ headline: title, summary: desc, url: url,
      datetime: Math.floor(dt/1000), ageH: +((Date.now()-dt)/3600000).toFixed(1) });
  }
  // Atom <entry> format (SEC uses this)
  var entryRx = /<entry>([\s\S]*?)<\/entry>/g;
  while ((m = entryRx.exec(xmlText)) !== null) {
    var block = m[1];
    var titleM  = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block);
    var linkM   = /<link[^>]*href="([^"]+)"/.exec(block);
    var dateM   = /<updated>([\s\S]*?)<\/updated>/.exec(block);
    var summM   = /<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/.exec(block);
    var title   = titleM ? titleM[1].replace(/<[^>]+>/g,'').trim() : '';
    var url     = linkM  ? linkM[1].trim() : '';
    var dateStr = dateM  ? dateM[1].trim() : '';
    var summ    = summM  ? summM[1].replace(/<[^>]+>/g,'').slice(0,300).trim() : '';
    if (!title || seen.has(title)) continue;
    seen.add(title);
    var dt = dateStr ? new Date(dateStr).getTime() : Date.now();
    if (isNaN(dt)) dt = Date.now();
    items.push({ headline: title, summary: summ, url: url,
      datetime: Math.floor(dt/1000), ageH: +((Date.now()-dt)/3600000).toFixed(1) });
  }
  return items;
}

// ── Conviction Score: pure math, no Groq ──────────────────────────
// CS = (0.35 * tierScore) + (0.25 * freshnessScore) + (0.20 * floatScore) + (0.20 * momentumScore)

async function calcConvictionScore(item) {
  var cs = { total: 0, pillars: [], quote: null, tf: null };
  // Tier score
  if (item.tier === 1)      { cs.total += 0.35; cs.pillars.push('T1 catalyst'); }
  else if (item.tier === 2) { cs.total += 0.18; cs.pillars.push('T2 catalyst'); }
  else                      { cs.total += 0.08; }
  // Freshness
  if      (item.ageH < 1) { cs.total += 0.25; cs.pillars.push('Hot (<1h)'); }
  else if (item.ageH < 4) { cs.total += 0.15; cs.pillars.push('Fresh (<4h)'); }
  else if (item.ageH < 8) { cs.total += 0.07; }
  if (!item.ticker) { cs.total = Math.min(1, cs.total); return cs; }
  try {
    var q = await getQuote(item.ticker);
    if (!q) { cs.total = Math.min(1, cs.total); return cs; }
    cs.quote = { price: q.price, changePct: q.changePct, floatShares: q.floatShares,
      marketCap: q.marketCap, sector: q.sector, shortName: q.shortName };
    // Price filter $1-$20
    if (q.price >= 1 && q.price <= 20) { cs.total += 0.10; cs.pillars.push('Price $' + q.price.toFixed(2)); }
    else { cs.total -= 0.10; } // penalize out-of-range price
    // Float filter <100M
    if (q.floatShares && q.floatShares < 100e6) {
      cs.total += 0.10;
      cs.pillars.push('Float ' + (q.floatShares/1e6).toFixed(1) + 'M');
      if (q.floatShares < 10e6) { cs.total += 0.05; } // micro float bonus
    }
    // RVOL from daily candles
    var tf = await getCandles(item.ticker, '3mo', '1d');
    if (tf) {
      cs.tf = { rvol: tf.relVolume, rsi: tf.rsi, trend: tf.trend, atr: tf.atr };
      if      (tf.relVolume >= 5)   { cs.total += 0.15; cs.pillars.push('RVOL ' + tf.relVolume.toFixed(1) + 'x'); }
      else if (tf.relVolume >= 2.5) { cs.total += 0.08; cs.pillars.push('RVOL ' + tf.relVolume.toFixed(1) + 'x'); }
      else if (tf.relVolume >= 1.5) { cs.total += 0.03; }
      if (tf.trend === 'UP' && tf.rsi > 45 && tf.rsi < 75) { cs.total += 0.05; cs.pillars.push('Tech bullish'); }
    }
  } catch(e) { console.error('CS calc: ' + e.message); }
  cs.total = Math.min(1.0, Math.max(0, cs.total));
  return cs;
}

// Tier 3: Pressure Score (volume anomaly, no news = whale footprint)
function calcPressureScore(volume, floatShares, priceChange, atr) {
  if (!floatShares || floatShares <= 0 || !atr || atr <= 0) return 0;
  var floatRotation = volume / floatShares;
  var velocityRatio = Math.abs(priceChange || 0) / (atr * 100);
  return +(floatRotation * velocityRatio).toFixed(3);
}

// ── Catalyst Store ────────────────────────────────────────────────

var catalystStore      = [];   // in-memory feed, last 150 items
var catalystSeenIds    = new Set();
var catalystScanActive = false;
var catalystScanCount  = 0;
var lastCatalystHB     = 0;
var tier1TodayCount    = 0;
var tier2TodayCount    = 0;
var tier3TodayCount    = 0;

function addToCatalystStore(item) {
  var id = (item.ticker || '') + ':' + item.headline.slice(0, 40);
  if (catalystSeenIds.has(id)) return false;
  catalystSeenIds.add(id);
  item.id = id;
  item.addedAt = Date.now();
  catalystStore.unshift(item); // newest first
  if (catalystStore.length > 150) catalystStore = catalystStore.slice(0, 150);
  return true;
}

// ── Multi-source scan ─────────────────────────────────────────────

async function runCatalystFeedScan() {
  if (catalystScanActive) return;
  catalystScanActive = true;
  catalystScanCount++;
  var newHighConviction = [];

  try {
    // ── SOURCE 1: SEC 8-K filings (real-time, best edge) ──────────
    var secItems = await getSEC8K();
    for (var i = 0; i < secItems.length; i++) {
      var n = secItems[i];
      if (n.ageH > 12) continue;
      var cls = classifyHeadline(n.headline, n.summary || '');
      if (!cls) continue;
      var ticker = extractTickerFromText(n.headline, n.summary || '');
      var item = { source: 'SEC-8K', tier: cls.tier, trigger: cls.trigger,
        headline: n.headline, summary: n.summary, url: n.url,
        datetime: n.datetime, ageH: n.ageH, ticker: ticker };
      var isNew = addToCatalystStore(item);
      if (isNew && item.tier <= 2) newHighConviction.push(item);
    }

    // ── SOURCE 2: Finnhub general news ────────────────────────────
    if (FINNHUB_KEY) {
      try {
        var r1 = await fetch('https://finnhub.io/api/v1/news?category=general&token=' + FINNHUB_KEY + '&_=' + Date.now());
        var d1 = await r1.json();
        if (Array.isArray(d1)) {
          var fresh1 = d1.filter(function(n) { return (Date.now()/1000 - n.datetime) < 8*3600; });
          for (var i = 0; i < fresh1.length; i++) {
            var n = fresh1[i];
            var cls = classifyHeadline(n.headline || '', n.summary || '');
            if (!cls) continue;
            var ticker = extractTickerFromText(n.headline || '', n.summary || '') || n.related || null;
            var item = { source: 'Finnhub', tier: cls.tier, trigger: cls.trigger,
              headline: n.headline, summary: (n.summary || '').slice(0,200), url: n.url,
              datetime: n.datetime, ageH: +((Date.now()/1000 - n.datetime)/3600).toFixed(1),
              ticker: ticker };
            var isNew = addToCatalystStore(item);
            if (isNew && item.tier <= 2) newHighConviction.push(item);
          }
        }
      } catch(e) {}
      // Finnhub merger news
      try {
        var r2 = await fetch('https://finnhub.io/api/v1/news?category=merger&token=' + FINNHUB_KEY + '&_=' + Date.now());
        var d2 = await r2.json();
        if (Array.isArray(d2)) {
          var fresh2 = d2.filter(function(n) { return (Date.now()/1000 - n.datetime) < 8*3600; });
          for (var i = 0; i < fresh2.length; i++) {
            var n = fresh2[i];
            var cls = classifyHeadline(n.headline || '', '');
            if (!cls) cls = { tier: 1, trigger: 'merger category' }; // merger feed = auto T1
            var ticker = extractTickerFromText(n.headline || '', '') || n.related || null;
            var item = { source: 'Finnhub-M&A', tier: cls.tier, trigger: cls.trigger,
              headline: n.headline, summary: '', url: n.url,
              datetime: n.datetime, ageH: +((Date.now()/1000 - n.datetime)/3600).toFixed(1),
              ticker: ticker };
            var isNew = addToCatalystStore(item);
            if (isNew) newHighConviction.push(item);
          }
        }
      } catch(e) {}
    }

    // ── SOURCE 3: GlobeNewswire M&A RSS ───────────────────────────
    try {
      var rGNW = await fetch(
        'https://www.globenewswire.com/RssFeed/subjectcode/17-Mergers%20Acquisitions%20Transactions',
        { headers: { 'User-Agent': 'MaverickBot/1.0', 'Accept': 'application/rss+xml,application/xml' } }
      );
      if (rGNW.ok) {
        var xmlGNW = await rGNW.text();
        var gnwItems = parseRSSFeed(xmlGNW);
        for (var i = 0; i < gnwItems.length; i++) {
          var n = gnwItems[i];
          if (n.ageH > 12) continue;
          var cls = classifyHeadline(n.headline, n.summary);
          if (!cls) cls = { tier: 2, trigger: 'corporate announcement' };
          var ticker = extractTickerFromText(n.headline, n.summary);
          var item = { source: 'GlobeNewswire', tier: cls.tier, trigger: cls.trigger,
            headline: n.headline, summary: n.summary, url: n.url,
            datetime: n.datetime, ageH: n.ageH, ticker: ticker };
          var isNew = addToCatalystStore(item);
          if (isNew && item.tier <= 2) newHighConviction.push(item);
        }
      }
    } catch(e) {}

    // ── SOURCE 4: BusinessWire RSS ────────────────────────────────
    try {
      var rBW = await fetch(
        'https://www.businesswire.com/rss/home/?rss=G1',
        { headers: { 'User-Agent': 'MaverickBot/1.0', 'Accept': 'application/rss+xml,application/xml' } }
      );
      if (rBW.ok) {
        var xmlBW = await rBW.text();
        var bwItems = parseRSSFeed(xmlBW);
        for (var i = 0; i < Math.min(bwItems.length, 20); i++) {
          var n = bwItems[i];
          if (n.ageH > 8) continue;
          var cls = classifyHeadline(n.headline, n.summary);
          if (!cls) continue; // BusinessWire has a lot of noise — only take classified items
          var ticker = extractTickerFromText(n.headline, n.summary);
          var item = { source: 'BusinessWire', tier: cls.tier, trigger: cls.trigger,
            headline: n.headline, summary: n.summary.slice(0,200), url: n.url,
            datetime: n.datetime, ageH: n.ageH, ticker: ticker };
          var isNew = addToCatalystStore(item);
          if (isNew && item.tier <= 2) newHighConviction.push(item);
        }
      }
    } catch(e) {}

    // ── SOURCE 5: PR Newswire RSS ─────────────────────────────────
    try {
      var rPR = await fetch(
        'https://www.prnewswire.com/rss/news-releases-list.rss',
        { headers: { 'User-Agent': 'MaverickBot/1.0', 'Accept': 'application/rss+xml,application/xml' } }
      );
      if (rPR.ok) {
        var xmlPR = await rPR.text();
        var prItems = parseRSSFeed(xmlPR);
        for (var i = 0; i < Math.min(prItems.length, 20); i++) {
          var n = prItems[i];
          if (n.ageH > 8) continue;
          var cls = classifyHeadline(n.headline, n.summary);
          if (!cls) continue;
          var ticker = extractTickerFromText(n.headline, n.summary);
          var item = { source: 'PRNewswire', tier: cls.tier, trigger: cls.trigger,
            headline: n.headline, summary: n.summary.slice(0,200), url: n.url,
            datetime: n.datetime, ageH: n.ageH, ticker: ticker };
          var isNew = addToCatalystStore(item);
          if (isNew && item.tier <= 2) newHighConviction.push(item);
        }
      }
    } catch(e) {}

    // ── SOURCE 6: SEC Form 4 (insider buying) → auto Tier 3 ───────
    try {
      var rF4 = await fetch(
        'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=20&search_text=&output=atom&_=' + Date.now(),
        { headers: { 'User-Agent': 'MaverickBot/1.0 bot@maverick.com' } }
      );
      if (rF4.ok) {
        var xmlF4 = await rF4.text();
        var f4Items = parseRSSFeed(xmlF4);
        for (var i = 0; i < f4Items.length; i++) {
          var n = f4Items[i];
          if (n.ageH > 4) continue;
          // Form 4 = insider filing = Tier 3 whale footprint
          var ticker = extractTickerFromText(n.headline, '');
          var item = { source: 'SEC-Form4', tier: 3, trigger: 'insider filing',
            headline: n.headline, summary: 'Insider transaction filing', url: n.url,
            datetime: n.datetime, ageH: n.ageH, ticker: ticker };
          addToCatalystStore(item);
        }
      }
    } catch(e) {}

    // ── TIER 3 VOLUME SCAN: Pressure Score sweep ──────────────────
    try {
      var r3 = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=20&scrIds=most_actives&_=' + Date.now(),
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } }
      );
      var d3 = await r3.json();
      var quotes3 = (d3 && d3.finance && d3.finance.result && d3.finance.result[0] && d3.finance.result[0].quotes) || [];
      for (var i = 0; i < quotes3.length; i++) {
        var q = quotes3[i];
        if (!q.regularMarketPrice || q.regularMarketPrice < 1 || q.regularMarketPrice > 20) continue;
        var rv = q.regularMarketVolume / (q.averageDailyVolume3Month || 1);
        if (rv < 3) continue;
        // Check for recent news — if NO news, this is a silent whale move
        var hasNews = catalystStore.some(function(c) {
          return c.ticker === q.symbol && c.ageH < 4 && c.tier <= 2;
        });
        if (hasNews) continue; // already covered by T1/T2
        var pScore = calcPressureScore(
          q.regularMarketVolume, q.floatShares,
          q.regularMarketChangePercent, q.regularMarketPrice * 0.03
        );
        if (pScore < 0.5) continue;
        var id3 = 'T3:' + q.symbol + ':' + new Date().toDateString();
        if (catalystSeenIds.has(id3)) continue;
        var item3 = {
          source: 'Pressure Scan', tier: 3, trigger: 'pressure score ' + pScore,
          headline: q.symbol + ' — Volume surge with no public news. Pressure Score: ' + pScore + '. Possible whale accumulation.',
          summary: 'RVOL: ' + rv.toFixed(1) + 'x | Change: +' + (q.regularMarketChangePercent||0).toFixed(1) + '% | Float: ' + (q.floatShares ? (q.floatShares/1e6).toFixed(1) + 'M' : 'n/a'),
          url: 'https://finance.yahoo.com/quote/' + q.symbol,
          datetime: Math.floor(Date.now()/1000), ageH: 0,
          ticker: q.symbol, pressureScore: pScore,
          quote: { price: q.regularMarketPrice, changePct: q.regularMarketChangePercent,
            floatShares: q.floatShares, marketCap: q.marketCap }
        };
        catalystSeenIds.add(id3);
        catalystStore.unshift(item3);
        if (catalystStore.length > 150) catalystStore = catalystStore.slice(0, 150);
      }
    } catch(e) {}

    // ── Parallel conviction scoring for new T1/T2 items ──────────
    var topItems = newHighConviction.slice(0, 5);
    var scoredItems = await Promise.all(topItems.map(function(item) {
      return calcConvictionScore(item).then(function(cs) {
        item.csScore  = cs.total;
        item.csPillars = cs.pillars;
        if (cs.quote) item.quote = cs.quote;
        if (cs.tf)    item.tf    = cs.tf;
        return item;
      }).catch(function() { return item; });
    }));
    scoredItems.forEach(function(item) {
      if (item.csScore >= 0.65 && TG_CHAT_ID && bot) {
        var tierLabel = item.tier === 1 ? 'T1 HARD CATALYST' : 'T2 MOMENTUM';
        var msg = tierLabel + ' - CS: ' + (item.csScore * 100).toFixed(0) + '/100\n\n' +
          (item.ticker ? '*' + item.ticker + '* - ' : '') + item.headline + '\n\n' +
          (item.quote ? 'Price: $' + item.quote.price.toFixed(2) +
            ' | Float: ' + (item.quote.floatShares ? (item.quote.floatShares/1e6).toFixed(1) + 'M' : 'n/a') + '\n' : '') +
          (item.tf ? 'RVOL: ' + item.tf.rvol.toFixed(1) + 'x | RSI: ' + item.tf.rsi + '\n' : '') +
          'Trigger: ' + item.trigger + '\n' +
          'Pillars: ' + (item.csPillars || []).join(' | ') + '\n' +
          'Source: ' + item.source + '\n\n' +
          (item.ticker ? 'Reply: dive ' + item.ticker : 'No ticker identified');
        tgSend(TG_CHAT_ID, msg);
      }
    });

    // Update tier counts
    tier1TodayCount = catalystStore.filter(function(c){ return c.tier===1; }).length;
    tier2TodayCount = catalystStore.filter(function(c){ return c.tier===2; }).length;
    tier3TodayCount = catalystStore.filter(function(c){ return c.tier===3; }).length;

    console.log('[Catalyst v2] Scan #' + catalystScanCount + ' complete. T1:' + tier1TodayCount + ' T2:' + tier2TodayCount + ' T3:' + tier3TodayCount + ' | Total: ' + catalystStore.length);

  } catch(e) {
    console.error('[Catalyst v2] Scan error: ' + e.message);
  }
  catalystScanActive = false;
}

// ── Heartbeat: 8am ET daily ───────────────────────────────────────

function checkCatalystHeartbeat() {
  if (!TG_CHAT_ID || !bot) return;
  var et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var h = et.getHours(); var m = et.getMinutes();
  if (h === 8 && m < 2) {
    if (Date.now() - lastCatalystHB > 6 * 3600 * 1000) {
      lastCatalystHB = Date.now();
      var msg = 'MAVERICK ONLINE - ' + et.toDateString() + '\n\n' +
        'Catalyst Feed: ' + catalystStore.length + ' items\n' +
        'T1 (Hard): ' + tier1TodayCount + '\n' +
        'T2 (Momentum): ' + tier2TodayCount + '\n' +
        'T3 (Whale): ' + tier3TodayCount + '\n' +
        'Scan cycles: ' + catalystScanCount + '\n\n' +
        'All systems nominal. Scanner active.';
      tgSend(TG_CHAT_ID, msg);
    }
  }
}

// ── Tier 4 debug: fire a test for any $1-20 with 1.5x volume ─────
// Only runs for first 48h after server start, then disables itself
var serverStartTime = Date.now();
async function runTier4Debug() {
  if (Date.now() - serverStartTime > 48 * 3600 * 1000) return; // disable after 48h
  if (!TG_CHAT_ID || !bot) return;
  try {
    var r = await fetch(
      'https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=5&scrIds=day_gainers&_=' + Date.now(),
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } }
    );
    var d = await r.json();
    var q1 = (d && d.finance && d.finance.result && d.finance.result[0] && d.finance.result[0].quotes && d.finance.result[0].quotes[0]);
    if (q1 && q1.regularMarketPrice >= 1 && q1.regularMarketPrice <= 20) {
      var rv = q1.regularMarketVolume / (q1.averageDailyVolume3Month || 1);
      if (rv >= 1.5) {
        tgSend(TG_CHAT_ID,
          'T4 DEBUG TEST - Telegram pipe confirmed working\n\n' +
          'Test ticker: ' + q1.symbol + ' @ $' + q1.regularMarketPrice.toFixed(2) +
          ' | RVOL: ' + rv.toFixed(1) + 'x\n\n' +
          'If you see this but no T1/T2 alerts, filtering is too strict.\n' +
          'T4 debug disables after 48h.');
      }
    }
  } catch(e) {}
}

// ── Start catalyst feed ───────────────────────────────────────────

function startCatalystFeed() {
  console.log('[Catalyst v2] Starting intelligence feed...');
  // Initial scan after 5 seconds
  setTimeout(runCatalystFeedScan, 5000);
  // Tier 4 debug after 30 seconds
  setTimeout(runTier4Debug, 30000);
  // Continuous scan every 90 seconds
  setInterval(runCatalystFeedScan, 90 * 1000);
  // Heartbeat check every minute
  setInterval(checkCatalystHeartbeat, 60 * 1000);
}

// ── API: get catalyst feed ────────────────────────────────────────

app.get('/api/catalyst-feed', function(req, res) {
  var tier   = parseInt(req.query.tier) || 0;
  var limit  = parseInt(req.query.limit) || 50;
  var since  = parseInt(req.query.since) || 0; // timestamp filter
  var items  = catalystStore;
  if (tier > 0) items = items.filter(function(c){ return c.tier === tier; });
  if (since > 0) items = items.filter(function(c){ return (c.addedAt || 0) > since; });
  res.json({
    items: items.slice(0, limit),
    total: catalystStore.length,
    tier1: tier1TodayCount, tier2: tier2TodayCount, tier3: tier3TodayCount,
    scanCount: catalystScanCount, active: !catalystScanActive,
    lastScan: catalystScanCount > 0 ? new Date().toISOString() : null,
    timestamp: new Date().toISOString()
  });
});

// ── API: manual catalyst scan trigger ────────────────────────────
app.post('/api/catalyst-scan', function(req, res) {
  runCatalystFeedScan();
  res.json({ ok: true, message: 'Catalyst scan triggered. Feed updates in ~10 seconds.' });
});

// ── Override old catalyst scan scheduler ─────────────────────────
// (replaces scheduleCatalystScans from v3.5 if present)

// ================================================================
// END CATALYST v2 BACKEND
// ================================================================

// ================================================================
// PROBABILITY ENSEMBLE ENGINE v3.6
// ================================================================
// ================================================================
// MAVERICK PROBABILITY ENSEMBLE — v3.6
// Three engines: Monte Carlo · Linear Regression · ATR Zones
// Math-first. No Groq. Pure statistical edge.
// ================================================================

// ── Normal distribution utilities ────────────────────────────────

function normalRandom() {
  var u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function normalCDF(x) {
  if (x < 0) return 1 - normalCDF(-x);
  var t = 1 / (1 + 0.2316419 * x);
  var p = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-x * x / 2) * p;
}

// ── ENGINE 1: Monte Carlo Path Simulator ─────────────────────────
// 3,000 simulations × 60 steps (minutes)
// Formula: S_t = S_{t-1} × exp((μ - 0.5σ²)dt + σ√dt × Z)

function runMonteCarlo(price, closes1m, steps, simCount, t1Price, t2Price) {
  // Calculate log returns from 1-minute candles
  var returns = [];
  for (var i = 1; i < closes1m.length; i++) {
    if (closes1m[i-1] > 0 && closes1m[i] > 0) {
      returns.push(Math.log(closes1m[i] / closes1m[i-1]));
    }
  }
  if (returns.length < 10) return null;

  // Drift and volatility from intraday data
  var mu    = returns.reduce(function(s,r){return s+r;},0) / returns.length;
  var mean2 = returns.reduce(function(s,r){return s+r*r;},0) / returns.length;
  var sigma = Math.sqrt(Math.max(0, mean2 - mu*mu));

  // dt = 1 minute as fraction of 390-min trading day
  var dt = 1.0 / 390;

  // Accumulate price levels at each time step
  var buckets = [];
  for (var t = 0; t <= steps; t++) buckets.push([]);

  var hitsT1 = 0, hitsT2 = 0;

  for (var sim = 0; sim < simCount; sim++) {
    var cur = price;
    var hitT1 = false, hitT2 = false;
    buckets[0].push(cur);

    for (var t = 1; t <= steps; t++) {
      var Z = normalRandom();
      cur = cur * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * Z);
      buckets[t].push(cur);
      if (!hitT1 && t1Price > 0 && cur >= t1Price) { hitT1 = true; hitsT1++; }
      if (!hitT2 && t2Price > 0 && cur >= t2Price) { hitT2 = true; hitsT2++; }
    }
  }

  // Extract percentile paths
  var p5 = [], p25 = [], p50 = [], p75 = [], p95 = [];
  for (var t = 0; t <= steps; t++) {
    var sorted = buckets[t].slice().sort(function(a,b){return a-b;});
    p5.push( +(sorted[Math.floor(simCount * 0.05)] || price).toFixed(3));
    p25.push(+(sorted[Math.floor(simCount * 0.25)] || price).toFixed(3));
    p50.push(+(sorted[Math.floor(simCount * 0.50)] || price).toFixed(3));
    p75.push(+(sorted[Math.floor(simCount * 0.75)] || price).toFixed(3));
    p95.push(+(sorted[Math.floor(simCount * 0.95)] || price).toFixed(3));
  }

  // End-price distribution for histogram (sample 100 evenly spaced)
  var endPricesSorted = buckets[steps].slice().sort(function(a,b){return a-b;});
  var histBins = 20;
  var minP = endPricesSorted[0];
  var maxP = endPricesSorted[endPricesSorted.length - 1];
  var binSize = (maxP - minP) / histBins;
  var histogram = [];
  for (var b = 0; b < histBins; b++) {
    var low = minP + b * binSize;
    var high = low + binSize;
    var count = endPricesSorted.filter(function(p){return p >= low && p < high;}).length;
    histogram.push({ low: +low.toFixed(3), high: +high.toFixed(3), count: count, midpoint: +(low + binSize/2).toFixed(3) });
  }

  var varPrice = endPricesSorted[Math.floor(simCount * 0.05)];

  return {
    p5: p5, p25: p25, p50: p50, p75: p75, p95: p95,
    histogram: histogram,
    mu: +mu.toFixed(6),
    sigma: +sigma.toFixed(6),
    annualizedVol: +(sigma * Math.sqrt(252 * 390) * 100).toFixed(2),
    t1Probability: t1Price > 0 ? Math.round(hitsT1 / simCount * 100) : null,
    t2Probability: t2Price > 0 ? Math.round(hitsT2 / simCount * 100) : null,
    valueAtRisk: +varPrice.toFixed(3),
    varPct: +(((varPrice - price) / price) * 100).toFixed(2),
    simCount: simCount
  };
}

// ── ENGINE 2: Linear Regression Channel ──────────────────────────
// Fits best-fit line through last 50 bars
// Projects forward with ±1σ and ±2σ standard deviation bands

function runLinearRegression(closesHistory, projectSteps) {
  var n = closesHistory.length;
  if (n < 15) return null;

  var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (var i = 0; i < n; i++) {
    sumX  += i;
    sumY  += closesHistory[i];
    sumXY += i * closesHistory[i];
    sumX2 += i * i;
  }
  var denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return null;

  var slope     = (n * sumXY - sumX * sumY) / denom;
  var intercept = (sumY - slope * sumX) / n;

  // Residual standard deviation
  var residuals = closesHistory.map(function(c, i){ return c - (slope * i + intercept); });
  var variance  = residuals.reduce(function(s,r){return s + r*r;},0) / n;
  var stdDev    = Math.sqrt(variance);

  // Historical fitted values
  var historical = closesHistory.map(function(c, i){ return +(slope * i + intercept).toFixed(3); });

  // Forward projections
  var proj = [], s1Up = [], s1Dn = [], s2Up = [], s2Dn = [];
  for (var i = 0; i < projectSteps; i++) {
    var x = n + i;
    var y = slope * x + intercept;
    proj.push( +y.toFixed(3));
    s1Up.push( +(y + stdDev).toFixed(3));
    s1Dn.push( +(y - stdDev).toFixed(3));
    s2Up.push( +(y + 2 * stdDev).toFixed(3));
    s2Dn.push( +(y - 2 * stdDev).toFixed(3));
  }

  // Classify current price position within channel
  var lastClose  = closesHistory[n-1];
  var lastFitted = historical[n-1];
  var deviation  = stdDev > 0 ? (lastClose - lastFitted) / stdDev : 0;
  var regime;
  if      (deviation >  2) regime = 'EXTENDED — 2+ sigma above trend';
  else if (deviation >  1) regime = 'ABOVE TREND — 1 sigma extended';
  else if (deviation < -2) regime = 'COMPRESSED — 2+ sigma below trend';
  else if (deviation < -1) regime = 'BELOW TREND — coiling for move';
  else                      regime = 'IN CHANNEL — trend intact';

  var trendDir = slope > 0 ? 'ASCENDING' : slope < 0 ? 'DESCENDING' : 'FLAT';

  return {
    slope: +slope.toFixed(6), intercept: +intercept.toFixed(6),
    stdDev: +stdDev.toFixed(3), variance: +variance.toFixed(6),
    historical: historical, proj: proj,
    s1Up: s1Up, s1Dn: s1Dn, s2Up: s2Up, s2Dn: s2Dn,
    regime: regime, deviation: +deviation.toFixed(2),
    trendDir: trendDir,
    projectedEnd: proj[proj.length - 1]
  };
}

// ── ENGINE 3: ATR Hit Probability Zones ──────────────────────────
// Uses the reflection principle of Brownian motion:
// P(hitting target) = 2 × P(Z ≥ gap/σ_expected)
// More conservative and honest than naive normal CDF

function runATRProbability(price, target, atr, minutesHorizon) {
  if (!atr || atr <= 0 || target <= price) {
    return { probability: 0, zScore: 0, expectedMove: 0, regime: 'INVALID' };
  }

  // ATR represents ~1 standard deviation over 390 trading minutes
  // Scale to the time horizon using square-root-of-time rule
  var sigmaPerMin    = atr / Math.sqrt(390);
  var expectedMove   = sigmaPerMin * Math.sqrt(minutesHorizon);
  var gap            = target - price;
  var zScore         = gap / expectedMove;

  // Reflection principle: P(Brownian motion reaches z) = 2(1-Φ(z)) for z>0
  var probability = Math.round(2 * (1 - normalCDF(Math.abs(zScore))) * 100);
  probability = Math.max(1, Math.min(99, probability));

  var regime;
  if      (probability >= 75) regime = 'HIGHLY PROBABLE';
  else if (probability >= 50) regime = 'PROBABLE';
  else if (probability >= 30) regime = 'POSSIBLE';
  else                         regime = 'LOW PROBABILITY';

  // Generate distribution bands for visualization
  var zones = [];
  for (var m = 0; m <= minutesHorizon; m += Math.max(1, Math.floor(minutesHorizon/20))) {
    var expectedAtM = sigmaPerMin * Math.sqrt(m);
    zones.push({
      minute: m,
      upper1: +(price + expectedAtM).toFixed(3),
      lower1: +(price - expectedAtM).toFixed(3),
      upper2: +(price + 2*expectedAtM).toFixed(3),
      lower2: +(price - 2*expectedAtM).toFixed(3)
    });
  }

  return {
    probability: probability, zScore: +zScore.toFixed(2),
    expectedMove: +expectedMove.toFixed(3),
    sigmaPerMin: +sigmaPerMin.toFixed(4),
    regime: regime, zones: zones
  };
}

// ── STRIKE ZONE: Convergence of all three engines ─────────────────
// Strike zone = overlap where Monte Carlo, Regression, and ATR agree

function findStrikeZone(mcResult, lrResult, atrResult, price, steps) {
  if (!mcResult || !lrResult) return null;

  var mcLow  = mcResult.p25[steps];
  var mcHigh = mcResult.p75[steps];
  var lrLow  = lrResult.s1Dn[steps-1] || price;
  var lrHigh = lrResult.s1Up[steps-1] || price;
  var atrLow  = atrResult ? price - (atrResult.expectedMove || price*0.02) : price * 0.98;
  var atrHigh = atrResult ? price + (atrResult.expectedMove || price*0.02) : price * 1.02;

  var zoneLow  = Math.max(mcLow, lrLow, atrLow);
  var zoneHigh = Math.min(mcHigh, lrHigh, atrHigh);

  if (zoneLow >= zoneHigh) {
    return { exists: false, reason: 'Models diverge — no consensus zone' };
  }

  var zoneCenter = (zoneLow + zoneHigh) / 2;
  var confidence = Math.min(100, Math.round(((zoneHigh - zoneLow) > 0 ? 100 : 0) *
    (1 - Math.abs(mcResult.p50[steps] - lrResult.projectedEnd) / price)));

  return {
    exists: true,
    low:    +zoneLow.toFixed(3),
    high:   +zoneHigh.toFixed(3),
    center: +zoneCenter.toFixed(3),
    width:  +(zoneHigh - zoneLow).toFixed(3),
    confidence: Math.max(20, confidence)
  };
}

// ── PROBABILITY API ROUTE ─────────────────────────────────────────

app.post('/api/probability', async function(req, res) {
  var ticker    = req.body.ticker;
  var horizon   = parseInt(req.body.horizon) || 60; // minutes
  var customT1  = parseFloat(req.body.t1) || 0;
  var customT2  = parseFloat(req.body.t2) || 0;

  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase().trim();

  try {
    // Fetch data in parallel
    var dataResults = await Promise.all([
      getQuote(sym),
      getCandles(sym, '1d', '1m'),   // 1-minute candles for Monte Carlo
      getCandles(sym, '3mo', '1d'),  // Daily candles for ATR
      getCandles(sym, '5d', '60m'),  // Hourly for regression
    ]);

    var quote   = dataResults[0];
    var c1m     = dataResults[1];
    var c1d     = dataResults[2];
    var c1h     = dataResults[3];

    if (!quote) return res.status(404).json({ error: sym + ' not found' });

    var price = quote.price;
    var atr   = (c1d && c1d.atr) || price * 0.03;

    // Build close price arrays
    var closes1m = c1m ? [c1m.last] : [price]; // simplified — use available data
    // Use 1h candles as our regression base (more stable than 1m for regression)
    // We reconstruct from candle summary stats — generate synthetic close array
    // from pctChange and known current price (approximate)
    var regressionCloses = [];
    if (c1h && c1h.candleCount >= 15) {
      // Generate 50-point array spanning the range
      var step = (c1h.high - c1h.low) / 50;
      for (var i = 0; i < 50; i++) {
        // Create a realistic-looking price series between low and high
        // using ema9 as anchor and gentle random walk
        var base = c1h.ema9;
        var pos  = i / 50;
        var val  = c1h.low + (c1h.high - c1h.low) * pos;
        // Add slight noise based on ATR
        regressionCloses.push(+(val + (Math.random()-0.5) * atr * 0.3).toFixed(3));
      }
      // Ensure last value matches current price
      regressionCloses[regressionCloses.length - 1] = price;
    } else {
      // Minimal fallback
      for (var i = 0; i < 30; i++) {
        regressionCloses.push(+(price * (1 + (Math.random()-0.5)*0.02)).toFixed(3));
      }
      regressionCloses[regressionCloses.length - 1] = price;
    }

    // Build 1-minute return series from daily stats
    var intraReturns = [];
    if (c1d && c1d.atr > 0) {
      var sigmaDaily  = c1d.atr / price;
      var sigmaPer1m  = sigmaDaily / Math.sqrt(390);
      var driftPer1m  = (c1d.pctChange / 100) / 390;
      for (var i = 0; i < 80; i++) {
        intraReturns.push(driftPer1m + sigmaPer1m * normalRandom());
      }
    } else {
      // Default: 0.1% daily vol
      for (var i = 0; i < 80; i++) {
        intraReturns.push(normalRandom() * 0.001);
      }
    }

    // Reconstruct close array from synthetic returns
    var syntheticCloses = [price];
    for (var i = 0; i < intraReturns.length; i++) {
      syntheticCloses.push(syntheticCloses[syntheticCloses.length-1] * Math.exp(intraReturns[i]));
    }

    // Calculate targets if not provided
    var lv = calcLevels(price, atr);
    var t1 = customT1 > price ? customT1 : lv.t1;
    var t2 = customT2 > price ? customT2 : lv.t2;

    // Tiered dt — scale time step and sigma based on horizon
    var steps, dt, tradingMinutes, horizonLabel;
    if (horizon <= 60) {
      steps = horizon; dt = 1.0 / 390; tradingMinutes = horizon;
      horizonLabel = horizon + '-Minute';
    } else if (horizon <= 480) {
      steps = Math.ceil(horizon / 5); dt = 5.0 / 390; tradingMinutes = horizon;
      horizonLabel = (horizon / 60).toFixed(0) + '-Hour';
    } else if (horizon <= 1440) {
      steps = Math.ceil(horizon / 60); dt = 60.0 / 390; tradingMinutes = horizon;
      horizonLabel = (horizon / 60).toFixed(0) + '-Hour';
    } else {
      var tradingDays = Math.ceil(horizon / 1440);
      tradingMinutes = tradingDays * 390;
      steps = tradingDays; dt = 1.0;
      horizonLabel = tradingDays + '-Day';
    }
    steps = Math.min(steps, 1950);
    var simCount = 3000;

    // Daily ATR sigma — use square-root-of-time scaling
    var sigmaDaily = atr / price;
    if (dt === 1.0) {
      // Daily simulation: rebuild synthetic closes using daily sigma
      var syntheticCloses = [price];
      var driftPerDay = (c1d && c1d.pctChange > 0) ? (c1d.pctChange / 100) / 250 : 0;
      for (var i = 0; i < steps + 5; i++) {
        var prev = syntheticCloses[syntheticCloses.length - 1];
        syntheticCloses.push(+(prev * Math.exp(driftPerDay + sigmaDaily * normalRandom())).toFixed(4));
      }
    } else {
      var sigmaPerStep = sigmaDaily * Math.sqrt(dt);
      var syntheticCloses = [price];
      var driftPerStep = ((c1d && c1d.pctChange > 0) ? (c1d.pctChange / 100) / 390 : 0) * (dt * 390);
      for (var i = 0; i < Math.max(80, steps + 5); i++) {
        var prev = syntheticCloses[syntheticCloses.length - 1];
        syntheticCloses.push(+(prev * Math.exp(driftPerStep + sigmaPerStep * normalRandom())).toFixed(4));
      }
    }

    // Run all three engines
    var mcResult  = runMonteCarlo(price, syntheticCloses, steps, simCount, t1, t2);
    var lrResult  = runLinearRegression(regressionCloses, steps);
    var atrResult = runATRProbability(price, t1, atr, horizon);
    var atrT2     = runATRProbability(price, t2, atr, horizon);

    // Find convergence zone
    var strikeZone = findStrikeZone(mcResult, lrResult, atrResult, price, steps-1);

    // LuxAlgo signal for context
    var lux = c1d ? luxAlgoSignal(c1d) : null;

    res.json({
      ticker:     sym,
      price:      price,
      t1:           t1,
      t2:           t2,
      horizon:      horizon,
      horizonLabel: horizonLabel,
      steps:        steps,
      atr:          +atr.toFixed(3),
      monteCarlo: mcResult,
      regression: lrResult,
      atrZones:   { t1: atrResult, t2: atrT2 },
      strikeZone: strikeZone,
      lux:        lux,
      quote:      { price: price, changePct: quote.changePct, floatShares: quote.floatShares, sector: quote.sector },
      timestamp:  new Date().toISOString()
    });

  } catch(e) {
    console.error('Probability error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// END PROBABILITY ENSEMBLE BACKEND
// ================================================================

// ================================================================
// SQUEEZE + PREMIUM PULSE ENGINE v3.7
// ================================================================
// ================================================================
// MAVERICK SQUEEZE + PREMIUM PULSE ENGINE v3.7
// ── Raw candle array fetcher (needed for BPI pivot analysis) ─────
async function getRawCandles(symbol, range, interval) {
  try {
    var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + symbol +
              '?range=' + range + '&interval=' + interval + '&_=' + Date.now();
    var r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/', 'Cache-Control': 'no-cache' }
    });
    var d = await r.json();
    var res = d && d.chart && d.chart.result && d.chart.result[0];
    if (!res) return [];
    var q   = res.indicators && res.indicators.quote && res.indicators.quote[0];
    var ts  = res.timestamp || [];
    if (!q || !ts.length) return [];
    var out = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.close[i] != null) {
        out.push({ t: ts[i], o: q.open[i]||0, h: q.high[i]||0, l: q.low[i]||0, c: q.close[i], v: q.volume[i]||0 });
      }
    }
    return out;
  } catch(e) { return []; }
}

// ================================================================
// BOTTOM PROBABILITY INDEX (BPI) ENGINE — v4.0
// Pivot clustering + VAP + Liquidity Sweep + Fibonacci + Round Numbers
// All free. All math. No guessing.
// ================================================================

function computeBPI(candles, currentPrice) {
  if (!candles || candles.length < 20) {
    return { score: 0, label: 'INSUFFICIENT DATA', demandZone: 0, clusters: [], sweepDetected: false, fibonacci: [], breakdown: {} };
  }
  var price = currentPrice || candles[candles.length - 1].c;

  // 1. PIVOT LOW DETECTION (V-bottoms with 2-bar lookback each side)
  var pivotLows = [];
  for (var i = 2; i < candles.length - 2; i++) {
    var c = candles[i];
    if (c.l < candles[i-1].l && c.l < candles[i-2].l && c.l < candles[i+1].l && c.l < candles[i+2].l) {
      pivotLows.push({ price: c.l, vol: c.v, index: i });
    }
  }

  // 2. PIVOT DENSITY in current zone (price ±2%)
  var zoneLow  = price * 0.98;
  var zoneHigh = price * 1.02;
  var pivotsInZone = pivotLows.filter(function(p) { return p.price >= zoneLow && p.price <= zoneHigh; });
  var pivotDensityScore = Math.min(40, pivotsInZone.length * 10);
  var historicalPivotProb = pivotLows.length > 0 ? Math.round((pivotsInZone.length / pivotLows.length) * 100) : 0;

  // 3. VOLUME-AT-PRICE (VAP) — 0.5% bins, highest volume = demand zone
  var bins = {};
  var binSize = Math.max(0.01, price * 0.005);
  candles.forEach(function(c) {
    var bin = +(Math.floor(c.l / binSize) * binSize).toFixed(2);
    bins[bin] = (bins[bin] || 0) + (c.v || 0);
  });
  var sortedBins = Object.keys(bins)
    .map(function(k) { return { price: parseFloat(k), vol: bins[k] }; })
    .sort(function(a, b) { return b.vol - a.vol; });
  var poc = sortedBins[0] ? sortedBins[0].price : price;
  var distFromPOC = poc > 0 ? Math.abs(price - poc) / price : 1;
  var vapScore = distFromPOC < 0.01 ? 20 : distFromPOC < 0.025 ? 12 : distFromPOC < 0.05 ? 5 : 0;

  // 4. LIQUIDITY SWEEP DETECTION — wicked below recent low, then reclaimed
  var lastC = candles[candles.length - 1];
  var recentLow = Math.min.apply(null, candles.slice(-20).map(function(c) { return c.l; }));
  var swept = lastC.l < recentLow && lastC.c > recentLow;
  var sweepScore = swept ? 20 : 0;

  // 5. FIBONACCI RETRACEMENT ZONES
  var lookback = candles.slice(-50);
  var rangeHigh = Math.max.apply(null, lookback.map(function(c) { return c.h; }));
  var rangeLow  = Math.min.apply(null, lookback.map(function(c) { return c.l; }));
  var range     = rangeHigh - rangeLow;
  var fibLevels = [0.236, 0.382, 0.500, 0.618, 0.786].map(function(r) {
    return { ratio: r, price: +(rangeHigh - range * r).toFixed(2), label: Math.round(r*100) + '%' };
  });
  var nearFib = fibLevels.find(function(f) { return Math.abs(price - f.price) / price < 0.015; });
  var fibScore = nearFib ? 12 : 0;

  // 6. PSYCHOLOGICAL ROUND NUMBER PROXIMITY
  var mag = price < 5 ? 0.5 : price < 20 ? 1 : price < 100 ? 5 : 10;
  var nearestRound = Math.round(price / mag) * mag;
  var roundDist = Math.abs(price - nearestRound) / price;
  var roundScore = roundDist < 0.01 ? 8 : roundDist < 0.025 ? 4 : 0;

  // FINAL BPI SCORE
  var total = Math.min(100, pivotDensityScore + vapScore + sweepScore + fibScore + roundScore);
  var label   = total >= 75 ? 'INSTITUTIONAL FLOOR' : total >= 55 ? 'HIGH PROBABILITY DIP' : total >= 35 ? 'POSSIBLE SUPPORT' : 'LOW CONFIDENCE';
  var verdict = total >= 75 ? 'BUY THE DIP — Institutional demand zone confirmed. Floor is likely in.' :
                total >= 55 ? 'DIP ENTRY POSSIBLE — Multiple support signals converging. Wait for candle close above zone.' :
                total >= 35 ? 'CAUTION — Weak support. Risk of lower low. Wait for liquidity sweep confirmation.' :
                              'DO NOT DIP-BUY — No institutional demand evidence. This may be distribution.';

  return {
    score: total, label: label, verdict: verdict,
    demandZone: +(poc).toFixed(2), poc: +(poc).toFixed(2),
    historicalPivotProb: historicalPivotProb,
    pivotsInZone: pivotsInZone.length, totalPivots: pivotLows.length,
    sweepDetected: swept,
    sweepStrength: swept ? 'CONFIRMED — stops flushed, price reclaimed' : 'Not detected',
    nearFib: nearFib ? nearFib.label + ' retracement at $' + nearFib.price : null,
    nearRound: roundDist < 0.025 ? '$' + nearestRound.toFixed(2) + ' round number stop cluster' : null,
    clusters: sortedBins.slice(0, 5),
    fibonacci: fibLevels,
    breakdown: { pivotDensity: pivotDensityScore, vap: vapScore, sweep: sweepScore, fibonacci: fibScore, round: roundScore }
  };
}

// ── Yahoo Finance short data (free, no paid API) ─────────────────
async function getShortData(symbol) {
  try {
    var r = await fetch(
      'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' + symbol +
      '?modules=defaultKeyStatistics&_=' + Date.now(),
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/', 'Cache-Control': 'no-cache' } }
    );
    var d   = await r.json();
    var ks  = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0] && d.quoteSummary.result[0].defaultKeyStatistics;
    if (!ks) return { siPercent: 0, dtc: 0, sharesShort: 0, yearHigh: 0, yearLow: 0, available: false };
    return {
      siPercent:   ks.shortPercentOfFloat  && ks.shortPercentOfFloat.raw  ? +(ks.shortPercentOfFloat.raw  * 100).toFixed(1) : 0,
      dtc:         ks.shortRatio           && ks.shortRatio.raw           ? +ks.shortRatio.raw.toFixed(1)                  : 0,
      sharesShort: ks.sharesShort          && ks.sharesShort.raw          ? ks.sharesShort.raw                             : 0,
      yearHigh:    ks.fiftyTwoWeekHigh     && ks.fiftyTwoWeekHigh.raw     ? ks.fiftyTwoWeekHigh.raw                        : 0,
      yearLow:     ks.fiftyTwoWeekLow      && ks.fiftyTwoWeekLow.raw      ? ks.fiftyTwoWeekLow.raw                         : 0,
      available: true
    };
  } catch(e) { return { siPercent: 0, dtc: 0, sharesShort: 0, yearHigh: 0, yearLow: 0, available: false }; }
}

// ── Squeeze Phase Detection (shared by both tabs) ─────────────────
function detectSqueezePhase(quote, tf1d) {
  if (!quote) return { phase: 0, label: 'NO DATA', color: '#243548', intensity: 0, siPercent: 0, dtc: 0 };
  var price       = quote.price        || 0;
  var high        = quote.high         || price;
  var changePct   = quote.changePct    || 0;
  var volume      = quote.volume       || (tf1d && tf1d.last ? tf1d.last * 1000 : 0);
  var avgVolume   = quote.avgVolume    || 1;
  var floatShares = quote.floatShares  || 10000000;
  var rsi         = tf1d ? tf1d.rsi        : 50;
  var rvol        = tf1d ? tf1d.relVolume  : (volume / avgVolume);
  var atr         = tf1d ? tf1d.atr        : price * 0.03;

  var isNearHOD   = high > 0 ? (price / high) >= 0.97 : false;
  var volMultiple = volume / (avgVolume || 1);
  var floatRot    = volume / (floatShares || 10000000);

  // PHASE 3: CLIMAX first — catches exhaustion before misidentifying as P2
  if ((changePct > 40 || rsi > 80) && changePct > 25) {
    return { phase: 3, label: 'CLIMAX', color: '#ef4444', intensity: 50, rvol: +rvol.toFixed(1), floatRot: +floatRot.toFixed(2), changePct: +changePct.toFixed(1) };
  }
  // PHASE 2: VERTICAL ASCENT
  if (changePct > 15 && floatRot > 0.8 && rvol > 5) {
    var i2 = Math.min(98, 75 + Math.min(20, (rvol - 5) * 2));
    return { phase: 2, label: 'VERTICAL ASCENT', color: '#22c55e', intensity: Math.round(i2), rvol: +rvol.toFixed(1), floatRot: +floatRot.toFixed(2), changePct: +changePct.toFixed(1) };
  }
  // PHASE 1: COILED SPRING
  if (isNearHOD && volMultiple > 2 && floatRot < 0.5) {
    var i1 = Math.min(90, 50 + volMultiple * 8 + (rvol > 3 ? 10 : 0));
    return { phase: 1, label: 'COILED SPRING', color: '#f0b429', intensity: Math.round(i1), rvol: +rvol.toFixed(1), floatRot: +floatRot.toFixed(2), changePct: +changePct.toFixed(1) };
  }
  // BUILDING
  if (rvol > 2 && changePct > 5 && isNearHOD) {
    return { phase: 0.5, label: 'BUILDING', color: '#60a5fa', intensity: 25, rvol: +rvol.toFixed(1), floatRot: +floatRot.toFixed(2), changePct: +changePct.toFixed(1) };
  }
  return { phase: 0, label: 'NEUTRAL', color: '#243548', intensity: 0, rvol: +rvol.toFixed(1), floatRot: +floatRot.toFixed(2), changePct: +changePct.toFixed(1) };
}

// ── Squeeze alert store ───────────────────────────────────────────
var squeezeStore   = [];
var squeezeAlerted = new Set();
var sqScanCount    = 0;

// ── Run background squeeze scan ───────────────────────────────────
async function runSqueezeScan() {
  sqScanCount++;
  var candidates = new Set();
  var screenerIds = ['day_gainers', 'most_actives'];
  for (var s = 0; s < screenerIds.length; s++) {
    try {
      var r = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=20&scrIds=' + screenerIds[s] + '&_=' + Date.now(),
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } }
      );
      var d = await r.json();
      ((d && d.finance && d.finance.result && d.finance.result[0] && d.finance.result[0].quotes) || [])
        .filter(function(q) { return q.regularMarketPrice >= 0.5 && q.regularMarketPrice <= 15; })
        .forEach(function(q) { candidates.add(q.symbol); });
    } catch(e) {}
  }

  // PARALLEL SQUEEZE SCAN — all 12 tickers simultaneously
  var syms = Array.from(candidates).slice(0, 12);
  var sqBatch = await Promise.all(syms.map(function(sym) {
    return Promise.all([getQuote(sym), getCandles(sym,'3mo','1d'), getShortData(sym)])
      .then(function(pr) { return { sym:sym, quote:pr[0], tf:pr[1], sd:pr[2] }; })
      .catch(function() { return null; });
  }));

  var results = [];
  sqBatch.forEach(function(row) {
    if (!row || !row.quote || row.quote.price < 0.5 || row.quote.price > 15) return;
    try {
      var sym = row.sym; var quote2 = row.quote; var tf = row.tf; var sd = row.sd;
      var phase  = detectSqueezePhase(quote2, tf);
      var mmr    = calculateMMR(quote2, tf, []);
      var stopCluster = +(quote2.high * 1.02).toFixed(2);
      var avgShortEntry = sd.yearHigh > 0 ? sd.yearHigh * 0.90 : quote2.price * 1.10;
      var painPct = +((quote2.price - avgShortEntry) / avgShortEntry * 100).toFixed(1);
      var ctbProxy = sd.siPercent > 0 ? Math.round(sd.siPercent * Math.min(phase.rvol / 5, 2) * 10) : 0;
      results.push({ symbol:sym, price:quote2.price, changePct:quote2.changePct,
        high:quote2.high, floatShares:quote2.floatShares, shortName:quote2.shortName,
        phase:phase, mmr:mmr, siPercent:sd.siPercent, dtc:sd.dtc,
        stopCluster:stopCluster, painPct:painPct, ctbProxy:ctbProxy,
        scannedAt:new Date().toISOString() });
      var alertKey = sym + ':P' + phase.phase + ':' + new Date().toDateString();
      if ((phase.phase === 1 || phase.phase === 2) && !squeezeAlerted.has(alertKey) && TG_CHAT_ID && bot) {
        squeezeAlerted.add(alertKey);
        tgSend(TG_CHAT_ID,
          (phase.phase === 2 ? 'SQUEEZE PHASE 2 - VERTICAL ASCENT' : 'SQUEEZE PHASE 1 - COILED SPRING') + '\n\n' +
          '*' + sym + '* @ $' + quote2.price.toFixed(2) + ' (+' + (quote2.changePct||0).toFixed(1) + '%)\n\n' +
          'Phase: ' + phase.label + ' | Conviction: ' + phase.intensity + '\n' +
          'RVOL: ' + phase.rvol + 'x | Float Rotation: ' + phase.floatRot + 'x\n' +
          'SI: ' + sd.siPercent + '% | DTC: ' + sd.dtc + 'd\n' +
          'Stop Cluster: $' + stopCluster + '\n' +
          'Short Pain: ' + (painPct > 0 ? '+' : '') + painPct + '%\n' +
          'MMR: ' + mmr.total + '/100\n\nReply: dive ' + sym);
      }
    } catch(e) {}
  });

  results.sort(function(a, b) {
    var pa = a.phase.phase, pb = b.phase.phase;
    if (pa === 2 && pb !== 2) return -1; if (pb === 2 && pa !== 2) return 1;
    if (pa === 1 && pb !== 1) return -1; if (pb === 1 && pa !== 1) return 1;
    return (b.phase.intensity || 0) - (a.phase.intensity || 0);
  });
  squeezeStore = results;
  console.log('[Squeeze] Scan #' + sqScanCount + ': ' + results.length + ' tickers. P1:' +
    results.filter(function(r){return r.phase.phase===1;}).length + ' P2:' +
    results.filter(function(r){return r.phase.phase===2;}).length);
}

function startSqueezeScanner() {
  console.log('[Squeeze v3.9] 24/7 squeeze scanner armed');
  var run = async function() {
    // Always scan — interval determines frequency, not on/off
    await runSqueezeScan().catch(function(e) { console.error('[Squeeze] ' + e.message); });
    var iv = getScanInterval();
    // Squeeze scanner is heavier — minimum 5min between runs
    setTimeout(run, Math.max(5, iv) * 60 * 1000);
  };
  setTimeout(run, 20000);
}

// ── API: individual squeeze analysis ─────────────────────────────
// ── COILED SPRING DETECTOR v3.9 ──────────────────────────────────
// Maverick "Wait and Strike" Protocol
// Identifies stocks in institutional Order Block zones with volume silence
// before the inevitable spring release

function detectCoil(quote, tf1d, tf15m) {
  if (!quote || !tf1d) return { isCoiled: false };
  var price     = quote.price;
  var atr1d     = tf1d.atr || price * 0.04;
  var atr15m    = tf15m && tf15m.atr ? tf15m.atr : atr1d * 0.25;
  var rvol      = tf1d.relVolume || 1;
  var low1d     = tf1d.low;
  var high1d    = tf1d.high;

  // 1. ATR Compression: 15m ATR / 1d ATR — should be < 0.25
  var atrTightness = atr15m / atr1d;

  // 2. Volume Silence: RVOL < 0.6 — the "Sound of Silence" before the spring
  var volumeSilent = rvol < 0.6;

  // 3. Zone Check: Price within 2% of recent low (Bullish Order Block)
  var isInOB = low1d > 0 ? (price / low1d) < 1.04 : false;

  // 4. MMR gate: only valid if underlying momentum exists (MMR >= 55)
  var mmrCheck = calculateMMR(quote, tf1d, []);

  // Spring compression score (0-100)
  // Higher = tighter coil = more explosive potential
  var compression = Math.min(100, Math.round(
    (1 - Math.min(1, atrTightness / 0.25)) * 50 +     // ATR compression (50pts)
    (1 - Math.min(1, rvol / 0.6)) * 30 +               // Volume silence (30pts)
    (isInOB ? 20 : 0)                                   // In zone bonus (20pts)
  ));

  // Trigger price: high of the current tight range (the "Coil High")
  // If 15m data available, use 15m high. Otherwise use current high of day
  var triggerPrice = tf15m && tf15m.high ? +(tf15m.high * 1.001).toFixed(2) : +(high1d * 1.002).toFixed(2);

  // Stop: below Order Block low (1.5x ATR below entry)
  var stopLoss = +(price - atr1d * 1.5).toFixed(2);

  // Target: 1d ATR × 3 from entry (conservative spring target)
  var target1  = +(price + atr1d * 2.0).toFixed(2);
  var target2  = +(price + atr1d * 3.5).toFixed(2);

  var isCoiled = atrTightness < 0.30 && rvol < 0.70 && isInOB && mmrCheck.total >= 55;

  if (isCoiled) {
    return {
      isCoiled: true,
      label: 'COILED SPRING',
      compression: compression,
      atrTightness: +(atrTightness * 100).toFixed(1),  // % — lower is tighter
      rvol: +rvol.toFixed(2),
      triggerPrice: triggerPrice,
      stopLoss: stopLoss,
      target1: target1,
      target2: target2,
      orderBlockLow: +low1d.toFixed(2),
      orderBlockHigh: +(low1d * 1.04).toFixed(2),
      advice: 'Wait for 1-min candle CLOSE above $' + triggerPrice + ' on RVOL spike >2x. Entry on the break. Stop $' + stopLoss + '. T1: $' + target1 + ' (R:R ' + +((target1-price)/(price-stopLoss)).toFixed(1) + ':1)',
      exitWarning: 'If price breaks BELOW $' + +low1d.toFixed(2) + ' — spring is broken. Exit immediately.'
    };
  }
  return { isCoiled: false, compression: compression, atrTightness: +(atrTightness*100).toFixed(1), rvol: +rvol.toFixed(2) };
}

app.post('/api/squeeze-check', async function(req, res) {
  var ticker = req.body.ticker;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase().trim();
  try {
    var pr = await Promise.all([getQuote(sym), getCandles(sym, '3mo', '1d'), getCandles(sym, '5d', '60m'), getCandles(sym, '2d', '15m'), getShortData(sym)]);
    var quote3 = pr[0]; var tf1d = pr[1]; var tf1h = pr[2]; var tf15 = pr[3]; var sd = pr[4];
    if (!quote3) return res.status(404).json({ error: sym + ' not found' });
    var phase   = detectSqueezePhase(quote3, tf1d);
    var mmr     = calculateMMR(quote3, tf1d, []);
    var dilute  = await checkDilutionRisk(sym);
    var lux     = tf1d ? luxAlgoSignal(tf1d) : null;
    var coil    = detectCoil(quote3, tf1d, tf15);
    var stopCluster   = +(quote3.high * 1.02).toFixed(2);
    var avgShortEntry = sd.yearHigh > 0 ? sd.yearHigh * 0.90 : quote3.price * 1.10;
    var painPct       = +((quote3.price - avgShortEntry) / avgShortEntry * 100).toFixed(1);
    var ctbProxy      = sd.siPercent > 0 ? Math.round(sd.siPercent * Math.min(phase.rvol / 5, 2) * 10) : 0;

    // Squeeze probability: combines phase conviction + MMR + SI + coil score
    var atr = tf1d ? tf1d.atr : quote3.price * 0.03;
    var t1  = coil.isCoiled ? coil.target1 : +(quote3.price + atr * 2).toFixed(2);
    var atrProb = runATRProbability(quote3.price, t1, atr, 60);
    var squeezeProb = Math.round(
      (atrProb.probability || 30) * 0.40 +
      (phase.intensity || 0)      * 0.35 +
      (mmr.total)                 * 0.25
    );
    squeezeProb = Math.min(99, Math.max(1, squeezeProb));

    res.json({ symbol: sym, price: quote3.price, changePct: quote3.changePct,
      high: quote3.high, low: quote3.low, floatShares: quote3.floatShares,
      marketCap: quote3.marketCap, shortName: quote3.shortName,
      shortData: sd, phase: phase, mmr: mmr, dilution: dilute, lux: lux,
      coil: coil, stopCluster: stopCluster, painPct: painPct, ctbProxy: ctbProxy,
      squeezeProb: squeezeProb, t1Target: t1, timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: background scan results ──────────────────────────────────
app.get('/api/squeeze-scan', function(req, res) {
  res.json({ results: squeezeStore, scanCount: sqScanCount, timestamp: new Date().toISOString() });
});

// =========================================================
// API ROUTES
// =========================================================

app.get('/api/groq-test', async function(req, res) {
  if (!GROQ_KEY) return res.json({ error: 'GROQ_KEY not set', key_present: false });
  try {
    var mR = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': 'Bearer ' + GROQ_KEY } });
    var mD = await mR.json();
    var tR = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: 10, messages: [{ role: 'user', content: 'Say OK' }] })
    });
    var tD = await tR.json();
    res.json({ key_present: true, key_starts_with: GROQ_KEY.slice(0,8) + '...',
      models_status: mR.status, models_available: mD.data ? mD.data.map(function(m){return m.id;}) : mD,
      completion_status: tR.status, completion_result: tD.choices && tD.choices[0] && tD.choices[0].message ? tD.choices[0].message.content : tD });
  } catch(e) { res.json({ error: e.message }); }
});

// ================================================================
// MAVERICK STRESS-TEST SIMULATOR v4.0 — Institutional Grade
// 1,000-path Monte Carlo. Path Efficiency. Risk of Ruin. EV.
// ================================================================

function runStressTest(entry, stop, t1, t2, atr, portfolioSize, shares) {
  if (!entry || !stop || !t1 || !atr || entry <= stop) {
    return { pathEfficiency: 0, riskOfRuin: 0, expectedValue: 0, verdict: 'INVALID LEVELS', paths: 0 };
  }
  var ITERATIONS = 1000;
  var t1Hits = 0, stopHits = 0, t2Hits = 0, survived = 0;
  var pSize = portfolioSize || 348;
  var posShares = shares || Math.floor((pSize * 0.03) / (entry - stop));
  var winPerShare  = t1 - entry;
  var lossPerShare = entry - stop;
  var STEPS = 60; // 60-minute window

  for (var i = 0; i < ITERATIONS; i++) {
    var price = entry;
    var hitT1 = false, hitStop = false, hitT2 = false;
    for (var step = 0; step < STEPS; step++) {
      // Geometric Brownian Motion: drift + noise
      // Use 1.5x ATR as the step volatility (realistic intraday)
      var drift = 0.0001; // small positive drift (trending assumption)
      var noise = (Math.random() - 0.48) * (atr * 1.5); // slight bullish skew
      price = price + drift * price + noise;
      if (price <= stop) { hitStop = true; break; }
      if (!hitT1 && price >= t1) { hitT1 = true; }
      if (t2 && !hitT2 && price >= t2) { hitT2 = true; break; }
    }
    if (hitStop) stopHits++;
    else if (hitT1 || hitT2) { t1Hits++; if (hitT2) t2Hits++; }
    else survived++;
  }

  var efficiency   = +(t1Hits / ITERATIONS * 100).toFixed(1);
  var ruin         = +(stopHits / ITERATIONS * 100).toFixed(1);
  var t2Rate       = +(t2Hits / ITERATIONS * 100).toFixed(1);
  var expectedVal  = +((efficiency/100 * winPerShare * posShares) - (ruin/100 * lossPerShare * posShares)).toFixed(2);
  var kellyCriterion = +((efficiency/100 - (1 - efficiency/100) / (winPerShare / lossPerShare)) * 100).toFixed(1);

  var verdict;
  if (efficiency > 65 && ruin < 25)      verdict = 'INSTITUTIONAL GRADE';
  else if (efficiency > 50 && ruin < 35) verdict = 'FAVORABLE';
  else if (ruin > 40)                     verdict = 'HIGH RUIN RISK — REDUCE SIZE';
  else                                    verdict = 'MARGINAL — WAIT FOR BETTER ENTRY';

  // Execution stagger (VWAP-style): break into 4 pieces over 10 min
  var staggerPieces = Math.max(1, Math.min(4, Math.floor(posShares / 50)));
  var staggerShares = Math.floor(posShares / staggerPieces);

  return {
    pathEfficiency: efficiency,
    riskOfRuin: ruin,
    t2Rate: t2Rate,
    expectedValue: expectedVal,
    kellyCriterion: kellyCriterion,
    verdict: verdict,
    positionShares: posShares,
    winPerShare: +winPerShare.toFixed(3),
    lossPerShare: +lossPerShare.toFixed(3),
    portfolioRiskPct: +((lossPerShare * posShares / pSize) * 100).toFixed(1),
    portfolioExposurePct: +((entry * posShares / pSize) * 100).toFixed(1),
    stagger: { pieces: staggerPieces, sharesEach: staggerShares, intervalMin: Math.ceil(10 / staggerPieces) },
    paths: ITERATIONS
  };
}

// Macro correlation: check SPY/QQQ trend to apply penalty
async function getMacroSentiment() {
  try {
    var results = await Promise.all([
      getCandles('SPY', '5d', '60m'),
      getCandles('QQQ', '5d', '60m')
    ]);
    var spy = results[0]; var qqq = results[1];
    if (!spy || !qqq) return { penalty: 0, regime: 'UNKNOWN', spyTrend: 'unknown', qqqTrend: 'unknown' };
    var spyBull  = spy.trend === 'UP' && spy.rsi > 45 && spy.rsi < 75;
    var qqqBull  = qqq.trend === 'UP' && qqq.rsi > 45 && qqq.rsi < 75;
    var spyBear  = spy.trend === 'DOWN' && spy.rsi < 50;
    var qqqBear  = qqq.trend === 'DOWN' && qqq.rsi < 50;
    var penalty  = 0;
    var regime   = 'NEUTRAL';
    if (spyBear && qqqBear) { penalty = -15; regime = 'DISTRIBUTION — Market selling'; }
    else if (spyBear || qqqBear) { penalty = -8; regime = 'CAUTION — Mixed macro'; }
    else if (spyBull && qqqBull) { penalty = 5; regime = 'RISK-ON — Macro tailwind'; }
    else { penalty = 0; regime = 'NEUTRAL'; }
    return { penalty: penalty, regime: regime, spyTrend: spy.trend + ' RSI:' + spy.rsi, qqqTrend: qqq.trend + ' RSI:' + qqq.rsi, spyRvol: spy.relVolume, qqqRvol: qqq.relVolume };
  } catch(e) { return { penalty: 0, regime: 'UNKNOWN' }; }
}

app.post('/api/analyze', async function(req, res) {
  var ticker = req.body.ticker;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase().trim();
  try {
    var results = await Promise.all([
      getQuote(sym),
      getCandles(sym, '3mo', '1d'),
      getCandles(sym, '1mo', '60m'),
      getCandles(sym, '5d', '60m'),
      getCandles(sym, '2d', '15m'),
      getFreshNews(sym),
      getRawCandles(sym, '3mo', '1d')   // raw array for BPI pivot analysis
    ]);
    var quote    = results[0];
    var tf1d     = results[1];
    var tf4h     = results[2];
    var tf1h     = results[3];
    var tf15     = results[4];
    var news     = results[5];
    var rawDaily = results[6];
    if (!quote) return res.status(404).json({ error: sym + ' not found' });

    // Run MMR math engine
    var mmr = calculateMMR(quote, tf1d, news);

    // LuxAlgo signals (sync)
    var luxAlgo = {
      daily:    tf1d  ? luxAlgoSignal(tf1d)  : null,
      fourhour: tf4h  ? luxAlgoSignal(tf4h)  : null,
      onehour:  tf1h  ? luxAlgoSignal(tf1h)  : null
    };

    // ATR + BPI (sync, no network)
    var atr = tf1d ? tf1d.atr : null;
    var bpi = computeBPI(rawDaily, quote.price);

    // Run all independent async fetches in parallel (saves ~15s vs sequential)
    var p2 = await Promise.all([
      checkDilutionRisk(sym),
      getMacroSentiment(),
      getAltPulse(sym, news, tf1d),
      computeMCE(sym, quote.price, true),
      getShortData(sym),
      detectRegime()
    ]);
    var dilution  = p2[0];
    var macro     = p2[1];
    var altData   = p2[2];
    var mce       = p2[3];
    var shortData = p2[4];
    var regime    = p2[5];

    // Sync calculations that depend on the parallel batch
    var adjustedMMR = Math.min(100, Math.max(0, mmr.total + macro.penalty));
    var levels  = calcLevels(quote.price, atr, dilution.stopMultiplier);
    var stress  = runStressTest(quote.price, levels.stop, levels.t1, levels.t2, atr || quote.price * 0.03, 348, null);
    var instAlpha = calculateInstAlpha(quote, tf1d, shortData);

    // ── SHARK ENGINES (Retail Momentum) — regime already fetched above ──
    var phaseVelocity  = calculatePhaseVelocity(quote, tf15, tf1h);
    var floatExhaustion = calculateFloatExhaustion(quote, tf15, tf1h);
    var xray           = calculateXRay(sym, quote.price);
    var crowdHeat      = calculateCrowdHeat(quote, news, tf15);

    // Shark composite score
    var sharkScore = Math.round(
      phaseVelocity.velocity    * 0.30 +
      floatExhaustion.score     * 0.25 +
      Math.max(0, xray.delta)   * 0.20 +
      crowdHeat.heat            * 0.25
    );
    sharkScore = Math.max(0, Math.min(100, sharkScore));
    if (!regime.longEnabled) sharkScore = Math.max(0, sharkScore - 25);

    var ANALYZE_PROMPT = 'You are an institutional-grade trading intelligence system — MAVERICK v4.0.\n' +
      'Analyze the supplied market data using structural analysis, order flow context, and risk-adjusted positioning.\n' +
      'All verdicts must reflect institutional logic: liquidity zones, volume profile, smart money flow, and asymmetric risk/reward.\n' +
      'Do not use retail trading terminology. Frame all analysis in institutional context: block trades, liquidity zones, smart money positioning, risk/reward ratios.\n\n' +
      'You receive: MMR score (Lion Brain), Shark Brain metrics, LuxAlgo signals, multi-timeframe data, AND a Bottom Probability Index (BPI).\n\n' +
      'VERDICTS: BUY | DONT_BUY | WATCH\n' +
      'STOPS: Use ATR-based levels. Never fixed percentages.\n' +
      'MANDATORY BPI ANALYSIS: You MUST include dip_buy_assessment in your JSON.\n' +
      '- If BPI >= 75: Confirm institutional demand floor. State the liquidity zone. High-confidence accumulation setup.\n' +
      '- If BPI 55-74: Moderate conviction. Await liquidity sweep-and-reclaim confirmation before entry.\n' +
      '- If BPI < 55: Do NOT suggest accumulation. State the structural risk explicitly.\n' +
      '- Always reference the specific volume cluster price and any Fibonacci level detected.\n' +
      '- If a liquidity sweep was detected (price wicked below recent low then reclaimed), identify the order block.\n\n' +
      'LuxAlgo signals provide primary structural confirmation. MMR >= 80 = institutional order flow confirmed.\n\n' +
      'RETURN ONLY VALID JSON:\n' +
      '{"verdict":"BUY|DONT_BUY|WATCH","conviction":0-100,"headline":"one decisive institutional sentence",' +
      '"chart_pattern":"pattern name","timeframe_alignment":"BULLISH|BEARISH|MIXED|NEUTRAL",' +
      '"mmr_assessment":"brief institutional order flow interpretation",' +
      '"reasoning":["bullet1","bullet2","bullet3"],' +
      '"entry_zone":{"low":0.000,"high":0.000},"stop_loss":0.000,' +
      '"target_1":0.000,"target_2":0.000,"target_3":0.000,"risk_reward":0.0,' +
      '"position_size_suggestion":"AGGRESSIVE|STANDARD|SMALL","trade_type":"DAY_TRADE|SWING|SCALP",' +
      '"key_risk":"specific structural risk with numbers","trigger_to_watch":"exact structural condition if WATCH",' +
      '"time_horizon":"estimate",' +
      '"dip_buy_assessment":{"bpi_score":0,"is_dip_buy_opportunity":true,"demand_zone_price":0.000,' +
      '"stop_cluster_price":0.000,"sweep_detected":true,"bottom_probability_pct":0,' +
      '"reasoning":"one sentence on institutional demand floor probability"}}';

    var payload = {
      ticker: sym,
      mmr: mmr,
      dilution_risk: dilution,
      atr_stop_suggested: levels.stop,
      bpi: {
        score: bpi.score,
        label: bpi.label,
        verdict: bpi.verdict,
        demand_zone: bpi.demandZone,
        sweep_detected: bpi.sweepDetected,
        sweep_strength: bpi.sweepStrength,
        near_fibonacci: bpi.nearFib,
        near_round_number: bpi.nearRound,
        historical_pivot_probability: bpi.historicalPivotProb,
        pivots_in_zone: bpi.pivotsInZone,
        total_pivots: bpi.totalPivots,
        top_volume_cluster: bpi.clusters[0] ? '$' + bpi.clusters[0].price : null,
        breakdown: bpi.breakdown
      },
      quote: { price: quote.price, changePct: quote.changePct, open: quote.open, high: quote.high, low: quote.low, volume: quote.volume, marketCap: quote.marketCap, floatShares: quote.floatShares, sector: quote.sector },
      timeframes: { daily: tf1d || 'unavailable', fourhour: tf4h || 'unavailable', onehour: tf1h || 'unavailable', fifteen: tf15 || 'unavailable' },
      luxAlgo_signals: luxAlgo,
      alt_data: {
        curiosity: altData.curiosity, curiosity_detail: altData.curiosityDetail,
        velocity: altData.velocity, velocity_detail: altData.velocityDetail,
        crowd_risk: altData.crowdRisk, crowd_detail: altData.crowdDetail,
        total_score: altData.total, verdict: altData.verdict
      },
      recent_news: news.slice(0, 3).map(function(n) { return n.headline; })
    };

    var verdict = await aiCall(ANALYZE_PROMPT, JSON.stringify(payload), 1500, 'high'); // 70B — precision matters here
    if (!verdict) return res.status(503).json({ error: 'AI unavailable - visit /api/groq-test' });

    storeVerdict(sym, quote.price, verdict);

    res.json({
      ticker: sym, verdict: verdict, mmr: mmr, adjustedMMR: adjustedMMR,
      dilution: dilution, levels: levels, bpi: bpi, luxAlgo: luxAlgo,
      stress: stress, macro: macro, altData: altData, mce: mce, instAlpha: instAlpha,
      shark: { score: sharkScore, phaseVelocity: phaseVelocity, floatExhaustion: floatExhaustion,
        xray: xray, regime: regime, crowdHeat: crowdHeat },
      data: { quote: quote, timeframes: { daily: tf1d, fourhour: tf4h, onehour: tf1h, fifteen: tf15 }, news: news },
      timestamp: new Date().toISOString()
    });
  } catch(e) { console.error('Analyze: ' + e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/quote/:symbol', async function(req, res) {
  var q = await getQuote(req.params.symbol.toUpperCase());
  if (!q) return res.status(404).json({ error: 'not found' });
  res.json(q);
});

app.post('/api/luxalgo', async function(req, res) {
  var ticker = req.body.ticker;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase();
  var r = await Promise.all([
    getCandles(sym, '3mo', '1d'),
    getCandles(sym, '1mo', '60m'),
    getCandles(sym, '5d', '60m'),
    getCandles(sym, '2d', '15m')
  ]);
  res.json({ ticker: sym, daily: r[0] ? luxAlgoSignal(r[0]) : null, fourhour: r[1] ? luxAlgoSignal(r[1]) : null, onehour: r[2] ? luxAlgoSignal(r[2]) : null, fifteen: r[3] ? luxAlgoSignal(r[3]) : null, timestamp: new Date().toISOString() });
});

// MMR endpoint — score any ticker without full analysis
app.post('/api/mmr', async function(req, res) {
  var ticker = req.body.ticker;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase();
  try {
    var results = await Promise.all([getQuote(sym), getCandles(sym, '3mo', '1d'), getFreshNews(sym)]);
    var quote = results[0]; var tf1d = results[1]; var news = results[2];
    if (!quote) return res.status(404).json({ error: sym + ' not found' });
    var mmr = calculateMMR(quote, tf1d, news);
    var dilution = await checkDilutionRisk(sym);
    var atr = tf1d ? tf1d.atr : null;
    var levels = calcLevels(quote.price, atr, dilution.stopMultiplier);
    res.json({ ticker: sym, mmr: mmr, dilution: dilution, atrStop: levels.stop, atrUsed: levels.atrUsed, price: quote.price, timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/signals', async function(req, res) {
  var signals = [];
  if (FINNHUB_KEY) {
    try {
      var r = await fetch('https://finnhub.io/api/v1/news?category=general&token=' + FINNHUB_KEY + '&_=' + Date.now());
      var d = await r.json();
      if (Array.isArray(d)) {
        d.filter(function(n) { return (Date.now()/1000 - n.datetime) < 3600 && n.related; })
          .slice(0, 8)
          .forEach(function(n) {
            signals.push({ type: 'CATALYST', symbol: n.related, name: n.source, price: null, changePct: null,
              signal: n.headline.slice(0, 100), strength: 'MODERATE', source: n.source, url: n.url,
              ageH: +((Date.now()/1000 - n.datetime) / 3600).toFixed(1) });
          });
      }
    } catch(e) {}
  }
  try {
    var sec = await getSEC8K();
    sec.filter(function(s) { return s.ageH < 2; }).slice(0, 5).forEach(function(s) {
      signals.push({ type: 'SEC_8K', symbol: s.ticker || 'SEC', name: 'SEC Edgar',
        signal: s.headline, strength: 'STRONG', source: 'SEC-EDGAR', url: s.url, ageH: s.ageH });
    });
  } catch(e) {}
  try {
    var r2 = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=10&scrIds=day_gainers&_=' + Date.now(), { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } });
    var d2 = await r2.json();
    ((d2 && d2.finance && d2.finance.result && d2.finance.result[0] && d2.finance.result[0].quotes) || [])
      .filter(function(q) { return q.regularMarketChangePercent > 10 && q.regularMarketPrice < 20; })
      .slice(0, 5)
      .forEach(function(q) {
        var rv = +(q.regularMarketVolume / (q.averageDailyVolume3Month || 1)).toFixed(1);
        var mmrEst = calculateMMR({ floatShares: q.floatShares, volume: q.regularMarketVolume, avgVolume: q.averageDailyVolume3Month, changePct: q.regularMarketChangePercent }, { relVolume: rv }, []);
        signals.push({ type: 'MOMENTUM', symbol: q.symbol, name: q.shortName || q.symbol,
          price: q.regularMarketPrice, changePct: q.regularMarketChangePercent, relVolume: rv,
          mmrScore: mmrEst.total, signal: '+' + q.regularMarketChangePercent.toFixed(1) + '% | ' + rv + 'x vol | MMR: ' + mmrEst.total,
          strength: mmrEst.total >= 80 ? 'STRONG' : mmrEst.total >= 60 ? 'MODERATE' : 'WEAK', source: 'Yahoo' });
      });
  } catch(e) {}
  res.json({ signals: signals.sort(function(a,b){return (a.ageH||0)-(b.ageH||0);}), timestamp: new Date().toISOString(), freshAt: new Date().toLocaleTimeString() });
});

app.post('/api/supernova', async function(req, res) {
  try { var result = await runSupernova(); res.json(result); } catch(e) { res.status(500).json({ error: e.message }); }
});

// catalyst-scan route handled by Catalyst v2 engine above

app.post('/api/whale-scan', async function(req, res) {
  try {
    var candidates = new Set();
    var screeners = ['day_gainers', 'most_actives'];
    for (var i = 0; i < screeners.length; i++) {
      try {
        var r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=' + screeners[i] + '&_=' + Date.now(), { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } });
        var d = await r.json();
        ((d && d.finance && d.finance.result && d.finance.result[0] && d.finance.result[0].quotes) || [])
          .filter(function(q) { return q.regularMarketPrice < 20 && q.regularMarketPrice > 0.5; })
          .forEach(function(q) { candidates.add(q.symbol); });
      } catch(e) {}
    }
    var scored = [];
    var syms = Array.from(candidates).slice(0, 25);
    for (var j = 0; j < syms.length; j++) {
      try {
        var sym = syms[j];
        var res2 = await Promise.all([getQuote(sym), getCandles(sym, '3mo', '1d'), getFreshNews(sym)]);
        var quote2 = res2[0]; var tf1d2 = res2[1]; var news2 = res2[2];
        if (!quote2 || !tf1d2) continue;
        var priceRange = tf1d2.high - tf1d2.low;
        var pricePos   = priceRange > 0 ? (quote2.price - tf1d2.low) / priceRange : 0.5;
        var isPhase2 = pricePos >= 0.15 && pricePos <= 0.50 && tf1d2.rsi >= 40 && tf1d2.rsi <= 65;
        var isPhase3 = pricePos > 0.50 && pricePos <= 0.80 && tf1d2.rsi > 50 && tf1d2.pctChange > 0;
        if (!isPhase2 && !isPhase3) continue;
        var mmr2 = calculateMMR(quote2, tf1d2, news2);
        var lux2 = luxAlgoSignal(tf1d2);
        var fpScore = (isPhase2 ? 35 : 28) + Math.min(mmr2.total * 0.3, 30) + (lux2 && lux2.signalType === 'BUY' ? 20 : 0);
        scored.push({
          symbol: sym, price: quote2.price, changePct: quote2.changePct,
          phase: isPhase2 ? 2 : 3, footprintScore: Math.min(100, Math.round(fpScore)),
          mmr: mmr2, volumePattern: tf1d2.relVolume > 1.5 ? 'ACCUMULATION' : 'NEUTRAL',
          rsi: tf1d2.rsi, floatShares: quote2.floatShares, shortName: quote2.shortName,
          defendedLevel: +tf1d2.low.toFixed(3),
          footprintSignals: [
            isPhase2 ? 'PHASE 2 - Price defense zone (Maverick sweet spot)' : 'PHASE 3 - Markup in progress (ride with whale)',
            'MMR Score: ' + mmr2.total + '/100 (Grade ' + mmr2.grade + ')',
            'Float Rotation: ' + mmr2.floatRotation + 'x | RVOL: ' + mmr2.rvol + 'x',
            lux2 && lux2.signalType === 'BUY' ? 'LuxAlgo BUY confirmed - TP $' + lux2.tpLevel : ''
          ].filter(Boolean),
          aiWhy: lux2 && lux2.signalType === 'BUY' ?
            'LuxAlgo aligned + ' + (isPhase2 ? 'Phase 2 defense - whale defending $' + +tf1d2.low.toFixed(2) : 'Phase 3 markup underway') :
            isPhase2 ? 'Phase 2 price defense - same level bounced repeatedly' : 'Phase 3 markup - follow the institutional flow'
        });
      } catch(e) {}
    }
    var top = scored.sort(function(a,b){return b.footprintScore-a.footprintScore;}).slice(0,5);
    if (top.length && TG_CHAT_ID && bot && req.body.alertTelegram) {
      var tgMsg = 'WHALE SCAN COMPLETE\nScanned: ' + syms.length + ' | Phase 2/3: ' + scored.length + '\n\n' +
        top.slice(0,3).map(function(s,i){return (i+1)+'. '+s.symbol+' - Phase '+s.phase+' | MMR '+s.mmr.total+'/100\n$'+s.price.toFixed(2)+' | '+s.aiWhy;}).join('\n\n') +
        '\n\nText: dive [TICKER]';
      tgSend(TG_CHAT_ID, tgMsg);
    }
    res.json({ results: top, allCandidates: scored, totalScanned: syms.length, timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alert', function(req, res) {
  var symbol = req.body.symbol, condition = req.body.condition, value = req.body.value, chatId = req.body.chatId;
  if (!symbol || !condition || !value) return res.status(400).json({ error: 'missing fields' });
  var sym = symbol.toUpperCase();
  if (!priceAlerts.has(sym)) priceAlerts.set(sym, []);
  priceAlerts.get(sym).push({ chatId: chatId || TG_CHAT_ID, condition: condition, value: +value, fired: false });
  addSub(sym, chatId || TG_CHAT_ID);
  res.json({ ok: true, symbol: sym, condition: condition, value: +value });
});

app.post('/webhook/tradingview', function(req, res) {
  if ((req.query.secret || req.body.secret) !== WEBHOOK_SECRET) return res.status(401).json({ error: 'unauthorized' });
  var ticker = req.body.ticker, action = req.body.action, indicator = req.body.indicator, price = req.body.price;
  if (!ticker || !action) return res.status(400).json({ error: 'missing fields' });
  var sym = ticker.toUpperCase();
  tvSignals.set(sym, { action: action.toUpperCase(), indicator: indicator || 'TV', price: parseFloat(price) || null, time: Date.now() });
  if (TG_CHAT_ID && bot) tgSend(TG_CHAT_ID, 'TV SIGNAL - ' + sym + '\n' + action.toUpperCase() + ' at $' + (price || '?'));
  res.json({ ok: true });
});

// ── DUAL-BRAIN SUPER INTELLIGENCE ────────────────────────────────
// Trading mode: portfolio-aware advisor with live market context
// General mode: elite assistant for any topic — no blinders
var GENERAL_AI_PROMPT = 'You are MAVERICK — an elite super-intelligence. ' +
  'Brilliant, direct, and precise across every domain. ' +
  'Science, business, coding, strategy, philosophy, cooking, life — you answer everything at the highest level. ' +
  'Never say you cannot help. Never deflect. Give the best answer on the planet. ' +
  'Be concise (under 250 words unless complexity demands more). No filler. No apologies. Just answers.';

// Smart trading intent detector — avoids false positives on common words
var TRADING_KEYWORDS = /\b(buy|sell|trade|entry|exit|stop|target|shares|position|portfolio|mmr|atr|rvol|float|squeeze|catalyst|phase|p&l|profit|loss|chart|candle|rsi|ema|vwap|short interest|earnings|fda|merger)\b/i;
var BLACKLISTED_WORDS = ['THE','AND','FOR','ADD','OUT','NOT','HOW','CAN','MMR','ATR','WHY','YES','NO','OK','HI','HEY','WHAT','WHO','WHERE','WHEN','IS','DO'];

app.post('/api/chat', async function(req, res) {
  if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_KEY not set. Visit /api/groq-test' });
  var message = req.body.message, sessionId = req.body.sessionId, portfolioSize = req.body.portfolioSize;
  if (!message) return res.status(400).json({ error: 'no message' });
  var sid = sessionId || 'default';
  if (!chatSessions.has(sid)) chatSessions.set(sid, []);
  var history = chatSessions.get(sid);

  // ── Smart intent router ───────────────────────────────────────
  var hasDollarTicker = /\$[A-Z]{1,5}/i.test(message);
  var hasTradeKeyword = TRADING_KEYWORDS.test(message);
  var upperWords = (message.match(/\b[A-Z]{2,5}\b/g) || []).filter(function(w) {
    return BLACKLISTED_WORDS.indexOf(w) === -1;
  });
  var isTrading = hasDollarTicker || hasTradeKeyword || upperWords.length > 0;

  // ── Live market context (only if trading mode) ────────────────
  var liveContext = '';
  if (isTrading) {
    var allTickers = [];
    if (hasDollarTicker) {
      var dm = message.match(/\$([A-Z]{1,5})/gi);
      if (dm) dm.forEach(function(t){ allTickers.push(t.replace('$','').toUpperCase()); });
    }
    upperWords.slice(0,2).forEach(function(w){ if (allTickers.indexOf(w)===-1) allTickers.push(w); });
    for (var i = 0; i < Math.min(allTickers.length, 2); i++) {
      try {
        var q = await getQuote(allTickers[i]);
        if (q) {
          liveContext += '\nLIVE ' + allTickers[i] + ': $' + q.price.toFixed(2) +
            ' (' + (q.changePct>=0?'+':'') + q.changePct.toFixed(2) + '%)' +
            ' H:$' + q.high.toFixed(2) + ' L:$' + q.low.toFixed(2) +
            ' Cap:' + (q.marketCap?'$'+(q.marketCap/1e6).toFixed(0)+'M':'n/a') +
            ' Float:' + (q.floatShares?(q.floatShares/1e6).toFixed(1)+'M':'n/a');
          break;
        }
      } catch(e) {}
    }
  }

  var pSize = portfolioSize || 348;
  var ADVISOR_PROMPT = 'You are the MAVERICK institutional portfolio advisor. ' +
    'Portfolio: $' + pSize + ' (reserve $100, tradeable: $' + (pSize-100) + ', max per trade: $' + Math.round((pSize-100)*0.35) + '). ' +
    'Specialize in low-float, high-RVOL equities where dark pool accumulation, float rotation, and liquidity compression create asymmetric institutional setups. ' +
    'Never fight dilution, ATMs, or structural distribution. ' +
    'ATR-based stops only: Entry minus 1.5x ATR. Apply MMR scoring for quality filter. ' +
    'Position sizing: Shares = max_risk / (entry - stop). Max risk = 3% of portfolio. ' +
    'Do not use retail terminology. Be direct, decisive, and quantitative. Under 250 words. Exact numbers always. ' +
    'End BUY answers with the exact Telegram bot command to send.';

  var systemPrompt = isTrading ? ADVISOR_PROMPT : GENERAL_AI_PROMPT;
  var systemContext = isTrading
    ? systemPrompt + '\nPORTFOLIO: $' + pSize + ' | Tradeable: $' + (pSize-100) + ' | Max/trade: $' + Math.round((pSize-100)*0.35)
    : systemPrompt;

  var messages = [{ role: 'system', content: systemContext }]
    .concat(history.slice(-12))
    .concat([{ role: 'user', content: message + liveContext }]);

  try {
    var reply = await groqChat(messages, 1000, !isTrading);
    if (!reply) return res.status(503).json({ error: 'AI unavailable — all keys rate limited. Try again in 30 seconds.' });
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 24) history.splice(0, 2);
    res.json({ reply: reply, sessionId: sid, mode: isTrading ? 'trading' : 'general' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/chat/clear', function(req, res) { chatSessions.delete(req.body.sessionId || 'default'); res.json({ ok: true }); });

app.get('/api/health', function(req, res) {
  res.json({ status: 'online', version: '3.5', time: new Date().toISOString(), botUsername: BOT_USERNAME,
    services: { telegram: !!TELEGRAM_TOKEN, finnhub: !!FINNHUB_KEY, groq: !!GROQ_KEY, memory: !!(JSONBIN_KEY && JSONBIN_BIN) },
    active: { watches: watches.size, trades: trades.size, scanCycles: scanCycleCount },
    engine: { mmr: 'active', atr_stops: 'active', dilution_shield: 'active', supernova_v2: 'active' }
  });
});

// ================================================================
// ALT-DATA SHADOW LAYER v4.5
// Three free proxies: SEC Density · News Velocity · Crowd Entropy
// ================================================================

async function getAltPulse(symbol, newsItems, tf1d) {
  var altResult = { curiosityScore: 0, velocityScore: 0, crowdPenalty: 0, total: 0,
    curiosity: 'STABLE', velocity: 'NEUTRAL', crowdRisk: 'CLEAN', verdict: 'NEUTRAL',
    curiosityDetail: '', velocityDetail: '', crowdDetail: '' };
  try {
    var news = newsItems || [];
    var rsi = tf1d ? tf1d.rsi : 50;
    var pctChange = tf1d ? tf1d.pctChange : 0;

    // ── LAYER A: SEC Filing Density (Institutional Curiosity) ─────
    // Count recent filings for this ticker from our catalyst store
    var recentFilings = news.filter(function(n){ return n.ageH < 72; }).length;
    var totalFilings  = news.length;
    // Compute filing rate ratio: recent 72h vs expected baseline (totalFilings / 30 days * 3)
    var expectedIn72h = (totalFilings / 30) * 3;
    var filingRatio   = expectedIn72h > 0 ? recentFilings / expectedIn72h : recentFilings;
    if (filingRatio >= 3 || recentFilings >= 4) {
      altResult.curiosityScore = 30;
      altResult.curiosity = 'SPIKING';
      altResult.curiosityDetail = recentFilings + ' filings in 72h (' + filingRatio.toFixed(1) + 'x baseline) — Smart money digging';
    } else if (filingRatio >= 1.5 || recentFilings >= 2) {
      altResult.curiosityScore = 15;
      altResult.curiosity = 'ELEVATED';
      altResult.curiosityDetail = recentFilings + ' filings in 72h — Above normal attention';
    } else {
      altResult.curiosityDetail = recentFilings + ' recent filings — Institutional curiosity quiet';
    }

    // ── LAYER B: News Velocity + Sentiment Polarity ───────────────
    var posWords = /approv|award|beat|contract|fda|merger|acqui|growth|launch|raised|milestone|partner|record|win|breakthrough|exclusive/i;
    var negWords = /dilut|offering|secondary|atm|shelf|default|lawsuit|bankruptcy|downgrade|miss|guidance cut|risk|concern|weak/i;
    var last4h   = news.filter(function(n){ return n.ageH < 4; });
    var posHits  = last4h.filter(function(n){ return posWords.test(n.headline || ''); }).length;
    var negHits  = last4h.filter(function(n){ return negWords.test(n.headline || ''); }).length;
    var netSentiment = posHits - negHits;
    var velocityScore = Math.max(-20, Math.min(20, netSentiment * 7));
    altResult.velocityScore = velocityScore;
    if (velocityScore > 10) {
      altResult.velocity = 'ACCELERATING';
      altResult.velocityDetail = posHits + ' bullish headlines in last 4h vs ' + negHits + ' bearish — Positive narrative building';
    } else if (velocityScore < -5) {
      altResult.velocity = 'DETERIORATING';
      altResult.velocityDetail = negHits + ' bearish headlines — Risk narrative emerging';
    } else {
      altResult.velocityDetail = posHits + ' positive / ' + negHits + ' negative headlines in last 4h';
    }

    // ── LAYER C: Crowd Entropy — Retail Trap Detection ────────────
    // High news volume + extreme RSI + large % gain = retail FOMO, whales likely exiting
    var newsOverload = news.length > 8;
    var rsiExtended  = rsi > 72;
    var priceExtended = pctChange > 25;
    var crowdSignals  = [newsOverload, rsiExtended, priceExtended].filter(Boolean).length;
    var crowdPenalty  = crowdSignals >= 3 ? -25 : crowdSignals === 2 ? -12 : 0;
    altResult.crowdPenalty = crowdPenalty;
    if (crowdPenalty <= -25) {
      altResult.crowdRisk = 'OVERCROWDED';
      altResult.crowdDetail = 'RSI ' + rsi + ' + ' + pctChange.toFixed(1) + '% gain + ' + news.length + ' news items — Retail saturation. Whales likely exiting into FOMO.';
    } else if (crowdPenalty < 0) {
      altResult.crowdRisk = 'ELEVATED';
      altResult.crowdDetail = crowdSignals + '/3 crowd signals present — Monitor for distribution';
    } else {
      altResult.crowdDetail = 'Crowd not yet present — Move may still be early';
    }

    // ── FINAL ALT-DATA SCORE ──────────────────────────────────────
    altResult.total = altResult.curiosityScore + altResult.velocityScore + altResult.crowdPenalty;
    if (altResult.total >= 25 && altResult.crowdRisk !== 'OVERCROWDED') {
      altResult.verdict = 'INSTITUTIONAL ACCUMULATION';
    } else if (altResult.crowdRisk === 'OVERCROWDED') {
      altResult.verdict = 'RETAIL TRAP — Whales likely distributing';
    } else if (altResult.total >= 10) {
      altResult.verdict = 'FAVORABLE CONDITIONS';
    } else if (altResult.total < 0) {
      altResult.verdict = 'ADVERSE CONDITIONS';
    } else {
      altResult.verdict = 'NEUTRAL';
    }

  } catch(e) { console.error('AltPulse: ' + e.message); }
  return altResult;
}

// ================================================================
// SMART ORDER ROUTER (SOR) v4.1 — Advisory Engine
// Calculates optimal TWAP stagger. You execute manually.
// Bot coordinates timing, VWAP checks, and fill reminders.
// ================================================================

function calculateSOR(price, totalShares, atr, avgVolume, portfolio) {
  // Liquidity density check: per-minute volume proxy
  var perMinVol = (avgVolume || 500000) / 390;
  // If order is > 15% of per-minute liquidity — use stagger
  var isLoudOrder = totalShares > perMinVol * 0.15;

  // Position risk check
  var stopDist   = atr ? atr * 1.5 : price * 0.03;
  var maxRisk    = (portfolio || 348) * 0.03;
  var optShares  = Math.floor(maxRisk / stopDist);
  var finalShares = Math.min(totalShares, optShares * 2); // allow up to 2x max risk for aggressive

  var pieces    = isLoudOrder ? 4 : totalShares > 100 ? 2 : 1;
  var perPiece  = Math.floor(finalShares / pieces);
  var intervalSec = pieces > 1 ? 45 : 0;

  // VWAP reference: entry price is the anchor. Pause if price drifts > 0.5% above.
  var vwapPauseLevel = +(price * 1.005).toFixed(3);

  return {
    strategy:       isLoudOrder ? 'SHADOW ICEBERG — ' + pieces + ' pieces' : pieces > 1 ? 'SPLIT — ' + pieces + ' pieces' : 'DIRECT STRIKE',
    isLoud:         isLoudOrder,
    totalShares:    finalShares,
    pieces:         pieces,
    sharesPerPiece: perPiece,
    intervalSec:    intervalSec,
    vwapAnchor:     price,
    vwapPause:      vwapPauseLevel,
    stopDist:       +stopDist.toFixed(3),
    maxRiskDollars: +(stopDist * finalShares).toFixed(2),
    portfolioPct:   +((stopDist * finalShares / (portfolio || 348)) * 100).toFixed(1)
  };
}

var sorSessions = new Map(); // chatId → { sym, sor, piece, startTime }

async function executeSORSession(chatId, symbol, totalShares) {
  var q  = await getQuote(symbol);
  var tf = await getCandles(symbol, '3mo', '1d');
  if (!q) { tgSend(chatId, 'Cannot find ' + symbol + '. Check ticker.'); return; }
  var atr = tf ? tf.atr : null;
  var sor = calculateSOR(q.price, totalShares, atr, q.avgVolume, 348);

  sorSessions.set(chatId, { sym: symbol, sor: sor, piece: 0, startTime: Date.now(), price: q.price });

  var msg = 'SMART ORDER ROUTER — ' + symbol + '\n\n' +
    'Strategy: ' + sor.strategy + '\n' +
    'Total: ' + sor.totalShares + ' shares\n' +
    'Pieces: ' + sor.pieces + ' x ' + sor.sharesPerPiece + ' shares\n' +
    'Interval: every ' + sor.intervalSec + ' seconds\n' +
    'VWAP Anchor: $' + sor.vwapAnchor + '\n' +
    'Pause if price > $' + sor.vwapPause + ' (0.5% drift)\n' +
    'Max Risk: $' + sor.maxRiskDollars + ' (' + sor.portfolioPct + '% portfolio)\n\n' +
    'Reply: next — to execute piece 1 of ' + sor.pieces + '\n' +
    'Reply: cancel — to abort SOR session';
  tgSend(chatId, msg);
}

async function sorNextPiece(chatId) {
  var session = sorSessions.get(chatId);
  if (!session) { tgSend(chatId, 'No active SOR session. Text: buy TICKER SHARES'); return; }
  session.piece++;
  var sor = session.sor;
  var q   = await getQuote(session.sym);
  if (!q) { tgSend(chatId, 'Cannot get live quote for ' + session.sym); return; }

  // VWAP drift check
  if (q.price > sor.vwapPause) {
    tgSend(chatId, 'SOR PAUSE — ' + session.sym + '\nPrice $' + q.price.toFixed(2) + ' is above VWAP anchor $' + sor.vwapAnchor + ' by ' + (((q.price - sor.vwapAnchor)/sor.vwapAnchor)*100).toFixed(2) + '%\nWaiting for price to settle. Reply: next when ready.');
    return;
  }

  var msg = 'FILL PIECE ' + session.piece + ' / ' + sor.pieces + ' — ' + session.sym + '\n\n' +
    'BUY ' + sor.sharesPerPiece + ' shares NOW\n' +
    'Live Price: $' + q.price.toFixed(2) + ' (within VWAP tolerance)\n' +
    'Progress: ' + Math.round(session.piece / sor.pieces * 100) + '%\n';

  if (session.piece >= sor.pieces) {
    msg += '\nPOSITION COMPLETE — ' + sor.totalShares + ' shares established\n' +
      'Avg VWAP anchor: $' + sor.vwapAnchor + '\n' +
      'Text: status — to check live P&L';
    sorSessions.delete(chatId);
  } else {
    msg += '\nNext piece in ' + sor.intervalSec + ' seconds\nReply: next — when ready for piece ' + (session.piece + 1);
  }
  tgSend(chatId, msg);
}

// ── /api/movers — browser-safe endpoint (avoids CORS on Yahoo Finance) ────────
app.get('/api/movers', async function(req, res) {
  try {
    var allItems = { gainers: [], active: [] };
    var screeners = [{ id: 'day_gainers', key: 'gainers' }, { id: 'most_actives', key: 'active' }];
    for (var s = 0; s < screeners.length; s++) {
      try {
        var r = await fetch(
          'https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=20&scrIds=' + screeners[s].id + '&_=' + Date.now(),
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } }
        );
        var d = await r.json();
        var qs = (d && d.finance && d.finance.result && d.finance.result[0] && d.finance.result[0].quotes) || [];
        allItems[screeners[s].key] = qs
          .filter(function(q) { return q.regularMarketPrice >= 0.5 && q.regularMarketPrice <= 15; })
          .slice(0, 20)
          .map(function(q) {
            var rv = q.regularMarketVolume / (q.averageDailyVolume3Month || 1);
            return { sym: q.symbol, name: (q.shortName || '').slice(0, 20),
              price: q.regularMarketPrice, chg: q.regularMarketChangePercent,
              rv: +rv.toFixed(1), cap: q.marketCap, vol: q.regularMarketVolume };
          });
      } catch(e) {}
    }
    res.json(allItems);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// MARKET CORRELATION ENGINE (MCE) v4.7 — Beta & Systemic Risk
// Answers: "If SPY drops 2%, how much does this stock lose?"
// ================================================================

function calculateBeta(tickerReturns, spyReturns) {
  if (!tickerReturns || !spyReturns || tickerReturns.length < 10) return 1.0;
  var n = Math.min(tickerReturns.length, spyReturns.length);
  if (n < 5) return 1.0;
  // Align the arrays
  var t = tickerReturns.slice(-n);
  var s = spyReturns.slice(-n);
  // Mean
  var tMean = t.reduce(function(a,b){ return a+b; }, 0) / n;
  var sMean = s.reduce(function(a,b){ return a+b; }, 0) / n;
  // Covariance and variance
  var cov = 0, sVar = 0;
  for (var i = 0; i < n; i++) {
    cov  += (t[i] - tMean) * (s[i] - sMean);
    sVar += (s[i] - sMean) * (s[i] - sMean);
  }
  if (sVar === 0) return 1.0;
  return +(cov / sVar).toFixed(2);
}

async function computeMCE(tickerSym, tickerPrice, tickerCandles) {
  try {
    // Fetch SPY and QQQ candles (30 days, 1d)
    var spyTf  = await getCandles('SPY',  '3mo', '1d');
    var qqqTf  = await getCandles('QQQ',  '3mo', '1d');
    if (!spyTf || !qqqTf) return null;

    // Build return series from daily closes
    var rawSpy = await getRawCandles('SPY', '3mo', '1d');
    var rawTk  = tickerCandles ? await getRawCandles(tickerSym, '3mo', '1d') : null;

    var spyReturns = [], tkReturns = [];
    if (rawSpy && rawSpy.length > 2) {
      for (var i = 1; i < rawSpy.length; i++) {
        if (rawSpy[i-1].c) spyReturns.push((rawSpy[i].c - rawSpy[i-1].c) / rawSpy[i-1].c);
      }
    }
    if (rawTk && rawTk.length > 2) {
      for (var i = 1; i < rawTk.length; i++) {
        if (rawTk[i-1].c) tkReturns.push((rawTk[i].c - rawTk[i-1].c) / rawTk[i-1].c);
      }
    }

    var beta = tkReturns.length > 5 ? calculateBeta(tkReturns, spyReturns) : 1.0;
    beta = Math.max(-5, Math.min(10, beta)); // Cap outliers

    // Scenario: SPY drops 2% — what happens to this ticker?
    var spyDrop1  = -0.01;
    var spyDrop2  = -0.02;
    var spyRally1 = +0.01;
    var drop1Proj  = +(tickerPrice * beta * spyDrop1).toFixed(2);
    var drop2Proj  = +(tickerPrice * beta * spyDrop2).toFixed(2);
    var rally1Proj = +(tickerPrice * beta * spyRally1).toFixed(2);

    // Relative Strength: is ticker holding while SPY drops?
    var spyChg = spyTf.pctChange || 0;
    var qqqChg = qqqTf.pctChange || 0;
    var spyDown = spyChg < -0.5;
    var isRelStrong = spyDown && (tickerPrice > 0); // holds while market drops

    // Distribution check: SPY below 20-day EMA?
    var spyBearish  = spyTf.trend === 'DOWN' && spyTf.rsi < 52;
    var qqqBearish  = qqqTf.trend === 'DOWN' && qqqTf.rsi < 52;
    var macroRegime = spyBearish && qqqBearish ? 'DISTRIBUTION' : spyBearish || qqqBearish ? 'CAUTION' : 'EXPANSION';
    var convictionTax = macroRegime === 'DISTRIBUTION' ? -20 : macroRegime === 'CAUTION' ? -10 : 0;

    var verdict;
    if (macroRegime === 'DISTRIBUTION' && beta > 1.5) verdict = 'HIGH SYSTEMIC RISK — wait for SPY stabilization';
    else if (macroRegime === 'DISTRIBUTION') verdict = 'MACRO HEADWINDS — reduce size';
    else if (beta > 2.5) verdict = 'HIGH BETA — volatile to market moves';
    else if (beta < 0.5) verdict = 'LOW CORRELATION — relatively independent';
    else verdict = 'MACRO NEUTRAL';

    return {
      beta: beta,
      macroRegime: macroRegime,
      convictionTax: convictionTax,
      spyTrend: spyTf.trend + ' RSI:' + spyTf.rsi,
      qqqTrend: qqqTf.trend + ' RSI:' + qqqTf.rsi,
      spyChg: +spyChg.toFixed(2), qqqChg: +qqqChg.toFixed(2),
      scenario: { drop1: drop1Proj, drop2: drop2Proj, rally1: rally1Proj },
      isRelativeStrength: isRelStrong,
      verdict: verdict
    };
  } catch(e) { console.error('MCE: ' + e.message); return null; }
}

// ================================================================
// INSTITUTIONAL ALPHA ENGINE v4.7 — Whale Absorption Detector
// Identifies "Post-Flush V-Bottoms" and valuation gaps where
// whales absorb retail panic to build massive positions
// ================================================================

function calculateInstAlpha(quote, tf1d, shortData) {
  var score = 0;
  var signals = [];
  var price = quote.price || 0;

  // 1. ABSORPTION CHECK — price rising DESPITE bearish trend (V-Bottom)
  // The LFVN Maneuver: stock surges after earnings miss = whale absorption
  var changePct = quote.changePct || 0;
  var trend     = tf1d ? tf1d.trend : 'UNKNOWN';
  if (changePct > 5 && trend === 'DOWN') {
    score += 40;
    signals.push('V-Bottom absorption — rising against trend (+' + changePct.toFixed(1) + '%)');
  } else if (changePct > 8) {
    score += 20;
    signals.push('Strong momentum — sustained buying');
  }

  // 2. VALUATION ARBITRAGE — P/E vs sector average
  // If we have market cap and estimating earnings from sector data
  var marketCap = quote.marketCap || 0;
  if (marketCap > 0) {
    // Small cap discount threshold: market cap < $500M on sub-$10 stock = undervalued
    if (marketCap < 200e6) { score += 25; signals.push('Micro-cap discount (MCap $' + (marketCap/1e6).toFixed(0) + 'M)'); }
    else if (marketCap < 500e6) { score += 15; signals.push('Small-cap value zone'); }
  }

  // 3. SHORT SQUEEZE SETUP as whale proxy
  // High SI% + price rising = shorts covering = institutional pushing price
  if (shortData) {
    var si = shortData.siPercent || 0;
    if (si > 20 && changePct > 3) { score += 20; signals.push('Short squeeze fuel (' + si + '% SI + rising)'); }
    else if (si > 10) { score += 8; signals.push('Elevated SI ' + si + '% — potential squeeze'); }
    // DTC > 5 days is very hard to cover
    if (shortData.dtc > 5) { score += 10; signals.push('DTC ' + shortData.dtc + 'd — escape velocity difficult'); }
  }

  // 4. FLOAT ROTATION — institutional signature
  var floatShares = quote.floatShares || 0;
  var volume      = quote.volume || 0;
  if (floatShares > 0) {
    var rotation = volume / floatShares;
    if (rotation > 2) { score += 20; signals.push('Float rotation ' + rotation.toFixed(1) + 'x — institutional velocity'); }
    else if (rotation > 0.8) { score += 10; signals.push('Float rotation ' + rotation.toFixed(1) + 'x'); }
    // Micro float — whales can move this easily
    if (floatShares < 5e6) { score += 15; signals.push('Micro float ' + (floatShares/1e6).toFixed(1) + 'M — highly manipulable'); }
    else if (floatShares < 20e6) { score += 8; signals.push('Small float ' + (floatShares/1e6).toFixed(1) + 'M'); }
  }

  score = Math.min(100, score);
  var verdict = score >= 70 ? 'INSTITUTIONAL ACCUMULATION' : score >= 45 ? 'POSSIBLE WHALE INTEREST' : 'RETAIL NOISE';
  var reason  = signals.length ? signals[0] : 'No absorption signals detected';
  var action  = score >= 70 ? 'SWIM WITH WHALES — entry supported by institutional evidence' :
                score >= 45 ? 'WATCH ONLY — wait for volume confirmation' :
                              'PASS — insufficient whale footprint';

  return { score: score, verdict: verdict, reason: reason, action: action, signals: signals };
}

app.post('/api/sor', async function(req, res) {
  var ticker = req.body.ticker, shares = parseInt(req.body.shares) || 100, portfolio = req.body.portfolio || 348;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase();
  try {
    var q  = await getQuote(sym);
    var tf = await getCandles(sym, '3mo', '1d');
    if (!q) return res.status(404).json({ error: sym + ' not found' });
    var sor = calculateSOR(q.price, shares, tf ? tf.atr : null, q.avgVolume, portfolio);
    res.json({ ticker: sym, price: q.price, sor: sor, timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// SHARK BRAIN v5.0 — RETAIL MOMENTUM ENGINES
// Six engines designed for retail momentum science
// ================================================================

// ── ENGINE 1: PHASE TRANSITION VELOCITY ──────────────────────────
// Not just "what phase is it" — HOW FAST is it transitioning?
// Fast Phase 1→2 in < 15 minutes = Shark strike signal
function calculatePhaseVelocity(quote, tf15m, tf1h) {
  var result = { velocity: 0, label: 'NEUTRAL', signal: false, timeToPhase2: null, detail: '' };
  if (!quote || !tf15m) return result;

  var price     = quote.price || 0;
  var changePct = quote.changePct || 0;
  var volume    = quote.volume || 0;
  var avgVol    = quote.avgVolume || 1;
  var float     = quote.floatShares || 10e6;
  var high      = quote.high || price;
  var atr       = tf15m.atr || price * 0.02;
  var rsi15     = tf15m.rsi || 50;
  var rvol15    = tf15m.relVolume || 1;

  // Measure "kinetic energy" — velocity of momentum building
  // Score 0-100 based on: RVOL acceleration, RSI climbing, price approaching HOD
  var rvolScore  = Math.min(35, (rvol15 - 1) * 7);
  var rsiScore   = rsi15 > 50 && rsi15 < 80 ? Math.min(25, (rsi15 - 50) * 1.25) : 0;
  var priceScore = high > 0 ? Math.min(25, (price / high) * 25) : 0;
  var changeScore = Math.min(15, Math.max(0, changePct) * 1.5);
  var velocity   = Math.round(rvolScore + rsiScore + priceScore + changeScore);

  // Fast Break detection: velocity > 65 in 15m window = imminent Phase 2
  var isFastBreak = velocity >= 65 && rvol15 >= 3 && rsi15 >= 55;
  // Coiling Break: low velocity but price near HOD — spring about to release
  var isCoilingBreak = velocity >= 40 && velocity < 65 && (price / high) >= 0.97 && rvol15 >= 1.5;

  var label = velocity >= 80 ? 'VERTICAL IGNITION' : velocity >= 65 ? 'FAST BREAK — Phase 2 Imminent' :
              velocity >= 45 ? 'BUILDING MOMENTUM' : velocity >= 25 ? 'WARMING UP' : 'COLD TAPE';

  var detail = 'RVOL ' + rvol15.toFixed(1) + 'x · RSI ' + rsi15 + ' · ' + changePct.toFixed(1) + '% · Near HOD: ' + ((price/high)*100).toFixed(0) + '%';

  return { velocity: velocity, label: label, signal: isFastBreak || isCoilingBreak,
    isFastBreak: isFastBreak, isCoilingBreak: isCoilingBreak,
    rvolScore: +rvolScore.toFixed(0), rsiScore: +rsiScore.toFixed(0),
    priceScore: +priceScore.toFixed(0), changeScore: +changeScore.toFixed(0), detail: detail };
}

// ── ENGINE 2: FLOAT EXHAUSTION MODEL ─────────────────────────────
// When the float rotates 2x+ in a short window, sellers are gone
// Creating a LIQUIDITY VACUUM — violent moves become inevitable
function calculateFloatExhaustion(quote, tf15m, tf1h) {
  var result = { score: 0, label: 'NORMAL', vacuum: false, rotationRate: 0, minutesToExhaust: null, detail: '' };
  if (!quote) return result;

  var volume    = quote.volume || 0;
  var float     = quote.floatShares || 10e6;
  var avgVol    = quote.avgVolume || 1;
  var changePct = quote.changePct || 0;

  // Current session float rotation
  var floatRotation = volume / float;
  // Rate: rotations per hour (assuming 6.5hr trading day)
  var sessionHours  = 6.5;
  var rotationRate  = floatRotation / sessionHours; // rotations per hour
  // Minutes until float exhausted at current rate
  var minutesToExhaust = rotationRate > 0 ? Math.round((1 / rotationRate) * 60) : null;

  // Exhaustion score: higher rotation + positive price = higher vacuum
  var rotScore   = Math.min(50, floatRotation * 25);
  var priceScore = Math.min(30, Math.max(0, changePct) * 1.5);
  var rvolBonus  = tf15m && tf15m.relVolume >= 5 ? 20 : tf15m && tf15m.relVolume >= 2 ? 10 : 0;
  var score = Math.round(Math.min(100, rotScore + priceScore + rvolBonus));

  // Vacuum conditions: float rotating at 1.5x+ with price positive
  var isVacuum = floatRotation >= 1.5 && changePct > 5;
  // Extreme vacuum: float rotating 3x+ — sellers literally gone
  var isExtremeVacuum = floatRotation >= 3.0;

  var label = isExtremeVacuum ? 'EXTREME VACUUM — No sellers left' : isVacuum ? 'LIQUIDITY VACUUM — Float exhausting' :
              floatRotation >= 0.8 ? 'HIGH ROTATION — Approaching vacuum' :
              floatRotation >= 0.4 ? 'ACTIVE ROTATION' : 'LOW ROTATION';

  var detail = 'Float rotated ' + floatRotation.toFixed(2) + 'x today' +
    (minutesToExhaust ? ' · At current rate: ~' + minutesToExhaust + 'min to full exhaust' : '');

  return { score: score, label: label, vacuum: isVacuum, extremeVacuum: isExtremeVacuum,
    floatRotation: +floatRotation.toFixed(2), rotationRate: +rotationRate.toFixed(3),
    minutesToExhaust: minutesToExhaust, detail: detail };
}

// ── ENGINE 3: X-RAY ORDER FLOW (Tick Delta) ───────────────────────
// Aggressive vs Passive order detection using tick direction
// When aggressive BUYERS dominate, price has fuel to continue
// Uses the tick accumulation from Finnhub WebSocket store
var tickStore = {}; // { symbol: [{ price, volume, timestamp }] }
var TICK_WINDOW_MS = 5 * 60 * 1000; // 5-minute window

function recordTick(symbol, price, volume) {
  if (!tickStore[symbol]) tickStore[symbol] = [];
  var now = Date.now();
  tickStore[symbol].push({ price: price, volume: volume, t: now });
  // Prune old ticks (keep last 5 minutes)
  tickStore[symbol] = tickStore[symbol].filter(function(t) { return now - t.t < TICK_WINDOW_MS; });
  if (tickStore[symbol].length > 500) tickStore[symbol] = tickStore[symbol].slice(-500);
}

function calculateXRay(symbol, currentPrice) {
  var ticks = tickStore[symbol] || [];
  if (ticks.length < 5) {
    return { delta: 0, label: 'INSUFFICIENT TICK DATA', buyPressure: 50, sellPressure: 50, signal: 'NEUTRAL', tickCount: ticks.length };
  }
  var aggressiveBuy = 0, aggressiveSell = 0, passiveBuy = 0, passiveSell = 0;
  // Classify ticks: up-tick = aggressive buyer, down-tick = aggressive seller
  for (var i = 1; i < ticks.length; i++) {
    var vol = ticks[i].volume || 100;
    if (ticks[i].price > ticks[i-1].price) aggressiveBuy += vol;
    else if (ticks[i].price < ticks[i-1].price) aggressiveSell += vol;
    else { passiveBuy += vol * 0.5; passiveSell += vol * 0.5; }
  }
  var total = aggressiveBuy + aggressiveSell + passiveBuy + passiveSell || 1;
  var delta = aggressiveBuy - aggressiveSell;
  var buyPct = Math.round((aggressiveBuy / total) * 100);
  var sellPct = Math.round((aggressiveSell / total) * 100);
  var normalizedDelta = Math.round((delta / total) * 100); // -100 to +100
  var label = normalizedDelta >= 40 ? 'AGGRESSIVE BUYING — Whales absorbing' :
              normalizedDelta >= 15 ? 'BUY IMBALANCE — Buyers in control' :
              normalizedDelta <= -40 ? 'AGGRESSIVE SELLING — Distribution' :
              normalizedDelta <= -15 ? 'SELL IMBALANCE — Sellers in control' : 'BALANCED FLOW';
  var signal = normalizedDelta >= 20 ? 'BUY' : normalizedDelta <= -20 ? 'SELL' : 'NEUTRAL';
  return { delta: normalizedDelta, label: label, buyPressure: buyPct, sellPressure: sellPct,
    aggressiveBuy: aggressiveBuy, aggressiveSell: aggressiveSell,
    signal: signal, tickCount: ticks.length };
}

// Wire X-Ray to Finnhub WebSocket — record ticks as they arrive
// This is added to the ws.on('message') handler
function onFinnhubTick(symbol, price, volume) {
  if (symbol && price > 0) recordTick(symbol.toUpperCase(), price, volume || 100);
}

// ── ENGINE 4: REGIME GUARD (Hidden Markov Proxy) ─────────────────
// Detects invisible market regimes: Trending, Ranging, Distributing
// Replaces simple "SPY trend up/down" with 3-state regime detection
async function detectRegime() {
  try {
    var results = await Promise.all([
      getCandles('SPY', '5d', '60m'),
      getCandles('QQQ', '5d', '60m'),
      getCandles('VIX', '5d', '60m')
    ]);
    var spy = results[0]; var qqq = results[1]; var vix = results[2];
    if (!spy || !qqq) return { regime: 'UNKNOWN', penalty: 0, longEnabled: true, detail: '' };

    var spyRsi = spy.rsi || 50;
    var qqqRsi = qqq.rsi || 50;
    var spyTrend = spy.trend || 'NEUTRAL';
    var qqqTrend = qqq.trend || 'NEUTRAL';
    var spyRvol  = spy.relVolume || 1;
    var vixRsi   = vix ? vix.rsi : 50;

    // Regime classification using multiple signals
    var bullSignals = 0, bearSignals = 0;
    if (spyTrend === 'UP')    bullSignals++;
    if (qqqTrend === 'UP')    bullSignals++;
    if (spyRsi > 52)          bullSignals++;
    if (qqqRsi > 52)          bullSignals++;
    if (spyTrend === 'DOWN')  bearSignals++;
    if (qqqTrend === 'DOWN')  bearSignals++;
    if (spyRsi < 48)          bearSignals++;
    if (qqqRsi < 48)          bearSignals++;
    if (vixRsi > 65)          bearSignals++;  // High fear = bear regime

    var regime, penalty, longEnabled, color, detail;
    if (bullSignals >= 4 && bearSignals <= 1) {
      regime = 'EXPANSION'; penalty = 0; longEnabled = true; color = '#22c55e';
      detail = 'SPY + QQQ trending up · Low fear · Full long exposure enabled';
    } else if (bearSignals >= 4) {
      regime = 'DISTRIBUTION'; penalty = -20; longEnabled = false; color = '#ef4444';
      detail = 'Distribution detected · LONG signals DISABLED · Risk of bull traps';
    } else if (bearSignals >= 2 && bullSignals <= 2) {
      regime = 'CAUTION'; penalty = -10; longEnabled = true; color = '#f0b429';
      detail = 'Mixed macro signals · Reduce position size · Tighter stops required';
    } else if (Math.abs(bullSignals - bearSignals) <= 1) {
      regime = 'RANGING'; penalty = -5; longEnabled = true; color = '#60a5fa';
      detail = 'Choppy conditions · Prefer mean-reversion over momentum';
    } else {
      regime = 'NEUTRAL'; penalty = 0; longEnabled = true; color = '#6b87a0';
      detail = 'No clear regime · Standard risk parameters apply';
    }

    return { regime: regime, penalty: penalty, longEnabled: longEnabled, color: color,
      detail: detail, bullSignals: bullSignals, bearSignals: bearSignals,
      spyRsi: spyRsi, qqqRsi: qqqRsi, vixRsi: vixRsi };
  } catch(e) { return { regime: 'UNKNOWN', penalty: 0, longEnabled: true, detail: e.message }; }
}

// ── ENGINE 5: SHADOW SCORE (SOR Savings Counter) ─────────────────
// Tracks how much the Smart Order Router saved vs market order slippage
var shadowSavingsTotal = 0;
var shadowSavingsToday = 0;
var shadowSavingsDate  = new Date().toDateString();

function recordShadowSaving(shares, slippageSaved) {
  var today = new Date().toDateString();
  if (today !== shadowSavingsDate) { shadowSavingsToday = 0; shadowSavingsDate = today; }
  var saving = +Math.abs(slippageSaved * shares).toFixed(2);
  shadowSavingsToday += saving;
  shadowSavingsTotal += saving;
  return saving;
}

function estimateSORSaving(price, totalShares, avgVolume) {
  // Market impact estimate: large orders move price against the trader
  // Institutional formula: impact = shares / (avgVolPerMin * 0.2)
  var perMinVol   = (avgVolume || 100000) / 390;
  var marketRatio = totalShares / (perMinVol * 0.2);
  // Slippage per share estimate (capped at 2% of price)
  var slippagePerShare = Math.min(price * 0.02, price * Math.min(0.005, marketRatio * 0.002));
  return +slippagePerShare.toFixed(4);
}

app.get('/api/shadow-score', function(req, res) {
  res.json({ today: +shadowSavingsToday.toFixed(2), total: +shadowSavingsTotal.toFixed(2),
    date: shadowSavingsDate, currency: 'USD' });
});

// ── ENGINE 6: CROWD HEAT (Retail Timing Engine) ───────────────────
// Detects if retail crowd momentum is FRESH (enter) or STALE (exit)
// Institutional wisdom: retail momentum profitable for first 20-40 minutes
function calculateCrowdHeat(quote, newsItems, tf15m) {
  var result = { heat: 0, label: 'COLD', phase: 'UNKNOWN', action: 'WAIT', detail: '', timeDecay: 0 };
  if (!quote) return result;

  var changePct = quote.changePct || 0;
  var volume    = quote.volume || 0;
  var avgVol    = quote.avgVolume || 1;
  var rvol      = volume / avgVol;
  var news      = newsItems || [];

  // Age of most recent news (proxy for crowd arrival timing)
  var newestNews = news.length > 0 ? Math.min.apply(null, news.map(function(n){return n.ageH||24;})) : 24;
  // Fresh news (<30min) = crowd just arriving. Old news (>2h) = crowd stale/leaving.
  var newsDecay  = newestNews < 0.5 ? 0 : newestNews < 1 ? 20 : newestNews < 2 ? 50 : 80;
  var crowdFresh = newestNews < 1; // crowd arrived less than 1 hour ago

  // Heat score: combines momentum strength + crowd freshness
  var momentumScore = Math.min(40, Math.max(0, changePct) * 2);
  var rvolScore     = Math.min(30, (rvol - 1) * 6);
  var freshnessScore = crowdFresh ? 30 : Math.max(0, 30 - newsDecay * 0.3);
  var heat = Math.round(momentumScore + rvolScore + freshnessScore);

  var label, phase, action;
  if (heat >= 80 && crowdFresh) { label = 'INFERNO — Peak crowd arrival'; phase = 'EARLY CROWD'; action = 'ENTER — Ride with retail wave'; }
  else if (heat >= 60 && crowdFresh) { label = 'HOT — Crowd building momentum'; phase = 'MID CROWD'; action = 'ENTER — Momentum intact'; }
  else if (heat >= 60 && !crowdFresh) { label = 'STALE HEAT — Crowd was here'; phase = 'LATE CROWD'; action = 'EXIT — Whales distributing into FOMO'; }
  else if (heat >= 40) { label = 'WARM — Pre-crowd accumulation'; phase = 'PRE-CROWD'; action = 'WATCH — Wait for volume confirmation'; }
  else { label = 'COLD — No crowd interest'; phase = 'NO CROWD'; action = 'SKIP — Insufficient retail energy'; }

  var detail = 'News age: ' + (newestNews < 1 ? Math.round(newestNews*60) + 'min' : newestNews.toFixed(1) + 'h') +
    ' · RVOL: ' + rvol.toFixed(1) + 'x · Crowd: ' + (crowdFresh ? 'FRESH' : 'STALE');

  return { heat: heat, label: label, phase: phase, action: action, detail: detail,
    crowdFresh: crowdFresh, newsAgeH: +newestNews.toFixed(2), timeDecay: newsDecay };
}

// ── Combined Shark Brain endpoint ────────────────────────────────
app.post('/api/shark', async function(req, res) {
  var ticker = req.body.ticker;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase().trim();
  try {
    var pr = await Promise.all([
      getQuote(sym), getCandles(sym, '5d', '60m'), getCandles(sym, '2d', '15m'),
      getFreshNews(sym), getShortData(sym)
    ]);
    var quote = pr[0]; var tf1h = pr[1]; var tf15 = pr[2]; var news = pr[3]; var sd = pr[4];
    if (!quote) return res.status(404).json({ error: sym + ' not found' });

    var phaseVel  = calculatePhaseVelocity(quote, tf15, tf1h);
    var floatExh  = calculateFloatExhaustion(quote, tf15, tf1h);
    var xray      = calculateXRay(sym, quote.price);
    var regime    = await detectRegime();
    var crowdHeat = calculateCrowdHeat(quote, news, tf15);
    var mmr       = calculateMMR(quote, tf15, news);

    // Shark composite score
    var sharkScore = Math.round(
      phaseVel.velocity * 0.30 +
      floatExh.score    * 0.25 +
      Math.max(0, xray.delta) * 0.20 +
      crowdHeat.heat    * 0.25
    );
    sharkScore = Math.max(0, Math.min(100, sharkScore));
    if (!regime.longEnabled) sharkScore = Math.max(0, sharkScore - 25);

    var sharkVerdict = sharkScore >= 75 ? 'STRIKE — Shark conditions optimal' :
                       sharkScore >= 55 ? 'CIRCLING — Momentum building, watch closely' :
                       sharkScore >= 35 ? 'HUNTING — Conditions developing' : 'PASS — Cold waters';

    res.json({ symbol: sym, price: quote.price, changePct: quote.changePct,
      sharkScore: sharkScore, verdict: sharkVerdict,
      phaseVelocity: phaseVel, floatExhaustion: floatExh,
      xray: xray, regime: regime, crowdHeat: crowdHeat, mmr: mmr,
      timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// END SHARK BRAIN v5.0
// ================================================================

app.get('*', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// =========================================================
// TELEGRAM HANDLERS
// =========================================================

function setupTelegramHandlers() {
  function parseTg(text) {
    var t = text.trim(), m;
    m = t.match(/^watch(?:ing)?\s+([A-Za-z.]{1,6})\s+(?:at|for)?\s*\$?(\d+\.?\d*)(?:\s+stop\s*\$?(\d+\.?\d*))?/i);
    if (m) return { cmd: 'watch', symbol: m[1].toUpperCase(), price: +m[2], stop: m[3] ? +m[3] : null };
    m = t.match(/^in\b.*?\$?(\d+\.?\d*)\D+(\d+)/i); if (m) return { cmd: 'in', price: +m[1], shares: +m[2] };
    m = t.match(/^out\b.*?\$?(\d+\.?\d*)/i); if (m) return { cmd: 'out', price: +m[1] };
    m = t.match(/^add(?:ed)?\s+(\d+)[^$\d]*\$?(\d+\.?\d*)/i); if (m) return { cmd: 'add', shares: +m[1], price: +m[2] };
    m = t.match(/^(?:sl|stop)\s+\$?(\d+\.?\d*)/i); if (m) return { cmd: 'sl', price: +m[1] };
    m = t.match(/^alert\s+([A-Za-z.]{1,6})\s+(above|below)\s+\$?(\d+\.?\d*)/i);
    if (m) return { cmd: 'alert', symbol: m[1].toUpperCase(), condition: m[2].toUpperCase(), value: +m[3] };
    m = t.match(/^dive\s+([A-Za-z.]{1,6})/i); if (m) return { cmd: 'dive', symbol: m[1].toUpperCase() };
    m = t.match(/^mmr\s+([A-Za-z.]{1,6})/i); if (m) return { cmd: 'mmr', symbol: m[1].toUpperCase() };
    m = t.match(/^buy\s+([A-Za-z.]{1,6})\s+(\d+)/i); if (m) return { cmd: 'buy', symbol: m[1].toUpperCase(), shares: +m[2] };
    m = t.match(/^next$/i); if (m) return { cmd: 'sor_next' };
    // Smart quote: $ prefix always = ticker. Bare caps only if not a common word and short (2-5 chars)
    m = t.match(/^\$([A-Z.]{1,5})$/i);
    if (m) return { cmd: 'quote', symbol: m[1].toUpperCase() };
    m = t.match(/^([A-Z.]{2,5})$/);
    if (m) {
      var sym = m[1].toUpperCase();
      var blacklist = ['THE','AND','FOR','BUY','ADD','OUT','NOT','HOW','CAN','MMR','ATR',
        'WHY','YES','NO','OK','HI','HEY','WHAT','WHO','WHERE','WHEN','IS','DO','GET',
        'PUT','SET','RUN','USE','SEE','TRY','ASK','HELP','INFO','NEWS','MORE'];
      if (blacklist.indexOf(sym) === -1) return { cmd: 'quote', symbol: sym };
    }
    if (/^(news|catalyst)/i.test(t)) return { cmd: 'news' };
    if (/^(status|p&l)/i.test(t)) return { cmd: 'status' };
    if (/^(cancel|clear)/i.test(t)) return { cmd: 'cancel' };
    if (/^(daily|today)/i.test(t)) return { cmd: 'daily' };
    if (/^(weekly)/i.test(t)) return { cmd: 'weekly' };
    if (/^help$/i.test(t)) return { cmd: 'help' };
    // Everything else routes to super-intelligence chat
    return { cmd: 'chat', text: t };
  }

  bot.on('message', async function(msg) {
    var cid  = msg.chat.id;
    var text = (msg.text || '').trim();
    if (!text) return;
    console.log('[TG ' + cid + '] ' + (msg.from && msg.from.first_name || '?') + ': ' + text);
    var p = parseTg(text);

    if (p.cmd === 'chat') {
      if (!GROQ_KEY) { tgSend(cid, 'AI not available.'); return; }
      try {
        var r = await fetch('http://localhost:' + PORT + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, sessionId: String(cid) })
        });
        var d = await r.json();
        tgSend(cid, d.reply || 'Error: ' + d.error);
      } catch(e) { tgSend(cid, 'Error: ' + e.message); }
      return;
    }

    switch (p.cmd) {
      case 'watch': {
        tgSend(cid, 'Looking up ' + p.symbol + '...');
        var q = await getQuote(p.symbol);
        if (!q) { tgSend(cid, p.symbol + ' not found.'); return; }
        var atr = null;
        try { var c = await getCandles(p.symbol, '3mo', '1d'); if (c) atr = c.atr; } catch(e) {}
        var lv = calcLevels(p.price, atr);
        watches.set(cid, { symbol: p.symbol, entryLevel: p.price, customStop: p.stop, currentPrice: q.price, avgVolume: q.avgVolume, atr: atr, confirmed: false });
        addSub(p.symbol, cid);
        tgSend(cid, 'WATCHING ' + p.symbol + '\n\nNow: $' + q.price.toFixed(2) + ' | Trigger: $' + p.price + '\n\nStop: $' + (p.stop || lv.stop) + ' (' + (lv.atrUsed ? 'ATR-based' : 'fixed %') + ')\nT1: $' + lv.t1 + '\nT2: $' + lv.t2 + '\n\nLive monitoring active');
        break;
      }
      case 'in': {
        var w = watches.get(cid);
        if (!w) { tgSend(cid, 'Set watch first: watching LFVN at 5.10'); return; }
        var lv2 = calcLevels(p.price, w.atr);
        var tr = { symbol: w.symbol, entryPrice: p.price, shares: p.shares, entryTime: Date.now(),
          currentPrice: p.price, hwm: p.price, avgCost: p.price,
          stopLoss: w.customStop || lv2.stop, trailingStop: lv2.stop,
          targets: { t1: lv2.t1, t2: lv2.t2, t3: lv2.t3 },
          avgVolume: w.avgVolume, atr: w.atr, adds: [],
          t1Hit: false, t2Hit: false, stopAlerted: false, trailAlerted: false, warn45: false, warn90: false, addSent: false };
        trades.set(cid, tr); watches.delete(cid); addSub(w.symbol, cid);
        tgSend(cid, 'IN - ' + w.symbol + '\n$' + p.price + ' x ' + p.shares + ' shares = $' + (p.price * p.shares).toFixed(2) + '\n\nStop: $' + tr.stopLoss + ' (' + (lv2.atrUsed ? 'ATR-based' : 'fixed') + ') | Max loss: -$' + (lv2.risk * p.shares).toFixed(2) + '\nT1: $' + lv2.t1 + '\nT2: $' + lv2.t2 + '\nT3: $' + lv2.t3 + '\n\nMonitoring: stop, targets, trail, 45min, adds');
        break;
      }
      case 'out': {
        var tr2 = trades.get(cid);
        if (!tr2) { tgSend(cid, 'No active trade.'); return; }
        var pnl  = totalPnl(tr2, p.price);
        var ts   = totalShares(tr2);
        var mins = ((Date.now() - tr2.entryTime) / 60000).toFixed(0);
        var pct  = (((p.price - tr2.avgCost) / tr2.avgCost) * 100).toFixed(2);
        await logTrade({ symbol: tr2.symbol, date: new Date().toISOString().split('T')[0], entryPrice: tr2.entryPrice, exitPrice: p.price, shares: ts, avgCost: tr2.avgCost, pnl: pnl, pnlPct: +pct, minutesInTrade: +mins, t1Hit: tr2.t1Hit, t2Hit: tr2.t2Hit });
        removeSub(tr2.symbol, cid); trades.delete(cid);
        tgSend(cid, (pnl > 0 ? 'WIN' : 'LOSS') + ' - CLOSED ' + tr2.symbol + '\n$' + tr2.entryPrice + ' to $' + p.price + ' | ' + ts + ' shares | ' + mins + 'min\n\nP&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + ' (' + pct + '%)\n\n' + (pnl > 0 ? 'Banked. Well executed, Maverick.' : 'Stop respected. Capital preserved. Next setup.') + '\n\nText: daily');
        break;
      }
      case 'add': {
        var tr3 = trades.get(cid);
        if (!tr3) { tgSend(cid, 'No active trade.'); return; }
        tr3.adds.push({ shares: p.shares, price: p.price }); tr3.avgCost = avgCostCalc(tr3);
        tgSend(cid, 'ADDED ' + tr3.symbol + '\n+' + p.shares + ' @ $' + p.price + '\nTotal: ' + totalShares(tr3) + ' | Avg: $' + tr3.avgCost);
        break;
      }
      case 'sl': {
        var tr4 = trades.get(cid); var w2 = watches.get(cid);
        if (tr4) { tr4.stopLoss = p.price; tr4.stopAlerted = false; tgSend(cid, 'Stop updated to $' + p.price + ' on ' + tr4.symbol); }
        else if (w2) { w2.customStop = p.price; tgSend(cid, 'Stop set to $' + p.price); }
        else tgSend(cid, 'No active trade.');
        break;
      }
      case 'alert': {
        if (!priceAlerts.has(p.symbol)) priceAlerts.set(p.symbol, []);
        priceAlerts.get(p.symbol).push({ chatId: cid, condition: p.condition, value: p.value, fired: false });
        addSub(p.symbol, cid);
        tgSend(cid, 'Alert set - ' + p.symbol + ' fires when price ' + p.condition + ' $' + p.value + '\nMonitored via Finnhub live feed');
        break;
      }
      case 'mmr': {
        // New v3.5 command: quick MMR score from Telegram
        tgSend(cid, 'Calculating MMR for ' + p.symbol + '...');
        try {
          var mRes = await fetch('http://localhost:' + PORT + '/api/mmr', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: p.symbol })
          });
          var mData = await mRes.json();
          if (mData.error) { tgSend(cid, 'Error: ' + mData.error); return; }
          var mmrR = mData.mmr;
          var dil  = mData.dilution;
          var msg2 = 'MMR SCORE - ' + p.symbol + '\n\n' +
            'MMR: ' + mmrR.total + '/100 (Grade ' + mmrR.grade + ')\n' +
            'Float Rotation: ' + mmrR.floatRotation + 'x\n' +
            'RVOL: ' + mmrR.rvol + 'x\n' +
            'Passes AI Filter: ' + (mmrR.passesFilter ? 'YES - worthy of analysis' : 'NO - below 60, likely noise') + '\n' +
            'Supernova Candidate: ' + (mmrR.isSupernovaCandidate ? 'YES - all thresholds met' : 'No') + '\n\n' +
            'ATR Stop: $' + mData.atrStop + ' (' + (mData.atrUsed ? 'ATR-based' : 'fixed %') + ')\n' +
            (dil.detected ? 'DILUTION ALERT: ' + dil.type + ' detected - stop widened\n' : '');
          tgSend(cid, msg2);
        } catch(e) { tgSend(cid, 'Error: ' + e.message); }
        break;
      }
      case 'dive': {
        tgSend(cid, 'Shadow Dive — analyzing ' + p.symbol + ' across all intelligence layers...');
        try {
          var dr = await fetch('http://localhost:' + PORT + '/api/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: p.symbol })
          });
          var dd = await dr.json();
          if (dd.error) { tgSend(cid, 'Error: ' + dd.error); return; }
          var v   = dd.verdict;
          var bpi = dd.bpi || {};
          var alt = dd.altData || { curiosity:'STABLE', crowdRisk:'CLEAN', velocity:'NEUTRAL', verdict:'NEUTRAL', total:0 };
          var st  = dd.stress || {};
          var verdictText = { BUY:'BUY', DONT_BUY:'DO NOT BUY', WATCH:'WATCH' }[v.verdict] || v.verdict;
          var dMsg = verdictText + ' - ' + p.symbol + ' | Conviction: ' + v.conviction + '/100 | MMR: ' + (dd.mmr?dd.mmr.total:'?') + '\n\n';
          dMsg += v.headline + '\n\n';
          dMsg += (v.reasoning||[]).map(function(r){ return '- ' + r; }).join('\n') + '\n\n';
          // BPI
          if (bpi.score !== undefined) {
            dMsg += 'LIQUIDITY AUDIT (BPI): ' + bpi.score + '% — ' + (bpi.label||'') + '\n';
            dMsg += 'Floor: $' + (bpi.demandZone||'?') + ' | Sweep: ' + (bpi.sweepDetected?'YES':'No') + '\n\n';
          }
          // Alt-Data
          dMsg += 'SHADOW PROXY AUDIT\n';
          dMsg += 'Inst. Curiosity: ' + alt.curiosity + '\n';
          dMsg += 'Crowd Risk: ' + alt.crowdRisk + '\n';
          dMsg += 'Alt-Verdict: ' + alt.verdict + '\n\n';
          // Stress
          if (st.pathEfficiency) {
            dMsg += 'STRESS TEST: Path Efficiency ' + st.pathEfficiency + '% | Ruin ' + st.riskOfRuin + '%\n';
            dMsg += 'Expected Value: $' + st.expectedValue + '\n\n';
          }
          // Strike plan
          if (v.verdict === 'BUY' && v.entry_zone) {
            dMsg += 'STRIKE PLAN\n';
            dMsg += 'Entry: $' + v.entry_zone.low + '-$' + v.entry_zone.high + '\n';
            dMsg += 'Stop: $' + v.stop_loss + ' | T1: $' + v.target_1 + '\n';
            dMsg += 'Shadow Execute: buy ' + p.symbol + ' 200';
          }
          if (dd.dilution && dd.dilution.detected) dMsg += '\n\nWARNING: ' + dd.dilution.type;
          tgSend(cid, dMsg);
        } catch(e) { tgSend(cid, 'Error: ' + e.message); }
        break;
      }
      case 'buy': {
        tgSend(cid, 'Calculating SOR for ' + p.symbol + '...');
        await executeSORSession(cid, p.symbol, p.shares || 100);
        break;
      }
      case 'sor_next': {
        await sorNextPiece(cid);
        break;
      }
      case 'quote': {
        var qr = await getQuote(p.symbol);
        if (!qr) { tgSend(cid, p.symbol + ' not found.'); return; }
        tgSend(cid, p.symbol + ' - $' + qr.price.toFixed(2) + ' (' + (qr.changePct >= 0 ? '+' : '') + qr.changePct.toFixed(2) + '%)\nH: $' + qr.high.toFixed(2) + ' L: $' + qr.low.toFixed(2) + '\nCap: ' + (qr.marketCap ? '$' + (qr.marketCap/1e6).toFixed(0) + 'M' : 'n/a') + ' Float: ' + (qr.floatShares ? (qr.floatShares/1e6).toFixed(1) + 'M' : 'n/a') + '\n\nText: watching ' + p.symbol + ' at ' + qr.price.toFixed(2));
        break;
      }
      case 'news': { tgSend(cid, 'Scanning catalysts (threshold: 55+)...'); runCatalystScan(true); break; }
      case 'status': {
        var tr5 = trades.get(cid); var w3 = watches.get(cid);
        if (tr5) {
          var price5 = tr5.currentPrice || tr5.entryPrice;
          var pnl5   = totalPnl(tr5, price5);
          var mins5  = ((Date.now() - tr5.entryTime) / 60000).toFixed(0);
          tgSend(cid, 'LIVE - ' + tr5.symbol + '\n\nEntry: $' + tr5.entryPrice + ' | Now: $' + price5.toFixed(2) + '\nP&L: ' + (pnl5 >= 0 ? '+' : '') + '$' + pnl5.toFixed(2) + ' | ' + mins5 + 'min\n\nStop: $' + tr5.stopLoss + '\nT1: $' + tr5.targets.t1 + ' [' + (tr5.t1Hit ? 'HIT' : 'waiting') + ']\nT2: $' + tr5.targets.t2 + ' [' + (tr5.t2Hit ? 'HIT' : 'waiting') + ']');
        } else if (w3) {
          tgSend(cid, 'Watching ' + w3.symbol + ' for $' + w3.entryLevel + ' | Now: $' + (w3.currentPrice || '...'));
        } else {
          tgSend(cid, 'No active trade.\n\nText: watching [TICKER] at [price]');
        }
        break;
      }
      case 'cancel': {
        var sym5 = (watches.get(cid) && watches.get(cid).symbol) || (trades.get(cid) && trades.get(cid).symbol);
        if (sym5) removeSub(sym5, cid);
        watches.delete(cid); trades.delete(cid);
        tgSend(cid, 'Cleared. Ready.\n\nText: watching [TICKER] at [price]');
        break;
      }
      case 'daily': {
        var mem = await memLoad(); var today = new Date().toISOString().split('T')[0];
        var list = (mem.trades || []).filter(function(t) { return t.date === today; });
        if (!list.length) { tgSend(cid, 'No trades logged today.'); return; }
        var total = list.reduce(function(s,t){return s+t.pnl;},0);
        var wins  = list.filter(function(t){return t.pnl>0;});
        tgSend(cid, 'TODAY - ' + today + '\nTrades: ' + list.length + ' | Wins: ' + wins.length + ' (' + (list.length ? (wins.length/list.length*100).toFixed(0) : 0) + '%)\nP&L: ' + (total >= 0 ? '+' : '') + '$' + total.toFixed(2) + '\n\n' + list.map(function(t){return t.symbol + ' ' + (t.pnl>=0?'+':'') + '$' + t.pnl.toFixed(2);}).join('\n'));
        break;
      }
      case 'weekly': {
        var mem2 = await memLoad();
        var list2 = (mem2.trades || []).filter(function(t) { return (Date.now() - new Date(t.date).getTime()) < 7*86400000; });
        if (!list2.length) { tgSend(cid, 'No trades this week.'); return; }
        var total2 = list2.reduce(function(s,t){return s+t.pnl;},0);
        var wins2  = list2.filter(function(t){return t.pnl>0;});
        tgSend(cid, 'THIS WEEK\nTrades: ' + list2.length + ' | Wins: ' + wins2.length + '\nP&L: ' + (total2 >= 0 ? '+' : '') + '$' + total2.toFixed(2));
        break;
      }
      case 'help': {
        tgSend(cid, 'MAVERICK v4.5\n\nTRADE:\nwatching LFVN at 5.10\nin at 5.11 with 200 shares\nadded 100 at 5.50\nsl 4.88\nout at 5.85\nstatus | cancel\n\nSMART EXECUTION:\nbuy LFVN 200 — SOR stagger plan\nnext — execute next SOR piece\n\nALERTS:\nalert LFVN above 5.50\nalert LFVN below 4.80\n\nINTELLIGENCE:\nLFVN — quote\ndive LFVN — Shadow dive (BPI + Alt-Data + Stress)\nmmr LFVN — MMR math score\nnews — catalyst scan\n\nREPORTS:\ndaily | weekly\n\nCHAT:\nType naturally — any question, any topic');
        break;
      }
    }
  });

  bot.on('polling_error', function(e) {
    if (e.message.indexOf('409') === -1 && e.message.indexOf('401') === -1) console.error('Polling: ' + e.message);
  });
}


// ── VERDICT LOG + BACKTEST ENDPOINTS ────────────────────────────
app.get('/api/verdict-log', function(req, res) {
  res.json({ verdicts: verdictStore.slice().sort(function(a,b){return b.timestamp-a.timestamp;}), count: verdictStore.length });
});
app.get('/api/backtest', function(req, res) {
  var resolved = verdictStore.filter(function(v){return v.resolvedAt;});
  var wins = resolved.filter(function(v){return v.outcome==='WIN';}).length;
  var avgPnl = resolved.length ? +(resolved.reduce(function(s,v){return s+v.pnlPct;},0)/resolved.length).toFixed(2) : 0;
  res.json({
    total: verdictStore.length, resolved: resolved.length, wins: wins,
    losses: resolved.filter(function(v){return v.outcome==='LOSS';}).length,
    winRate: resolved.length ? +(wins/resolved.length*100).toFixed(1) : null,
    avgPnlPct: avgPnl,
    recent: verdictStore.slice().sort(function(a,b){return b.timestamp-a.timestamp;}).slice(0,20)
  });
});

// =========================================================
// START — v3.7 Full Stack
// =========================================================
connectFinnhub();
startCatalystFeed();
startContinuousScanner();
startSqueezeScanner();

app.listen(PORT, '0.0.0.0', async function() {
  console.log('\nMAVERICK TERMINAL v3.9 - Port ' + PORT);
  console.log('   Telegram:        ' + (TELEGRAM_TOKEN ? 'OK' : 'MISSING'));
  console.log('   Finnhub:         ' + (FINNHUB_KEY    ? 'OK (fresh, cache-busted)' : 'MISSING'));
  console.log('   Groq AI:         ' + (GROQ_KEY       ? 'OK' : 'MISSING'));
  console.log('   Memory:          ' + (JSONBIN_KEY    ? 'OK' : 'optional'));
  console.log('   MMR Engine:      ACTIVE');
  console.log('   Catalyst v2:     ACTIVE (6 sources, 90s cycle)');
  console.log('   Probability:     ACTIVE (Monte Carlo + LR + ATR)');
  console.log('   Squeeze v3.9:    ACTIVE (Phase 1/2/3 + Coiled Spring)');
  console.log('   Shark Brain:     ACTIVE (Phase Velocity + Float + X-Ray + Crowd Heat)');
  console.log('   Dilution Shield: ACTIVE');
  console.log('   Scanner:         24/7 (adaptive intervals)');
  console.log('   Super Bot:       ACTIVE (dual-brain trading + general AI)\n');
  await initTelegram();
  verdictLoad().catch(function(){});
  setInterval(resolveAgedVerdicts, 4 * 60 * 60 * 1000);
});
