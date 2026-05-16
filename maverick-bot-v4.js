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

// ── RENDER HTTP SERVER ─────────────────────────────────────────────────────
// Render Web Service requires an open port or it kills the process.
// This tiny server satisfies that requirement. Bot runs normally alongside it.
var PORT = process.env.PORT || 10000;
http.createServer(function(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('MAVERICK INTEL BOT v4.1 — ONLINE\n');
}).listen(PORT, function() {
  console.log('[SERVER] HTTP keepalive listening on port ' + PORT);
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
var lastNewsTs       = Math.floor(Date.now() / 1000) - 300;
var sentHeadlines    = new Set();
var activeProtocol   = null;
var lastBriefingDate = '';

// ── MEMORY ─────────────────────────────────────────────────────────────────
var memory = { trades: [], preferences: {}, winRates: {}, science: null, lastUpdated: 0 };

// ── BASE UNIVERSE ──────────────────────────────────────────────────────────
var BASE_SCAN = [
  'MARA','RIOT','SOFI','HOOD','FFIE','MULN','ATER','BBIG',
  'GFAI','GMBL','NKLA','GPUS','AIXI','AAOI','VERB','CNEY','XTIA',
  'MSTX','IONQ','RKLB','ACHR','PLTR','AMD'
];

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
  if (/\b(supernova|snova|rule of five|supernova score)\b/.test(lower)) return 'supernova';
  if (/\b(gap up|gapping|gappers|gainers|top gain|top gainer)\b/.test(lower)) return 'gappers';
  return null;
}

// ── HELPERS ────────────────────────────────────────────────────────────────
var rnd = function(n, d) { return +Number(n).toFixed(d === undefined ? 2 : d); };
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function nowHourCT() {
  try {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
    return parseInt(fmt.format(new Date()), 10);
  } catch (e) { return (new Date().getUTCHours() - 5 + 24) % 24; }
}

function pruneHeadlines() {
  if (sentHeadlines.size > 500) {
    var arr = Array.from(sentHeadlines).slice(-200);
    sentHeadlines.clear();
    arr.forEach(function(h) { sentHeadlines.add(h); });
  }
}

// ── JSONBIN ────────────────────────────────────────────────────────────────
async function loadMemory() {
  if (!JSONBIN_ID || !JSONBIN_KEY) { console.log('[MEMORY] Not configured — running in-memory only'); return; }
  try {
    var r    = await fetch('https://api.jsonbin.io/v3/b/' + JSONBIN_ID + '/latest', { headers: { 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Meta': 'false' } });
    var text = await r.text();
    if (!text) { console.error('[MEMORY] Empty response'); return; }
    var d = JSON.parse(text), rec = (d && d.record) ? d.record : d;
    if (rec && rec.trades) { memory = Object.assign(memory, rec); console.log('[MEMORY] Loaded ' + (memory.trades ? memory.trades.length : 0) + ' trades'); }
    else console.log('[MEMORY] Fresh start');
  } catch (e) { console.error('[MEMORY] Load failed:', e.message); }
}

async function saveMemory() {
  if (!JSONBIN_ID || !JSONBIN_KEY) return;
  try {
    memory.lastUpdated = Date.now();
    await fetch('https://api.jsonbin.io/v3/b/' + JSONBIN_ID, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY }, body: JSON.stringify(memory) });
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

// ── DATA LAYER ─────────────────────────────────────────────────────────────
// PRIMARY: Yahoo Finance (free, live, no key needed)
async function yahooQuote(sym) {
  try {
    var r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=2d', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaverickBot/4.1)' } });
    var d = await r.json(), res = d && d.chart && d.chart.result && d.chart.result[0], meta = res && res.meta;
    if (meta && meta.regularMarketPrice && meta.regularMarketPrice > 0) {
      return { price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice, volume: meta.regularMarketVolume || 0, high: meta.regularMarketDayHigh || meta.regularMarketPrice, low: meta.regularMarketDayLow || meta.regularMarketPrice, open: meta.regularMarketOpen || meta.regularMarketPrice, week52H: meta.fiftyTwoWeekHigh || 0, week52L: meta.fiftyTwoWeekLow || 0, source: 'Yahoo' };
    }
  } catch (e) { console.error('[Yahoo]', sym, e.message); }
  return null;
}

// SECONDARY: Finnhub quote
async function fhQuote(sym) {
  if (!FINNHUB) return null;
  try {
    var r = await fetch('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + FINNHUB), text = await r.text();
    if (!text || text.trim() === '') return null;
    var d = JSON.parse(text);
    if (d && d.c && d.c > 0) return { price:d.c, prevClose:d.pc||d.c, volume:d.v||0, high:d.h||d.c, low:d.l||d.c, open:d.o||d.c, source:'Finnhub' };
  } catch (e) {}
  return null;
}

// Finnhub fundamentals
async function fhMetrics(sym) {
  if (!FINNHUB) return null;
  try { var r = await fetch('https://finnhub.io/api/v1/stock/metric?symbol='+sym+'&metric=all&token='+FINNHUB), text = await r.text(); if (!text||text.trim()==='') return null; return JSON.parse(text); } catch (e) { return null; }
}

async function fh(ep) {
  if (!FINNHUB) return null;
  try { var sep = ep.indexOf('?')!==-1?'&':'?', r = await fetch('https://finnhub.io/api/v1'+ep+sep+'token='+FINNHUB), text = await r.text(); if (!text||text.trim()==='') return null; return JSON.parse(text); } catch (e) { return null; }
}

// Polygon daily aggs (works on free plan)
async function polyAggs(sym, days) {
  if (!POLYGON) return null;
  days = days || 20;
  try {
    var to = todayStr(), from = new Date(Date.now() - days*86400000).toISOString().slice(0,10);
    var r = await fetch('https://api.polygon.io/v2/aggs/ticker/'+sym+'/range/1/day/'+from+'/'+to+'?adjusted=true&sort=asc&limit=50&apiKey='+POLYGON);
    var d = await r.json(); if (d && d.results && d.results.length) return d.results;
  } catch (e) { console.error('[polyAggs]', sym, e.message); }
  return null;
}

// Polygon gainers (works on free plan)
async function getTopGainers() {
  if (!POLYGON) return [];
  try { var r = await fetch('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey='+POLYGON), d = await r.json(); if (d && d.tickers) return d.tickers.slice(0,20); } catch (e) {}
  return [];
}

// Polygon news (works on free plan)
async function polyNewsRaw(tickerOrNull, limit) {
  if (!POLYGON) return [];
  limit = limit || 25;
  try {
    var url = 'https://api.polygon.io/v2/reference/news?limit='+limit+'&order=desc&sort=published_utc&apiKey='+POLYGON;
    if (tickerOrNull) url += '&ticker=' + tickerOrNull;
    var r = await fetch(url), d = await r.json(); if (d && d.results) return d.results;
  } catch (e) {}
  return [];
}

// ── UNIFIED STOCK DATA ─────────────────────────────────────────────────────
async function getStock(sym) {
  try {
    var price=0, prevClose=0, volume=0, high=0, low=0, open=0, week52H=0, week52L=0, source='unknown';

    // TIER 1: Yahoo Finance (primary — free and live)
    var yq = await yahooQuote(sym);
    if (yq && yq.price > 0) { price=yq.price; prevClose=yq.prevClose; volume=yq.volume; high=yq.high; low=yq.low; open=yq.open; week52H=yq.week52H; week52L=yq.week52L; source='Yahoo'; }

    // TIER 2: Finnhub
    if (!price || price <= 0) {
      var fq = await fhQuote(sym);
      if (fq && fq.price > 0) { price=fq.price; prevClose=fq.prevClose; volume=fq.volume; high=fq.high; low=fq.low; open=fq.open; source='Finnhub'; }
    }

    // TIER 3: Polygon aggs (last close)
    if (!price || price <= 0) {
      var aggs3 = await polyAggs(sym, 5);
      if (aggs3 && aggs3.length >= 1) {
        var last=aggs3[aggs3.length-1], before=aggs3.length>=2?aggs3[aggs3.length-2]:last;
        price=last.c; prevClose=before.c; volume=last.v; high=last.h; low=last.l; open=last.o; source='Polygon (EOD)';
      }
    }

    if (!price || price <= 0) return null;

    // RVOL
    var avgVol = 500000;
    var aggs = await polyAggs(sym, 20);
    if (aggs && aggs.length >= 3) { var vols=aggs.slice(-10).map(function(a){return a.v||0;}); avgVol=vols.reduce(function(a,b){return a+b;},0)/vols.length; }

    // Gap
    var gapPct = 0;
    if (aggs && aggs.length >= 2) { var pd=aggs[aggs.length-2]; if (pd&&pd.c>0) gapPct=rnd((open-pd.c)/pd.c*100,2); }

    // Fundamentals
    var floatM=50, shortPct=0;
    if (!week52H || week52H<=0) { week52H=price*2; week52L=price*0.3; }
    var metrics = await fhMetrics(sym);
    if (metrics && metrics.metric) {
      var m=metrics.metric;
      if (m.sharesFloat&&m.sharesFloat>0) floatM=m.sharesFloat;
      if (m.shortInterestPercentOfFloat) shortPct=m.shortInterestPercentOfFloat;
      if (m['52WeekHigh']&&!week52H) week52H=m['52WeekHigh'];
      if (m['52WeekLow']&&!week52L) week52L=m['52WeekLow'];
    }

    var changePct   = prevClose>0 ? rnd((price-prevClose)/prevClose*100,2) : 0;
    var relVol      = rnd(volume/Math.max(avgVol,1),2);
    var atr         = rnd(price*0.025,4);
    var daysToCover = floatM>0&&avgVol>0 ? rnd((floatM*1e6)/avgVol,2) : 99;

    return { sym, price, changePct, gapPct, high, low, open, prevClose, volume, avgVol:rnd(avgVol,0), relVol, floatM, shortPct, week52High:week52H, week52Low:week52L, atr, daysToCover, source };
  } catch (e) { console.error('[getStock]', sym, e.message); return null; }
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
  if      (d.price<1) {score+=10;flags.push('SUB-$1');}
  else if (d.price<3) {score+=9;}
  else if (d.price<5) {score+=6;}
  else if (d.price<10){score+=3;}
  if (d.shortPct>30&&d.relVol>3){score+=18;flags.push('SQUEEZE SETUP');}
  else if (d.shortPct>20){score+=9;flags.push('SHORT '+rnd(d.shortPct,1)+'%');}
  if (d.week52High>0){var pf=(d.week52High-d.price)/Math.max(d.week52High,0.01)*100; if(pf<2&&d.changePct>0){score+=10;flags.push('52W BREAKOUT');}}
  return { score: Math.min(100, Math.max(0, score)), flags };
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
  if      (d.price<2) {score+=5;components.push('Price 5/5 — sub-$2');}
  else if (d.price<5) {score+=4;components.push('Price 4/5 — $2-5');}
  else if (d.price<10){score+=2;components.push('Price 2/5 — $5-10');}
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

// ── PROTOCOLS ──────────────────────────────────────────────────────────────
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
  var hourCT = nowHourCT();
  var changeAbs = Math.abs(d.changePct);

  // Phase 5: Distribution / Fade — late day, volume dying
  if (hourCT >= 14 && d.relVol < 1.5 && d.changePct < d.changePct * 0.5)
    return { phase: 5, name: 'PHASE 5 — DISTRIBUTION/FADE', emoji: '🔴', action: 'EXIT. Whales distributing. Retail holding the bag. If you\'re in, get out now.', entryOk: false };

  // Phase 4: Late Run / Exhaustion
  if (hourCT >= 13 && d.changePct >= 30 && d.relVol >= 3)
    return { phase: 4, name: 'PHASE 4 — LATE RUN/EXHAUSTION', emoji: '🟠', action: 'DANGER ZONE. Move is extended. Only trail existing position. No new entries. Exit before 3:45PM CT.', entryOk: false };

  // Phase 3: Mid-Day Continuation
  if (hourCT >= 11 && hourCT < 14 && d.changePct >= 15 && d.relVol >= 3)
    return { phase: 3, name: 'PHASE 3 — MID-DAY CONTINUATION', emoji: '🟡', action: 'PARTIAL ENTRY OK on pullback to VWAP. Tighter size than Phase 1-2. Stop below mid-day low.', entryOk: true };

  // Dead Zone
  if (hourCT >= 11 && hourCT < 13 && d.relVol < 2)
    return { phase: 0, name: 'DEAD ZONE (11AM-1PM CT)', emoji: '⚫', action: 'Volume dry. No edge. Wait for Phase 3 continuation or walk away.', entryOk: false };

  // Phase 2: First Pullback / Dip Buy
  if (hourCT >= 10 && hourCT < 12 && d.changePct >= 10 && d.relVol >= 3)
    return { phase: 2, name: 'PHASE 2 — FIRST PULLBACK / DIP BUY', emoji: '🟢', action: 'PRIME ENTRY WINDOW. Dip to VWAP or 9EMA. This is your Archetype B setup. Stop below Phase 1 low.', entryOk: true };

  // Phase 1: Morning Ignition
  if (hourCT >= 9 && hourCT < 11 && d.changePct >= 5 && d.relVol >= 2)
    return { phase: 1, name: 'PHASE 1 — MORNING IGNITION', emoji: '🟢', action: 'PRIMARY ENTRY ZONE. First candle break or pullback to VWAP. Highest probability window for supernova runs.', entryOk: true };

  // Pre-Ignition
  if (hourCT < 9 || (d.gapPct >= 10 && hourCT === 9))
    return { phase: 0, name: 'PRE-IGNITION', emoji: '🔵', action: 'Pre-market. Watch but do not enter. Wait for first 5-min candle to close. Gap must hold at open.', entryOk: false };

  return { phase: 0, name: 'NO CLEAR PHASE', emoji: '⚪', action: 'Setup not in an active window. Wait or monitor.', entryOk: false };
}

// ── KILL ZONE EXIT SIGNALS ────────────────────────────────────────────────
function getKillZoneSignals(d) {
  var hourCT = nowHourCT();
  var signals = [], critical = false;

  if (hourCT >= 15 && hourCT < 16) { signals.push('HARD EXIT ZONE — 3:45PM CT rule: flatten all positions before close'); critical = true; }
  if (d.relVol < 1.5 && d.changePct > 0) { signals.push('RVOL DYING — '+d.relVol+'x: volume fading means distribution. Whales exiting.'); }
  if (d.changePct < 0 && d.relVol > 2) { signals.push('HIGH VOLUME REVERSAL — selling on big volume. Thesis broken.'); critical = true; }
  if (hourCT >= 11 && hourCT <= 13 && d.relVol < 2) { signals.push('DEAD ZONE TRAP — 11AM-1PM low-volume grind. Easy to get faked out.'); }
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
      var r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY},body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:maxTokens,temperature:0.3,messages})});
      var gd=await r.json(), text=gd&&gd.choices&&gd.choices[0]&&gd.choices[0].message&&gd.choices[0].message.content;
      if (text) {
        if (chatId){if(!chatHistory[chatId])chatHistory[chatId]=[];chatHistory[chatId].push({role:'user',content:user},{role:'assistant',content:text});if(chatHistory[chatId].length>24)chatHistory[chatId]=chatHistory[chatId].slice(-24);}
        return text;
      }
    } catch (e) { console.error('[Groq]', e.message); }
  }
  if (CBRS_KEY) {
    try {
      var r2=await fetch('https://api.cerebras.ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+CBRS_KEY},body:JSON.stringify({model:'llama3.1-8b',max_tokens:maxTokens,temperature:0.3,messages})});
      var d2=await r2.json(), txt2=d2&&d2.choices&&d2.choices[0]&&d2.choices[0].message&&d2.choices[0].message.content;
      if (txt2) return txt2;
    } catch (e) { console.error('[Cerebras]', e.message); }
  }
  return null;
}

