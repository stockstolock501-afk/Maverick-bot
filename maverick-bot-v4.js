/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         MAVERICK INTEL BOT v4.0 — COMPLETE REWRITE      ║
 * ║                                                          ║
 * ║  BUGS FIXED:                                             ║
 * ║  • Stale/2022 data → Polygon SNAPSHOT endpoint (live)   ║
 * ║  • No news alerts → Polygon News as primary source      ║
 * ║  • Dual Telegram tokens → INTEL_BOT_TOKEN only          ║
 * ║  • JSONBin errors → auto-create + better error logs     ║
 * ║  • Morning briefing timezone → Intl API (real CDT/CST)  ║
 * ║                                                          ║
 * ║  NEW SCIENCE MODULE:                                     ║
 * ║  • /autopsy  — 30-day top gainer pattern analysis       ║
 * ║  • /science TICKER — Maverick Ignition Score (MIS)      ║
 * ║  • /sdi TICKER — Short Danger Index                     ║
 * ║  • Morning briefing pre-screens with MIS                 ║
 * ╚══════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
var fetch = require('node-fetch');

// ── CONFIG ─────────────────────────────────────────────────────────────────
// Single bot token only. INTEL_BOT_TOKEN is the only token used.
var TG_TOKEN    = process.env.INTEL_BOT_TOKEN || '';
var CHAT_ID     = process.env.INTEL_BOT_CHAT  || '';
var POLYGON     = process.env.POLYGON_KEY      || '';
var FINNHUB     = process.env.FINNHUB_KEY      || '';
var GROQ_KEY    = process.env.GROQ_KEY         || '';
var CBRS_KEY    = process.env.CEREBRAS_KEY     || '';
var JSONBIN_ID  = process.env.JSONBIN_ID       || '';
var JSONBIN_KEY = process.env.JSONBIN_KEY      || '';

var ACCOUNT_SIZE    = 350;
var MAX_RISK_PCT    = 0.02;
var MAX_RISK_DOLLAR = ACCOUNT_SIZE * MAX_RISK_PCT; // $7

// ── STATE ──────────────────────────────────────────────────────────────────
var positions        = {};
var watchlist        = {};
var priceAlerts      = [];
var chatHistory      = {};
var lastUpdateId     = 0;
var lastNewsTs       = Math.floor(Date.now() / 1000) - 300; // 5 min ago
var sentHeadlines    = new Set();
var activeProtocol   = null;
var lastBriefingDate = '';

// ── MEMORY ─────────────────────────────────────────────────────────────────
var memory = {
  trades:      [],
  preferences: {},
  winRates:    {},
  science:     null, // autopsy cache
  lastUpdated: 0
};

// ── BASE UNIVERSE ──────────────────────────────────────────────────────────
var BASE_SCAN = [
  'MARA','RIOT','SOFI','HOOD','SNDL','FFIE','MULN','ATER','BBIG','PROG',
  'GFAI','GMBL','BFRI','NKLA','GPUS','AIXI','AAOI','VERB','CNEY','XTIA'
];

// ── HELPERS ────────────────────────────────────────────────────────────────
var rnd = function(n, d) {
  d = (d === undefined ? 2 : d);
  return +Number(n).toFixed(d);
};

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Accurate Central Time using JS Intl API (handles CST/CDT automatically)
function nowHourCT() {
  try {
    var d   = new Date();
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric', hour12: false
    });
    return parseInt(fmt.format(d), 10);
  } catch (e) {
    // Fallback: CDT = UTC-5
    return (new Date().getUTCHours() - 5 + 24) % 24;
  }
}

// Get approximate trading date N trading days back
function nTradingDaysAgo(n) {
  var d = new Date();
  var count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return d.toISOString().slice(0, 10);
}

// Prune sentHeadlines to prevent memory bloat
function pruneHeadlines() {
  if (sentHeadlines.size > 500) {
    var arr = Array.from(sentHeadlines).slice(-200);
    sentHeadlines.clear();
    arr.forEach(function(h) { sentHeadlines.add(h); });
  }
}

// ── JSONBIN MEMORY ─────────────────────────────────────────────────────────
async function loadMemory() {
  if (!JSONBIN_ID || !JSONBIN_KEY) {
    console.log('[MEMORY] Not configured — running in-memory only');
    console.log('[MEMORY] Set JSONBIN_ID and JSONBIN_KEY in .env to persist trades');
    return;
  }
  try {
    var r = await fetch(
      'https://api.jsonbin.io/v3/b/' + JSONBIN_ID + '/latest',
      { headers: { 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Meta': 'false' } }
    );
    var text = await r.text();
    if (!text) { console.error('[MEMORY] Empty response — check JSONBIN_KEY'); return; }
    var d = JSON.parse(text);
    // Handle both {record: ...} and raw data formats
    var rec = (d && d.record) ? d.record : d;
    if (rec && rec.trades) {
      memory = Object.assign(memory, rec);
      console.log('[MEMORY] Loaded ' + (memory.trades ? memory.trades.length : 0) + ' trades');
    } else {
      console.log('[MEMORY] Bin exists but no trade data yet (fresh start)');
    }
  } catch (e) {
    console.error('[MEMORY] Load failed:', e.message);
    if (e.message.indexOf('404') !== -1 || e.message.indexOf('not found') !== -1) {
      console.error('[MEMORY] Bin ID not found — check JSONBIN_ID in .env');
    }
  }
}

async function saveMemory() {
  if (!JSONBIN_ID || !JSONBIN_KEY) return;
  try {
    memory.lastUpdated = Date.now();
    var r = await fetch(
      'https://api.jsonbin.io/v3/b/' + JSONBIN_ID,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
        body:    JSON.stringify(memory)
      }
    );
    if (!r.ok) {
      var err = await r.text();
      console.error('[MEMORY] Save error ' + r.status + ':', err.slice(0, 100));
    }
  } catch (e) { console.error('[MEMORY] Save failed:', e.message); }
}

function learnFromTrade(tradeObj) {
  if (!memory.trades) memory.trades = [];
  memory.trades.push(tradeObj);
  if (memory.trades.length > 200) memory.trades = memory.trades.slice(-200);
  rebuildWinRates();
  saveMemory();
}

function rebuildWinRates() {
  var byProtocol = {};
  var byFloat    = { nano: [], tight: [], mid: [] };
  var byRvol     = { low: [], med: [], high: [] };
  (memory.trades || []).forEach(function(t) {
    var win = t.pnlPct > 0;
    var p   = t.protocol || 'maverick';
    if (!byProtocol[p]) byProtocol[p] = { wins: 0, total: 0 };
    byProtocol[p].total++;
    if (win) byProtocol[p].wins++;
    if      (t.float < 5)  byFloat.nano.push(win ? 1 : 0);
    else if (t.float < 15) byFloat.tight.push(win ? 1 : 0);
    else                   byFloat.mid.push(win ? 1 : 0);
    if      (t.rvol >= 5) byRvol.high.push(win ? 1 : 0);
    else if (t.rvol >= 2) byRvol.med.push(win ? 1 : 0);
    else                  byRvol.low.push(win ? 1 : 0);
  });
  memory.winRates = { byProtocol: byProtocol, byFloat: byFloat, byRvol: byRvol };
}

function getPersonalInsight() {
  if (!memory.trades || memory.trades.length < 5) return '';
  rebuildWinRates();
  var wr = memory.winRates;
  var lines = [];
  var floatBest = null, floatBestRate = 0;
  ['nano', 'tight', 'mid'].forEach(function(k) {
    var arr = wr.byFloat[k];
    if (arr.length >= 3) {
      var rate = arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
      if (rate > floatBestRate) { floatBestRate = rate; floatBest = k; }
    }
  });
  if (floatBest) lines.push('Best float: ' + floatBest + ' (' + rnd(floatBestRate * 100, 0) + '% win)');
  var rvolBest = null, rvolBestRate = 0;
  ['high', 'med', 'low'].forEach(function(k) {
    var arr = wr.byRvol[k];
    if (arr.length >= 3) {
      var rate = arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
      if (rate > rvolBestRate) { rvolBestRate = rate; rvolBest = k; }
    }
  });
  if (rvolBest) lines.push('Best RVOL zone: ' + rvolBest + ' (' + rnd(rvolBestRate * 100, 0) + '% win)');
  return lines.length ? '\n\nPERSONAL EDGE: ' + lines.join(' | ') : '';
}

// ── DATA LAYER ─────────────────────────────────────────────────────────────

// FIX #1: Use Polygon SNAPSHOT (real-time) instead of last trade endpoint
// This is the fix for stale/2022 data. The snapshot gives today's full OHLCV.
async function polySnapshot(sym) {
  if (!POLYGON) return null;
  try {
    var r = await fetch(
      'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/' +
      sym + '?apiKey=' + POLYGON
    );
    var d = await r.json();
    if (d && d.ticker) return d.ticker;
    if (d && d.status === 'NOT_AUTHORIZED') {
      console.error('[Polygon] Key not authorized for snapshot — check your plan');
    }
  } catch (e) { console.error('[polySnapshot]', sym, e.message); }
  return null;
}

// Historical daily bars (used for RVOL, autopsy)
async function polyAggs(sym, days) {
  if (!POLYGON) return null;
  days = days || 15;
  try {
    var to   = todayStr();
    var from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    var r    = await fetch(
      'https://api.polygon.io/v2/aggs/ticker/' + sym +
      '/range/1/day/' + from + '/' + to +
      '?adjusted=true&sort=asc&limit=50&apiKey=' + POLYGON
    );
    var d = await r.json();
    if (d && d.results && d.results.length) return d.results;
  } catch (e) { console.error('[polyAggs]', sym, e.message); }
  return null;
}

// Polygon reference (for float data from company info)
async function polyDetails(sym) {
  if (!POLYGON) return null;
  try {
    var r = await fetch(
      'https://api.polygon.io/v3/reference/tickers/' + sym + '?apiKey=' + POLYGON
    );
    var d = await r.json();
    if (d && d.results) return d.results;
  } catch (e) {}
  return null;
}

// FIX #2: Polygon News as PRIMARY news source (replaces dead Benzinga RSS)
// Polygon news is ticker-tagged, timestamped, and included in free tier
async function polyNewsRaw(tickerOrNull, limit) {
  if (!POLYGON) return [];
  limit = limit || 25;
  try {
    var url = 'https://api.polygon.io/v2/reference/news?limit=' + limit +
              '&order=desc&sort=published_utc&apiKey=' + POLYGON;
    if (tickerOrNull) url += '&ticker=' + tickerOrNull;
    var r = await fetch(url);
    var d = await r.json();
    if (d && d.results) return d.results;
  } catch (e) { console.error('[polyNews]', e.message); }
  return [];
}

// Polygon top gainers snapshot
async function getTopGainers() {
  if (!POLYGON) return [];
  try {
    var r = await fetch(
      'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=' + POLYGON
    );
    var d = await r.json();
    if (d && d.tickers) return d.tickers.slice(0, 20);
  } catch (e) { console.error('[gainers]', e.message); }
  return [];
}

// Yahoo Finance BACKUP
async function yahooQuote(sym) {
  try {
    var r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/' + sym +
      '?interval=1d&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaverickBot/4.0)' } }
    );
    var d    = await r.json();
    var res  = d && d.chart && d.chart.result && d.chart.result[0];
    var meta = res && res.meta;
    if (meta && meta.regularMarketPrice && meta.regularMarketPrice > 0) {
      return {
        price:     meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice,
        volume:    meta.regularMarketVolume || 0,
        high:      meta.regularMarketDayHigh || meta.regularMarketPrice,
        low:       meta.regularMarketDayLow  || meta.regularMarketPrice,
        source:    'Yahoo'
      };
    }
  } catch (e) { console.error('[Yahoo]', sym, e.message); }
  return null;
}

// Finnhub TERTIARY quote
async function fhQuote(sym) {
  if (!FINNHUB) return null;
  try {
    var r    = await fetch('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + FINNHUB);
    var text = await r.text();
    if (!text || text.trim() === '') return null;
    var d = JSON.parse(text);
    if (d && d.c && d.c > 0) {
      return { price: d.c, prevClose: d.pc, volume: d.v, high: d.h, low: d.l, source: 'Finnhub' };
    }
  } catch (e) {}
  return null;
}

// Finnhub fundamentals (float, short interest)
async function fhMetrics(sym) {
  if (!FINNHUB) return null;
  try {
    var r    = await fetch(
      'https://finnhub.io/api/v1/stock/metric?symbol=' + sym + '&metric=all&token=' + FINNHUB
    );
    var text = await r.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text);
  } catch (e) { return null; }
}

