require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const fetch       = require('node-fetch');
const path        = require('path');

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

// Groq models - verified working on your account
const GROQ_MODELS = [
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
        body: JSON.stringify({ model: model, max_tokens: maxTokens, temperature: 0.25, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
      });
      if (!r.ok) { var err = await r.text(); console.error('Groq [' + model + '] ' + r.status + ': ' + err.slice(0,150)); continue; }
      var d = await r.json();
      var text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
      if (!text) { console.error('Groq [' + model + '] empty'); continue; }
      var cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      var m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) { console.error('Groq [' + model + '] no JSON'); continue; }
      return JSON.parse(m[0]);
    } catch(e) { console.error('Groq [' + model + ']: ' + e.message); }
  }
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
  } catch(e) { console.error('groqChat: ' + e.message); return null; }
}

// Telegram
var bot = null;
async function initTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/deleteWebhook?drop_pending_updates=true');
    await new Promise(function(r) { setTimeout(r, 1000); });
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { interval: 2000, params: { timeout: 10, allowed_updates: ['message'] } } });
    console.log('Telegram started');
    setupTelegramHandlers();
  } catch(e) { console.error('TG init: ' + e.message); }
}
function tgSend(chatId, text) {
  if (!bot || !chatId) return;
  bot.sendMessage(String(chatId), text, { parse_mode: 'Markdown' }).catch(function(e) { console.error('TG: ' + e.message); });
}

// State
var watches      = new Map();
var trades       = new Map();
var priceAlerts  = new Map();
var subscribers  = new Map();
var volTracker   = new Map();
var tvSignals    = new Map();
var chatSessions = new Map();
var scanCache    = new Map();
var scannedHeadlines = new Set();
var lastCatalystScan = 0;
var scanCycleCount = 0;

// Finnhub WS
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
      if (m.type === 'trade' && Array.isArray(m.data)) m.data.forEach(function(t) { onTick(t.s, t.p, t.v); });
    } catch(e) {}
  });
  ws.on('close', function() { setTimeout(connectFinnhub, 5000); });
  ws.on('error', function(e) { if (e.message.indexOf('429') === -1) console.error('WS: ' + e.message); });
}
function wsSend(s, a) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: a, symbol: s })); }
function addSub(s, id) { if (!subscribers.has(s)) subscribers.set(s, new Set()); if (!subscribers.get(s).size) wsSend(s, 'subscribe'); subscribers.get(s).add(id); }
function removeSub(s, id) { var x = subscribers.get(s); if (!x) return; x.delete(id); if (!x.size) { subscribers.delete(s); wsSend(s, 'unsubscribe'); } }

// Data
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
        return { price: q.c, change: ch, changePct: q.pc ? (ch/q.pc)*100 : 0, open: q.o, high: q.h, low: q.l, prevClose: q.pc, marketCap: p && p.marketCapitalization ? p.marketCapitalization * 1e6 : null, floatShares: p && p.shareOutstanding ? p.shareOutstanding * 1e6 : null, sector: (p && p.finnhubIndustry) || null, shortName: (p && p.name) || sym, source: 'finnhub' };
      }
    } catch(e) { console.error('Finnhub quote: ' + e.message); }
  }
  try {
    var r = await fetch('https://query2.finance.yahoo.com/v7/finance/quote?symbols=' + sym, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/', 'Cache-Control': 'no-cache' } });
    var d = await r.json();
    var q2 = d && d.quoteResponse && d.quoteResponse.result && d.quoteResponse.result[0];
    if (q2 && q2.regularMarketPrice) return { price: q2.regularMarketPrice, change: q2.regularMarketChange, changePct: q2.regularMarketChangePercent, open: q2.regularMarketOpen, high: q2.regularMarketDayHigh, low: q2.regularMarketDayLow, prevClose: q2.regularMarketPreviousClose, volume: q2.regularMarketVolume, avgVolume: q2.averageDailyVolume3Month, marketCap: q2.marketCap, floatShares: q2.floatShares, yearHigh: q2.fiftyTwoWeekHigh, yearLow: q2.fiftyTwoWeekLow, sector: q2.sector, shortName: q2.shortName, preMarket: q2.preMarketPrice, preMarketChangePct: q2.preMarketChangePercent, source: 'yahoo' };
  } catch(e) { console.error('Yahoo: ' + e.message); }
  return null;
}

async function getCandles(symbol, range, interval) {
  try {
    var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=' + range + '&interval=' + interval + '&_=' + Date.now();
    var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/', 'Cache-Control': 'no-cache' } });
    var d = await r.json();
    var res = d && d.chart && d.chart.result && d.chart.result[0];
    if (!res) return null;
    var q = res.indicators && res.indicators.quote && res.indicators.quote[0];
    var ts = res.timestamp || [];
    if (!q || !ts.length) return null;
    var candles = ts.map(function(t, i) { return { t: t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }; }).filter(function(c) { return c.c != null; });
    if (!candles.length) return null;
    var closes = candles.map(function(c) { return c.c; });
    var last = closes[closes.length - 1];
    var first = closes[0];
    var high = Math.max.apply(null, candles.map(function(c) { return c.h; }));
    var low  = Math.min.apply(null, candles.map(function(c) { return c.l; }));
    var avgVol = candles.reduce(function(s,c) { return s + (c.v||0); }, 0) / candles.length;
    var lastVol = candles[candles.length-1].v || 0;
    var ema9 = closes.reduce(function(e,c,i) { return i===0 ? c : c*(2/10) + e*(8/10); }, closes[0]);
    var gains = [], losses = [];
    for (var i = 1; i < Math.min(closes.length, 15); i++) {
      var df = closes[i] - closes[i-1];
      if (df > 0) gains.push(df); else losses.push(Math.abs(df));
    }
    var ag = gains.reduce(function(s,v){return s+v;},0) / (gains.length||1);
    var al = losses.reduce(function(s,v){return s+v;},0) / (losses.length||1);
    var rsi = al === 0 ? 100 : 100 - (100 / (1 + ag/al));
    var atrSlice = candles.slice(-14);
    var atr = atrSlice.reduce(function(s,c){return s+(c.h-c.l);},0) / Math.min(14, candles.length);
    var mid = closes[Math.floor(closes.length/2)];
    return { range: range, interval: interval, pctChange: +((last-first)/first*100).toFixed(2), trend: last>mid ? 'UP' : 'DOWN', high: high, low: low, last: last, ema9: +ema9.toFixed(3), rsi: +rsi.toFixed(1), relVolume: +(lastVol/avgVol).toFixed(2), atr: +atr.toFixed(3), candleCount: candles.length };
  } catch(e) { return null; }
}

async function getFreshNews(symbol) {
  var news = [];
  if (FINNHUB_KEY) {
    try {
      var to = new Date().toISOString().split('T')[0];
      var from = new Date(Date.now()-3*86400000).toISOString().split('T')[0];
      var r = await fetch('https://finnhub.io/api/v1/company-news?symbol=' + symbol + '&from=' + from + '&to=' + to + '&token=' + FINNHUB_KEY + '&_=' + Date.now());
      var d = await r.json();
      if (Array.isArray(d)) d.slice(0,5).forEach(function(n) { news.push({ headline: n.headline, source: n.source, url: n.url, datetime: n.datetime, ageH: +((Date.now()/1000-n.datetime)/3600).toFixed(1) }); });
    } catch(e) {}
  }
  try {
    var r2 = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' + symbol + '&newsCount=5&_=' + Date.now(), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    var d2 = await r2.json();
    ((d2 && d2.news) || []).slice(0,3).forEach(function(n) { if (!news.find(function(x){return x.headline===n.title;})) news.push({ headline: n.title, source: n.publisher, url: n.link, datetime: n.providerPublishTime, ageH: +((Date.now()/1000-(n.providerPublishTime||0))/3600).toFixed(1) }); });
  } catch(e) {}
  return news.sort(function(a,b){return b.datetime-a.datetime;}).slice(0,6);
}