// ── NEWS SCANNING ──────────────────────────────────────────────────────────
var BULLISH_KW=['fda approval','fda approved','fda clearance','merger','acquisition','buyout','earnings beat','short squeeze','trading halted','halt','government contract','phase 3 results','phase 3 trial','uplisting','nasdaq compliance','barda contract','dod contract','positive data','breakthrough','upgraded','price target raised','record revenue','beat estimates','raised guidance','partnership agreement','clinical data','positive results','contract award','data readout'];
var BEARISH_KW=['going concern','dilution','public offering','atm offering','shelf registration','bankruptcy','delisting','class action','default','missed estimates','downgraded','lowered guidance','fraud','sec investigation','restatement'];

async function scanNewsIntel() {
  pruneHeadlines();
  try {
    if (POLYGON) {
      var articles=await polyNewsRaw(null,50);
      for (var i=0;i<articles.length;i++) {
        var art=articles[i], pubTs=art.published_utc?new Date(art.published_utc).getTime()/1000:0;
        if (pubTs&&pubTs<=lastNewsTs) continue;
        var key=art.id||art.title; if (sentHeadlines.has(key)) continue;
        var body=(art.title+' '+(art.description||'')).toLowerCase();
        var hits=BULLISH_KW.filter(function(k){return body.indexOf(k)!==-1;});
        var negs=BEARISH_KW.filter(function(k){return body.indexOf(k)!==-1;});
        var ticks=(art.tickers||[]).filter(function(t){return t&&t.length>=1&&t.length<=5;});
        if (hits.length>=1&&negs.length===0&&ticks.length>=1) {
          sentHeadlines.add(key);
          var cat=identifyCatalyst(art.title), ageMin=pubTs?Math.round((Date.now()/1000-pubTs)/60):0;
          var pub=art.publisher&&art.publisher.name?art.publisher.name:'News';
          var msg='CATALYST [Rank '+cat.rank+'/5] '+cat.name.toUpperCase()+'\n'+art.title+'\n'+pub+' — '+ageMin+'m ago\nTickers: '+ticks.slice(0,3).join(', ')+'\nSignal: '+hits.slice(0,2).join(', ');
          if (ticks[0]) msg+='\n\n/science '+ticks[0]+' | /check '+ticks[0];
          await tg(msg); await sleep(1500);
        }
        if (negs.length>=1&&ticks.length>=1){sentHeadlines.add(key);await tg('BEARISH FLAG: '+art.title+'\n'+negs.slice(0,2).join(', ')+'\nWatch $'+ticks[0]);await sleep(1500);}
        if (pubTs&&pubTs>lastNewsTs) lastNewsTs=pubTs;
      }
    }
  } catch (e) { console.error('[NEWS-POLY]', e.message); }
  try {
    if (FINNHUB) {
      var wkeys=Object.keys(watchlist).slice(0,5);
      for (var w=0;w<wkeys.length;w++) {
        var wsym=wkeys[w], wFrom=new Date(Date.now()-86400000).toISOString().slice(0,10);
        var wNews=await fh('/company-news?symbol='+wsym+'&from='+wFrom+'&to='+todayStr());
        if (!Array.isArray(wNews)){await sleep(400);continue;}
        var fresh=wNews.filter(function(n){return n.datetime>lastNewsTs-3600&&n.headline;});
        for (var fn=0;fn<Math.min(fresh.length,2);fn++){
          var n=fresh[fn], nk=n.id||n.headline; if(sentHeadlines.has(nk)) continue;
          var bd=(n.headline+' '+(n.summary||'')).toLowerCase();
          var h2=BULLISH_KW.filter(function(k){return bd.indexOf(k)!==-1;});
          if(h2.length){sentHeadlines.add(nk);await tg('WATCHLIST $'+wsym+'\n'+n.headline+'\nSignal: '+h2[0]);await sleep(1500);}
        }
        await sleep(400);
      }
    }
  } catch (e) { console.error('[NEWS-FH]', e.message); }
  try {
    var eFrom=new Date(Date.now()-7200000).toISOString().slice(0,10);
    var er=await fetch('https://efts.sec.gov/LATEST/search-index?q=%228-K%22&forms=8-K&dateRange=custom&startdt='+eFrom+'&enddt='+todayStr(),{headers:{'User-Agent':'MaverickIntelBot/4.1 (research@maverick.ai)'}});
    if (er.ok){
      var ed=await er.json(), eHits=ed&&ed.hits&&ed.hits.hits?ed.hits.hits:[];
      for (var ek=0;ek<Math.min(eHits.length,6);ek++){
        var src=eHits[ek]&&eHits[ek]._source; if(!src) continue;
        var eKey=(src.entity_name||'')+'|'+(src.file_date||''); if(sentHeadlines.has(eKey)) continue;
        var tick=((src.ticker||'')||(src.tickers&&src.tickers[0])||'').toUpperCase().trim();
        if (!tick||tick.length>5) continue;
        sentHeadlines.add(eKey);
        await tg('SEC 8-K FILING\n'+(src.entity_name||'Unknown')+' ($'+tick+')\nFiled: '+(src.file_date||todayStr())+'\n/science '+tick+' | /check '+tick);
        await sleep(2000);
      }
    }
  } catch (e) { console.error('[NEWS-SEC]', e.message); }
}