// Generic Finnhub helper
async function fh(ep) {
  if (!FINNHUB) return null;
  try {
    var sep  = ep.indexOf('?') !== -1 ? '&' : '?';
    var r    = await fetch('https://finnhub.io/api/v1' + ep + sep + 'token=' + FINNHUB);
    var text = await r.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text);
  } catch (e) {
    console.error('[Finnhub]', ep.split('?')[0], e.message);
    return null;
  }
}

// ── UNIFIED STOCK DATA (getStock) ──────────────────────────────────────────
// Three-tier fallback: Polygon Snapshot → Yahoo → Finnhub
async function getStock(sym) {
  try {
    var price = 0, prevClose = 0, volume = 0, high = 0, low = 0;
    var source = 'unknown';

    // TIER 1: Polygon Snapshot (real-time, always try first)
    if (POLYGON) {
      var snap = await polySnapshot(sym);
      if (snap) {
        var day  = snap.day    || {};
        var prev = snap.prevDay || {};
        // Use lastTrade.p for most current tick, fall back to day close
        price     = (snap.lastTrade && snap.lastTrade.p > 0) ? snap.lastTrade.p : (day.c || 0);
        prevClose = prev.c > 0 ? prev.c : (day.o || price);
        volume    = day.v  || 0;
        high      = day.h  || price;
        low       = day.l  || price;
        source    = 'Polygon';
        // Safety: if we got a snapshot but price is 0, use vwap
        if (price <= 0) price = day.vw || 0;
      }
    }

    // TIER 2: Yahoo Finance
    if (!price || price <= 0) {
      var yq = await yahooQuote(sym);
      if (yq && yq.price > 0) {
        price = yq.price; prevClose = yq.prevClose || price;
        volume = yq.volume || 0; high = yq.high || price; low = yq.low || price;
        source = 'Yahoo';
      }
    }

    // TIER 3: Finnhub
    if (!price || price <= 0) {
      var fq = await fhQuote(sym);
      if (fq && fq.price > 0) {
        price = fq.price; prevClose = fq.prevClose || price;
        volume = fq.volume || 0; high = fq.high || price; low = fq.low || price;
        source = 'Finnhub';
      }
    }

    if (!price || price <= 0) return null;

    // RVOL from historical aggs (15-day lookback)
    var avgVol = 500000;
    var aggs   = await polyAggs(sym, 20);
    if (aggs && aggs.length >= 3) {
      var vols = aggs.slice(-10).map(function(a) { return a.v || 0; });
      avgVol = vols.reduce(function(a, b) { return a + b; }, 0) / vols.length;
    }

    // Float + short interest from Finnhub metrics
    var floatM = 50, shortPct = 0, week52H = price * 2, week52L = price * 0.5;
    var metrics = await fhMetrics(sym);
    if (metrics && metrics.metric) {
      var m    = metrics.metric;
      floatM   = m.sharesFloat                 || floatM;
      shortPct = m.shortInterestPercentOfFloat || shortPct;
      week52H  = m['52WeekHigh']               || week52H;
      week52L  = m['52WeekLow']                || week52L;
    }

    // Better float from Polygon reference data
    var details = await polyDetails(sym);
    if (details && details.share_class_shares_outstanding) {
      floatM = details.share_class_shares_outstanding / 1e6;
    }

    var changePct   = prevClose > 0 ? rnd((price - prevClose) / prevClose * 100, 2) : 0;
    var relVol      = rnd(volume / Math.max(avgVol, 1), 2);
    var atr         = rnd(price * 0.025, 4);
    var daysToCover = (floatM > 0 && avgVol > 0) ? rnd((floatM * 1e6) / avgVol, 2) : 99;

    // Gap from previous day close
    var gapPct = 0;
    if (aggs && aggs.length >= 2) {
      var prevDay = aggs[aggs.length - 2];
      if (prevDay && prevDay.c > 0) {
        gapPct = rnd((price - prevDay.c) / prevDay.c * 100, 2);
      }
    }

    return {
      sym:         sym,
      price:       price,
      changePct:   changePct,
      gapPct:      gapPct,
      high:        high,
      low:         low,
      prevClose:   prevClose,
      volume:      volume,
      avgVol:      rnd(avgVol, 0),
      relVol:      relVol,
      floatM:      floatM,
      shortPct:    shortPct,
      week52High:  week52H,
      week52Low:   week52L,
      atr:         atr,
      daysToCover: daysToCover,
      source:      source
    };
  } catch (e) {
    console.error('[getStock]', sym, e.message);
    return null;
  }
}

// ── SETUP SCORER (original logic preserved) ────────────────────────────────
function scoreSetup(d) {
  var score = 0, flags = [];
  // Float
  if      (d.floatM < 1)   { score += 30; flags.push('NANO FLOAT'); }
  else if (d.floatM < 5)   { score += 22; flags.push('TIGHT FLOAT'); }
  else if (d.floatM < 15)  { score += 14; flags.push('WORKABLE FLOAT'); }
  else if (d.floatM > 100) { score -=  5; }
  // RVOL
  if      (d.relVol >= 10) { score += 25; flags.push('RVOL ' + d.relVol + 'x WHALE'); }
  else if (d.relVol >= 5)  { score += 20; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol >= 3)  { score += 13; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol >= 2)  { score +=  7; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol < 0.8) { score -=  8; }
  // Price move
  if      (d.changePct >= 30) { score += 20; flags.push('+' + rnd(d.changePct, 1) + '% MOVER'); }
  else if (d.changePct >= 15) { score += 15; flags.push('+' + rnd(d.changePct, 1) + '%'); }
  else if (d.changePct >=  7) { score +=  9; flags.push('+' + rnd(d.changePct, 1) + '%'); }
  else if (d.changePct >=  3) { score +=  4; }
  else if (d.changePct <  -5) { score -=  8; }
  // Gap
  if      (d.gapPct >= 20) { score += 12; flags.push('GAP +' + rnd(d.gapPct, 1) + '%'); }
  else if (d.gapPct >= 10) { score +=  8; flags.push('GAP +' + rnd(d.gapPct, 1) + '%'); }
  // Price range (sweet spot for small account)
  if      (d.price < 1)  { score += 10; flags.push('SUB-$1'); }
  else if (d.price < 3)  { score +=  9; }
  else if (d.price < 5)  { score +=  6; }
  else if (d.price < 10) { score +=  3; }
  // Short squeeze
  if      (d.shortPct > 30 && d.relVol > 3) { score += 18; flags.push('SQUEEZE SETUP'); }
  else if (d.shortPct > 20)                  { score +=  9; flags.push('SHORT ' + rnd(d.shortPct, 1) + '%'); }
  // 52W breakout
  if (d.week52High > 0) {
    var pctFrom52H = (d.week52High - d.price) / Math.max(d.week52High, 0.01) * 100;
    if (pctFrom52H < 2 && d.changePct > 0) { score += 10; flags.push('52W BREAKOUT'); }
  }
  return { score: Math.min(100, Math.max(0, score)), flags: flags };
}

// ── CATALYST TAXONOMY ─────────────────────────────────────────────────────
// Ranked 1 (most explosive) to 5 (weakest)
var CATALYST_MAP = {
  // Rank 1 — binary events, massive moves, shorts terrified
  'fda approval':    { rank: 1, name: 'FDA Approval' },
  'fda approved':    { rank: 1, name: 'FDA Approved' },
  'fda clearance':   { rank: 1, name: 'FDA Clearance' },
  'phase 3 results': { rank: 1, name: 'Phase 3 Results' },
  'phase 3 trial':   { rank: 1, name: 'Phase 3 Trial' },
  'breakthrough':    { rank: 1, name: 'Breakthrough Data' },
  'positive data':   { rank: 1, name: 'Positive Clinical Data' },
  // Rank 2 — strong catalysts, high predictability of move
  'merger':               { rank: 2, name: 'Merger' },
  'acquisition':          { rank: 2, name: 'Acquisition' },
  'buyout':               { rank: 2, name: 'Buyout' },
  'short squeeze':        { rank: 2, name: 'Short Squeeze' },
  'government contract':  { rank: 2, name: 'Government Contract' },
  'barda contract':       { rank: 2, name: 'BARDA Contract' },
  'dod contract':         { rank: 2, name: 'DOD Contract' },
  'trading halted':       { rank: 2, name: 'Trading Halt (News)' },
  'uplisting':            { rank: 2, name: 'Uplisting' },
  'reverse merger':       { rank: 2, name: 'Reverse Merger' },
  // Rank 3 — solid catalysts, decent moves
  'earnings beat':        { rank: 3, name: 'Earnings Beat' },
  'beat estimates':       { rank: 3, name: 'Beat Estimates' },
  'record revenue':       { rank: 3, name: 'Record Revenue' },
  'raised guidance':      { rank: 3, name: 'Raised Guidance' },
  'partnership':          { rank: 3, name: 'Partnership' },
  'nasdaq compliance':    { rank: 3, name: 'Nasdaq Compliance' },
  'nasdaq listing':       { rank: 3, name: 'Nasdaq Listing' },
  'clinical data':        { rank: 3, name: 'Clinical Data' },
  'positive results':     { rank: 3, name: 'Positive Results' },
  // Rank 4 — weak catalysts, smaller moves
  'upgraded':             { rank: 4, name: 'Analyst Upgrade' },
  'price target raised':  { rank: 4, name: 'PT Raised' },
  'buyback':              { rank: 4, name: 'Buyback' },
  'reverse split':        { rank: 4, name: 'Reverse Split' }
};

function identifyCatalyst(headline) {
  if (!headline) return { rank: 5, name: 'No Catalyst' };
  var body     = headline.toLowerCase();
  var bestRank = 5;
  var bestName = 'Unknown Catalyst';
  Object.keys(CATALYST_MAP).forEach(function(k) {
    if (body.indexOf(k) !== -1) {
      var item = CATALYST_MAP[k];
      if (item.rank < bestRank) { bestRank = item.rank; bestName = item.name; }
    }
  });
  return { rank: bestRank, name: bestName };
}