async function getMarketNewsFresh() {
  var news = [];
  if (!FINNHUB_KEY) return news;
  for (var cat of ['general','merger']) {
    try {
      var r = await fetch('https://finnhub.io/api/v1/news?category=' + cat + '&token=' + FINNHUB_KEY + '&_=' + Date.now());
      var d = await r.json();
      if (Array.isArray(d)) d.filter(function(n){return (Date.now()/1000-n.datetime)<7200;}).forEach(function(n){news.push({headline:n.headline,source:n.source,url:n.url,datetime:n.datetime,related:n.related,ageH:+((Date.now()/1000-n.datetime)/3600).toFixed(1)});});
    } catch(e) {}
  }
  return news.sort(function(a,b){return b.datetime-a.datetime;}).slice(0,40);
}

async function getSEC8K() {
  try {
    var r = await fetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=20&search_text=&output=atom&_=' + Date.now(), { headers: { 'User-Agent': 'MaverickBot/1.0 bot@maverick.com' } });
    var text = await r.text();
    var items = [];
    var regex = /<entry>([\s\S]*?)<\/entry>/g;
    var m;
    while ((m = regex.exec(text)) !== null) {
      var entry = m[1];
      var titleMatch = /<title>(.*?)<\/title>/.exec(entry);
      var linkMatch  = /<link.*?href="(.*?)"/.exec(entry);
      var updMatch   = /<updated>(.*?)<\/updated>/.exec(entry);
      var title   = titleMatch ? titleMatch[1] : '';
      var link    = linkMatch  ? linkMatch[1]  : '';
      var updated = updMatch   ? updMatch[1]   : '';
      items.push({ headline: title, source: 'SEC-8K', url: link, datetime: new Date(updated).getTime()/1000, ageH: +((Date.now()-new Date(updated).getTime())/3600000).toFixed(1) });
    }
    return items.slice(0,15);
  } catch(e) { return []; }
}

// LuxAlgo signal engine
function luxAlgoSignal(candles) {
  if (!candles || candles.candleCount < 20) return null;
  var price = candles.last;
  var high  = candles.high;
  var low   = candles.low;
  var ema9  = candles.ema9;
  var rsi   = candles.rsi;
  var atr   = candles.atr;
  var relVolume = candles.relVolume;
  var trend = candles.trend;
  var pctChange = candles.pctChange;
  var atrVal  = atr || (high-low)*0.5;
  var ema21   = +(ema9 * (trend==='UP' ? 0.985 : 1.015)).toFixed(2);
  var ema50   = +(ema9 * (trend==='UP' ? 0.970 : 1.030)).toFixed(2);
  var upperBand = +(ema21 + atrVal*1.5).toFixed(2);
  var lowerBand = +(ema21 - atrVal*1.5).toFixed(2);
  var bullishFan = ema9>ema21 && ema21>ema50;
  var bearishFan = ema9<ema21 && ema21<ema50;
  var bandPosition = atrVal>0 ? (price-lowerBand)/(upperBand-lowerBand) : 0.5;
  var bullishOB = +(low+(high-low)*0.15).toFixed(2);
  var fvgDetected = atrVal>(high-low)*0.3 && relVolume>2;
  var fvgLevel = +(trend==='UP' ? low+atrVal*0.5 : high-atrVal*0.5).toFixed(2);
  var bullishBOS = trend==='UP' && pctChange>3 && relVolume>1.5;
  var bullishPts = [bullishFan, price>ema21, rsi>40&&rsi<65, relVolume>1.2, bullishBOS, Math.abs(price-bullishOB)/price<0.05, fvgDetected&&trend==='UP'].filter(Boolean).length;
  var bearishPts = [bearishFan, price<ema21, rsi<50&&rsi>30, relVolume>1.2, trend==='DOWN'&&pctChange<-3&&relVolume>1.5, Math.abs(price-(high-(high-low)*0.15))/price<0.05].filter(Boolean).length;
  var signalType = 'NEUTRAL', signalStrength = 0, tpLevel = null, tp2Level = null, slLevel = null;
  if (bullishPts >= 4 && rsi < 70) {
    signalType = 'BUY'; signalStrength = Math.round(bullishPts/7*100);
    tpLevel  = +(price+atrVal*2).toFixed(2);
    tp2Level = +(price+atrVal*3.5).toFixed(2);
    slLevel  = +(price-atrVal*1.5).toFixed(2);
  } else if (bearishPts >= 4 && rsi > 30) {
    signalType = 'SELL'; signalStrength = Math.round(bearishPts/6*100);
    tpLevel = +(price-atrVal*2).toFixed(2);
    slLevel = +(price+atrVal*1.5).toFixed(2);
  }
  return { signalType: signalType, signalStrength: signalStrength, tpLevel: tpLevel, tp2Level: tp2Level, slLevel: slLevel, ema9: +ema9.toFixed(2), ema21: ema21, upperBand: upperBand, lowerBand: lowerBand, atrVal: +atrVal.toFixed(3), bullishOB: bullishOB, fvgDetected: fvgDetected, fvgLevel: fvgLevel, bos: bullishBOS ? 'BULLISH' : (trend==='DOWN'&&pctChange<-3 ? 'BEARISH' : 'NONE'), bandPosition: +bandPosition.toFixed(2), rsi: rsi, trend: trend, confluenceScore: bullishPts + '/7' };
}

// Trade math
function calcLevels(entry) {
  var sp = entry<5 ? 0.035 : entry<15 ? 0.028 : 0.02;
  var stop = +(entry*(1-sp)).toFixed(2);
  var risk = entry - stop;
  return { stop: stop, t1: +(entry+risk*2).toFixed(2), t2: +(entry+risk*3.5).toFixed(2), t3: +(entry+risk*5.5).toFixed(2), risk: +risk.toFixed(2) };
}
function totalShares(tr) { return tr.shares + tr.adds.reduce(function(s,a){return s+a.shares;},0); }
function avgCostCalc(tr) { return +((tr.entryPrice*tr.shares + tr.adds.reduce(function(s,a){return s+a.price*a.shares;},0))/totalShares(tr)).toFixed(2); }
function totalPnl(tr, p) { return +((p-tr.entryPrice)*tr.shares + tr.adds.reduce(function(s,a){return s+(p-a.price)*a.shares;},0)).toFixed(2); }

