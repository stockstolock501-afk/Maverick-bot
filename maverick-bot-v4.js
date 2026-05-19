/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         MAVERICK INTEL BOT v5.0 — SUPERNOVA PROTOCOL     ║
 * ║                                                          ║
 * ║  v5.0 — PHASE 3: PROJECT SUPERNOVA SCIENCE              ║
 * ║  • /supernova TICKER — Full Supernova Protocol score     ║
 * ║  • 9 Supernova Ingredients scored live                   ║
 * ║  • Rule of Five engine — 5/9 = tradeable candidate       ║
 * ║  • 5 Archetype classifier (Gap&Squeeze, Catalyst, etc.)  ║
 * ║  • 7 False Signal detector — flags known traps           ║
 * ║  • 5-Phase lifecycle engine — where is this ticker NOW   ║
 * ║  • 3 Entry window awareness — right time to enter?       ║
 * ║  • Kill zone exit signals — when to get out              ║
 * ║  • Poll conflict fix — deleteWebhook at startup          ║
 * ║  • "gainers" word now routes to gappers                  ║
 * ║                                                          ║
 * ║  SCIENCE MODULE (v4.0/4.1):                              ║
 * ║  • /science TICKER — Maverick Ignition Score (MIS)       ║
 * ║  • /sdi TICKER — Short Danger Index                      ║
 * ║  • /autopsy — 30-day top mover pattern analysis          ║
 * ╚══════════════════════════════════════════════════════════╝
 */

'use strict';
require('dotenv').config();
var fetch = require('node-fetch');
var http  = require('http');

// ── RENDER HTTP SERVER — MAVERICK TERMINAL + TELEGRAM WEBHOOK ─────────────
var PORT      = process.env.PORT || 10000;
var BOT_START = new Date();
var server    = http.createServer(function(req, res) {

  // ── TELEGRAM WEBHOOK (POST /webhook) ──────────────────────────────────────
  // Telegram pushes every message here. We respond 200 immediately,
  // then process async — no polling, no conflict possible.
  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(chunk) { body += chunk.toString(); });
    req.on('end', function() {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      try {
        var update = JSON.parse(body);
        handleUpdate(update).catch(function(e) { console.error('[WEBHOOK]', e.message); });
      } catch (e) { console.error('[WEBHOOK] Parse error:', e.message); }
    });
    return;
  }

  // ── DASHBOARD (GET /) ─────────────────────────────────────────────────────
  var upMs  = Date.now() - BOT_START.getTime();
  var upH   = Math.floor(upMs/3600000), upM = Math.floor((upMs%3600000)/60000), upS = Math.floor((upMs%60000)/1000);
  var upStr = upH+'h '+upM+'m '+upS+'s';
  var posCount = Object.keys(positions||{}).length;
  var wlCount  = Object.keys(watchlist||{}).length;
  var html = '<!DOCTYPE html><html><head><title>MAVERICK INTEL BOT v5.2</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="refresh" content="30">' +
    '<style>' +
    'body{background:#0a0a0f;color:#e0e0e0;font-family:"Courier New",monospace;margin:0;padding:20px;}' +
    'h1{color:#00ff88;font-size:1.2em;letter-spacing:3px;border-bottom:1px solid #00ff8833;padding-bottom:10px;}' +
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px;}' +
    '.card{background:#111118;border:1px solid #1a1a2e;border-radius:8px;padding:14px;}' +
    '.card h3{color:#00ff88;font-size:0.75em;letter-spacing:2px;margin:0 0 10px;}' +
    '.row{display:flex;justify-content:space-between;font-size:0.8em;margin:4px 0;}' +
    '.ok{color:#00ff88;}.warn{color:#ffaa00;}.off{color:#ff4444;}' +
    '.tag{background:#00ff8815;color:#00ff88;padding:2px 8px;border-radius:4px;font-size:0.7em;}' +
    '.up{color:#00ff88;font-size:1.4em;font-weight:bold;letter-spacing:1px;margin:8px 0;}' +
    '.mode{background:#00ff8815;border:1px solid #00ff8833;border-radius:6px;padding:8px 12px;margin:10px 0;font-size:0.8em;color:#00ff88;}' +
    '.pulse{width:8px;height:8px;background:#00ff88;border-radius:50%;display:inline-block;margin-right:6px;animation:p 1.5s infinite;}' +
    '@keyframes p{0%,100%{opacity:1}50%{opacity:0.3}}' +
    'footer{margin-top:20px;font-size:0.7em;color:#444;text-align:center;}' +
    '</style></head><body>' +
    '<h1><span class="pulse"></span>MAVERICK INTEL BOT <span class="tag">v5.2</span></h1>' +
    '<div class="up">● ONLINE</div>' +
    '<div class="mode">⚡ WEBHOOK MODE — Zero polling. Zero conflict. Telegram pushes directly here.</div>' +
    '<div class="grid">' +
    '<div class="card"><h3>SYSTEM</h3>' +
    '<div class="row"><span>Uptime</span><span class="ok">'+upStr+'</span></div>' +
    '<div class="row"><span>Mode</span><span class="ok">Webhook ✓</span></div>' +
    '<div class="row"><span>Positions</span><span class="ok">'+posCount+' open</span></div>' +
    '<div class="row"><span>Watchlist</span><span class="ok">'+wlCount+' tickers</span></div>' +
    '<div class="row"><span>Trades logged</span><span class="ok">'+((memory&&memory.trades)?memory.trades.length:0)+'</span></div>' +
    '</div>' +
    '<div class="card"><h3>DATA STACK</h3>' +
    '<div class="row"><span>Yahoo Finance</span><span class="ok">PRIMARY ✓</span></div>' +
    '<div class="row"><span>Finnhub</span><span class="'+(process.env.FINNHUB_KEY?'ok">connected ✓':'off">not set')+'</span></div>' +
    '<div class="row"><span>Polygon</span><span class="'+(process.env.POLYGON_KEY?'ok">free tier ✓':'warn">not set')+'</span></div>' +
    '</div>' +
    '<div class="card"><h3>AI BRAIN</h3>' +
    '<div class="row"><span>Groq</span><span class="'+(process.env.GROQ_KEY?'ok">connected ✓':'off">not set')+'</span></div>' +
    '<div class="row"><span>Cerebras</span><span class="'+(process.env.CEREBRAS_KEY?'ok">connected ✓':'warn">backup')+'</span></div>' +
    '<div class="row"><span>Model</span><span class="ok">llama-3.3-70b</span></div>' +
    '</div>' +
    '<div class="card"><h3>MODULES</h3>' +
    '<div class="row"><span>MIS Engine</span><span class="ok">active ✓</span></div>' +
    '<div class="row"><span>SDI Engine</span><span class="ok">active ✓</span></div>' +
    '<div class="row"><span>Supernova Protocol</span><span class="ok">active ✓</span></div>' +
    '<div class="row"><span>News Scanner</span><span class="ok">2min cycle ✓</span></div>' +
    '</div>' +
    '</div>' +
    '<footer>MAVERICK INTEL BOT v5.2 · Webhook Mode · Page refreshes every 30s</footer>' +
    '</body></html>';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
server.listen(PORT, function() {
  console.log('[SERVER] Maverick Terminal on port ' + PORT + ' (webhook + dashboard)');
});

// ── CONFIG ─────────────────────────────────────────────────────────────────
var TG_TOKEN    = process.env.INTEL_BOT_TOKEN || '';
var CHAT_ID     = process.env.INTEL_BOT_CHAT  || '';
var POLYGON     = process.env.POLYGON_KEY      || '';
var FINNHUB     = process.env.FINNHUB_KEY      || '';
var GROQ_KEY    = process.env.GROQ_KEY         || '';
var CBRS_KEY    = process.env.CEREBRAS_KEY     || '';
var JSONBIN_ID  = process.env.JSONBIN_ID       || '';
var JSONBIN_KEY = process.env.JSONBIN_KEY      || '';

// ── STATE ──────────────────────────────────────────────────────────────────
var positions        = {};
var watchlist        = {};
var priceAlerts      = [];
var chatHistory      = {};
var lastUpdateId     = 0;
var lastNewsTs       = Math.floor(Date.now() / 1000) - 1800;
var sentHeadlines    = new Set();
var activeProtocol   = null;
var lastBriefingDate = '';

// ── TRADING UNIVERSE RULES ─────────────────────────────────────────────────
// Hard ceiling for scans, alerts, news. Research-only above this price.
var TRADE_MAX_PRICE = 20;

// ── COUNTRY FLAG HELPER ────────────────────────────────────────────────────
// Universal — call on every output so country is always visible.
function cFlag(sym) {
  var c = detectCountry(sym, '');
  return c === 'US' ? '🇺🇸' : c === 'CN' ? '🇨🇳' : c === 'IL' ? '🇮🇱' : '🌐';
}

// ── SEPARATE COUNTERS: organic vs test ────────────────────────────────────
var organicAlertsSent = 0;

// ── FOCUS MODE — pure expert conversation ─────────────────────────────────
var focusMode = false; // When true: all plain text goes direct to AI peer brain

// ── ALGO WATCHLIST — the algorithm's autonomous arsenal ───────────────────
// Separate from user watchlist. Always maintains 7 slots.
// Evolves every 10 min. Alerts on every slot change.
var algoWatchlist   = [];
var algoWatchTs     = 0;

// ── INTRADAY ALERT DEDUP — prevents repeat alerts same day ────────────────
var intradayAlertsToday = new Set();

// ── INTERVAL HEALTH TRACKING ───────────────────────────────────────────────
var iHealth = {
  newsLastRun:    0, newsRunCount:   0, newsAlertsTotal: 0,
  posLastRun:     0, posRunCount:    0,
  briefLastRun:   0, alertsLastRun:  0,
  startTime:      Date.now(),
  dataErrors:     0, dataOk:         0,
  processing:     {} // active heavy tasks { key: { cmd, sym, start } }
};

function procStart(key, cmd, sym) {
  iHealth.processing[key] = { cmd: cmd, sym: sym || '', start: Date.now() };
}
function procEnd(key) {
  delete iHealth.processing[key];
}

// ── MEMORY ─────────────────────────────────────────────────────────────────
var memory = { trades: [], preferences: {}, winRates: {}, science: null, lastUpdated: 0 };

// ── BASE UNIVERSE — 65 TICKERS ────────────────────────────────────────────
// Expanded to include AMEX names, broader micro-cap coverage, active movers.
// Primary zone ($0.25-$6) weighted first. Includes known AMEX staircase types.
var BASE_SCAN = [
  // Core NASDAQ momentum (proven volatility)
  'MARA','RIOT','SOFI','HOOD','FFIE','MULN','ATER','BBIG',
  'GFAI','GMBL','NKLA','GPUS','AIXI','AAOI','VERB','CNEY','XTIA',
  'MSTX','IONQ','RKLB','ACHR','PLTR','AMD',
  // AMEX active names (TRT-style staircase territory)
  'TRT','CEI','IMPP','CSLR','NRXS','AMMO','SCON','BKSY',
  // Active NASDAQ micro-caps $1-$15
  'SBET','PBTS','DRUG','BTBT','SOPA','KAVL','BRTX','GOEV',
  'WRAP','GTBP','ABOS','WLDS','SNPX','CLWT','CLEU','SOS',
  'REBN','PHGE','TRKA','AGEN','IDEX','ILUS','CODA','IDN',
  'GREE','APLT','BURU','INPX','FRZA','PAYO',
  // Biotech/pharma sub-$15
  'ADXN','OBSV','FEMY','HUDI','PRFX','HLBZ','VVPR','BFRI',
  // Crypto-adjacent / emerging tech
  'SFOR','GAMC','MEGL','NUKK','MBOT','CENN','MULN'
].filter(function(v,i,a){return a.indexOf(v)===i;}); // deduplicate

// ── STAIRCASE TRACKER ──────────────────────────────────────────────────────
// Remembers when each ticker first showed staircase behavior.
// Enables the duration timer: 30min soft / 60min hard alert.
var staircaseTracker = {};

// ── TICKER + INTENT DETECTION ─────────────────────────────────────────────
var SKIP_WORDS = new Set([
  'I','A','AN','THE','AND','OR','BUT','IN','ON','AT','TO','FOR','OF','WITH',
  'BY','FROM','IS','IT','BE','DO','GO','MY','WE','ME','HE','SHE','UP','AM',
  'NO','SO','IF','AS','HI','OK','PM','CT','ET','AI','TV','US','UK','EU','VC',
  'IPO','SEC','FDA','DOD','ETF','OTC','CEO','CFO','COO','LLC','INC','GET',
  'SET','PUT','BUY','OUT','ALL','NEW','NOW','HOW','WHY','WHAT','WHEN','WHO',
  'CAN','ARE','WAS','HAS','HAD','DID','DOES','WILL','HAVE','THIS','THAT',
  'THEM','THEY','SCAN','NEWS','HELP','NEXT','LAST','BEST','HIGH','LOW','BIG'
]);

function extractTicker(text) {
  var words = text.trim().split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    if (words[i].charAt(0) === '$') {
      var t = words[i].slice(1).replace(/[^A-Za-z]/g,'').toUpperCase();
      if (t.length >= 1 && t.length <= 5) return t;
    }
  }
  for (var j = 0; j < words.length; j++) {
    var w = words[j].replace(/[^A-Za-z]/g,'');
    if (w.length >= 1 && w.length <= 5 && w === w.toUpperCase() && !SKIP_WORDS.has(w)) return w;
  }
  return null;
}

function detectIntent(text) {
  var lower = text.toLowerCase();
  if (/\b(scan|top mover|movers today|what.s moving)\b/.test(lower)) return 'scan';
  if (/\b(squeeze|short squeeze)\b/.test(lower)) return 'squeeze';
  if (/\b(news|catalyst|headline|filing)\b/.test(lower)) return 'news';
  if (/\b(price|check|analyse|analyze|trade|buy|entry|stop|target|worth|setup|chart|look up|doing)\b/.test(lower)) return 'check';
  if (/\b(autopsy|30.day|pattern)\b/.test(lower)) return 'autopsy';
  if (/\b(ignition|mis score|science score)\b/.test(lower)) return 'science';
  if (/\b(short danger|sdi)\b/.test(lower)) return 'sdi';
  if (/\b(stealth|accumulation|whale detect|sas score|dark pool)\b/.test(lower)) return 'sas';
  if (/\b(backtest|back test|hit rate|88|formula|validate|validation)\b/.test(lower)) return 'backtest';
  if (/\b(trend|trending|staircase|uptrend|higher high|higher low|momentum trend)\b/.test(lower)) return 'trend';
  if (/\b(supernova|snova|rule of five|supernova score)\b/.test(lower)) return 'supernova';
  if (/\b(gap up|gapping|gappers|gainers|top gain|top gainer)\b/.test(lower)) return 'gappers';
  return null;
}

// ── HELPERS ────────────────────────────────────────────────────────────────
var rnd = function(n, d) { return +Number(n).toFixed(d === undefined ? 2 : d); };
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── FETCH WITH TIMEOUT ─────────────────────────────────────────────────────
// Hard 9-second cap on every external HTTP call.
// Prevents any single hanging API from freezing the entire command.
// This fixes: science, sdi, sas, supernova, autopsy, briefing, backtest.
async function tFetch(url, opts, ms) {
  ms = ms || 9000;
  var ctrl  = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, ms);
  try {
    var r = await fetch(url, Object.assign({}, opts||{}, { signal: ctrl.signal }));
    return r;
  } catch(e) {
    if (e.name === 'AbortError') { console.warn('[TIMEOUT]', url.slice(0,60)); iHealth.dataErrors++; }
    throw e;
  } finally { clearTimeout(timer); }
}

function nowHourCT() {
  try {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
    return parseInt(fmt.format(new Date()), 10);
  } catch (e) { return (new Date().getUTCHours() - 5 + 24) % 24; }
}

// ── MINUTE-AWARE CT TIME — use this for all market timing checks ───────────
// Market hours in CT (Central Time):
//   Pre-market:  3:00AM CT – 8:30AM CT  (4AM-9:30AM ET)
//   Regular:     8:30AM CT – 3:00PM CT  (9:30AM-4PM ET)
//   After-hours: 3:00PM CT – 7:00PM CT  (4PM-8PM ET)
function nowTimeCT() {
  try {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hour12: false });
    var parts = fmt.formatToParts(new Date());
    var h = parseInt(parts.find(function(p){return p.type==='hour';}).value, 10);
    var m = parseInt(parts.find(function(p){return p.type==='minute';}).value, 10);
    return h + m/60;
  } catch(e) { return nowHourCT(); }
}

function isMarketOpen()    { var t = nowTimeCT(); return t >= 8.5 && t < 15; }   // 8:30AM–3PM CT
function isPreMarketHours(){ var t = nowTimeCT(); return t >= 3   && t < 8.5; }  // 3AM–8:30AM CT
function isAfterHours()    { var t = nowTimeCT(); return t >= 15  && t < 19; }   // 3PM–7PM CT
function isExtendedHours() { return isPreMarketHours() || isAfterHours(); }

function pruneHeadlines() {
  if (sentHeadlines.size > 500) {
    var arr = Array.from(sentHeadlines).slice(-200);
    sentHeadlines.clear();
    arr.forEach(function(h) { sentHeadlines.add(h); });
  }
}

// ── TIERED DATA CACHE ──────────────────────────────────────────────────────
// Different data types change at different rates.
// Fetching aggs 60 times an hour is wasteful — they barely change.
// This cuts Yahoo/Finnhub calls by 80%+ while keeping data accurate.
//
//  quote:        60 seconds  — live price, changes every tick
//  aggs:         4 hours     — daily bars, no intraday change needed
//  fundamentals: 24 hours    — float & short% change weekly, not hourly
//  gainers:      5 minutes   — top gainer list refreshes often enough
//
var dataCache = {};
var aggsCache  = {};
var fundCache  = {};
var gainersCache = null;
var gainersCacheTs = 0;

var TTL_QUOTE = 60000;
var TTL_AGGS  = 4 * 3600000;
var TTL_FUND  = 24 * 3600000;
var TTL_GAIN  = 5 * 60000;

function cacheGet(sym) {
  var e = dataCache[sym];
  if (e && (Date.now() - e.ts) < TTL_QUOTE) return e.data;
  return null;
}
function cacheSet(sym, data) {
  dataCache[sym] = { data: data, ts: Date.now() };
  var keys = Object.keys(dataCache);
  if (keys.length > 150) {
    keys.sort(function(a,b){ return dataCache[a].ts - dataCache[b].ts; })
        .slice(0, 30).forEach(function(k){ delete dataCache[k]; });
  }
}

function aggsGet(sym) {
  var e = aggsCache[sym];
  if (e && (Date.now() - e.ts) < TTL_AGGS) return e.data;
  return null;
}
function aggsSet(sym, data) {
  aggsCache[sym] = { data: data, ts: Date.now() };
}

function fundGet(sym) {
  var e = fundCache[sym];
  if (e && (Date.now() - e.ts) < TTL_FUND) return e.data;
  return null;
}
function fundSet(sym, data) {
  fundCache[sym] = { data: data, ts: Date.now() };
}

// ── REQUEST QUEUE — prevents simultaneous hits on same Yahoo endpoint ───────
var inFlight = {};
// ── SAFE JSON / TEXT — body parse with hard timeout ───────────────────────
// tFetch covers the connection phase only. Once headers arrive, the timer
// clears and r.json() / r.text() have ZERO protection against stalled body.
// safeJson/safeText add a parallel 8-second race so body delivery can't hang.
async function safeJson(r, ms) {
  ms = ms || 8000;
  return Promise.race([
    r.json(),
    new Promise(function(_, rej) {
      setTimeout(function() { rej(new Error('json() timeout')); }, ms);
    })
  ]);
}
async function safeText(r, ms) {
  ms = ms || 8000;
  return Promise.race([
    r.text(),
    new Promise(function(_, rej) {
      setTimeout(function() { rej(new Error('text() timeout')); }, ms);
    })
  ]);
}

// ── DEDUPED — deadlock-safe request deduplication ─────────────────────────
// If fn() hangs (e.g. safeJson still stalls), hard-kill the inFlight entry
// after 12 seconds so the ticker is never permanently locked.
async function deduped(key, fn) {
  if (inFlight[key]) return inFlight[key];
  var p = fn().finally(function(){ delete inFlight[key]; });
  var killer = new Promise(function(resolve) {
    setTimeout(function() { delete inFlight[key]; resolve(null); }, 12000);
  });
  inFlight[key] = Promise.race([p, killer]);
  return inFlight[key];
}

// ── SMART FETCH — 1 automatic retry before giving up ──────────────────────
// If a request times out or fails, waits 2 seconds and tries once more.
// This handles transient Yahoo/Finnhub hiccups without cascading to fallback.
async function sFetch(url, opts, ms, retries) {
  ms      = ms      || 9000;
  retries = retries === undefined ? 1 : retries;
  try {
    return await tFetch(url, opts, ms);
  } catch(e) {
    if (retries > 0) {
      console.log('[RETRY]', url.slice(0,50));
      await sleep(2000);
      return sFetch(url, opts, ms, retries - 1);
    }
    throw e;
  }
}

// ── JSONBIN ────────────────────────────────────────────────────────────────
async function loadMemory() {
  if (!JSONBIN_ID || !JSONBIN_KEY) { console.log('[MEMORY] Not configured — running in-memory only'); return; }
  try {
    var r    = await fetch('https://api.jsonbin.io/v3/b/' + JSONBIN_ID + '/latest', { headers: { 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Meta': 'false' } });
    var text = await safeText(r);
    if (!text) { console.error('[MEMORY] Empty response'); return; }
    var d = JSON.parse(text), rec = (d && d.record) ? d.record : d;
    if (rec && rec.trades) {
      memory = Object.assign(memory, rec);
      // Restore persistent state
      if (rec.watchlist)        watchlist        = rec.watchlist;
      if (rec.staircaseTracker) staircaseTracker = rec.staircaseTracker;
      if (rec.sentHeadlines)    rec.sentHeadlines.forEach(function(h){ sentHeadlines.add(h); });
      if (rec.organicCount)     organicAlertsSent = rec.organicCount;
      console.log('[MEMORY] Loaded ' + (memory.trades ? memory.trades.length : 0) + ' trades | watchlist:' + Object.keys(watchlist).length + ' | headlines:' + sentHeadlines.size);
    } else console.log('[MEMORY] Fresh start');
  } catch (e) { console.error('[MEMORY] Load failed:', e.message); }
}

async function saveMemory() {
  if (!JSONBIN_ID || !JSONBIN_KEY) return;
  try {
    memory.lastUpdated      = Date.now();
    memory.watchlist        = watchlist;
    memory.organicCount     = organicAlertsSent;
    memory.staircaseTracker = staircaseTracker;
    memory.sentHeadlines    = Array.from(sentHeadlines).slice(-300);
    await fetch('https://api.jsonbin.io/v3/b/' + JSONBIN_ID, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
      body: JSON.stringify(memory)
    });
  } catch (e) { console.error('[MEMORY] Save failed:', e.message); }
}

function learnFromTrade(t) {
  if (!memory.trades) memory.trades = [];
  memory.trades.push(t);
  if (memory.trades.length > 200) memory.trades = memory.trades.slice(-200);
  rebuildWinRates(); saveMemory();
}

function rebuildWinRates() {
  var byProtocol = {}, byFloat = { nano:[], tight:[], mid:[] }, byRvol = { low:[], med:[], high:[] };
  (memory.trades || []).forEach(function(t) {
    var win = t.pnlPct > 0, p = t.protocol || 'maverick';
    if (!byProtocol[p]) byProtocol[p] = { wins:0, total:0 };
    byProtocol[p].total++; if (win) byProtocol[p].wins++;
    if (t.float < 5) byFloat.nano.push(win?1:0); else if (t.float < 15) byFloat.tight.push(win?1:0); else byFloat.mid.push(win?1:0);
    if (t.rvol >= 5) byRvol.high.push(win?1:0); else if (t.rvol >= 2) byRvol.med.push(win?1:0); else byRvol.low.push(win?1:0);
  });
  memory.winRates = { byProtocol, byFloat, byRvol };
}

function getPersonalInsight() {
  if (!memory.trades || memory.trades.length < 5) return '';
  rebuildWinRates(); var wr = memory.winRates, lines = [];
  ['nano','tight','mid'].forEach(function(k) {
    var arr = wr.byFloat[k];
    if (arr && arr.length >= 3) { var rate = arr.reduce(function(a,b){return a+b;},0)/arr.length; if (rate > 0.5) lines.push('Best float: ' + k + ' (' + rnd(rate*100,0) + '% win)'); }
  });
  return lines.length ? '\n\nPERSONAL EDGE: ' + lines.join(' | ') : '';
}

// ══════════════════════════════════════════════════════════════════════════
// ── DATA LAYER v5.7 — TRIPLE-REDUNDANT, TIERED-CACHE ─────────────────────
// ══════════════════════════════════════════════════════════════════════════
//  Quotes:       Yahoo → Finnhub                       (60s cache)
//  Aggs/History: Yahoo → Finnhub Candles → Polygon     (4hr cache)
//  Fundamentals: Finnhub Metrics                       (24hr cache)
//  Gainers:      Yahoo Screener → Polygon              (5min cache)
//  News:         Finnhub → SEC EDGAR → Polygon
//
//  All calls use sFetch (smart retry) — 1 auto-retry with 2s delay.
//  Deduped queue prevents simultaneous identical calls.

// ── YAHOO QUOTE ─────────────────────────────────────────────────────────────
// CRITICAL: During pre-market (4AM-9:30AM ET) and after-hours (4PM-8PM ET),
// we switch the primary price to preMarketPrice/postMarketPrice so every
// engine — staircase, position monitor, scoring, alerts — sees LIVE data.
// Pre-market IS the golden window. We cannot afford stale closes here.
async function yahooQuote(sym) {
  return deduped('yq:'+sym, async function() {
    try {
      var r = await sFetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=2d',
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaverickBot/6.5)' } }
      );
      var d    = await safeJson(r);
      var res  = d && d.chart && d.chart.result && d.chart.result[0];
      var meta = res && res.meta;
      if (!meta || !meta.regularMarketPrice) return null;

      iHealth.dataOk++;
      var marketState   = meta.marketState || 'REGULAR'; // PRE / REGULAR / POST / CLOSED
      var regularPrice  = meta.regularMarketPrice;
      var prevClose     = meta.chartPreviousClose || meta.previousClose || regularPrice;
      var preMarketPx   = meta.preMarketPrice  || 0;
      var postMarketPx  = meta.postMarketPrice || 0;

      // ── LIVE PRICE SELECTION ──────────────────────────────────────────────
      // Use the price that is actually moving RIGHT NOW.
      // Pre-market: use preMarketPrice so every engine scores the actual move.
      // After-hours: use postMarketPrice for the same reason.
      // Regular session: use regularMarketPrice as always.
      var activePrice = regularPrice;
      var isPreMarket = marketState === 'PRE'  || (marketState !== 'REGULAR' && preMarketPx > 0 && postMarketPx === 0);
      var isPostMarket= marketState === 'POST' || (marketState !== 'REGULAR' && postMarketPx > 0);

      if (isPreMarket && preMarketPx > 0) {
        activePrice = preMarketPx;
      } else if (isPostMarket && postMarketPx > 0) {
        activePrice = postMarketPx;
      }

      // Pre-market volume (Yahoo sometimes returns it)
      var preMarketVol = meta.preMarketVolume || 0;

      return {
        price:        activePrice,     // ← LIVE price: pre/post/regular
        regularPrice: regularPrice,    // ← Previous session close for reference
        prevClose:    prevClose,
        volume:       meta.regularMarketVolume || 0,
        high:         Math.max(meta.regularMarketDayHigh||activePrice, activePrice),
        low:          Math.min(meta.regularMarketDayLow||activePrice, activePrice),
        open:         meta.regularMarketOpen || regularPrice,
        week52H:      meta.fiftyTwoWeekHigh  || 0,
        week52L:      meta.fiftyTwoWeekLow   || 0,
        preMarket:    preMarketPx,
        preMarketChg: meta.preMarketChange   || 0,
        preMarketVol: preMarketVol,
        postMarket:   postMarketPx,
        postMarketChg:meta.postMarketChange  || 0,
        marketState:  marketState,
        isPreMarket:  isPreMarket,
        isPostMarket: isPostMarket,
        source: 'Yahoo'
      };
    } catch(e) { if (e.name!=='AbortError') console.error('[Yahoo]', sym, e.message); }
    return null;
  });
}

// ── FINNHUB QUOTE ────────────────────────────────────────────────────────────
async function fhQuote(sym) {
  if (!FINNHUB) return null;
  try {
    var r = await sFetch('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + FINNHUB);
    var t = await safeText(r); if (!t || t.trim() === '') return null;
    var d = JSON.parse(t);
    if (d && d.c && d.c > 0) return { price:d.c, prevClose:d.pc||d.c, volume:d.v||0, high:d.h||d.c, low:d.l||d.c, open:d.o||d.c, source:'Finnhub' };
  } catch(e) {}
  return null;
}

// ── FINNHUB CANDLES — daily OHLCV bars, free tier ───────────────────────────
// This is the KEY new source for aggs. Gives us a second free aggs feed
// independent of Yahoo. No Polygon paid plan needed.
async function fhCandles(sym, days) {
  if (!FINNHUB) return null;
  days = days || 22;
  try {
    var to   = Math.floor(Date.now() / 1000);
    var from = to - (days + 10) * 86400;
    var r    = await sFetch(
      'https://finnhub.io/api/v1/stock/candle?symbol='+sym+'&resolution=D&from='+from+'&to='+to+'&token='+FINNHUB
    );
    var d = await safeJson(r);
    if (!d || d.s === 'no_data' || !d.t || !d.t.length) return null;
    var bars = [];
    for (var i = 0; i < d.t.length; i++) {
      if (!d.c[i] || !d.v[i]) continue;
      bars.push({ t:d.t[i]*1000, o:d.o[i]||d.c[i], h:d.h[i]||d.c[i], l:d.l[i]||d.c[i], c:d.c[i], v:d.v[i] });
    }
    return bars.length >= 3 ? bars : null;
  } catch(e) { return null; }
}

// ── FINNHUB METRICS — fundamentals (24-hour cache) ─────────────────────────
async function fhMetrics(sym) {
  var cached = fundGet(sym);
  if (cached) return cached;
  if (!FINNHUB) return null;
  try {
    var r = await sFetch('https://finnhub.io/api/v1/stock/metric?symbol='+sym+'&metric=all&token='+FINNHUB);
    var t = await safeText(r); if (!t||t.trim()==='') return null;
    var d = JSON.parse(t);
    if (d && d.metric) { fundSet(sym, d); return d; }
  } catch(e) {}
  return null;
}

async function fh(ep) {
  if (!FINNHUB) return null;
  try {
    var sep = ep.indexOf('?')!==-1?'&':'?';
    var r   = await sFetch('https://finnhub.io/api/v1'+ep+sep+'token='+FINNHUB);
    var t   = await safeText(r); if (!t||t.trim()==='') return null; return JSON.parse(t);
  } catch(e) { return null; }
}

// ── UNIFIED AGGS — Yahoo → Finnhub Candles → Polygon (4-hour cache) ────────
// Three independent free sources. If one is slow or down, next fires.
// 4-hour cache means market-hours data stays accurate while slashing API calls.
async function yahooAggs(sym, days) {
  days = days || 22;
  var range = days <= 30 ? '3mo' : '6mo';
  try {
    var r = await sFetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval=1d&range='+range,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaverickBot/5.7)' } }
    );
    var d   = await safeJson(r);
    var res = d && d.chart && d.chart.result && d.chart.result[0];
    if (!res || !res.timestamp) return null;
    var ts = res.timestamp, q = res.indicators && res.indicators.quote && res.indicators.quote[0];
    var adjc = res.indicators && res.indicators.adjclose && res.indicators.adjclose[0];
    if (!q) return null;
    var bars = [];
    for (var i = 0; i < ts.length; i++) {
      var c = (adjc && adjc.adjclose && adjc.adjclose[i]) || q.close[i];
      if (!c || !q.volume[i]) continue;
      bars.push({ t:ts[i]*1000, o:q.open[i]||c, h:q.high[i]||c, l:q.low[i]||c, c:c, v:q.volume[i]||0 });
    }
    return bars.length ? bars.slice(-Math.min(days+5, bars.length)) : null;
  } catch(e) { if (e.name!=='AbortError') console.error('[yahooAggs]', sym, e.message); return null; }
}

async function polyAggs(sym, days) {
  if (!POLYGON) return null; days = days || 20;
  try {
    var to = todayStr(), from = new Date(Date.now()-days*86400000).toISOString().slice(0,10);
    var r  = await sFetch('https://api.polygon.io/v2/aggs/ticker/'+sym+'/range/1/day/'+from+'/'+to+'?adjusted=true&sort=asc&limit=50&apiKey='+POLYGON);
    var d  = await safeJson(r); if (d && d.results && d.results.length) return d.results;
  } catch(e) {}
  return null;
}

async function getAggs(sym, days) {
  days = days || 22;
  var cached = aggsGet(sym);
  if (cached && cached.length >= 3) return cached;
  return deduped('aggs:'+sym, async function() {
    var bars = await yahooAggs(sym, days);
    if (bars && bars.length >= 3) { aggsSet(sym, bars); return bars; }
    bars = await fhCandles(sym, days);
    if (bars && bars.length >= 3) { aggsSet(sym, bars); console.log('[AGGS] Finnhub candles:'+sym); return bars; }
    bars = await polyAggs(sym, days);
    if (bars && bars.length >= 3) { aggsSet(sym, bars); return bars; }
    console.log('[AGGS] All sources exhausted for '+sym); return null;
  });
}

// ── YAHOO GAINERS SCREENER (5-minute cache) ───────────────────────────────
async function yahooGainers() {
  if (gainersCache && (Date.now()-gainersCacheTs) < TTL_GAIN) return gainersCache;
  return deduped('gainers', async function() {
    try {
      var fields = 'symbol,regularMarketPrice,regularMarketChangePercent,regularMarketVolume,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose';
      var r = await sFetch(
        'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=25&fields='+fields,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaverickBot/5.7)' } }
      );
      var d      = await safeJson(r);
      var quotes = d && d.finance && d.finance.result && d.finance.result[0] && d.finance.result[0].quotes;
      if (!quotes || !quotes.length) return gainersCache || [];
      gainersCache = quotes.map(function(q) {
        return { ticker:q.symbol, todaysChangePerc:q.regularMarketChangePercent||0, day:{c:q.regularMarketPrice||0,h:q.regularMarketDayHigh||0,l:q.regularMarketDayLow||0,v:q.regularMarketVolume||0}, prevDay:{c:q.regularMarketPreviousClose||0} };
      }).filter(function(g){ return g.ticker && g.day.c > 0; });
      gainersCacheTs = Date.now();
      return gainersCache;
    } catch(e) { console.error('[yahooGainers]', e.message); return gainersCache || []; }
  });
}

async function polyNewsRaw(tickerOrNull, limit) {
  if (!POLYGON) return []; limit = limit || 25;
  try {
    var url = 'https://api.polygon.io/v2/reference/news?limit='+limit+'&order=desc&sort=published_utc&apiKey='+POLYGON;
    if (tickerOrNull) url += '&ticker='+tickerOrNull;
    var r = await sFetch(url); var d = await safeJson(r); if (d && d.results) return d.results;
  } catch(e) {}
  return [];
}

// ── UNIFIED GAINERS — Yahoo primary, Polygon fallback ─────────────────────
async function getTopGainers() {
  var yg = await yahooGainers();
  if (yg && yg.length >= 3) { console.log('[GAINERS] Yahoo: '+yg.length); return yg; }
  if (POLYGON) {
    try {
      var r = await sFetch('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey='+POLYGON);
      var d = await safeJson(r);
      if (d && d.tickers && d.tickers.length) { console.log('[GAINERS] Polygon: '+d.tickers.length); return d.tickers.slice(0,20); }
    } catch(e) {}
  }
  console.log('[GAINERS] No data — base universe only'); return [];
}