// ── MAVERICK IGNITION SCORE (NEW SCIENCE) ─────────────────────────────────
// Leading indicator stack — scores BEFORE the move happens
// Unlike RSI/MACD (lagging), MIS uses pre-existing conditions
function calcMIS(d, catalystRank) {
  var score = 0;
  var components = [];
  catalystRank = catalystRank || 5;

  // Float [0-20 pts] — tight float = explosive moves
  if      (d.floatM < 1)  { score += 20; components.push('Float 20/20 — NANO'); }
  else if (d.floatM < 5)  { score += 16; components.push('Float 16/20 — tight'); }
  else if (d.floatM < 15) { score += 10; components.push('Float 10/20 — workable'); }
  else if (d.floatM < 30) { score +=  4; components.push('Float 4/20 — wide'); }
  else                    { components.push('Float 0/20 — too large'); }

  // RVOL [0-18 pts] — whale volume confirms thesis
  if      (d.relVol >= 10) { score += 18; components.push('RVOL 18/18 — ' + d.relVol + 'x WHALE'); }
  else if (d.relVol >= 5)  { score += 14; components.push('RVOL 14/18 — ' + d.relVol + 'x'); }
  else if (d.relVol >= 3)  { score +=  9; components.push('RVOL 9/18 — ' + d.relVol + 'x'); }
  else if (d.relVol >= 2)  { score +=  5; components.push('RVOL 5/18 — ' + d.relVol + 'x'); }
  else                     { components.push('RVOL 0/18 — weak volume'); }

  // Catalyst rank [0-15 pts] — catalyst type predicts move magnitude
  var catPts = [15, 12, 8, 4, 0][Math.min(catalystRank - 1, 4)];
  score += catPts;
  components.push('Catalyst ' + catPts + '/15 — rank ' + catalystRank + '/5');

  // Short interest [0-12 pts] — fuel for squeeze
  if      (d.shortPct >= 30) { score += 12; components.push('Short 12/12 — ' + rnd(d.shortPct, 1) + '% heavy'); }
  else if (d.shortPct >= 20) { score +=  8; components.push('Short 8/12 — ' + rnd(d.shortPct, 1) + '%'); }
  else if (d.shortPct >= 10) { score +=  4; components.push('Short 4/12 — ' + rnd(d.shortPct, 1) + '%'); }
  else                       { components.push('Short 0/12 — ' + rnd(d.shortPct, 1) + '%'); }

  // Gap [0-8 pts] — pre-market demand signals
  if      (d.gapPct >= 20) { score += 8; components.push('Gap 8/8 — +' + rnd(d.gapPct, 1) + '%'); }
  else if (d.gapPct >= 10) { score += 5; components.push('Gap 5/8 — +' + rnd(d.gapPct, 1) + '%'); }
  else if (d.gapPct >=  5) { score += 2; components.push('Gap 2/8 — +' + rnd(d.gapPct, 1) + '%'); }
  else                     { components.push('Gap 0/8'); }

  // Days to cover [0-7 pts] — trapped shorts = forced buying
  var dtc = d.daysToCover || 99;
  if      (dtc < 0.5) { score += 7; components.push('DTC 7/7 — ' + rnd(dtc, 2) + 'd SHORTS TRAPPED'); }
  else if (dtc < 1.0) { score += 5; components.push('DTC 5/7 — ' + rnd(dtc, 2) + 'd'); }
  else if (dtc < 2.0) { score += 3; components.push('DTC 3/7 — ' + rnd(dtc, 2) + 'd'); }
  else                { components.push('DTC 0/7 — ' + rnd(dtc, 1) + 'd (shorts comfortable)'); }

  // Price range [0-5 pts]
  if      (d.price < 2)  { score += 5; components.push('Price 5/5 — sub-$2'); }
  else if (d.price < 5)  { score += 4; components.push('Price 4/5 — $2-5'); }
  else if (d.price < 10) { score += 2; components.push('Price 2/5 — $5-10'); }
  else                   { components.push('Price 0/5 — over $10'); }

  // 52W breakout bonus [0-5 pts]
  if (d.week52High > 0 && d.price >= d.week52High * 0.98 && d.changePct > 0) {
    score += 5;
    components.push('52W Breakout +5 BONUS');
  }

  // Scale to 100 (max possible raw = 90)
  var pct  = Math.min(100, Math.round(score / 90 * 100));
  var tier = pct >= 80 ? 'IGNITION READY' :
             pct >= 65 ? 'HIGH POTENTIAL' :
             pct >= 50 ? 'WATCH'          : 'SKIP';

  // Expected move range based on MIS tier
  var expectedMove = pct >= 80 ? '50-200%' :
                     pct >= 65 ? '25-75%'  :
                     pct >= 50 ? '15-35%'  : '<15%';

  return { raw: score, pct: pct, tier: tier, components: components, expectedMove: expectedMove };
}

// ── SHORT DANGER INDEX (NEW SCIENCE) ──────────────────────────────────────
// What do shorts fear? Score 0-100. High SDI = shorts likely to panic cover.
function calcSDI(d, catalystRank) {
  var score = 0;
  var reasons = [];
  catalystRank = catalystRank || 5;

  // Days to cover [0-30 pts] — the single most dangerous metric for shorts
  var dtc = d.daysToCover || 99;
  if      (dtc < 0.5) { score += 30; reasons.push('SHORTS TRAPPED — only ' + rnd(dtc, 2) + ' days to cover'); }
  else if (dtc < 1.0) { score += 20; reasons.push('DTC < 1 day — very tight squeeze window'); }
  else if (dtc < 2.0) { score += 10; reasons.push('DTC < 2 days — squeeze possible'); }

  // Short interest [0-25 pts] — more shorts = bigger squeeze fuel
  if      (d.shortPct >= 30) { score += 25; reasons.push('HEAVY SHORT: ' + rnd(d.shortPct, 1) + '% of float'); }
  else if (d.shortPct >= 20) { score += 15; reasons.push('High short: ' + rnd(d.shortPct, 1) + '%'); }
  else if (d.shortPct >= 10) { score +=  8; reasons.push('Moderate short: ' + rnd(d.shortPct, 1) + '%'); }

  // Price range [0-20 pts] — cheap stocks = unlimited % upside for longs
  if      (d.price < 1) { score += 20; reasons.push('SUB-$1 — theoretically unlimited upside %'); }
  else if (d.price < 3) { score += 15; reasons.push('Sub-$3 — high % move possible'); }
  else if (d.price < 5) { score +=  8; reasons.push('Sub-$5 — elevated upside risk for shorts'); }

  // Catalyst type [0-20 pts] — binary events = shorts cannot hedge
  if      (catalystRank === 1) { score += 20; reasons.push('BINARY CATALYST — shorts cannot hedge; infinite loss risk'); }
  else if (catalystRank === 2) { score += 12; reasons.push('Strong catalyst — short risk elevated'); }
  else if (catalystRank === 3) { score +=  5; reasons.push('Moderate catalyst'); }

  // RVOL [0-5 pts] — momentum forcing covers
  if      (d.relVol >= 10) { score += 5; reasons.push('WHALE RVOL ' + d.relVol + 'x — forced covering NOW'); }
  else if (d.relVol >= 5)  { score += 3; reasons.push('High RVOL ' + d.relVol + 'x — momentum building'); }

  score = Math.min(100, score);
  var danger = score >= 75 ? 'EXTREME DANGER' :
               score >= 55 ? 'HIGH DANGER'    :
               score >= 35 ? 'MODERATE'       : 'LOW RISK';

  return { score: score, danger: danger, reasons: reasons };
}

// ── POSITION SIZING ────────────────────────────────────────────────────────
function calcShares(price, stopPrice) {
  var risk     = Math.abs(price - stopPrice);
  if (risk <= 0) return 1;
  var shares   = Math.floor(MAX_RISK_DOLLAR / risk);
  var cost     = shares * price;
  if (cost > ACCOUNT_SIZE * 0.8) shares = Math.floor((ACCOUNT_SIZE * 0.8) / price);
  return Math.max(1, shares);
}

// ── TRADER PROTOCOLS ──────────────────────────────────────────────────────
var PROTOCOLS = {
  ross: {
    name: 'Ross Cameron Protocol',
    desc: 'Gap and Go — first 5min candle break, exit by 11AM',
    filter: function(d) {
      return d.gapPct >= 10 && d.price >= 2 && d.price <= 20 && d.floatM <= 10 && d.relVol >= 3;
    },
    entry:  function(d) { return rnd(d.price * 1.005, 4); },
    stop:   function(d) { return rnd(d.price * 0.97, 4); },
    tp1:    function(d) { return rnd(d.price * 1.10, 4); },
    tp2:    function(d) { return rnd(d.price * 1.20, 4); },
    rules: [
      'Only trade first 90 minutes (9:30-11:00AM)',
      'Gap must be 10%+ from previous close',
      'Float under 10M — tight floats move faster',
      'Enter on break of 5-minute opening range high',
      'Stop = low of first 5-minute candle',
      'Sell all by 11AM — never hold into afternoon',
      'Max 2 trades per day — quality over quantity'
    ]
  },
  humble: {
    name: 'Humble Trader Protocol',
    desc: 'Mid-day continuation — patient entries, 3:1 R:R minimum',
    filter: function(d) {
      return d.changePct >= 10 && d.price >= 1 && d.price <= 30 && d.floatM <= 20 && d.relVol >= 2;
    },
    entry:  function(d) { return rnd(d.price * 1.002, 4); },
    stop:   function(d) { return rnd(d.price * 0.95, 4); },
    tp1:    function(d) { return rnd(d.price * 1.15, 4); },
    tp2:    function(d) { return rnd(d.price * 1.30, 4); },
    rules: [
      'Wait for 3 consecutive green 5-min candles with increasing volume',
      'Float under 20M acceptable',
      'Minimum 3:1 R:R — if it doesn\'t meet it, skip',
      'Trade 9:30AM through 3:30PM',
      'Hold runners — don\'t sell all at TP1',
      'Move stop to breakeven after TP1 hit',
      'Fewer trades than Ross but higher conviction each'
    ]
  },
  maverick: {
    name: 'Maverick Protocol (Adaptive)',
    desc: 'Learns from YOUR trade history — gets smarter every trade',
    filter: function(d) {
      var floatOk = d.floatM <= 15;
      var rvolOk  = d.relVol >= 2;
      var moveOk  = d.changePct >= 5;
      if (memory.trades && memory.trades.length >= 10) {
        rebuildWinRates();
        var wr = memory.winRates;
        if (wr.byFloat && wr.byFloat.nano && wr.byFloat.nano.length >= 3) {
          var nanoRate = wr.byFloat.nano.reduce(function(a, b) { return a + b; }, 0) / wr.byFloat.nano.length;
          if (nanoRate > 0.6) floatOk = d.floatM <= 5;
        }
        if (wr.byRvol && wr.byRvol.high && wr.byRvol.high.length >= 3) {
          var highRate = wr.byRvol.high.reduce(function(a, b) { return a + b; }, 0) / wr.byRvol.high.length;
          if (highRate > 0.6) rvolOk = d.relVol >= 5;
        }
      }
      return floatOk && rvolOk && moveOk;
    },
    entry:  function(d) { return rnd(d.price, 4); },
    stop:   function(d) { return rnd(d.price - d.atr * 1.5, 4); },
    tp1:    function(d) { return rnd(d.price + d.atr * 2, 4); },
    tp2:    function(d) { return rnd(d.price + d.atr * 4, 4); },
    rules: [
      'Starts as a blend of Ross and Humble Trader',
      'Adapts to YOUR win rate data after 10+ logged trades',
      'Learns which float ranges you win in',
      'Learns which RVOL levels produce your best results',
      'Gets smarter every trade you log with /close',
      'Run /myedge to see what the data says about you'
    ]
  }
};

function applyProtocol(d, proto) {
  var p       = PROTOCOLS[proto];
  var entry   = p.entry(d);
  var stop    = p.stop(d);
  var tp1     = p.tp1(d);
  var tp2     = p.tp2(d);
  var shares  = calcShares(entry, stop);
  var risk    = rnd((entry - stop) * shares, 2);
  var reward1 = rnd((tp1   - entry) * shares, 2);
  var rr      = rnd((tp1 - entry) / Math.max(entry - stop, 0.001), 2);
  return { entry, stop, tp1, tp2, shares, risk, reward1, rr };
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────
async function tg(text, chatId) {
  chatId = chatId || CHAT_ID;
  if (!TG_TOKEN || !chatId) {
    if (!chatId) console.error('[TG] No CHAT_ID — set INTEL_BOT_CHAT in .env');
    return;
  }
  try {
    var chunks = [];
    while (text.length > 4000) { chunks.push(text.slice(0, 4000)); text = text.slice(4000); }
    chunks.push(text);
    for (var i = 0; i < chunks.length; i++) {
      await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: chatId, text: chunks[i], parse_mode: 'HTML' })
      });
      if (chunks.length > 1) await sleep(300);
    }
  } catch (e) { console.error('[TG]', e.message); }
}

// ── AI BRAIN ──────────────────────────────────────────────────────────────
async function ai(system, user, maxTokens, chatId) {
  maxTokens = maxTokens || 500;
  var history  = (chatId && chatHistory[chatId]) ? chatHistory[chatId].slice(-8) : [];
  var messages = [{ role: 'system', content: system }]
    .concat(history)
    .concat([{ role: 'user', content: user }]);

  // Groq primary (fast, free)
  if (GROQ_KEY) {
    try {
      var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile', max_tokens: maxTokens,
          temperature: 0.3, messages: messages
        })
      });
      var gd   = await r.json();
      var text = gd && gd.choices && gd.choices[0] && gd.choices[0].message && gd.choices[0].message.content;
      if (text) {
        if (chatId) {
          if (!chatHistory[chatId]) chatHistory[chatId] = [];
          chatHistory[chatId].push({ role: 'user', content: user }, { role: 'assistant', content: text });
          if (chatHistory[chatId].length > 24) chatHistory[chatId] = chatHistory[chatId].slice(-24);
        }
        return text;
      }
    } catch (e) { console.error('[Groq]', e.message); }
  }

  // Cerebras backup
  if (CBRS_KEY) {
    try {
      var r2 = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CBRS_KEY },
        body: JSON.stringify({ model: 'llama3.1-8b', max_tokens: maxTokens, temperature: 0.3, messages: messages })
      });
      var d2   = await r2.json();
      var txt2 = d2 && d2.choices && d2.choices[0] && d2.choices[0].message && d2.choices[0].message.content;
      if (txt2) return txt2;
    } catch (e) { console.error('[Cerebras]', e.message); }
  }
  return null;
}