// Tick handler
function onTick(sym, price, vol) {
  if (!volTracker.has(sym)) volTracker.set(sym, { v1m: 0, reset: Date.now() });
  var vt = volTracker.get(sym);
  if (Date.now()-vt.reset > 60000) { vt.v1m = 0; vt.reset = Date.now(); }
  vt.v1m += vol;

  watches.forEach(function(w, cid) {
    if (w.symbol !== sym || w.confirmed) return;
    w.currentPrice = price;
    if (price >= w.entryLevel) {
      var apr = w.avgVolume ? w.avgVolume/390 : null;
      var vr  = apr ? vt.v1m/apr : 99;
      if (vr >= 1.5) {
        w.confirmed = true;
        var lv = calcLevels(price);
        tgSend(cid, 'ENTRY CONFIRMED - ' + sym + '\n\n$' + price.toFixed(2) + ' | Vol: ' + vr.toFixed(1) + 'x avg\n\nStop: $' + lv.stop + '\nT1: $' + lv.t1 + '\nT2: $' + lv.t2 + '\n\nText: in at ' + price.toFixed(2) + ' with 200 shares');
      }
    }
  });

  (priceAlerts.get(sym) || []).forEach(function(a) {
    if (a.fired) return;
    var hit = (a.condition==='ABOVE' && price>=a.value) || (a.condition==='BELOW' && price<=a.value);
    if (hit) { a.fired = true; tgSend(a.chatId, 'ALERT - ' + sym + '\n$' + price.toFixed(2) + ' ' + a.condition + ' $' + a.value + '\nText: watching ' + sym + ' at ' + price.toFixed(2)); }
  });

  trades.forEach(function(tr, cid) {
    if (tr.symbol !== sym) return;
    var prev = tr.currentPrice || tr.entryPrice;
    tr.currentPrice = price;
    var mins = (Date.now()-tr.entryTime)/60000;
    var pnl  = totalPnl(tr, price);
    var apr  = tr.avgVolume ? tr.avgVolume/390 : null;
    var vr   = apr ? vt.v1m/apr : 0;
    if (price > tr.hwm) { tr.hwm = price; if (tr.t1Hit) { var trail = +(price-(price-tr.avgCost)*0.40).toFixed(2); if (trail>tr.trailingStop) tr.trailingStop = trail; } }
    if (!tr.stopAlerted && price<=tr.stopLoss) { tr.stopAlerted=true; tgSend(cid, 'STOP HIT - ' + tr.symbol + '\n$' + price.toFixed(2) + '\nLoss: -$' + Math.abs(pnl).toFixed(2) + '\nEXIT NOW. Text: out at ' + price.toFixed(2)); }
    if (tr.t1Hit && !tr.trailAlerted && price<=tr.trailingStop) { tr.trailAlerted=true; tgSend(cid, 'TRAIL STOP - ' + tr.symbol + '\nLocked profit: +$' + pnl.toFixed(2) + '\nText: out at ' + price.toFixed(2)); }
    if (!tr.t1Hit && price>=tr.targets.t1) { tr.t1Hit=true; tr.stopLoss=tr.avgCost; tr.stopAlerted=false; tr.trailAlerted=false; tgSend(cid, 'TARGET 1 HIT - ' + tr.symbol + '\nProfit: +$' + totalPnl(tr,tr.targets.t1).toFixed(2) + '\nSell 50% - Stop moved to breakeven $' + tr.avgCost + '\nNext target: $' + tr.targets.t2); }
    if (!tr.t2Hit && price>=tr.targets.t2) { tr.t2Hit=true; tgSend(cid, 'TARGET 2 HIT - ' + tr.symbol + '\nProfit: +$' + totalPnl(tr,tr.targets.t2).toFixed(2) + '\nSell rest or hold to T3: $' + tr.targets.t3); }
    if (!tr.addSent && tr.t1Hit && !tr.t2Hit) { var pg=((price-tr.avgCost)/tr.avgCost)*100; if (pg>4&&vr>2&&price>prev*0.995) { tr.addSent=true; tgSend(cid, 'ADD SIGNAL - ' + tr.symbol + '\nVol: ' + vr.toFixed(1) + 'x | +' + pg.toFixed(1) + '%\nText: added 100 at ' + price.toFixed(2)); } }
    if (!tr.warn45 && mins>=45) { tr.warn45=true; tgSend(cid, '45-MIN WARNING - ' + tr.symbol + '\n' + mins.toFixed(0) + ' min in | P&L: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2)); }
    if (!tr.warn90 && mins>=90) { tr.warn90=true; tgSend(cid, '90-MIN WARNING - ' + tr.symbol + '\nMomentum typically done. Consider exit.\nText: out at ' + price.toFixed(2)); }
  });
}

// Memory
async function memLoad() { if (!JSONBIN_KEY||!JSONBIN_BIN) return {trades:[],scans:[]}; try { var r=await fetch('https://api.jsonbin.io/v3/b/'+JSONBIN_BIN+'/latest',{headers:{'X-Master-Key':JSONBIN_KEY}}); var d=await r.json(); return d.record||{trades:[],scans:[]}; } catch(e){return{trades:[],scans:[]};} }
async function memSave(rec) { if (!JSONBIN_KEY||!JSONBIN_BIN) return; try { await fetch('https://api.jsonbin.io/v3/b/'+JSONBIN_BIN,{method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},body:JSON.stringify(rec)}); } catch(e){} }
async function logTrade(entry) { var m=await memLoad(); m.trades=m.trades||[]; m.trades.push(Object.assign({},entry,{id:Date.now()})); await memSave(m); }

// Catalyst scanner
async function runCatalystScan(manual) {
  if (!GROQ_KEY) return;
  var now = Date.now();
  if (!manual && now-lastCatalystScan < 28*60*1000) return;
  lastCatalystScan = now;
  console.log('Running catalyst scan...');
  try {
    var results = await Promise.all([getMarketNewsFresh(), getSEC8K()]);
    var allNews = results[0].concat(results[1]).filter(function(n){ return n.headline && !scannedHeadlines.has(n.headline) && n.ageH < 8; }).slice(0,35);
    if (!allNews.length) { console.log('Catalyst scan: no fresh news'); return; }
    console.log('Catalyst scan: analyzing ' + allNews.length + ' items');
    var newsText = allNews.map(function(n){ return 'HEADLINE: ' + n.headline + '\nSOURCE: ' + n.source + '\nAGE: ' + n.ageH + 'h'; }).join('\n---\n');
    var CATALYST_PROMPT = 'You are MAVERICK Catalyst Intelligence. Find HIGH CONVICTION catalysts: FDA approval=95pts, Merger=93pts, Gov contract>2x mktcap=92pts, Oversubscribed placement=88pts, Earnings beat>30%=87pts. Only score>=75. US-listed only. Fresh only (<8h). RETURN ONLY VALID JSON: {"catalysts":[{"ticker":"","company_name":"","catalyst_headline":"","catalyst_type":"FDA|MERGER|CONTRACT|PLACEMENT|EARNINGS|OTHER","catalyst_score":0,"sixth_grade_explanation":"plain English","price_impact_probability":0,"estimated_move_pct":"X-Y%","time_sensitivity":"PRE-MARKET|TODAY|THIS_WEEK","source":""}]}';
    var r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{'Authorization':'Bearer '+GROQ_KEY,'Content-Type':'application/json'}, body:JSON.stringify({model:GROQ_MODELS[0],max_tokens:2000,temperature:0.2,messages:[{role:'system',content:CATALYST_PROMPT},{role:'user',content:'Analyze for catalysts (score>=75 only):\n\n'+newsText+'\n\nReturn ONLY valid JSON.'}]}) });
    if (!r.ok) { console.error('Catalyst Groq error: ' + r.status); return; }
    var d = await r.json();
    var text = (d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content)||'';
    var cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) { console.log('Catalyst: no JSON returned'); return; }
    var result = JSON.parse(match[0]);
    if (!result.catalysts||!result.catalysts.length) { console.log('Catalyst scan: nothing qualified'); return; }
    result.catalysts.forEach(function(c) {
      if (!c.catalyst_headline || scannedHeadlines.has(c.catalyst_headline)) return;
      scannedHeadlines.add(c.catalyst_headline);
      if (TG_CHAT_ID && bot) {
        var msg = 'CATALYST ALERT - Score: ' + c.catalyst_score + '/100\n\n' + (c.ticker||'?') + ' - ' + c.company_name + '\n\n' + c.catalyst_headline + '\n\nProbability: ' + c.price_impact_probability + '%\nMove: ' + c.estimated_move_pct + '\n' + c.sixth_grade_explanation + '\n\nReply: dive ' + (c.ticker||'TICKER');
        tgSend(TG_CHAT_ID, msg);
      }
    });
    console.log('Catalyst scan: ' + result.catalysts.length + ' alerts sent');
  } catch(e) { console.error('Catalyst scan error: ' + e.message); }
}