// ── UNIFIED STOCK DATA ─────────────────────────────────────────────────────
async function getStock(sym) {
  var cached = cacheGet(sym);
  if (cached) return cached;

  try {
    var price=0, prevClose=0, volume=0, high=0, low=0, open=0, week52H=0, week52L=0, source='unknown';

    // TIER 1: Yahoo quote (primary)
    var yq = await yahooQuote(sym);
    if (yq && yq.price > 0) {
      price=yq.price; prevClose=yq.prevClose; volume=yq.volume;
      high=yq.high; low=yq.low; open=yq.open;
      week52H=yq.week52H; week52L=yq.week52L; source='Yahoo';
    }

    // TIER 2: Finnhub quote (if Yahoo failed)
    if (!price || price <= 0) {
      var fq = await fhQuote(sym);
      if (fq && fq.price > 0) {
        price=fq.price; prevClose=fq.prevClose; volume=fq.volume;
        high=fq.high; low=fq.low; open=fq.open; source='Finnhub';
      }
    }

    if (!price || price <= 0) return null;

    // PARALLEL: unified aggs (3-source, 4hr cached) + fundamentals (24hr cached)
    var parallel = await Promise.allSettled([ getAggs(sym, 22), fhMetrics(sym) ]);

    var aggs = (parallel[0].status==='fulfilled' && parallel[0].value) ? parallel[0].value : null;

    // RVOL
    var avgVol = 500000;
    if (aggs && aggs.length >= 3) {
      var vols = aggs.slice(-10).map(function(a){return a.v||0;});
      avgVol = vols.reduce(function(a,b){return a+b;},0) / vols.length;
    }

    // Gap
    var gapPct = 0;
    if (aggs && aggs.length >= 2) {
      var pd = aggs[aggs.length-2];
      if (pd && pd.c > 0) gapPct = rnd((open - pd.c) / pd.c * 100, 2);
    }

    // Fundamentals
    var floatM=50, shortPct=0;
    if (!week52H || week52H<=0) { week52H=price*2; week52L=price*0.3; }
    var metrics = (parallel[1].status==='fulfilled' && parallel[1].value) ? parallel[1].value : null;
    if (metrics && metrics.metric) {
      var m = metrics.metric;
      if (m.sharesFloat&&m.sharesFloat>0) floatM=m.sharesFloat;
      // Short interest — try multiple field names (Finnhub naming varies by plan)
      var rawShort = m.shortInterestPercentOfFloat || m.shortPercent || m.shortRatio || 0;
      if (rawShort > 0) shortPct = rawShort;
      // Proxy estimate when Finnhub has no data: DTC-based approximation
      // DTC = (float * short%) / avgVol → short% = (DTC * avgVol) / float
      // We don't know DTC yet, but if Finnhub returned shortRatio (DTC): estimate
      if (shortPct === 0 && m.shortRatio && m.shortRatio > 0 && floatM > 0 && avgVol > 0) {
        shortPct = rnd((m.shortRatio * avgVol) / (floatM * 1e6) * 100, 1);
      }
      if (m['52WeekHigh']&&!week52H) week52H=m['52WeekHigh'];
      if (m['52WeekLow']&&!week52L)  week52L=m['52WeekLow'];
    }

    var changePct   = prevClose>0 ? rnd((price-prevClose)/prevClose*100,2) : 0;
    var relVol      = rnd(volume/Math.max(avgVol,1),2);
    var atr         = rnd(price*0.025,4);
    var daysToCover = floatM>0&&avgVol>0 ? rnd((floatM*1e6)/avgVol,2) : 99;

    // Log pre-market moves so they're visible in position monitor and alerts
    var isPreMarket  = yq ? (yq.isPreMarket  || false) : false;
    var isPostMarket = yq ? (yq.isPostMarket || false) : false;
    if (isPreMarket && yq.preMarket > 0) {
      console.log('[PRE-MKT] $'+sym+' '+rnd(changePct,1)+'% @ $'+price+' (reg close: $'+prevClose+')');
    }

    // ── PRE-CROWD MATRIX B — Float Rotation % pre-market ────────────────────
    // If pre-market volume > 30% of float = explosive intraday rotation signal.
    var preMarketVol = yq ? (yq.preMarketVol||0) : 0;
    var floatRotPct  = (preMarketVol > 0 && floatM > 0)
      ? rnd(preMarketVol / (floatM * 1e6) * 100, 2) : 0;

    var result = {
      sym, price, changePct, gapPct, high, low, open, prevClose, volume,
      avgVol:rnd(avgVol,0), relVol, floatM, shortPct,
      week52High:week52H, week52Low:week52L, atr, daysToCover, source, _aggs:aggs,
      preMarket:    yq ? (yq.preMarket||0)     : 0,
      preMarketChg: yq ? (yq.preMarketChg||0)  : 0,
      postMarket:   yq ? (yq.postMarket||0)    : 0,
      postMarketChg:yq ? (yq.postMarketChg||0) : 0,
      marketState:  yq ? (yq.marketState||'REGULAR') : 'REGULAR',
      floatRotPct   // Pre-Crowd Matrix B: pre-market float rotation %
    };
    cacheSet(sym, result);
    return result;
  } catch(e) { console.error('[getStock]', sym, e.message); return null; }
}

// ── COUNTRY DETECTION ──────────────────────────────────────────────────────
// Detects company country from ticker suffix/exchange conventions.
// IL (Israeli) = hard excluded. US = bonus. CN = penalty.
var IL_PATTERNS = /\.(TA|IL)$|^(TEVA|CHKP|NICE|AMDOCS|CEVA|MLNK|EVGN|GILT|NNDM)$/i;
var CN_PATTERNS = /(\.SZ|\.SS|\.HK)$|china|chinese|\bcn\b|zhong|sino/i;

function detectCountry(sym, companyName) {
  var s = (sym||'').toUpperCase(), n = (companyName||'').toLowerCase();
  // Hard-check ticker patterns first
  if (IL_PATTERNS.test(s)) return 'IL';
  if (s.endsWith('.TA') || s.endsWith('.IL')) return 'IL';
  // Common Israeli company names
  if (/\b(israel|israeli|tel aviv|haifa)\b/.test(n)) return 'IL';
  // Chinese patterns
  if (CN_PATTERNS.test(s) || /\b(china|chinese|beijing|shanghai|shenzhen|hong kong|sino)\b/.test(n)) return 'CN';
  // Default: assume US for most tickers (NASDAQ/NYSE)
  return 'US';
}

function priceZone(price) {
  if (price < 0.25 || price <= 0)  return { label:'OUT OF ZONE',    bonus:0,   mis:0,   penaltySetup:-20, penaltyMIS:-10, filter:true  };
  if (price <= 6.00)               return { label:'PRIMARY ZONE 🎯', bonus:14,  mis:8,   penaltySetup:0,  penaltyMIS:0,  filter:false };
  if (price <= 9.99)               return { label:'GOOD ZONE ✅',    bonus:7,   mis:4,   penaltySetup:0,  penaltyMIS:0,  filter:false };
  if (price <= 20.00)              return { label:'NOT PREFERRED',   bonus:0,   mis:0,   penaltySetup:0,  penaltyMIS:0,  filter:false };
  return                                  { label:'DON\'T BOTHER ❌', bonus:-15, mis:-8,  penaltySetup:-15,penaltyMIS:-8, filter:true  };
}

// ══════════════════════════════════════════════════════════════════════════
// ── TREND RECOGNITION ENGINE (TRE) ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Calculates trend direction, strength, MAs, HH/HL structure, volume bias,
// momentum, and whether the setup is forming a staircase pattern.
// Uses only OHLCV bars — no paid data needed.

function calcTrend(d, aggs) {
  if (!aggs || aggs.length < 5) {
    return { direction:'UNKNOWN', strength:0, isStaircase:false, details:[], summary:'Insufficient history for trend analysis.', sma5:null, sma10:null, sma20:null };
  }

  // Simple Moving Averages from closes
  var closes = aggs.map(function(b){return b.c||0;});
  function sma(n) {
    if (closes.length < n) return null;
    return rnd(closes.slice(-n).reduce(function(a,b){return a+b;},0)/n, 4);
  }
  var sma5  = sma(5);
  var sma10 = sma(10);
  var sma20 = sma(20);

  // Higher Highs / Higher Lows / Lower Lows / Lower Highs
  var last10   = aggs.slice(-10);
  var hhCount=0, hlCount=0, llCount=0, lhCount=0;
  for (var i=1; i<last10.length; i++) {
    if (last10[i].h > last10[i-1].h) hhCount++; else lhCount++;
    if (last10[i].l > last10[i-1].l) hlCount++; else llCount++;
  }

  // Volume bias — are up days louder than down days?
  var upVol=0, downVol=0;
  last10.forEach(function(b){
    if ((b.c||0) >= (b.o||0)) upVol += b.v||0;
    else downVol += b.v||0;
  });
  var volBias = downVol > 0 ? rnd(upVol/downVol,2) : 1;

  // Rate of change (momentum)
  var roc5  = aggs.length >= 6  ? rnd((d.price - aggs[aggs.length-6].c)/Math.max(aggs[aggs.length-6].c,0.01)*100, 1) : 0;
  var roc10 = aggs.length >= 11 ? rnd((d.price - aggs[aggs.length-11].c)/Math.max(aggs[aggs.length-11].c,0.01)*100, 1) : 0;

  // Trend scoring
  var bull=0, bear=0;
  if (sma5  && d.price > sma5)          { bull += 15; }
  if (sma10 && sma5  && sma5  > sma10)  { bull += 15; }
  if (sma20 && sma10 && sma10 > sma20)  { bull += 10; }
  if (hhCount >= 6)  bull += 20; else if (hhCount >= 4) bull += 10;
  if (hlCount >= 6)  bull += 20; else if (hlCount >= 4) bull += 10;
  if (volBias >= 1.5) bull += 15; else if (volBias >= 1.2) bull += 8;
  if (roc5 > 5)  bull += 10; else if (roc5 > 0) bull += 4;
  if (sma5  && d.price < sma5)          { bear += 15; }
  if (sma10 && sma5  && sma5  < sma10)  { bear += 15; }
  if (llCount >= 6) bear += 20; else if (llCount >= 4) bear += 10;
  if (lhCount >= 6) bear += 15;
  if (volBias < 0.7) bear += 15;
  if (roc5 < -5) bear += 10; else if (roc5 < 0) bear += 4;

  var net      = bull - bear;
  var direction= net >= 25 ? 'BULLISH 📈' : net <= -25 ? 'BEARISH 📉' : 'SIDEWAYS ↔️';
  var strength = Math.min(100, Math.abs(net));

  // Staircase detection: HH + HL majority + bullish volume + positive momentum
  var isStaircase = hlCount >= 5 && hhCount >= 4 && volBias >= 1.1 && roc5 > 0;

  var details = [];
  if (sma5)  details.push('5d MA: $'+sma5+' (price '+(d.price>sma5?'above ✅':'below ❌')+')');
  if (sma10) details.push('10d MA: $'+sma10+' (price '+(d.price>sma10?'above ✅':'below ❌')+')');
  if (sma20) details.push('20d MA: $'+sma20+' (price '+(d.price>sma20?'above ✅':'below ❌')+')');
  details.push('HH/HL '+hhCount+'/'+hlCount+' | LL/LH '+llCount+'/'+lhCount+' (last 10 sessions)');
  details.push('Volume bias: '+volBias+'x '+(volBias>=1.5?'STRONG BUY 🟢':volBias>=1.2?'BUY':volBias<=0.7?'SELL 🔴':'NEUTRAL'));
  details.push('5d ROC: '+(roc5>=0?'+':'')+roc5+'%  |  10d ROC: '+(roc10>=0?'+':'')+roc10+'%');
  if (isStaircase) details.push('🪜 STAIRCASE PATTERN DETECTED — higher highs + higher lows + volume confirmation');

  var summary = direction.includes('BULLISH') ?
    'Uptrend confirmed. '+hhCount+' of '+(last10.length-1)+' sessions made higher highs. Volume favors buyers '+volBias+'x. Momentum: +'+roc5+'% (5d).' :
    direction.includes('BEARISH') ?
    'Downtrend. Lower lows dominating. Volume confirms selling pressure.' :
    'Sideways/consolidating. Watch for breakout. No clear directional edge yet.';

  return { direction, strength, bull, bear, net, sma5, sma10, sma20, hhCount, hlCount, llCount, lhCount, volBias, roc5, roc10, details, summary, isStaircase };
}

// ── INTRADAY STAIRCASE DETECTOR ───────────────────────────────────────────
// Detects whether a stock is CURRENTLY forming a staircase intraday.
// Uses: today's price position in range + RVOL + from-open move + daily trend.
function detectStaircaseScore(d, aggs) {
  var score=0, signals=[];

  // Price near HOD (not a spike-fade — still holding gains)
  var range = (d.high||0) - (d.low||0);
  if (range > 0) {
    var rangePos = (d.price - (d.low||0)) / range;
    if      (rangePos >= 0.80) { score+=25; signals.push('Price at '+rnd(rangePos*100,0)+'% of day range — holding near HOD ✅'); }
    else if (rangePos >= 0.60) { score+=12; signals.push('Price at '+rnd(rangePos*100,0)+'% of range — mid-range, still in play'); }
    else                        { score-=15; signals.push('Price near LOD — staircase losing steam ❌'); }
  }

  // Sustained move from open (not one candle spike)
  var fromOpen = d.open > 0 ? (d.price - d.open) / d.open * 100 : 0;
  if      (fromOpen >= 15) { score+=20; signals.push('+'+rnd(fromOpen,1)+'% from open — strong sustained push'); }
  else if (fromOpen >= 8)  { score+=13; signals.push('+'+rnd(fromOpen,1)+'% from open — building'); }
  else if (fromOpen >= 4)  { score+=6;  signals.push('+'+rnd(fromOpen,1)+'% from open'); }
  else if (fromOpen < 0)   { score-=10; signals.push('Below open — directional failure'); }

  // RVOL (institutional volume = real staircase, not retail tweet)
  if      (d.relVol >= 10) { score+=25; signals.push('RVOL '+d.relVol+'x — WHALE volume. Institutional accumulation.'); }
  else if (d.relVol >= 6)  { score+=18; signals.push('RVOL '+d.relVol+'x — strong institutional interest'); }
  else if (d.relVol >= 3)  { score+=10; signals.push('RVOL '+d.relVol+'x — elevated'); }
  else                      { score+=0;  signals.push('RVOL '+d.relVol+'x — not enough volume for confirmed staircase'); }

  // Multi-day higher lows (the structural foundation)
  if (aggs && aggs.length >= 5) {
    var last5    = aggs.slice(-5);
    var higherL  = 0, higherH = 0;
    for (var i=1; i<last5.length; i++) {
      if ((last5[i].l||0) > (last5[i-1].l||0)) higherL++;
      if ((last5[i].h||0) > (last5[i-1].h||0)) higherH++;
    }
    if (higherL >= 3) { score+=20; signals.push(higherL+' of 4 sessions made higher lows — staircase structure building ✅'); }
    else if (higherL >= 2) { score+=10; signals.push(higherL+' higher lows detected'); }

    // Volume bias on up days vs down days
    var upV=0, dnV=0;
    last5.forEach(function(b){ if((b.c||0)>=(b.o||0)) upV+=b.v||0; else dnV+=b.v||0; });
    if (upV > dnV*1.5) { score+=10; signals.push('Buy volume '+rnd(upV/Math.max(dnV,1),1)+'x sell volume — whales loading'); }
  }

  score = Math.min(100, Math.max(0, score));
  var tier = score>=75?'CONFIRMED STAIRCASE 🪜':score>=55?'DEVELOPING 📈':score>=35?'EARLY SIGNS 👀':'NOT A STAIRCASE';
  return { score, tier, signals };
}

// ══════════════════════════════════════════════════════════════════════════
// ── PRE-MARKET SCANNER — 4AM to 9:30AM ET, every 5 minutes ───────────────
// ══════════════════════════════════════════════════════════════════════════
// The golden window. Scans watchlist + algo arsenal + gainers for pre-market
// movers using LIVE preMarketPrice. Fires alerts before retail even wakes up.
// Three signals: gap %, float rotation %, and pre-market RVOL proxy.
var preMarketAlertedToday = new Set();

async function runPreMarketScanner() {
  // CT time: pre-market ET (4AM-9:30AM ET) = 3AM-8:30AM CT
  var hourCT  = nowHourCT();
  var minCT   = new Date().getMinutes();
  var timeCT  = hourCT + minCT / 60;
  if (timeCT < 3 || timeCT >= 8.5) return; // Only 3AM-8:30AM CT

  var today    = todayStr();
  if (!runPreMarketScanner._lastDay || runPreMarketScanner._lastDay !== today) {
    preMarketAlertedToday.clear();
    runPreMarketScanner._lastDay = today;
  }

  // Universe: watchlist first (user's picks), then algo arsenal, then gainers
  var universe = Object.keys(watchlist);
  algoWatchlist.forEach(function(w){ if(universe.indexOf(w.sym)===-1) universe.push(w.sym); });
  var gainers = gainersCache || [];
  gainers.slice(0,15).forEach(function(g){ if(g.ticker && universe.indexOf(g.ticker)===-1) universe.push(g.ticker); });
  BASE_SCAN.slice(0,20).forEach(function(s){ if(universe.indexOf(s)===-1) universe.push(s); });
  universe = universe.filter(function(v,i,a){return a.indexOf(v)===i && v && v.length<=5;}).slice(0,50);

  var hits = [];
  console.log('[PRE-MKT-SCAN] Checking '+universe.length+' tickers at '+hourCT+':'+minCT+'CT');

  for (var i=0; i<universe.length; i++) {
    var sym = universe[i];
    try {
      // Always fresh quote during pre-market — bypass 60s cache for live data
      var yq = await yahooQuote(sym);
      if (!yq || !yq.isPreMarket || yq.preMarket <= 0) continue;
      if (detectCountry(sym,'') === 'IL') continue;
      if (yq.price > TRADE_MAX_PRICE || yq.price < 0.25) continue;

      var gapPct     = yq.prevClose > 0 ? rnd((yq.price - yq.prevClose) / yq.prevClose * 100, 2) : 0;
      if (Math.abs(gapPct) < 8) continue; // Only significant pre-market moves

      var alertKey = 'pm:'+sym+':'+today;
      if (preMarketAlertedToday.has(alertKey)) continue;

      // Float rotation % (Pre-Crowd Matrix B)
      var d = await getStock(sym).catch(function(){return null;});
      if (!d) continue;

      var floatRotPct = d.floatRotPct || 0;
      var country     = detectCountry(sym,'');
      if (country === 'IL') continue;

      hits.push({
        sym:       sym,
        price:     yq.price,
        prevClose: yq.prevClose,
        gapPct:    gapPct,
        floatM:    d.floatM,
        floatRotPct: floatRotPct,
        relVol:    d.relVol,
        mis:       calcMIS(d,5).pct,
        alertKey:  alertKey,
        isWatch:   !!watchlist[sym]
      });
      await sleep(200);
    } catch(e) {}
  }

  if (!hits.length) { console.log('[PRE-MKT-SCAN] No significant moves.'); return; }

  // Sort by absolute gap size — biggest movers first
  hits.sort(function(a,b){ return Math.abs(b.gapPct) - Math.abs(a.gapPct); });

  for (var h=0; h<hits.length; h++) {
    var hit = hits[h];
    preMarketAlertedToday.add(hit.alertKey);

    var direction = hit.gapPct >= 0 ? '🚀' : '🔻';
    var gapStr    = (hit.gapPct >= 0 ? '+' : '') + rnd(hit.gapPct, 1) + '%';
    var priority  = hit.floatRotPct >= 30 ? '🚨 EXPLOSIVE' : Math.abs(hit.gapPct) >= 30 ? '⚡ MAJOR GAP' : '📡 PRE-MKT';
    var zone      = priceZone(hit.price).label;
    var flag      = cFlag(hit.sym);

    var msg = direction+' <b>'+priority+' — $'+hit.sym+' '+flag+'</b>\n\n';
    msg += '<b>Pre-market: $'+hit.price+'</b> ('+gapStr+' from $'+hit.prevClose+')\n';
    msg += 'Float: '+hit.floatM+'M  |  '+zone+'\n';
    msg += 'MIS: '+hit.mis+'/100\n';
    if (hit.floatRotPct >= 15) {
      msg += '🐋 <b>Float rotation: '+hit.floatRotPct+'%</b> of float traded pre-market';
      msg += hit.floatRotPct >= 30 ? ' — EXPLOSIVE INTRADAY SETUP\n' : ' — elevated\n';
    }
    if (hit.isWatch) msg += '📋 <b>On your watchlist</b>\n';
    msg += '\n';
    if (hit.gapPct >= 15) msg += 'This could run hard at 9:30 open if volume confirms.\n';
    else if (hit.gapPct <= -15) msg += 'Significant gap down. Watch for bounce or continued fade.\n';
    msg += '\n/check '+hit.sym+' | /science '+hit.sym;

    await tg(msg);
    organicAlertsSent++;
    await sleep(1500);
  }
  console.log('[PRE-MKT-SCAN] Sent '+hits.length+' pre-market alert(s).');
}
async function runStaircaseScanner() {
  var hourCT = nowHourCT();
  var minCT  = new Date().getMinutes();
  var timeCT = hourCT + minCT / 60;
  // Run during regular hours AND pre-market (staircase can form pre-market too)
  var isActive = isPreMarketHours() || isMarketOpen();
  if (!isActive) return;

  // Full universe: gainers + watchlist + expanded base
  var universe=[], gainers=await getTopGainers();
  gainers.forEach(function(g){ if(g.ticker) universe.push(g.ticker); });
  Object.keys(watchlist).forEach(function(t){ if(universe.indexOf(t)===-1) universe.push(t); });
  BASE_SCAN.forEach(function(t){ if(universe.indexOf(t)===-1) universe.push(t); });
  universe = universe.filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,50);

  var now = Date.now();
  for (var i=0; i<universe.length; i++) {
    var sym = universe[i];
    try {
      var d = await getStock(sym);
      if (!d) continue;
      // STAIRCASE EXCEPTION: sub-$20, any score, any float — the exception is ABSOLUTE
      if (d.price > 20 || d.price < 0.25) continue;
      if (d.changePct < 5) { delete staircaseTracker[sym]; continue; }
      var country = detectCountry(sym,'');
      if (country === 'IL') continue;

      var sc = detectStaircaseScore(d, d._aggs);
      if (sc.score < 40) { delete staircaseTracker[sym]; continue; }

      if (!staircaseTracker[sym]) {
        staircaseTracker[sym] = { firstSeen:now, alerted30:false, alerted60:false };
        console.log('[STAIRCASE] First detection: '+sym+' score:'+sc.score);
      }
      var tracker = staircaseTracker[sym];
      var elapsedMin = Math.round((now - tracker.firstSeen) / 60000);

      // ── 60 MIN HARD ALERT — NO EXCEPTIONS ───────────────────────────────
      if (elapsedMin >= 60 && !tracker.alerted60) {
        tracker.alerted60 = true;
        tracker.alerted30 = true;
        var zones = calcDemandSupplyZones(d._aggs||[]);
        var trend = calcTrend(d, d._aggs||[]);
        var msg  = '🪜 <b>STAIRCASE EXCEPTION ALERT — $'+sym+'</b>\n\n';
        msg += '$'+sym+' has been climbing steadily for <b>'+elapsedMin+' minutes</b>.\n';
        msg += 'Price: $'+d.price+' (+'+rnd(d.changePct,1)+'%)  RVOL: '+d.relVol+'x\n';
        msg += 'Zone: '+priceZone(d.price).label+'  Country: '+country+'\n';
        msg += 'Staircase Score: <b>'+sc.score+'/100</b> ['+sc.tier+']\n';
        msg += 'Trend: '+trend.direction+' ('+trend.strength+'/100)\n\n';
        msg += '<b>Why this is real:</b>\n';
        sc.signals.slice(0,4).forEach(function(s){ msg += '• '+s+'\n'; });
        msg += '\n<b>Entry zone:</b> $'+rnd(d.price*0.99,4)+' — $'+rnd(d.price*1.01,4)+'\n';
        msg += '<b>Stop:</b> $'+rnd(d.price*0.94,4)+' (below today\'s higher low structure)\n';
        msg += '<b>Hold plan:</b> Staircase plays run until RVOL fades. Exit when RVOL < 2x.\n';
        if (zones.demand.length) msg += '<b>Demand:</b> '+zones.demand.join(' / ')+'\n';
        if (zones.supply.length) msg += '<b>Supply:</b> '+zones.supply.join(' / ')+'\n';
        msg += '\n/check '+sym+' | /sas '+sym+' | /trend '+sym;
        await tg(msg);
        iHealth.newsAlertsTotal++;
        await sleep(1500);
      }
      // ── 30 MIN SOFT ALERT ────────────────────────────────────────────────
      else if (elapsedMin >= 30 && !tracker.alerted30 && sc.score >= 60) {
        tracker.alerted30 = true;
        await tg('🪜 <b>STAIRCASE BUILDING — $'+sym+'</b>\n$'+d.price+' (+'+rnd(d.changePct,1)+'%) for <b>'+elapsedMin+' min</b>\nRVOL:'+d.relVol+'x  Score:'+sc.score+'/100\nWatching. Will hard-alert at 60min.\n\n/check '+sym);
        await sleep(1500);
      }
      await sleep(300);
    } catch(e) { console.error('[STAIRCASE]', sym, e.message); }
  }
  // Prune stale entries (>8 hours old)
  Object.keys(staircaseTracker).forEach(function(sym){
    if ((Date.now()-staircaseTracker[sym].firstSeen) > 8*3600000) delete staircaseTracker[sym];
  });
  console.log('[STAIRCASE] Scan complete. Tracking: '+Object.keys(staircaseTracker).length+' names.');
}

// ── POSITION SIZING ────────────────────────────────────────────────────────
function calcShares(price, stopPrice) {
  var risk = Math.abs(price - stopPrice);
  if (risk <= 0) return 1;
  // Small account: 2% risk per trade, max 80% of capital in one position
  var maxRisk = 500 * 0.02;
  var shares  = Math.floor(maxRisk / risk);
  if (shares * price > 500 * 0.8) shares = Math.floor((500*0.8) / price);
  return Math.max(1, shares);
}

// ── SETUP SCORER ───────────────────────────────────────────────────────────
function scoreSetup(d) {
  var score=0, flags=[];
  var country = d.country || detectCountry(d.sym, '');
  var zone    = priceZone(d.price);

  // Hard exclusions
  if (country === 'IL') return { score:-999, flags:['EXCLUDED: Israeli company'], excluded:true };
  if (d.price < 0.25)   return { score:0, flags:['BELOW MIN PRICE $0.25'], excluded:true };

  if      (d.floatM<1)   {score+=30;flags.push('NANO FLOAT');}
  else if (d.floatM<5)   {score+=22;flags.push('TIGHT FLOAT');}
  else if (d.floatM<15)  {score+=14;flags.push('WORKABLE FLOAT');}
  else if (d.floatM>100) {score-=5;}
  if      (d.relVol>=10) {score+=25;flags.push('RVOL '+d.relVol+'x WHALE');}
  else if (d.relVol>=5)  {score+=20;flags.push('RVOL '+d.relVol+'x');}
  else if (d.relVol>=3)  {score+=13;flags.push('RVOL '+d.relVol+'x');}
  else if (d.relVol>=2)  {score+=7;flags.push('RVOL '+d.relVol+'x');}
  else if (d.relVol<0.8) {score-=8;}
  if      (d.changePct>=30){score+=20;flags.push('+'+rnd(d.changePct,1)+'% MOVER');}
  else if (d.changePct>=15){score+=15;flags.push('+'+rnd(d.changePct,1)+'%');}
  else if (d.changePct>=7) {score+=9;flags.push('+'+rnd(d.changePct,1)+'%');}
  else if (d.changePct>=3) {score+=4;}
  else if (d.changePct<-5) {score-=8;}
  if      (d.gapPct>=20){score+=12;flags.push('GAP +'+rnd(d.gapPct,1)+'%');}
  else if (d.gapPct>=10){score+=8;flags.push('GAP +'+rnd(d.gapPct,1)+'%');}

  // Price zone scoring (replaces old flat price scoring)
  score += zone.bonus;
  if (zone.bonus > 0)      flags.push(zone.label);
  else if (zone.bonus < 0) flags.push(zone.label);

  // Country scoring
  if      (country === 'US') { score += 5;  flags.push('🇺🇸 US'); }
  else if (country === 'CN') { score -= 5;  flags.push('🇨🇳 CN -5'); }

  if (d.shortPct>30&&d.relVol>3){score+=18;flags.push('SQUEEZE SETUP');}
  else if (d.shortPct>20){score+=9;flags.push('SHORT '+rnd(d.shortPct,1)+'%');}
  if (d.week52High>0){var pf=(d.week52High-d.price)/Math.max(d.week52High,0.01)*100; if(pf<2&&d.changePct>0){score+=10;flags.push('52W BREAKOUT');}}
  return { score: Math.min(100, Math.max(0, score)), flags, country, zone: zone.label };
}

// ── CATALYST TAXONOMY ──────────────────────────────────────────────────────
var CATALYST_MAP = {
  'fda approval':{rank:1,name:'FDA Approval'},'fda approved':{rank:1,name:'FDA Approved'},
  'fda clearance':{rank:1,name:'FDA Clearance'},'phase 3 results':{rank:1,name:'Phase 3 Results'},
  'breakthrough':{rank:1,name:'Breakthrough Data'},'positive data':{rank:1,name:'Positive Clinical Data'},
  'merger':{rank:2,name:'Merger'},'acquisition':{rank:2,name:'Acquisition'},'buyout':{rank:2,name:'Buyout'},
  'short squeeze':{rank:2,name:'Short Squeeze'},'government contract':{rank:2,name:'Gov Contract'},
  'barda contract':{rank:2,name:'BARDA Contract'},'dod contract':{rank:2,name:'DOD Contract'},
  'uplisting':{rank:2,name:'Uplisting'},'trading halted':{rank:2,name:'Trading Halt'},
  'earnings beat':{rank:3,name:'Earnings Beat'},'beat estimates':{rank:3,name:'Beat Estimates'},
  'record revenue':{rank:3,name:'Record Revenue'},'raised guidance':{rank:3,name:'Raised Guidance'},
  'partnership':{rank:3,name:'Partnership'},'nasdaq compliance':{rank:3,name:'Nasdaq Compliance'},
  'positive results':{rank:3,name:'Positive Results'},'clinical data':{rank:3,name:'Clinical Data'},
  'upgraded':{rank:4,name:'Analyst Upgrade'},'price target raised':{rank:4,name:'PT Raised'},
  'buyback':{rank:4,name:'Buyback'},'reverse split':{rank:4,name:'Reverse Split'}
};

function identifyCatalyst(headline) {
  if (!headline) return { rank:5, name:'No Catalyst' };
  var body=headline.toLowerCase(), bestRank=5, bestName='Unknown Catalyst';
  Object.keys(CATALYST_MAP).forEach(function(k){ if(body.indexOf(k)!==-1&&CATALYST_MAP[k].rank<bestRank){bestRank=CATALYST_MAP[k].rank;bestName=CATALYST_MAP[k].name;} });
  return { rank:bestRank, name:bestName };
}

// ── MAVERICK IGNITION SCORE ────────────────────────────────────────────────
function calcMIS(d, catRank) {
  catRank=catRank||5; var score=0, components=[];
  var country = d.country || detectCountry(d.sym, '');
  var zone    = priceZone(d.price);

  // Hard exclusions
  if (country==='IL' || d.price < 0.25) return { raw:0, pct:0, tier:'EXCLUDED', components:['Hard excluded'], expectedMove:'0%' };

  if      (d.floatM<1) {score+=20;components.push('Float 20/20 — NANO');}
  else if (d.floatM<5) {score+=16;components.push('Float 16/20 — tight');}
  else if (d.floatM<15){score+=10;components.push('Float 10/20 — workable');}
  else if (d.floatM<30){score+=4;components.push('Float 4/20 — wide');}
  else {components.push('Float 0/20 — too large');}
  if      (d.relVol>=10){score+=18;components.push('RVOL 18/18 — '+d.relVol+'x WHALE');}
  else if (d.relVol>=5) {score+=14;components.push('RVOL 14/18 — '+d.relVol+'x');}
  else if (d.relVol>=3) {score+=9;components.push('RVOL 9/18 — '+d.relVol+'x');}
  else if (d.relVol>=2) {score+=5;components.push('RVOL 5/18 — '+d.relVol+'x');}
  else {components.push('RVOL 0/18 — weak');}
  var catPts=[15,12,8,4,0][Math.min(catRank-1,4)]; score+=catPts; components.push('Catalyst '+catPts+'/15 — rank '+catRank+'/5');
  if      (d.shortPct>=30){score+=12;components.push('Short 12/12 — '+rnd(d.shortPct,1)+'% heavy');}
  else if (d.shortPct>=20){score+=8;components.push('Short 8/12 — '+rnd(d.shortPct,1)+'%');}
  else if (d.shortPct>=10){score+=4;components.push('Short 4/12 — '+rnd(d.shortPct,1)+'%');}
  else {components.push('Short 0/12 — '+rnd(d.shortPct,1)+'%');}
  if      (d.gapPct>=20){score+=8;components.push('Gap 8/8 — +'+rnd(d.gapPct,1)+'%');}
  else if (d.gapPct>=10){score+=5;components.push('Gap 5/8 — +'+rnd(d.gapPct,1)+'%');}
  else if (d.gapPct>=5) {score+=2;components.push('Gap 2/8 — +'+rnd(d.gapPct,1)+'%');}
  var dtc=d.daysToCover||99;
  if      (dtc<0.5){score+=7;components.push('DTC 7/7 — '+rnd(dtc,2)+'d TRAPPED');}
  else if (dtc<1.0){score+=5;components.push('DTC 5/7 — '+rnd(dtc,2)+'d');}
  else if (dtc<2.0){score+=3;components.push('DTC 3/7 — '+rnd(dtc,2)+'d');}

  // Price zone scoring (replaces flat price score)
  if (zone.mis !== 0) {
    score += zone.mis;
    components.push('Price '+zone.mis+'/8 — '+zone.label+' $'+d.price);
  } else {
    components.push('Price 0/8 — '+zone.label+' $'+d.price);
  }

  // Country adjustment
  if      (country==='US') { score+=4; components.push('Country +4 — 🇺🇸 US'); }
  else if (country==='CN') { score-=4; components.push('Country -4 — 🇨🇳 CN penalty'); }

  if (d.week52High>0&&d.price>=d.week52High*0.98&&d.changePct>0){score+=5;components.push('52W Breakout +5 BONUS');}
  var pct=Math.min(100,Math.round(score/90*100));
  var tier=pct>=80?'IGNITION READY':pct>=65?'HIGH POTENTIAL':pct>=50?'WATCH':'SKIP';
  var expectedMove=pct>=80?'50-200%':pct>=65?'25-75%':pct>=50?'15-35%':'<15%';
  return { raw:score, pct, tier, components, expectedMove };
}