// ── NEWS SCANNING (COMPLETELY REBUILT) ─────────────────────────────────────
// FIX: Primary source is now Polygon News (ticker-tagged, timestamped, reliable)
// FIX: Finnhub used for watchlist-specific company news
// FIX: SEC EDGAR URL corrected
var BULLISH_KW = [
  'fda approval','fda approved','fda clearance','merger','acquisition','buyout',
  'earnings beat','short squeeze','trading halted','halt','government contract',
  'phase 3 results','phase 3 trial','reverse split','buyback','uplisting',
  'nasdaq compliance','barda contract','dod contract','positive data','breakthrough',
  'upgraded','price target raised','record revenue','beat estimates','raised guidance',
  'partnership agreement','clinical data','compelling results','positive results',
  'contract award','milestone payment','data readout'
];
var BEARISH_KW = [
  'going concern','dilution','public offering','atm offering','shelf registration',
  'bankruptcy','delisting','class action','default','missed estimates','downgraded',
  'lowered guidance','fraud','sec investigation','restatement','warning letter'
];

async function scanNewsIntel() {
  pruneHeadlines();

  // ─ SOURCE 1: Polygon News (PRIMARY) ──────────────────────────────────
  try {
    if (POLYGON) {
      var articles = await polyNewsRaw(null, 50);
      for (var i = 0; i < articles.length; i++) {
        var art    = articles[i];
        var pubTs  = art.published_utc ? new Date(art.published_utc).getTime() / 1000 : 0;
        if (pubTs && pubTs <= lastNewsTs) continue;
        var key = art.id || art.title;
        if (sentHeadlines.has(key)) continue;

        var body  = (art.title + ' ' + (art.description || '')).toLowerCase();
        var hits  = BULLISH_KW.filter(function(k) { return body.indexOf(k) !== -1; });
        var negs  = BEARISH_KW.filter(function(k) { return body.indexOf(k) !== -1; });
        var ticks = (art.tickers || []).filter(function(t) { return t && t.length >= 1 && t.length <= 5; });

        if (hits.length >= 1 && negs.length === 0 && ticks.length >= 1) {
          sentHeadlines.add(key);
          var cat    = identifyCatalyst(art.title);
          var ageMin = pubTs ? Math.round((Date.now() / 1000 - pubTs) / 60) : 0;
          var ageStr = ageMin < 60 ? ageMin + 'm ago' : Math.round(ageMin / 60) + 'h ago';
          var pub    = art.publisher && art.publisher.name ? art.publisher.name : 'News';

          var msg = 'CATALYST [Rank ' + cat.rank + '/5] ' + cat.name.toUpperCase() + '\n';
          msg += art.title + '\n';
          msg += pub + ' — ' + ageStr + '\n';
          msg += 'Tickers: ' + ticks.slice(0, 3).join(', ') + '\n';
          msg += 'Signal: ' + hits.slice(0, 2).join(', ') + '\n';
          if (ticks[0]) msg += '\n/science ' + ticks[0] + ' | /check ' + ticks[0];

          await tg(msg);
          await sleep(1500);
        }

        if (negs.length >= 1 && ticks.length >= 1) {
          sentHeadlines.add(key);
          await tg(
            'BEARISH FLAG: ' + art.title + '\n' +
            negs.slice(0, 2).join(', ') + '\n' +
            'Watch $' + ticks[0]
          );
          await sleep(1500);
        }

        if (pubTs && pubTs > lastNewsTs) lastNewsTs = pubTs;
      }
    }
  } catch (e) { console.error('[NEWS-POLY]', e.message); }

  // ─ SOURCE 2: Finnhub watchlist company news ───────────────────────────
  try {
    if (FINNHUB) {
      var wkeys = Object.keys(watchlist).slice(0, 5);
      for (var w = 0; w < wkeys.length; w++) {
        var wsym  = wkeys[w];
        var wFrom = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        var wNews = await fh('/company-news?symbol=' + wsym + '&from=' + wFrom + '&to=' + todayStr());
        if (!Array.isArray(wNews)) { await sleep(400); continue; }
        var fresh = wNews.filter(function(n) { return n.datetime > lastNewsTs - 3600 && n.headline; });
        for (var fn = 0; fn < Math.min(fresh.length, 2); fn++) {
          var n   = fresh[fn];
          var nk  = n.id || n.headline;
          if (sentHeadlines.has(nk)) continue;
          var bd  = (n.headline + ' ' + (n.summary || '')).toLowerCase();
          var h2  = BULLISH_KW.filter(function(k) { return bd.indexOf(k) !== -1; });
          if (h2.length) {
            sentHeadlines.add(nk);
            await tg('WATCHLIST $' + wsym + '\n' + n.headline + '\nSignal: ' + h2[0]);
            await sleep(1500);
          }
        }
        await sleep(400);
      }
    }
  } catch (e) { console.error('[NEWS-FH]', e.message); }

  // ─ SOURCE 3: SEC EDGAR 8-K filings ───────────────────────────────────
  try {
    var edgarFrom = new Date(Date.now() - 7200000).toISOString().slice(0, 10);
    var edgarUrl  =
      'https://efts.sec.gov/LATEST/search-index?q=%228-K%22&forms=8-K' +
      '&dateRange=custom&startdt=' + edgarFrom + '&enddt=' + todayStr();
    var er = await fetch(edgarUrl, {
      headers: { 'User-Agent': 'MaverickIntelBot/4.0 (research@maverick.ai)' }
    });
    if (er.ok) {
      var ed    = await er.json();
      var eHits = ed && ed.hits && ed.hits.hits ? ed.hits.hits : [];
      for (var ek = 0; ek < Math.min(eHits.length, 6); ek++) {
        var src  = eHits[ek] && eHits[ek]._source;
        if (!src) continue;
        var eKey = (src.entity_name || '') + '|' + (src.file_date || '');
        if (sentHeadlines.has(eKey)) continue;
        var tick = ((src.ticker || '') || (src.tickers && src.tickers[0]) || '').toUpperCase().trim();
        if (!tick || tick.length > 5) continue;
        sentHeadlines.add(eKey);
        await tg(
          'SEC 8-K FILING\n' +
          (src.entity_name || 'Unknown') + ' ($' + tick + ')\n' +
          'Form: ' + (src.form_type || '8-K') + ' | Filed: ' + (src.file_date || todayStr()) + '\n' +
          '/science ' + tick + ' | /check ' + tick
        );
        await sleep(2000);
      }
    }
  } catch (e) { console.error('[NEWS-SEC]', e.message); }
}

// ── MORNING BRIEFING ──────────────────────────────────────────────────────
async function morningBriefing() {
  var hour  = nowHourCT();
  var today = todayStr();
  // Fire between 4AM and 11AM CT, once per day
  if (hour < 4 || hour >= 11) return;
  if (lastBriefingDate === today) return;
  lastBriefingDate = today;

  await tg('<b>MAVERICK MORNING BRIEFING v4.0</b>\n' + today + ' | ' + hour + ':00 CT\n\nPulling top setups...');

  var gainers = await getTopGainers();
  var results = [];

  if (gainers.length) {
    for (var i = 0; i < Math.min(gainers.length, 15); i++) {
      var g   = gainers[i];
      var sym = g.ticker;
      var snap = g.day || {};
      var prev = g.prevDay || {};
      var price     = snap.c || (g.lastTrade && g.lastTrade.p) || 0;
      var prevClose = prev.c || price;
      var changePct = prevClose > 0 ? rnd((price - prevClose) / prevClose * 100, 2) : (g.todaysChangePerc || 0);
      if (price < 1 || price > 30 || changePct < 5) continue;

      var d  = await getStock(sym).catch(function() { return null; });
      if (!d) continue;
      var sr  = scoreSetup(d);
      var mis = calcMIS(d, 5); // No catalyst known yet — use baseline

      var passesProto = !activeProtocol || !PROTOCOLS[activeProtocol] || PROTOCOLS[activeProtocol].filter(d);
      if (passesProto && sr.score >= 50) {
        results.push(Object.assign({}, d, { score: sr.score, flags: sr.flags, mis: mis.pct, misTier: mis.tier }));
      }
    }
  } else {
    // Fallback to BASE_SCAN
    var settled = await Promise.allSettled(BASE_SCAN.map(function(s) { return getStock(s); }));
    for (var j = 0; j < settled.length; j++) {
      var rj = settled[j];
      if (rj.status !== 'fulfilled' || !rj.value) continue;
      var sr2 = scoreSetup(rj.value);
      if (sr2.score >= 55) {
        var mis2 = calcMIS(rj.value, 5);
        results.push(Object.assign({}, rj.value, { score: sr2.score, flags: sr2.flags, mis: mis2.pct, misTier: mis2.tier }));
      }
    }
  }

  // Sort by MIS (leading indicator) rather than just setup score
  results.sort(function(a, b) { return (b.mis + b.score) - (a.mis + a.score); });

  if (!results.length) {
    await tg('No high-conviction setups in premarket. Stay patient — skip quiet days.');
    return;
  }

  var proto = activeProtocol ? PROTOCOLS[activeProtocol].name : 'Maverick Standard';
  var msg   =
    '<b>TOP PREMARKET SETUPS</b>\nProtocol: ' + proto +
    '\nAccount: $' + ACCOUNT_SIZE + ' | Max risk/trade: $' + MAX_RISK_DOLLAR + '\n\n';

  for (var n = 0; n < Math.min(5, results.length); n++) {
    var d2  = results[n];
    var lbl = d2.score >= 80 ? 'HOT' : d2.score >= 65 ? 'WARM' : 'WATCH';
    var lvl = activeProtocol ? applyProtocol(d2, activeProtocol) : {
      entry:  d2.price,
      stop:   rnd(d2.price - d2.atr * 1.5, 4),
      tp1:    rnd(d2.price + d2.atr * 2, 4),
      tp2:    rnd(d2.price + d2.atr * 3.5, 4),
      shares: calcShares(d2.price, rnd(d2.price - d2.atr * 1.5, 4)),
      rr:     rnd(2 / 1.5, 2)
    };
    msg += '[' + lbl + '] <b>$' + d2.sym + '</b> Score:' + d2.score + ' MIS:' + d2.mis + '\n';
    msg += '$' + d2.price + '  ' + (d2.changePct >= 0 ? '+' : '') + rnd(d2.changePct, 1) + '%';
    if (d2.gapPct) msg += '  Gap +' + rnd(d2.gapPct, 1) + '%';
    msg += '\nRVOL:' + d2.relVol + 'x Float:' + d2.floatM + 'M Short:' + rnd(d2.shortPct, 1) + '%\n';
    msg += (d2.flags.slice(0, 3).join(' | ') || '') + '\n';
    msg += 'Entry:$' + lvl.entry + ' Stop:$' + lvl.stop + ' TP1:$' + lvl.tp1 + '\n';
    msg += 'MIS Tier: ' + d2.misTier + ' | Source: ' + (d2.source || 'Multi') + '\n\n';
  }
  msg += 'Use /science TICKER for ignition score.\nMarket opens 9:30AM ET.';
  await tg(msg);
}