function scheduleCatalystScans() {
  setInterval(function(){ runCatalystScan(false); }, 28*60*1000);
  setInterval(function(){
    var et = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
    var h = et.getHours(); var m = et.getMinutes(); var isWeekday = et.getDay()>0&&et.getDay()<6;
    if (!isWeekday) return;
    if ((h===4||h===6||h===8) && m<2) runCatalystScan(false);
  }, 60*1000);
}

function getScanInterval() {
  var et = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  var h = et.getHours(); var min = et.getMinutes(); var total = h*60+min;
  var isWeekday = et.getDay()>0&&et.getDay()<6;
  if (!isWeekday||total<4*60||total>=16*60) return null;
  if (total<9.5*60) return 3; if (total<11*60) return 1.5; if (total<15.5*60) return 4; return 1.5;
}

async function continuousScanCycle() {
  if (!getScanInterval()) return;
  scanCycleCount++;
  var candidates = new Set();
  try { var r=await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=day_gainers&_='+Date.now(),{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}}); var d=await r.json(); ((d&&d.finance&&d.finance.result&&d.finance.result[0]&&d.finance.result[0].quotes)||[]).filter(function(q){return q.regularMarketPrice<10&&q.regularMarketChangePercent>15;}).forEach(function(q){candidates.add(q.symbol);}); } catch(e){}
  try { var r2=await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=most_actives&_='+Date.now(),{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}}); var d2=await r2.json(); ((d2&&d2.finance&&d2.finance.result&&d2.finance.result[0]&&d2.finance.result[0].quotes)||[]).filter(function(q){var rv=q.regularMarketVolume/(q.averageDailyVolume3Month||1);return q.regularMarketPrice<10&&rv>8;}).forEach(function(q){candidates.add(q.symbol);}); } catch(e){}
  var syms = Array.from(candidates).slice(0,6);
  for (var i=0; i<syms.length; i++) {
    var sym = syms[i];
    var last = scanCache.get(sym);
    if (last && (Date.now()-last) < 90*60*1000) continue;
    try {
      var results = await Promise.all([getQuote(sym), getCandles(sym,'3mo','1d'), getCandles(sym,'2d','15m'), getFreshNews(sym)]);
      var quote=results[0], tf1d=results[1], tf15=results[2], news=results[3];
      if (!quote) continue;
      var score = 0;
      if (news.length>0&&news[0].ageH<4) score++;
      if (quote.floatShares&&quote.floatShares<5e6) score++;
      if (quote.price>=0.5&&quote.price<=10) score++;
      if (tf1d&&tf1d.relVolume>=5) score++;
      if (Math.abs(quote.changePct||0)>=15) score++;
      if (tf15&&tf15.trend==='UP'&&tf15.rsi>50&&tf15.rsi<75) score++;
      if (tf1d) { var lux=luxAlgoSignal(tf1d); if (lux&&lux.signalType==='BUY'&&lux.signalStrength>50) score++; }
      if (score>=4&&TG_CHAT_ID&&bot) {
        scanCache.set(sym, Date.now());
        var tier = score>=7 ? 'PERFECT TRADE' : score>=6 ? 'NEAR PERFECT' : 'STRONG SETUP';
        tgSend(TG_CHAT_ID, tier + ' - ' + sym + '\nScore: ' + score + '/7 conditions\n$' + quote.price.toFixed(2) + ' | +' + (quote.changePct||0).toFixed(1) + '%\n\nText: dive ' + sym);
      }
      await new Promise(function(r){setTimeout(r,300);});
    } catch(e){}
  }
}

function startContinuousScanner() {
  console.log('Continuous scanner armed (4am-4pm ET)');
  var run = async function() {
    await continuousScanCycle().catch(function(e){console.error('Scan: '+e.message);});
    var iv = getScanInterval();
    setTimeout(run, (iv||5)*60*1000);
  };
  setTimeout(run, 30000);
}

// === API ROUTES ===

app.get('/api/groq-test', async function(req, res) {
  if (!GROQ_KEY) return res.json({ error: 'GROQ_KEY not set', key_present: false });
  try {
    var modelsR = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': 'Bearer ' + GROQ_KEY } });
    var modelsD = await modelsR.json();
    var testR = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{'Authorization':'Bearer '+GROQ_KEY,'Content-Type':'application/json'}, body:JSON.stringify({model:GROQ_MODELS[0],max_tokens:10,messages:[{role:'user',content:'Say OK'}]}) });
    var testD = await testR.json();
    res.json({ key_present: true, key_starts_with: GROQ_KEY.slice(0,8)+'...', models_status: modelsR.status, models_available: modelsD.data ? modelsD.data.map(function(m){return m.id;}) : modelsD, completion_status: testR.status, completion_result: testD.choices&&testD.choices[0]&&testD.choices[0].message ? testD.choices[0].message.content : testD });
  } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/analyze', async function(req, res) {
  var ticker = req.body.ticker;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase().trim();
  try {
    var results = await Promise.all([getQuote(sym), getCandles(sym,'3mo','1d'), getCandles(sym,'1mo','60m'), getCandles(sym,'5d','60m'), getCandles(sym,'2d','15m'), getFreshNews(sym)]);
    var quote=results[0], tf1d=results[1], tf4h=results[2], tf1h=results[3], tf15=results[4], news=results[5];
    if (!quote) return res.status(404).json({ error: sym + ' not found' });
    var luxAlgo = { daily: tf1d?luxAlgoSignal(tf1d):null, fourhour: tf4h?luxAlgoSignal(tf4h):null, onehour: tf1h?luxAlgoSignal(tf1h):null };
    var payload = { ticker:sym, quote:{price:quote.price,changePct:quote.changePct,open:quote.open,high:quote.high,low:quote.low,marketCap:quote.marketCap,floatShares:quote.floatShares,sector:quote.sector}, timeframes:{daily:tf1d||'unavailable',fourhour:tf4h||'unavailable',onehour:tf1h||'unavailable',fifteen:tf15||'unavailable'}, luxAlgo_signals:luxAlgo, recent_news:news.slice(0,3).map(function(n){return n.headline;}) };
    var ANALYZE_PROMPT = 'You are MAVERICK aggressive day trading AI. Use all timeframes. LuxAlgo signals are primary. VERDICTS: BUY|DONT_BUY|WATCH. Stop=1.5xATR. T1=2x risk. T2=3.5x. RETURN ONLY VALID JSON: {"verdict":"BUY|DONT_BUY|WATCH","conviction":0-100,"headline":"one decisive sentence","chart_pattern":"pattern","timeframe_alignment":"BULLISH|BEARISH|MIXED|NEUTRAL","reasoning":["bullet1","bullet2","bullet3"],"entry_zone":{"low":0.00,"high":0.00},"stop_loss":0.00,"target_1":0.00,"target_2":0.00,"target_3":0.00,"risk_reward":0.0,"position_size_suggestion":"AGGRESSIVE|STANDARD|SMALL","trade_type":"DAY_TRADE|SWING|SCALP","key_risk":"specific risk","trigger_to_watch":"if WATCH","time_horizon":"estimate"}';
    var verdict = await groqCall(ANALYZE_PROMPT, JSON.stringify(payload));
    if (!verdict) return res.status(503).json({ error: 'AI unavailable - visit /api/groq-test' });
    res.json({ ticker:sym, verdict:verdict, luxAlgo:luxAlgo, data:{quote:quote,timeframes:{daily:tf1d,fourhour:tf4h,onehour:tf1h,fifteen:tf15},news:news}, timestamp:new Date().toISOString() });
  } catch(e) { console.error('Analyze: '+e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/quote/:symbol', async function(req, res) { var q=await getQuote(req.params.symbol.toUpperCase()); if(!q)return res.status(404).json({error:'not found'}); res.json(q); });

app.post('/api/luxalgo', async function(req, res) {
  var ticker = req.body.ticker;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  var sym = ticker.toUpperCase();
  var results = await Promise.all([getCandles(sym,'3mo','1d'),getCandles(sym,'1mo','60m'),getCandles(sym,'5d','60m'),getCandles(sym,'2d','15m')]);
  res.json({ ticker:sym, daily:results[0]?luxAlgoSignal(results[0]):null, fourhour:results[1]?luxAlgoSignal(results[1]):null, onehour:results[2]?luxAlgoSignal(results[2]):null, fifteen:results[3]?luxAlgoSignal(results[3]):null, timestamp:new Date().toISOString() });
});

app.get('/api/signals', async function(req, res) {
  var signals = [];
  if (FINNHUB_KEY) {
    try { var r=await fetch('https://finnhub.io/api/v1/news?category=general&token='+FINNHUB_KEY+'&_='+Date.now()); var d=await r.json(); if(Array.isArray(d)){d.filter(function(n){return(Date.now()/1000-n.datetime)<3600&&n.related;}).slice(0,8).forEach(function(n){signals.push({type:'CATALYST',symbol:n.related,name:n.source,price:null,changePct:null,signal:n.headline.slice(0,100),strength:'MODERATE',source:n.source,url:n.url,ageH:+((Date.now()/1000-n.datetime)/3600).toFixed(1)});});} } catch(e){}
  }
  try { var sec=await getSEC8K(); sec.filter(function(s){return s.ageH<2;}).slice(0,5).forEach(function(s){signals.push({type:'SEC_8K',symbol:'SEC',name:'SEC Edgar',signal:s.headline,strength:'STRONG',source:'SEC-EDGAR',url:s.url,ageH:s.ageH});}); } catch(e){}
  try { var r2=await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=10&scrIds=day_gainers&_='+Date.now(),{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}}); var d2=await r2.json(); ((d2&&d2.finance&&d2.finance.result&&d2.finance.result[0]&&d2.finance.result[0].quotes)||[]).filter(function(q){return q.regularMarketChangePercent>10&&q.regularMarketPrice<10;}).slice(0,5).forEach(function(q){var rv=+(q.regularMarketVolume/(q.averageDailyVolume3Month||1)).toFixed(1);signals.push({type:'MOMENTUM',symbol:q.symbol,name:q.shortName||q.symbol,price:q.regularMarketPrice,changePct:q.regularMarketChangePercent,relVolume:rv,signal:'+'+q.regularMarketChangePercent.toFixed(1)+'% | '+rv+'x vol',strength:rv>5?'STRONG':rv>2?'MODERATE':'WEAK',source:'Yahoo'});});}catch(e){}
  res.json({ signals: signals.sort(function(a,b){return(a.ageH||0)-(b.ageH||0);}), timestamp:new Date().toISOString(), freshAt:new Date().toLocaleTimeString() });
});

app.post('/api/catalyst-scan', function(req, res) { res.json({ ok:true, message:'Catalyst scan triggered - Telegram alert incoming if qualifying catalysts found. Check in 30 seconds.' }); runCatalystScan(true); });

app.post('/api/supernova', async function(req, res) {
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_KEY missing' });
  try {
    var movers = [];
    try { var r=await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=30&scrIds=day_gainers&_='+Date.now(),{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}}); var d=await r.json(); movers=((d&&d.finance&&d.finance.result&&d.finance.result[0]&&d.finance.result[0].quotes)||[]).slice(0,25).map(function(q){return{symbol:q.symbol,name:q.shortName,price:q.regularMarketPrice,changePct:q.regularMarketChangePercent,volume:q.regularMarketVolume,avgVolume:q.averageDailyVolume3Month,relVolume:+(q.regularMarketVolume/(q.averageDailyVolume3Month||1)).toFixed(1),marketCap:q.marketCap,float:q.floatShares};}).filter(function(s){return s.price&&s.price<25;}); } catch(e){}
    var NOVA_PROMPT = 'Maverick Supernova Detection. Score 0-100: Catalyst(30),Float(25),Velocity(20),Pillars(15),SGT(10). Tiers: SUPERNOVA(85+),IGNITING(70+),WARMING(55+). RETURN ONLY VALID JSON: {"scan_time":"ISO","market_session":"string","market_pulse":"2 sentences","supernovas":[{"ticker":"","company":"","price":0,"price_change_pct":0,"float_millions":0,"catalyst":"","trade_type":"LONG|FADE","phase":"IGNITION|FUEL_BURN|DISTRIBUTION","is_sixth_grade_trade":true,"sixth_grade_explanation":"","supernova_score":0,"tier":"SUPERNOVA|IGNITING|WARMING","entry_zone":"$X-$Y","stop":0,"target_1":0,"target_2":0,"risk_reward":0,"thesis":""}],"algo_note":""}';
    var verdict = await groqCall(NOVA_PROMPT, 'Todays movers:\n' + JSON.stringify(movers,null,2) + '\nTime:' + new Date().toLocaleString() + '\nReturn ONLY JSON.', 4000);
    if (!verdict) return res.status(500).json({ error: 'AI returned no data. Visit /api/groq-test' });
    res.json(verdict);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/whale-scan', async function(req, res) {
  try {
    var candidates = new Set();
    for (var scrId of ['day_gainers','most_actives']) {
      try { var r=await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds='+scrId+'&_='+Date.now(),{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}}); var d=await r.json(); ((d&&d.finance&&d.finance.result&&d.finance.result[0]&&d.finance.result[0].quotes)||[]).filter(function(q){return q.regularMarketPrice<15&&q.regularMarketPrice>0.5;}).forEach(function(q){candidates.add(q.symbol);}); } catch(e){}
    }
    var scored = [];
    var syms = Array.from(candidates).slice(0,25);
    for (var i=0; i<syms.length; i++) {
      try {
        var sym = syms[i];
        var results = await Promise.all([getQuote(sym), getCandles(sym,'3mo','1d')]);
        var quote=results[0], tf1d=results[1];
        if (!quote||!tf1d) continue;
        var priceRange=tf1d.high-tf1d.low, pricePos=priceRange>0?(quote.price-tf1d.low)/priceRange:0.5;
        var isPhase2=pricePos>=0.15&&pricePos<=0.50&&tf1d.rsi>=40&&tf1d.rsi<=65;
        var isPhase3=pricePos>0.50&&pricePos<=0.80&&tf1d.rsi>50&&tf1d.pctChange>0;
        if (!isPhase2&&!isPhase3) continue;
        var lux = luxAlgoSignal(tf1d);
        var score = isPhase2 ? 35 : 28;
        if (tf1d.relVolume>2) score+=15;
        if (lux&&lux.signalType==='BUY') score+=20;
        scored.push({symbol:sym,price:quote.price,changePct:quote.changePct,phase:isPhase2?2:3,footprintScore:Math.min(100,score),volumePattern:tf1d.relVolume>1.5?'ACCUMULATION':'NEUTRAL',rsi:tf1d.rsi,floatShares:quote.floatShares,shortName:quote.shortName,defendedLevel:+tf1d.low.toFixed(2),footprintSignals:[isPhase2?'PHASE 2 - Price defense zone':'PHASE 3 - Markup in progress',tf1d.relVolume>2?'Volume '+tf1d.relVolume.toFixed(1)+'x average':'',lux&&lux.signalType==='BUY'?'LuxAlgo BUY - TP $'+lux.tpLevel:''].filter(Boolean),aiWhy:lux&&lux.signalType==='BUY'?'LuxAlgo aligned, '+(isPhase2?'Phase 2 defense':'Phase 3 markup'):isPhase2?'Phase 2 price defense':'Phase 3 markup'});
        await new Promise(function(r){setTimeout(r,200);});
      } catch(e){}
    }
    var top = scored.sort(function(a,b){return b.footprintScore-a.footprintScore;}).slice(0,5);
    if (top.length&&TG_CHAT_ID&&bot&&req.body.alertTelegram) { tgSend(TG_CHAT_ID, 'WHALE SCAN COMPLETE\nScanned: '+Array.from(candidates).length+' | Phase 2/3: '+scored.length+'\n\n'+top.slice(0,3).map(function(s,i){return (i+1)+'. '+s.symbol+' - Phase '+s.phase+' Score '+s.footprintScore+'/100\n$'+s.price.toFixed(2)+' | '+s.aiWhy;}).join('\n\n')+'\n\nText: dive [TICKER]'); }
    res.json({ results:top, allCandidates:scored, totalScanned:Array.from(candidates).length, timestamp:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alert', function(req, res) {
  var symbol=req.body.symbol, condition=req.body.condition, value=req.body.value, chatId=req.body.chatId;
  if (!symbol||!condition||!value) return res.status(400).json({error:'missing fields'});
  var sym = symbol.toUpperCase();
  if (!priceAlerts.has(sym)) priceAlerts.set(sym,[]);
  priceAlerts.get(sym).push({chatId:chatId||TG_CHAT_ID,condition:condition,value:+value,fired:false});
  addSub(sym,chatId||TG_CHAT_ID);
  res.json({ok:true,symbol:sym,condition:condition,value:+value});
});

app.post('/webhook/tradingview', function(req, res) {
  if ((req.query.secret||req.body.secret) !== WEBHOOK_SECRET) return res.status(401).json({error:'unauthorized'});
  var ticker=req.body.ticker, action=req.body.action, indicator=req.body.indicator, price=req.body.price;
  if (!ticker||!action) return res.status(400).json({error:'missing'});
  var sym = ticker.toUpperCase();
  tvSignals.set(sym,{action:action.toUpperCase(),indicator:indicator||'TV',price:parseFloat(price)||null,time:Date.now()});
  if (TG_CHAT_ID&&bot) tgSend(TG_CHAT_ID,'TV SIGNAL - '+sym+'\n'+action.toUpperCase()+' at $'+(price||'?'));
  res.json({ok:true});
});

app.post('/api/chat', async function(req, res) {
  if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_KEY not set. Visit /api/groq-test' });
  var message=req.body.message, sessionId=req.body.sessionId, portfolioSize=req.body.portfolioSize;
  if (!message) return res.status(400).json({ error: 'no message' });
  var sid = sessionId || 'default';
  if (!chatSessions.has(sid)) chatSessions.set(sid,[]);
  var history = chatSessions.get(sid);
  var liveContext = '';
  var tm = message.match(/\b([A-Z]{2,5})\b/g);
  var skipWords = ['THE','AND','FOR','BUY','ADD','OUT','NOT','HOW','CAN'];
  if (tm) {
    for (var i=0; i<Math.min(tm.length,2); i++) {
      if (skipWords.indexOf(tm[i]) !== -1) continue;
      try { var q=await getQuote(tm[i]); if(q){liveContext+='\nLIVE '+tm[i]+': $'+q.price.toFixed(2)+', '+q.changePct.toFixed(2)+'%, H$'+q.high.toFixed(2)+' L$'+q.low.toFixed(2)+', Cap'+(q.marketCap?'$'+(q.marketCap/1e6).toFixed(0)+'M':'n/a')+', Float'+(q.floatShares?(q.floatShares/1e6).toFixed(1)+'M':'n/a');break;} } catch(e){}
    }
  }
  var pSize = portfolioSize || 348;
  var portfolioCtx = '\nPORTFOLIO: $' + pSize + ' | Reserve:$100 | Tradeable:$' + (pSize-100) + ' | Max/trade:$' + Math.round((pSize-100)*0.35);
  var ADVISOR_PROMPT = 'You are MAVERICKs personal hedge fund AI advisor. Portfolio: $' + pSize + ' (keep $100 reserve, tradeable=$' + (pSize-100) + ', max/trade=$' + Math.round((pSize-100)*0.35) + '). Phase 2/3 player. Sub-$10. Aggressive. Never fights dilution. Position size: Shares=max_risk/(entry-stop). Max risk=3% portfolio. Direct. Under 200 words. Exact numbers.';
  var messages = [{role:'system',content:ADVISOR_PROMPT+portfolioCtx}].concat(history.slice(-10)).concat([{role:'user',content:message+liveContext}]);
  try {
    var r = await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+GROQ_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:GROQ_MODELS[0],max_tokens:500,temperature:0.3,messages:messages})});
    if (!r.ok) { var err=await r.text(); return res.status(503).json({error:'Groq '+r.status+': '+err.slice(0,100)}); }
    var d = await r.json();
    var reply = d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content;
    if (!reply) return res.status(503).json({error:'Empty AI response'});
    history.push({role:'user',content:message}); history.push({role:'assistant',content:reply}); if (history.length>20) history.splice(0,2);
    res.json({reply:reply,sessionId:sid});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/chat/clear', function(req, res) { chatSessions.delete(req.body.sessionId||'default'); res.json({ok:true}); });

app.get('/api/health', function(req, res) { res.json({status:'online',version:'3.4',time:new Date().toISOString(),botUsername:BOT_USERNAME,services:{telegram:!!TELEGRAM_TOKEN,finnhub:!!FINNHUB_KEY,groq:!!GROQ_KEY,memory:!!(JSONBIN_KEY&&JSONBIN_BIN)},active:{watches:watches.size,trades:trades.size,scanCycles:scanCycleCount}}); });

app.get('*', function(req, res) { res.sendFile(path.join(__dirname,'public','index.html')); });

// === TELEGRAM HANDLERS ===
function setupTelegramHandlers() {
  function parseTg(text) {
    var t = text.trim(); var m;
    m=t.match(/^watch(?:ing)?\s+([A-Za-z.]{1,6})\s+(?:at|for)?\s*\$?(\d+\.?\d*)(?:\s+stop\s*\$?(\d+\.?\d*))?/i); if(m)return{cmd:'watch',symbol:m[1].toUpperCase(),price:+m[2],stop:m[3]?+m[3]:null};
    m=t.match(/^in\b.*?\$?(\d+\.?\d*)\D+(\d+)/i); if(m)return{cmd:'in',price:+m[1],shares:+m[2]};
    m=t.match(/^out\b.*?\$?(\d+\.?\d*)/i); if(m)return{cmd:'out',price:+m[1]};
    m=t.match(/^add(?:ed)?\s+(\d+)[^$\d]*\$?(\d+\.?\d*)/i); if(m)return{cmd:'add',shares:+m[1],price:+m[2]};
    m=t.match(/^(?:sl|stop)\s+\$?(\d+\.?\d*)/i); if(m)return{cmd:'sl',price:+m[1]};
    m=t.match(/^alert\s+([A-Za-z.]{1,6})\s+(above|below|cross)\s+\$?(\d+\.?\d*)/i); if(m)return{cmd:'alert',symbol:m[1].toUpperCase(),condition:m[2].toUpperCase(),value:+m[3]};
    m=t.match(/^dive\s+([A-Za-z.]{1,6})/i); if(m)return{cmd:'dive',symbol:m[1].toUpperCase()};
    m=t.match(/^([A-Z.]{1,6})$/); if(m)return{cmd:'quote',symbol:m[1]};
    if(/^(news|catalyst)/i.test(t))return{cmd:'news'};
    if(/^(status|p&l)/i.test(t))return{cmd:'status'};
    if(/^(cancel|clear)/i.test(t))return{cmd:'cancel'};
    if(/^(daily|today)/i.test(t))return{cmd:'daily'};
    if(/^(weekly)/i.test(t))return{cmd:'weekly'};
    if(/^help$/i.test(t))return{cmd:'help'};
    return{cmd:'chat',text:t};
  }

  bot.on('message', async function(msg) {
    var cid = msg.chat.id;
    var text = (msg.text||'').trim();
    if (!text) return;
    console.log('[TG ' + cid + '] ' + (msg.from&&msg.from.first_name||'?') + ': ' + text);
    var p = parseTg(text);

    if (p.cmd === 'chat') {
      if (!GROQ_KEY) { tgSend(cid, 'AI not available.'); return; }
      try { var r=await fetch('http://localhost:'+PORT+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,sessionId:String(cid)})}); var d=await r.json(); tgSend(cid,d.reply||'Error: '+d.error); } catch(e) { tgSend(cid,'Error: '+e.message); }
      return;
    }

    switch(p.cmd) {
      case 'watch': {
        tgSend(cid, 'Looking up ' + p.symbol + '...');
        var q = await getQuote(p.symbol);
        if (!q) { tgSend(cid, p.symbol + ' not found.'); return; }
        var lv = calcLevels(p.price);
        watches.set(cid, {symbol:p.symbol,entryLevel:p.price,customStop:p.stop,currentPrice:q.price,avgVolume:q.avgVolume,confirmed:false});
        addSub(p.symbol, cid);
        tgSend(cid, 'WATCHING ' + p.symbol + '\n\nNow: $' + q.price.toFixed(2) + ' | Trigger: $' + p.price + '\n\nStop: $' + (p.stop||lv.stop) + '\nT1: $' + lv.t1 + '\nT2: $' + lv.t2 + '\n\nLive monitoring active');
        break;
      }
      case 'in': {
        var w = watches.get(cid);
        if (!w) { tgSend(cid, 'Set watch first: watching LFVN at 5.10'); return; }
        var lv2 = calcLevels(p.price);
        var tr = {symbol:w.symbol,entryPrice:p.price,shares:p.shares,entryTime:Date.now(),currentPrice:p.price,hwm:p.price,avgCost:p.price,stopLoss:w.customStop||lv2.stop,trailingStop:lv2.stop,targets:{t1:lv2.t1,t2:lv2.t2,t3:lv2.t3},avgVolume:w.avgVolume,adds:[],t1Hit:false,t2Hit:false,stopAlerted:false,trailAlerted:false,warn45:false,warn90:false,addSent:false};
        trades.set(cid, tr); watches.delete(cid); addSub(w.symbol, cid);
        tgSend(cid, 'IN - ' + w.symbol + '\n$' + p.price + ' x ' + p.shares + ' shares = $' + (p.price*p.shares).toFixed(2) + '\n\nStop: $' + tr.stopLoss + ' (max loss -$' + (lv2.risk*p.shares).toFixed(2) + ')\nT1: $' + lv2.t1 + '\nT2: $' + lv2.t2 + '\nT3: $' + lv2.t3 + '\n\nMonitoring: stop, targets, trail, 45min, adds');
        break;
      }
      case 'out': {
        var tr2 = trades.get(cid);
        if (!tr2) { tgSend(cid, 'No active trade.'); return; }
        var pnl = totalPnl(tr2, p.price);
        var ts  = totalShares(tr2);
        var mins = ((Date.now()-tr2.entryTime)/60000).toFixed(0);
        var pct  = (((p.price-tr2.avgCost)/tr2.avgCost)*100).toFixed(2);
        await logTrade({symbol:tr2.symbol,date:new Date().toISOString().split('T')[0],entryPrice:tr2.entryPrice,exitPrice:p.price,shares:ts,avgCost:tr2.avgCost,pnl:pnl,pnlPct:+pct,minutesInTrade:+mins,t1Hit:tr2.t1Hit,t2Hit:tr2.t2Hit});
        removeSub(tr2.symbol, cid); trades.delete(cid);
        var result = pnl>0 ? 'WIN' : 'LOSS';
        tgSend(cid, result + ' - CLOSED ' + tr2.symbol + '\n$' + tr2.entryPrice + ' to $' + p.price + ' | ' + ts + ' shares | ' + mins + 'min\n\nP&L: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) + ' (' + pct + '%)\n\n' + (pnl>0?'Banked. Well executed, Maverick.':'Stop respected. Next setup.') + '\n\nText: daily');
        break;
      }
      case 'add': {
        var tr3 = trades.get(cid);
        if (!tr3) { tgSend(cid, 'No active trade.'); return; }
        tr3.adds.push({shares:p.shares,price:p.price}); tr3.avgCost = avgCostCalc(tr3);
        tgSend(cid, 'ADDED ' + tr3.symbol + '\n+' + p.shares + ' @ $' + p.price + '\nTotal: ' + totalShares(tr3) + ' shares | Avg cost: $' + tr3.avgCost);
        break;
      }
      case 'sl': {
        var tr4=trades.get(cid), w2=watches.get(cid);
        if (tr4) { tr4.stopLoss=p.price; tr4.stopAlerted=false; tgSend(cid,'Stop updated to $'+p.price+' on '+tr4.symbol); }
        else if (w2) { w2.customStop=p.price; tgSend(cid,'Stop set to $'+p.price); }
        else tgSend(cid,'No active trade.');
        break;
      }
      case 'alert': {
        if (!priceAlerts.has(p.symbol)) priceAlerts.set(p.symbol,[]);
        priceAlerts.get(p.symbol).push({chatId:cid,condition:p.condition,value:p.value,fired:false});
        addSub(p.symbol,cid);
        tgSend(cid,'Alert set - ' + p.symbol + '\nFires when price ' + p.condition + ' $' + p.value + '\nMonitored via Finnhub live feed');
        break;
      }
      case 'dive': {
        tgSend(cid,'Analyzing ' + p.symbol + '...');
        try {
          var r=await fetch('http://localhost:'+PORT+'/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker:p.symbol})});
          var data=await r.json();
          if (data.error) { tgSend(cid,'Error: '+data.error); return; }
          var v=data.verdict;
          var vtext={BUY:'BUY',DONT_BUY:'DO NOT BUY',WATCH:'WATCH'}[v.verdict]||v.verdict;
          var msg=vtext+' - '+p.symbol+'\nConviction: '+v.conviction+'/100\n\n'+v.headline+'\n\n'+((v.reasoning||[]).map(function(r){return '- '+r;}).join('\n'));
          if (v.verdict==='BUY') msg+='\n\nEntry: $'+v.entry_zone.low+'-$'+v.entry_zone.high+'\nStop: $'+v.stop_loss+' | T1: $'+v.target_1+' | R:R: '+v.risk_reward+':1\n\nText: watching '+p.symbol+' at '+v.entry_zone.low;
          tgSend(cid,msg);
        } catch(e){tgSend(cid,'Error: '+e.message);}
        break;
      }
      case 'quote': {
        var q2=await getQuote(p.symbol);
        if (!q2) { tgSend(cid,p.symbol+' not found.'); return; }
        tgSend(cid,p.symbol+' - $'+q2.price.toFixed(2)+' ('+(q2.changePct>=0?'+':'')+q2.changePct.toFixed(2)+'%)\nH:$'+q2.high.toFixed(2)+' L:$'+q2.low.toFixed(2)+'\nCap:'+(q2.marketCap?'$'+(q2.marketCap/1e6).toFixed(0)+'M':'n/a')+' Float:'+(q2.floatShares?(q2.floatShares/1e6).toFixed(1)+'M':'n/a')+'\n\nText: watching '+p.symbol+' at '+q2.price.toFixed(2));
        break;
      }
      case 'news': { tgSend(cid,'Scanning catalysts...'); runCatalystScan(true); break; }
      case 'status': {
        var tr5=trades.get(cid), w3=watches.get(cid);
        if (tr5) {
          var price2=tr5.currentPrice||tr5.entryPrice;
          var pnl2=totalPnl(tr5,price2);
          var mins2=((Date.now()-tr5.entryTime)/60000).toFixed(0);
          var t1status = tr5.t1Hit ? 'HIT' : 'waiting';
          var t2status = tr5.t2Hit ? 'HIT' : 'waiting';
          tgSend(cid,'LIVE - '+tr5.symbol+'\n\nEntry:$'+tr5.entryPrice+' | Now:$'+price2.toFixed(2)+'\nP&L:'+(pnl2>=0?'+':'')+'$'+pnl2.toFixed(2)+' | '+mins2+'min\n\nStop: $'+tr5.stopLoss+'\nT1: $'+tr5.targets.t1+' ['+t1status+']\nT2: $'+tr5.targets.t2+' ['+t2status+']');
        } else if (w3) {
          tgSend(cid,'Watching '+w3.symbol+' for $'+w3.entryLevel+' | Now: $'+(w3.currentPrice||'...'));
        } else {
          tgSend(cid,'No active trade.\n\nText: watching [TICKER] at [price]');
        }
        break;
      }
      case 'cancel': {
        var sym2=watches.get(cid)&&watches.get(cid).symbol || trades.get(cid)&&trades.get(cid).symbol;
        if (sym2) removeSub(sym2,cid);
        watches.delete(cid); trades.delete(cid);
        tgSend(cid,'Cleared. Ready.\n\nText: watching [TICKER] at [price]');
        break;
      }
      case 'daily': {
        var mem=await memLoad(); var today=new Date().toISOString().split('T')[0];
        var list=(mem.trades||[]).filter(function(t){return t.date===today;});
        if (!list.length) { tgSend(cid,'No trades logged today.'); return; }
        var total=list.reduce(function(s,t){return s+t.pnl;},0);
        var wins=list.filter(function(t){return t.pnl>0;});
        tgSend(cid,'TODAY\nTrades: '+list.length+' | Wins: '+wins.length+' ('+(list.length?(wins.length/list.length*100).toFixed(0):0)+'%)\nTotal: '+(total>=0?'+':'')+'$'+total.toFixed(2)+'\n\n'+list.map(function(t){return t.symbol+' '+(t.pnl>=0?'+':'')+'$'+t.pnl.toFixed(2);}).join('\n'));
        break;
      }
      case 'weekly': {
        var mem2=await memLoad(); var list2=(mem2.trades||[]).filter(function(t){return(Date.now()-new Date(t.date).getTime())<7*86400000;});
        if (!list2.length) { tgSend(cid,'No trades this week.'); return; }
        var total2=list2.reduce(function(s,t){return s+t.pnl;},0); var wins2=list2.filter(function(t){return t.pnl>0;});
        tgSend(cid,'WEEK\nTrades: '+list2.length+' | Wins: '+wins2.length+'\nTotal: '+(total2>=0?'+':'')+'$'+total2.toFixed(2));
        break;
      }
      case 'help': {
        tgSend(cid,'MAVERICK BOT v3.4\n\nTRADE:\nwatching LFVN at 5.10\nwatching LFVN at 5.10 stop 4.80\nin at 5.11 with 200 shares\nadded 100 at 5.50\nsl 4.88\nout at 5.85\nstatus | cancel\n\nALERTS:\nalert LFVN above 5.50\nalert LFVN below 4.80\n\nANALYSIS:\nLFVN - quote\ndive LFVN - AI analysis\nnews - catalyst scan\n\nREPORTS:\ndaily | weekly\n\nCHAT:\nType naturally - how many shares should I buy?');
        break;
      }
    }
  });
  bot.on('polling_error', function(e) { if (e.message.indexOf('409')===-1&&e.message.indexOf('401')===-1) console.error('Polling: '+e.message); });
}

var PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async function() {
  console.log('\nMAVERICK TERMINAL v3.4 - Port ' + PORT);
  console.log('   Telegram:  ' + (TELEGRAM_TOKEN?'OK':'MISSING'));
  console.log('   Finnhub:   ' + (FINNHUB_KEY?'OK':'MISSING'));
  console.log('   Groq AI:   ' + (GROQ_KEY?'OK':'MISSING'));
  console.log('   Memory:    ' + (JSONBIN_KEY?'OK':'optional'));
  console.log('   Models:    ' + GROQ_MODELS[0]);
  console.log('   Test:      /api/groq-test\n');
  connectFinnhub();
  scheduleCatalystScans();
  startContinuousScanner();
  await initTelegram();
});