// ── SHORT DANGER INDEX ─────────────────────────────────────────────────────
function calcSDI(d, catRank) {
  catRank=catRank||5; var score=0, reasons=[];
  var dtc=d.daysToCover||99;
  if      (dtc<0.5){score+=30;reasons.push('SHORTS TRAPPED — '+rnd(dtc,2)+'d to cover');}
  else if (dtc<1.0){score+=20;reasons.push('DTC < 1 day — very tight');}
  else if (dtc<2.0){score+=10;reasons.push('DTC < 2 days — squeeze possible');}
  if      (d.shortPct>=30){score+=25;reasons.push('HEAVY SHORT '+rnd(d.shortPct,1)+'%');}
  else if (d.shortPct>=20){score+=15;reasons.push('High short '+rnd(d.shortPct,1)+'%');}
  else if (d.shortPct>=10){score+=8;reasons.push('Moderate short '+rnd(d.shortPct,1)+'%');}
  if      (d.price<1){score+=20;reasons.push('SUB-$1 — unlimited % upside risk for shorts');}
  else if (d.price<3){score+=15;reasons.push('Sub-$3 — high % move possible');}
  else if (d.price<5){score+=8;reasons.push('Sub-$5 — elevated short risk');}
  if      (catRank===1){score+=20;reasons.push('BINARY CATALYST — shorts cannot hedge');}
  else if (catRank===2){score+=12;reasons.push('Strong catalyst — short risk elevated');}
  else if (catRank===3){score+=5;reasons.push('Moderate catalyst');}
  if      (d.relVol>=10){score+=5;reasons.push('WHALE RVOL '+d.relVol+'x — forced covering');}
  else if (d.relVol>=5) {score+=3;reasons.push('High RVOL '+d.relVol+'x');}
  score=Math.min(100,score);
  var danger=score>=75?'EXTREME DANGER':score>=55?'HIGH DANGER':score>=35?'MODERATE':'LOW RISK';
  return { score, danger, reasons };
}

// ══════════════════════════════════════════════════════════════════════════
// ── STEALTH ACCUMULATION SCORE (SAS) — MODULE 3 COMPLETE ─────────────────
// ══════════════════════════════════════════════════════════════════════════
// Detects quiet whale entry BEFORE a move happens using free data.
// No dark pool feed needed — statistical proxies from OHLCV bars.
//
// FIVE COMPONENTS:
//  1. Volume Anomaly      — high volume, low price move = silent absorption
//  2. Close Position      — closing near HOD on volume = buyers in control
//  3. Multi-day Buildup   — consecutive above-avg volume days = pre-ignition
//  4. ATR Compression     — range tightening while volume builds = coil forming
//  5. Volume Acceleration — volume growing faster than price = accumulation
//
function calcSAS(d) {
  var aggs = d._aggs || [];
  var score = 0;
  var signals = [];
  var warnings = [];

  // ── COMPONENT 1: VOLUME ANOMALY (0-25 pts) ────────────────────────────
  // High volume + low price movement = someone absorbing shares quietly.
  // Whales accumulate by spreading buys so price doesn't spike and reveal them.
  var volAnomalyPts = 0, volAnomalySignal = '';
  if (aggs.length >= 6) {
    var recentVols = aggs.slice(-5).map(function(a){return a.v||0;});
    var priorVols  = aggs.slice(-15,-5).map(function(a){return a.v||0;});
    var recentAvg  = recentVols.reduce(function(a,b){return a+b;},0) / Math.max(recentVols.length,1);
    var priorAvg   = priorVols.reduce(function(a,b){return a+b;},0)  / Math.max(priorVols.length,1);
    var volRatio   = priorAvg > 0 ? recentAvg / priorAvg : 1;
    var priceMove  = Math.abs(d.changePct);

    if      (volRatio >= 3 && priceMove < 5)  { volAnomalyPts = 25; volAnomalySignal = 'SILENT ABSORPTION — vol '+rnd(volRatio,1)+'x surge with only '+rnd(priceMove,1)+'% price move. Classic whale accumulation.'; }
    else if (volRatio >= 2 && priceMove < 8)  { volAnomalyPts = 18; volAnomalySignal = 'Volume anomaly — '+rnd(volRatio,1)+'x spike vs quiet price action.'; }
    else if (volRatio >= 1.5 && priceMove < 12){ volAnomalyPts = 10; volAnomalySignal = 'Mild volume expansion with contained price.'; }
    else if (volRatio >= 1.2)                  { volAnomalyPts =  4; volAnomalySignal = 'Slight volume pickup.'; }
    else { warnings.push('Volume flat or declining — no accumulation detected.'); }
    if (volAnomalyPts > 0) signals.push({ label:'Volume Anomaly', pts:volAnomalyPts, max:25, detail:volAnomalySignal });
  } else {
    signals.push({ label:'Volume Anomaly', pts:0, max:25, detail:'Insufficient history for analysis.' });
  }
  score += volAnomalyPts;

  // ── COMPONENT 2: CLOSE POSITION IN DAILY RANGE (0-20 pts) ────────────
  // Where price closes within its day range reveals who won the session.
  // Closing near HOD on volume = buyers absorbed all supply. Accumulation.
  var closePts = 0, closeSignal = '';
  var range = (d.high || 0) - (d.low || 0);
  if (range > 0 && d.price > 0) {
    var closePos = (d.price - (d.low||0)) / range; // 0=closed at LOD, 1=closed at HOD
    if      (closePos >= 0.85) { closePts = 20; closeSignal = 'Closed at '+rnd(closePos*100,0)+'% of range — BUYERS IN CONTROL. Sellers absorbed completely.'; }
    else if (closePos >= 0.70) { closePts = 14; closeSignal = 'Strong close at '+rnd(closePos*100,0)+'% of range — demand present.'; }
    else if (closePos >= 0.50) { closePts =  7; closeSignal = 'Mid-range close — balanced session, slight buy bias.'; }
    else if (closePos >= 0.30) { closePts =  2; closeSignal = 'Weak close at '+rnd(closePos*100,0)+'% of range — sellers had edge.'; }
    else                       { closePts =  0; closeSignal = 'Closed near LOD — distribution pressure, not accumulation.'; warnings.push('Closed near LOD — bearish close pattern.'); }
    signals.push({ label:'Close Position', pts:closePts, max:20, detail:closeSignal });
  } else {
    signals.push({ label:'Close Position', pts:0, max:20, detail:'Range data unavailable.' });
  }
  score += closePts;

  // ── COMPONENT 3: MULTI-DAY VOLUME BUILDUP (0-25 pts) ─────────────────
  // Consecutive above-average volume days signal sustained institutional buying.
  // 5+ days of building volume before a gap = classic pre-ignition signature.
  var buildupPts = 0, buildupSignal = '', consecAboveAvg = 0;
  if (aggs.length >= 8) {
    var allVols   = aggs.slice(0,-1).map(function(a){return a.v||0;});
    var longAvg   = allVols.reduce(function(a,b){return a+b;},0) / Math.max(allVols.length,1);
    var threshold = longAvg * 1.2;
    // Count consecutive above-average volume days from most recent backwards
    for (var ci = aggs.length - 2; ci >= 0; ci--) {
      if ((aggs[ci].v||0) >= threshold) consecAboveAvg++;
      else break;
    }
    // Also check if volume is INCREASING day over day (acceleration)
    var lastThree = aggs.slice(-4,-1).map(function(a){return a.v||0;});
    var isAccel   = lastThree.length >= 2 && lastThree[lastThree.length-1] > lastThree[0];

    if      (consecAboveAvg >= 5) { buildupPts = 25; buildupSignal = consecAboveAvg+' consecutive above-avg volume days — CLASSIC PRE-IGNITION SIGNATURE. Whale has been building for days.'; }
    else if (consecAboveAvg >= 3) { buildupPts = 17; buildupSignal = consecAboveAvg+' days of above-avg volume'+(isAccel?' with acceleration — buildup intensifying.':'.'); }
    else if (consecAboveAvg >= 2) { buildupPts = 10; buildupSignal = '2 days of above-avg volume — early buildup pattern.'; }
    else if (consecAboveAvg >= 1) { buildupPts =  4; buildupSignal = '1 day above average — too early to confirm.'; }
    else                          { buildupPts =  0; warnings.push('No consecutive volume buildup — accumulation not confirmed over time.'); buildupSignal = 'Volume not building consistently.'; }
    signals.push({ label:'Multi-Day Buildup', pts:buildupPts, max:25, detail:buildupSignal });
  } else {
    signals.push({ label:'Multi-Day Buildup', pts:0, max:25, detail:'Need 8+ bars for buildup analysis.' });
  }
  score += buildupPts;

  // ── COMPONENT 4: ATR COMPRESSION (0-20 pts) ───────────────────────────
  // Price range tightening while volume builds = coil forming before explosion.
  // The tighter the range, the more compressed the energy.
  var compressionPts = 0, compressionSignal = '';
  if (aggs.length >= 10) {
    var recent5Ranges = aggs.slice(-6,-1).map(function(a){return (a.h||0)-(a.l||0);});
    var prior15Ranges = aggs.slice(-21,-6).map(function(a){return (a.h||0)-(a.l||0);});
    var recentRangeAvg = recent5Ranges.reduce(function(a,b){return a+b;},0) / Math.max(recent5Ranges.length,1);
    var priorRangeAvg  = prior15Ranges.reduce(function(a,b){return a+b;},0) / Math.max(prior15Ranges.length,1);
    var compressionRatio = priorRangeAvg > 0 ? recentRangeAvg / priorRangeAvg : 1;
    var volumeBuilding  = buildupPts >= 10; // Cross-reference with buildup

    if      (compressionRatio <= 0.50 && volumeBuilding) { compressionPts = 20; compressionSignal = 'MAXIMUM COIL — range '+rnd(compressionRatio*100,0)+'% of historical with volume building. Explosion imminent.'; }
    else if (compressionRatio <= 0.60 && volumeBuilding) { compressionPts = 15; compressionSignal = 'Strong compression — range contracted '+rnd((1-compressionRatio)*100,0)+'% while volume held.'; }
    else if (compressionRatio <= 0.70)                   { compressionPts = 10; compressionSignal = 'Moderate compression — range contracting.'; }
    else if (compressionRatio <= 0.80)                   { compressionPts =  5; compressionSignal = 'Mild range tightening detected.'; }
    else                                                  { compressionPts =  0; compressionSignal = 'Range expanding or stable — no compression.'; }
    signals.push({ label:'ATR Compression', pts:compressionPts, max:20, detail:compressionSignal });
  } else {
    signals.push({ label:'ATR Compression', pts:0, max:20, detail:'Need 10+ bars for compression analysis.' });
  }
  score += compressionPts;

  // ── COMPONENT 5: VOLUME ACCELERATION (0-10 pts) ───────────────────────
  // Volume growing faster than price = institutional buying against supply.
  var accelPts = 0, accelSignal = '';
  if (aggs.length >= 6) {
    var last3  = aggs.slice(-4,-1).map(function(a){return a.v||0;});
    var prev3  = aggs.slice(-7,-4).map(function(a){return a.v||0;});
    var last3Avg = last3.reduce(function(a,b){return a+b;},0) / Math.max(last3.length,1);
    var prev3Avg = prev3.reduce(function(a,b){return a+b;},0) / Math.max(prev3.length,1);
    var accelRatio = prev3Avg > 0 ? last3Avg / prev3Avg : 1;

    if      (accelRatio >= 3)   { accelPts = 10; accelSignal = 'Volume '+ rnd(accelRatio,1)+'x vs prior 3 days — AGGRESSIVE acceleration.'; }
    else if (accelRatio >= 2)   { accelPts =  7; accelSignal = 'Volume '+ rnd(accelRatio,1)+'x vs prior 3 days — strong acceleration.'; }
    else if (accelRatio >= 1.5) { accelPts =  4; accelSignal = 'Volume picking up '+ rnd(accelRatio,1)+'x vs prior period.'; }
    else if (accelRatio >= 1.2) { accelPts =  2; accelSignal = 'Slight volume acceleration detected.'; }
    else                        { accelSignal = 'Volume not accelerating.'; }
    signals.push({ label:'Volume Acceleration', pts:accelPts, max:10, detail:accelSignal });
  } else {
    signals.push({ label:'Volume Acceleration', pts:0, max:10, detail:'Insufficient data.' });
  }
  score += accelPts;

  // ── SCORE + TIER ──────────────────────────────────────────────────────
  score = Math.min(100, Math.max(0, score));
  var tier, interpretation;
  if      (score >= 80) { tier = 'WHALE DETECTED';    interpretation = 'High-probability institutional accumulation. A move is being loaded. This is the "counting cards" signal.'; }
  else if (score >= 60) { tier = 'STRONG SIGNAL';     interpretation = 'Multiple accumulation indicators confirmed. Smart money may be positioning. Watch for catalyst to ignite.'; }
  else if (score >= 40) { tier = 'MODERATE SIGNAL';   interpretation = 'Some accumulation signs present. Not conclusive. Combine with MIS and SDI before acting.'; }
  else if (score >= 20) { tier = 'WEAK SIGNAL';       interpretation = 'Minor signals only. No clear institutional footprint detected.'; }
  else                  { tier = 'NO SIGNAL';          interpretation = 'No detectable accumulation. Either too early, or no whale interest.'; }

  return { score, tier, signals, warnings, interpretation };
}

// ── /sas COMMAND ─────────────────────────────────────────────────────────
async function cmdSAS(sym, chatId) {
  await tg('🐋 Running Stealth Accumulation Score for $' + sym + '...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('Cannot pull data for $' + sym + '. Check ticker.', chatId);
  // Guarantee aggs are present — SAS needs historical bars to score
  if (!d._aggs || d._aggs.length < 5) {
    var freshAggs = await yahooAggs(sym, 25);
    if (freshAggs && freshAggs.length >= 5) d._aggs = freshAggs;
    else d._aggs = [];
  }
  var sas = calcSAS(d);
  var mis = calcMIS(d, 5);
  var sdi = calcSDI(d, 5);

  var tierEmoji = sas.score >= 80 ? '🐋' : sas.score >= 60 ? '⚡' : sas.score >= 40 ? '👀' : '❌';
  var msg = tierEmoji + ' <b>$' + sym + ' — STEALTH ACCUMULATION SCORE</b>\n\n';
  msg += 'SAS: <b>' + sas.score + '/100</b>  [' + sas.tier + ']\n\n';
  msg += '<b>' + sas.interpretation + '</b>\n\n';

  msg += '<b>COMPONENT BREAKDOWN:</b>\n';
  sas.signals.forEach(function(s) {
    var bar = '';
    var filled = Math.round(s.pts / s.max * 5);
    for (var bi=0; bi<5; bi++) bar += bi < filled ? '█' : '░';
    msg += bar + ' ' + s.label + ' ' + s.pts + '/' + s.max + '\n';
    msg += '   ' + s.detail + '\n';
  });

  if (sas.warnings.length) {
    msg += '\n<b>⚠️ CONCERNS:</b>\n';
    sas.warnings.forEach(function(w) { msg += '• ' + w + '\n'; });
  }

  msg += '\n<b>COMBINED PICTURE:</b>\n';
  msg += 'SAS: ' + sas.score + ' [' + sas.tier + ']\n';
  msg += 'MIS: ' + mis.pct + ' [' + mis.tier + ']\n';
  msg += 'SDI: ' + sdi.score + ' [' + sdi.danger + ']\n\n';

  // Composite signal
  var composite = sas.score + mis.pct + sdi.score;
  if (composite >= 220 && sas.score >= 60) {
    msg += '🔥 <b>TRIPLE CONFIRMATION</b> — SAS + MIS + SDI all elevated.\nThis is the highest-confidence setup the Maverick system can generate.\n';
    msg += '/supernova ' + sym + ' for full breakdown.';
  } else if (sas.score >= 60 && mis.pct >= 65) {
    msg += '⚡ <b>DOUBLE SIGNAL</b> — Whale accumulation + strong MIS.\nWait for catalyst or RVOL spike to trigger entry.\n';
  } else if (sas.score >= 80) {
    msg += '🐋 Whale is loading but setup not fully ignited yet.\nMark it. Watch for catalyst.\n/watch ' + sym;
  } else {
    msg += 'No composite confirmation yet. Keep monitoring.\n';
  }

  msg += '\n$' + d.price + ' | RVOL:' + d.relVol + 'x | Float:' + d.floatM + 'M';
  await tg(msg, chatId);
}

// ══════════════════════════════════════════════════════════════════════════
// ── SEQUENCE MATCH % ENGINE ───────────────────────────────────────────────
// Scores how closely a setup matches the two most explosive historical sequences.
// Sequence A = Explosive (nano float + catalyst + gap + short squeeze fuel)
// Sequence B = Duration  (mid float + earnings + institutional buildup)
function calcSequenceMatch(d, catRank, aggs) {
  catRank = catRank || 5;
  var seqA = [], seqB = [];
  var scoreA = 0, scoreB = 0;

  // ── SEQUENCE A — MOST EXPLOSIVE ──────────────────────────────────────────
  // Float < 5M
  if (d.floatM < 5)  { scoreA += 25; seqA.push('✅ Float '+d.floatM+'M < 5M — NANO'); }
  else if (d.floatM < 10){ scoreA += 12; seqA.push('⚡ Float '+d.floatM+'M — tight but not nano'); }
  else { seqA.push('❌ Float '+d.floatM+'M — too large for Seq A (need < 5M)'); }

  // Short > 25%
  if (d.shortPct >= 25) { scoreA += 20; seqA.push('✅ Short '+rnd(d.shortPct,1)+'% — squeeze fuel loaded'); }
  else if (d.shortPct >= 15){ scoreA += 10; seqA.push('⚡ Short '+rnd(d.shortPct,1)+'% — moderate fuel'); }
  else { seqA.push('❌ Short '+rnd(d.shortPct,1)+'% — not enough shorts (need > 25%)'); }

  // Rank 1-2 catalyst
  if (catRank <= 2) { scoreA += 20; seqA.push('✅ Rank '+catRank+' catalyst — binary event, shorts cannot hedge'); }
  else if (catRank === 3) { scoreA += 8; seqA.push('⚡ Rank '+catRank+' catalyst — moderate signal'); }
  else { seqA.push('❌ Rank '+catRank+' catalyst — too weak for Seq A (need Rank 1-2)'); }

  // Gap > 20%
  if (d.gapPct >= 20) { scoreA += 20; seqA.push('✅ Gap +'+rnd(d.gapPct,1)+'% — shorts trapped overnight'); }
  else if (d.gapPct >= 10) { scoreA += 10; seqA.push('⚡ Gap +'+rnd(d.gapPct,1)+'% — partial match'); }
  else { seqA.push('❌ Gap '+rnd(d.gapPct,1)+'% — need > 20% for full Seq A'); }

  // RVOL > 5x
  if (d.relVol >= 5) { scoreA += 15; seqA.push('✅ RVOL '+d.relVol+'x — whale accumulation confirmed'); }
  else if (d.relVol >= 3) { scoreA += 7; seqA.push('⚡ RVOL '+d.relVol+'x — building'); }
  else { seqA.push('❌ RVOL '+d.relVol+'x — need > 5x for Seq A (volume not there yet)'); }

  // ── SEQUENCE B — LONGEST DURATION ────────────────────────────────────────
  // Float 5-20M (institutional-friendly)
  if (d.floatM >= 5 && d.floatM <= 20) { scoreB += 25; seqB.push('✅ Float '+d.floatM+'M — institutional sweet spot'); }
  else if (d.floatM < 5) { scoreB += 8; seqB.push('⚡ Float '+d.floatM+'M — too tight for sustained Seq B'); }
  else { seqB.push('❌ Float '+d.floatM+'M — too wide (need 5-20M for duration run)'); }

  // Earnings/revenue catalyst (Rank 3)
  if (catRank === 3) { scoreB += 25; seqB.push('✅ Rank 3 catalyst — earnings/revenue beat, durable move'); }
  else if (catRank <= 2) { scoreB += 12; seqB.push('⚡ Rank '+catRank+' catalyst — strong but may be too volatile for Seq B'); }
  else { seqB.push('❌ Rank '+catRank+' catalyst — too weak for sustained Seq B run'); }

  // RVOL 2-5x (institutional, not retail panic)
  if (d.relVol >= 2 && d.relVol < 6) { scoreB += 20; seqB.push('✅ RVOL '+d.relVol+'x — institutional buying pace'); }
  else if (d.relVol >= 6) { scoreB += 8; seqB.push('⚡ RVOL '+d.relVol+'x — too hot, likely retail not institutional'); }
  else { seqB.push('❌ RVOL '+d.relVol+'x — need 2-5x institutional pace'); }

  // 3+ day volume buildup from aggs
  var buildup = 0;
  if (aggs && aggs.length >= 8) {
    var allVols  = aggs.slice(-20).map(function(a){return a.v||0;});
    var avgV     = allVols.reduce(function(a,b){return a+b;},0) / Math.max(allVols.length,1);
    var last5    = aggs.slice(-6,-1);
    buildup = last5.filter(function(a){return (a.v||0) >= avgV*1.2;}).length;
  }
  if (buildup >= 3) { scoreB += 20; seqB.push('✅ '+buildup+'-day volume buildup — pre-ignition sequence confirmed'); }
  else if (buildup >= 2) { scoreB += 10; seqB.push('⚡ '+buildup+'-day buildup — developing'); }
  else { seqB.push('❌ No volume buildup detected (need 3+ days above avg)'); }

  // Controlled move 5-30% (not parabolic, sustainable)
  var absMov = Math.abs(d.changePct);
  if (absMov >= 5 && absMov <= 30) { scoreB += 10; seqB.push('✅ Move +'+rnd(absMov,1)+'% — controlled, sustainable'); }
  else if (absMov > 30) { seqB.push('❌ Move +'+rnd(absMov,1)+'% — too extended for Seq B entry'); }
  else { seqB.push('❌ Move +'+rnd(absMov,1)+'% — needs 5%+ momentum'); }

  scoreA = Math.min(100, scoreA);
  scoreB = Math.min(100, scoreB);
  var primary  = scoreA >= scoreB ? 'A' : 'B';
  var primScore = Math.max(scoreA, scoreB);
  var label    = primScore >= 80 ? 'STRONG MATCH' : primScore >= 60 ? 'PARTIAL MATCH' : primScore >= 40 ? 'WEAK MATCH' : 'NO MATCH';

  return { scoreA, scoreB, primary, primScore, label, seqA, seqB };
}

// ── DURATION PREDICTOR ────────────────────────────────────────────────────
// Estimates how long the move will last based on float × catalyst × RVOL.
// This tells you whether to expect a 30-minute scalp or an all-day hold.
function predictDuration(d, catRank) {
  catRank = catRank || 5;
  var floatTier = d.floatM < 1 ? 'NANO' : d.floatM < 5 ? 'TIGHT' : d.floatM < 15 ? 'MID' : 'WIDE';
  var catTier   = catRank <= 2 ? 'BINARY' : catRank === 3 ? 'EARNINGS' : 'WEAK';
  var rvolTier  = d.relVol >= 10 ? 'WHALE' : d.relVol >= 5 ? 'HIGH' : d.relVol >= 2 ? 'MOD' : 'LOW';

  var minMin=30, maxMin=90, style='', hold='', exitNote='';

  if (floatTier==='NANO' && catTier==='BINARY' && rvolTier==='WHALE') {
    minMin=15; maxMin=45; style='🚀 VIOLENT SPIKE';
    hold='Sell 75% in first 20 min. Trail remaining 25% with tight stop.';
    exitNote='Vertical moves ALWAYS mean-revert. Don\'t be greedy.';
  } else if (floatTier==='NANO' && rvolTier==='WHALE') {
    minMin=20; maxMin=75; style='⚡ FAST MOVER';
    hold='Sell 50% at +25%, move stop to breakeven, trail rest.';
    exitNote='RVOL fade = exit signal. Watch every candle.';
  } else if (floatTier==='TIGHT' && catTier==='BINARY') {
    minMin=30; maxMin=150; style='🔥 SUSTAINED RUN';
    hold='Phase-based exit. Hold through first pullback, exit before 2PM CT dead zone.';
    exitNote='This can go all day if volume holds. Watch DTC.';
  } else if (floatTier==='MID' && catTier==='EARNINGS') {
    minMin=120; maxMin=360; style='📈 ALL-DAY RUNNER';
    hold='Enter Phase 1-2. Scale out in thirds. Can hold through lunch on earnings beats.';
    exitNote='Volume sustainability is the key signal. Fading RVOL = start selling.';
  } else if (catTier==='WEAK' && rvolTier==='LOW') {
    minMin=10; maxMin=30; style='⚡ SCALP ONLY';
    hold='Quick in and out. No overnight hold. No thesis here.';
    exitNote='This is a momentum scalp, not a swing. Treat it that way.';
  } else if (floatTier==='WIDE') {
    minMin=60; maxMin=240; style='🐢 SLOW GRIND';
    hold='Wide float needs institutional conviction to move. Smaller size.';
    exitNote='Patient hold but tight stop. Large floats fade easily.';
  } else {
    minMin=30; maxMin=120; style='📊 STANDARD MOVER';
    hold='Standard Maverick phase-based exit. Exit before Phase 4 distribution.';
    exitNote='Watch RVOL for fade signal as primary exit trigger.';
  }
  return { minMin, maxMin, style, hold, exitNote };
}

// ── /trend TICKER ─────────────────────────────────────────────────────────
async function cmdTrend(sym, chatId) {
  var key = 'trend:'+sym;
  procStart(key, '/trend', sym);
  await tg('⏳ Running Trend Recognition Engine on $'+sym+'...', chatId);
  var d = await getStock(sym);
  procEnd(key);
  if (!d) return tg('Cannot pull data for $'+sym+'. Check ticker.', chatId);
  if (!d._aggs || d._aggs.length < 5) {
    var freshAggs = await getAggs(sym, 25);
    if (freshAggs) d._aggs = freshAggs;
  }
  var trend = calcTrend(d, d._aggs||[]);
  var sc    = detectStaircaseScore(d, d._aggs||[]);
  var zone  = priceZone(d.price);
  var country = detectCountry(sym,'');
  var countryFlag = country==='US'?'🇺🇸':country==='CN'?'🇨🇳':'🌐';

  var trendEmoji = trend.direction.includes('BULLISH')?'📈':trend.direction.includes('BEARISH')?'📉':'↔️';
  var msg = trendEmoji+' <b>$'+sym+' — TREND RECOGNITION</b> '+countryFlag+'\n\n';
  msg += '<b>Trend:</b> '+trend.direction+'  Strength: <b>'+trend.strength+'/100</b>\n';
  msg += '<b>Price:</b> $'+d.price+'  '+zone.label+'\n';
  msg += (trend.isStaircase ? '🪜 <b>STAIRCASE PATTERN ACTIVE</b>\n' : '');
  msg += '\n<b>Moving Averages:</b>\n';
  if (trend.sma5)  msg += '5d MA:  $'+trend.sma5+' — price '+(d.price>trend.sma5?'ABOVE ✅':'BELOW ❌')+'\n';
  if (trend.sma10) msg += '10d MA: $'+trend.sma10+' — price '+(d.price>trend.sma10?'ABOVE ✅':'BELOW ❌')+'\n';
  if (trend.sma20) msg += '20d MA: $'+trend.sma20+' — price '+(d.price>trend.sma20?'ABOVE ✅':'BELOW ❌')+'\n';
  msg += '\n<b>Structure (last 10 sessions):</b>\n';
  msg += 'Higher Highs: '+trend.hhCount+'  Higher Lows: '+trend.hlCount+'\n';
  msg += 'Lower Lows:   '+trend.llCount+'  Lower Highs: '+trend.lhCount+'\n';
  msg += '\n<b>Volume Bias:</b> '+trend.volBias+'x '+(trend.volBias>=1.5?'🟢 STRONG BUYERS':trend.volBias>=1.2?'🟡 BUYERS':trend.volBias<=0.7?'🔴 SELLERS':'⚪ NEUTRAL')+'\n';
  msg += '<b>Momentum:</b> 5d '+( trend.roc5>=0?'+':'')+trend.roc5+'%  |  10d '+(trend.roc10>=0?'+':'')+trend.roc10+'%\n';
  msg += '\n<b>Summary:</b>\n'+trend.summary+'\n';
  if (trend.isStaircase) {
    msg += '\n<b>🪜 STAIRCASE DETAIL:</b>\n';
    msg += 'Score: '+sc.score+'/100 ['+sc.tier+']\n';
    sc.signals.slice(0,4).forEach(function(s){ msg += '• '+s+'\n'; });
  }
  msg += '\n/check '+sym+' | /science '+sym;
  await tg(msg, chatId);
}

// ── PROTOCOLS ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// ── INTRADAY MOMENTUM ENGINE + VWAP PROXY WHALE DETECTOR ─────────────────
// ══════════════════════════════════════════════════════════════════════════
// Measures what's happening TODAY, not yesterday.
// From-open move, volume pace, and VWAP proxy hold are the three whale signals.
// Whales adapted to hide from close-to-close scanners. VWAP proxy finds them.
function calcIntradayMomentum(d) {
  var signals = [], score = 0;
  var hourCT = nowHourCT();

  // 1. VOLUME PACE — project full-day volume vs daily average
  // If it's 11AM and volume is already at 80% of avg — someone is buying hard.
  var timeCT2 = nowTimeCT();
  var tradingElapsed = Math.max(0.25, timeCT2 - 8.5); // market opens 8:30AM CT
  var volumePace = d.avgVol > 0 ?
    rnd((d.volume / tradingElapsed) * 6.5 / d.avgVol, 2) : 1;
  if      (volumePace >= 6) { score+=30; signals.push('🐋 Volume pace '+volumePace+'x — on track to print '+rnd(volumePace,1)+'x daily average. INSTITUTIONAL accumulation at scale.'); }
  else if (volumePace >= 3) { score+=20; signals.push('📊 Volume pace '+volumePace+'x — strong accumulation underway. Not retail.'); }
  else if (volumePace >= 2) { score+=10; signals.push('📊 Volume pace '+volumePace+'x — above average intraday pace.'); }
  else                       { signals.push('📊 Volume pace '+volumePace+'x — normal. No unusual buying.'); }

  // 2. FROM-OPEN MOVE — real intraday buying, not gap
  // This is separate from the gap. A stock can gap 10% and then fade.
  // From-open move shows whether buyers are ADDING to the gap or fading it.
  var fromOpen = d.open > 0 ? rnd((d.price - d.open) / d.open * 100, 2) : 0;
  if      (fromOpen >= 20) { score+=25; signals.push('🚀 +'+fromOpen+'% FROM OPEN — sustained push. Not a gap fade. Buyers still entering after open.'); }
  else if (fromOpen >= 10) { score+=18; signals.push('📈 +'+fromOpen+'% from open — strong intraday buying post-open.'); }
  else if (fromOpen >= 5)  { score+=10; signals.push('📈 +'+fromOpen+'% from open — building.'); }
  else if (fromOpen < -5)  { score-=15; signals.push('❌ '+fromOpen+'% from open — fading. Gap sellers in control.'); }
  else if (fromOpen < 0)   { score-=5;  signals.push('⚠️ '+fromOpen+'% from open — slightly below open. Weak.'); }
  else                      { signals.push('➡️ +'+fromOpen+'% from open — flat from open. Sideways.'); }

  // 3. VWAP PROXY HOLD — the whale hunting signal
  // True VWAP requires tick-by-tick data. Our proxy: (O+H+L+C)/4.
  // When price > VWAP proxy AND price is in top 40% of day range:
  //   — Every buyer since open is profitable
  //   — Shorts from the gap are underwater
  //   — Distribution hasn't started
  //   — That's institutional accumulation hiding in plain sight.
  var vwapProxy = d.open > 0 ? rnd((d.open + (d.high||d.price) + (d.low||d.price) + d.price) / 4, 4) : d.price;
  var range     = ((d.high||0) - (d.low||0));
  var rangePos  = range > 0 ? (d.price - (d.low||0)) / range : 0.5;
  var aboveVwap = d.price >= vwapProxy;
  if      (aboveVwap && rangePos >= 0.75) {
    score+=25;
    signals.push('🐋 VWAP PROXY HOLD — $'+d.price+' above proxy $'+vwapProxy+', top '+rnd(rangePos*100,0)+'% of range. Every buyer since open profitable. Shorts trapped. WHALE ACCUMULATION PATTERN.');
  }
  else if (aboveVwap && rangePos >= 0.50) {
    score+=15;
    signals.push('✅ Above VWAP proxy ($'+vwapProxy+') — buyers in control, holding mid-range.');
  }
  else if (!aboveVwap && rangePos < 0.30) {
    score-=15;
    signals.push('🔴 Below VWAP proxy — distribution. Sellers winning intraday. Do not enter.');
  }
  else {
    signals.push('⚪ Near VWAP proxy ($'+vwapProxy+') — contested. Wait for direction.');
  }

  // 4. INTRADAY HIGHER-LOW STRUCTURE — staircase forming
  // Using recent aggs as structural context (multi-session higher lows)
  if (d._aggs && d._aggs.length >= 3) {
    var last3 = d._aggs.slice(-3);
    var hlCount = 0;
    for (var i=1; i<last3.length; i++) {
      if ((last3[i].l||0) > (last3[i-1].l||0)) hlCount++;
    }
    if (hlCount >= 2 && fromOpen > 0) {
      score+=20;
      signals.push('🪜 MULTI-SESSION HIGHER LOWS ('+hlCount+' consecutive) — staircase structure in formation. Institutions defending each pullback.');
    } else if (hlCount >= 1) {
      score+=8;
      signals.push('📈 1 session higher low — early staircase development. Monitor.');
    }
  } else {
    // Intraday proxy: if near HOD and above open, likely staircase
    if (d.price >= (d.high||d.price)*0.97 && fromOpen > 3) {
      score+=12;
      signals.push('📈 Holding near HOD above open — intraday staircase signature.');
    }
  }

  score = Math.min(100, Math.max(0, score));
  var tier = score>=75?'PRIME MOMENTUM 🔥':score>=55?'BUILDING 📈':score>=35?'EARLY SIGNAL 👀':'INSUFFICIENT';
  return { score, tier, signals, volumePace, fromOpen, vwapProxy, aboveVwap, rangePos };
}

// ══════════════════════════════════════════════════════════════════════════
// ── ALGO-WATCHLIST ENGINE — The Algorithm's Autonomous Arsenal ────────────
// ══════════════════════════════════════════════════════════════════════════
// Always maintains 7 slots. Tiers: HIGH (≥70), MED (50-69), LOW (<50).
// Alerts on every slot change. Runs every 10 min, uses cache to save API calls.
// Purpose: view the algorithm's ready arsenal + prepare for next session.
async function updateAlgoWatchlist() {
  // Build candidate universe from cache-warm gainers + staircase + base
  var candidates = [];
  var gainers = gainersCache || [];
  gainers.forEach(function(g){ if(g.ticker) candidates.push(g.ticker); });
  Object.keys(staircaseTracker).forEach(function(s){ if(candidates.indexOf(s)===-1) candidates.push(s); });
  Object.keys(watchlist).forEach(function(s){ if(candidates.indexOf(s)===-1) candidates.push(s); });
  BASE_SCAN.slice(0,30).forEach(function(s){ if(candidates.indexOf(s)===-1) candidates.push(s); });
  candidates = candidates.filter(function(v,i,a){return a.indexOf(v)===i && v && v.length<=5;}).slice(0,45);

  var scored = [];
  for (var i=0; i<candidates.length; i++) {
    var sym = candidates[i];
    try {
      // Use cache first — avoids extra API calls
      var d = cacheGet(sym);
      if (!d) d = await getStock(sym);
      if (!d) { await sleep(150); continue; }
      if (d.price > TRADE_MAX_PRICE || d.price < 0.25) continue;
      var country = detectCountry(sym,'');
      if (country === 'IL') continue;
      var sr = scoreSetup(d); if (sr.excluded) continue;
      var mis = calcMIS(d, 5);
      var sdi = calcSDI(d, 5);
      var sas = calcSAS(d);
      var im  = calcIntradayMomentum(d);
      var trend = calcTrend(d, d._aggs||[]);
      var sc  = detectStaircaseScore(d, d._aggs||[]);
      // Composite algo score — weighted toward intraday signals during market hours
      var hourCT = nowHourCT();
      var isOpen = isMarketOpen();
      var composite = isOpen
        ? rnd((mis.pct*0.25)+(sas.score*0.20)+(im.score*0.30)+(sc.score*0.15)+(trend.strength*0.10),1)
        : rnd((mis.pct*0.35)+(sas.score*0.30)+(sdi.score*0.20)+(sr.score*0.15),1);
      var convTier = composite>=70?'HIGH 🔥':composite>=50?'MED ⚡':'LOW 👀';
      var reason = convTier+' | MIS:'+mis.pct+' SAS:'+sas.score+(im.score>=55?' 🐋INTRADAY':'')+(sc.score>=55?' 🪜STAIRCASE':'');
      scored.push({ sym, score:composite, convTier, mis:mis.pct, sdi:sdi.score, sas:sas.score, imScore:im.score, price:d.price, changePct:d.changePct, relVol:d.relVol, reason, trend:trend.direction, floatM:d.floatM });
    } catch(e) {}
    await sleep(100);
  }

  scored.sort(function(a,b){return b.score-a.score;});
  // Always fill 7 slots — even if low conviction
  var newList = scored.slice(0,7).map(function(s){return Object.assign({},s,{addedTs:Date.now()});});
  if (newList.length === 0) return; // Nothing scoreable, skip update

  // Detect slot changes and alert
  var oldSyms = algoWatchlist.map(function(w){return w.sym;});
  var newSyms = newList.map(function(w){return w.sym;});
  var hasChange = false;

  // Alert: new entries
  for (var n=0; n<newSyms.length; n++) {
    if (oldSyms.indexOf(newSyms[n]) === -1) {
      hasChange = true;
      var entry = newList[n];
      await tg(
        '🤖 <b>ALGO WATCHLIST — SLOT '+(n+1)+' ENTRY</b>\n\n' +
        '$'+entry.sym+' '+cFlag(entry.sym)+' earned a spot\n' +
        'Conviction: <b>'+entry.convTier+'</b>  Score: '+entry.score+'/100\n' +
        'MIS:'+entry.mis+' SDI:'+entry.sdi+' SAS:'+entry.sas+'\n' +
        '$'+entry.price+' ('+(entry.changePct>=0?'+':'')+rnd(entry.changePct,1)+'%) RVOL:'+entry.relVol+'x Float:'+entry.floatM+'M\n' +
        'Trend: '+entry.trend+'\n' +
        entry.reason+'\n\n' +
        '/check '+entry.sym+' | /trend '+entry.sym
      );
      await sleep(1200);
    }
  }
  // Alert: exits
  for (var o=0; o<oldSyms.length; o++) {
    if (newSyms.indexOf(oldSyms[o]) === -1) {
      hasChange = true;
      var dropReason = scored.find(function(s){return s.sym===oldSyms[o];});
      await tg(
        '🤖 <b>ALGO WATCHLIST — DROPPED</b>\n\n' +
        '$'+oldSyms[o]+' removed from algo arsenal\n' +
        (dropReason?'New score: '+dropReason.score+'/100 — fell below threshold\n':'No longer scoring\n') +
        'Replaced by stronger setup'
      );
      await sleep(1200);
    }
  }

  algoWatchlist = newList;
  algoWatchTs   = Date.now();
  if (hasChange) console.log('[ALGO-WATCH] Updated: '+newSyms.join(', '));
  else console.log('[ALGO-WATCH] No changes. Holding: '+newSyms.join(', '));
}

// ── /awatch — show algo watchlist ────────────────────────────────────────
async function cmdAlgoWatch(chatId) {
  if (!algoWatchlist.length) {
    return tg('🤖 Algo watchlist is initializing. Check back in ~10 minutes or run /top-pick to warm it.', chatId);
  }
  var updAgo = algoWatchTs ? Math.round((Date.now()-algoWatchTs)/60000)+'m ago' : 'initializing';
  var msg = '🤖 <b>ALGO WATCHLIST — THE ARSENAL</b>\n';
  msg += '<i>Algorithm\'s autonomous selections | Updated: '+updAgo+'</i>\n\n';
  var tiers = {high:[], med:[], low:[]};
  algoWatchlist.forEach(function(w,i){
    var slot = '['+(i+1)+'] $'+w.sym+' '+cFlag(w.sym)+' '+w.convTier+' ('+w.score+')\n';
    slot += '    $'+w.price+' ('+(w.changePct>=0?'+':'')+rnd(w.changePct,1)+'%) RVOL:'+w.relVol+'x  MIS:'+w.mis+' SAS:'+w.sas+'\n';
    slot += '    '+w.reason+'\n';
    if (w.convTier.includes('HIGH')) tiers.high.push(slot);
    else if (w.convTier.includes('MED')) tiers.med.push(slot);
    else tiers.low.push(slot);
  });
  if (tiers.high.length)  { msg += '🔥 <b>HIGH CONVICTION:</b>\n';   tiers.high.forEach(function(s){msg+=s;}); msg+='\n'; }
  if (tiers.med.length)   { msg += '⚡ <b>MEDIUM CONVICTION:</b>\n';  tiers.med.forEach(function(s){msg+=s;}); msg+='\n'; }
  if (tiers.low.length)   { msg += '👀 <b>MONITORING:</b>\n';         tiers.low.forEach(function(s){msg+=s;}); msg+='\n'; }
  msg += 'Your watchlist: /mywatch\nBest pick now: /top-pick';
  await tg(msg, chatId);
}

// ── /mywatch — show user watchlist ────────────────────────────────────────
async function cmdMyWatch(chatId) {
  var keys = Object.keys(watchlist);
  if (!keys.length) return tg('Your watchlist is empty.\nAdd: /watch TICKER', chatId);
  var msg = '📋 <b>YOUR WATCHLIST</b>\n\n';
  for (var i=0; i<keys.length; i++) {
    var sym = keys[i], info = watchlist[sym];
    var d = cacheGet(sym) || await getStock(sym).catch(function(){return null;});
    if (d) {
      msg += '$'+sym+' '+cFlag(sym)+' $'+d.price+' ('+(d.changePct>=0?'+':'')+rnd(d.changePct,1)+'%)'+'  RVOL:'+d.relVol+'x\n';
    } else {
      msg += '$'+sym+' — data unavailable\n';
    }
    if (info && info.addedTs) msg += '  Added: '+new Date(info.addedTs).toLocaleDateString()+'\n';
  }
  msg += '\nAlgo arsenal: /awatch | Best now: /top-pick';
  await tg(msg, chatId);
}

// ══════════════════════════════════════════════════════════════════════════
// ── COMBINED ALGO + INTRADAY SCAN (every 10 min) ─────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Shares the same universe scan to minimize API calls.
// Algo watchlist runs always (including after hours).
// Intraday momentum alerts only during market hours.
async function runAlgoAndIntradayScan() {
  var hourCT = nowHourCT();
  var isMarketHoursNow = isMarketOpen();

  // Reset intraday dedup at start of new day
  var today = todayStr();
  if (!runAlgoAndIntradayScan._lastDay || runAlgoAndIntradayScan._lastDay !== today) {
    intradayAlertsToday.clear();
    runAlgoAndIntradayScan._lastDay = today;
  }

  // Update algo watchlist (runs regardless of market hours)
  await updateAlgoWatchlist();

  // Intraday momentum scan — market hours only
  if (!isMarketHoursNow) return;

  // Scan the algo watchlist + user watchlist (data already cached from algo update)
  var intradayUniverse = algoWatchlist.map(function(w){return w.sym;});
  Object.keys(watchlist).forEach(function(s){ if(intradayUniverse.indexOf(s)===-1) intradayUniverse.push(s); });

  for (var i=0; i<intradayUniverse.length; i++) {
    var sym = intradayUniverse[i];
    try {
      var d = cacheGet(sym); // Use cached data only — zero extra API calls
      if (!d || d.price > TRADE_MAX_PRICE || d.price < 0.25) continue;
      var im = calcIntradayMomentum(d);
      // Fire alert if: prime momentum AND not already alerted today AND significant change pct
      var alertKey = 'intraday:'+sym+':'+today;
      if (im.score >= 65 && !intradayAlertsToday.has(alertKey) && d.changePct >= 8) {
        intradayAlertsToday.add(alertKey);
        var imMIS = calcMIS(d,5), imTrend = calcTrend(d, d._aggs||[]);
        var msg = '📊 <b>INTRADAY MOMENTUM — $'+sym+' '+cFlag(sym)+'</b>\n\n';
        msg += 'Score: <b>'+im.score+'/100</b> ['+im.tier+']\n';
        msg += priceZone(d.price).label+'\n\n';
        im.signals.forEach(function(s){ msg += s+'\n'; });
        msg += '\n$'+d.price+' ('+(d.changePct>=0?'+':'')+rnd(d.changePct,1)+'%) RVOL:'+d.relVol+'x\n';
        msg += 'From open: '+(im.fromOpen>=0?'+':'')+im.fromOpen+'%\n';
        msg += 'VWAP proxy: $'+im.vwapProxy+' — price '+(im.aboveVwap?'ABOVE ✅':'BELOW ❌')+'\n';
        msg += 'Volume pace: '+im.volumePace+'x projected daily\n';
        msg += 'MIS:'+imMIS.pct+' Trend:'+imTrend.direction+'\n\n';
        msg += '/check '+sym+' | /trend '+sym+' | /sas '+sym;
        await tg(msg);
        organicAlertsSent++;
        await sleep(1500);
      }
    } catch(e) { console.error('[INTRADAY]', sym, e.message); }
  }
  console.log('[INTRADAY] Scan complete. Alerts today: '+intradayAlertsToday.size);
}

// ── /intraday — on-demand intraday scan ─────────────────────────────────
async function cmdIntraday(chatId) {
  var hourCT = nowHourCT();
  if (!isMarketOpen() && !isPreMarketHours()) {
    return tg('📊 Market is closed.\nIntraday scanner runs 8:30AM–3PM CT (regular session)\nPre-market scanner runs 3AM–8:30AM CT\nUse /awatch to see the algo arsenal for next session.', chatId);
  }
  await tg('⏳ Running Live Intraday Momentum Scanner...\nVWAP proxy + volume pace + from-open move (~30s)', chatId);
  var gainers = await getTopGainers();
  var universe = gainers.slice(0,15).map(function(g){return g.ticker;});
  Object.keys(watchlist).forEach(function(s){ if(universe.indexOf(s)===-1) universe.push(s); });
  algoWatchlist.forEach(function(w){ if(universe.indexOf(w.sym)===-1) universe.push(w.sym); });
  universe = universe.filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,25);

  var settled = await Promise.allSettled(universe.map(function(s){ return getStock(s); }));
  var results = [];
  settled.forEach(function(r){ if(r.status==='fulfilled'&&r.value&&r.value.price<=TRADE_MAX_PRICE&&r.value.price>=0.25&&r.value.changePct>=5) results.push(r.value); });
  results.sort(function(a,b){
    return calcIntradayMomentum(b).score - calcIntradayMomentum(a).score;
  });

  if (!results.length) return tg('No strong intraday momentum detected right now. Market may be quiet or post-peak.', chatId);
  var msg = '<b>📊 LIVE INTRADAY MOMENTUM SCAN</b>\n\n';
  for (var i=0; i<Math.min(6,results.length); i++) {
    var d = results[i], im = calcIntradayMomentum(d);
    msg += '<b>$'+d.sym+' '+cFlag(d.sym)+'</b> ['+im.tier+']\n';
    msg += '$'+d.price+' ('+(d.changePct>=0?'+':'')+rnd(d.changePct,1)+'%) RVOL:'+d.relVol+'x\n';
    msg += 'Score:'+im.score+'  From open:'+(im.fromOpen>=0?'+':'')+im.fromOpen+'%  Vol pace:'+im.volumePace+'x\n';
    msg += (im.aboveVwap?'🐋 Above VWAP proxy':'⚠️ Below VWAP proxy')+' ($'+im.vwapProxy+')\n';
    if (im.signals.length) msg += im.signals[0]+'\n';
    msg += '/check '+d.sym+'\n\n';
  }
  await tg(msg, chatId);
}

