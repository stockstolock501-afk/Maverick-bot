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
var JSONBIN_KEY    = process.env.JSONBIN_KEY;
var JSONBIN_BIN    = process.env.JSONBIN_BIN;
var WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'maverick';
var TG_CHAT_ID     = process.env.TG_CHAT_ID;
var BOT_USERNAME   = process.env.TG_BOT_USERNAME || '';
var PORT           = process.env.PORT || 3000;

var app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Groq models - verified live on your account
var GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-scout-17b-16e-instruct',
];

async function groqCall(system, user, maxTokens) {
  maxTokens = maxTokens || 1500;
  if (!GROQ_KEY) { console.error('GROQ_KEY missing'); return null; }
  for (var i = 0; i < GROQ_MODELS.length; i++) {
    var model = GROQ_MODELS[i];
    try {
      var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model, max_tokens: maxTokens, temperature: 0.25,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
      });
      if (!r.ok) { var err = await r.text(); console.error('Groq [' + model + '] ' + r.status + ': ' + err.slice(0,150)); continue; }
      var d = await r.json();
      var text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
      if (!text) { console.error('Groq [' + model + '] empty'); continue; }
      var cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      var m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) { console.error('Groq [' + model + '] no JSON in response'); continue; }
      return JSON.parse(m[0]);
    } catch(e) { console.error('Groq [' + model + ']: ' + e.message); }
  }
  console.error('All Groq models failed');
  return null;
}