// ── MORNING BRIEFING ───────────────────────────────────────────────────────
async function morningBriefing() {
  var hour=nowHourCT(), today=todayStr();
  if (hour<4||hour>=11) return;
  if (lastBriefingDate===today) return;
  lastBriefingDate=today;
  await tg('<b>MAVERICK MORNING BRIEFING v4.1</b>\n'+today+' | '+hour+':00 CT\n\nPulling top setups...');
  var gainers=await getTopGainers(), results=[];
  if (gainers.length) {
    for (var i=0;i<Math.min(gainers.length,15);i++) {
      var g=gainers[i], day=g.day||{}, prev=g.prevDay||{};
      var price=day.c||(g.lastTrade&&g.lastTrade.p)||0, prevClose=prev.c||price;
      var changePct=prevClose>0?rnd((price-prevClose)/prevClose*100,2):(g.todaysChangePerc||0);
      if (price<1||price>30||changePct<5) continue;
      var d=await getStock(g.ticker).catch(function(){return null;}); if(!d) continue;
      var sr=scoreSetup(d), mis=calcMIS(d,5);
      if (sr.score>=50) results.push(Object.assign({},d,{score:sr.score,flags:sr.flags,mis:mis.pct,misTier:mis.tier}));
    }
  } else {
    var settled=await Promise.allSettled(BASE_SCAN.slice(0,10).map(function(s){return getStock(s);}));
    for (var j=0;j<settled.length;j++){
      var rj=settled[j]; if(rj.status!=='fulfilled'||!rj.value) continue;
      var sr2=scoreSetup(rj.value), mis2=calcMIS(rj.value,5);
      if(sr2.score>=55) results.push(Object.assign({},rj.value,{score:sr2.score,flags:sr2.flags,mis:mis2.pct,misTier:mis2.tier}));
    }
  }
  results.sort(function(a,b){return (b.mis+b.score)-(a.mis+a.score);});
  if (!results.length){await tg('No high-conviction setups in premarket. Stay patient.');return;}
  var proto=activeProtocol?PROTOCOLS[activeProtocol].name:'Maverick Standard';
  var msg='<b>TOP PREMARKET SETUPS</b>\nProtocol: '+proto+'\n\n';
  for (var n=0;n<Math.min(5,results.length);n++){
    var d2=results[n], lbl=d2.score>=80?'HOT':d2.score>=65?'WARM':'WATCH';
    var stop=rnd(d2.price-d2.atr*1.5,4), tp1=rnd(d2.price+d2.atr*2,4);
    msg+='['+lbl+'] <b>$'+d2.sym+'</b> Score:'+d2.score+' MIS:'+d2.mis+'\n';
    msg+='$'+d2.price+' ('+(d2.changePct>=0?'+':'')+rnd(d2.changePct,1)+'%)';
    if(d2.gapPct) msg+='  Gap:+'+rnd(d2.gapPct,1)+'%';
    msg+='\nRVOL:'+d2.relVol+'x Float:'+d2.floatM+'M Source:'+( d2.source||'?')+'\n';
    msg+='Stop:$'+stop+'  TP1:$'+tp1+'  ['+d2.misTier+']\n\n';
  }
  msg+='Use /science TICKER for ignition score | Market opens 9:30AM ET';
  await tg(msg);
}