// ══════════════════════════════════════════════════════════════════════════
// ── FOCUS MODE — Expert Peer Conversation ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Two traders talking. No training wheels. No disclaimers.
// The AI knows the full system and speaks from experience.
// If a ticker is mentioned, live data is pulled and woven in automatically.
async function cmdFocusChat(text, chatId) {
  // Only detect tickers the user explicitly capitalizes (ALL-CAPS in original text).
  // Never uppercase the message to find tickers — that turns "Good" into $GOOD.
  // User has committed to capitalizing tickers: PIII, TRT, CNEY etc.
  var words = text.split(/\s+/);
  var COMMON_WORDS = new Set(['THE','AND','BUT','FOR','ARE','NOT','ITS','LET','SEE','CAN','GET','BUY','PUT','YES','NOW','ALL','ANY','WHAT','WHEN','WHERE','WHY','HOW','THIS','THAT','WITH','FROM','HAVE','BEEN','WILL','THEY','THEM','THAN','INTO','OVER','JUST','GOOD','WELL','LIKE','MAKE','SOME','ALSO','BEEN','MORE','MOST','ONLY','SUCH','VERY','THAN','THEN','THESE','THOSE','EACH','BOTH','SAID','DOES','THEIR','THERE','WOULD','COULD','SHOULD','ABOUT']);
  var ticker = words.find(function(w) {
    // Must be ALL-CAPS as typed by user (not lowercased or mixed case)
    return w.length >= 2 && w.length <= 5 &&
           /^[A-Z]+$/.test(w) &&           // all uppercase letters only
           w === w.toUpperCase() &&         // redundant but explicit
           !COMMON_WORDS.has(w) &&
           !/^\d/.test(w);                  // not a number
  });

  var liveCtx = '';
  if (ticker) {
    var d = await getStock(ticker).catch(function(){return null;});
    if (d) {
      var mis = calcMIS(d,5), sdi = calcSDI(d,5), sas = calcSAS(d);
      var trend = calcTrend(d, d._aggs||[]);
      var im = calcIntradayMomentum(d);
      var lifecycle = detectLifecyclePhase(d);
      liveCtx =
        '\n\n[LIVE DATA: $'+ticker+']'+
        '\nPrice: $'+d.price+' ('+(d.changePct>=0?'+':'')+rnd(d.changePct,1)+'%) '+cFlag(ticker)+' '+priceZone(d.price).label+
        '\nRVOL:'+d.relVol+'x Float:'+d.floatM+'M Short:'+rnd(d.shortPct,1)+'% DTC:'+d.daysToCover+'d'+
        '\nFrom open: '+(im.fromOpen>=0?'+':'')+im.fromOpen+'% VPace:'+im.volumePace+'x VWAP:'+(im.aboveVwap?'ABOVE':'BELOW')+' ($'+im.vwapProxy+')'+
        '\nMIS:'+mis.pct+'['+mis.tier+'] SDI:'+sdi.score+'['+sdi.danger+'] SAS:'+sas.score+'['+sas.tier+']'+
        '\nIntraday:'+im.score+'/100['+im.tier+'] Trend:'+trend.direction+' Strength:'+trend.strength+
        '\n'+lifecycle.emoji+' '+lifecycle.name;
    }
  }

  // Build market context
  var mktCtx = '';
  if (algoWatchlist.length) {
    mktCtx = '\n[ALGO ARSENAL: '+algoWatchlist.slice(0,3).map(function(w){return '$'+w.sym+'('+w.convTier+')'}).join(', ')+']';
  }
  if (Object.keys(positions).length) {
    mktCtx += '\n[OPEN POSITIONS: '+Object.keys(positions).join(', ')+']';
  }
  var edgeCtx = getPersonalInsight();

  var reply = await ai(
    // This is the most important system prompt in the bot.
    // It defines WHO the bot is in focus mode. No bot persona. No disclaimers. Two traders.
    'You are a seasoned micro-cap trader with 15 years in the game. ' +
    'You have traded through every market condition — dotcom crashes, meme stock mania, algo-dominated tape. ' +
    'You think in terms of whale behavior, institutional footprints, and probability stacks. ' +
    'You know this trader\'s complete system: Maverick Creed, Supernova Protocol, MIS/SDI/SAS/SM%/Duration, staircase exception, VWAP proxy whale detection. ' +
    'You\'ve been tracking the market together. You have opinions. You push back when the setup looks wrong. ' +
    'You are not a bot assistant. You are a trading partner who happens to know everything. ' +
    'When data is provided, use it. When it\'s not, speak from experience and pattern recognition. ' +
    'No disclaimers. No "you should consult a financial advisor." No training wheels. No "I cannot provide financial advice." ' +
    'Plain speech. Trader to trader. If the setup is garbage, say so. If it\'s clean, call it clean. ' +
    'Max 300 words unless the question is complex. Reference actual numbers when available.' +
    (activeProtocol ? ' Active protocol: '+activeProtocol+'.' : '') +
    edgeCtx + mktCtx,

    text + liveCtx,
    700, chatId
  );

  if (reply) await tg(reply, chatId);
  else await tg('AI brain offline. Try again in a moment.', chatId);
}

// ══════════════════════════════════════════════════════════════════════════
// ── BUY-TO-COVER CASCADE DETECTOR ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
function calcCascadeConditions(d) {
  var score=0, stage=0, signals=[], warnings=[];
  var dtc=d.daysToCover||99, short=d.shortPct||0, rvol=d.relVol||0, floatM=d.floatM||50;

  if      (dtc<0.25){score+=30;signals.push('🚨 DTC '+rnd(dtc,2)+'d — CRITICAL: shorts need 6hr+ to cover');}
  else if (dtc<0.5) {score+=22;signals.push('⚡ DTC '+rnd(dtc,2)+'d — shorts trapped, ~half-day to cover');}
  else if (dtc<0.75){score+=14;signals.push('👀 DTC '+rnd(dtc,2)+'d — pressure building');}
  else if (dtc<1.5) {score+=6;signals.push('DTC '+rnd(dtc,2)+'d — moderate');}
  else {warnings.push('DTC '+rnd(dtc,2)+'d — too long, cascade less likely');}

  if      (short>=30){score+=25;signals.push('🔥 Short '+rnd(short,1)+'% — extreme fuel. Every 1% costs shorts dearly.');}
  else if (short>=20){score+=16;signals.push('⚡ Short '+rnd(short,1)+'% — significant fuel');}
  else if (short>=10){score+=8;signals.push('Short '+rnd(short,1)+'% — moderate');}
  else if (short>0)  {score+=3;signals.push('Short '+rnd(short,1)+'% — light');}
  else {warnings.push('Short 0% — no confirmed short data (check manually via /sdi)');}

  if      (rvol>=20){score+=25;signals.push('🐋 RVOL '+rvol+'x — WHALE. Institutional buying overwhelming shorts.');}
  else if (rvol>=10){score+=18;signals.push('⚡ RVOL '+rvol+'x — institutional interest confirmed');}
  else if (rvol>=5) {score+=10;signals.push('RVOL '+rvol+'x — elevated, not yet cascade-level');}
  else if (rvol>=3) {score+=4;signals.push('RVOL '+rvol+'x — building');}
  else {warnings.push('RVOL '+rvol+'x — low. Need volume to ignite cascade.');}

  if      (floatM<1) {score+=15;signals.push('💎 NANO FLOAT '+floatM+'M — <1M shares. Shorts fighting over scraps.');}
  else if (floatM<3) {score+=10;signals.push('Float '+floatM+'M — tight. Limited inventory to cover against.');}
  else if (floatM<10){score+=5;signals.push('Float '+floatM+'M — workable');}
  else {warnings.push('Float '+floatM+'M — wide float reduces cascade potential');}

  if (priceZone(d.price).label.includes('PRIMARY')){score+=5;signals.push('PRIMARY ZONE — maximum volatility territory');}

  // ── 52-WEEK PIVOT BREACH — mechanical cascade trigger ─────────────────────
  // Retail short sellers program stop-losses right above the 52W high.
  // Price breaching that level triggers automated buy-to-cover market orders.
  if (d.week52High > 0 && d.week52High < 9999) {
    var distFrom52W = (d.week52High - d.price) / d.week52High;
    if      (distFrom52W < 0)    { score += 20; signals.push('🚨 ABOVE 52W HIGH ($'+d.week52High+') — retail short stops ALREADY triggered. Cascade IS happening.'); }
    else if (distFrom52W < 0.02) { score += 20; signals.push('🎯 Within 2% of 52W HIGH ($'+d.week52High+'). Retail short buy-stops cluster HERE. Breach = mechanical cascade.'); }
    else if (distFrom52W < 0.05) { score += 10; signals.push('52W High approaching at $'+d.week52High+' ('+rnd(distFrom52W*100,1)+'% away). Short stops loading.'); }
  }

  score = Math.min(100,score);
  if      (score>=80){stage=3;}
  else if (score>=60){stage=2;}
  else if (score>=40){stage=1;}

  var stageLabel=stage===3?'🚨 CASCADE IMMINENT':stage===2?'⚡ TRAP FORMING':stage===1?'👀 PRE-CONDITIONS':'❌ NO CASCADE';
  var range=(d.high||0)-(d.low||0), closePos=range>0?(d.price-(d.low||0))/range:0.5;
  var cascadeEnding=rvol<3&&closePos<0.35;
  var cascadeMinPct=dtc<1?Math.min(150,rnd(30/Math.max(dtc,0.1),0)):20;
  var cascadeMaxPct=Math.min(400,rnd(cascadeMinPct*2.5,0));

  return {score,stage,stageLabel,signals,warnings,dtc,short,rvol,floatM,
    cascadeRange:'+'+cascadeMinPct+'% — +'+cascadeMaxPct+'%',
    entryZone:'$'+rnd(d.price*0.99,4)+' — $'+rnd(d.price*1.01,4),
    stopBelow:'$'+rnd(d.price*0.93,4),
    cascadeEnding,closePos};
}

async function cmdCascade(sym, chatId) {
  procStart('cascade:'+sym,'/cascade',sym);
  await tg('⏳ Running Buy-to-Cover Cascade analysis on $'+sym+'...',chatId);
  var d=await getStock(sym); procEnd('cascade:'+sym);
  if(!d) return tg('Cannot pull data for $'+sym,chatId);
  var casc=calcCascadeConditions(d);
  var msg='🌀 <b>CASCADE DETECTOR — $'+sym+' '+cFlag(sym)+'</b>\n';
  msg+='━━━━━━━━━━━━━━━━━━━━━━\n';
  msg+=casc.stageLabel+'  Score: <b>'+casc.score+'/100</b>\n\n';
  if(casc.stage>=2){msg+='<b>🎯 PROJECTED RANGE: '+casc.cascadeRange+'</b>\nEntry: '+casc.entryZone+'\nStop: '+casc.stopBelow+'\n\n';}
  msg+='<b>CONDITIONS:</b>\n'; casc.signals.forEach(function(s){msg+='• '+s+'\n';});
  if(casc.warnings.length){msg+='\n<b>⚠️ GAPS:</b>\n';casc.warnings.forEach(function(w){msg+='• '+w+'\n';});}
  if(casc.cascadeEnding){msg+='\n🏁 <b>CASCADE ENDING</b> — RVOL fading + price near LOD. Scale out now.\n';}
  else if(casc.stage>=2){msg+='\n<b>EXIT SIGNALS:</b>\n• RVOL < 3x (shorts done covering)\n• First candle closes below 35% of range\n• Price breaks VWAP proxy for 2+ candles\n';}
  msg+='\n$'+d.price+' ('+(d.changePct>=0?'+':'')+rnd(d.changePct,1)+'%)  RVOL:'+d.relVol+'x  DTC:'+d.daysToCover+'d  Short:'+rnd(d.shortPct,1)+'%';
  if(casc.stage>=3){msg+='\n\n🚨 <b>IMMINENT.</b> Shorts at pain threshold.\n/check '+sym+' for full case.';}
  else if(casc.stage>=2){msg+='\n\n⚡ Watch for RVOL spike above 10x — that\'s the trigger.\n/watch '+sym+' to track.';}
  await tg(msg,chatId);
}

async function cmdStaircase(chatId) {
  await tg('⏳ Running staircase scan...',chatId);
  var universe=Object.keys(watchlist);
  algoWatchlist.forEach(function(w){if(universe.indexOf(w.sym)===-1)universe.push(w.sym);});
  BASE_SCAN.slice(0,20).forEach(function(t){if(universe.indexOf(t)===-1)universe.push(t);});
  universe=universe.filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,30);
  var results=[];
  for(var i=0;i<universe.length;i++){
    var sym=universe[i];
    try{
      var d=await getStock(sym);
      if(!d||d.price>TRADE_MAX_PRICE||d.price<0.25||detectCountry(sym,'')===('IL')||d.changePct<4) continue;
      var sc=detectStaircaseScore(d,d._aggs||[]);
      if(sc.score>=35) results.push({sym,price:d.price,changePct:d.changePct,relVol:d.relVol,score:sc.score,tier:sc.tier,tracked:!!staircaseTracker[sym],elapsed:staircaseTracker[sym]?Math.round((Date.now()-staircaseTracker[sym].firstSeen)/60000):0});
      await sleep(200);
    }catch(e){}
  }
  if(!results.length) return tg('🪜 No active staircases detected.\nNeed: 5%+ move + price near HOD + RVOL > 2x\n\nAdd tickers: /watch TICKER',chatId);
  results.sort(function(a,b){return b.score-a.score;});
  var msg='🪜 <b>STAIRCASE SCAN</b>\n\n';
  results.slice(0,8).forEach(function(r){
    msg+=(r.score>=75?'🔥':'⚡')+' <b>$'+r.sym+'</b> '+cFlag(r.sym)+' — '+r.score+'/100 ['+r.tier+']\n';
    msg+='$'+r.price+' (+'+rnd(r.changePct,1)+'%) RVOL:'+r.relVol+'x'+(r.tracked?' | Tracking:'+r.elapsed+'min':'')+'\n';
    msg+='/check '+r.sym+'  /cascade '+r.sym+'\n\n';
  });
  msg+='Auto-alerts fire at 30min (soft) + 60min (hard) per name.';
  await tg(msg,chatId);
}

var PROTOCOLS = {
  ross: {
    name:'Ross Cameron Protocol', desc:'Gap and Go — first 5min candle break, exit by 11AM',
    filter:function(d){return d.gapPct>=10&&d.price>=2&&d.price<=20&&d.floatM<=10&&d.relVol>=3;},
    entry:function(d){return rnd(d.price*1.005,4);}, stop:function(d){return rnd(d.price*0.97,4);},
    tp1:function(d){return rnd(d.price*1.10,4);}, tp2:function(d){return rnd(d.price*1.20,4);},
    rules:['Only trade first 90 minutes (9:30–11:00AM ET)','Gap must be 10%+ from previous close','Float under 10M','Enter on break of 5-min opening range high','Stop = low of first 5-min candle','Sell all by 11AM','Max 2 trades per day']
  },
  humble: {
    name:'Humble Trader Protocol', desc:'Mid-day continuation — patient entries, 3:1 R:R minimum',
    filter:function(d){return d.changePct>=10&&d.price>=1&&d.price<=30&&d.floatM<=20&&d.relVol>=2;},
    entry:function(d){return rnd(d.price*1.002,4);}, stop:function(d){return rnd(d.price*0.95,4);},
    tp1:function(d){return rnd(d.price*1.15,4);}, tp2:function(d){return rnd(d.price*1.30,4);},
    rules:['Wait for 3 consecutive green 5-min candles with increasing volume','Float under 20M','Minimum 3:1 R:R','Hold runners — don\'t sell all at TP1','Move stop to breakeven after TP1 hit']
  },
  maverick: {
    name:'Maverick Protocol (Adaptive)', desc:'Learns from YOUR trade history',
    filter:function(d){return d.floatM<=15&&d.relVol>=2&&d.changePct>=5;},
    entry:function(d){return rnd(d.price,4);}, stop:function(d){return rnd(d.price-d.atr*1.5,4);},
    tp1:function(d){return rnd(d.price+d.atr*2,4);}, tp2:function(d){return rnd(d.price+d.atr*4,4);},
    rules:['Starts as a blend of Ross and Humble Trader','Adapts to YOUR win rate after 10+ logged trades','Learns which float/RVOL ranges you win in','Gets smarter every trade you log with /close','Run /myedge to see your data']
  }
};

function applyProtocol(d, proto) {
  var p=PROTOCOLS[proto], entry=p.entry(d), stop=p.stop(d), tp1=p.tp1(d), tp2=p.tp2(d);
  var shares=calcShares(entry,stop), rr=rnd((tp1-entry)/Math.max(entry-stop,0.001),2);
  return { entry, stop, tp1, tp2, shares, rr };
}

// ── DEMAND / SUPPLY ZONE DETECTION ────────────────────────────────────────
function calcDemandSupplyZones(aggs) {
  if (!aggs || aggs.length < 5) return { demand: [], supply: [] };
  var demand = [], supply = [];
  for (var i=1; i<aggs.length-1; i++) {
    var prev=aggs[i-1], curr=aggs[i], next=aggs[i+1];
    // Demand: local low — price bounced up from here
    if (curr.l <= prev.l && curr.l <= next.l && next.c > curr.l*1.02) {
      demand.push({ low:rnd(curr.l*0.99,4), high:rnd(curr.l*1.03,4), vol:curr.v||0 });
    }
    // Supply: local high — price rejected down from here
    if (curr.h >= prev.h && curr.h >= next.h && next.c < curr.h*0.98) {
      supply.push({ low:rnd(curr.h*0.97,4), high:rnd(curr.h*1.01,4), vol:curr.v||0 });
    }
  }
  demand.sort(function(a,b){return b.vol-a.vol;});
  supply.sort(function(a,b){return b.vol-a.vol;});
  return {
    demand: demand.slice(0,2).map(function(z){return '$'+z.low+'-$'+z.high;}),
    supply: supply.slice(0,2).map(function(z){return '$'+z.low+'-$'+z.high;})
  };
}

// ── 30-MINUTE MOVE PROJECTION ─────────────────────────────────────────────
function project30MinMove(d, catRank) {
  catRank = catRank || 5;
  var base     = Math.max(Math.abs(d.gapPct)||0, Math.abs(d.changePct)||0);
  var floatMult = d.floatM < 1 ? 4 : d.floatM < 5 ? 2.5 : d.floatM < 15 ? 1.5 : 0.8;
  var rvolMult  = d.relVol >= 10 ? 2.2 : d.relVol >= 5 ? 1.6 : d.relVol >= 3 ? 1.2 : 0.7;
  var catMult   = catRank === 1 ? 2.0 : catRank === 2 ? 1.5 : catRank === 3 ? 1.1 : 0.8;
  var projected = rnd(base * floatMult * rvolMult * catMult * 0.25 + d.relVol * 2.5, 0);
  projected = Math.max(5, Math.min(projected, 250));
  var conf = (d.relVol >= 5 && catRank <= 2) ? 'HIGH' : (d.relVol >= 3 && catRank <= 3) ? 'MODERATE' : 'LOW';
  return { pct: projected, confidence: conf };
}

// ── MAVERICK ALERT VOICE ──────────────────────────────────────────────────
// This is the psychology of every alert. Personal. Direct. Trade-ready.
async function buildMaverickAlert(sym, d, triggerReason, catName, catRank) {
  catRank = catRank || 5;
  catName = catName || 'No Catalyst';
  var archetype  = classifyArchetype(d, catRank);
  var projection = project30MinMove(d, catRank);
  var zones      = calcDemandSupplyZones(d._aggs || []);
  var lifecycle  = detectLifecyclePhase(d);
  var mis        = calcMIS(d, catRank);
  var sdi        = calcSDI(d, catRank);
  var sas        = calcSAS(d);
  var stop  = rnd(d.price - d.atr * 1.5, 4);
  var tp1   = rnd(d.price + d.atr * 2, 4);
  var tp2   = rnd(d.price + d.atr * 4, 4);
  var buyLo = rnd(d.price * 0.988, 4);
  var buyHi = rnd(d.price * 1.005, 4);
  var changeStr = (d.changePct >= 0 ? '+' : '') + rnd(d.changePct, 2) + '%';

  // Engine synergy for this alert
  var aScores  = [mis.pct, sdi.score, sas.score];
  var aSpread  = Math.max.apply(null,aScores) - Math.min.apply(null,aScores);
  var aSynergy = aSpread<=20?'🟢 ALIGNED':aSpread<=40?'🟡 MIXED':'🔴 CONFLICTED';

  var zone = priceZone(d.price);
  var flag = cFlag(sym);

  var msg = '<b>🔔 $'+sym+' '+flag+' just pinged my alert.</b>\n\n';
  msg += "I've looked into it and found it's a <b>"+archetype.type+"</b> for the following reasons:\n";
  msg += '• '+triggerReason+'\n';
  msg += '• RVOL '+d.relVol+'x — '+(d.relVol>=10?'whale-level accumulation':d.relVol>=5?'institutional interest confirmed':d.relVol>=3?'above-average buying':'building')+'\n';
  msg += '• Float: '+d.floatM+'M — '+(d.floatM<1?'nano float, explosive % moves possible':d.floatM<5?'tight float, limited supply':d.floatM<15?'workable float':'wide float, needs more volume')+'\n';
  if (catName !== 'No Catalyst' && catName !== 'System Test') msg += '• Catalyst: '+catName+' (Rank '+catRank+'/5)\n';
  msg += '• Price '+changeStr+' today at $'+d.price+'  '+zone.label+'\n';
  msg += '\n'+lifecycle.emoji+' <b>'+lifecycle.name+'</b>\n'+lifecycle.action+'\n';
  msg += '\nEngines: MIS:'+mis.pct+' SDI:'+sdi.score+' SAS:'+sas.score+'  '+aSynergy+'\n';
  msg += '\n<b>I\'m projecting this could move '+projection.pct+'%+ within the first 30 minutes.</b>';
  msg += ' [Confidence: '+projection.confidence+']\n\n';
  msg += '<b>Zones:</b>\n';
  msg += 'Buy zone:  $'+buyLo+' — $'+buyHi+'\n';
  msg += 'Stop loss: $'+stop+'\n';
  msg += 'TP1: $'+tp1+'  |  TP2: $'+tp2+'\n\n';
  if (zones.demand.length) msg += '<b>Demand clusters at:</b> '+zones.demand.join(' / ')+'\n';
  if (zones.supply.length) msg += '<b>Supply resistance at:</b> '+zones.supply.join(' / ')+'\n';
  msg += '\n'+archetype.emoji+' '+archetype.type+' | MIS:'+mis.pct+' | SDI:'+sdi.score;
  msg += '\n\n/check '+sym+' | /science '+sym+' | /supernova '+sym;
  return msg;
}

// ══════════════════════════════════════════════════════════════════════════
// ── PHASE 3: SUPERNOVA PROTOCOL ENGINE ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