// ══════════════════════════════════════════════════════════════════════
// ── AUTOPSY ENGINE (NEW SCIENCE) ──────────────────────────────────────
// Dissects the last 30 days of top movers to extract pattern DNA
// ══════════════════════════════════════════════════════════════════════
async function runAutopsy() {
  await tg(
    '<b>AUTOPSY ENGINE RUNNING</b>\n' +
    'Dissecting last 30 days of top movers...\n' +
    'Estimated time: ~90 seconds. Stand by.',
    CHAT_ID
  );

  // Step 1: Pull current top gainers as seed candidates
  var gainers    = await getTopGainers();
  var candidates = gainers.map(function(g) { return g.ticker; }).slice(0, 8);

  // Add any watchlist tickers the user cares about
  Object.keys(watchlist).forEach(function(t) {
    if (candidates.indexOf(t) === -1) candidates.push(t);
  });

  candidates = candidates.slice(0, 10); // Cap at 10 to keep runtime manageable
  var autopsyResults = [];

  for (var i = 0; i < candidates.length; i++) {
    var sym = candidates[i];
    try {
      // Pull 35 calendar days of daily OHLCV
      var aggs = await polyAggs(sym, 35);
      if (!aggs || aggs.length < 5) { await sleep(200); continue; }

      // Find the single biggest daily move in the last 30 days
      var biggestMove = 0, biggestDay = null, biggestIdx = 0;
      for (var j = 1; j < aggs.length; j++) {
        var pc = aggs[j - 1].c;
        var cc = aggs[j].c;
        if (!pc || !cc || pc <= 0) continue;
        var pct = (cc - pc) / pc * 100;
        if (pct > biggestMove) { biggestMove = pct; biggestDay = aggs[j]; biggestIdx = j; }
      }

      if (biggestMove < 15) { await sleep(200); continue; } // Skip weak movers

      // Duration analysis: close vs high of move day
      var closeVsHigh = biggestDay && biggestDay.h > 0
        ? rnd(biggestDay.c / biggestDay.h * 100, 1) : 50;
      var durationType = closeVsHigh >= 80 ? 'SUSTAINED' : closeVsHigh >= 50 ? 'PARTIAL' : 'SPIKE-FADE';
      var estHours     = durationType === 'SUSTAINED' ? 5.5 : durationType === 'PARTIAL' ? 3.0 : 1.5;

      // RVOL on move day vs prior 5 days
      var priorVols = aggs.slice(Math.max(0, biggestIdx - 5), biggestIdx).map(function(a) { return a.v || 0; });
      var priorAvg  = priorVols.length
        ? priorVols.reduce(function(a, b) { return a + b; }, 0) / priorVols.length : 500000;
      var rvolOnDay = priorAvg > 0 ? rnd((biggestDay.v || 0) / priorAvg, 1) : 0;

      // Move day date
      var dayDate = biggestDay
        ? new Date(biggestDay.t).toISOString().slice(0, 10) : todayStr();

      // Pull news from Polygon for this ticker around that date
      var newsItems = await polyNewsRaw(sym, 10);
      var relevantNews = newsItems.filter(function(n) {
        var pub  = (n.published_utc || '').slice(0, 10);
        var nDt  = new Date(pub).getTime();
        var mDt  = new Date(dayDate).getTime();
        var diff = (mDt - nDt) / 86400000;
        return diff >= -1 && diff <= 3; // news 1 day before to 3 days after
      });

      var catalyst = { rank: 5, name: 'Unknown' };
      var catHead  = '';
      if (relevantNews.length) {
        catHead  = relevantNews[0].title || '';
        catalyst = identifyCatalyst(catHead);
      }

      // Current float/short
      var d       = await getStock(sym).catch(function() { return null; });
      var floatM  = d ? d.floatM  : 50;
      var shrtPct = d ? d.shortPct : 0;

      // Sequence tag: what conditions were present
      var seqFlags = [];
      if (floatM < 5)       seqFlags.push('TIGHT FLOAT');
      if (shrtPct > 20)     seqFlags.push('HIGH SHORT');
      if (rvolOnDay >= 5)   seqFlags.push('WHALE RVOL');
      if (catalyst.rank <= 2) seqFlags.push('STRONG CATALYST');
      if (durationType === 'SUSTAINED') seqFlags.push('ALL-DAY RUN');

      autopsyResults.push({
        sym:         sym,
        maxGainPct:  rnd(biggestMove, 1),
        dayDate:     dayDate,
        catalyst:    catalyst,
        catHead:     catHead.slice(0, 120),
        durationType: durationType,
        estHours:    estHours,
        rvolOnDay:   rvolOnDay,
        closeVsHigh: closeVsHigh,
        floatM:      floatM,
        shortPct:    shrtPct,
        seqFlags:    seqFlags
      });

      await sleep(400);
    } catch (e) { console.error('[AUTOPSY]', sym, e.message); }
  }

  // Sort by max gain descending
  autopsyResults.sort(function(a, b) { return b.maxGainPct - a.maxGainPct; });

  // Cache results in memory
  memory.science = { results: autopsyResults, generated: Date.now() };
  await saveMemory();

  return autopsyResults;
}

function buildAutopsyReport(results) {
  if (!results || !results.length) {
    return 'No autopsy data. Run /autopsy to analyze top movers.';
  }
  var top3 = results.slice(0, 3);

  // Aggregate science metrics
  var avgMove  = rnd(top3.reduce(function(a, r) { return a + r.maxGainPct; }, 0) / top3.length, 1);
  var avgHours = rnd(top3.reduce(function(a, r) { return a + r.estHours; }, 0) / top3.length, 1);
  var avgRvol  = rnd(top3.reduce(function(a, r) { return a + r.rvolOnDay; }, 0) / top3.length, 1);

  // Most common catalyst type
  var catCount = {};
  top3.forEach(function(r) {
    var cn = r.catalyst.name;
    catCount[cn] = (catCount[cn] || 0) + 1;
  });
  var topCat = Object.keys(catCount).sort(function(a, b) { return catCount[b] - catCount[a]; })[0] || 'Unknown';

  // Sequence pattern analysis
  var sustained   = top3.filter(function(r) { return r.durationType === 'SUSTAINED'; }).length;
  var whaleVol    = top3.filter(function(r) { return r.rvolOnDay >= 5; }).length;
  var tightFloat  = top3.filter(function(r) { return r.floatM < 15; }).length;
  var strongCat   = top3.filter(function(r) { return r.catalyst.rank <= 2; }).length;

  var msg = '<b>MAVERICK AUTOPSY REPORT</b>\n';
  msg += 'Top Movers — Last 30 Days Science\n\n';

  for (var i = 0; i < top3.length; i++) {
    var r = top3[i];
    msg += '<b>#' + (i + 1) + ' $' + r.sym + '</b>\n';
    msg += 'Max Move: +' + r.maxGainPct + '% (' + r.dayDate + ')\n';
    msg += 'Catalyst: ' + r.catalyst.name + ' (Rank ' + r.catalyst.rank + '/5)\n';
    if (r.catHead) msg += 'Headline: "' + r.catHead.slice(0, 90) + '"\n';
    msg += 'Duration: ' + r.durationType + ' (~' + r.estHours + 'h)\n';
    msg += 'RVOL on Move Day: ' + r.rvolOnDay + 'x\n';
    msg += 'Close/High: ' + r.closeVsHigh + '% | Float: ' + r.floatM + 'M\n';
    if (r.seqFlags.length) msg += 'Sequence: ' + r.seqFlags.join(' + ') + '\n';
    msg += '\n';
  }

  msg += '─────────────────────\n';
  msg += '<b>NEW SCIENCE FINDINGS</b>\n\n';
  msg += 'Avg move (top 3): +' + avgMove + '%\n';
  msg += 'Avg duration: ' + avgHours + 'h\n';
  msg += 'Avg RVOL on move day: ' + avgRvol + 'x\n';
  msg += 'Top catalyst type: ' + topCat + '\n\n';

  msg += '<b>SEQUENCE PATTERNS:</b>\n';
  msg += '• ' + sustained + '/3 movers had SUSTAINED all-day runs\n';
  msg += '• ' + whaleVol  + '/3 had RVOL > 5x on move day\n';
  msg += '• ' + tightFloat + '/3 had float under 15M\n';
  msg += '• ' + strongCat + '/3 had Rank 1-2 catalyst\n\n';

  msg += '<b>WHAT THIS TEACHES:</b>\n';
  if (avgRvol >= 5)   msg += '• Wait for RVOL > 5x — whales confirm before entry\n';
  if (avgHours >= 4)  msg += '• Sustained moves last ~' + avgHours + 'h — hold your runners\n';
  if (strongCat >= 2) msg += '• Strong catalysts (Rank 1-2) drove these moves\n';
  if (sustained >= 2) msg += '• All-day runs > spike-fades — thesis matters\n\n';

  msg += '<b>IGNITION SEQUENCE (what preceded each move):</b>\n';
  msg += '1. Catalyst drops (Rank 1-2)\n';
  msg += '2. Float < 15M (limited supply)\n';
  msg += '3. Gap > 10% pre-market\n';
  msg += '4. RVOL > ' + (avgRvol >= 5 ? '5x' : '3x') + ' within first hour\n';
  msg += '5. First green candle holds VWAP\n\n';

  msg += 'Score any setup: /science TICKER\n';
  msg += 'Cached 4h. Run /autopsy to refresh.';
  return msg;
}

// ══════════════════════════════════════════════════════════════════════
// ── COMMAND HANDLERS ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

async function cmdStart(chatId) {
  await tg(
    '<b>MAVERICK INTEL BOT v4.0</b>\n\n' +
    '<b>STOCK ANALYSIS</b>\n' +
    '/check TICKER — Full AI + live data analysis\n' +
    '/scan — Top setups now\n' +
    '/squeeze — Squeeze candidates\n' +
    '/gappers — Today\'s top gappers\n' +
    '/news — Latest catalysts\n\n' +
    '<b>NEW SCIENCE</b>\n' +
    '/science TICKER — Maverick Ignition Score (MIS)\n' +
    '/sdi TICKER — Short Danger Index\n' +
    '/autopsy — 30-day top mover pattern analysis\n\n' +
    '<b>PROTOCOLS</b>\n' +
    '/ross — Ross Cameron Gap and Go\n' +
    '/humble — Humble Trader Continuation\n' +
    '/maverick — Maverick Adaptive\n' +
    '/protocol off — Deactivate protocol\n\n' +
    '<b>TRADE TRACKING</b>\n' +
    '/position TICKER ENTRY STOP TP1 TP2 SHARES\n' +
    '/positions — Open trades\n' +
    '/close TICKER EXITPRICE — Close and log\n' +
    '/watch TICKER — Add to universe\n' +
    '/alert TICKER PRICE above|below\n\n' +
    '<b>LEARNING</b>\n' +
    '/myedge — Personal win rate analysis\n' +
    '/history — Last 10 logged trades\n\n' +
    '<b>AI</b>\n' +
    'Type anything — I remember our conversation.\n\n' +
    'Account: $' + ACCOUNT_SIZE + ' | Risk/trade: $' + MAX_RISK_DOLLAR,
    chatId
  );
}