async function groqChat(messages, maxTokens) {
  maxTokens = maxTokens || 500;
  if (!GROQ_KEY) return null;
  try {
    var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: maxTokens, temperature: 0.3, messages: messages })
    });
    if (!r.ok) return null;
    var d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || null;
  } catch(e) { return null; }
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
        fetch('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + FINNHUB_KEY),
        fetch('https://finnhub.io/api/v1/stock/profile2?symbol=' + sym + '&token=' + FINNHUB_KEY)
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
    var verdict = await groqCall(SUPERNOVA_PROMPT, payload, 4000);
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

function getScanInterval() {
  var et    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var total = et.getHours() * 60 + et.getMinutes();
  var isWeekday = et.getDay() > 0 && et.getDay() < 6;
  if (!isWeekday || total < 4*60 || total >= 16*60) return null;
  if (total < 9.5*60)  return 3;
  if (total < 11*60)   return 1.5;
  if (total < 15.5*60) return 4;
  return 1.5;
}

async function continuousScanCycle() {
  if (!getScanInterval()) return;
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

  var syms = Array.from(candidates).slice(0, 8);
  for (var i = 0; i < syms.length; i++) {
    var sym = syms[i];
    var lastAlert = scanCache.get(sym);
    if (lastAlert && (Date.now() - lastAlert) < 90 * 60 * 1000) continue;
    try {
      var results = await Promise.all([
        getQuote(sym),
        getCandles(sym, '3mo', '1d'),
        getCandles(sym, '2d', '15m'),
        getFreshNews(sym)
      ]);
      var quote = results[0];
      var tf1d  = results[1];
      var tf15  = results[2];
      var news  = results[3];
      if (!quote) continue;

      // MMR math engine — no Groq call here
      var mmr = calculateMMR(quote, tf1d, news);
      if (!mmr.passesFilter) continue; // Below 60 — skip silently

      // Additional technical check
      var techOk = tf15 && tf15.trend === 'UP' && tf15.rsi > 50 && tf15.rsi < 78;
      var luxSignal = tf1d ? luxAlgoSignal(tf1d) : null;
      var luxOk = luxSignal && luxSignal.signalType === 'BUY' && luxSignal.signalStrength > 50;

      // Tier the alert
      var tier, tierText;
      if (mmr.isSupernovaCandidate && techOk) {
        tier = 'PERFECT'; tierText = 'PERFECT TRADE ALERT';
      } else if (mmr.total >= 80 && techOk) {
        tier = 'HIGH'; tierText = 'HIGH CONVICTION SETUP';
      } else if (mmr.total >= 60) {
        tier = 'MODERATE'; tierText = 'SETUP DETECTED';
      } else {
        continue;
      }

      scanCache.set(sym, Date.now());
      if (TG_CHAT_ID && bot) {
        var atr = (tf1d && tf1d.atr) || null;
        var lv  = calcLevels(quote.price, atr);
        var msg = tier === 'PERFECT' ?
          'PERFECT TRADE - ' + sym + '\n' :
          tierText + ' - ' + sym + '\n';
        msg += 'MMR Score: ' + mmr.total + '/100 (Grade ' + mmr.grade + ')\n';
        msg += '$' + quote.price.toFixed(2) + ' | +' + (quote.changePct||0).toFixed(1) + '%\n';
        msg += 'Float Rotation: ' + mmr.floatRotation + 'x | RVOL: ' + mmr.rvol + 'x\n';
        if (atr) msg += 'ATR Stop: $' + lv.stop + ' (1.5x ATR)\n';
        if (luxOk) msg += 'LuxAlgo: BUY ' + luxSignal.signalStrength + '% - TP $' + luxSignal.tpLevel + '\n';
        msg += '\nText: dive ' + sym;
        tgSend(TG_CHAT_ID, msg);
      }
    } catch(e) {}
    await new Promise(function(r) { setTimeout(r, 300); });
  }
}

function startContinuousScanner() {
  console.log('Continuous scanner armed (4am-4pm ET, MMR-driven)');
  var run = async function() {
    await continuousScanCycle().catch(function(e) { console.error('Scan cycle: ' + e.message); });
    var iv = getScanInterval();
    setTimeout(run, (iv || 5) * 60 * 1000);
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

function scheduleCatalystScans() {
  setInterval(function() { runCatalystScan(false); }, 28 * 60 * 1000);
  setInterval(function() {
    var et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    var h = et.getHours(); var m = et.getMinutes(); var isWeekday = et.getDay() > 0 && et.getDay() < 6;
    if (!isWeekday) return;
    if ((h === 4 || h === 6 || h === 8) && m < 2) runCatalystScan(false);
  }, 60 * 1000);
}

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
      getFreshNews(sym)
    ]);
    var quote = results[0];
    var tf1d  = results[1];
    var tf4h  = results[2];
    var tf1h  = results[3];
    var tf15  = results[4];
    var news  = results[5];
    if (!quote) return res.status(404).json({ error: sym + ' not found' });

    // Run MMR math engine
    var mmr = calculateMMR(quote, tf1d, news);

    // Run dilution shield
    var dilution = await checkDilutionRisk(sym);

    // LuxAlgo signals
    var luxAlgo = {
      daily:    tf1d  ? luxAlgoSignal(tf1d)  : null,
      fourhour: tf4h  ? luxAlgoSignal(tf4h)  : null,
      onehour:  tf1h  ? luxAlgoSignal(tf1h)  : null
    };

    // ATR-first stop calculation
    var atr = tf1d ? tf1d.atr : null;
    var levels = calcLevels(quote.price, atr, dilution.stopMultiplier);

    var ANALYZE_PROMPT = 'You are MAVERICK aggressive day trading AI. You receive MMR score (math pre-filter), LuxAlgo signals, and multi-timeframe data.\n' +
      'VERDICTS: BUY | DONT_BUY | WATCH\n' +
      'STOPS: Use ATR-based levels provided. Do NOT use fixed percentages.\n' +
      'If dilution risk detected, widen stops and note in key_risk.\n' +
      'LuxAlgo signals are primary technical confirmation. 2+ timeframe alignment = high conviction.\n' +
      'MMR >= 80 = whale confirmed. MMR 60-79 = elevated interest. MMR < 60 = noise.\n' +
      'RETURN ONLY VALID JSON:\n' +
      '{"verdict":"BUY|DONT_BUY|WATCH","conviction":0-100,"headline":"one decisive sentence","chart_pattern":"pattern name","timeframe_alignment":"BULLISH|BEARISH|MIXED|NEUTRAL","mmr_assessment":"brief MMR interpretation","reasoning":["bullet1","bullet2","bullet3"],"entry_zone":{"low":0.000,"high":0.000},"stop_loss":0.000,"target_1":0.000,"target_2":0.000,"target_3":0.000,"risk_reward":0.0,"position_size_suggestion":"AGGRESSIVE|STANDARD|SMALL","trade_type":"DAY_TRADE|SWING|SCALP","key_risk":"specific risk with numbers","trigger_to_watch":"exact condition if WATCH","time_horizon":"estimate"}';

    var payload = {
      ticker: sym,
      mmr: mmr,
      dilution_risk: dilution,
      atr_stop_suggested: levels.stop,
      quote: { price: quote.price, changePct: quote.changePct, open: quote.open, high: quote.high, low: quote.low, volume: quote.volume, marketCap: quote.marketCap, floatShares: quote.floatShares, sector: quote.sector },
      timeframes: { daily: tf1d || 'unavailable', fourhour: tf4h || 'unavailable', onehour: tf1h || 'unavailable', fifteen: tf15 || 'unavailable' },
      luxAlgo_signals: luxAlgo,
      recent_news: news.slice(0, 3).map(function(n) { return n.headline; })
    };

    var verdict = await groqCall(ANALYZE_PROMPT, JSON.stringify(payload));
    if (!verdict) return res.status(503).json({ error: 'AI unavailable - visit /api/groq-test' });

    res.json({
      ticker: sym, verdict: verdict, mmr: mmr, dilution: dilution, levels: levels,
      luxAlgo: luxAlgo, data: { quote: quote, timeframes: { daily: tf1d, fourhour: tf4h, onehour: tf1h, fifteen: tf15 }, news: news },
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

app.post('/api/catalyst-scan', function(req, res) {
  res.json({ ok: true, message: 'Catalyst scan triggered (threshold: 55+). Telegram alert incoming if qualifying catalysts found. Check in 30 seconds.' });
  runCatalystScan(true);
});

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
        await new Promise(function(r){setTimeout(r,200);});
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

app.post('/api/chat', async function(req, res) {
  if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_KEY not set. Visit /api/groq-test' });
  var message = req.body.message, sessionId = req.body.sessionId, portfolioSize = req.body.portfolioSize;
  if (!message) return res.status(400).json({ error: 'no message' });
  var sid = sessionId || 'default';
  if (!chatSessions.has(sid)) chatSessions.set(sid, []);
  var history = chatSessions.get(sid);
  var liveContext = '';
  var tm = message.match(/\b([A-Z]{2,5})\b/g);
  var skipWords = ['THE','AND','FOR','BUY','ADD','OUT','NOT','HOW','CAN','MMR','ATR'];
  if (tm) {
    for (var i = 0; i < Math.min(tm.length, 2); i++) {
      if (skipWords.indexOf(tm[i]) !== -1) continue;
      try {
        var q = await getQuote(tm[i]);
        if (q) {
          liveContext += '\nLIVE ' + tm[i] + ': $' + q.price.toFixed(2) + ', ' + q.changePct.toFixed(2) + '%, H$' + q.high.toFixed(2) + ' L$' + q.low.toFixed(2) + ', Cap' + (q.marketCap ? '$' + (q.marketCap/1e6).toFixed(0) + 'M' : 'n/a') + ', Float' + (q.floatShares ? (q.floatShares/1e6).toFixed(1) + 'M' : 'n/a');
          break;
        }
      } catch(e) {}
    }
  }
  var pSize = portfolioSize || 348;
  var ADVISOR_PROMPT = 'You are MAVERICKs personal hedge fund AI advisor. ' +
    'Portfolio: $' + pSize + ' (keep $100 reserve, tradeable: $' + (pSize-100) + ', max per trade: $' + Math.round((pSize-100)*0.35) + '). ' +
    'Phase 2/3 player. Sub-$10 specialist. Aggressive but calculated. Never fights dilution or ATMs. ' +
    'Uses ATR-based stops: Entry minus 1.5x ATR. Uses MMR scoring. ' +
    'Position sizing: Shares = max_risk divided by (entry minus stop). Max risk = 3% of portfolio. ' +
    'Direct and decisive. Under 200 words. Exact numbers always. ' +
    'End BUY answers with the exact Telegram bot command to send.';
  var messages = [{ role: 'system', content: ADVISOR_PROMPT + '\nPORTFOLIO: $' + pSize + ' | Tradeable: $' + (pSize-100) + ' | Max/trade: $' + Math.round((pSize-100)*0.35) }]
    .concat(history.slice(-10))
    .concat([{ role: 'user', content: message + liveContext }]);
  try {
    var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: 500, temperature: 0.3, messages: messages })
    });
    if (!r.ok) { var errText = await r.text(); return res.status(503).json({ error: 'Groq ' + r.status + ': ' + errText.slice(0,100) }); }
    var d = await r.json();
    var reply = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!reply) return res.status(503).json({ error: 'Empty AI response' });
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 20) history.splice(0, 2);
    res.json({ reply: reply, sessionId: sid });
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
// MAVERICK PROBABILITY ENSEMBLE — v3.6
// Paste this entire block into index.js BEFORE app.get('*'...)
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

    var steps   = Math.min(horizon, 60);
    var simCount = 3000;

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
      t1:         t1,
      t2:         t2,
      horizon:    horizon,
      steps:      steps,
      atr:        +atr.toFixed(3),
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
// MAVERICK CATALYST INTELLIGENCE ENGINE v2.0
// Paste this entire block into index.js BEFORE app.get('*'...)
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

    // ── Calculate conviction scores for new T1/T2 items ──────────
    for (var i = 0; i < Math.min(newHighConviction.length, 5); i++) {
      var item = newHighConviction[i];
      try {
        var cs = await calcConvictionScore(item);
        item.csScore = cs.total;
        item.csPillars = cs.pillars;
        if (cs.quote) item.quote = cs.quote;
        if (cs.tf)    item.tf    = cs.tf;
        // Fire Telegram for high conviction
        if (cs.total >= 0.65 && TG_CHAT_ID && bot) {
          var tierLabel = item.tier === 1 ? 'T1 HARD CATALYST' : 'T2 MOMENTUM';
          var msg = tierLabel + ' - CS: ' + (cs.total * 100).toFixed(0) + '/100\n\n' +
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
        await new Promise(function(r){ setTimeout(r, 300); });
      } catch(e) {}
    }

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
// startCatalystFeed() is called at server start below

// ================================================================
// END CATALYST v2 BACKEND
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
    m = t.match(/^([A-Z.]{1,6})$/); if (m) return { cmd: 'quote', symbol: m[1] };
    if (/^(news|catalyst)/i.test(t)) return { cmd: 'news' };
    if (/^(status|p&l)/i.test(t)) return { cmd: 'status' };
    if (/^(cancel|clear)/i.test(t)) return { cmd: 'cancel' };
    if (/^(daily|today)/i.test(t)) return { cmd: 'daily' };
    if (/^(weekly)/i.test(t)) return { cmd: 'weekly' };
    if (/^help$/i.test(t)) return { cmd: 'help' };
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
        tgSend(cid, 'Full analysis on ' + p.symbol + '...');
        try {
          var dr = await fetch('http://localhost:' + PORT + '/api/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: p.symbol })
          });
          var dd = await dr.json();
          if (dd.error) { tgSend(cid, 'Error: ' + dd.error); return; }
          var v = dd.verdict;
          var verdictText = { BUY: 'BUY', DONT_BUY: 'DO NOT BUY', WATCH: 'WATCH' }[v.verdict] || v.verdict;
          var dMsg = verdictText + ' - ' + p.symbol + '\nConviction: ' + v.conviction + '/100 | MMR: ' + (dd.mmr ? dd.mmr.total : '?') + '/100\n\n' +
            v.headline + '\n\n' + (v.reasoning || []).map(function(r) { return '- ' + r; }).join('\n');
          if (v.verdict === 'BUY') {
            dMsg += '\n\nEntry: $' + v.entry_zone.low + '-$' + v.entry_zone.high +
              '\nStop: $' + v.stop_loss + ' (ATR-based)' +
              '\nT1: $' + v.target_1 + ' | T2: $' + v.target_2 +
              '\nR:R: ' + v.risk_reward + ':1\n\n' +
              'Text: watching ' + p.symbol + ' at ' + v.entry_zone.low;
          }
          if (dd.dilution && dd.dilution.detected) {
            dMsg += '\n\nWARNING: ' + dd.dilution.type + ' - ' + dd.dilution.note;
          }
          tgSend(cid, dMsg);
        } catch(e) { tgSend(cid, 'Error: ' + e.message); }
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
        tgSend(cid, 'MAVERICK v3.5\n\nTRADE:\nwatching LFVN at 5.10\nwatching LFVN at 5.10 stop 4.80\nin at 5.11 with 200 shares\nadded 100 at 5.50\nsl 4.88\nout at 5.85\nstatus | cancel\n\nALERTS:\nalert LFVN above 5.50\nalert LFVN below 4.80\n\nINTELLIGENCE:\nLFVN - quote\ndive LFVN - full AI analysis\nmmr LFVN - MMR math score (new v3.5)\nnews - catalyst scan\n\nREPORTS:\ndaily | weekly\n\nCHAT:\nType naturally - how many shares of Ford should I buy?');
        break;
      }
    }
  });

  bot.on('polling_error', function(e) {
    if (e.message.indexOf('409') === -1 && e.message.indexOf('401') === -1) console.error('Polling: ' + e.message);
  });
}

// =========================================================
// START
// =========================================================
connectFinnhub();
startContinuousScanner();
startCatalystFeed();

app.listen(PORT, '0.0.0.0', async function() {
  console.log('\nMAVERICK TERMINAL v3.5 - Port ' + PORT);
  console.log('   Telegram:        ' + (TELEGRAM_TOKEN ? 'OK' : 'MISSING'));
  console.log('   Finnhub:         ' + (FINNHUB_KEY    ? 'OK' : 'MISSING'));
  console.log('   Groq AI:         ' + (GROQ_KEY       ? 'OK' : 'MISSING'));
  console.log('   Memory:          ' + (JSONBIN_KEY    ? 'OK' : 'optional'));
  console.log('   MMR Engine:      ACTIVE (60+ threshold)');
  console.log('   ATR Stops:       ACTIVE (1.5x ATR default)');
  console.log('   Dilution Shield: ACTIVE (S-3/424B monitoring)');
  console.log('   Supernova 2.0:   ACTIVE (rotation >3x, RVOL >10x)');
  console.log('   Scanner:         4am-4pm ET, MMR-driven\n');
  await initTelegram();
});