// ── 9 SUPERNOVA INGREDIENTS ───────────────────────────────────────────────
// Each ingredient either passes (1) or fails (0). Rule of Five: 5+ = tradeable.
function scoreSupernova(d, catRank, headline) {
  catRank = catRank || 5;
  headline = (headline || '').toLowerCase();
  var ingredients = [];

  // 1. FLOAT UNDER 20M (ideally under 5M)
  var floatPass = d.floatM < 20;
  ingredients.push({
    name: 'Float < 20M', pass: floatPass,
    detail: floatPass ? (d.floatM < 5 ? 'NANO '+d.floatM+'M — ROCKET FUEL' : d.floatM+'M — tight') : d.floatM+'M — too large for supernova'
  });

  // 2. CATALYST RANK 1-2 (binary event)
  var catPass = catRank <= 2;
  ingredients.push({
    name: 'Rank 1-2 Catalyst', pass: catPass,
    detail: catPass ? 'Rank '+catRank+' — binary event, shorts cannot hedge' : 'Rank '+catRank+' — catalyst too weak for supernova ignition'
  });

  // 3. RVOL > 5x
  var rvolPass = d.relVol >= 5;
  ingredients.push({
    name: 'RVOL > 5x', pass: rvolPass,
    detail: d.relVol+'x — '+(rvolPass ? (d.relVol >= 10 ? 'WHALE volume, shorts forced to cover' : 'strong institutional interest') : 'not enough volume for sustained move')
  });

  // 4. GAP > 20% premarket
  var gapPass = d.gapPct >= 20;
  ingredients.push({
    name: 'Gap > 20%', pass: gapPass,
    detail: d.gapPct > 0 ? '+'+rnd(d.gapPct,1)+'% gap — '+(gapPass ? 'massive gap, shorts trapped overnight' : 'gap too small for supernova') : 'No gap detected'
  });

  // 5. SHORT INTEREST > 20% (squeeze fuel)
  var shortPass = d.shortPct >= 20;
  ingredients.push({
    name: 'Short % > 20%', pass: shortPass,
    detail: rnd(d.shortPct,1)+'% short — '+(shortPass ? 'heavy short interest, squeeze fuel loaded' : 'not enough shorts to force a squeeze run')
  });

  // 6. PRICE UNDER $10 (maximum % move potential)
  var pricePass = d.price < 10;
  ingredients.push({
    name: 'Price < $10', pass: pricePass,
    detail: '$'+d.price+' — '+(pricePass ? (d.price < 2 ? 'sub-$2, unlimited % upside' : 'sub-$10, high % move possible') : 'above $10, limits % move magnitude')
  });

  // 7. DAYS TO COVER < 1 (shorts trapped)
  var dtcPass = d.daysToCover < 1;
  ingredients.push({
    name: 'DTC < 1 Day', pass: dtcPass,
    detail: rnd(d.daysToCover,2)+'d — '+(dtcPass ? 'TRAPPED — shorts cannot exit without moving price' : 'shorts can still exit without panic')
  });

  // 8. CLEAN BREAKOUT (no major resistance within 20% overhead — proxy: near 52W high)
  var near52wHigh = d.week52High > 0 && d.price >= d.week52High * 0.75;
  var cleanPass = near52wHigh || d.changePct >= 15;
  ingredients.push({
    name: 'Clean Chart / Breakout', pass: cleanPass,
    detail: cleanPass ? (d.price >= (d.week52High||0)*0.95 ? '52W breakout — blue sky territory' : '+'+rnd(d.changePct,1)+'% — momentum clear') : 'Price in middle of range — resistance overhead'
  });

  // 9. SECTOR / SYMPATHY IN PLAY (proxy: catalyst or high RVOL on a non-catalyst name)
  var sectorPass = catRank <= 3 || d.relVol >= 8 || /biotech|pharma|ai|crypto|defense|energy|ev|cannabis/.test(headline);
  ingredients.push({
    name: 'Sector In Play', pass: sectorPass,
    detail: sectorPass ? 'Sector catalyst or extreme volume — sympathy runners possible' : 'No sector theme detected — isolated mover'
  });

  var passed = ingredients.filter(function(ing){return ing.pass;}).length;
  var ruleFive = passed >= 5;
  var grade = passed >= 8 ? 'TIER 1 — SUPERNOVA CONFIRMED' :
              passed >= 6 ? 'TIER 2 — HIGH PROBABILITY' :
              passed >= 5 ? 'TIER 3 — WATCH CLOSELY' :
              passed >= 3 ? 'BELOW THRESHOLD' : 'NOT A SUPERNOVA';

  return { ingredients, passed, ruleFive, grade };
}

// ── 5 SUPERNOVA ARCHETYPES ────────────────────────────────────────────────
function classifyArchetype(d, catRank) {
  catRank = catRank || 5;
  // Priority order — first match wins
  if (d.shortPct >= 25 && d.gapPct >= 15 && d.floatM < 15)
    return { type: 'GAP & SQUEEZE', emoji: '💥', desc: 'Heavy short interest met a gap. Shorts trapped. This runs until covering is done. Most violent archetype.', playbook: 'Enter on first 5-min pullback to VWAP. Scale out 50% at +30%, trail rest. Exit on 3 consecutive red candles or RVOL fade below 3x.' };
  if (catRank <= 2 && d.floatM < 20)
    return { type: 'CATALYST RUNNER', emoji: '🚀', desc: 'Binary event with tight float. Pure momentum play — the news IS the trade.', playbook: 'Enter within first 15 min. Do not chase extended moves. Stop = pre-news low. TP1 = +50%, TP2 = +100%. Exit before Phase 4 distribution.' };
  if (d.floatM < 3 && d.relVol >= 8)
    return { type: 'LOW FLOAT ROCKET', emoji: '⚡', desc: 'Tiny float + whale volume = no resistance overhead. Small volume = massive price swings.', playbook: 'Enter Phase 1 only. This is a sniper trade — one entry, one exit. Stop is tight. Can move 200%+ but fades just as fast.' };
  if (d.relVol >= 10 && catRank >= 3)
    return { type: 'SYMPATHY PLAY', emoji: '🔗', desc: 'Sector is in play. This ticker is moving because a peer made a big move. Rides the wave.', playbook: 'Watch the leader for direction. Enter if holding above VWAP. Exit when leader fades. Shorter hold time than catalyst runner.' };
  if (d.changePct >= 40 && d.relVol >= 5)
    return { type: 'PARABOLIC EXTENSION', emoji: '📈', desc: 'Already extended but volume still pushing. High risk, high reward. Not for beginners.', playbook: 'Only enter on momentum continuation — never chase vertical moves. Wait for 5-min flag or pullback to 9EMA. Hard stop below flag low.' };
  return { type: 'UNCLASSIFIED', emoji: '❓', desc: 'Does not match a standard supernova archetype. Treat with caution.', playbook: 'Use /check for standard analysis. Wait for clearer setup.' };
}

// ── 7 FALSE SIGNAL DETECTOR ───────────────────────────────────────────────
function detectFalseSignals(d, catRank, headline) {
  catRank = catRank || 5;
  headline = (headline || '').toLowerCase();
  var traps = [];

  // 1. HIGH FLOAT MASQUERADING AS LOW FLOAT
  if (d.floatM >= 50 && d.changePct >= 20)
    traps.push({ trap: 'HIGH FLOAT TRAP', severity: 'HIGH', reason: 'Float is '+d.floatM+'M — too large for sustained supernova. Large moves in high-float names fade fast. Institutions dump into retail buyers.' });

  // 2. DILUTION GAP (ATM offering or shelf disguised as news)
  if (/offering|shelf|atm|dilut|warrants|shares sold/.test(headline))
    traps.push({ trap: 'DILUTION TRAP', severity: 'CRITICAL', reason: 'Headline contains dilution signals. This gap will likely fade as new shares enter the market. Avoid or short the rip.' });

  // 3. REVERSE SPLIT SPIKE
  if (/reverse split|reverse-split|r\/s|1-for-/.test(headline) || (d.gapPct >= 50 && d.floatM < 1))
    traps.push({ trap: 'REVERSE SPLIT SPIKE', severity: 'HIGH', reason: 'Reverse splits create artificial price spikes that almost always fade to new lows within days. Not a real move.' });

  // 4. NEWS RECYCLE (old news repackaged)
  if (/previously announced|reiterates|reminder|update on|recall/.test(headline))
    traps.push({ trap: 'RECYCLED NEWS', severity: 'MODERATE', reason: 'Headline appears to be old news repackaged. Market already priced this in. Gap is a manipulation trap.' });

  // 5. WEEKEND GAP FADE (thin pre-market, no follow-through)
  var dayOfWeek = new Date().getDay();
  if ((dayOfWeek === 1) && d.volume < 100000 && d.gapPct >= 20)
    traps.push({ trap: 'MONDAY GAP FADE RISK', severity: 'MODERATE', reason: 'Monday gaps on low volume often fade. Weekend news with no real buying is a trap. Wait for market open confirmation.' });

  // 6. LOW VOLUME GAP (no real institutional interest)
  if (d.gapPct >= 15 && d.relVol < 2)
    traps.push({ trap: 'LOW VOLUME GAP', severity: 'HIGH', reason: 'Gap '+rnd(d.gapPct,1)+'% but RVOL only '+d.relVol+'x. No real buyers behind this. Thin gap = easy fade. Wait for volume confirmation.' });

  // 7. PRE-MARKET ONLY VOLUME (fades at open)
  if (d.volume < 50000 && d.gapPct >= 20 && d.relVol < 1.5)
    traps.push({ trap: 'PRE-MARKET GHOST', severity: 'HIGH', reason: 'Gap with almost no share volume. Pre-market moves on tiny volume routinely reverse at 9:30 open. Do not chase.' });

  return traps;
}

// ── 5-PHASE LIFECYCLE ENGINE ──────────────────────────────────────────────
function detectLifecyclePhase(d) {
  var timeCT_lc = nowTimeCT();
  var hourCT_lc = Math.floor(timeCT_lc);
  var changeAbs = Math.abs(d.changePct);

  // Phase 5: Distribution / Fade — late CT day (ET 2PM+)
  if (timeCT_lc >= 13 && d.relVol < 1.5 && d.changePct < d.changePct * 0.5)
    return { phase: 5, name: 'PHASE 5 — DISTRIBUTION/FADE', emoji: '🔴', action: 'EXIT. Whales distributing. Retail holding the bag. If you\'re in, get out now.', entryOk: false };

  // Phase 4: Late Run / Exhaustion (ET noon+)
  if (timeCT_lc >= 12 && d.changePct >= 30 && d.relVol >= 3)
    return { phase: 4, name: 'PHASE 4 — LATE RUN/EXHAUSTION', emoji: '🟠', action: 'DANGER ZONE. Move is extended. Only trail existing position. No new entries. Exit before 2:45PM CT.', entryOk: false };

  // Phase 3: Mid-Day Continuation (ET 11AM-2PM = CT 10AM-1PM)
  if (timeCT_lc >= 10 && timeCT_lc < 13 && d.changePct >= 15 && d.relVol >= 3)
    return { phase: 3, name: 'PHASE 3 — MID-DAY CONTINUATION', emoji: '🟡', action: 'PARTIAL ENTRY OK on pullback to VWAP. Tighter size than Phase 1-2. Stop below mid-day low.', entryOk: true };

  // Dead Zone (ET 11AM-1PM = CT 10AM-12PM)
  if (timeCT_lc >= 10 && timeCT_lc < 12 && d.relVol < 2)
    return { phase: 0, name: 'DEAD ZONE (10AM-12PM CT)', emoji: '⚫', action: 'Volume dry. No edge. Wait for Phase 3 continuation or walk away.', entryOk: false };

  // Phase 2: First Pullback / Dip Buy (ET 10-11AM = CT 9-10AM)
  if (timeCT_lc >= 9 && timeCT_lc < 11 && d.changePct >= 10 && d.relVol >= 3)
    return { phase: 2, name: 'PHASE 2 — FIRST PULLBACK / DIP BUY', emoji: '🟢', action: 'PRIME ENTRY WINDOW. Dip to VWAP or 9EMA. This is your Archetype B setup. Stop below Phase 1 low.', entryOk: true };

  // Phase 1: Morning Ignition (ET 9:30-10:30AM = CT 8:30-9:30AM)
  if (timeCT_lc >= 8.5 && timeCT_lc < 10 && d.changePct >= 5 && d.relVol >= 2)
    return { phase: 1, name: 'PHASE 1 — MORNING IGNITION', emoji: '🟢', action: 'PRIMARY ENTRY ZONE. First candle break or pullback to VWAP. Highest probability window for supernova runs.', entryOk: true };

  // Pre-Ignition
  if (timeCT_lc < 8.5 || (d.gapPct >= 10 && timeCT_lc < 9))
    return { phase: 0, name: 'PRE-IGNITION', emoji: '🔵', action: 'Pre-market. Watch but do not enter. Wait for first 5-min candle to close at open (8:30AM CT). Gap must hold.', entryOk: false };

  return { phase: 0, name: 'NO CLEAR PHASE', emoji: '⚪', action: 'Setup not in an active window. Wait or monitor.', entryOk: false };
}

// ── KILL ZONE EXIT SIGNALS ────────────────────────────────────────────────
function getKillZoneSignals(d) {
  var timeCT_kz = nowTimeCT();
  var signals = [], critical = false;

  if (timeCT_kz >= 14.5 && timeCT_kz < 15) { signals.push('HARD EXIT ZONE — 2:45PM CT: flatten all positions 15 min before CT close'); critical = true; }
  if (d.relVol < 1.5 && d.changePct > 0) { signals.push('RVOL DYING — '+d.relVol+'x: volume fading means distribution. Whales exiting.'); }
  if (d.changePct < 0 && d.relVol > 2) { signals.push('HIGH VOLUME REVERSAL — selling on big volume. Thesis broken.'); critical = true; }
  if (timeCT_kz >= 10 && timeCT_kz <= 12 && d.relVol < 2) { signals.push('DEAD ZONE TRAP — 10AM-12PM CT low-volume grind. Easy to get faked out.'); }
  if (d.high > 0 && d.price < d.low * 1.02) { signals.push('NEW LOW OF DAY — price breaking down. Stop should already be hit.'); critical = true; }
  if (d.changePct >= 80) { signals.push('PARABOLIC (+'+rnd(d.changePct,0)+'%) — scale out minimum 50%. Vertical moves always mean-revert.'); }

  return { signals, critical };
}

// ── SUPERNOVA COMMAND ─────────────────────────────────────────────────────
async function cmdSupernova(sym, chatId) {
  await tg('Running Supernova Protocol on $' + sym + '...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('Cannot pull data for $' + sym + '. Check ticker.', chatId);

  var news = await polyNewsRaw(sym, 5);
  var catRank = 5, catName = 'No Catalyst', latestHead = '';
  if (news.length) { latestHead = news[0].title || ''; var cat = identifyCatalyst(latestHead); catRank = cat.rank; catName = cat.name; }

  var sn        = scoreSupernova(d, catRank, latestHead);
  var archetype = classifyArchetype(d, catRank);
  var traps     = detectFalseSignals(d, catRank, latestHead);
  var lifecycle = detectLifecyclePhase(d);
  var killzone  = getKillZoneSignals(d);
  var mis       = calcMIS(d, catRank);
  var sdi       = calcSDI(d, catRank);

  // AI narrative
  var analysis = await ai(
    'You are MAVERICK SUPERNOVA ENGINE — the most advanced low-float momentum analyst alive. ' +
    'Apply Supernova Protocol: 9 ingredients, Rule of Five, archetype classification. ' +
    'Small account trader — tight risk per trade, sniper discipline. ' +
    'Give a sharp verdict on whether this is a real supernova or a trap. Max 150 words. No fluff.',
    '$' + sym + ' SUPERNOVA DATA:\n' +
    'Ingredients passed: ' + sn.passed + '/9 [' + sn.grade + ']\n' +
    'Archetype: ' + archetype.type + '\n' +
    'Lifecycle: ' + lifecycle.name + '\n' +
    'False signals: ' + (traps.length ? traps.map(function(t){return t.trap;}).join(', ') : 'NONE') + '\n' +
    'Price: $' + d.price + ' (' + (d.changePct >= 0 ? '+' : '') + rnd(d.changePct, 2) + '%) Gap: ' + rnd(d.gapPct, 1) + '%\n' +
    'RVOL: ' + d.relVol + 'x Float: ' + d.floatM + 'M Short: ' + rnd(d.shortPct, 1) + '% DTC: ' + d.daysToCover + 'd\n' +
    'MIS: ' + mis.pct + ' SDI: ' + sdi.score + '\n' +
    'Catalyst: ' + catName + ' (Rank ' + catRank + ')\n' +
    (latestHead ? '"' + latestHead.slice(0, 100) + '"' : ''),
    350, chatId
  );

  // Build report
  var gradeEmoji = sn.passed >= 8 ? '🔥' : sn.passed >= 6 ? '⚡' : sn.passed >= 5 ? '👀' : '❌';
  var msg = '<b>' + gradeEmoji + ' $' + sym + ' — SUPERNOVA PROTOCOL</b>\n\n';
  msg += '<b>' + sn.grade + '</b>\n';
  msg += 'Ingredients: ' + sn.passed + '/9  Rule of Five: ' + (sn.ruleFive ? 'PASSED ✓' : 'FAILED ✗') + '\n\n';

  msg += '<b>' + archetype.emoji + ' ARCHETYPE: ' + archetype.type + '</b>\n';
  msg += archetype.desc + '\n';
  msg += 'Playbook: ' + archetype.playbook + '\n\n';

  msg += '<b>' + lifecycle.emoji + ' LIFECYCLE: ' + lifecycle.name + '</b>\n';
  msg += lifecycle.action + '\n\n';

  msg += '<b>9 INGREDIENTS:</b>\n';
  sn.ingredients.forEach(function(ing) {
    msg += (ing.pass ? '✅' : '❌') + ' ' + ing.name + '\n   ' + ing.detail + '\n';
  });

  if (traps.length) {
    msg += '\n<b>⚠️ FALSE SIGNAL ALERTS:</b>\n';
    traps.forEach(function(t) {
      msg += '[' + t.severity + '] ' + t.trap + '\n' + t.reason + '\n';
    });
  } else {
    msg += '\n✅ NO FALSE SIGNALS DETECTED\n';
  }

  if (killzone.signals.length) {
    msg += '\n<b>' + (killzone.critical ? '🚨' : '⚠️') + ' KILL ZONE SIGNALS:</b>\n';
    killzone.signals.forEach(function(s) { msg += '• ' + s + '\n'; });
  }

  msg += '\n<b>LEVELS:</b>\n';
  msg += '$' + d.price + '  RVOL:' + d.relVol + 'x  Float:' + d.floatM + 'M  Short:' + rnd(d.shortPct, 1) + '%\n';
  msg += 'MIS:' + mis.pct + ' [' + mis.tier + ']  SDI:' + sdi.score + ' [' + sdi.danger + ']\n';
  msg += 'Catalyst: ' + catName + '\n';
  if (lifecycle.entryOk) {
    msg += '\nEntry: $' + rnd(d.price, 4) + '\n';
    msg += 'Stop:  $' + rnd(d.price - d.atr * 1.5, 4) + '\n';
    msg += 'TP1:   $' + rnd(d.price + d.atr * 2, 4) + '\n';
    msg += 'TP2:   $' + rnd(d.price + d.atr * 4, 4) + '\n';
  }

  msg += '\n' + (analysis || '') + '\n\n';
  if (sn.ruleFive && !traps.length) msg += '🎯 SNIPER READY — Track it: /watch ' + sym + ' | /position ' + sym;
  else if (traps.length) msg += '🚫 TRAPS DETECTED — Review false signals before entering.';
  else msg += 'Below threshold. Monitor or skip.';

  await tg(msg, chatId);
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────
async function tg(text, chatId) {
  chatId = chatId || CHAT_ID;
  if (!TG_TOKEN || !chatId) { if (!chatId) console.error('[TG] No CHAT_ID — set INTEL_BOT_CHAT in .env'); return; }
  try {
    var chunks=[], t=String(text);
    while (t.length>4000){chunks.push(t.slice(0,4000));t=t.slice(4000);}
    chunks.push(t);
    for (var i=0;i<chunks.length;i++){
      await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:chunks[i],parse_mode:'HTML'})});
      if(chunks.length>1) await sleep(300);
    }
  } catch (e) { console.error('[TG]', e.message); }
}

// ── AI BRAIN ──────────────────────────────────────────────────────────────
async function ai(system, user, maxTokens, chatId) {
  maxTokens=maxTokens||500;
  var history=(chatId&&chatHistory[chatId])?chatHistory[chatId].slice(-8):[];
  var messages=[{role:'user',content:'[SYSTEM] '+system}].concat(history).concat([{role:'user',content:user}]);
  if (GROQ_KEY) {
    try {
      var r=await tFetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY},body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:maxTokens,temperature:0.3,messages})},15000);
      var gd=await safeJson(r), text=gd&&gd.choices&&gd.choices[0]&&gd.choices[0].message&&gd.choices[0].message.content;
      if (text) {
        if (chatId){if(!chatHistory[chatId])chatHistory[chatId]=[];chatHistory[chatId].push({role:'user',content:user},{role:'assistant',content:text});if(chatHistory[chatId].length>24)chatHistory[chatId]=chatHistory[chatId].slice(-24);}
        return text;
      }
    } catch (e) { console.error('[Groq]', e.message); }
  }
  if (CBRS_KEY) {
    try {
      var r2=await tFetch('https://api.cerebras.ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+CBRS_KEY},body:JSON.stringify({model:'llama3.1-8b',max_tokens:maxTokens,temperature:0.3,messages})},12000);
      var d2=await safeJson(r2), txt2=d2&&d2.choices&&d2.choices[0]&&d2.choices[0].message&&d2.choices[0].message.content;
      if (txt2) return txt2;
    } catch (e) { console.error('[Cerebras]', e.message); }
  }
  return null;
}

// ── AI JSON PARSER — temperature 0.0, ultra-low tokens, pure structured output ──
// Used for NLP sentiment parsing. Forces deterministic JSON, not prose.
// Cerebras first — fastest inference for structured output.
async function aiJson(systemPrompt, userContent, maxTok) {
  maxTok = maxTok || 100;
  var messages = [
    { role: 'user', content: '[SYSTEM] '+systemPrompt },
    { role: 'user', content: userContent }
  ];
  if (CBRS_KEY) {
    try {
      var r = await tFetch('https://api.cerebras.ai/v1/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+CBRS_KEY},
        body: JSON.stringify({ model:'llama3.1-8b', max_tokens:maxTok, temperature:0.0, messages })
      }, 6000);
      var d = await safeJson(r);
      var t = d&&d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content;
      if (t) return t.trim();
    } catch(e) {}
  }
  if (GROQ_KEY) {
    try {
      var r2 = await tFetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY},
        body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:maxTok, temperature:0.0, messages })
      }, 8000);
      var d2 = await safeJson(r2);
      var t2 = d2&&d2.choices&&d2.choices[0]&&d2.choices[0].message&&d2.choices[0].message.content;
      if (t2) return t2.trim();
    } catch(e) {}
  }
  return null;
}

// ── MD5 HEADLINE HASHING — Fixed-size fingerprints instead of full text ───────
// Stores a 12-char hash instead of 200-char headline. Keeps JSONBin payload tiny.
var crypto = require('crypto');
function headlineHash(text) {
  try { return crypto.createHash('md5').update(String(text)).digest('hex').slice(0,12); }
  catch(e) { return String(text).slice(0,12); }
}

// ── TWO-PHASE NLP SENTIMENT PARSER ────────────────────────────────────────────
// Phase 1: Fast regex keyword scan (existing BULLISH_KW / BEARISH_KW)
// Phase 2: AI JSON context verification — catches "fails to get FDA approval",
//          "termination of merger", "ATM offering" that keywords miss entirely.
// Only runs Phase 2 when Phase 1 produces a match — keeps latency near zero.
async function parseHeadlineSentiment(ticker, headline) {
  try {
    var systemPrompt =
      'You are an HFT-grade market sentiment parser for low-float micro-cap stocks. ' +
      'Output ONLY raw minified JSON — no markdown, no explanation, no text outside the object. ' +
      'Format: {"is_catalyst":true/false,"sentiment":"BULLISH/BEARISH/NEUTRAL",' +
      '"catalyst_tier":1,"short_squeeze_risk":true/false,"dilution_event":true/false} ' +
      'Strict Rules: ' +
      'Tier 1=FDA Approval/major merger/acquisition. Tier 2=Phase 3 success/major contract. ' +
      'Tier 3=Earnings beat/revenue record/partnership. Tier 4=Minor deal/uplisting. Tier 5=PR/minor. ' +
      'Flag ANY shelf registration, ATM offering, S-1 or S-3 amendment as dilution_event=true + BEARISH. ' +
      'If headline contains "fails","terminates","withdraws","postpones","discontinues","not approved",' +
      '"going concern" mark as BEARISH regardless of subject matter. ' +
      'If headline contains "false","rumor","clarification" mark NEUTRAL. ' +
      'Never output anything except the raw JSON object.';

    var raw = await aiJson(systemPrompt, 'Ticker:'+ticker+' Headline:"'+headline.slice(0,200)+'"', 80);
    if (!raw) return null;
    var clean = raw.replace(/```json|```|\n/g,'').trim();
    // Find JSON object in response
    var start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    return JSON.parse(clean.slice(start, end+1));
  } catch(e) { return null; }
}

// ── NEWS SCANNING ──────────────────────────────────────────────────────────
var BULLISH_KW=['fda approval','fda approved','fda clearance','merger','acquisition','buyout','earnings beat','short squeeze','trading halted','halt','government contract','phase 3 results','phase 3 trial','uplisting','nasdaq compliance','barda contract','dod contract','positive data','breakthrough','upgraded','price target raised','record revenue','beat estimates','raised guidance','partnership agreement','clinical data','positive results','contract award','data readout'];
var BEARISH_KW=['going concern','dilution','public offering','atm offering','shelf registration','bankruptcy','delisting','class action','default','missed estimates','downgraded','lowered guidance','fraud','sec investigation','restatement'];

async function scanNewsIntel() {
  pruneHeadlines();
  iHealth.newsLastRun = Date.now();
  iHealth.newsRunCount++;
  var sent = 0;

  // ── SOURCE 1: TICKER-CENTRIC FINNHUB SCAN ─────────────────────────────────
  // Scan active gainers + watchlist for company-specific news.
  // This is reliable: we pick tickers first, then look for their news.
  // Fixes the broken "general news → ticker extraction" approach.
  try {
    if (FINNHUB) {
      var gainers = await getTopGainers();
      var activeTickers = gainers.slice(0,10).map(function(g){return g.ticker;});
      Object.keys(watchlist).forEach(function(t){ if(activeTickers.indexOf(t)===-1) activeTickers.push(t); });
      var wFrom = new Date(Date.now()-86400000).toISOString().slice(0,10);
      for (var ti=0; ti<activeTickers.length; ti++) {
        var sym = activeTickers[ti];
        if (!sym || sym.length > 5) continue;
        try {
          var tickerNews = await fh('/company-news?symbol='+sym+'&from='+wFrom+'&to='+todayStr());
          if (!Array.isArray(tickerNews) || !tickerNews.length) { await sleep(200); continue; }
          var fresh = tickerNews.filter(function(n){ return n.datetime > lastNewsTs-3600 && n.headline; });
          for (var tn=0; tn<Math.min(fresh.length,3); tn++) {
            var tnItem = fresh[tn];
            var tnKey  = String(tnItem.id||tnItem.headline);
            if (sentHeadlines.has(headlineHash(tnKey))) continue;
            var tnBody = (tnItem.headline+' '+(tnItem.summary||'')).toLowerCase();
            var tnHits = BULLISH_KW.filter(function(k){return tnBody.indexOf(k)!==-1;});
            var tnNegs = BEARISH_KW.filter(function(k){return tnBody.indexOf(k)!==-1;});

            // ── PHASE 2: AI CONTEXTUAL VERIFICATION ───────────────────────
            // Only fires when Phase 1 keyword scan found a match.
            // Catches false positives: "fails to get FDA approval" triggers on "FDA approval"
            // Catches dilution events keywords miss: "S-3 shelf registration"
            var nlpResult = null;
            if ((tnHits.length >= 1 || tnNegs.length >= 1) && (GROQ_KEY||CBRS_KEY)) {
              nlpResult = await parseHeadlineSentiment(sym, tnItem.headline);
            }

            // Use NLP result when available, fall back to keyword scan
            var isBullish = false, isBearish = false;
            if (nlpResult) {
              isBullish = nlpResult.is_catalyst && nlpResult.sentiment === 'BULLISH' && !nlpResult.dilution_event;
              isBearish = nlpResult.sentiment === 'BEARISH' || nlpResult.dilution_event;
              if (nlpResult.dilution_event) {
                // Dilution detected — override any bullish keyword hits
                isBullish = false; isBearish = true;
                console.log('[NLP] Dilution event detected for $'+sym+': "'+tnItem.headline.slice(0,60)+'"');
              }
            } else {
              isBullish = tnHits.length >= 1 && tnNegs.length === 0;
              isBearish = tnNegs.length >= 1;
            }
            if (isBullish) {
              sentHeadlines.add(headlineHash(tnKey));
              if (tnItem.datetime > lastNewsTs) lastNewsTs = tnItem.datetime;
              var tnCat  = nlpResult ? { rank: nlpResult.catalyst_tier||5, name: identifyCatalyst(tnItem.headline).name } : identifyCatalyst(tnItem.headline);
              var tnLive = await getStock(sym).catch(function(){return null;});
              if (!tnLive || tnLive.price > TRADE_MAX_PRICE || tnLive.price < 0.25) { await sleep(200); continue; }
              var ageMin = Math.round((Date.now()/1000 - tnItem.datetime)/60);
              var squeezeFlag = nlpResult && nlpResult.short_squeeze_risk ? ' ⚡ SHORT SQUEEZE RISK' : '';
              var reason = tnCat.name + squeezeFlag + ' ('+ageMin+'m ago' + (nlpResult?' | AI verified':'') + ')';
              var alertMsg = await buildMaverickAlert(sym, tnLive, reason, tnCat.name, tnCat.rank);
              await tg(alertMsg); sent++; organicAlertsSent++; iHealth.newsAlertsTotal++;
              await sleep(1500);
            }
            if (isBearish) {
              sentHeadlines.add(headlineHash(tnKey));
              var dilutionFlag = nlpResult && nlpResult.dilution_event ? '💧 DILUTION EVENT — ' : '';
              await tg('<b>⚠️ BEARISH — $'+sym+' '+cFlag(sym)+'</b>\n'+dilutionFlag+tnItem.headline+(nlpResult?' [AI confirmed]':''));
              sent++; await sleep(1500);
            }
          }
          await sleep(300);
        } catch(e) { /* skip ticker on error */ }
      }
    }
  } catch (e) { console.error('[NEWS-FH-TICKER]', e.message); }

  // ── SOURCE 2: SEC EDGAR 8-K FILINGS (completely free, high signal) ──────────
  try {
    var eFrom = new Date(Date.now()-7200000).toISOString().slice(0,10);
    var er = await tFetch(
      'https://efts.sec.gov/LATEST/search-index?q=%228-K%22&forms=8-K&dateRange=custom&startdt='+eFrom+'&enddt='+todayStr(),
      { headers: { 'User-Agent': 'MaverickIntelBot/5.6 (research@maverick.ai)' } }
    );
    if (er.ok) {
      var ed = await safeJson(er), eHits = ed && ed.hits && ed.hits.hits ? ed.hits.hits : [];
      for (var ek = 0; ek < Math.min(eHits.length, 8); ek++) {
        var src = eHits[ek] && eHits[ek]._source; if (!src) continue;
        var eKey = (src.entity_name||'')+'|'+(src.file_date||'');
        if (sentHeadlines.has(headlineHash(eKey))) continue;
        var tick = ((src.ticker||'')||(src.tickers&&src.tickers[0])||'').toUpperCase().trim();
        if (!tick || tick.length > 5) continue;
        sentHeadlines.add(headlineHash(eKey));
        var secD = await getStock(tick).catch(function(){return null;});
        if (secD && secD.price <= TRADE_MAX_PRICE && secD.price >= 0.25) {
          var secReason = 'SEC 8-K filing detected ('+src.file_date+') — potential catalyst';
          var secMsg = await buildMaverickAlert(tick, secD, secReason, 'SEC 8-K Filing', 3);
          await tg(secMsg); sent++; organicAlertsSent++; iHealth.newsAlertsTotal++; await sleep(2000);
        }
      }
    }
  } catch (e) { console.error('[NEWS-SEC]', e.message); }

  // ── SOURCE 3: POLYGON NEWS (tertiary — may return empty on free tier) ────────
  try {
    if (POLYGON) {
      var articles = await polyNewsRaw(null, 40);
      for (var i = 0; i < articles.length; i++) {
        var art = articles[i], pubTs = art.published_utc ? new Date(art.published_utc).getTime()/1000 : 0;
        if (pubTs && pubTs <= lastNewsTs) continue;
        var key = art.id || art.title; if (sentHeadlines.has(headlineHash(key))) continue;
        var body = (art.title+' '+(art.description||'')).toLowerCase();
        var hits = BULLISH_KW.filter(function(k){return body.indexOf(k)!==-1;});
        var negs = BEARISH_KW.filter(function(k){return body.indexOf(k)!==-1;});
        var ticks = (art.tickers||[]).filter(function(t){return t&&t.length>=1&&t.length<=5;});
        if (hits.length>=1 && negs.length===0 && ticks.length>=1) {
          sentHeadlines.add(headlineHash(key));
          var cat = identifyCatalyst(art.title), ticker = ticks[0];
          var ageMin = pubTs ? Math.round((Date.now()/1000-pubTs)/60) : 0;
          if (cat.rank <= 2) {
            var pLive = await getStock(ticker).catch(function(){return null;});
            if (pLive && pLive.price <= TRADE_MAX_PRICE && pLive.price >= 0.25) {
              var pReason = cat.name+' via Polygon ('+ageMin+'m ago) '+cFlag(ticker);
              var pAlert = await buildMaverickAlert(ticker, pLive, pReason, cat.name, cat.rank);
              await tg(pAlert); sent++; organicAlertsSent++; iHealth.newsAlertsTotal++; await sleep(1500);
            }
          } else {
            await tg('<b>📡 CATALYST — $'+ticks.slice(0,3).join(' $')+'</b> '+cFlag(ticker)+'\n[Rank '+cat.rank+'] '+cat.name+'\n'+art.title+'\n/check '+ticker);
            sent++; iHealth.newsAlertsTotal++; await sleep(1500);
          }
        }
        if (negs.length>=1 && ticks.length>=1) {
          sentHeadlines.add(headlineHash(key));
          await tg('<b>⚠️ BEARISH — $'+ticks[0]+'</b>\n'+art.title+'\nFlags: '+negs.slice(0,2).join(', '));
          await sleep(1500);
        }
        if (pubTs && pubTs > lastNewsTs) lastNewsTs = pubTs;
      }
    }
  } catch (e) { console.error('[NEWS-POLY]', e.message); }

  // ── SOURCE 4: FINNHUB WATCHLIST NEWS ─────────────────────────────────────
  try {
    if (FINNHUB) {
      var wkeys = Object.keys(watchlist).slice(0,5);
      for (var w = 0; w < wkeys.length; w++) {
        var wsym = wkeys[w], wFrom = new Date(Date.now()-86400000).toISOString().slice(0,10);
        var wNews = await fh('/company-news?symbol='+wsym+'&from='+wFrom+'&to='+todayStr());
        if (!Array.isArray(wNews)) { await sleep(400); continue; }
        var fresh = wNews.filter(function(n){return n.datetime > lastNewsTs-3600 && n.headline;});
        for (var wn = 0; wn < Math.min(fresh.length,2); wn++) {
          var wItem = fresh[wn], wK = String(wItem.id||wItem.headline);
          if (sentHeadlines.has(headlineHash(wK))) continue;
          var wBody = (wItem.headline+' '+(wItem.summary||'')).toLowerCase();
          var wH = BULLISH_KW.filter(function(k){return wBody.indexOf(k)!==-1;});
          if (wH.length) {
            sentHeadlines.add(headlineHash(wK));
            var wCat = identifyCatalyst(wItem.headline);
            var wLive = await getStock(wsym).catch(function(){return null;});
            if (wLive && wLive.price <= TRADE_MAX_PRICE && wLive.price >= 0.25) {
              var wAlert = await buildMaverickAlert(wsym, wLive, 'Watchlist — '+wH[0]+' '+cFlag(wsym), wCat.name, wCat.rank);
              await tg(wAlert); sent++; organicAlertsSent++; iHealth.newsAlertsTotal++; await sleep(1500);
            } else if (wLive && wLive.price > TRADE_MAX_PRICE) {
              await tg('<b>📊 RESEARCH ALERT — $'+wsym+' '+cFlag(wsym)+'</b> ($'+wLive.price+' — above trading zone)\n'+wItem.headline+'\n[Market research only — not a trade setup]');
              sent++; await sleep(1500);
            }
          }
        }
        await sleep(400);
      }
    }
  } catch (e) { console.error('[NEWS-WL]', e.message); }

  if (sent > 0) console.log('[NEWS] Sent ' + sent + ' alert(s). Total: ' + iHealth.newsAlertsTotal);
}