// ── AUTOPSY ENGINE ─────────────────────────────────────────────────────────
async function runAutopsy() {
  await tg('<b>AUTOPSY ENGINE RUNNING</b>\nDissecting last 30 days of top movers...\n~90 seconds. Stand by.');
  var gainers=await getTopGainers(), candidates=gainers.map(function(g){return g.ticker;}).slice(0,8);
  Object.keys(watchlist).forEach(function(t){if(candidates.indexOf(t)===-1)candidates.push(t);});
  candidates=candidates.slice(0,10);
  var autopsyResults=[];
  for (var i=0;i<candidates.length;i++){
    var sym=candidates[i];
    try {
      var aggs=await polyAggs(sym,35); if(!aggs||aggs.length<5){await sleep(200);continue;}
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

// ══════════════════════════════════════════════════════════════════════
// ── COMMAND HANDLERS ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

async function cmdStart(chatId) {
  await tg(
    '<b>MAVERICK INTEL BOT v5.0</b>\n\n' +
    '<b>🌟 SUPERNOVA PROTOCOL (NEW)</b>\n' +
    '/supernova TICKER — Full 9-ingredient score, archetype, lifecycle, false signals, kill zones\n\n' +
    '<b>STOCK ANALYSIS</b>\n' +
    '/check TICKER — Full AI + live data analysis\n' +
    '/scan — Top setups now\n/squeeze — Squeeze candidates\n' +
    '/gappers — Today\'s top gappers\n/news — Latest catalysts\n\n' +
    '<b>SCIENCE MODULE</b>\n' +
    '/science TICKER — Maverick Ignition Score\n' +
    '/sdi TICKER — Short Danger Index\n' +
    '/autopsy — 30-day top mover analysis\n\n' +
    '<b>PROTOCOLS</b>\n' +
    '/ross /humble /maverick — Activate protocol\n' +
    '/protocol off — Deactivate\n\n' +
    '<b>TRADE TRACKING</b>\n' +
    '/position TICKER ENTRY STOP TP1 TP2 SHARES\n' +
    '/positions /close TICKER EXITPRICE\n' +
    '/watch TICKER /alert TICKER PRICE above|below\n\n' +
    '<b>LEARNING</b>\n' +
    '/myedge — Your win rate analysis\n/history — Last 10 trades\n\n' +
    '<b>NATURAL LANGUAGE</b>\n' +
    'Type anything: "What\'s NIXX doing?" "scan" "gainers" "supernova MDAI"',
    chatId
  );
}

async function cmdCheck(sym, chatId) {
  await tg('Pulling live data for $' + sym + '...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('No data for $' + sym + '. Verify ticker symbol.', chatId);
  var sr=scoreSetup(d);
  var news=await polyNewsRaw(sym,5);
  var catRank=5,catName='No Catalyst',latestHead='';
  if(news.length){latestHead=news[0].title||'';var cat=identifyCatalyst(latestHead);catRank=cat.rank;catName=cat.name;}
  var mis=calcMIS(d,catRank), sdi=calcSDI(d,catRank);
  var protoMsg='';
  if(activeProtocol&&PROTOCOLS[activeProtocol]){
    var passes=PROTOCOLS[activeProtocol].filter(d), lvl=applyProtocol(d,activeProtocol);
    protoMsg='\n<b>'+PROTOCOLS[activeProtocol].name+':</b> '+(passes?'PASSES':'FAILS FILTER')+'\nEntry:$'+lvl.entry+' Stop:$'+lvl.stop+' TP1:$'+lvl.tp1+' TP2:$'+lvl.tp2+'\nShares:'+lvl.shares+' R:R '+lvl.rr+':1\n';
  }
  var changeStr=(d.changePct>=0?'+':'')+rnd(d.changePct,2)+'%';
  var analysis=await ai(
    'You are MAVERICK LION BRAIN — elite micro-cap trading analyst. Apply Maverick Whale Doctrine: Phase 1-2 accumulation entry, exit before Phase 4 distribution. Small account trader — tight risk per trade is essential. '+(activeProtocol==='ross'?'Apply Ross Cameron Gap and Go rules. ':''+(activeProtocol==='humble'?'Apply Humble Trader: 3 green candles, 3:1 R:R. ':''))+'Verdict: BUY / WATCH / PASS. Entry zone, hard stop, TP1, TP2, R:R. Direct. No fluff. Max 200 words.',
    '$'+sym+' LIVE DATA (source: '+d.source+'):\nPrice:$'+d.price+' ('+changeStr+') Gap:'+(d.gapPct||0)+'%\nRVOL:'+d.relVol+'x AvgVol:'+d.avgVol+' Float:'+d.floatM+'M Short:'+d.shortPct+'%\nDTC:'+d.daysToCover+'d ATR:$'+d.atr+' Score:'+sr.score+'/100\nMIS:'+mis.pct+'/100 ['+mis.tier+'] SDI:'+sdi.score+'/100 ['+sdi.danger+']\nCatalyst:'+catName+' (Rank '+catRank+')\n'+(latestHead?'Latest:"'+latestHead.slice(0,100)+'"\n':'')+'Flags:'+(sr.flags.join(', ')||'none'),
    400, chatId
  );
  var conviction=sr.score>=85?'HIGH CONVICTION':sr.score>=70?'ELEVATED':sr.score>=55?'MODERATE':'LOW';
  await tg(
    '<b>$'+sym+'</b> ['+conviction+'] Source:'+( d.source||'Multi')+'\n\n' +
    '$'+d.price+' ('+changeStr+')'+(d.gapPct?'  Gap:+'+rnd(d.gapPct,1)+'%':'')+'\n' +
    'RVOL:<b>'+d.relVol+'x</b> Float:<b>'+d.floatM+'M</b> Short:'+rnd(d.shortPct,1)+'%\n' +
    'DTC:'+d.daysToCover+'d Score:'+sr.score+'/100\n' +
    'MIS:<b>'+mis.pct+'</b> ['+mis.tier+'] SDI:<b>'+sdi.score+'</b> ['+sdi.danger+']\n' +
    (sr.flags.length?sr.flags.join(' | ')+'\n':'') +
    (catName!=='No Catalyst'?'Catalyst:'+catName+'\n':'') +
    protoMsg+'\n' +
    (analysis||'AI offline — computed levels only.') +
    '\n\n<b>Quick Levels:</b>\nStop: $'+rnd(d.price-d.atr*1.5,4)+'\nTP1:  $'+rnd(d.price+d.atr*2,4)+'\nTP2:  $'+rnd(d.price+d.atr*4,4)+
    getPersonalInsight(),
    chatId
  );
}

async function cmdScience(sym, chatId) {
  await tg('Running Maverick Ignition Score for $'+sym+'...', chatId);
  var d=await getStock(sym); if(!d) return tg('Cannot pull data for $'+sym, chatId);
  var news=await polyNewsRaw(sym,5);
  var catRank=5,catName='No Catalyst',latestHead='';
  if(news.length){latestHead=news[0].title||'';var cat=identifyCatalyst(latestHead);catRank=cat.rank;catName=cat.name;}
  var mis=calcMIS(d,catRank), sdi=calcSDI(d,catRank);
  var msg='<b>$'+sym+' — MAVERICK IGNITION SCORE</b>\n\nMIS: <b>'+mis.pct+'/100</b> ['+mis.tier+']\nSDI: <b>'+sdi.score+'/100</b> ['+sdi.danger+']\nExpected Move: '+mis.expectedMove+'\n\nCatalyst: '+catName+' (Rank '+catRank+'/5)\n';
  if(latestHead) msg+='"'+latestHead.slice(0,100)+'"\n';
  msg+='\n<b>MIS Breakdown:</b>\n'; mis.components.forEach(function(c){msg+='• '+c+'\n';});
  msg+='\n<b>Short Danger:</b>\n'; sdi.reasons.slice(0,5).forEach(function(r){msg+='• '+r+'\n';});
  msg+='\n<b>Levels:</b>\n$'+d.price+' ('+(d.changePct>=0?'+':'')+rnd(d.changePct,2)+'%)\nStop: $'+rnd(d.price-d.atr*1.5,4)+'\nTP1:  $'+rnd(d.price+d.atr*2,4)+'\nTP2:  $'+rnd(d.price+d.atr*4,4)+'\nFloat:'+d.floatM+'M RVOL:'+d.relVol+'x DTC:'+d.daysToCover+'d\n';
  if(mis.pct>=80) msg+='\nMIS > 80 = HIGH PRIORITY. Track it: /watch '+sym;
  else if(mis.pct>=65) msg+='\nMIS 65-79 = Watch for RVOL spike or catalyst confirmation.';
  else msg+='\nMIS < 65 = Missing key ingredients. Skip or monitor.';
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
    var d=r.value, sr=scoreSetup(d);
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
  if(!keys.length) return tg('No open positions.\n\n/position TICKER ENTRY STOP TP1', chatId);
  var msg='<b>OPEN POSITIONS</b>\n\n';
  for(var i=0;i<keys.length;i++){
    var sym=keys[i],pos=positions[sym],d=await getStock(sym).catch(function(){return null;});
    if(!d){msg+='<b>$'+sym+'</b> — data unavailable\n\n';continue;}
    var pl=rnd((d.price-pos.entry)/pos.entry*100,2),plD=rnd((d.price-pos.entry)*pos.shares,2);
    var stopDist=rnd((d.price-pos.stop)/d.price*100,1),tp1D=pos.tp1?rnd((pos.tp1-d.price)/d.price*100,1):null;
    msg+=(pl>=0?'UP':'DOWN')+' <b>$'+sym+'</b>\nEntry $'+pos.entry+' → Now $'+d.price+' ['+( d.source||'?')+']\n';
    msg+='P&L: '+(pl>=0?'+':'')+pl+'% ($'+(plD>=0?'+':'')+plD+')\n';
    msg+='Stop: $'+pos.stop+' ('+stopDist+'% away)'+(stopDist<3?' ⚠️ CLOSE':'')+'\n';
    msg+='TP1: '+(pos.tp1?'$'+pos.tp1+' ('+tp1D+'% away)':'not set')+'\n\n';
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

async function cmdWatch(sym, chatId) { watchlist[sym.toUpperCase()]={added:Date.now()}; await tg('$'+sym.toUpperCase()+' added. Appears in /scan, /squeeze, and news alerts.', chatId); }

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

  // General conversation
  var personalInsight=getPersonalInsight();
  var protoCtx=activeProtocol?'Active protocol: '+PROTOCOLS[activeProtocol].name+'. ':'';
  var reply=await ai(
    'You are Maverick Bot v4.1 — elite trading assistant and brilliant general AI. For trading: Maverick Whale Doctrine, Phase 1-2 entry, tight float, whale volume, hard stops. Small account trader — tight risk per trade. '+protoCtx+'Logged '+(memory.trades?memory.trades.length:0)+' trades.'+(personalInsight?' Edge:'+personalInsight+'.':'')+' For non-trading: direct knowledgeable friend. No disclaimers. Max 280 words.',
    text, 500, chatId
  );
  if(reply) await tg(reply, chatId);
  else await tg('AI brain offline. Try /check TICKER for analysis.', chatId);
}

// ── BACKGROUND MONITORS ────────────────────────────────────────────────────
async function monitorPositions() {
  for(var sym in positions){
    var pos=positions[sym],d=await getStock(sym).catch(function(){return null;});
    if(!d) continue;
    var price=d.price,pct=(price-pos.entry)/pos.entry*100,stopDist=(price-pos.stop)/pos.stop*100;
    if(stopDist<3&&!pos.alerts.stopWarn){pos.alerts.stopWarn=true;await tg('WARNING — <b>$'+sym+' STOP APPROACHING</b>\nPrice $'+price+' Stop $'+pos.stop+' ('+rnd(stopDist,1)+'% away)\nRVOL:'+d.relVol+'x\nIf thesis broken — exit now. Small loss beats big loss.');}
    else if(stopDist>=6){pos.alerts.stopWarn=false;}
    if(price<=pos.stop) await tg('STOP HIT — <b>$'+sym+'</b>\nPrice $'+price+' Stop $'+pos.stop+'\nP&L: '+rnd(pct,1)+'%  EXIT NOW.');
    if(pos.tp1&&price>=pos.tp1&&!pos.alerts.tp1){pos.alerts.tp1=true;await tg('TP1 HIT — <b>$'+sym+' $'+pos.tp1+'</b>\nPrice:$'+price+' (+'+rnd(pct,1)+'%)\nSell 50%. Move stop to breakeven. Let runner work.\nTP2: '+(pos.tp2?'$'+pos.tp2:'not set'));}
    if(pos.tp2&&price>=pos.tp2&&!pos.alerts.tp2){pos.alerts.tp2=true;await tg('TP2 HIT — <b>$'+sym+' $'+pos.tp2+'</b>\nPrice:$'+price+' (+'+rnd(pct,1)+'%)\nSell 30% more. Trail remaining 20% aggressively.');}
    if(pct>25&&!pos.alerts.tp1&&!pos.alerts.overextended){pos.alerts.overextended=true;await tg('OVEREXTENDED — <b>$'+sym+'</b>\n+'+rnd(pct,1)+'% from entry $'+pos.entry+'\nRVOL:'+d.relVol+'x\n'+(d.relVol<1.5?'Volume fading — distribution risk. Scale out.':'Volume holding. Partial exit + trail stop.'));}
  }
}

async function checkPriceAlerts() {
  for(var i=0;i<priceAlerts.length;i++){
    var alert=priceAlerts[i]; if(alert.fired) continue;
    var d=await getStock(alert.ticker).catch(function(){return null;}); if(!d) continue;
    var triggered=alert.direction==='above'?d.price>=alert.price:d.price<=alert.price;
    if(triggered){alert.fired=true;await tg('PRICE ALERT — <b>$'+alert.ticker+'</b>\n$'+d.price+' is '+alert.direction+' $'+alert.price+'\n'+(d.changePct>=0?'+':'')+rnd(d.changePct,2)+'% RVOL:'+d.relVol+'x\n/science '+alert.ticker+' | /check '+alert.ticker,alert.chatId||CHAT_ID);}
  }
}

// ── TELEGRAM POLL LOOP ─────────────────────────────────────────────────────
async function poll() {
  try {
    var controller=new AbortController(), timer=setTimeout(function(){controller.abort();},32000);
    var r;
    try { r=await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/getUpdates?offset='+(lastUpdateId+1)+'&timeout=25',{signal:controller.signal}); }
    finally { clearTimeout(timer); }
    var d=await r.json();
    if(!d.ok||!d.result||!d.result.length){if(!d.ok)console.error('[POLL]',d.description);return;}
    for(var i=0;i<d.result.length;i++){
      var update=d.result[i]; lastUpdateId=update.update_id;
      var msg=update.message||update.channel_post; if(!msg||!msg.text) continue;
      var chatId=String(msg.chat.id), text=msg.text.trim(), parts=text.split(/\s+/), cmd=parts[0].toLowerCase().split('@')[0];
      console.log('[MSG] chatId='+chatId+' text='+text.slice(0,60));
      try {
        if      (cmd==='/start'||cmd==='/help')  await cmdStart(chatId);
        else if (cmd==='/check'&&parts[1])        await cmdCheck(parts[1].toUpperCase(),chatId);
        else if (cmd==='/check')                  await tg('Usage: /check TICKER  e.g. /check AAPL',chatId);
        else if (cmd==='/scan')                   await cmdScan(chatId);
        else if (cmd==='/squeeze')                await cmdSqueeze(chatId);
        else if (cmd==='/gappers')                await cmdGappers(chatId);
        else if (cmd==='/news')                   await cmdNews(chatId);
        else if (cmd==='/science'&&parts[1])      await cmdScience(parts[1].toUpperCase(),chatId);
        else if (cmd==='/science')                await tg('Usage: /science TICKER  e.g. /science AAPL',chatId);
        else if (cmd==='/sdi'&&parts[1])          await cmdSDI(parts[1].toUpperCase(),chatId);
        else if (cmd==='/sdi')                    await tg('Usage: /sdi TICKER  e.g. /sdi AAPL',chatId);
        else if (cmd==='/autopsy')                await cmdAutopsy(chatId);
        else if (cmd==='/ross')                   await cmdActivateProtocol('ross',chatId);
        else if (cmd==='/humble')                 await cmdActivateProtocol('humble',chatId);
        else if (cmd==='/maverick')               await cmdActivateProtocol('maverick',chatId);
        else if (cmd==='/protocol')               await cmdProtocol(parts,chatId);
        else if (cmd==='/position')               await cmdPosition(parts,chatId);
        else if (cmd==='/positions')              await cmdPositions(chatId);
        else if (cmd==='/close'&&parts[1])        await cmdClose(parts,chatId);
        else if (cmd==='/watch'&&parts[1])        await cmdWatch(parts[1],chatId);
        else if (cmd==='/alert')                  await cmdAlert(parts,chatId);
        else if (cmd==='/myedge')                 await cmdMyEdge(chatId);
        else if (cmd==='/history')                await cmdHistory(chatId);
        else if (cmd==='/supernova'&&parts[1])    await cmdSupernova(parts[1].toUpperCase(),chatId);
        else if (cmd==='/supernova')              await tg('Usage: /supernova TICKER  e.g. /supernova MDAI',chatId);
        else if (text.charAt(0)!=='/') await cmdAI(text,chatId);
        else await tg('Unknown command. Type /help for all commands.',chatId);
      } catch(e){console.error('[CMD]',cmd,e.message);await tg('Error on '+cmd+': '+e.message,chatId);}
    }
  } catch(e){if(e.name!=='AbortError')console.error('[POLL]',e.message);}
  finally { setTimeout(poll, 500); }
}

// ── STARTUP ────────────────────────────────────────────────────────────────
async function start() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║    MAVERICK INTEL BOT v5.0           ║');
  console.log('║    SUPERNOVA PROTOCOL ACTIVE         ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log('  Telegram:   '+(TG_TOKEN?'INTEL_BOT_TOKEN connected':'MISSING — set INTEL_BOT_TOKEN in Render Environment'));
  console.log('  Chat ID:    '+(CHAT_ID?'connected ('+CHAT_ID+')':'MISSING — set INTEL_BOT_CHAT (get from @userinfobot on Telegram)'));
  console.log('  Data:       Yahoo Finance (primary) + Finnhub + Polygon aggs');
  console.log('  Polygon:    '+(POLYGON?'connected — news + gainers + aggs (free tier)':'not set'));
  console.log('  Finnhub:    '+(FINNHUB?'connected':'not set'));
  console.log('  Groq AI:    '+(GROQ_KEY?'connected':'not set'));
  console.log('  Cerebras:   '+(CBRS_KEY?'connected':'not set'));
  console.log('  JSONBin:    '+(JSONBIN_ID?'configured':'not set — trades not persisted'));
  console.log('');
  if(!TG_TOKEN){console.error('[BOT] FATAL: No INTEL_BOT_TOKEN. Cannot start.');return;}
  if(!CHAT_ID) console.error('[BOT] WARNING: No INTEL_BOT_CHAT. Proactive alerts will NOT send. Fix this first.\n       Go to Telegram → message @userinfobot → copy the number → add as INTEL_BOT_CHAT in Render Environment.');
  await loadMemory();
  await tg(
    '<b>MAVERICK INTEL BOT v5.0 — ONLINE</b>\n\n' +
    'Data:   Yahoo Finance (live) ✓\n' +
    (POLYGON?'Polygon: news + gainers + history ✓\n':'') +
    (FINNHUB?'Finnhub: fundamentals ✓\n':'') +
    'Brain:  '+(GROQ_KEY?'Groq+Cerebras ✓':CBRS_KEY?'Cerebras only':'NO AI KEYS — add GROQ_KEY')+'\n' +
    'Memory: '+(JSONBIN_ID?(memory.trades?memory.trades.length:0)+' trades loaded ✓':'not configured')+'\n\n' +
    '<b>🌟 SUPERNOVA PROTOCOL NOW LIVE:</b>\n' +
    '• /supernova TICKER — 9 ingredients scored live\n' +
    '• Rule of Five engine — is this a real supernova?\n' +
    '• Archetype classification — which type of move\n' +
    '• False signal detection — 7 known traps flagged\n' +
    '• Lifecycle phase — where are we in the 5 phases\n' +
    '• Kill zone exits — when to get out\n' +
    '• Poll conflict fixed — single instance guaranteed\n' +
    '• "gainers" and "gappers" both route correctly\n\n' +
    'Type /help for all commands.'
  );
  setInterval(monitorPositions,  60000);
  setInterval(checkPriceAlerts,  30000);
  setInterval(scanNewsIntel,    120000);
  setInterval(morningBriefing,  300000);
  setInterval(pruneHeadlines,  3600000);

  // ── WEBHOOK SETUP (Better for Render) ─────────────────────────────────────
async function handleUpdate(update) {
  try {
    var msg = update.message || update.channel_post;
    if (!msg || !msg.text) return;

    var chatId = String(msg.chat.id);
    var text = msg.text.trim();
    var parts = text.split(/\s+/);
    var cmd = parts[0].toLowerCase().split('@')[0];

    console.log('[MSG] chatId=' + chatId + ' text=' + text.slice(0, 60));

    if      (cmd === '/start' || cmd === '/help')  await cmdStart(chatId);
    else if (cmd === '/check' && parts[1])        await cmdCheck(parts[1].toUpperCase(), chatId);
    else if (cmd === '/check')                    await tg('Usage: /check TICKER', chatId);
    else if (cmd === '/scan')                     await cmdScan(chatId);
    else if (cmd === '/squeeze')                  await cmdSqueeze(chatId);
    else if (cmd === '/gappers')                  await cmdGappers(chatId);
    else if (cmd === '/news')                     await cmdNews(chatId);
    else if (cmd === '/science' && parts[1])      await cmdScience(parts[1].toUpperCase(), chatId);
    else if (cmd === '/science')                  await tg('Usage: /science TICKER', chatId);
    else if (cmd === '/sdi' && parts[1])          await cmdSDI(parts[1].toUpperCase(), chatId);
    else if (cmd === '/sdi')                      await tg('Usage: /sdi TICKER', chatId);
    else if (cmd === '/autopsy')                  await cmdAutopsy(chatId);
    else if (cmd === '/ross')                     await cmdActivateProtocol('ross', chatId);
    else if (cmd === '/humble')                   await cmdActivateProtocol('humble', chatId);
    else if (cmd === '/maverick')                 await cmdActivateProtocol('maverick', chatId);
    else if (cmd === '/protocol')                 await cmdProtocol(parts, chatId);
    else if (cmd === '/position')                 await cmdPosition(parts, chatId);
    else if (cmd === '/positions')                await cmdPositions(chatId);
    else if (cmd === '/close' && parts[1])        await cmdClose(parts, chatId);
    else if (cmd === '/watch' && parts[1])        await cmdWatch(parts[1], chatId);
    else if (cmd === '/alert')                    await cmdAlert(parts, chatId);
    else if (cmd === '/myedge')                   await cmdMyEdge(chatId);
    else if (cmd === '/history')                  await cmdHistory(chatId);
    else if (cmd === '/supernova' && parts[1])    await cmdSupernova(parts[1].toUpperCase(), chatId);
    else if (cmd === '/supernova')                await tg('Usage: /supernova TICKER', chatId);
    else if (text.charAt(0) !== '/')              await cmdAI(text, chatId);
    else await tg('Unknown command. Type /help for all commands.', chatId);

  } catch (e) {
    console.error('[WEBHOOK]', e.message);
  }
}

// ── STARTUP ────────────────────────────────────────────────────────────────
async function start() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║    MAVERICK INTEL BOT v5.0           ║');
  console.log('║    SUPERNOVA PROTOCOL ACTIVE         ║');
  console.log('╚══════════════════════════════════════╝\n');

  // ... keep all your existing console.log lines for connections ...

  if (!TG_TOKEN) { console.error('[BOT] FATAL: No INTEL_BOT_TOKEN'); return; }

  await loadMemory();

  // === WEBHOOK SETUP ===
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/deleteWebhook?drop_pending_updates=true');
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'maverick-terminal.onrender.com'}/webhook`,
        drop_pending_updates: true
      })
    });
    console.log('[WEBHOOK] ✅ Successfully set on Render');
  } catch (e) {
    console.error('[WEBHOOK] Setup failed:', e.message);
  }

  await tg('<b>✅ MAVERICK INTEL BOT v5.0 — ONLINE (Webhook Mode)</b>', CHAT_ID);

  setInterval(monitorPositions,  60000);
  setInterval(checkPriceAlerts,  30000);
  setInterval(scanNewsIntel,    120000);
  setInterval(morningBriefing,  300000);
  setInterval(pruneHeadlines,   3600000);

  console.log('[BOT] v5.0 running in Webhook mode. No more polling conflicts.');
}

// ── HTTP SERVER WITH WEBHOOK ───────────────────────────────────────────────
var PORT = process.env.PORT || 10000;
var server = http.createServer(async function(req, res) {
  if (req.url === '/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        await handleUpdate(update);
      } catch (e) {}
      res.writeHead(200);
      res.end();
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MAVERICK INTEL BOT v5.0 — ONLINE\n');
  }
});

server.listen(PORT, function() {
  console.log('[SERVER] HTTP keepalive listening on port ' + PORT);
  start();
});