async function cmdCheck(sym, chatId) {
  await tg('Pulling live data for $' + sym + '...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('No data for $' + sym + '. Verify ticker or try again.', chatId);

  var sr     = scoreSetup(d);
  var news   = await polyNewsRaw(sym, 5);
  var catRank = 5, catName = 'No Catalyst';
  var latestHead = '';
  if (news.length) {
    latestHead = news[0].title || '';
    var cat = identifyCatalyst(latestHead);
    catRank = cat.rank; catName = cat.name;
  }

  var mis = calcMIS(d, catRank);
  var sdi = calcSDI(d, catRank);

  var protoMsg = '';
  if (activeProtocol && PROTOCOLS[activeProtocol]) {
    var passes = PROTOCOLS[activeProtocol].filter(d);
    var lvl    = applyProtocol(d, activeProtocol);
    protoMsg   =
      '\n<b>' + PROTOCOLS[activeProtocol].name + ':</b> ' + (passes ? 'PASSES' : 'FAILS FILTER') + '\n' +
      'Entry:$' + lvl.entry + ' Stop:$' + lvl.stop + ' TP1:$' + lvl.tp1 + ' TP2:$' + lvl.tp2 + '\n' +
      'Shares:' + lvl.shares + ' Risk:$' + rnd(Math.abs(lvl.entry - lvl.stop) * lvl.shares, 2) + ' R:R ' + lvl.rr + ':1\n';
  }

  var changeStr = (d.changePct >= 0 ? '+' : '') + rnd(d.changePct, 2) + '%';

  var analysis = await ai(
    'You are MAVERICK LION BRAIN — elite micro-cap trading analyst. ' +
    'Apply Maverick Whale Doctrine: Phase 1-2 accumulation entry, exit before Phase 4 distribution. ' +
    'User has $350 account. Max risk $7 per trade. ' +
    (activeProtocol === 'ross' ? 'Apply Ross Cameron Gap and Go rules. ' : '') +
    (activeProtocol === 'humble' ? 'Apply Humble Trader rules: 3 green candles, 3:1 R:R. ' : '') +
    'Verdict: BUY / WATCH / PASS. Include entry zone, hard stop, TP1, TP2, R:R. Direct. No fluff. Max 200 words.',
    '$' + sym + ' LIVE DATA:\n' +
    'Price:$' + d.price + ' (' + changeStr + ') Source:' + d.source + '\n' +
    'RVOL:' + d.relVol + 'x AvgVol:' + d.avgVol + ' Float:' + d.floatM + 'M Short:' + d.shortPct + '%\n' +
    'Gap:' + (d.gapPct || 0) + '% DTC:' + d.daysToCover + 'd ATR:$' + d.atr + '\n' +
    'Score:' + sr.score + '/100 MIS:' + mis.pct + '/100 SDI:' + sdi.score + '/100\n' +
    'Catalyst:' + catName + ' (Rank ' + catRank + ')\n' +
    (latestHead ? 'Latest:"' + latestHead.slice(0, 100) + '"\n' : '') +
    'Flags:' + (sr.flags.join(', ') || 'none'),
    400, chatId
  );

  var conviction = sr.score >= 85 ? 'HIGH CONVICTION' : sr.score >= 70 ? 'ELEVATED' : sr.score >= 55 ? 'MODERATE' : 'LOW';

  await tg(
    '<b>$' + sym + '</b> [' + conviction + '] | Source: ' + (d.source || 'Multi') + '\n\n' +
    '$' + d.price + ' (' + changeStr + ')' + (d.gapPct ? '  Gap:+' + rnd(d.gapPct, 1) + '%' : '') + '\n' +
    'RVOL:<b>' + d.relVol + 'x</b>  Float:<b>' + d.floatM + 'M</b>  Short:' + rnd(d.shortPct, 1) + '%\n' +
    'DTC: ' + d.daysToCover + ' days | Score:' + sr.score + '/100\n' +
    'MIS:<b>' + mis.pct + '</b> [' + mis.tier + '] | SDI:<b>' + sdi.score + '</b> [' + sdi.danger + ']\n' +
    (sr.flags.length ? sr.flags.join(' | ') + '\n' : '') +
    (catName !== 'No Catalyst' ? 'Catalyst: ' + catName + '\n' : '') +
    protoMsg +
    '\n' + (analysis || 'AI offline — computed levels only.') +
    '\n\n<b>Quick Levels:</b>\n' +
    'Stop: $' + rnd(d.price - d.atr * 1.5, 4) + '\n' +
    'TP1:  $' + rnd(d.price + d.atr * 2, 4) + '\n' +
    'TP2:  $' + rnd(d.price + d.atr * 4, 4) +
    getPersonalInsight(),
    chatId
  );
}

async function cmdScience(sym, chatId) {
  await tg('Running Maverick Ignition Score for $' + sym + '...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('Cannot pull data for $' + sym + '. Check ticker.', chatId);

  var news = await polyNewsRaw(sym, 5);
  var catRank = 5, catName = 'No Catalyst Detected', latestHead = '';
  if (news.length) {
    latestHead = news[0].title || '';
    var cat = identifyCatalyst(latestHead);
    catRank = cat.rank; catName = cat.name;
  }

  var mis = calcMIS(d, catRank);
  var sdi = calcSDI(d, catRank);

  var msg = '<b>$' + sym + ' — MAVERICK IGNITION SCORE</b>\n\n';
  msg += 'MIS: <b>' + mis.pct + '/100</b> [' + mis.tier + ']\n';
  msg += 'SDI: <b>' + sdi.score + '/100</b> [' + sdi.danger + ']\n';
  msg += 'Expected Move: ' + mis.expectedMove + '\n\n';

  msg += '<b>Catalyst:</b> ' + catName + ' (Rank ' + catRank + '/5)\n';
  if (latestHead) msg += '"' + latestHead.slice(0, 100) + '"\n';

  msg += '\n<b>MIS Breakdown (Leading Indicators):</b>\n';
  mis.components.forEach(function(c) { msg += '• ' + c + '\n'; });

  msg += '\n<b>Short Danger Analysis:</b>\n';
  sdi.reasons.slice(0, 5).forEach(function(r) { msg += '• ' + r + '\n'; });

  msg += '\n<b>Quick Levels:</b>\n';
  msg += 'Price:  $' + d.price + ' (' + (d.changePct >= 0 ? '+' : '') + rnd(d.changePct, 2) + '%)\n';
  msg += 'Entry:  $' + d.price + '\n';
  msg += 'Stop:   $' + rnd(d.price - d.atr * 1.5, 4) + '\n';
  msg += 'TP1:    $' + rnd(d.price + d.atr * 2, 4) + '\n';
  msg += 'TP2:    $' + rnd(d.price + d.atr * 4, 4) + '\n';
  msg += 'Float: ' + d.floatM + 'M  RVOL: ' + d.relVol + 'x  DTC: ' + d.daysToCover + 'd\n';

  if (mis.pct >= 80) {
    msg += '\nMIS > 80 = HIGH PRIORITY SETUP. Track it: /watch ' + sym;
  } else if (mis.pct >= 65) {
    msg += '\nMIS 65-79 = Watch for RVOL spike or catalyst confirmation.';
  } else {
    msg += '\nMIS < 65 = Missing key ingredients. Skip or monitor.';
  }

  await tg(msg, chatId);
}

async function cmdSDI(sym, chatId) {
  await tg('Calculating Short Danger Index for $' + sym + '...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('Cannot pull data for $' + sym, chatId);

  var news    = await polyNewsRaw(sym, 5);
  var catRank = 5;
  if (news.length) catRank = identifyCatalyst(news[0].title || '').rank;

  var sdi = calcSDI(d, catRank);

  var msg = '<b>$' + sym + ' — SHORT DANGER INDEX</b>\n\n';
  msg += 'SDI Score: <b>' + sdi.score + '/100</b>\n';
  msg += 'Danger Level: <b>' + sdi.danger + '</b>\n\n';
  msg += '<b>Why Shorts Fear This Setup:</b>\n';
  sdi.reasons.forEach(function(r) { msg += '• ' + r + '\n'; });
  msg += '\nFloat: ' + d.floatM + 'M  |  Short: ' + rnd(d.shortPct, 1) + '%\n';
  msg += 'Days to Cover: ' + d.daysToCover + ' days\n';
  msg += 'RVOL: ' + d.relVol + 'x  |  Price: $' + d.price + '\n\n';

  if (sdi.score >= 75) {
    msg += 'EXTREME DANGER for shorts = highest reward potential for longs.\nPair with /science ' + sym + ' for full picture.';
  } else if (sdi.score >= 55) {
    msg += 'Shorts are nervous. Watch for RVOL spike — that forces covers.';
  } else {
    msg += 'Shorts comfortable here. Need stronger catalyst or higher RVOL before this moves.';
  }

  await tg(msg, chatId);
}

async function cmdAutopsy(chatId) {
  // Use cached results if less than 4 hours old
  if (
    memory.science &&
    memory.science.results &&
    memory.science.generated &&
    (Date.now() - memory.science.generated) < 4 * 3600 * 1000
  ) {
    var cached = buildAutopsyReport(memory.science.results);
    return tg(cached, chatId);
  }
  var results = await runAutopsy();
  if (results && results.length) {
    await tg(buildAutopsyReport(results), chatId);
  } else {
    await tg(
      'Autopsy failed — no movers found. Needs POLYGON_KEY with active subscription.\n' +
      'Check /check SPY to verify your Polygon key is working.',
      chatId
    );
  }
}

async function cmdGappers(chatId) {
  await tg('Pulling live gappers...', chatId);
  var gainers = await getTopGainers();
  if (!gainers.length) return tg('No gapper data. Verify POLYGON_KEY in .env.', chatId);

  var msg = '<b>TOP GAPPERS NOW</b>\n\n';
  var count = 0;
  for (var i = 0; i < gainers.length && count < 10; i++) {
    var g         = gainers[i];
    var sym       = g.ticker;
    var day       = g.day || {};
    var price     = day.c || (g.lastTrade && g.lastTrade.p) || 0;
    var changePct = g.todaysChangePerc || 0;
    var volume    = day.v || 0;
    if (price < 0.5 || price > 50) continue;
    msg += '<b>$' + sym + '</b>  $' + rnd(price, 4) + '  +' + rnd(changePct, 1) + '%\n';
    msg += 'Vol: ' + (volume > 1e6 ? rnd(volume / 1e6, 2) + 'M' : rnd(volume / 1e3, 0) + 'K') + '\n\n';
    count++;
  }
  msg += 'Full analysis: /check TICKER or /science TICKER';
  await tg(msg, chatId);
}

async function cmdScan(chatId) {
  var protoName = activeProtocol ? PROTOCOLS[activeProtocol].name : 'Standard';
  await tg('Scanning universe... Protocol: ' + protoName, chatId);

  var universe = [];
  var gainers  = await getTopGainers();
  if (gainers.length) {
    gainers.forEach(function(g) { if (g.ticker) universe.push(g.ticker); });
  }
  universe = universe.concat(Object.keys(watchlist)).concat(BASE_SCAN)
    .filter(function(v, i, a) { return a.indexOf(v) === i; }).slice(0, 25);

  var settled = await Promise.allSettled(universe.map(function(s) { return getStock(s); }));
  var results = [];
  for (var i = 0; i < settled.length; i++) {
    var r = settled[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    var d  = r.value;
    var sr = scoreSetup(d);
    var ok = !activeProtocol || !PROTOCOLS[activeProtocol] || PROTOCOLS[activeProtocol].filter(d);
    if (sr.score >= 50 && ok) {
      var mis = calcMIS(d, 5);
      results.push(Object.assign({}, d, { score: sr.score, flags: sr.flags, mis: mis.pct }));
    }
  }
  results.sort(function(a, b) { return (b.score + b.mis) - (a.score + a.mis); });

  if (!results.length) {
    return tg('No qualifying setups. Market may be quiet. Try /scan with /protocol off.', chatId);
  }

  var msg = '<b>MAVERICK SCAN</b> [' + protoName + ']\n\n';
  for (var j = 0; j < Math.min(6, results.length); j++) {
    var d2  = results[j];
    var lbl = d2.score >= 80 ? 'HOT' : d2.score >= 65 ? 'WARM' : 'WATCH';
    var lvl = activeProtocol ? applyProtocol(d2, activeProtocol) : {
      stop:   rnd(d2.price - d2.atr * 1.5, 4),
      tp1:    rnd(d2.price + d2.atr * 2, 4),
      shares: calcShares(d2.price, rnd(d2.price - d2.atr * 1.5, 4)),
      rr:     rnd(2 / 1.5, 2)
    };
    msg += '[' + lbl + '] <b>$' + d2.sym + '</b> Score:' + d2.score + ' MIS:' + d2.mis + '\n';
    msg += '$' + d2.price + '  ' + (d2.changePct >= 0 ? '+' : '') + rnd(d2.changePct, 1) + '%';
    msg += '  RVOL ' + d2.relVol + 'x\n';
    msg += 'Float:' + d2.floatM + 'M  ' + (d2.flags.slice(0, 2).join(' | ') || '') + '\n';
    msg += 'Stop:$' + lvl.stop + '  TP1:$' + lvl.tp1 + '  Shares:' + lvl.shares + '\n\n';
  }
  msg += 'Full analysis: /science TICKER  or  /check TICKER';
  await tg(msg, chatId);
}

async function cmdSqueeze(chatId) {
  await tg('Running squeeze scan...', chatId);
  var universe = Object.keys(watchlist).concat(BASE_SCAN)
    .filter(function(v, i, a) { return a.indexOf(v) === i; }).slice(0, 20);
  var settled  = await Promise.allSettled(universe.map(function(s) { return getStock(s); }));
  var results  = [];
  for (var i = 0; i < settled.length; i++) {
    var r = settled[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    var d    = r.value;
    var sdi  = calcSDI(d, 5);
    var sqSc = sdi.score;
    if (sqSc >= 30 || d.shortPct >= 15) results.push(Object.assign({}, d, { sqSc: sqSc }));
  }
  results.sort(function(a, b) { return b.sqSc - a.sqSc; });
  if (!results.length) return tg('No notable squeeze setups detected.', chatId);

  var msg = '<b>SQUEEZE SCAN (SDI-Powered)</b>\n\n';
  for (var j = 0; j < Math.min(5, results.length); j++) {
    var d2   = results[j];
    var danger = d2.sqSc >= 75 ? 'EXTREME' : d2.sqSc >= 55 ? 'HIGH' : 'WATCH';
    msg += '[' + danger + '] <b>$' + d2.sym + '</b> SDI:' + d2.sqSc + '/100\n';
    msg += 'Short:' + rnd(d2.shortPct, 1) + '%  RVOL:' + d2.relVol + 'x  Float:' + d2.floatM + 'M\n';
    msg += 'DTC:' + d2.daysToCover + 'd  Stop:$' + rnd(d2.price * 0.95, 4) + '\n\n';
  }
  msg += 'SDI > 75 = EXTREME danger for shorts = highest reward for longs.\n';
  msg += 'Full score: /sdi TICKER';
  await tg(msg, chatId);
}

async function cmdNews(chatId) {
  await tg('Pulling latest catalysts...', chatId);
  var articles = POLYGON ? await polyNewsRaw(null, 15) : [];
  var fhNews   = !POLYGON ? await fh('/news?category=general') : null;

  var msg = '<b>LATEST CATALYSTS</b>\n\n';

  if (articles.length) {
    var filtered = articles.filter(function(a) { return a.title; }).slice(0, 8);
    for (var i = 0; i < filtered.length; i++) {
      var a      = filtered[i];
      var cat    = identifyCatalyst(a.title);
      var ticks  = (a.tickers || []).slice(0, 3).join(', ') || '—';
      var ageMin = a.published_utc
        ? Math.round((Date.now() - new Date(a.published_utc).getTime()) / 60000) : 0;
      var age    = ageMin < 60 ? ageMin + 'm' : Math.round(ageMin / 60) + 'h';
      msg += (i + 1) + '. [Rank ' + cat.rank + '] <b>' + ticks + '</b> — ' + age + '\n' + a.title + '\n\n';
    }
  } else if (Array.isArray(fhNews)) {
    var items = fhNews.filter(function(n) { return n.headline; }).slice(0, 8);
    for (var j = 0; j < items.length; j++) {
      var n      = items[j];
      var ageMin2 = Math.round((Date.now() / 1000 - n.datetime) / 60);
      var age2    = ageMin2 < 60 ? ageMin2 + 'm' : Math.round(ageMin2 / 60) + 'h';
      var related = (n.related || '').split(',')[0].replace(/[^A-Z0-9]/gi, '').trim().toUpperCase() || '—';
      msg += (j + 1) + '. <b>' + related + '</b> — ' + age2 + '\n' + n.headline + '\n\n';
    }
  } else {
    msg += 'News unavailable. Check POLYGON_KEY or FINNHUB_KEY in .env.';
  }
  await tg(msg, chatId);
}

async function cmdProtocol(parts, chatId) {
  var sub = (parts[1] || '').toLowerCase();
  if (sub === 'off') {
    activeProtocol = null;
    return tg('Protocol deactivated. Running standard Maverick mode.', chatId);
  }
  if (!activeProtocol) {
    return tg(
      'No protocol active.\n\n' +
      '/ross — Ross Cameron Gap and Go\n' +
      '/humble — Humble Trader Continuation\n' +
      '/maverick — Maverick Adaptive\n\n' +
      'Type /protocol off to clear.',
      chatId
    );
  }
  var p   = PROTOCOLS[activeProtocol];
  var msg = '<b>' + p.name + ' — ACTIVE</b>\n\n' + p.desc + '\n\nRULES:\n';
  p.rules.forEach(function(r, i) { msg += (i + 1) + '. ' + r + '\n'; });
  await tg(msg, chatId);
}

async function cmdActivateProtocol(name, chatId) {
  activeProtocol = name;
  var p   = PROTOCOLS[name];
  var msg = '<b>' + p.name + ' ACTIVATED</b>\n\n' + p.desc + '\n\nRULES:\n';
  p.rules.forEach(function(r, i) { msg += (i + 1) + '. ' + r + '\n'; });
  msg += '\nAll /scan, /check, briefing filtered through this protocol.\nType /protocol off to deactivate.';
  await tg(msg, chatId);
}

async function cmdPosition(parts, chatId) {
  var sym    = parts[1];
  var entry  = parts[2];
  var stop   = parts[3];
  var tp1    = parts[4];
  var tp2    = parts[5];
  var shares = parts[6];
  if (!sym || !entry || !stop || !tp1) {
    return tg('Usage: /position TICKER ENTRY STOP TP1 TP2 SHARES\nExample: /position MDAI 1.50 1.38 1.80 2.10 50', chatId);
  }
  var ticker = sym.toUpperCase();
  if (!shares) shares = calcShares(+entry, +stop);
  var rr = rnd((+tp1 - +entry) / Math.max(+entry - +stop, 0.001), 2);
  positions[ticker] = {
    entry: +entry, stop: +stop, tp1: +tp1, tp2: tp2 ? +tp2 : null,
    shares: +shares, protocol: activeProtocol || 'maverick',
    entryTime: Date.now(),
    alerts: { stopWarn: false, tp1: false, tp2: false, overextended: false }
  };
  var risk    = rnd(Math.abs(+entry - +stop) * +shares, 2);
  var reward1 = rnd(Math.abs(+tp1 - +entry) * +shares, 2);
  await tg(
    '<b>$' + ticker + ' TRACKED</b>\n\n' +
    'Entry:  $' + entry + '\n' +
    'Stop:   $' + stop + ' (' + rnd((+stop - +entry) / +entry * 100, 1) + '%)\n' +
    'TP1:    $' + tp1 + ' (+' + rnd((+tp1 - +entry) / +entry * 100, 1) + '%)\n' +
    'TP2:    ' + (tp2 ? '$' + tp2 : 'not set') + '\n' +
    'Shares: ' + shares + '\n' +
    'Risk:   $' + risk + ' of $' + ACCOUNT_SIZE + '\n' +
    'Reward at TP1: $' + reward1 + '\n' +
    'R:R:    ' + rr + ':1\n' +
    'Protocol: ' + (activeProtocol || 'maverick') + '\n\n' +
    'I will alert you at stop, TP1, and TP2.',
    chatId
  );
}

async function cmdPositions(chatId) {
  var keys = Object.keys(positions);
  if (!keys.length) return tg('No open positions.\n\nTrack a trade:\n/position TICKER ENTRY STOP TP1', chatId);
  var msg = '<b>OPEN POSITIONS</b>\n\n';
  for (var i = 0; i < keys.length; i++) {
    var sym = keys[i];
    var pos = positions[sym];
    var d   = await getStock(sym).catch(function() { return null; });
    if (!d) { msg += '<b>$' + sym + '</b> — data unavailable\n\n'; continue; }
    var pl       = rnd((d.price - pos.entry) / pos.entry * 100, 2);
    var plDollar = rnd((d.price - pos.entry) * pos.shares, 2);
    var stopDist = rnd((d.price - pos.stop) / d.price * 100, 1);
    var tp1Dist  = pos.tp1 ? rnd((pos.tp1 - d.price) / d.price * 100, 1) : null;
    msg += (pl >= 0 ? 'UP' : 'DOWN') + ' <b>$' + sym + '</b>\n';
    msg += 'Entry $' + pos.entry + ' → Now $' + d.price + ' [' + (d.source || '?') + ']\n';
    msg += 'P&L: ' + (pl >= 0 ? '+' : '') + pl + '% ($' + (plDollar >= 0 ? '+' : '') + plDollar + ')\n';
    msg += 'Stop: $' + pos.stop + ' (' + stopDist + '% away)' + (stopDist < 3 ? ' ⚠️ CLOSE' : '') + '\n';
    msg += 'TP1: ' + (pos.tp1 ? '$' + pos.tp1 + ' (' + tp1Dist + '% away)' : 'not set') + '\n\n';
  }
  await tg(msg, chatId);
}

async function cmdClose(parts, chatId) {
  var sym       = (parts[1] || '').toUpperCase();
  var exitPrice = parts[2] ? +parts[2] : null;
  if (!sym || !positions[sym]) return tg('No tracked position for $' + sym, chatId);
  var pos = positions[sym];
  delete positions[sym];
  if (!exitPrice) {
    var d = await getStock(sym).catch(function() { return null; });
    if (d) exitPrice = d.price;
  }
  if (exitPrice) {
    var pl       = rnd((exitPrice - pos.entry) / pos.entry * 100, 2);
    var plDollar = rnd((exitPrice - pos.entry) * pos.shares, 2);
    learnFromTrade({
      sym: sym, entry: pos.entry, exit: exitPrice, pnlPct: pl, pnlDollar: plDollar,
      protocol: pos.protocol || 'maverick', setupScore: 0, float: 0, rvol: 0, ts: Date.now()
    });
    await tg(
      '<b>$' + sym + ' CLOSED</b>\n' +
      'Entry: $' + pos.entry + ' | Exit: $' + exitPrice + '\n' +
      'P&L: ' + (pl >= 0 ? '+' : '') + pl + '% ($' + (plDollar >= 0 ? '+' : '') + plDollar + ')\n' +
      'Shares: ' + pos.shares + '  Protocol: ' + (pos.protocol || 'maverick') + '\n\n' +
      (pl > 0 ? 'Win logged. Maverick Protocol learning.' : 'Loss logged. Maverick Protocol learning.') +
      '\nTotal trades logged: ' + (memory.trades ? memory.trades.length : 0),
      chatId
    );
  } else {
    await tg('$' + sym + ' position removed (no exit price).', chatId);
  }
}

async function cmdWatch(sym, chatId) {
  var ticker = sym.toUpperCase();
  watchlist[ticker] = { added: Date.now() };
  await tg('$' + ticker + ' added to watchlist. Will appear in /scan, /squeeze, and news alerts.', chatId);
}

async function cmdAlert(parts, chatId) {
  var sym   = parts[1];
  var price = parts[2];
  var dir   = parts[3];
  if (!sym || !price) return tg('Usage: /alert TICKER PRICE above|below\nExample: /alert MDAI 2.00 above', chatId);
  priceAlerts.push({ ticker: sym.toUpperCase(), price: +price, direction: dir || 'above', chatId: chatId, fired: false });
  await tg('Alert set: $' + sym.toUpperCase() + ' ' + (dir || 'above') + ' $' + price, chatId);
}

async function cmdMyEdge(chatId) {
  if (!memory.trades || memory.trades.length < 5) {
    return tg(
      'Need at least 5 logged trades.\n\n' +
      'Log trades:\n/position TICKER ENTRY STOP TP1\nthen /close TICKER EXITPRICE\n\n' +
      'Currently logged: ' + (memory.trades ? memory.trades.length : 0) + ' trades.',
      chatId
    );
  }
  rebuildWinRates();
  var wr      = memory.winRates;
  var trades  = memory.trades;
  var wins    = trades.filter(function(t) { return t.pnlPct > 0; }).length;
  var winRate = rnd(wins / trades.length * 100, 1);
  var winList = trades.filter(function(t) { return t.pnlPct > 0; });
  var avgWin  = rnd(winList.reduce(function(a, t) { return a + t.pnlPct; }, 0) / Math.max(wins, 1), 2);
  var losses  = trades.filter(function(t) { return t.pnlPct <= 0; });
  var avgLoss = rnd(losses.reduce(function(a, t) { return a + t.pnlPct; }, 0) / Math.max(losses.length, 1), 2);

  var msg = '<b>YOUR PERSONAL EDGE</b>\n';
  msg += 'Based on ' + trades.length + ' logged trades\n\n';
  msg += 'Win rate: ' + winRate + '%  |  Avg win: +' + avgWin + '%  |  Avg loss: ' + avgLoss + '%\n\n';
  msg += '<b>By Float:</b>\n';
  ['nano', 'tight', 'mid'].forEach(function(k) {
    var arr = wr.byFloat[k] || [];
    if (arr.length >= 2) {
      var rate = rnd(arr.reduce(function(a, b) { return a + b; }, 0) / arr.length * 100, 0);
      msg += k + ' (<' + (k === 'nano' ? '5M' : k === 'tight' ? '15M' : '15M+') + '): ' + rate + '% win (' + arr.length + ' trades)\n';
    }
  });
  msg += '\n<b>By RVOL:</b>\n';
  ['high', 'med', 'low'].forEach(function(k) {
    var arr = wr.byRvol[k] || [];
    if (arr.length >= 2) {
      var rate = rnd(arr.reduce(function(a, b) { return a + b; }, 0) / arr.length * 100, 0);
      msg += k + ' RVOL: ' + rate + '% win (' + arr.length + ' trades)\n';
    }
  });
  msg += '\n<b>By Protocol:</b>\n';
  Object.keys(wr.byProtocol || {}).forEach(function(p) {
    var bp   = wr.byProtocol[p];
    var rate = rnd(bp.wins / bp.total * 100, 0);
    msg += p + ': ' + rate + '% (' + bp.wins + '/' + bp.total + ')\n';
  });
  msg += '\n' + getPersonalInsight();
  msg += '\n\nMaverick Protocol is adapting to your edge.';
  await tg(msg, chatId);
}

async function cmdHistory(chatId) {
  if (!memory.trades || !memory.trades.length) return tg('No trade history yet.', chatId);
  var recent = memory.trades.slice(-10).reverse();
  var msg    = '<b>LAST ' + recent.length + ' TRADES</b>\n\n';
  recent.forEach(function(t) {
    var d   = new Date(t.ts).toLocaleDateString();
    var win = t.pnlPct > 0 ? 'WIN' : 'LOSS';
    msg += '[' + win + '] <b>$' + t.sym + '</b> ' + (t.pnlPct > 0 ? '+' : '') + rnd(t.pnlPct, 2) + '%';
    msg += ' ($' + (t.pnlDollar > 0 ? '+' : '') + rnd(t.pnlDollar || 0, 2) + ')\n';
    msg += d + ' | ' + (t.protocol || '?') + '\n\n';
  });
  await tg(msg, chatId);
}

async function cmdAI(text, chatId) {
  var personalInsight = getPersonalInsight();
  var protoContext    = activeProtocol ? ('Active protocol: ' + PROTOCOLS[activeProtocol].name + '. ') : '';
  var tradeCount      = memory.trades ? memory.trades.length : 0;
  var reply = await ai(
    'You are Maverick Bot v4.0 — elite trading assistant and brilliant general AI. ' +
    'For trading: apply Maverick Whale Doctrine (Phase 1-2 entry, tight float, whale volume, hard stops). ' +
    'User has $350 account. Max $7 risk per trade. ' + protoContext +
    'User has logged ' + tradeCount + ' trades. ' +
    (personalInsight ? 'Personal edge data: ' + personalInsight + '. ' : '') +
    'For non-trading: answer like a knowledgeable direct friend. No disclaimers. Max 280 words.',
    text, 500, chatId
  );
  if (reply) await tg(reply, chatId);
  else await tg('AI brain offline. Try /check TICKER for analysis.', chatId);
}

// ── BACKGROUND MONITORS ────────────────────────────────────────────────────
async function monitorPositions() {
  for (var sym in positions) {
    var pos = positions[sym];
    var d   = await getStock(sym).catch(function() { return null; });
    if (!d) continue;
    var price    = d.price;
    var pct      = (price - pos.entry) / pos.entry * 100;
    var stopDist = (price - pos.stop) / pos.stop * 100;

    // Stop warning
    if (stopDist < 3 && !pos.alerts.stopWarn) {
      pos.alerts.stopWarn = true;
      await tg(
        'WARNING — <b>$' + sym + ' STOP APPROACHING</b>\n' +
        'Price $' + price + '  Stop $' + pos.stop + '  (' + rnd(stopDist, 1) + '% away)\n' +
        'RVOL: ' + d.relVol + 'x  Source: ' + (d.source || '?') + '\n' +
        'If thesis broken — exit now. Small loss beats big loss.'
      );
    } else if (stopDist >= 6) { pos.alerts.stopWarn = false; }

    // Stop hit
    if (price <= pos.stop) {
      await tg(
        'STOP HIT — <b>$' + sym + '</b>\n' +
        'Price:$' + price + '  Stop:$' + pos.stop + '\n' +
        'P&L: ' + rnd(pct, 1) + '%  EXIT NOW.'
      );
    }

    // TP1
    if (pos.tp1 && price >= pos.tp1 && !pos.alerts.tp1) {
      pos.alerts.tp1 = true;
      await tg(
        'TP1 HIT — <b>$' + sym + ' $' + pos.tp1 + '</b>\n' +
        'Price:$' + price + ' (+' + rnd(pct, 1) + '%)\n' +
        'Sell 50%. Move stop to breakeven. Let runner work.\n' +
        'TP2: ' + (pos.tp2 ? '$' + pos.tp2 : 'not set')
      );
    }

    // TP2
    if (pos.tp2 && price >= pos.tp2 && !pos.alerts.tp2) {
      pos.alerts.tp2 = true;
      await tg(
        'TP2 HIT — <b>$' + sym + ' $' + pos.tp2 + '</b>\n' +
        'Price:$' + price + ' (+' + rnd(pct, 1) + '%)\n' +
        'Sell 30% more. Trail remaining 20% aggressively.'
      );
    }

    // Overextended
    if (pct > 25 && !pos.alerts.tp1 && !pos.alerts.overextended) {
      pos.alerts.overextended = true;
      await tg(
        'OVEREXTENDED — <b>$' + sym + '</b>\n' +
        '+' + rnd(pct, 1) + '% from entry $' + pos.entry + '\n' +
        'No TP hit yet. RVOL: ' + d.relVol + 'x\n' +
        (d.relVol < 1.5 ? 'Volume fading — distribution risk. Scale out.' : 'Volume holding. Consider partial exit and trail stop.')
      );
    }
  }
}

async function checkPriceAlerts() {
  for (var i = 0; i < priceAlerts.length; i++) {
    var alert = priceAlerts[i];
    if (alert.fired) continue;
    var d = await getStock(alert.ticker).catch(function() { return null; });
    if (!d) continue;
    var triggered = alert.direction === 'above' ? d.price >= alert.price : d.price <= alert.price;
    if (triggered) {
      alert.fired = true;
      await tg(
        'PRICE ALERT — <b>$' + alert.ticker + '</b>\n' +
        'Price $' + d.price + ' is ' + alert.direction + ' $' + alert.price + '\n' +
        'Change: ' + (d.changePct >= 0 ? '+' : '') + rnd(d.changePct, 2) + '%  RVOL:' + d.relVol + 'x\n' +
        'Source: ' + (d.source || '?') + '\n' +
        '/science ' + alert.ticker + ' | /check ' + alert.ticker,
        alert.chatId || CHAT_ID
      );
    }
  }
}

// ── TELEGRAM POLL LOOP ──────────────────────────────────────────────────────
async function poll() {
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 30000);
    var r;
    try {
      r = await fetch(
        'https://api.telegram.org/bot' + TG_TOKEN +
        '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=25',
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timer);
    }

    var d = await r.json();
    if (!d.ok || !d.result || !d.result.length) {
      if (!d.ok) console.error('[POLL] Telegram error:', d.description);
      return;
    }

    for (var i = 0; i < d.result.length; i++) {
      var update = d.result[i];
      lastUpdateId = update.update_id;
      var msg    = update.message || update.channel_post;
      if (!msg || !msg.text) continue;
      var chatId = String(msg.chat.id);
      var text   = msg.text.trim();
      var parts  = text.split(/\s+/);
      var cmd    = parts[0].toLowerCase().split('@')[0];
      console.log('[MSG] chatId=' + chatId + ' cmd=' + cmd);

      try {
        if      (cmd === '/start'    || cmd === '/help')  await cmdStart(chatId);
        else if (cmd === '/check'    && parts[1])         await cmdCheck(parts[1].toUpperCase(), chatId);
        else if (cmd === '/scan')                         await cmdScan(chatId);
        else if (cmd === '/squeeze')                      await cmdSqueeze(chatId);
        else if (cmd === '/gappers')                      await cmdGappers(chatId);
        else if (cmd === '/news')                         await cmdNews(chatId);
        else if (cmd === '/science'  && parts[1])         await cmdScience(parts[1].toUpperCase(), chatId);
        else if (cmd === '/sdi'      && parts[1])         await cmdSDI(parts[1].toUpperCase(), chatId);
        else if (cmd === '/autopsy')                      await cmdAutopsy(chatId);
        else if (cmd === '/ross')                         await cmdActivateProtocol('ross', chatId);
        else if (cmd === '/humble')                       await cmdActivateProtocol('humble', chatId);
        else if (cmd === '/maverick')                     await cmdActivateProtocol('maverick', chatId);
        else if (cmd === '/protocol')                     await cmdProtocol(parts, chatId);
        else if (cmd === '/position')                     await cmdPosition(parts, chatId);
        else if (cmd === '/positions')                    await cmdPositions(chatId);
        else if (cmd === '/close'    && parts[1])         await cmdClose(parts, chatId);
        else if (cmd === '/watch'    && parts[1])         await cmdWatch(parts[1], chatId);
        else if (cmd === '/alert')                        await cmdAlert(parts, chatId);
        else if (cmd === '/myedge')                       await cmdMyEdge(chatId);
        else if (cmd === '/history')                      await cmdHistory(chatId);
        else if (text.charAt(0) !== '/')                  await cmdAI(text, chatId);
        else await tg('Unknown command. Type /help for all commands.', chatId);
      } catch (e) {
        console.error('[CMD]', cmd, e.message);
        await tg('Error on ' + cmd + ': ' + e.message, chatId);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.error('[POLL]', e.message);
  } finally {
    // GUARANTEED reschedule — this NEVER stops
    setTimeout(poll, 500);
  }
}

// ── STARTUP ─────────────────────────────────────────────────────────────────
async function start() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║    MAVERICK INTEL BOT v4.0           ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log('  Telegram token:  ' + (TG_TOKEN   ? 'INTEL_BOT_TOKEN connected' : 'MISSING — set INTEL_BOT_TOKEN'));
  console.log('  Chat ID:         ' + (CHAT_ID    ? 'connected (' + CHAT_ID + ')' : 'MISSING — set INTEL_BOT_CHAT'));
  console.log('  Polygon:         ' + (POLYGON    ? 'connected (real-time snapshot)' : 'MISSING — set POLYGON_KEY'));
  console.log('  Finnhub:         ' + (FINNHUB    ? 'connected (fundamentals)' : 'not set'));
  console.log('  Groq AI:         ' + (GROQ_KEY   ? 'connected (primary brain)' : 'not set'));
  console.log('  Cerebras AI:     ' + (CBRS_KEY   ? 'connected (backup brain)' : 'not set'));
  console.log('  JSONBin memory:  ' + (JSONBIN_ID ? 'configured' : 'not set — trades not persisted'));
  console.log('');

  if (!TG_TOKEN) {
    console.error('[BOT] FATAL: No INTEL_BOT_TOKEN. Bot cannot start.');
    console.error('[BOT] Add INTEL_BOT_TOKEN=your_token to .env file');
    return;
  }
  if (!CHAT_ID) {
    console.error('[BOT] WARNING: No INTEL_BOT_CHAT. Proactive alerts will not send.');
    console.error('[BOT] Add INTEL_BOT_CHAT=your_chat_id to .env file');
    console.error('[BOT] To find your chat ID: message @userinfobot on Telegram');
  }
  if (!POLYGON) {
    console.error('[BOT] WARNING: No POLYGON_KEY. Using Yahoo+Finnhub only (less reliable).');
  }

  await loadMemory();

  await tg(
    '<b>MAVERICK INTEL BOT v4.0 — ONLINE</b>\n\n' +
    'Data: ' + (POLYGON ? 'Polygon LIVE SNAPSHOT ✓' : 'Yahoo+Finnhub (no Polygon)') + '\n' +
    'News: ' + (POLYGON ? 'Polygon News + SEC EDGAR ✓' : 'Finnhub + SEC EDGAR') + '\n' +
    'Brain: ' + (GROQ_KEY ? 'Groq+Cerebras ✓' : CBRS_KEY ? 'Cerebras only' : 'NO AI KEYS') + '\n' +
    'Memory: ' + (JSONBIN_ID ? (memory.trades ? memory.trades.length : 0) + ' trades loaded ✓' : 'not configured') + '\n' +
    'Account: $' + ACCOUNT_SIZE + ' | Max risk/trade: $' + MAX_RISK_DOLLAR + '\n\n' +
    '<b>NEW IN v4.0:</b>\n' +
    '/science TICKER — Maverick Ignition Score\n' +
    '/sdi TICKER — Short Danger Index\n' +
    '/autopsy — 30-day pattern science\n\n' +
    'Type /help for all commands.'
  );

  // Background intervals
  setInterval(monitorPositions,  60000);   // every 60s — position monitoring
  setInterval(checkPriceAlerts,  30000);   // every 30s — price alerts
  setInterval(scanNewsIntel,    120000);   // every 2min — news & catalyst alerts
  setInterval(morningBriefing,  300000);   // every 5min — checks time window internally
  setInterval(pruneHeadlines,  3600000);   // every 1hr — memory cleanup

  poll();
  console.log('[BOT] Running. All intervals active. Alerts will fire proactively.');
}

start();