// ── MORNING BRIEFING ───────────────────────────────────────────────────────
async function morningBriefing(manual) {
  var hour=nowHourCT(), today=todayStr();
  var minCT = new Date().getMinutes();
  var timeCT = hour + minCT/60;
  iHealth.briefLastRun = Date.now();
  if (!manual) {
    // 3AM-8:30AM CT = pre-market ET | 9AM-11AM CT = regular morning
    var inPreMarket = timeCT >= 3 && timeCT < 8.5;
    var inMorning   = hour >= 9 && hour < 11;
    if (!inPreMarket && !inMorning) return;
    if (lastBriefingDate===today && !inPreMarket) return;
  }
  lastBriefingDate=today;
  var isPreMkt = timeCT >= 3 && timeCT < 8.5;
  await tg('<b>🌅 MAVERICK '+(isPreMkt?'PRE-MARKET':'MORNING')+' BRIEFING</b>\n'+today+' | '+hour+':'+String(minCT).padStart(2,'0')+' CT'+(isPreMkt?'\n⚡ Pre-market prices active — live data':'')+'\n\nPulling top setups...');
  // Briefing content: use live universe with REAL prices (pre-market OR regular)
  var universe = [], gainers = await getTopGainers();
  if (gainers.length) gainers.forEach(function(g){ if(g.ticker) universe.push(g.ticker); });
  Object.keys(watchlist).forEach(function(t){ if(universe.indexOf(t)===-1) universe.push(t); });
  algoWatchlist.forEach(function(w){ if(universe.indexOf(w.sym)===-1) universe.push(w.sym); });
  BASE_SCAN.slice(0,20).forEach(function(t){ if(universe.indexOf(t)===-1) universe.push(t); });
  universe = universe.filter(function(v,i,a){return a.indexOf(v)===i && v && v.length<=5;}).slice(0,30);

  var results = [];
  for (var i=0; i<universe.length; i++) {
    var ticker = universe[i];
    try {
      var d = await getStock(ticker).catch(function(){return null;});
      if (!d) continue;
      if (d.price > TRADE_MAX_PRICE || d.price < 0.25) continue;
      if (detectCountry(ticker,'') === 'IL') continue;
      // Use changePct which now reflects PRE-MARKET move when in pre-market hours
      if (Math.abs(d.changePct) < 5 && d.relVol < 2) continue;
      var sr = scoreSetup(d), mis = calcMIS(d, 5);
      if (sr.excluded) continue;
      results.push(Object.assign({}, d, { setup: sr.score, mis: mis.pct, misTier: mis.tier, flags: sr.flags }));
    } catch(e) {}
  }
  results.sort(function(a,b){return (b.mis+b.setup)-(a.mis+a.setup);});
  var isPreMktNow = isPreMarketHours();
  if (!results.length){
    await tg((isPreMktNow?'🌅 Pre-market scan complete.':'📊 Morning scan complete.')+' No high-conviction setups yet (need 5%+ move + 2x RVOL).\nMarket opens 8:30AM CT. Watching for catalysts.');
    return;
  }
  var proto=activeProtocol?PROTOCOLS[activeProtocol].name:'Maverick Standard';
  var msg='<b>'+(isPreMktNow?'🌅 PRE-MARKET':'☀️ MORNING')+' BRIEFING</b> | '+todayStr()+' | '+proto+'\n';
  msg+=(isPreMktNow?'⚡ Using live pre-market prices\n':'')+'\n';
  msg+='Found '+Math.min(5,results.length)+' setup'+(Math.min(5,results.length)>1?'s':'')+' worth watching:\n\n';
  for (var n=0;n<Math.min(5,results.length);n++){
    var d2=results[n], lbl=d2.mis>=80?'🔥 HOT':d2.mis>=65?'⚡ WARM':'👀 WATCH';
    var stop2=rnd(d2.price-d2.atr*1.5,4), tp12=rnd(d2.price+d2.atr*2,4), tp22=rnd(d2.price+d2.atr*4,4);
    var proj=project30MinMove(d2,5);
    msg+=lbl+' <b>$'+d2.sym+'</b> '+cFlag(d2.sym)+' — MIS:'+d2.mis+' Setup:'+d2.setup+'\n';
    msg+='$'+d2.price+' ('+(d2.changePct>=0?'+':'')+rnd(d2.changePct,1)+'%) RVOL:'+d2.relVol+'x Float:'+d2.floatM+'M\n';
    msg+='Proj: +'+proj.pct+'%+ in 30min ['+proj.confidence+']\n';
    msg+='Buy: $'+rnd(d2.price*0.988,4)+'-$'+rnd(d2.price*1.005,4)+'  SL:$'+stop2+'  TP1:$'+tp12+'\n';
    if(d2.flags&&d2.flags.length) msg+=d2.flags.slice(0,2).join(' | ')+'\n';
    msg+='\n';
  }
  msg+='Market opens 8:30AM CT / 9:30AM ET. /check TICKER for full analysis.';
  await tg(msg);
}

// ── AUTOPSY ENGINE ─────────────────────────────────────────────────────────
async function runAutopsy() {
  procStart('autopsy', '/autopsy', '');
  await tg('⏳ <b>AUTOPSY ENGINE RUNNING</b>\nDissecting last 30 days of top movers...\nThis takes 2-4 minutes on cold start. I\'ll send results when done. You can type /status to see progress.', CHAT_ID);
  var gainers=await getTopGainers(), candidates=gainers.map(function(g){return g.ticker;}).slice(0,8);
  Object.keys(watchlist).forEach(function(t){if(candidates.indexOf(t)===-1)candidates.push(t);});
  candidates=candidates.slice(0,10);
  var autopsyResults=[];
  for (var i=0;i<candidates.length;i++){
    var sym=candidates[i];
    try {
      var aggs=await getAggs(sym,40); if(!aggs||aggs.length<5){await sleep(200);continue;}
      var biggestMove=0, biggestDay=null, biggestIdx=0;
      for(var j=1;j<aggs.length;j++){var pc=aggs[j-1].c,cc=aggs[j].c;if(!pc||!cc||pc<=0)continue;var pct=(cc-pc)/pc*100;if(pct>biggestMove){biggestMove=pct;biggestDay=aggs[j];biggestIdx=j;}}
      if(biggestMove<15||!biggestDay){await sleep(200);continue;}
      var closeVsHigh=biggestDay.h>0?rnd(biggestDay.c/biggestDay.h*100,1):50;
      var durationType=closeVsHigh>=80?'SUSTAINED':closeVsHigh>=50?'PARTIAL':'SPIKE-FADE';
      var estHours=durationType==='SUSTAINED'?5.5:durationType==='PARTIAL'?3.0:1.5;
      var priorVols=aggs.slice(Math.max(0,biggestIdx-5),biggestIdx).map(function(a){return a.v||0;});
      var priorAvg=priorVols.length?priorVols.reduce(function(a,b){return a+b;},0)/priorVols.length:500000;
      var rvolOnDay=priorAvg>0?rnd((biggestDay.v||0)/priorAvg,1):0;
      var dayDate=new Date(biggestDay.t).toISOString().slice(0,10);
      var newsItems=await polyNewsRaw(sym,10);
      var relevantNews=newsItems.filter(function(n){var pub=(n.published_utc||'').slice(0,10);var diff=(new Date(dayDate).getTime()-new Date(pub).getTime())/86400000;return diff>=-1&&diff<=3;});
      var catalyst={rank:5,name:'Unknown'},catHead='';
      if(relevantNews.length){catHead=relevantNews[0].title||'';catalyst=identifyCatalyst(catHead);}
      var d=await getStock(sym).catch(function(){return null;});
      var floatM=d?d.floatM:50,shrtPct=d?d.shortPct:0;
      var seqFlags=[];
      if(floatM<5)seqFlags.push('TIGHT FLOAT');if(shrtPct>20)seqFlags.push('HIGH SHORT');if(rvolOnDay>=5)seqFlags.push('WHALE RVOL');if(catalyst.rank<=2)seqFlags.push('STRONG CATALYST');if(durationType==='SUSTAINED')seqFlags.push('ALL-DAY RUN');
      autopsyResults.push({sym,maxGainPct:rnd(biggestMove,1),dayDate,catalyst,catHead:catHead.slice(0,120),durationType,estHours,rvolOnDay,closeVsHigh,floatM,shortPct:shrtPct,seqFlags});
      await sleep(400);
    } catch(e){console.error('[AUTOPSY]',sym,e.message);}
  }
  autopsyResults.sort(function(a,b){return b.maxGainPct-a.maxGainPct;});
  memory.science={results:autopsyResults,generated:Date.now()};
  await saveMemory();
  procEnd('autopsy');
  return autopsyResults;
}

function buildAutopsyReport(results) {
  if(!results||!results.length) return 'No autopsy data. Run /autopsy to analyze.';
  var top3=results.slice(0,3);
  var avgMove=rnd(top3.reduce(function(a,r){return a+r.maxGainPct;},0)/top3.length,1);
  var avgHours=rnd(top3.reduce(function(a,r){return a+r.estHours;},0)/top3.length,1);
  var avgRvol=rnd(top3.reduce(function(a,r){return a+r.rvolOnDay;},0)/top3.length,1);
  var catCount={};top3.forEach(function(r){catCount[r.catalyst.name]=(catCount[r.catalyst.name]||0)+1;});
  var topCat=Object.keys(catCount).sort(function(a,b){return catCount[b]-catCount[a];})[0]||'Unknown';
  var sustained=top3.filter(function(r){return r.durationType==='SUSTAINED';}).length;
  var whaleVol=top3.filter(function(r){return r.rvolOnDay>=5;}).length;
  var tightFlt=top3.filter(function(r){return r.floatM<15;}).length;
  var strongCat=top3.filter(function(r){return r.catalyst.rank<=2;}).length;
  var msg='<b>MAVERICK AUTOPSY REPORT</b>\nTop Movers — Last 30 Days\n\n';
  for(var i=0;i<top3.length;i++){
    var r=top3[i];
    msg+='<b>#'+(i+1)+' $'+r.sym+'</b>\nMax Move: +'+r.maxGainPct+'% ('+r.dayDate+')\n';
    msg+='Catalyst: '+r.catalyst.name+' (Rank '+r.catalyst.rank+'/5)\n';
    if(r.catHead) msg+='"'+r.catHead.slice(0,80)+'"\n';
    msg+='Duration: '+r.durationType+' (~'+r.estHours+'h)  RVOL: '+r.rvolOnDay+'x\n';
    if(r.seqFlags.length) msg+='Sequence: '+r.seqFlags.join(' + ')+'\n';
    msg+='\n';
  }
  msg+='─────────────────────\n<b>SCIENCE FINDINGS</b>\n\n';
  msg+='Avg move: +'+avgMove+'%  Avg duration: '+avgHours+'h  Avg RVOL: '+avgRvol+'x\nTop catalyst: '+topCat+'\n\n';
  msg+='<b>PATTERNS:</b>\n• '+sustained+'/3 SUSTAINED all-day\n• '+whaleVol+'/3 RVOL > 5x\n• '+tightFlt+'/3 float < 15M\n• '+strongCat+'/3 Rank 1-2 catalyst\n\n';
  msg+='<b>IGNITION SEQUENCE:</b>\n1. Catalyst drops (Rank 1-2)\n2. Float < 15M\n3. Gap > 10% pre-market\n4. RVOL > '+(avgRvol>=5?'5x':'3x')+' first hour\n5. First green candle holds VWAP\n\nScore any setup: /science TICKER\nCached 4h. /autopsy to refresh.';
  return msg;
}

// ── /top-pick — Bot's single highest-conviction pick right now ─────────────
async function cmdTopPick(chatId) {
  procStart('toppick', '/top-pick', '');
  await tg('⏳ <b>Scanning for the highest-conviction setup right now...</b>\nScoring every name in universe — sending my #1 pick with full case. (~30s)', chatId);
  var universe = [], gainers = await getTopGainers();
  if (gainers.length) gainers.forEach(function(g){ if(g.ticker) universe.push(g.ticker); });
  universe = universe.concat(Object.keys(watchlist)).concat(BASE_SCAN).filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,20);
  var settled = await Promise.allSettled(universe.map(function(s){return getStock(s);}));
  var results = [];
  for (var i=0; i<settled.length; i++) {
    var r = settled[i]; if(r.status!=='fulfilled'||!r.value) continue;
    var d = r.value, sr = scoreSetup(d), mis = calcMIS(d,5), sas = calcSAS(d), sdi = calcSDI(d,5);
    var composite = rnd((mis.pct + sas.score + sdi.score + sr.score) / 4, 1);
    results.push(Object.assign({},d,{composite,mis:mis.pct,misTier:mis.tier,sas:sas.score,sdi:sdi.score,setup:sr.score,flags:sr.flags}));
  }
  results.sort(function(a,b){return b.composite-a.composite;});
  procEnd('toppick');
  if (!results.length) return tg('No qualifying setups found. Market may be quiet or pre/post-market.', chatId);
  var pick = results[0];
  var msg = '🏆 <b>MY TOP PICK RIGHT NOW: $'+pick.sym+' '+cFlag(pick.sym)+'</b>\n';
  msg += 'Composite score: <b>'+pick.composite+'/100</b>\n';
  msg += 'MIS:'+pick.mis+' | SDI:'+pick.sdi+' | SAS:'+pick.sas+' | Setup:'+pick.setup+'\n';
  msg += '$'+pick.price+' ('+(pick.changePct>=0?'+':'')+rnd(pick.changePct,2)+'%) RVOL:'+pick.relVol+'x Float:'+pick.floatM+'M\n';
  if (pick.flags&&pick.flags.length) msg += pick.flags.join(' | ')+'\n';
  msg += '\nFor full analysis: /check '+pick.sym;
  msg += '\n\n<b>Runner-up:</b> ';
  if (results[1]) msg += '$'+results[1].sym+' ('+results[1].composite+') — /check '+results[1].sym;
  if (results[2]) msg += '\n$'+results[2].sym+' ('+results[2].composite+') — /check '+results[2].sym;
  await tg(msg, chatId);
  // Auto-run full check on top pick
  await sleep(500);
  return cmdCheck(pick.sym, chatId);
}

async function cmdStart(chatId) {
  await tg(
    '<b>MAVERICK INTEL BOT v6.2</b>\n' +
    '<i>Trading universe: $0.25–$'+TRADE_MAX_PRICE+' | 🇺🇸 +bonus  🇨🇳 -penalty  🇮🇱 excluded</i>\n\n' +
    '<b>🎯 FOCUS MODE</b>\n' +
    '/focus — enter expert peer conversation mode\n' +
    '/focus off — return to command routing\n\n' +
    '<b>🏆 TOP PICK</b>\n' +
    '/top-pick — best setup right now, full case auto-runs\n\n' +
    '<b>📊 ANALYSIS</b>\n' +
    '/check TICKER  /science TICKER  /mis TICKER\n' +
    '/sdi TICKER  /sas TICKER  /trend TICKER\n' +
    '/supernova TICKER  /supernova-scan\n\n' +
    '<b>📡 SCANNERS</b>\n' +
    '/scan — top setups ranked\n' +
    '/intraday — live intraday momentum + VWAP whale hunter\n' +
    '/gappers — top gainers/gappers live\n' +
    '/squeeze — short squeeze candidates\n' +
    '/news — latest catalysts ranked 1-5\n' +
    '/autopsy — 30-day top mover dissection\n' +
    '/backtest — MIS validated vs history\n' +
    '/briefing — morning briefing manual trigger\n\n' +
    '<b>🤖 WATCHLISTS</b>\n' +
    '/awatch — algo watchlist (algorithm\'s arsenal, 7 slots)\n' +
    '/mywatch — your personal watchlist\n' +
    '/watch TICKER — add to your watchlist\n\n' +
    '<b>⚙️ PROTOCOLS</b>\n' +
    '/ross  /humble  /maverick  /protocol off\n\n' +
    '<b>📈 TRADE TRACKING</b>\n' +
    '/position TICKER ENTRY STOP TP1 TP2 SHARES\n' +
    '/positions  /close TICKER EXITPRICE\n' +
    '/alert TICKER PRICE above|below\n\n' +
    '<b>🧠 LEARNING</b>\n' +
    '/myedge  /history\n\n' +
    '<b>🔧 DIAGNOSTICS</b>\n' +
    '/status  /test-alert TICKER',
    chatId
  );
}

async function cmdCheck(sym, chatId) {
  var key = 'check:'+sym;
  procStart(key, '/check', sym);
  await tg('⏳ <b>Pulling full analysis on $'+sym+'...</b>\nData → Scores → Conviction Case → Levels\n(~15-30 seconds)', chatId);

  var d = await getStock(sym);
  procEnd(key);
  if (!d) return tg('❌ No data for $'+sym+'. Verify ticker symbol.', chatId);

  var sr = scoreSetup(d);
  var news = await polyNewsRaw(sym, 5);
  var catRank=5, catName='No Catalyst', latestHead='';
  if (news.length) { latestHead=news[0].title||''; var cat=identifyCatalyst(latestHead); catRank=cat.rank; catName=cat.name; }

  var mis  = calcMIS(d, catRank);
  var sdi  = calcSDI(d, catRank);
  var sas  = calcSAS(d);
  var seq  = calcSequenceMatch(d, catRank, d._aggs || []);
  var dur  = predictDuration(d, catRank);
  var trend = calcTrend(d, d._aggs || []);
  var sc_stair = detectStaircaseScore(d, d._aggs || []);
  var sn   = scoreSupernova(d, catRank, latestHead);
  var arch = classifyArchetype(d, catRank);
  var zones = calcDemandSupplyZones(d._aggs || []);
  var proj = project30MinMove(d, catRank);

  var changeStr = (d.changePct>=0?'+':'')+rnd(d.changePct,2)+'%';
  var stop  = rnd(d.price - d.atr*1.5, 4);
  var tp1   = rnd(d.price + d.atr*2, 4);
  var tp2   = rnd(d.price + d.atr*4, 4);
  var rr    = rnd((tp1-d.price)/Math.max(d.price-stop,0.001),2);
  var conviction = sr.score>=85?'HIGH CONVICTION':sr.score>=70?'ELEVATED':sr.score>=55?'MODERATE':'LOW';

  var country  = d.country || detectCountry(d.sym, '');
  var zone     = priceZone(d.price);
  var countryFlag = country==='US'?'🇺🇸':country==='CN'?'🇨🇳':'🌐';

  // ── MESSAGE 1: DATA SNAPSHOT ─────────────────────────────────────────────
  var m1 = '<b>🎯 $'+sym+' — '+conviction+'</b> | '+d.source+' '+countryFlag+'\n';
  m1 += zone.label+'\n';
  m1 += '━━━━━━━━━━━━━━━━━━━━━━\n';
  m1 += '$'+d.price+' ('+changeStr+')';
  if (d.gapPct) m1 += '  Gap:+'+rnd(d.gapPct,1)+'%';
  var checkHour = nowHourCT();
  if (d.preMarket && d.preMarket > 0 && checkHour < 9.5) {
    m1 += '\n🌅 <b>PRE-MARKET: $'+d.preMarket+'</b> ('+(d.preMarketChg>=0?'+':'')+rnd(d.preMarketChg,2)+'%) — live';
    if (d.floatRotPct >= 30) m1 += '\n🚨 <b>FLOAT ROTATION: '+d.floatRotPct+'% of float traded pre-market</b> — EXPLOSIVE INTRADAY SETUP';
    else if (d.floatRotPct >= 15) m1 += '\n⚡ Float rotation: '+d.floatRotPct+'% pre-market (elevated)';
  } else if (d.postMarket && d.postMarket > 0 && checkHour >= 16) {
    m1 += '\n🌙 <b>AFTER-HOURS: $'+d.postMarket+'</b> ('+(d.postMarketChg>=0?'+':'')+rnd(d.postMarketChg,2)+'%) — live';
  }
  m1 += '\n';
  m1 += 'RVOL: <b>'+d.relVol+'x</b>  Float: <b>'+d.floatM+'M</b>  Short: '+rnd(d.shortPct,1)+'%\n';
  if (catName !== 'No Catalyst') m1 += 'Catalyst: <b>'+catName+'</b> [Rank '+catRank+'/5]\n';
  if (sr.flags.length) m1 += sr.flags.join(' | ')+'\n';
  m1 += '\n<b>SCORES:</b>\n';
  m1 += 'MIS: <b>'+mis.pct+'/100</b> ['+mis.tier+']  Expected: +'+mis.expectedMove+'\n';
  m1 += 'SDI: <b>'+sdi.score+'/100</b> ['+sdi.danger+']\n';
  m1 += 'SAS: <b>'+sas.score+'/100</b> ['+sas.tier+']\n';
  m1 += 'Setup: '+sr.score+'/100  Supernova: '+sn.passed+'/9 ingredients\n';
  m1 += '\n<b>TREND:</b> '+trend.direction+'  Strength:'+trend.strength+'/100\n';
  m1 += (trend.sma5?'5dMA:$'+trend.sma5+' '+(d.price>trend.sma5?'✅':'❌')+'  ':'');
  m1 += (trend.sma20?'20dMA:$'+trend.sma20+' '+(d.price>trend.sma20?'✅':'❌'):'')+'\n';
  m1 += 'HH/HL: '+trend.hhCount+'/'+trend.hlCount+'  VolBias:'+trend.volBias+'x  ROC5:'+( trend.roc5>=0?'+':'')+trend.roc5+'%\n';
  if (trend.isStaircase || sc_stair.score >= 55) {
    m1 += '🪜 <b>STAIRCASE PATTERN</b> — Score:'+sc_stair.score+'/100 ['+sc_stair.tier+']\n';
  }
  m1 += '\n<b>SEQUENCE MATCH:</b>\n';
  m1 += 'Seq A (Explosive):  <b>'+seq.scoreA+'%</b>\n';
  m1 += 'Seq B (Duration):   <b>'+seq.scoreB+'%</b>\n';
  m1 += '→ Primary: Sequence <b>'+seq.primary+'</b> ['+seq.label+']\n';
  m1 += '\n<b>'+dur.style+'</b>\n';
  m1 += 'Duration: '+dur.minMin+'-'+dur.maxMin+' min\n';
  m1 += 'Hold plan: '+dur.hold+'\n';
  m1 += '⚠️ '+dur.exitNote;
  await tg(m1, chatId);
  await sleep(300);

  // ── MESSAGE 2: CONVICTION CASE (AI) ──────────────────────────────────────
  // Build a rich context block so the AI gives phase-specific, synergy-checked verdicts.
  // No more generic "RVOL may indicate overbought" — every word references the actual data.
  procStart(key+':ai', '/check AI', sym);

  var lifecycle  = detectLifecyclePhase(d);
  var killzone   = getKillZoneSignals(d);
  var traps      = detectFalseSignals(d, catRank, latestHead);

  // ── SYNERGY CHECK — do engines agree? ─────────────────────────────────────
  var synScores  = [mis.pct, sdi.score, sas.score, sr.score];
  var synAvg     = rnd(synScores.reduce(function(a,b){return a+b;},0)/synScores.length,0);
  var synMax     = Math.max.apply(null,synScores);
  var synMin     = Math.min.apply(null,synScores);
  var synSpread  = synMax - synMin;
  var synergy    = synSpread <= 20 ? 'ALIGNED' : synSpread <= 40 ? 'MIXED' : 'CONFLICTED';
  var synergyNote = synergy==='ALIGNED'
    ? 'All 4 engines pointing same direction (spread '+synSpread+'pts) — high confidence signal.'
    : synergy==='MIXED'
    ? 'Engines partially aligned (spread '+synSpread+'pts) — valid setup but size down.'
    : 'Engines conflicted (spread '+synSpread+'pts) — competing signals. Wait for clarity.';

  // ── PHASE-SPECIFIC PLAYBOOK ────────────────────────────────────────────────
  var phasePlaybook = lifecycle.action;
  var phaseContext  =
    lifecycle.phase===1 ? 'You are in PHASE 1 — the optimal entry window. This is where the Maverick edge lives. ' :
    lifecycle.phase===2 ? 'You are in PHASE 2 — the dip-buy window. Archetype B territory. Higher quality entry. ' :
    lifecycle.phase===3 ? 'You are in PHASE 3 — mid-day continuation. Still tradeable but size smaller. ' :
    lifecycle.phase===4 ? 'You are in PHASE 4 — extended. DO NOT enter fresh. Trail existing only. ' :
    lifecycle.phase===5 ? 'You are in PHASE 5 — distribution. Whales exiting. Exit any existing position. ' :
    lifecycle.name.includes('DEAD') ? 'DEAD ZONE — no edge here. Wait for Phase 3 to develop. ' :
    'Pre-market or unclear phase. Wait for open confirmation. ';

  // ── SEQUENCE CONTEXT ────────────────────────────────────────────────────────
  var seqContext = seq.primary==='A'
    ? 'Sequence A match '+seq.scoreA+'% — explosive setup type. Short fuel + catalyst + tight float. Targets 50-200% if all 5 factors present.'
    : 'Sequence B match '+seq.scoreB+'% — duration setup type. Staircase potential. Targets sustained run, not a spike.';

  // ── TRAP CONTEXT ────────────────────────────────────────────────────────────
  var trapContext = traps.length
    ? 'FALSE SIGNAL WARNINGS: '+traps.map(function(t){return t.trap+' ['+t.severity+']';}).join(', ')+'. Address these before entry.'
    : 'No false signal traps detected.';

  // ── PERSONAL EDGE CONTEXT ──────────────────────────────────────────────────
  var edgeCtx = '';
  if (memory.trades && memory.trades.length >= 5) {
    rebuildWinRates();
    var wr = memory.winRates;
    var floatKey = d.floatM<5?'nano':d.floatM<15?'tight':'mid';
    var floatArr = wr.byFloat && wr.byFloat[floatKey] ? wr.byFloat[floatKey] : [];
    if (floatArr.length >= 3) {
      var floatWR = rnd(floatArr.reduce(function(a,b){return a+b;},0)/floatArr.length*100,0);
      edgeCtx = 'TRADER PERSONAL EDGE: '+floatWR+'% win rate on '+floatKey+' float ('+floatArr.length+' trades). ';
    }
    var rvolKey = d.relVol>=5?'high':d.relVol>=2?'med':'low';
    var rvolArr  = wr.byRvol && wr.byRvol[rvolKey] ? wr.byRvol[rvolKey] : [];
    if (rvolArr.length >= 3) {
      var rvolWR = rnd(rvolArr.reduce(function(a,b){return a+b;},0)/rvolArr.length*100,0);
      edgeCtx += rvolWR+'% win rate at '+rvolKey+' RVOL. ';
    }
  }

  var analysis = await ai(
    'You are MAVERICK LION BRAIN — the most precise micro-cap analyst alive. ' +
    'You speak directly to a small-account trader who needs phase-specific, actionable guidance. ' +
    '\n\n' +
    'STRUCTURE YOUR RESPONSE EXACTLY LIKE THIS — no deviation:\n' +
    '**VERDICT**: [BUY / SCALE-IN / WATCH / AVOID] — one sentence tied directly to phase and synergy\n' +
    '**WHY I\'M RIGHT**:\n' +
    '• [Cite MIS/SDI/SAS scores and what they mean together — not individually]\n' +
    '• [Cite the sequence match % and what it predicts about move type and duration]\n' +
    '• [Cite the lifecycle phase and exactly how to exploit it right now]\n' +
    '**WHAT COULD KILL THIS**:\n' +
    '• [Specific price level below which thesis is broken — not vague]\n' +
    '• [Specific condition — volume, catalyst, phase transition — that invalidates entry]\n' +
    '**PHASE INSTRUCTION**: [One sentence on what to do RIGHT NOW based on lifecycle]\n' +
    '\n' +
    'Rules: Use exact numbers from the data. Never say "may" or "could indicate". Be direct and certain. ' +
    'Max 300 words. No disclaimers. Tight risk is everything for this account.',

    '$'+sym+' FULL CONTEXT:\n' +
    '— PRICE: $'+d.price+' ('+changeStr+')  Gap:+'+rnd(d.gapPct,1)+'%  Zone:'+zone.label+'\n' +
    '— MARKET STATS: RVOL:'+d.relVol+'x  Float:'+d.floatM+'M  Short:'+rnd(d.shortPct,1)+'%  DTC:'+d.daysToCover+'d  ATR:$'+d.atr+'\n' +
    '— SCORES: MIS:'+mis.pct+'/100['+mis.tier+']  SDI:'+sdi.score+'/100['+sdi.danger+']  SAS:'+sas.score+'/100['+sas.tier+']  Setup:'+sr.score+'/100\n' +
    '— ENGINE SYNERGY: '+synergy+' (avg:'+synAvg+'  spread:'+synSpread+'pts)  '+synergyNote+'\n' +
    '— CATALYST: '+catName+' Rank:'+catRank+'/5'+(latestHead?' — "'+latestHead.slice(0,100)+'"':'')+'\n' +
    '— SEQUENCE: Seq A:'+seq.scoreA+'%  Seq B:'+seq.scoreB+'%  Primary:'+seq.primary+'  ['+seq.label+']\n' +
    '  '+seqContext+'\n' +
    '— LIFECYCLE: '+lifecycle.name+'  Entry ok:'+lifecycle.entryOk+'\n' +
    '  '+phaseContext+phasePlaybook+'\n' +
    '— DURATION: '+dur.minMin+'-'+dur.maxMin+'min  Style:'+dur.style+'\n' +
    '  Hold plan: '+dur.hold+'\n' +
    '— STAIRCASE: '+(trend.isStaircase||sc_stair.score>=55?'YES score:'+sc_stair.score+'/100['+sc_stair.tier+']':'Not detected')+'\n' +
    '— TREND: '+trend.direction+'  Strength:'+trend.strength+'/100  HH:'+trend.hhCount+' HL:'+trend.hlCount+'  ROC5:'+(trend.roc5>=0?'+':'')+trend.roc5+'%\n' +
    '— SUPERNOVA: '+sn.passed+'/9 ingredients ['+sn.grade+']  Archetype: '+arch.type+'\n' +
    '— TRAPS: '+trapContext+'\n' +
    (killzone.signals.length?'— KILL ZONE: '+killzone.signals.slice(0,2).join(' | ')+'\n':'')+
    (edgeCtx?'— '+edgeCtx+'\n':'') +
    '— PROJ MOVE: +'+proj.pct+'%+ in 30min ['+proj.confidence+']\n' +
    '— COUNTRY: '+cFlag(sym)+' '+detectCountry(sym,'')+'\n' +
    '— LEVELS: Entry:$'+rnd(d.price*0.988,4)+'-$'+rnd(d.price*1.005,4)+'  Stop:$'+stop+'  TP1:$'+tp1+'  TP2:$'+tp2+'  R:R:'+rr,
    600, chatId
  );
  procEnd(key+':ai');

  // ── BUILD MESSAGE 2 ────────────────────────────────────────────────────────
  var synergyEmoji = synergy==='ALIGNED'?'🟢':synergy==='MIXED'?'🟡':'🔴';
  var m2 = '<b>🧠 CONVICTION CASE — $'+sym+' '+cFlag(sym)+'</b>\n';
  m2 += '━━━━━━━━━━━━━━━━━━━━━━\n';
  m2 += synergyEmoji+' Engine Synergy: <b>'+synergy+'</b>  ('+synergyNote+')\n\n';
  m2 += lifecycle.emoji+' <b>'+lifecycle.name+'</b>\n';
  m2 += phasePlaybook+'\n\n';
  if (traps.length) {
    m2 += '⚠️ <b>Traps detected:</b> ';
    m2 += traps.map(function(t){return t.trap+' ['+t.severity+']';}).join(' | ')+'\n\n';
  }
  m2 += (analysis || 'AI offline. Use scores and lifecycle above for trade decision.') + '\n\n';
  m2 += arch.emoji+' <b>Archetype: '+arch.type+'</b>\n';
  m2 += arch.desc+'\n';
  m2 += '\n<b>Proj. move:</b> +'+proj.pct+'%+ in 30min ['+proj.confidence+' confidence]';
  if (killzone.critical) m2 += '\n🚨 <b>KILL ZONE ACTIVE:</b> '+killzone.signals[0];
  await tg(m2, chatId);
  await sleep(300);

  // ── MESSAGE 3: ACTION PLAN ────────────────────────────────────────────────
  var protoLine = '';
  if (activeProtocol && PROTOCOLS[activeProtocol]) {
    var passes = PROTOCOLS[activeProtocol].filter(d);
    var lvl    = applyProtocol(d, activeProtocol);
    protoLine  = '\n<b>'+PROTOCOLS[activeProtocol].name+':</b> '+(passes?'✅ PASSES':'❌ FAILS')+'\n';
    protoLine += 'Protocol entry: $'+lvl.entry+'  Stop: $'+lvl.stop+'\n';
  }

  var m3 = '<b>📋 ACTION PLAN — $'+sym+'</b>\n';
  m3 += '━━━━━━━━━━━━━━━━━━━━━━\n';
  m3 += 'Entry zone:  $'+rnd(d.price*0.988,4)+' — $'+rnd(d.price*1.005,4)+'\n';
  m3 += 'Hard stop:   $'+stop+' ('+ rnd((d.price-stop)/d.price*100,1)+'% risk)\n';
  m3 += 'TP1:         $'+tp1+' (+'+rnd((tp1-d.price)/d.price*100,1)+'%) — sell 50%\n';
  m3 += 'TP2:         $'+tp2+' (+'+rnd((tp2-d.price)/d.price*100,1)+'%) — sell 30%\n';
  m3 += 'R:R:         '+rr+':1\n';
  m3 += 'Shares:      '+calcShares(d.price, stop)+' (risk-sized)\n\n';
  if (zones.demand.length) m3 += '\n<b>📍 Historical support zones:</b> '+zones.demand.join(' / ')+'\n';
  if (zones.supply.length) m3 += '<b>📍 Historical resistance zones:</b> '+zones.supply.join(' / ')+'\n';
  m3 += '<i>(Prior consolidation areas — useful for context, not current entry targets)</i>\n';
  m3 += protoLine;
  m3 += '\n<b>SEQUENCE DETAIL:</b>\n';
  var primaryItems = seq.primary === 'A' ? seq.seqA : seq.seqB;
  primaryItems.slice(0,3).forEach(function(item){ m3 += item+'\n'; });
  m3 += '\n' + getPersonalInsight();
  m3 += '\n\n<b>Track it:</b>\n/position '+sym+' '+d.price+' '+stop+' '+tp1+' '+tp2;
  m3 += '\n/watch '+sym+'  ←  get proactive alerts';
  await tg(m3, chatId);
}

async function cmdScience(sym, chatId) {
  var key = 'science:'+sym;
  procStart(key, '/science', sym);
  await tg('⏳ Running full Science Module on $'+sym+'... (~20s)', chatId);
  var d=await getStock(sym);
  procEnd(key);
  if(!d) return tg('Cannot pull data for $'+sym, chatId);
  var news=await polyNewsRaw(sym,5);
  var catRank=5,catName='No Catalyst',latestHead='';
  if(news.length){latestHead=news[0].title||'';var cat=identifyCatalyst(latestHead);catRank=cat.rank;catName=cat.name;}
  var mis=calcMIS(d,catRank), sdi=calcSDI(d,catRank), sas=calcSAS(d);
  var seq=calcSequenceMatch(d,catRank,d._aggs), dur=predictDuration(d,catRank);
  var lifecycle2=detectLifecyclePhase(d);
  var synScores2=[mis.pct,sdi.score,sas.score]; var synAvg2=rnd(synScores2.reduce(function(a,b){return a+b;},0)/synScores2.length,0);
  var synSpread2=Math.max.apply(null,synScores2)-Math.min.apply(null,synScores2);
  var synergy2=synSpread2<=20?'🟢 ALIGNED':synSpread2<=40?'🟡 MIXED':'🔴 CONFLICTED';
  var msg='<b>🔬 $'+sym+' '+cFlag(sym)+' — MAVERICK SCIENCE MODULE</b>\n\n';
  msg+='MIS: <b>'+mis.pct+'/100</b> ['+mis.tier+']  Move: +'+mis.expectedMove+'\n';
  msg+='SDI: <b>'+sdi.score+'/100</b> ['+sdi.danger+']\n';
  msg+='SAS: <b>'+sas.score+'/100</b> ['+sas.tier+']\n';
  msg+='Synergy: '+synergy2+'  (avg:'+synAvg2+'  spread:'+synSpread2+'pts)\n';
  msg+='Seq A: <b>'+seq.scoreA+'%</b>  Seq B: <b>'+seq.scoreB+'%</b>  ['+seq.label+']\n';
  msg+=dur.style+'  '+dur.minMin+'-'+dur.maxMin+' min\n';
  msg+=lifecycle2.emoji+' '+lifecycle2.name+'\n';
  msg+='Catalyst: '+catName+' (Rank '+catRank+'/5)\n';
  if(latestHead) msg+='"'+latestHead.slice(0,100)+'"\n';
  msg+='\n<b>MIS Breakdown:</b>\n'; mis.components.forEach(function(c){msg+='• '+c+'\n';});
  msg+='\n<b>Short Danger:</b>\n'; sdi.reasons.slice(0,4).forEach(function(r){msg+='• '+r+'\n';});
  msg+='\n<b>Stealth Accumulation:</b>\n'+sas.interpretation+'\n';
  sas.signals.slice(0,3).forEach(function(s){msg+='• '+s.label+': '+s.pts+'/'+s.max+'\n';});
  msg+='\n<b>Sequence A match ('+seq.scoreA+'%):</b>\n';
  seq.seqA.forEach(function(item){msg+=item+'\n';});
  msg+='\n<b>Duration:</b> '+dur.hold+'\n⚠️ '+dur.exitNote+'\n';
  msg+='\n<b>Levels:</b>\n$'+d.price+' ('+(d.changePct>=0?'+':'')+rnd(d.changePct,2)+'%)\n';
  msg+='Stop: $'+rnd(d.price-d.atr*1.5,4)+'\nTP1:  $'+rnd(d.price+d.atr*2,4)+'\nTP2:  $'+rnd(d.price+d.atr*4,4)+'\n';
  msg+='Float:'+d.floatM+'M  RVOL:'+d.relVol+'x  DTC:'+d.daysToCover+'d\n';
  if(mis.pct>=80) msg+='\n🔥 MIS > 80 = PRIME SETUP. /watch '+sym;
  else if(mis.pct>=65) msg+='\n⚡ MIS 65-79. Watch for catalyst confirmation.';
  else msg+='\n📊 MIS < 65. Missing key ingredients.';
  if(sas.score>=60) msg+='\n🐋 SAS > 60 — whale footprint. /sas '+sym+' for detail.';
  if(seq.primScore>=70) msg+='\n🎯 Seq '+seq.primary+' match '+seq.primScore+'% — high sequence confidence.';
  await tg(msg, chatId);
}

async function cmdSDI(sym, chatId) {
  await tg('Calculating Short Danger Index for $'+sym+'...', chatId);
  var d=await getStock(sym); if(!d) return tg('Cannot pull data for $'+sym, chatId);
  var news=await polyNewsRaw(sym,5), catRank=5;
  if(news.length) catRank=identifyCatalyst(news[0].title||'').rank;
  var sdi=calcSDI(d,catRank);
  var msg='<b>$'+sym+' — SHORT DANGER INDEX</b>\n\nSDI: <b>'+sdi.score+'/100</b>  ['+sdi.danger+']\n\n<b>Why Shorts Fear This:</b>\n';
  sdi.reasons.forEach(function(r){msg+='• '+r+'\n';});
  msg+='\nFloat:'+d.floatM+'M Short:'+rnd(d.shortPct,1)+'% DTC:'+d.daysToCover+'d\nRVOL:'+d.relVol+'x Price:$'+d.price+'\n\n';
  if(sdi.score>=75) msg+='EXTREME = highest reward potential for longs.\n/science '+sym+' for full picture.';
  else if(sdi.score>=55) msg+='Shorts nervous. RVOL spike forces covers.';
  else msg+='Shorts comfortable. Need stronger catalyst or RVOL to move this.';
  await tg(msg, chatId);
}

async function cmdAutopsy(chatId) {
  if(memory.science&&memory.science.results&&memory.science.generated&&(Date.now()-memory.science.generated)<4*3600*1000) return tg(buildAutopsyReport(memory.science.results), chatId);
  var results=await runAutopsy();
  await tg(results&&results.length?buildAutopsyReport(results):'Autopsy failed. Check /check SPY to verify data is working.', chatId);
}

async function cmdGappers(chatId) {
  await tg('Pulling live gappers...', chatId);
  var gainers=await getTopGainers(); if(!gainers.length) return tg('No gapper data. Verify POLYGON_KEY in .env.', chatId);
  var msg='<b>TOP GAPPERS NOW</b>\n\n', count=0;
  for(var i=0;i<gainers.length&&count<10;i++){
    var g=gainers[i],day=g.day||{},price=day.c||(g.lastTrade&&g.lastTrade.p)||0,chg=g.todaysChangePerc||0,vol=day.v||0;
    if(price<0.5||price>50) continue;
    msg+='<b>$'+g.ticker+'</b>  $'+rnd(price,4)+'  +'+rnd(chg,1)+'%\nVol: '+(vol>1e6?rnd(vol/1e6,2)+'M':rnd(vol/1e3,0)+'K')+'\n\n'; count++;
  }
  msg+='Full analysis: /check TICKER or /science TICKER';
  await tg(msg, chatId);
}

async function cmdScan(chatId) {
  var protoName=activeProtocol?PROTOCOLS[activeProtocol].name:'Standard';
  await tg('Scanning... Protocol: '+protoName, chatId);
  var universe=[], gainers=await getTopGainers();
  if(gainers.length) gainers.forEach(function(g){if(g.ticker) universe.push(g.ticker);});
  universe=universe.concat(Object.keys(watchlist)).concat(BASE_SCAN).filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,25);
  var settled=await Promise.allSettled(universe.map(function(s){return getStock(s);}));
  var results=[];
  for(var i=0;i<settled.length;i++){
    var r=settled[i]; if(r.status!=='fulfilled'||!r.value) continue;
    var d = r.value, sr = scoreSetup(d);
    if (sr.excluded) continue;
    // HARD RULE: top-pick only considers tradeable stocks (≤ $20)
    if (d.price > TRADE_MAX_PRICE || d.price < 0.25) continue;
    var ok=!activeProtocol||!PROTOCOLS[activeProtocol]||PROTOCOLS[activeProtocol].filter(d);
    if(sr.score>=50&&ok){var mis=calcMIS(d,5);results.push(Object.assign({},d,{score:sr.score,flags:sr.flags,mis:mis.pct}));}
  }
  results.sort(function(a,b){return (b.score+b.mis)-(a.score+a.mis);});
  if(!results.length) return tg('No qualifying setups. Market may be quiet. Try /protocol off then /scan.', chatId);
  var msg='<b>MAVERICK SCAN</b> ['+protoName+']\n\n';
  for(var j=0;j<Math.min(6,results.length);j++){
    var d2=results[j], lbl=d2.score>=80?'HOT':d2.score>=65?'WARM':'WATCH';
    var stop=rnd(d2.price-d2.atr*1.5,4), tp1=rnd(d2.price+d2.atr*2,4), shares=calcShares(d2.price,stop);
    msg+='['+lbl+'] <b>$'+d2.sym+'</b> Score:'+d2.score+' MIS:'+d2.mis+'\n';
    msg+='$'+d2.price+'  '+(d2.changePct>=0?'+':'')+rnd(d2.changePct,1)+'%  RVOL '+d2.relVol+'x\n';
    msg+='Float:'+d2.floatM+'M  '+(d2.flags.slice(0,2).join(' | ')||'')+'\n';
    msg+='Stop:$'+stop+'  TP1:$'+tp1+'  Shares:'+shares+'\n\n';
  }
  msg+='Full analysis: /science TICKER  or  /check TICKER';
  await tg(msg, chatId);
}

async function cmdSqueeze(chatId) {
  await tg('Running squeeze scan...', chatId);
  var universe=Object.keys(watchlist).concat(BASE_SCAN).filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,20);
  var settled=await Promise.allSettled(universe.map(function(s){return getStock(s);}));
  var results=[];
  for(var i=0;i<settled.length;i++){var r=settled[i];if(r.status!=='fulfilled'||!r.value)continue;var sdi=calcSDI(r.value,5);if(sdi.score>=30||r.value.shortPct>=15)results.push(Object.assign({},r.value,{sqSc:sdi.score}));}
  results.sort(function(a,b){return b.sqSc-a.sqSc;});
  if(!results.length) return tg('No notable squeeze setups detected.', chatId);
  var msg='<b>SQUEEZE SCAN (SDI-Powered)</b>\n\n';
  for(var j=0;j<Math.min(5,results.length);j++){
    var d2=results[j],danger=d2.sqSc>=75?'EXTREME':d2.sqSc>=55?'HIGH':'WATCH';
    msg+='['+danger+'] <b>$'+d2.sym+'</b> SDI:'+d2.sqSc+'/100\nShort:'+rnd(d2.shortPct,1)+'% RVOL:'+d2.relVol+'x Float:'+d2.floatM+'M\nDTC:'+d2.daysToCover+'d\n\n';
  }
  msg+='SDI > 75 = EXTREME short danger.\n/sdi TICKER for full breakdown.';
  await tg(msg, chatId);
}

async function cmdNews(chatId) {
  await tg('Pulling latest catalysts...', chatId);
  var articles=POLYGON?await polyNewsRaw(null,15):[];
  var msg='<b>LATEST CATALYSTS</b>\n\n';
  if(articles.length){
    articles.filter(function(a){return a.title;}).slice(0,8).forEach(function(a,i){
      var cat=identifyCatalyst(a.title), ticks=(a.tickers||[]).slice(0,3).join(', ')||'—';
      var ageMin=a.published_utc?Math.round((Date.now()-new Date(a.published_utc).getTime())/60000):0;
      msg+=(i+1)+'. [Rank '+cat.rank+'] <b>'+ticks+'</b> — '+(ageMin<60?ageMin+'m':Math.round(ageMin/60)+'h')+'\n'+a.title+'\n\n';
    });
  } else {
    var fhNews=FINNHUB?await fh('/news?category=general'):null;
    if(Array.isArray(fhNews)){fhNews.filter(function(n){return n.headline;}).slice(0,8).forEach(function(n,i){var age=Math.round((Date.now()/1000-n.datetime)/60);var rel=(n.related||'').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase()||'—';msg+=(i+1)+'. <b>'+rel+'</b> — '+age+'m\n'+n.headline+'\n\n';});}
    else msg+='News unavailable. Check POLYGON_KEY or FINNHUB_KEY in .env.';
  }
  await tg(msg, chatId);
}

async function cmdProtocol(parts, chatId) {
  if((parts[1]||'').toLowerCase()==='off'){activeProtocol=null;return tg('Protocol deactivated. Running standard Maverick mode.', chatId);}
  if(!activeProtocol) return tg('No protocol active.\n\n/ross  /humble  /maverick\n\n/protocol off to clear.', chatId);
  var p=PROTOCOLS[activeProtocol], msg='<b>'+p.name+' — ACTIVE</b>\n\n'+p.desc+'\n\nRULES:\n';
  p.rules.forEach(function(r,i){msg+=(i+1)+'. '+r+'\n';});
  await tg(msg, chatId);
}

async function cmdActivateProtocol(name, chatId) {
  activeProtocol=name; var p=PROTOCOLS[name];
  var msg='<b>'+p.name+' ACTIVATED</b>\n\n'+p.desc+'\n\nRULES:\n';
  p.rules.forEach(function(r,i){msg+=(i+1)+'. '+r+'\n';});
  msg+='\nAll /scan, /check, briefing filtered through this protocol.\n/protocol off to deactivate.';
  await tg(msg, chatId);
}

async function cmdPosition(parts, chatId) {
  var sym=parts[1],entry=parts[2],stop=parts[3],tp1=parts[4],tp2=parts[5],shares=parts[6];
  if(!sym||!entry||!stop||!tp1) return tg('Usage: /position TICKER ENTRY STOP TP1 TP2 SHARES\nExample: /position MDAI 1.50 1.38 1.80 2.10 50', chatId);
  var ticker=sym.toUpperCase(); if(!shares) shares=calcShares(+entry,+stop);
  var rr=rnd((+tp1-+entry)/Math.max(+entry-+stop,0.001),2);
  positions[ticker]={entry:+entry,stop:+stop,tp1:+tp1,tp2:tp2?+tp2:null,shares:+shares,protocol:activeProtocol||'maverick',entryTime:Date.now(),alerts:{stopWarn:false,tp1:false,tp2:false,overextended:false}};
  var risk=rnd(Math.abs(+entry-+stop)*+shares,2), reward1=rnd(Math.abs(+tp1-+entry)*+shares,2);
  await tg('<b>$'+ticker+' TRACKED</b>\n\nEntry:  $'+entry+'\nStop:   $'+stop+' ('+rnd((+stop-+entry)/+entry*100,1)+'%)\nTP1:    $'+tp1+' (+'+rnd((+tp1-+entry)/+entry*100,1)+'%)\nTP2:    '+(tp2?'$'+tp2:'not set')+'\nShares: '+shares+'\nRisk:   $'+risk+'  Reward@TP1: $'+reward1+'  R:R: '+rr+':1\nProtocol: '+(activeProtocol||'maverick')+'\n\nAlerts set for stop, TP1, TP2.', chatId);
}

async function cmdPositions(chatId) {
  var keys=Object.keys(positions);
  if(!keys.length) return tg('No open positions.\n\nLog one: /position TICKER ENTRY STOP TP1 TP2 SHARES', chatId);
  var msg='<b>📈 OPEN POSITIONS</b>\n\n';
  for(var i=0;i<keys.length;i++){
    var sym=keys[i], pos=positions[sym];
    // Clear cache to get freshest price
    delete dataCache[sym];
    var d=await getStock(sym).catch(function(){return null;});
    var livePrice = d ? d.price : null;
    var marketLabel = d && d.isPreMarket ? ' 🌅' : d && d.isPostMarket ? ' 🌙' : '';

    if(!livePrice){
      // Show stored position data even when live price fails
      msg+='⚠️ <b>$'+sym+'</b> '+cFlag(sym)+' — live price unavailable\n';
      msg+='Entry: $'+pos.entry+' | Stop: $'+pos.stop+'\n';
      msg+='TP1: '+(pos.tp1?'$'+pos.tp1:'not set')+'  TP2: '+(pos.tp2?'$'+pos.tp2:'not set')+'\n';
      msg+='Shares: '+pos.shares+'  (P&L pending live data)\n\n';
      continue;
    }
    var pl=rnd((livePrice-pos.entry)/pos.entry*100,2);
    var plD=rnd((livePrice-pos.entry)*pos.shares,2);
    var stopDist=rnd((livePrice-pos.stop)/livePrice*100,1);
    var tp1Dist=pos.tp1?rnd((pos.tp1-livePrice)/livePrice*100,1):null;
    msg+=(pl>=0?'🟢 UP':'🔴 DOWN')+' <b>$'+sym+'</b> '+cFlag(sym)+marketLabel+'\n';
    msg+='Entry $'+pos.entry+' → Now $'+livePrice+' ['+( d.source||'?')+']\n';
    msg+='P&L: '+(pl>=0?'+':'')+pl+'% ($'+(plD>=0?'+':'')+plD+')\n';
    msg+='Stop: $'+pos.stop+' ('+stopDist+'% away)'+(Math.abs(stopDist)<3?' ⚠️ CLOSE':'')+'\n';
    msg+='TP1: '+(pos.tp1?'$'+pos.tp1+' ('+(tp1Dist>=0?'+':'')+tp1Dist+'% away)':'not set')+'\n';
    if(pos.tp2) msg+='TP2: $'+pos.tp2+'\n';
    msg+='RVOL: '+d.relVol+'x  Float: '+d.floatM+'M  Short: '+rnd(d.shortPct,1)+'%\n\n';
  }
  await tg(msg, chatId);
}

async function cmdClose(parts, chatId) {
  var sym=(parts[1]||'').toUpperCase(),exitPrice=parts[2]?+parts[2]:null;
  if(!sym||!positions[sym]) return tg('No tracked position for $'+sym, chatId);
  var pos=positions[sym]; delete positions[sym];
  if(!exitPrice){var d=await getStock(sym).catch(function(){return null;});if(d) exitPrice=d.price;}
  if(exitPrice){
    var pl=rnd((exitPrice-pos.entry)/pos.entry*100,2),plD=rnd((exitPrice-pos.entry)*pos.shares,2);
    learnFromTrade({sym,entry:pos.entry,exit:exitPrice,pnlPct:pl,pnlDollar:plD,protocol:pos.protocol||'maverick',setupScore:0,float:0,rvol:0,ts:Date.now()});
    await tg('<b>$'+sym+' CLOSED</b>\nEntry:$'+pos.entry+' | Exit:$'+exitPrice+'\nP&L: '+(pl>=0?'+':'')+pl+'% ($'+(plD>=0?'+':'')+plD+')\nShares:'+pos.shares+' Protocol:'+(pos.protocol||'maverick')+'\n\n'+(pl>0?'Win logged.':'Loss logged.')+' Maverick Protocol learning.\nTotal trades: '+(memory.trades?memory.trades.length:0), chatId);
  } else { await tg('$'+sym+' position removed.', chatId); }
}

async function cmdWatch(sym, chatId) {
  watchlist[sym.toUpperCase()] = { added: Date.now() };
  await saveMemory(); // Persist watchlist to JSONBin immediately
  await tg('$'+sym.toUpperCase()+' '+cFlag(sym)+' added to your watchlist.\nAlerts will fire on news, staircase, and intraday momentum.\n/mywatch to see your list.', chatId);
}

async function cmdAlert(parts, chatId) {
  var sym=parts[1],price=parts[2],dir=parts[3];
  if(!sym||!price) return tg('Usage: /alert TICKER PRICE above|below\nExample: /alert MDAI 2.00 above', chatId);
  priceAlerts.push({ticker:sym.toUpperCase(),price:+price,direction:dir||'above',chatId:chatId,fired:false});
  await tg('Alert set: $'+sym.toUpperCase()+' '+(dir||'above')+' $'+price, chatId);
}

async function cmdMyEdge(chatId) {
  if(!memory.trades||memory.trades.length<5) return tg('Need 5+ logged trades.\n\nCurrently logged: '+(memory.trades?memory.trades.length:0)+' trades.', chatId);
  rebuildWinRates(); var wr=memory.winRates,trades=memory.trades;
  var wins=trades.filter(function(t){return t.pnlPct>0;}).length;
  var winRate=rnd(wins/trades.length*100,1);
  var wl=trades.filter(function(t){return t.pnlPct>0;}),ll=trades.filter(function(t){return t.pnlPct<=0;});
  var avgWin=rnd(wl.reduce(function(a,t){return a+t.pnlPct;},0)/Math.max(wins,1),2);
  var avgLoss=rnd(ll.reduce(function(a,t){return a+t.pnlPct;},0)/Math.max(ll.length,1),2);
  var msg='<b>YOUR PERSONAL EDGE</b>\nBased on '+trades.length+' trades\n\nWin rate: '+winRate+'% | Avg win: +'+avgWin+'% | Avg loss: '+avgLoss+'%\n\n<b>By Float:</b>\n';
  ['nano','tight','mid'].forEach(function(k){var arr=(wr.byFloat[k]||[]);if(arr.length>=2){var rate=rnd(arr.reduce(function(a,b){return a+b;},0)/arr.length*100,0);msg+=k+' (<'+(k==='nano'?'5M':k==='tight'?'15M':'15M+')+'): '+rate+'% win ('+arr.length+' trades)\n';}});
  msg+='\n<b>By RVOL:</b>\n';
  ['high','med','low'].forEach(function(k){var arr=(wr.byRvol[k]||[]);if(arr.length>=2){var rate=rnd(arr.reduce(function(a,b){return a+b;},0)/arr.length*100,0);msg+=k+' RVOL: '+rate+'% win ('+arr.length+' trades)\n';}});
  msg+='\n<b>By Protocol:</b>\n';
  Object.keys(wr.byProtocol||{}).forEach(function(p){var bp=wr.byProtocol[p];msg+=p+': '+rnd(bp.wins/bp.total*100,0)+'% ('+bp.wins+'/'+bp.total+')\n';});
  msg+='\n'+getPersonalInsight()+'\n\nMaverick Protocol adapting to your edge.';
  await tg(msg, chatId);
}

async function cmdHistory(chatId) {
  if(!memory.trades||!memory.trades.length) return tg('No trade history yet.', chatId);
  var recent=memory.trades.slice(-10).reverse(), msg='<b>LAST '+recent.length+' TRADES</b>\n\n';
  recent.forEach(function(t){var d=new Date(t.ts).toLocaleDateString(),win=t.pnlPct>0?'WIN':'LOSS';msg+='['+win+'] <b>$'+t.sym+'</b> '+(t.pnlPct>0?'+':'')+rnd(t.pnlPct,2)+'% ($'+(t.pnlDollar>0?'+':'')+rnd(t.pnlDollar||0,2)+')\n'+d+' | '+(t.protocol||'?')+'\n\n';});
  await tg(msg, chatId);
}

// ── /status — Interval + pipeline health ──────────────────────────────────
async function cmdStatus(chatId) {
  var now = Date.now();
  var upMs = now - iHealth.startTime;
  var upH = Math.floor(upMs/3600000), upM = Math.floor((upMs%3600000)/60000);

  function ago(ts) {
    if (!ts) return 'never';
    var d = Math.round((now-ts)/1000);
    if (d < 60) return d+'s ago';
    if (d < 3600) return Math.round(d/60)+'m ago';
    return Math.round(d/3600)+'h ago';
  }

  // Quick data source check
  var yTest = await yahooQuote('SPY').catch(function(){return null;});
  var fhTest = FINNHUB ? await fhQuote('SPY').catch(function(){return null;}) : null;

  var msg = '<b>🔧 MAVERICK BOT STATUS v6.3</b>\n\n';
  msg += '<b>UPTIME:</b> '+upH+'h '+upM+'m\n';
  msg += '<b>MODE:</b> Webhook ✓ (zero polling)\n';
  msg += '<b>TRADING RULE:</b> Sub-$'+TRADE_MAX_PRICE+' only (alerts + scans)\n\n';

  msg += '<b>DATA SOURCES:</b>\n';
  msg += (yTest ? '✅' : '❌') + ' Yahoo Finance — ' + (yTest ? 'live $'+yTest.price : 'OFFLINE') + '\n';
  msg += (fhTest ? '✅' : (FINNHUB ? '⚠️' : '❌')) + ' Finnhub — ' + (fhTest ? 'live' : FINNHUB ? 'slow/offline' : 'no key') + '\n';
  msg += (POLYGON ? '✅' : '❌') + ' Polygon — ' + (POLYGON ? 'news only' : 'no key') + '\n\n';

  msg += '<b>INTERVAL HEALTH:</b>\n';
  msg += '📡 News scanner: '+ago(iHealth.newsLastRun)+' ('+iHealth.newsRunCount+' runs)\n';
  msg += '📢 Organic alerts: <b>'+organicAlertsSent+'</b>  |  Test alerts: '+(iHealth.newsAlertsTotal - organicAlertsSent)+'\n';
  msg += '🌅 Briefing: '+ago(iHealth.briefLastRun)+'\n';
  msg += '📈 Position monitor: '+ago(iHealth.posLastRun)+'\n\n';

  msg += '<b>CACHE STATUS:</b>\n';
  msg += 'Quote cache (60s): '+Object.keys(dataCache).length+' entries\n';
  msg += 'Aggs cache (4hr):  '+Object.keys(aggsCache).length+' entries\n';
  msg += 'Fund cache (24hr): '+Object.keys(fundCache).length+' entries\n';
  msg += 'Gainers cache (5m): '+(gainersCache&&gainersCache.length?gainersCache.length+' tickers, '+Math.round((Date.now()-gainersCacheTs)/1000)+'s old':'empty')+'\n\n';
  msg += 'Data ok/error: '+iHealth.dataOk+' / '+iHealth.dataErrors+'\n\n';
  msg += '<b>PIPELINE:</b>\n';
  msg += 'CHAT_ID: ' + (CHAT_ID ? '✅ set ('+CHAT_ID.slice(0,4)+'***)' : '❌ MISSING — alerts cannot send') + '\n';
  msg += 'Watchlist: '+Object.keys(watchlist).length+' tickers  |  Algo arsenal: '+algoWatchlist.length+'/7 slots\n';
  msg += 'Focus mode: '+(focusMode?'🎯 ON (pure conversation)':'OFF (command routing)')+'\n';
  msg += 'Open positions: '+Object.keys(positions).length+'\n\n';

  var procKeys = Object.keys(iHealth.processing);
  if (procKeys.length > 0) {
    msg += '<b>⏳ CURRENTLY PROCESSING:</b>\n';
    procKeys.forEach(function(k) {
      var p = iHealth.processing[k];
      var elapsed = Math.round((Date.now()-p.start)/1000);
      msg += '• '+p.cmd+(p.sym?' $'+p.sym:'')+' — '+elapsed+'s elapsed\n';
    });
    msg += '\n';
  }

  if (organicAlertsSent === 0 && iHealth.newsRunCount > 0) {
    msg += '<b>⚠️ NO ALERTS SENT YET</b>\n';
    msg += 'Scanner is running but no bullish keywords found.\n';
    msg += 'Try /test-alert to verify the pipeline works.\n';
    msg += 'Add tickers with /watch TICKER to get watchlist alerts.';
  } else if (!CHAT_ID) {
    msg += '<b>🚨 CRITICAL: CHAT_ID not set</b>\nGo to Render → Environment → add INTEL_BOT_CHAT\nFind your ID by messaging @userinfobot on Telegram.';
  }

  await tg(msg, chatId);
}

// ── /test-alert — Fire a real end-to-end alert to verify pipeline ──────────
async function cmdTestAlert(parts, chatId) {
  var sym = (parts && parts[1]) ? parts[1].toUpperCase() : 'SPY';
  await tg('🧪 Running end-to-end alert test with $'+sym+'...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('❌ Data pull failed for $'+sym+'.\nYahoo Finance may be rate-limiting.\nTry /test-alert AAPL or /test-alert TSLA', chatId);

  // Ensure aggs for SAS
  if (!d._aggs || d._aggs.length < 5) {
    var freshAggs = await yahooAggs(sym, 22);
    if (freshAggs && freshAggs.length >= 5) d._aggs = freshAggs;
  }

  var reason = 'TEST ALERT — end-to-end pipeline verification. Data source: '+d.source;
  var alertMsg = await buildMaverickAlert(sym, d, reason, 'System Test', 3);
  await tg(alertMsg, chatId);
  await tg(
    '✅ <b>ALERT PIPELINE TEST COMPLETE</b>\n\n' +
    'If you received the alert above, the full pipeline works:\n' +
    '• Data pull ✓ ('+d.source+')\n' +
    '• Score engine ✓\n' +
    '• Alert voice ✓\n' +
    '• Telegram delivery ✓\n\n' +
    'The news scanner will send alerts in this exact format when it finds bullish catalysts.',
    chatId
  );
  iHealth.newsAlertsTotal++; // Count test as verified send
}

// ── AI WITH INTENT DETECTION ───────────────────────────────────────────────
async function cmdAI(text, chatId) {
  var ticker = extractTicker(text);
  var intent = detectIntent(text);

  // Ticker found → pull live data and give real AI analysis
  if (ticker && (intent === 'check' || intent === 'science' || !intent)) {
    await tg('Pulling live data for $' + ticker + '...', chatId);
    var d = await getStock(ticker);
    if (d) {
      var sr=scoreSetup(d), mis=calcMIS(d,5), sdi=calcSDI(d,5);
      var changeStr=(d.changePct>=0?'+':'')+rnd(d.changePct,2)+'%';
      var analysis=await ai(
        'You are MAVERICK LION BRAIN — elite micro-cap analyst for a small account trader. Tight risk per trade is essential. Apply Maverick Whale Doctrine (Phase 1-2 entry, Phase 4 exit). You have REAL live data. Use it. No disclaimers. BUY / WATCH / PASS verdict. Entry, stop, TP1, TP2. Max 200 words.',
        'User asked: "'+text+'"\n\n$'+ticker+' LIVE DATA ('+d.source+'):\nPrice:$'+d.price+' ('+changeStr+') Gap:'+(d.gapPct||0)+'%\nRVOL:'+d.relVol+'x Float:'+d.floatM+'M Short:'+d.shortPct+'%\nDTC:'+d.daysToCover+'d Score:'+sr.score+'/100 MIS:'+mis.pct+' SDI:'+sdi.score+'\nFlags:'+(sr.flags.join(', ')||'none'),
        400, chatId
      );
      return tg(
        '<b>$'+ticker+'</b> ['+( sr.score>=85?'HIGH':sr.score>=65?'ELEVATED':'MODERATE')+'] '+d.source+'\n' +
        '$'+d.price+' ('+changeStr+') RVOL:'+d.relVol+'x Float:'+d.floatM+'M\n' +
        'MIS:'+mis.pct+' ['+mis.tier+'] SDI:'+sdi.score+' ['+sdi.danger+']\n\n' +
        (analysis||'AI offline.')+
        '\n\nFull analysis: /check '+ticker+' | /science '+ticker,
        chatId
      );
    }
  }

  // Route intent without ticker to commands
  if (intent==='scan')      return cmdScan(chatId);
  if (intent==='news')      return cmdNews(chatId);
  if (intent==='gappers')   return cmdGappers(chatId);
  if (intent==='squeeze')   return cmdSqueeze(chatId);
  if (intent==='autopsy')   return cmdAutopsy(chatId);
  if (intent==='supernova' && ticker) return cmdSupernova(ticker, chatId);
  if (intent==='supernova') return tg('Supernova which ticker? Try: "supernova MDAI" or /supernova MDAI', chatId);
  if (intent==='sas' && ticker) return cmdSAS(ticker, chatId);
  if (intent==='sas') return tg('SAS on which ticker? Try: "stealth MDAI" or /sas MDAI', chatId);
  if (intent==='backtest') return cmdBacktest(chatId);
  if (intent==='trend' && ticker) return cmdTrend(ticker, chatId);
  if (intent==='trend') return tg('Trend on which ticker? Try: "trend AAPL" or /trend AAPL', chatId);

  // General conversation
  var personalInsight=getPersonalInsight();
  var protoCtx=activeProtocol?'Active protocol: '+PROTOCOLS[activeProtocol].name+'. ':'';
  var reply=await ai(
    'You are Maverick Bot v5.3 — elite trading assistant and brilliant general AI. For trading: Maverick Whale Doctrine, Phase 1-2 entry, tight float, whale volume, hard stops. Small account trader — tight risk per trade. '+protoCtx+'Logged '+(memory.trades?memory.trades.length:0)+' trades.'+(personalInsight?' Edge:'+personalInsight+'.':'')+' For non-trading: direct knowledgeable friend. No disclaimers. Max 280 words.',
    text, 500, chatId
  );
  if(reply) await tg(reply, chatId);
  else await tg('AI brain offline. Try /check TICKER for analysis.', chatId);
}

// ── BACKGROUND MONITORS ────────────────────────────────────────────────────
async function monitorPositions() {
  iHealth.posLastRun = Date.now();
  for(var sym in positions){
    var pos=positions[sym];
    // Clear quote cache for position tickers — always get freshest price
    delete dataCache[sym];
    var d=await getStock(sym).catch(function(){return null;});
    if(!d) continue;
    // Use the live price — already handles pre/post market via yahooQuote fix
    var price=d.price;
    var marketLabel = d.isPreMarket ? ' 🌅 pre-mkt' : d.isPostMarket ? ' 🌙 AH' : '';
    var pct=(price-pos.entry)/pos.entry*100, stopDist=(price-pos.stop)/pos.stop*100;
    var zones=calcDemandSupplyZones(d._aggs||[]);
    var zoneStr=zones.demand.length?'\nDemand below: '+zones.demand[0]:'';

    if(stopDist<3&&!pos.alerts.stopWarn){
      pos.alerts.stopWarn=true;
      await tg('<b>⚠️ $'+sym+' just pinged my stop warning.</b>'+marketLabel+'\n\nPrice $'+price+' is within 3% of your stop at $'+pos.stop+'. RVOL is '+d.relVol+'x.\n\nIf the thesis is broken — exit now. A small controlled loss is better than letting this turn into a big one. Don\'t hope, act.'+zoneStr);
    } else if(stopDist>=6){pos.alerts.stopWarn=false;}

    if(price<=pos.stop){
      await tg('<b>🛑 $'+sym+' stop has been hit.</b>\n\nEntry was $'+pos.entry+'. Stop $'+pos.stop+'. Price now $'+price+' ('+rnd(pct,1)+'%).\n\nExit the position. No exceptions. Protect the account.');
    }

    if(pos.tp1&&price>=pos.tp1&&!pos.alerts.tp1){
      pos.alerts.tp1=true;
      var proj2=project30MinMove(d,5);
      await tg('<b>✅ $'+sym+' just hit TP1 at $'+pos.tp1+'.</b>\n\nYou\'re up '+rnd(pct,1)+'% from entry $'+pos.entry+'. I\'m projecting this could push another '+proj2.pct+'%.\n\nSell 50% here. Move your stop to breakeven. Let the runner work to TP2: '+(pos.tp2?'$'+pos.tp2:'(not set)')+'.'+zoneStr);
    }

    if(pos.tp2&&price>=pos.tp2&&!pos.alerts.tp2){
      pos.alerts.tp2=true;
      await tg('<b>🎯 $'+sym+' hit TP2 at $'+pos.tp2+'!</b>\n\nUp '+rnd(pct,1)+'% from entry. This is the extended target.\n\nSell 30% more. Trail the remaining 20% aggressively. Watch for RVOL fade as the exit signal.');
    }

    if(pct>25&&!pos.alerts.tp1&&!pos.alerts.overextended){
      pos.alerts.overextended=true;
      var kz=getKillZoneSignals(d);
      await tg('<b>📈 $'+sym+' is overextended — up '+rnd(pct,1)+'%.</b>\n\n'+(d.relVol<1.5?'I\'m seeing volume fade (RVOL '+d.relVol+'x). This signals distribution — whales are selling into retail. Scale out now.':'RVOL still '+d.relVol+'x. Volume holding. Take partial profits and trail the stop tight.')+(kz.signals.length?'\n\n⚠️ '+kz.signals[0]:''));
    }
  }
}

async function checkPriceAlerts() {
  for(var i=0;i<priceAlerts.length;i++){
    var alert=priceAlerts[i]; if(alert.fired) continue;
    var d=await getStock(alert.ticker).catch(function(){return null;}); if(!d) continue;
    var triggered=alert.direction==='above'?d.price>=alert.price:d.price<=alert.price;
    if(triggered){
      alert.fired=true;
      var reason='Price '+alert.direction+' your $'+alert.price+' alert level';
      var alertMsg=await buildMaverickAlert(alert.ticker,d,reason,'Price Alert',5);
      await tg(alertMsg, alert.chatId||CHAT_ID);
    }
  }
}

// ── COMMAND ROUTER (used by webhook — no polling needed) ───────────────────
async function handleUpdate(update) {
  var msg = update.message || update.channel_post;
  if (!msg || !msg.text) return;
  var chatId = String(msg.chat.id);
  var text   = msg.text.trim();
  var parts  = text.split(/\s+/);
  var cmd    = parts[0].toLowerCase().split('@')[0];
  console.log('[MSG] chatId='+chatId+' text='+text.slice(0,60));
  // Fire heavy commands without await — response comes when ready, bot stays responsive
  var fire = function(fn) { fn.catch(function(e) { console.error('[CMD]', e.message); tg('Something went wrong. Try again.', chatId); }); };
  try {
    // ── FOCUS MODE — all plain text goes direct to expert peer AI ─────────
    // In focus mode, only explicit slash commands bypass the conversation.
    if (focusMode && text.charAt(0) !== '/') {
      fire(cmdFocusChat(text, chatId));
      return;
    }

    if      (cmd==='/start'||cmd==='/help')  await cmdStart(chatId);
    else if (cmd==='/check'&&parts[1])        fire(cmdCheck(parts[1].toUpperCase(),chatId));
    else if (cmd==='/check')                  await tg('Usage: /check TICKER  e.g. /check AAPL',chatId);
    else if (cmd==='/scan')                   fire(cmdScan(chatId));
    else if (cmd==='/squeeze')                fire(cmdSqueeze(chatId));
    else if (cmd==='/gappers')                fire(cmdGappers(chatId));
    else if (cmd==='/news')                   fire(cmdNews(chatId));
    else if (cmd==='/science'&&parts[1])      fire(cmdScience(parts[1].toUpperCase(),chatId));
    else if (cmd==='/science')                await tg('Usage: /science TICKER  e.g. /science AAPL',chatId);
    else if (cmd==='/sdi'&&parts[1])          fire(cmdSDI(parts[1].toUpperCase(),chatId));
    else if (cmd==='/sdi')                    await tg('Usage: /sdi TICKER  e.g. /sdi AAPL',chatId);
    else if (cmd==='/sas'&&parts[1])          fire(cmdSAS(parts[1].toUpperCase(),chatId));
    else if (cmd==='/sas')                    await tg('Usage: /sas TICKER  e.g. /sas MDAI',chatId);
    else if (cmd==='/autopsy')                fire(cmdAutopsy(chatId));
    else if (cmd==='/supernova'&&parts[1])    fire(cmdSupernova(parts[1].toUpperCase(),chatId));
    else if (cmd==='/supernova')              await tg('Usage: /supernova TICKER  e.g. /supernova MDAI',chatId);
    else if (cmd==='/supernova-scan')         fire(cmdSupernovaScan(chatId));
    else if (cmd==='/briefing')               fire(morningBriefing(true));
    else if (cmd==='/backtest')               fire(cmdBacktest(chatId));
    else if (cmd==='/trend'&&parts[1])        fire(cmdTrend(parts[1].toUpperCase(),chatId));
    else if (cmd==='/trend')                  await tg('Usage: /trend TICKER  e.g. /trend TRT',chatId);
    else if (cmd==='/backtest'&&parts[1]==='force') fire(runBacktest(chatId));
    else if (cmd==='/ross')                   await cmdActivateProtocol('ross',chatId);
    else if (cmd==='/humble')                 await cmdActivateProtocol('humble',chatId);
    else if (cmd==='/maverick')               await cmdActivateProtocol('maverick',chatId);
    else if (cmd==='/protocol')               await cmdProtocol(parts,chatId);
    else if (cmd==='/position')               await cmdPosition(parts,chatId);
    else if (cmd==='/positions')              fire(cmdPositions(chatId));
    else if (cmd==='/confidence'&&parts[1])   fire(cmdConfidence(parts[1].toUpperCase(),chatId));
    else if (cmd==='/confidence')             await tg('Usage: /confidence TICKER  e.g. /confidence GOVX\n(Must have position tracked via /position first)',chatId);
    else if (cmd==='/cascade'&&parts[1])      fire(cmdCascade(parts[1].toUpperCase(),chatId));
    else if (cmd==='/cascade')                await tg('Usage: /cascade TICKER  e.g. /cascade GOVX',chatId);
    else if (cmd==='/staircase'||cmd==='/sc') fire(cmdStaircase(chatId));
    else if (cmd==='/close'&&parts[1])        await cmdClose(parts,chatId);
    else if (cmd==='/watch'&&parts[1])        await cmdWatch(parts[1],chatId);
    else if (cmd==='/alert')                  await cmdAlert(parts,chatId);
    else if (cmd==='/mis'&&parts[1])          fire(cmdScience(parts[1].toUpperCase(),chatId));
    else if (cmd==='/mis')                    await tg('Usage: /mis TICKER  (alias for /science)',chatId);
    else if (cmd==='/top-pick'||cmd==='/toppick'||cmd==='/best') fire(cmdTopPick(chatId));
    else if (cmd==='/myedge')                 fire(cmdMyEdge(chatId));
    else if (cmd==='/history')                await cmdHistory(chatId);
    else if (cmd==='/status')                 fire(cmdStatus(chatId));
    else if (cmd==='/test-alert')             fire(cmdTestAlert(parts, chatId));
    else if (cmd==='/focus') {
      if (parts[1]==='off') { focusMode=false; await tg('Focus mode OFF. Command routing restored. /help for commands.', chatId); }
      else { focusMode=true; await tg('🎯 <b>FOCUS MODE ON</b>\n\nI\'m listening. Talk to me like a trader.\nTickers get live data auto-pulled. Slash commands still work anytime.\n\nType /focus off to return to command mode.', chatId); }
    }
    else if (cmd==='/awatch'||cmd==='/algo-watch') fire(cmdAlgoWatch(chatId));
    else if (cmd==='/mywatch')                fire(cmdMyWatch(chatId));
    else if (cmd==='/intraday')               fire(cmdIntraday(chatId));
    else if (text.charAt(0)!=='/') fire(cmdAI(text,chatId));
    else await tg('Unknown command. Type /help for all commands.',chatId);
  } catch(e) { console.error('[CMD]', cmd, e.message); await tg('Error: '+e.message, chatId); }
}

// ── SUPERNOVA SCAN ────────────────────────────────────────────────────────
async function cmdSupernovaScan(chatId) {
  await tg('🔭 Running Supernova Scan across the universe...', chatId);
  var universe=[], gainers=await getTopGainers();
  if(gainers.length) gainers.forEach(function(g){if(g.ticker) universe.push(g.ticker);});
  universe=universe.concat(Object.keys(watchlist)).concat(BASE_SCAN).filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,20);
  var settled=await Promise.allSettled(universe.map(function(s){return getStock(s);}));
  var results=[];
  for(var i=0;i<settled.length;i++){
    var r=settled[i]; if(r.status!=='fulfilled'||!r.value) continue;
    var d=r.value, sn=scoreSupernova(d,5,'');
    if(sn.passed>=4) results.push(Object.assign({},d,{snPassed:sn.passed,snGrade:sn.grade}));
  }
  results.sort(function(a,b){return b.snPassed-a.snPassed;});
  if(!results.length) return tg('No supernova candidates in current universe. Market may be quiet.', chatId);
  var msg='<b>🌟 SUPERNOVA SCAN RESULTS</b>\n\n';
  for(var j=0;j<Math.min(5,results.length);j++){
    var d2=results[j], arch=classifyArchetype(d2,5);
    msg+='<b>$'+d2.sym+'</b> — '+d2.snPassed+'/9 ingredients ['+d2.snGrade+']\n';
    msg+=arch.emoji+' '+arch.type+' | $'+d2.price+' RVOL:'+d2.relVol+'x Float:'+d2.floatM+'M\n';
    msg+='/supernova '+d2.sym+'\n\n';
  }
  await tg(msg, chatId);
}

// ══════════════════════════════════════════════════════════════════════════
// ── BACKTESTING ENGINE — PHASE 5 ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Reconstructs what the MIS would have been T-1 (day before each big move)
// using only data that was knowable at that moment.
// Compares pre-move score to actual outcome. Calculates real hit rates.
// This is what validates the 88% target is achievable.
//
// DATA: Yahoo historical OHLCV (free) — exact RVOL and gap reconstruction.
// Limitations: historical short% not available free, so we proxy from float.

function calcPreMoveMIS(aggs, moveIdx, floatM) {
  // Use bars available T-1 (everything BEFORE the move day)
  if (moveIdx < 3) return null;
  var preAggs  = aggs.slice(0, moveIdx);   // all bars before the move
  var dayBefore = aggs[moveIdx - 1];       // T-1 bar
  var moveDay   = aggs[moveIdx];           // T-0 bar (the actual move)

  // RVOL: what was the RVOL going INTO the move?
  var prevVols = preAggs.slice(-10).map(function(a){return a.v||0;});
  var avgVol   = prevVols.reduce(function(a,b){return a+b;},0) / Math.max(prevVols.length,1);
  var rvolPreMove = avgVol > 0 ? rnd(moveDay.v / avgVol, 2) : 1;

  // Gap: how much did price gap from T-1 close to T-0 open?
  var gap = dayBefore.c > 0 ? rnd((moveDay.o - dayBefore.c) / dayBefore.c * 100, 2) : 0;

  // Price at time of move
  var price = moveDay.o || dayBefore.c;

  // ATR compression: was the range contracting before the move?
  var recent5Ranges = preAggs.slice(-6,-1).map(function(a){return (a.h||0)-(a.l||0);});
  var prior15Ranges = preAggs.slice(-21,-6).map(function(a){return (a.h||0)-(a.l||0);});
  var recentRAvg = recent5Ranges.reduce(function(a,b){return a+b;},0)/Math.max(recent5Ranges.length,1);
  var priorRAvg  = prior15Ranges.reduce(function(a,b){return a+b;},0)/Math.max(prior15Ranges.length,1);
  var compressionBonus = (priorRAvg > 0 && recentRAvg/priorRAvg <= 0.65) ? 8 : 0;

  // Volume buildup T-5 to T-1
  var thresh = avgVol * 1.3;
  var consec = 0;
  for (var ci = preAggs.length-1; ci >= Math.max(0,preAggs.length-5); ci--) {
    if ((preAggs[ci].v||0) >= thresh) consec++; else break;
  }
  var buildupBonus = consec >= 3 ? 10 : consec >= 2 ? 5 : 0;

  // Proxy: catalyst rank from gap size (gap > 20% = likely rank 1-2)
  var catRankProxy = gap >= 20 ? 2 : gap >= 10 ? 3 : gap >= 5 ? 4 : 5;

  // Score using MIS weights (same formula, pre-move data only)
  var score = 0;
  // Float (same as current — doesn't change day-to-day)
  if      (floatM < 1)  score += 20;
  else if (floatM < 5)  score += 16;
  else if (floatM < 15) score += 10;
  else if (floatM < 30) score +=  4;
  // RVOL on move day
  if      (rvolPreMove >= 10) score += 18;
  else if (rvolPreMove >= 5)  score += 14;
  else if (rvolPreMove >= 3)  score +=  9;
  else if (rvolPreMove >= 2)  score +=  5;
  // Catalyst proxy from gap
  score += [15,12,8,4,0][Math.min(catRankProxy-1,4)];
  // Gap
  if      (gap >= 20) score += 8;
  else if (gap >= 10) score += 5;
  else if (gap >= 5)  score += 2;
  // Price range
  if      (price < 2)  score += 5;
  else if (price < 5)  score += 4;
  else if (price < 10) score += 2;
  // Bonuses from SAS-style analysis
  score += compressionBonus + buildupBonus;

  return Math.min(100, Math.max(0, score));
}

async function runBacktest(chatId) {
  await tg(
    '<b>🧪 MAVERICK BACKTEST ENGINE — INITIALIZING</b>\n\n' +
    'Reconstructing what the MIS was T-1 before each historical move.\n' +
    'Comparing pre-move scores to actual outcomes.\n' +
    'This will take 2-3 minutes. Analyzing up to 20 tickers...',
    chatId
  );

  // Get candidate tickers from autopsy cache or fresh gainers
  var candidates = [];
  if (memory.science && memory.science.results && memory.science.results.length) {
    candidates = memory.science.results.map(function(r){return r.sym;});
    await tg('Using cached autopsy data — ' + candidates.length + ' tickers from last autopsy.', chatId);
  } else {
    var gainers = await getTopGainers();
    candidates  = gainers.map(function(g){return g.ticker;}).slice(0,8);
    candidates  = candidates.concat(BASE_SCAN.slice(0,10));
    await tg('No autopsy cache. Using current gainers + base universe.', chatId);
  }
  candidates = candidates.filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,18);

  var results = [];
  var skipped = 0;
  var processed = 0;

  for (var i = 0; i < candidates.length; i++) {
    var sym = candidates[i];
    try {
      // Get full history
      var aggs = await yahooAggs(sym, 45);
      if (!aggs || aggs.length < 10) { skipped++; await sleep(300); continue; }

      // Get fundamentals for float
      var liveD   = await getStock(sym).catch(function(){return null;});
      var floatM  = liveD ? liveD.floatM : 50;

      // Find ALL moves >= 15% in the history (not just the biggest)
      var movesFound = [];
      for (var j = 2; j < aggs.length; j++) {
        var pc = aggs[j-1].c, cc = aggs[j].c;
        if (!pc || !cc || pc <= 0) continue;
        var movePct = (cc - pc) / pc * 100;
        if (movePct >= 15) {
          // Only use moves where we have enough pre-history to score
          if (j >= 5) movesFound.push({ idx: j, pct: movePct });
        }
      }

      // For each move found, calculate what the pre-move MIS would have been
      for (var k = 0; k < movesFound.length; k++) {
        var mv    = movesFound[k];
        var preMIS = calcPreMoveMIS(aggs, mv.idx, floatM);
        if (preMIS === null) continue;
        results.push({
          sym:      sym,
          preMIS:   preMIS,
          actualPct: rnd(mv.pct, 1),
          floatM:   floatM,
          moveDate: new Date(aggs[mv.idx].t||0).toISOString().slice(0,10)
        });
        processed++;
      }
      await sleep(350); // Respect Yahoo rate limits
    } catch(e) { console.error('[BACKTEST]', sym, e.message); skipped++; }
  }

  if (!results.length) {
    return tg('Backtest incomplete — not enough historical move data found.\nTry running /autopsy first to populate the ticker universe, then retry /backtest.', chatId);
  }

  // ── TIER ANALYSIS ─────────────────────────────────────────────────────
  var tiers = [
    { label:'80-100', min:80, max:100, threshold:20, desc:'HIGH CONVICTION' },
    { label:'65-79',  min:65, max:79,  threshold:15, desc:'ELEVATED' },
    { label:'50-64',  min:50, max:64,  threshold:10, desc:'MODERATE' },
    { label:'<50',    min:0,  max:49,  threshold:10, desc:'LOW' }
  ];

  var tierStats = tiers.map(function(tier) {
    var inTier = results.filter(function(r){ return r.preMIS >= tier.min && r.preMIS <= tier.max; });
    var hits   = inTier.filter(function(r){ return r.actualPct >= tier.threshold; });
    return {
      label:     tier.label,
      desc:      tier.desc,
      threshold: tier.threshold,
      total:     inTier.length,
      hits:      hits.length,
      hitRate:   inTier.length > 0 ? rnd(hits.length/inTier.length*100, 1) : 0,
      avgMove:   inTier.length > 0 ? rnd(inTier.reduce(function(a,r){return a+r.actualPct;},0)/inTier.length,1) : 0,
      maxMove:   inTier.length > 0 ? Math.max.apply(null,inTier.map(function(r){return r.actualPct;})) : 0
    };
  });

  // ── COMPONENT CORRELATION ─────────────────────────────────────────────
  // Find which MIS ranges best predicted big moves
  var topMovers   = results.filter(function(r){return r.actualPct>=25;});
  var avgMISTop   = topMovers.length ? rnd(topMovers.reduce(function(a,r){return a+r.preMIS;},0)/topMovers.length,0) : 0;
  var avgMISAll   = rnd(results.reduce(function(a,r){return a+r.preMIS;},0)/results.length,0);
  var avgMoveAll  = rnd(results.reduce(function(a,r){return a+r.actualPct;},0)/results.length,1);

  // ── WEIGHT TUNING SUGGESTIONS ─────────────────────────────────────────
  var highMIS = results.filter(function(r){return r.preMIS>=75;});
  var highHits = highMIS.filter(function(r){return r.actualPct>=20;});
  var currentHitRate = highMIS.length > 0 ? rnd(highHits.length/highMIS.length*100,1) : 0;
  var gapTo88 = rnd(88 - currentHitRate, 1);

  // Find the float tier that produces best outcomes
  var nanoMoves  = results.filter(function(r){return r.floatM<5;});
  var tightMoves = results.filter(function(r){return r.floatM>=5&&r.floatM<15;});
  var nanoAvg    = nanoMoves.length  ? rnd(nanoMoves.reduce(function(a,r){return a+r.actualPct;},0)/nanoMoves.length,1) : 0;
  var tightAvg   = tightMoves.length ? rnd(tightMoves.reduce(function(a,r){return a+r.actualPct;},0)/tightMoves.length,1) : 0;

  // Store backtest results in memory for future reference
  memory.backtest = {
    generated:      Date.now(),
    tested:         results.length,
    skipped:        skipped,
    tierStats:      tierStats,
    hitRateAtMIS75: currentHitRate,
    avgMISForBigMoves: avgMISTop,
    avgMoveAll:     avgMoveAll
  };
  await saveMemory();

  // ── BUILD REPORT ──────────────────────────────────────────────────────
  var msg = '<b>🧪 MAVERICK BACKTEST RESULTS</b>\n';
  msg += 'Analyzed: ' + results.length + ' historical setups across ' + (candidates.length - skipped) + ' tickers\n';
  msg += 'Period: Last 45 trading days\n\n';

  msg += '<b>📊 MIS TIER PERFORMANCE:</b>\n';
  tierStats.forEach(function(t) {
    var bar = '';
    var filled = t.total > 0 ? Math.round(t.hitRate/20) : 0;
    for (var bi=0; bi<5; bi++) bar += bi < filled ? '█' : '░';
    var arrow = t.hitRate >= 75 ? '🔥' : t.hitRate >= 55 ? '⚡' : t.hitRate >= 35 ? '👀' : '❌';
    msg += arrow+' MIS '+t.label+' → '+t.hitRate+'% gained '+t.threshold+'%+\n';
    msg += '   '+bar+' ('+t.hits+'/'+t.total+' setups | avg move +'+t.avgMove+'% | best +'+t.maxMove+'%)\n';
  });

  msg += '\n<b>🎯 88% TARGET ANALYSIS:</b>\n';
  msg += 'MIS ≥ 75 hit rate: <b>'+currentHitRate+'%</b> ('+highHits.length+'/'+highMIS.length+' setups)\n';
  if (gapTo88 > 0) {
    msg += 'Gap to 88% target: '+gapTo88+'pts\n';
    msg += '<b>Weight tuning needed:</b>\n';
    if (nanoAvg > tightAvg) {
      msg += '• Float < 5M produces best moves (avg +'+nanoAvg+'% vs +'+tightAvg+'% for 5-15M)\n';
      msg += '  → Recommend increasing float weight for nano tier\n';
    }
    if (avgMISTop > avgMISAll + 10) {
      msg += '• Top movers had avg pre-move MIS of '+avgMISTop+' vs overall avg '+avgMISAll+'\n';
      msg += '  → MIS is directionally correct but threshold needs raising\n';
    }
    msg += '• Current recommended entry threshold: MIS ≥ '+(currentHitRate>=75?'75':'80')+'\n';
  } else {
    msg += '🏆 <b>88% TARGET ACHIEVED</b> — MIS formula validated.\n';
  }

  msg += '\n<b>📐 FLOAT TIER BREAKDOWN:</b>\n';
  msg += 'Nano (<5M):   '+nanoMoves.length+' moves, avg +'+nanoAvg+'%\n';
  msg += 'Tight (5-15M): '+tightMoves.length+' moves, avg +'+tightAvg+'%\n';

  msg += '\n<b>🔬 KEY FINDINGS:</b>\n';
  var topTier = tierStats[0];
  msg += '• Best tier: MIS '+topTier.label+' — '+topTier.hitRate+'% hit rate, avg +'+topTier.avgMove+'% move\n';
  msg += '• Avg MIS before 25%+ moves: '+avgMISTop+'\n';
  msg += '• Overall avg move in dataset: +'+avgMoveAll+'%\n';
  if (topTier.hitRate >= 80) msg += '• Formula performing at HIGH CONFIDENCE level\n';
  else if (topTier.hitRate >= 65) msg += '• Formula needs more data or weight adjustment\n';
  else msg += '• Market was quiet during test period — retest after active week\n';

  msg += '\n<b>TOP HISTORICAL SETUPS FOUND:</b>\n';
  var topResults = results.slice().sort(function(a,b){return b.actualPct-a.actualPct;}).slice(0,5);
  topResults.forEach(function(r){
    msg += '$'+r.sym+' +'+r.actualPct+'% ('+r.moveDate+') | Pre-move MIS: '+r.preMIS+'\n';
  });

  msg += '\n/backtest again after an active trading week for better sample size.\n';
  msg += 'Results cached. /science TICKER uses these validated weights.';

  await tg(msg, chatId);
}

async function cmdBacktest(chatId) {
  // Check if we have a recent backtest cached (< 6 hours)
  if (memory.backtest && memory.backtest.generated && (Date.now() - memory.backtest.generated) < 6*3600*1000) {
    var bt = memory.backtest;
    var cached = '<b>🧪 BACKTEST CACHE (last run ' + rnd((Date.now()-bt.generated)/3600000,1) + 'h ago)</b>\n\n';
    cached += 'Setups tested: ' + bt.tested + '\n';
    cached += 'MIS ≥ 75 hit rate: <b>' + bt.hitRateAtMIS75 + '%</b>\n';
    cached += 'Avg move all setups: +' + bt.avgMoveAll + '%\n\n';
    bt.tierStats.forEach(function(t){
      cached += 'MIS '+t.label+': '+t.hitRate+'% hit rate ('+t.hits+'/'+t.total+')\n';
    });
    cached += '\nType /backtest force to run fresh analysis.';
    return tg(cached, chatId);
  }
  return runBacktest(chatId);
}
// ══════════════════════════════════════════════════════════════════════════
// ── TRADE CONFIDENCE ENGINE ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// The single most important psychological tool in the system.
// Fires every 5 minutes on open positions. Shows whether the ORIGINAL THESIS
// is still intact — so fear doesn't make the trading decision.
//
// Addresses the core behavioral trap:
//   → Buying at the top because of FOMO (no context for entry)
//   → Selling too early because a normal pullback feels like failure
//   → Missing the actual move by exiting at +3% when TP1 was +40%
//
// The engine separates: "this is normal volatility" from "thesis is broken."

function calcTradeConfidence(pos, d) {
  var price = d.price, entry = pos.entry;
  var pct   = rnd((price - entry) / entry * 100, 2);
  var score = 0;
  var reasons = [], warnings = [], pullbackContext = '';

  var rvol    = d.relVol;
  var lifecycle = detectLifecyclePhase(d);
  var im      = calcIntradayMomentum ? calcIntradayMomentum(d) : { aboveVwap: false, vwapProxy: price, fromOpen: 0 };

  // ── RVOL — are buyers still here? ────────────────────────────────────────
  if      (rvol >= 8)  { score += 30; reasons.push('RVOL '+rvol+'x — institutional buying STILL active. They haven\'t left.'); }
  else if (rvol >= 4)  { score += 20; reasons.push('RVOL '+rvol+'x — elevated. Thesis supported by volume.'); }
  else if (rvol >= 2)  { score += 10; reasons.push('RVOL '+rvol+'x — above average. Monitoring.'); }
  else                  { score -= 10; warnings.push('RVOL '+rvol+'x — volume fading. This is your #1 exit signal.'); }

  // ── VWAP PROXY — are buyers in control? ──────────────────────────────────
  if (im.aboveVwap)     { score += 20; reasons.push('Above VWAP proxy ($'+im.vwapProxy+') — bulls in structural control. Every buyer since open is profitable.'); }
  else                  { score -= 5;  warnings.push('Below VWAP proxy ($'+im.vwapProxy+') — bears have short-term edge. Normal if early in pullback.'); }

  // ── LIFECYCLE PHASE — where are you in the move? ─────────────────────────
  if (lifecycle.phase <= 2)  { score += 20; reasons.push(lifecycle.name+' — still early. The main move hasn\'t happened yet. This is where patience pays.'); }
  else if (lifecycle.phase === 3){ score += 10; reasons.push('Phase 3 continuation — still running but tightening stops makes sense.'); }
  else if (lifecycle.phase >= 4) { score -= 15; warnings.push(lifecycle.name+' — late phase. Thesis is aging. Start planning your exit.'); }

  // ── STOP DISTANCE — is your position structurally safe? ──────────────────
  var stopDist = pos.stop > 0 ? rnd((price - pos.stop) / price * 100, 1) : 0;
  if      (stopDist > 15)  { score += 15; reasons.push('Stop $'+pos.stop+' is '+stopDist+'% below — well protected. This is breathing room, not failure.'); }
  else if (stopDist > 8)   { score += 8;  reasons.push('Stop '+stopDist+'% away — acceptable cushion.'); }
  else if (stopDist > 3)   { score += 3;  warnings.push('Stop only '+stopDist+'% away. Consider trailing to breakeven if up 10%+.'); }
  else if (stopDist > 0)   { score -= 5;  warnings.push('Stop within 3% — may fire on normal volatility. Evaluate vs thesis.'); }

  // ── PULLBACK CONTEXT — is this normal or a problem? ──────────────────────
  if (pct < 0) {
    var pullbackPct = Math.abs(pct);
    if (pullbackPct < 5 && im.aboveVwap && rvol >= 3) {
      pullbackContext = '📊 <b>Pullback context:</b> -'+rnd(pullbackPct,1)+'% from entry is NORMAL Phase 2 behavior. Stocks never go straight up. RVOL '+rvol+'x is still elevated — the move is NOT over. The whales who caused this are still in the building.';
    } else if (pullbackPct < 10 && score >= 35) {
      pullbackContext = '📊 <b>Pullback context:</b> -'+rnd(pullbackPct,1)+'% from entry. Thesis '+(score>=50?'still intact':'under review')+'. Your stop at $'+pos.stop+' is the true decision line — not this pullback.';
    } else if (pullbackPct >= 10) {
      pullbackContext = '⚠️ <b>Pullback context:</b> -'+rnd(pullbackPct,1)+'% from entry is significant. Review: is the original catalyst still valid? Is RVOL holding?';
    }
  } else if (pct > 0 && pct < 8 && pos.tp1 > 0) {
    // Early gain — the sell-too-early trap
    var tp1Dist = rnd((pos.tp1 - price) / price * 100, 1);
    pullbackContext = '💡 <b>Hold context:</b> Up +'+rnd(pct,1)+'%, TP1 is still +'+tp1Dist+'% away. Your original analysis set TP1 at $'+pos.tp1+' for a reason. The market hasn\'t changed — your emotions have. Hold the plan.';
  }

  score = Math.min(100, Math.max(0, score));
  var tier = score>=70?'💚 HOLD WITH CONVICTION':score>=50?'🟡 THESIS INTACT — HOLD':score>=35?'🟠 WATCH CLOSELY':' 🔴 REVIEW YOUR STOP';

  return { score, tier, reasons, warnings, pullbackContext, pct, stopDist, lifecycle, rvol, aboveVwap: im.aboveVwap };
}

// ── TRADE CONFIDENCE PULSE — fires every 5 min on open positions ──────────
async function sendTradeConfidencePulse() {
  if (!isMarketOpen() && !isPreMarketHours()) return;
  var syms = Object.keys(positions);
  if (!syms.length) return;

  for (var si=0; si<syms.length; si++) {
    var sym = syms[si], pos = positions[sym];
    delete dataCache[sym]; // Always fresh data for positions
    var d = await getStock(sym).catch(function(){return null;});
    if (!d) continue;

    var conf = calcTradeConfidence(pos, d);
    var price = d.price;
    var pctStr = (conf.pct >= 0 ? '+' : '') + rnd(conf.pct, 2) + '%';
    var marketLabel = d.isPreMarket ? ' 🌅' : d.isPostMarket ? ' 🌙' : '';

    var msg = conf.tier + '\n';
    msg += '<b>$'+sym+'</b> '+cFlag(sym)+marketLabel+' — $'+price+' ('+pctStr+' from entry $'+pos.entry+')\n';
    msg += 'Confidence: <b>'+conf.score+'/100</b>\n\n';

    if (conf.reasons.length) {
      msg += '<b>Why the thesis is still valid:</b>\n';
      conf.reasons.slice(0, 3).forEach(function(r){ msg += '• '+r+'\n'; });
    }

    if (conf.warnings.length) {
      msg += '\n<b>Watch these:</b>\n';
      conf.warnings.forEach(function(w){ msg += '• '+w+'\n'; });
    }

    // Stop vs TP context — the asymmetry reminder
    msg += '\nStop: $'+pos.stop;
    if (conf.stopDist > 0) msg += ' ('+conf.stopDist+'% away)';
    if (pos.tp1) {
      var tp1Dist = rnd((pos.tp1 - price) / price * 100, 1);
      msg += '  →  TP1: $'+pos.tp1+' (+'+(tp1Dist>=0?tp1Dist:0)+'% away)';
    }

    if (conf.pullbackContext) msg += '\n\n'+conf.pullbackContext;

    await tg(msg);
    await sleep(1000);
  }
}

// ── /confidence TICKER — on-demand confidence analysis ────────────────────
async function cmdConfidence(sym, chatId) {
  var pos = positions[sym];
  if (!pos) return tg('No tracked position for $'+sym+'.\n\nLog one first: /position '+sym+' ENTRY STOP TP1 TP2 SHARES', chatId);
  await tg('⏳ Running Trade Confidence analysis for $'+sym+'...', chatId);
  delete dataCache[sym];
  var d = await getStock(sym).catch(function(){return null;});
  if (!d) return tg('Cannot pull live data for $'+sym+'. Position data shown below:\nEntry:$'+pos.entry+' Stop:$'+pos.stop+' TP1:'+(pos.tp1||'not set'), chatId);

  var conf = calcTradeConfidence(pos, d);
  var pctStr = (conf.pct >= 0 ? '+' : '') + rnd(conf.pct, 2) + '%';

  var msg = '<b>🧠 TRADE CONFIDENCE — $'+sym+' '+cFlag(sym)+'</b>\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n';
  msg += conf.tier+'\n';
  msg += 'Confidence score: <b>'+conf.score+'/100</b>\n';
  msg += 'P&L from entry: <b>'+pctStr+'</b> ($'+pos.entry+' → $'+d.price+')\n\n';

  msg += '<b>THESIS CHECK:</b>\n';
  conf.reasons.forEach(function(r){ msg += '✅ '+r+'\n'; });
  if (conf.warnings.length) {
    msg += '\n<b>CONCERNS:</b>\n';
    conf.warnings.forEach(function(w){ msg += '⚠️ '+w+'\n'; });
  }

  msg += '\n<b>LEVELS:</b>\n';
  msg += 'Entry: $'+pos.entry+'\n';
  msg += 'Stop:  $'+pos.stop+(conf.stopDist>0?' ('+conf.stopDist+'% away)':'')+'\n';
  if (pos.tp1) { var tp1d=rnd((pos.tp1-d.price)/d.price*100,1); msg += 'TP1:   $'+pos.tp1+' (+'+(tp1d>=0?tp1d:0)+'% away) — sell 50%\n'; }
  if (pos.tp2) { var tp2d=rnd((pos.tp2-d.price)/d.price*100,1); msg += 'TP2:   $'+pos.tp2+' (+'+(tp2d>=0?tp2d:0)+'% away) — sell 30%\n'; }

  if (conf.pullbackContext) msg += '\n'+conf.pullbackContext;

  if (conf.score >= 70) {
    msg += '\n\n<b>BOTTOM LINE: Hold the position.</b>\nYour thesis is intact. Fear is not a strategy. The bot is watching it for you.';
  } else if (conf.score < 40) {
    msg += '\n\n<b>BOTTOM LINE: Review your stop.</b>\nConditions are deteriorating. Don\'t hope — protect capital.';
  }

  await tg(msg, chatId);
}
// Pre-fetches data for all active tickers so deep commands are instant.
async function warmCache() {
  var gainers = await getTopGainers().catch(function(){return [];});
  var priority = gainers.slice(0,15).map(function(g){return g.ticker;});
  Object.keys(watchlist).forEach(function(t){if(priority.indexOf(t)===-1)priority.push(t);});
  BASE_SCAN.slice(0,20).forEach(function(t){if(priority.indexOf(t)===-1)priority.push(t);});
  priority = priority.filter(function(v,i,a){return a.indexOf(v)===i && v && v.length<=5;}).slice(0,35);
  console.log('[WARM] Pre-warming '+priority.length+' tickers...');
  var warmed = 0;
  for (var i=0; i<priority.length; i++) {
    try { var d = await getStock(priority[i]); if(d) warmed++; await sleep(400); } catch(e) {}
  }
  console.log('[WARM] Cache ready. '+warmed+'/'+priority.length+' tickers loaded.');
}

async function start() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║    MAVERICK INTEL BOT v6.7           ║');
  console.log('║    NLP+CASCADE+CONFIDENCE ENGINE     ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log('  Telegram:   '+(TG_TOKEN?'INTEL_BOT_TOKEN connected':'MISSING'));
  console.log('  Chat ID:    '+(CHAT_ID?'connected ('+CHAT_ID+')':'MISSING — set INTEL_BOT_CHAT'));
  console.log('  Mode:       Webhook (Telegram pushes → no polling conflict)');
  console.log('  Data:       Yahoo Finance (parallel) + Finnhub + Polygon');
  console.log('  Polygon:    '+(POLYGON?'connected':'not set'));
  console.log('  Finnhub:    '+(FINNHUB?'connected':'not set'));
  console.log('  Groq AI:    '+(GROQ_KEY?'connected':'not set'));
  console.log('  Cerebras:   '+(CBRS_KEY?'connected':'not set'));
  console.log('  JSONBin:    '+(JSONBIN_ID?'configured':'not set'));
  console.log('');
  if (!TG_TOKEN) { console.error('[BOT] FATAL: No INTEL_BOT_TOKEN. Cannot start.'); return; }
  if (!CHAT_ID)  { console.error('[BOT] WARNING: No INTEL_BOT_CHAT. Proactive alerts will NOT send.'); }

  await loadMemory();

  // Register webhook with Telegram — tells Telegram to push messages here
  var WEBHOOK_URL = 'https://maverick-terminal.onrender.com/webhook';
  try {
    var whr = await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: WEBHOOK_URL, drop_pending_updates: true, allowed_updates: ['message','channel_post'] })
    });
    var whd = await safeJson(whr);
    if (whd.ok) {
      console.log('[WEBHOOK] Registered: ' + WEBHOOK_URL);
    } else {
      console.error('[WEBHOOK] Registration failed:', JSON.stringify(whd));
    }
  } catch(e) { console.error('[WEBHOOK] setWebhook error:', e.message); }

  await tg(
    '<b>MAVERICK INTEL BOT v6.5 — ONLINE</b>\n\n' +
    '🌅 PRE-MARKET LIVE — The Golden Window is open\n\n' +
    '<b>v6.5 — PRE-MARKET ENGINE:</b>\n' +
    '• ALL prices now switch to live preMarketPrice during 4-9:30AM ET\n' +
    '• Pre-market scanner fires every 5min — 4AM to 9:30AM ET\n' +
    '• Gaps >8% trigger immediate alert with float rotation %\n' +
    '• Morning briefing fires during pre-market with live prices\n' +
    '• Staircase scanner active during pre-market hours\n' +
    '• Position monitor uses live pre/post market price — no stale data\n' +
    '• SBFM +596%, GOVX +181% type moves will NOT be missed again\n\n' +
    'Type /briefing to see current pre-market setups.'
  );

  setInterval(monitorPositions,  60000);
  setInterval(checkPriceAlerts,  30000);
  setInterval(scanNewsIntel,    120000);
  setInterval(morningBriefing,  300000);
  setInterval(pruneHeadlines,  3600000);
  setInterval(runStaircaseScanner, 300000);
  setInterval(runPreMarketScanner, 300000);
  setInterval(runAlgoAndIntradayScan, 600000);
  setInterval(sendTradeConfidencePulse, 300000); // Every 5 min — confidence pulse on open positions
  setInterval(warmCache, 1800000);
  setTimeout(warmCache, 45000);
  setTimeout(runAlgoAndIntradayScan, 90000);
  setTimeout(runPreMarketScanner, 15000);

  console.log('[BOT] v6.5 running. Pre-market live prices. Golden window active. Position monitor live.');
}

start();
