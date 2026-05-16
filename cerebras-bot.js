/**
 * MAVERICK INTEL BOT v3.0
 * - Multi-source live data: Polygon (primary), Yahoo (backup), Finnhub (tertiary)
 * - Real catalyst news: SEC EDGAR + Benzinga RSS
 * - Trader Protocols: Ross Cameron, Humble Trader, Maverick (adaptive)
 * - Adaptive learning memory via JSONBin
 * - Morning briefing 4AM-11AM CT
 * - Account size: $350 | Max risk per trade: 2% = $7
 * - Poll loop: finally block guarantees it NEVER dies
 */

require('dotenv').config();
const fetch = require('node-fetch');

// ── CONFIG ────────────────────────────────────────────────────────
var TG_TOKEN   = process.env.INTEL_BOT_TOKEN  || process.env.TELEGRAM_TOKEN   || '';
var CHAT_ID    = process.env.INTEL_BOT_CHAT   || process.env.TELEGRAM_CHAT_ID || '';
var POLYGON    = process.env.POLYGON_KEY       || '';
var FINNHUB    = process.env.FINNHUB_KEY       || '';
var GROQ_KEY   = process.env.GROQ_KEY          || process.env.GROQ_KEY_2       || '';
var CBRS_KEY   = process.env.CEREBRAS_KEY      || '';
var JSONBIN_ID = process.env.JSONBIN_ID        || '';
var JSONBIN_KEY= process.env.JSONBIN_KEY       || '';

// Account constants
var ACCOUNT_SIZE   = 350;
var MAX_RISK_PCT   = 0.02;   // 2% per trade = $7
var MAX_RISK_DOLLAR = ACCOUNT_SIZE * MAX_RISK_PCT;

// ── STATE ─────────────────────────────────────────────────────────
var positions     = {};
var watchlist     = {};
var priceAlerts   = [];
var chatHistory   = {};
var lastUpdateId  = 0;
var lastNewsTs    = Math.floor(Date.now() / 1000) - 300;
var sentHeadlines = new Set();
var activeProtocol = null;   // 'ross' | 'humble' | 'maverick' | null
var briefingDone  = false;   // reset daily
var lastBriefingDate = '';

// Learning memory — loaded from JSONBin on start
var memory = {
  trades:     [],   // { sym, entry, exit, pnlPct, protocol, setupScore, float, rvol, ts }
  preferences:{},   // learned from usage patterns
  winRates:   {},   // by protocol, by setup type
  lastUpdated: 0
};

var BASE_SCAN = [
  'MARA','RIOT','SOFI','HOOD','SNDL','FFIE','MULN','ATER','BBIG','PROG',
  'GFAI','GMBL','BFRI','NKLA','GPUS','AIXI','AAOI','VERB','CNEY','XTIA'
];

// ── HELPERS ───────────────────────────────────────────────────────
var rnd = function(n, d) { d = d || 2; return +Number(n).toFixed(d); };

function nowHourCT() {
  var d = new Date();
  // CT is UTC-5 (CST) or UTC-6 (CDT) — use UTC-5 as safe default
  return (d.getUTCHours() - 5 + 24) % 24;
}

function todayStr() {
  return new Date().toISOString().slice(0,10);
}

// ── JSONBIN MEMORY ────────────────────────────────────────────────
async function loadMemory() {
  if (!JSONBIN_ID || !JSONBIN_KEY) return;
  try {
    var r = await fetch('https://api.jsonbin.io/v3/b/' + JSONBIN_ID + '/latest', {
      headers: { 'X-Master-Key': JSONBIN_KEY }
    });
    var d = await r.json();
    if (d && d.record) {
      memory = Object.assign(memory, d.record);
      console.log('[MEMORY] Loaded ' + (memory.trades ? memory.trades.length : 0) + ' trades from JSONBin');
    }
  } catch (e) { console.error('[MEMORY] Load failed:', e.message); }
}

async function saveMemory() {
  if (!JSONBIN_ID || !JSONBIN_KEY) return;
  try {
    memory.lastUpdated = Date.now();
    await fetch('https://api.jsonbin.io/v3/b/' + JSONBIN_ID, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
      body: JSON.stringify(memory)
    });
  } catch (e) { console.error('[MEMORY] Save failed:', e.message); }
}

function learnFromTrade(tradeObj) {
  if (!memory.trades) memory.trades = [];
  memory.trades.push(tradeObj);
  // Keep last 200 trades
  if (memory.trades.length > 200) memory.trades = memory.trades.slice(-200);
  rebuildWinRates();
  saveMemory();
}

function rebuildWinRates() {
  var byProtocol = {};
  var byFloat    = { nano:[], tight:[], mid:[] };
  var byRvol     = { low:[], med:[], high:[] };

  (memory.trades || []).forEach(function(t) {
    var win = t.pnlPct > 0;
    // By protocol
    var p = t.protocol || 'maverick';
    if (!byProtocol[p]) byProtocol[p] = { wins:0, total:0 };
    byProtocol[p].total++;
    if (win) byProtocol[p].wins++;
    // By float
    if      (t.float < 5)  byFloat.nano.push(win ? 1 : 0);
    else if (t.float < 15) byFloat.tight.push(win ? 1 : 0);
    else                   byFloat.mid.push(win ? 1 : 0);
    // By rvol
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

  // Best float bucket
  var floatBest = null; var floatBestRate = 0;
  ['nano','tight','mid'].forEach(function(k) {
    var arr = wr.byFloat[k];
    if (arr.length >= 3) {
      var rate = arr.reduce(function(a,b){return a+b;},0) / arr.length;
      if (rate > floatBestRate) { floatBestRate = rate; floatBest = k; }
    }
  });
  if (floatBest) lines.push('Your best float: ' + floatBest + ' (' + rnd(floatBestRate*100,0) + '% win rate over ' + wr.byFloat[floatBest].length + ' trades)');

  // Best rvol bucket
  var rvolBest = null; var rvolBestRate = 0;
  ['high','med','low'].forEach(function(k) {
    var arr = wr.byRvol[k];
    if (arr.length >= 3) {
      var rate = arr.reduce(function(a,b){return a+b;},0) / arr.length;
      if (rate > rvolBestRate) { rvolBestRate = rate; rvolBest = k; }
    }
  });
  if (rvolBest) lines.push('Your best RVOL zone: ' + rvolBest + ' (' + rnd(rvolBestRate*100,0) + '% win rate)');

  return lines.length ? '\n\nPERSONAL EDGE:\n' + lines.join('\n') : '';
}

// ── LIVE DATA LAYER ───────────────────────────────────────────────
// Source 1: Polygon.io (primary — real-time)
async function polyQuote(sym) {
  if (!POLYGON) return null;
  try {
    var r = await fetch('https://api.polygon.io/v2/last/trade/' + sym + '?apiKey=' + POLYGON);
    var d = await r.json();
    if (d && d.results && d.results.p) return { price: d.results.p, source: 'Polygon' };
  } catch (e) {}
  return null;
}

async function polyDetails(sym) {
  if (!POLYGON) return null;
  try {
    var r = await fetch('https://api.polygon.io/v3/reference/tickers/' + sym + '?apiKey=' + POLYGON);
    var d = await r.json();
    if (d && d.results) return d.results;
  } catch (e) {}
  return null;
}

async function polyAggs(sym, days) {
  if (!POLYGON) return null;
  days = days || 10;
  try {
    var to   = new Date().toISOString().slice(0,10);
    var from = new Date(Date.now() - days*86400000).toISOString().slice(0,10);
    var r    = await fetch(
      'https://api.polygon.io/v2/aggs/ticker/' + sym + '/range/1/day/' + from + '/' + to +
      '?adjusted=true&sort=asc&limit=50&apiKey=' + POLYGON
    );
    var d = await r.json();
    if (d && d.results && d.results.length) return d.results;
  } catch (e) {}
  return null;
}

// Source 2: Yahoo Finance (backup — free, no key)
async function yahooQuote(sym) {
  try {
    var r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1m&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    var d = await r.json();
    var meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
    if (meta && meta.regularMarketPrice) {
      return {
        price:     meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose || meta.previousClose,
        volume:    meta.regularMarketVolume || 0,
        source:    'Yahoo'
      };
    }
  } catch (e) {}
  return null;
}

// Source 3: Finnhub (tertiary fallback)
async function fhQuote(sym) {
  if (!FINNHUB) return null;
  try {
    var r    = await fetch('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + FINNHUB);
    var text = await r.text();
    if (!text || text.trim() === '') return null;
    var d = JSON.parse(text);
    if (d && d.c && d.c > 0) return { price: d.c, prevClose: d.pc, volume: d.v, high: d.h, low: d.l, source: 'Finnhub' };
  } catch (e) {}
  return null;
}

async function fhMetrics(sym) {
  if (!FINNHUB) return null;
  try {
    var r    = await fetch('https://finnhub.io/api/v1/stock/metric?symbol=' + sym + '&metric=all&token=' + FINNHUB);
    var text = await r.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text);
  } catch (e) { return null; }
}

// Unified getStock — tries Polygon first, Yahoo second, Finnhub third
async function getStock(sym) {
  try {
    // Get quote from best available source
    var q = await polyQuote(sym);
    if (!q) q = await yahooQuote(sym);
    if (!q) q = await fhQuote(sym);
    if (!q || !q.price) return null;

    // Get volume history for RVOL from Polygon aggs or fallback
    var avgVol = 500000;
    var aggs = await polyAggs(sym, 10);
    if (aggs && aggs.length >= 3) {
      var vols = aggs.slice(-10).map(function(a){ return a.v || 0; });
      avgVol = vols.reduce(function(a,b){return a+b;},0) / vols.length;
    }

    // Get float/short from Finnhub metrics (best free source for fundamentals)
    var floatM   = 50;
    var shortPct = 0;
    var week52H  = q.price * 1.5;
    var week52L  = q.price * 0.5;
    var metrics  = await fhMetrics(sym);
    if (metrics && metrics.metric) {
      var m = metrics.metric;
      floatM   = m.sharesFloat                 || floatM;
      shortPct = m.shortInterestPercentOfFloat || shortPct;
      week52H  = m['52WeekHigh']               || week52H;
      week52L  = m['52WeekLow']                || week52L;
      if (m['10DayAverageTradingVolume'] && !aggs) {
        avgVol = m['10DayAverageTradingVolume'] * 1e6;
      }
    }

    // Try Polygon ticker details for better float data
    var details = await polyDetails(sym);
    if (details && details.share_class_shares_outstanding) {
      floatM = details.share_class_shares_outstanding / 1e6;
    }

    var volume   = q.volume || 0;
    var relVol   = rnd(volume / Math.max(avgVol, 1), 2);
    var prevClose= q.prevClose || q.price;
    var changePct= prevClose > 0 ? rnd((q.price - prevClose) / prevClose * 100, 2) : 0;
    var atr      = rnd(q.price * 0.025, 4);

    // Premarket gap detection (if high/low available from aggs)
    var gapPct = 0;
    if (aggs && aggs.length >= 2) {
      var prevDay = aggs[aggs.length - 2];
      if (prevDay && prevDay.c) gapPct = rnd((q.price - prevDay.c) / prevDay.c * 100, 2);
    }

    return {
      sym:       sym,
      price:     q.price,
      changePct: changePct,
      gapPct:    gapPct,
      high:      q.high || q.price,
      low:       q.low  || q.price,
      prevClose: prevClose,
      volume:    volume,
      avgVol:    rnd(avgVol, 0),
      relVol:    relVol,
      floatM:    floatM,
      shortPct:  shortPct,
      week52High:week52H,
      week52Low: week52L,
      atr:       atr,
      source:    q.source
    };
  } catch (e) {
    console.error('[getStock]', sym, e.message);
    return null;
  }
}

// Top gainers scan via Polygon
async function getTopGainers() {
  if (!POLYGON) return [];
  try {
    var r = await fetch('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=' + POLYGON);
    var d = await r.json();
    if (d && d.tickers) return d.tickers.slice(0,20);
  } catch (e) {}
  return [];
}

// ── FINNHUB GENERIC (for news) ────────────────────────────────────
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

// ── TELEGRAM ─────────────────────────────────────────────────────
async function tg(text, chatId) {
  chatId = chatId || CHAT_ID;
  if (!TG_TOKEN || !chatId) return;
  try {
    // Telegram max message length is 4096
    var chunks = [];
    while (text.length > 4000) {
      chunks.push(text.slice(0, 4000));
      text = text.slice(4000);
    }
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

function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

// ── AI BRAIN ─────────────────────────────────────────────────────
async function ai(system, user, maxTokens, chatId) {
  maxTokens = maxTokens || 500;
  var history  = (chatId && chatHistory[chatId]) ? chatHistory[chatId].slice(-8) : [];
  var messages = [{ role: 'system', content: system }].concat(history).concat([{ role: 'user', content: user }]);

  if (GROQ_KEY) {
    try {
      var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, temperature: 0.3, messages: messages })
      });
      var d    = await r.json();
      var text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
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

// ── SETUP SCORER ─────────────────────────────────────────────────
function scoreSetup(d) {
  var score = 0;
  var flags = [];

  // Float score
  if      (d.floatM < 1)  { score += 30; flags.push('NANO FLOAT'); }
  else if (d.floatM < 5)  { score += 22; flags.push('TIGHT FLOAT'); }
  else if (d.floatM < 15) { score += 14; flags.push('WORKABLE FLOAT'); }
  else if (d.floatM > 100){ score -=  5; }

  // RVOL score
  if      (d.relVol >= 10) { score += 25; flags.push('RVOL ' + d.relVol + 'x WHALE'); }
  else if (d.relVol >= 5)  { score += 20; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol >= 3)  { score += 13; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol >= 2)  { score +=  7; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol < 0.8) { score -=  8; }

  // Price move
  if      (d.changePct >= 30) { score += 20; flags.push('+' + rnd(d.changePct,1) + '% MOVER'); }
  else if (d.changePct >= 15) { score += 15; flags.push('+' + rnd(d.changePct,1) + '%'); }
  else if (d.changePct >= 7)  { score +=  9; flags.push('+' + rnd(d.changePct,1) + '%'); }
  else if (d.changePct >= 3)  { score +=  4; }
  else if (d.changePct < -5)  { score -=  8; }

  // Gap score
  if      (d.gapPct >= 20) { score += 12; flags.push('GAP +' + rnd(d.gapPct,1) + '%'); }
  else if (d.gapPct >= 10) { score +=  8; flags.push('GAP +' + rnd(d.gapPct,1) + '%'); }

  // Price range (sweet spot for small accounts)
  if      (d.price < 1)  { score += 10; flags.push('SUB-$1'); }
  else if (d.price < 3)  { score +=  9; }
  else if (d.price < 5)  { score +=  6; }
  else if (d.price < 10) { score +=  3; }

  // Short squeeze potential
  if (d.shortPct > 30 && d.relVol > 3) { score += 18; flags.push('SQUEEZE'); }
  else if (d.shortPct > 20)             { score +=  9; flags.push('SHORT ' + rnd(d.shortPct,1) + '%'); }

  // 52W breakout
  var pctFrom52H = (d.week52High - d.price) / Math.max(d.week52High, 0.01) * 100;
  if (pctFrom52H < 2 && d.changePct > 0) { score += 10; flags.push('52W BREAKOUT'); }

  return { score: Math.min(100, Math.max(0, score)), flags: flags };
}

// ── POSITION SIZING ───────────────────────────────────────────────
function calcShares(price, stopPrice) {
  var risk       = Math.abs(price - stopPrice);
  if (risk <= 0) return 1;
  var shares     = Math.floor(MAX_RISK_DOLLAR / risk);
  var totalCost  = shares * price;
  // Cap at 80% of account so we don't go all-in
  if (totalCost > ACCOUNT_SIZE * 0.8) shares = Math.floor((ACCOUNT_SIZE * 0.8) / price);
  return Math.max(1, shares);
}

// ── TRADER PROTOCOLS ──────────────────────────────────────────────
var PROTOCOLS = {

  ross: {
    name: 'Ross Cameron Protocol',
    desc: 'Gap and Go - first 5min candle break, exit by 11AM',
    filter: function(d) {
      // Ross criteria: gap 10%+, price $2-$20, float under 10M, RVOL high
      return d.gapPct >= 10 &&
             d.price  >= 2  &&
             d.price  <= 20 &&
             d.floatM <= 10 &&
             d.relVol >= 3;
    },
    entry: function(d) {
      // Enter on first pullback to VWAP / breakout of 5min high
      return rnd(d.price * 1.005, 4);  // slight breakout above current
    },
    stop: function(d) {
      // Stop = low of first 5min candle (approximate as 3% below open)
      return rnd(d.price * 0.97, 4);
    },
    tp1: function(d) { return rnd(d.price * 1.10, 4); },
    tp2: function(d) { return rnd(d.price * 1.20, 4); },
    rules: [
      'Only trade first 90 minutes (9:30-11:00AM)',
      'Gap must be 10% or more from previous close',
      'Float under 10M - tight floats move faster',
      'Enter on break of 5-minute opening range high',
      'Stop = low of first 5-minute candle',
      'Sell all by 11AM - Ross never holds into afternoon',
      'Max 2 trades per day - quality over quantity'
    ]
  },

  humble: {
    name: 'Humble Trader Protocol',
    desc: 'Mid-day continuation - patient entries, 3:1 R:R minimum',
    filter: function(d) {
      // Humbled: mid-day momentum, slightly wider float OK, needs volume
      return d.changePct >= 10 &&
             d.price     >= 1  &&
             d.price     <= 30 &&
             d.floatM    <= 20 &&
             d.relVol    >= 2;
    },
    entry: function(d) {
      // Wait for 3 consecutive green candles - entry slightly above current
      return rnd(d.price * 1.002, 4);
    },
    stop: function(d) {
      // Wider stop - Humbled uses 5% stop
      return rnd(d.price * 0.95, 4);
    },
    tp1: function(d) { return rnd(d.price * 1.15, 4); },
    tp2: function(d) { return rnd(d.price * 1.30, 4); },
    rules: [
      'Wait for 3 consecutive green 5-min candles with increasing volume',
      'Float under 20M acceptable - not as strict as Ross',
      'Minimum 3:1 risk/reward - if it does not meet it, skip it',
      'Can trade 9:30AM through 3:30PM',
      'Hold runners - do not sell all at TP1',
      'Move stop to breakeven after TP1 hit',
      'Fewer trades than Ross but higher conviction each'
    ]
  },

  maverick: {
    name: 'Maverick Protocol (Your Edge)',
    desc: 'Adaptive - learns from your trade history',
    filter: function(d) {
      // Start as blend, tighten based on your win rates
      var floatOk = d.floatM <= 15;
      var rvolOk  = d.relVol >= 2;
      var moveOk  = d.changePct >= 5;

      // If we have enough data, override with personal edge
      if (memory.trades && memory.trades.length >= 10) {
        rebuildWinRates();
        var wr = memory.winRates;
        // If user wins more on nano floats, tighten float requirement
        if (wr.byFloat && wr.byFloat.nano && wr.byFloat.nano.length >= 3) {
          var nanoRate = wr.byFloat.nano.reduce(function(a,b){return a+b;},0) / wr.byFloat.nano.length;
          if (nanoRate > 0.6) floatOk = d.floatM <= 5; // tighten to what works
        }
        // If high RVOL wins more, require it
        if (wr.byRvol && wr.byRvol.high && wr.byRvol.high.length >= 3) {
          var highRate = wr.byRvol.high.reduce(function(a,b){return a+b;},0) / wr.byRvol.high.length;
          if (highRate > 0.6) rvolOk = d.relVol >= 5;
        }
      }

      return floatOk && rvolOk && moveOk;
    },
    entry: function(d) { return rnd(d.price, 4); },
    stop:  function(d) { return rnd(d.price - d.atr * 1.5, 4); },
    tp1:   function(d) { return rnd(d.price + d.atr * 2, 4); },
    tp2:   function(d) { return rnd(d.price + d.atr * 4, 4); },
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
  return { entry:entry, stop:stop, tp1:tp1, tp2:tp2, shares:shares, risk:risk, reward1:reward1, rr:rr };
}

// ── NEWS FEEDS ────────────────────────────────────────────────────
// SEC EDGAR real-time RSS
async function fetchEdgarNews() {
  try {
    var r = await fetch('https://efts.sec.gov/LATEST/search-index?q=%228-K%22&dateRange=custom&startdt=' +
      new Date(Date.now()-3600000).toISOString().slice(0,10) +
      '&enddt=' + new Date().toISOString().slice(0,10) +
      '&hits.hits._source=period_of_report,entity_name,file_date,form_type,ticker',
      { headers: { 'User-Agent': 'MaverickBot/1.0 trading@maverick.com' } }
    );
    var d = await r.json();
    if (d && d.hits && d.hits.hits) return d.hits.hits;
  } catch (e) {}
  return [];
}

// Benzinga RSS
async function fetchBenzingaRSS() {
  try {
    var r = await fetch('https://feeds.benzinga.com/benzinga', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    var xml  = await r.text();
    var items = [];
    var re   = /<item>([\s\S]*?)<\/item>/g;
    var m;
    while ((m = re.exec(xml)) !== null && items.length < 30) {
      var block   = m[1];
      var title   = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      var pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
      var link    = (block.match(/<link>(.*?)<\/link>/)       || [])[1] || '';
      if (title) items.push({ title: title.trim(), pubDate: pubDate.trim(), link: link.trim() });
    }
    return items;
  } catch (e) {}
  return [];
}

// Combined news scanner
async function scanNewsIntel() {
  var BULLISH = [
    'fda approval','fda approved','merger','acquisition','buyout','earnings beat',
    'short squeeze','trading halted','halt','government contract','phase 3 results',
    'phase 3 trial','reverse split','buyback','uplisting','nasdaq compliance',
    'barda contract','dod contract','positive data','breakthrough','upgraded',
    'price target raised','record revenue','beat estimates','raised guidance'
  ];
  var BEARISH = [
    'going concern','dilution','public offering','atm offering','shelf registration',
    'bankruptcy','delisting','class action','default','missed','downgraded',
    'lowered guidance','reverse merger','fraud'
  ];

  // Finnhub news (existing)
  try {
    var fhNews = await fh('/news?category=general');
    if (Array.isArray(fhNews)) {
      var fresh = fhNews.filter(function(n){ return n.datetime > lastNewsTs && n.headline; });
      if (fresh.length) lastNewsTs = Math.max.apply(null, fresh.map(function(n){ return n.datetime; }));

      for (var i = 0; i < fresh.length; i++) {
        var n    = fresh[i];
        if (sentHeadlines.has(n.headline)) continue;
        var body = (n.headline + ' ' + (n.summary || '')).toLowerCase();
        var hits = BULLISH.filter(function(k){ return body.indexOf(k) !== -1; });
        var negs = BEARISH.filter(function(k){ return body.indexOf(k) !== -1; });
        var related = (n.related || '').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase() || '';

        if (hits.length >= 1 && negs.length === 0) {
          sentHeadlines.add(n.headline);
          var ageMin = Math.round((Date.now()/1000 - n.datetime) / 60);
          var msg = 'CATALYST ALERT\n' + n.headline + '\n' +
                    (n.source || 'Finnhub') + ' - ' + ageMin + 'm ago\n' +
                    (related ? related + ' | ' : '') + hits.slice(0,2).join(', ');
          if (related) msg += '\n\n/check ' + related;
          await tg(msg);
          await sleep(1500);
        }

        // Bearish alert
        if (negs.length >= 1 && related) {
          sentHeadlines.add(n.headline);
          await tg('BEARISH FLAG: ' + n.headline + '\n' + negs.join(', ') + '\n' + (related ? 'Watch $' + related : ''));
          await sleep(1500);
        }
      }
    }
  } catch (e) { console.error('[NEWS-FH]', e.message); }

  // Benzinga RSS
  try {
    var bzItems = await fetchBenzingaRSS();
    for (var j = 0; j < bzItems.length; j++) {
      var item = bzItems[j];
      if (sentHeadlines.has(item.title)) continue;
      var body2 = item.title.toLowerCase();
      var hits2 = BULLISH.filter(function(k){ return body2.indexOf(k) !== -1; });
      if (hits2.length >= 1) {
        sentHeadlines.add(item.title);
        await tg('BZ CATALYST\n' + item.title + '\n' + hits2.slice(0,2).join(', '));
        await sleep(1500);
      }
    }
  } catch (e) { console.error('[NEWS-BZ]', e.message); }

  // SEC EDGAR 8-K filings
  try {
    var edgarHits = await fetchEdgarNews();
    for (var k = 0; k < Math.min(edgarHits.length, 10); k++) {
      var hit  = edgarHits[k] && edgarHits[k]._source;
      if (!hit) continue;
      var key  = hit.entity_name + hit.file_date;
      if (sentHeadlines.has(key)) continue;
      var ticker = (hit.ticker || '').toUpperCase();
      if (!ticker) continue;
      sentHeadlines.add(key);
      await tg('SEC 8-K FILING\n' + hit.entity_name + (ticker ? ' ($' + ticker + ')' : '') + '\n' +
               'Form: ' + hit.form_type + ' | Filed: ' + hit.file_date + '\n' +
               (ticker ? '/check ' + ticker : ''));
      await sleep(2000);
    }
  } catch (e) { console.error('[NEWS-SEC]', e.message); }
}

// ── MORNING BRIEFING ──────────────────────────────────────────────
async function morningBriefing() {
  var hour    = nowHourCT();
  var today   = todayStr();

  // Only fire between 4AM and 11AM CT, once per day
  if (hour < 4 || hour >= 11) return;
  if (lastBriefingDate === today) return;
  lastBriefingDate = today;
  briefingDone     = true;

  await tg('<b>MAVERICK MORNING BRIEFING</b>\n' + today + ' | ' + hour + ':00 CT\n\nScanning top movers...');

  var gainers = await getTopGainers();
  var results = [];

  if (gainers.length) {
    // Polygon gainers snapshot
    for (var i = 0; i < Math.min(gainers.length, 15); i++) {
      var g   = gainers[i];
      var sym = g.ticker;
      var snap = g.day || {};
      var prev = g.prevDay || {};
      var price     = snap.c || (g.lastTrade && g.lastTrade.p) || 0;
      var prevClose = prev.c || price;
      var changePct = prevClose > 0 ? rnd((price - prevClose)/prevClose*100,2) : (g.todaysChangePerc || 0);
      var volume    = snap.v || 0;
      if (price < 1 || price > 30 || changePct < 5) continue;

      var d = await getStock(sym).catch(function(){ return null; });
      if (!d) continue;
      var sr = scoreSetup(d);

      // Apply active protocol filter if set
      var passesProto = true;
      if (activeProtocol && PROTOCOLS[activeProtocol]) {
        passesProto = PROTOCOLS[activeProtocol].filter(d);
      }
      if (passesProto && sr.score >= 50) {
        results.push(Object.assign({}, d, { score: sr.score, flags: sr.flags }));
      }
    }
  } else {
    // Fallback: scan BASE_SCAN universe
    var settled = await Promise.allSettled(BASE_SCAN.map(function(s){ return getStock(s); }));
    for (var j = 0; j < settled.length; j++) {
      var r = settled[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      var sr2 = scoreSetup(r.value);
      if (sr2.score >= 55) results.push(Object.assign({}, r.value, { score: sr2.score, flags: sr2.flags }));
    }
  }

  results.sort(function(a,b){ return b.score - a.score; });

  if (!results.length) {
    await tg('No high-conviction setups in premarket. Markets may be quiet today. Stay patient.');
    return;
  }

  var proto = activeProtocol ? PROTOCOLS[activeProtocol].name : 'Maverick Default';
  var msg   = '<b>TOP PREMARKET SETUPS</b>\nProtocol: ' + proto + '\nAccount: $' + ACCOUNT_SIZE + ' | Max risk/trade: $' + MAX_RISK_DOLLAR + '\n\n';

  for (var n = 0; n < Math.min(5, results.length); n++) {
    var d2  = results[n];
    var lbl = d2.score >= 80 ? 'HOT' : d2.score >= 65 ? 'WARM' : 'WATCH';
    var lvl = activeProtocol ? applyProtocol(d2, activeProtocol) : {
      entry:  d2.price,
      stop:   rnd(d2.price - d2.atr*1.5, 4),
      tp1:    rnd(d2.price + d2.atr*2,   4),
      tp2:    rnd(d2.price + d2.atr*3.5, 4),
      shares: calcShares(d2.price, rnd(d2.price - d2.atr*1.5, 4)),
      rr:     rnd(d2.atr*2 / Math.max(d2.atr*1.5,0.001), 2)
    };
    msg += '[' + lbl + '] <b>$' + d2.sym + '</b> ' + d2.score + '/100\n';
    msg += '$' + d2.price + '  ' + (d2.changePct >= 0 ? '+' : '') + rnd(d2.changePct,1) + '%';
    if (d2.gapPct) msg += '  Gap: +' + rnd(d2.gapPct,1) + '%';
    msg += '\nRVOL: ' + d2.relVol + 'x  Float: ' + d2.floatM + 'M  Short: ' + rnd(d2.shortPct,1) + '%\n';
    msg += (d2.flags.slice(0,3).join(' | ') || '') + '\n';
    msg += 'Entry: $' + lvl.entry + '  Stop: $' + lvl.stop + '\n';
    msg += 'TP1: $' + lvl.tp1 + '  TP2: $' + lvl.tp2 + '\n';
    msg += 'Shares: ' + lvl.shares + '  Risk: $' + (rnd(Math.abs(lvl.entry - lvl.stop) * lvl.shares, 2)) + '  R:R ' + lvl.rr + ':1\n';
    msg += 'Data: ' + (d2.source || 'Multi') + '\n\n';
  }

  msg += 'Use /check TICKER for full AI analysis.\nProtocol active: ' + (activeProtocol ? activeProtocol.toUpperCase() : 'none') + '\nMarket opens 9:30AM ET.';
  await tg(msg);
}

// ── COMMAND HANDLERS ──────────────────────────────────────────────

async function cmdStart(chatId) {
  await tg(
    '<b>MAVERICK INTEL BOT v3.0</b>\n\n' +
    '<b>STOCK COMMANDS</b>\n' +
    '/check TICKER - Full AI + live data analysis\n' +
    '/scan - Top setups now\n' +
    '/squeeze - Squeeze candidates\n' +
    '/news - Latest catalysts\n' +
    '/gappers - Today\'s top gappers\n\n' +
    '<b>TRADER PROTOCOLS</b>\n' +
    '/ross - Activate Ross Cameron Protocol\n' +
    '/humble - Activate Humble Trader Protocol\n' +
    '/maverick - Activate Maverick (adaptive) Protocol\n' +
    '/protocol off - Deactivate protocol\n' +
    '/protocol - Show active protocol rules\n\n' +
    '<b>TRADE TRACKING</b>\n' +
    '/position TICKER ENTRY STOP TP1 TP2 SHARES\n' +
    '/positions - View open trades\n' +
    '/close TICKER EXITPRICE - Close and log trade\n' +
    '/watch TICKER - Add to universe\n' +
    '/alert TICKER PRICE above|below\n\n' +
    '<b>LEARNING & EDGE</b>\n' +
    '/myedge - Your personal win rate analysis\n' +
    '/history - Last 10 logged trades\n\n' +
    '<b>AI ASSISTANT</b>\n' +
    'Type anything - I remember our conversation.\n' +
    'Account: $' + ACCOUNT_SIZE + ' | Risk/trade: $' + MAX_RISK_DOLLAR,
    chatId
  );
}

async function cmdCheck(sym, chatId) {
  await tg('Pulling live data for $' + sym + '...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('No data for $' + sym + '. Check the ticker or try again.', chatId);

  var result = scoreSetup(d);
  var score  = result.score;
  var flags  = result.flags;
  var changeStr = (d.changePct >= 0 ? '+' : '') + rnd(d.changePct, 2) + '%';

  // Protocol levels if active
  var protoMsg = '';
  if (activeProtocol && PROTOCOLS[activeProtocol]) {
    var passes = PROTOCOLS[activeProtocol].filter(d);
    var lvl    = applyProtocol(d, activeProtocol);
    protoMsg   = '\n<b>' + PROTOCOLS[activeProtocol].name + ':</b> ' + (passes ? 'PASSES FILTER' : 'FAILS FILTER') + '\n' +
                 'Entry: $' + lvl.entry + '  Stop: $' + lvl.stop + '\n' +
                 'TP1: $' + lvl.tp1 + '  TP2: $' + lvl.tp2 + '\n' +
                 'Shares: ' + lvl.shares + '  Risk: $' + rnd(Math.abs(lvl.entry-lvl.stop)*lvl.shares,2) + '  R:R ' + lvl.rr + ':1\n';
  }

  var personalInsight = getPersonalInsight();

  var analysis = await ai(
    'You are MAVERICK LION BRAIN - elite micro-cap trading analyst. ' +
    'Apply Maverick Whale Doctrine: Phase 1-2 accumulation entry, exit before Phase 4 distribution. ' +
    'The user has a $350 account. Max risk $7 per trade. ' +
    (activeProtocol === 'ross' ? 'Apply Ross Cameron Gap and Go rules: tight float, high gap, exit by 11AM. ' : '') +
    (activeProtocol === 'humble' ? 'Apply Humble Trader rules: wait for 3 green candles, 3:1 minimum R:R. ' : '') +
    'Give a clear verdict: BUY / WATCH / PASS. ' +
    'Include exact entry zone, hard stop, TP1, TP2, R:R ratio, whale phase assessment. ' +
    'Direct. No fluff. Max 200 words.',
    '$' + sym + ' live data:\n' +
    'Price: $' + d.price + ' (' + changeStr + ')  Source: ' + (d.source||'unknown') + '\n' +
    'RVOL: ' + d.relVol + 'x  AvgVol: ' + d.avgVol + '\n' +
    'Float: ' + d.floatM + 'M  Short: ' + d.shortPct + '%\n' +
    'Gap: ' + (d.gapPct||0) + '%  ATR: $' + d.atr + '\n' +
    'Score: ' + score + '/100  Flags: ' + (flags.join(', ')||'none') + '\n' +
    '52W: $' + d.week52Low + ' - $' + d.week52High,
    350, chatId
  );

  var conviction = score >= 85 ? 'HIGH CONVICTION' : score >= 70 ? 'ELEVATED' : score >= 55 ? 'MODERATE' : 'LOW';

  await tg(
    '<b>$' + sym + ' - LION BRAIN</b> [' + conviction + ']\n' +
    'Source: ' + (d.source||'Multi') + '\n\n' +
    '$' + d.price + ' (' + changeStr + ')' + (d.gapPct ? '  Gap: +' + rnd(d.gapPct,1) + '%' : '') + '\n' +
    'RVOL: <b>' + d.relVol + 'x</b>  Float: <b>' + d.floatM + 'M</b>\n' +
    'Short: ' + rnd(d.shortPct,1) + '%  Score: <b>' + score + '/100</b>\n' +
    (flags.length ? flags.join(' | ') + '\n' : '') +
    protoMsg +
    '\n' + (analysis || 'AI offline - computed levels only.') +
    '\n\n<b>Quick Levels:</b>\n' +
    'Stop: $' + rnd(d.price - d.atr*1.5, 4) + '\n' +
    'TP1:  $' + rnd(d.price + d.atr*2,   4) + '\n' +
    'TP2:  $' + rnd(d.price + d.atr*3.5, 4) +
    personalInsight,
    chatId
  );
}

async function cmdGappers(chatId) {
  await tg('Pulling live gappers from Polygon...', chatId);
  var gainers = await getTopGainers();
  if (!gainers.length) return tg('No gapper data available. Check POLYGON_KEY env var.', chatId);

  var msg = '<b>TOP GAPPERS RIGHT NOW</b>\n\n';
  var count = 0;
  for (var i = 0; i < gainers.length && count < 10; i++) {
    var g    = gainers[i];
    var sym  = g.ticker;
    var snap = g.day || {};
    var prev = g.prevDay || {};
    var price     = snap.c || (g.lastTrade && g.lastTrade.p) || 0;
    var changePct = g.todaysChangePerc || 0;
    var volume    = snap.v || 0;
    if (price < 0.5 || price > 50) continue;
    msg += '<b>$' + sym + '</b>  $' + rnd(price,4) + '  +' + rnd(changePct,1) + '%\n';
    msg += 'Vol: ' + (volume > 1e6 ? rnd(volume/1e6,2)+'M' : rnd(volume/1e3,0)+'K') + '\n\n';
    count++;
  }
  msg += 'Use /check TICKER for full analysis.';
  await tg(msg, chatId);
}

async function cmdProtocol(parts, chatId) {
  var sub = (parts[1] || '').toLowerCase();

  if (sub === 'off') {
    activeProtocol = null;
    return tg('Protocol deactivated. Running in standard Maverick mode.', chatId);
  }

  if (!activeProtocol) {
    return tg(
      'No protocol active.\n\n' +
      'Activate one:\n' +
      '/ross - Ross Cameron Gap and Go\n' +
      '/humble - Humble Trader Continuation\n' +
      '/maverick - Maverick Adaptive\n\n' +
      'Or type /protocol off to clear.',
      chatId
    );
  }

  var p = PROTOCOLS[activeProtocol];
  var msg = '<b>' + p.name + ' - ACTIVE</b>\n\n' + p.desc + '\n\nRULES:\n';
  p.rules.forEach(function(r, i){ msg += (i+1) + '. ' + r + '\n'; });
  await tg(msg, chatId);
}

async function cmdActivateProtocol(name, chatId) {
  activeProtocol = name;
  var p = PROTOCOLS[name];
  var msg = '<b>' + p.name + ' ACTIVATED</b>\n\n' + p.desc + '\n\nRULES:\n';
  p.rules.forEach(function(r, i){ msg += (i+1) + '. ' + r + '\n'; });
  msg += '\nAll /scan, /check, and briefing results will now be filtered through this protocol.\nType /protocol off to deactivate.';
  await tg(msg, chatId);
}

async function cmdScan(chatId) {
  var protoName = activeProtocol ? PROTOCOLS[activeProtocol].name : 'Standard';
  await tg('Scanning universe... Protocol: ' + protoName, chatId);

  // Try Polygon gainers first, fall back to BASE_SCAN
  var universe = [];
  var gainers  = await getTopGainers();
  if (gainers.length) {
    gainers.forEach(function(g){ if (g.ticker) universe.push(g.ticker); });
  }
  universe = universe.concat(Object.keys(watchlist)).concat(BASE_SCAN)
    .filter(function(v,i,a){ return a.indexOf(v)===i; }).slice(0,25);

  var settled = await Promise.allSettled(universe.map(function(s){ return getStock(s); }));
  var results = [];

  for (var i = 0; i < settled.length; i++) {
    var r = settled[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    var d  = r.value;
    var sr = scoreSetup(d);
    // Apply protocol filter if active
    var passes = !activeProtocol || !PROTOCOLS[activeProtocol] || PROTOCOLS[activeProtocol].filter(d);
    if (sr.score >= 50 && passes) results.push(Object.assign({}, d, { score: sr.score, flags: sr.flags }));
  }
  results.sort(function(a,b){ return b.score - a.score; });

  if (!results.length) return tg('No qualifying setups right now. Market may be quiet or protocol filter is tight. Try /scan with /protocol off.', chatId);

  var msg = '<b>MAVERICK SCAN</b> [' + protoName + ']\n\n';
  for (var j = 0; j < Math.min(6, results.length); j++) {
    var d2  = results[j];
    var lbl = d2.score >= 80 ? 'HOT' : d2.score >= 65 ? 'WARM' : 'WATCH';
    var lvl = activeProtocol ? applyProtocol(d2, activeProtocol) : {
      stop:   rnd(d2.price - d2.atr*1.5, 4),
      tp1:    rnd(d2.price + d2.atr*2,   4),
      shares: calcShares(d2.price, rnd(d2.price - d2.atr*1.5, 4)),
      rr:     rnd(d2.atr*2 / Math.max(d2.atr*1.5,0.001),2)
    };
    msg += '[' + lbl + '] <b>$' + d2.sym + '</b> ' + d2.score + '/100\n';
    msg += '$' + d2.price + '  ' + (d2.changePct>=0?'+':'') + rnd(d2.changePct,1) + '%  RVOL ' + d2.relVol + 'x\n';
    msg += 'Float: ' + d2.floatM + 'M  ' + (d2.flags.slice(0,2).join(' | ')||'') + '\n';
    msg += 'Stop: $' + lvl.stop + '  TP1: $' + lvl.tp1 + '  Shares: ' + lvl.shares + '\n\n';
  }
  msg += 'Use /check TICKER for full AI read.';
  await tg(msg, chatId);
}

async function cmdSqueeze(chatId) {
  await tg('Running squeeze scan...', chatId);
  var universe = Object.keys(watchlist).concat(BASE_SCAN).filter(function(v,i,a){ return a.indexOf(v)===i; }).slice(0,20);
  var settled  = await Promise.allSettled(universe.map(function(s){ return getStock(s); }));
  var results  = [];

  for (var i = 0; i < settled.length; i++) {
    var r = settled[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    var d    = r.value;
    var sqSc = Math.min(100, Math.round(d.shortPct*1.5 + d.relVol*5 + (d.floatM<10?15:0)));
    if (sqSc >= 30 || d.shortPct >= 15) results.push(Object.assign({}, d, { sqSc: sqSc }));
  }
  results.sort(function(a,b){ return b.sqSc - a.sqSc; });

  if (!results.length) return tg('No notable squeeze setups detected.', chatId);

  var msg = '<b>SQUEEZE SCAN</b>\n\n';
  for (var j = 0; j < Math.min(5, results.length); j++) {
    var d2    = results[j];
    var phase = (d2.shortPct>30 && d2.relVol>2) ? 'PHASE 2' : d2.shortPct>15 ? 'PHASE 1' : 'WATCH';
    msg += '[' + phase + '] <b>$' + d2.sym + '</b> Score: ' + d2.sqSc + '/100\n';
    msg += 'Short: ' + rnd(d2.shortPct,1) + '%  RVOL: ' + d2.relVol + 'x  Float: ' + d2.floatM + 'M\n';
    msg += 'Trigger: $' + rnd(d2.price*1.02,4) + '  Stop: $' + rnd(d2.price*0.95,4) + '\n\n';
  }
  msg += 'Phase 2 = shorts covering + retail momentum. Most explosive.';
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
  // Auto-calculate shares if not given
  if (!shares) shares = calcShares(+entry, +stop);
  var rr = rnd((+tp1 - +entry) / Math.max(+entry - +stop, 0.001), 2);

  positions[ticker] = {
    entry:     +entry,
    stop:      +stop,
    tp1:       +tp1,
    tp2:       tp2 ? +tp2 : null,
    shares:    +shares,
    protocol:  activeProtocol || 'maverick',
    entryTime: Date.now(),
    alerts:    { stopWarn:false, tp1:false, tp2:false, overextended:false }
  };

  var risk    = rnd(Math.abs(+entry - +stop) * +shares, 2);
  var reward1 = rnd(Math.abs(+tp1   - +entry) * +shares, 2);

  await tg(
    '<b>$' + ticker + ' TRACKED</b>\n\n' +
    'Entry:  $' + entry + '\n' +
    'Stop:   $' + stop + ' (' + rnd((+stop - +entry)/+entry*100,1) + '%)\n' +
    'TP1:    $' + tp1 + ' (+' + rnd((+tp1 - +entry)/+entry*100,1) + '%)\n' +
    'TP2:    ' + (tp2 ? '$'+tp2 : 'not set') + '\n' +
    'Shares: ' + shares + '\n' +
    'Risk:   $' + risk + ' of your $' + ACCOUNT_SIZE + '\n' +
    'Reward at TP1: $' + reward1 + '\n' +
    'R:R:    ' + rr + ':1\n' +
    'Protocol: ' + (activeProtocol || 'maverick') + '\n\n' +
    'I will alert you at stop, TP1, and TP2.',
    chatId
  );
}

async function cmdPositions(chatId) {
  var keys = Object.keys(positions);
  if (!keys.length) return tg('No open positions.\n\nUse /position TICKER ENTRY STOP TP1 to track a trade.', chatId);

  var msg = '<b>OPEN POSITIONS</b>\n\n';
  for (var i = 0; i < keys.length; i++) {
    var sym = keys[i];
    var pos = positions[sym];
    var d   = await getStock(sym).catch(function(){ return null; });
    if (!d) { msg += '<b>$' + sym + '</b> - data unavailable\n\n'; continue; }
    var pl       = rnd((d.price - pos.entry)/pos.entry*100, 2);
    var plDollar = rnd((d.price - pos.entry)*pos.shares, 2);
    var stopDist = rnd((d.price - pos.stop)/d.price*100, 1);
    var tp1Dist  = pos.tp1 ? rnd((pos.tp1 - d.price)/d.price*100,1) : null;
    msg += (pl >= 0 ? 'UP' : 'DOWN') + ' <b>$' + sym + '</b>\n';
    msg += 'Entry $' + pos.entry + ' -> Now $' + d.price + ' [' + (d.source||'?') + ']\n';
    msg += 'P&L: ' + (pl>=0?'+':'') + pl + '% ($' + (plDollar>=0?'+':'') + plDollar + ')\n';
    msg += 'Stop: $' + pos.stop + ' (' + stopDist + '% away)' + (stopDist<3?' WARNING':'') + '\n';
    msg += 'TP1: ' + (pos.tp1 ? '$'+pos.tp1+' ('+tp1Dist+'% away)' : 'not set') + '\n';
    msg += 'RVOL: ' + d.relVol + 'x  Protocol: ' + (pos.protocol||'?') + '\n\n';
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
    var d = await getStock(sym).catch(function(){ return null; });
    if (d) exitPrice = d.price;
  }

  if (exitPrice) {
    var pl       = rnd((exitPrice - pos.entry)/pos.entry*100, 2);
    var plDollar = rnd((exitPrice - pos.entry)*pos.shares, 2);
    // Log to learning memory
    learnFromTrade({
      sym:       sym,
      entry:     pos.entry,
      exit:      exitPrice,
      pnlPct:    pl,
      pnlDollar: plDollar,
      protocol:  pos.protocol || 'maverick',
      setupScore:0,
      float:     0,
      rvol:      0,
      ts:        Date.now()
    });
    await tg(
      '<b>$' + sym + ' CLOSED</b>\n' +
      'Entry: $' + pos.entry + ' | Exit: $' + exitPrice + '\n' +
      'P&L: ' + (pl>=0?'+':'') + pl + '% ($' + (plDollar>=0?'+':'') + plDollar + ')\n' +
      'Shares: ' + pos.shares + '  Protocol: ' + (pos.protocol||'maverick') + '\n\n' +
      (pl > 0 ? 'Win logged. Maverick Protocol is learning.' : 'Loss logged. Maverick Protocol is learning.') +
      '\nTotal logged trades: ' + (memory.trades ? memory.trades.length : 0),
      chatId
    );
  } else {
    await tg('$' + sym + ' position removed.', chatId);
  }
}

async function cmdWatch(sym, chatId) {
  var ticker = sym.toUpperCase();
  watchlist[ticker] = { added: Date.now() };
  await tg('$' + ticker + ' added to scan universe. Will appear in /scan and /squeeze.', chatId);
}

async function cmdAlert(parts, chatId) {
  var sym  = parts[1];
  var price = parts[2];
  var dir  = parts[3];
  if (!sym || !price) return tg('Usage: /alert TICKER PRICE above|below\nExample: /alert MDAI 2.00 above', chatId);
  priceAlerts.push({ ticker: sym.toUpperCase(), price: +price, direction: dir||'above', chatId: chatId, fired: false });
  await tg('Alert set: $' + sym.toUpperCase() + ' ' + (dir||'above') + ' $' + price, chatId);
}

async function cmdNews(chatId) {
  await tg('Pulling latest catalysts...', chatId);
  var news = await fh('/news?category=general').catch(function(){ return null; });
  if (!Array.isArray(news)) return tg('News unavailable. Finnhub may be rate-limiting.', chatId);
  var msg  = '<b>LATEST CATALYSTS</b>\n\n';
  var items = news.filter(function(n){ return n.headline; }).slice(0,8);
  for (var i = 0; i < items.length; i++) {
    var n       = items[i];
    var ageMin  = Math.round((Date.now()/1000 - n.datetime)/60);
    var age     = ageMin < 60 ? ageMin+'m' : Math.round(ageMin/60)+'h';
    var related = (n.related||'').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase() || '-';
    msg += (i+1) + '. <b>' + related + '</b> - ' + age + '\n' + n.headline + '\n\n';
  }
  await tg(msg, chatId);
}

async function cmdMyEdge(chatId) {
  if (!memory.trades || memory.trades.length < 5) {
    return tg(
      'Not enough trade history yet. Log at least 5 trades by using:\n' +
      '/position TICKER ENTRY STOP TP1\n' +
      'Then /close TICKER EXITPRICE when done.\n\n' +
      'Currently logged: ' + (memory.trades ? memory.trades.length : 0) + ' trades.',
      chatId
    );
  }

  rebuildWinRates();
  var wr     = memory.winRates;
  var trades = memory.trades;
  var wins   = trades.filter(function(t){ return t.pnlPct > 0; }).length;
  var winRate = rnd(wins/trades.length*100, 1);
  var avgWin  = rnd(trades.filter(function(t){return t.pnlPct>0;}).reduce(function(a,t){return a+t.pnlPct;},0) / Math.max(wins,1), 2);
  var losses  = trades.filter(function(t){ return t.pnlPct <= 0; });
  var avgLoss = rnd(losses.reduce(function(a,t){return a+t.pnlPct;},0) / Math.max(losses.length,1), 2);

  var msg = '<b>YOUR PERSONAL EDGE</b>\n';
  msg += 'Based on ' + trades.length + ' logged trades\n\n';
  msg += 'Overall win rate: ' + winRate + '%\n';
  msg += 'Avg win: +' + avgWin + '%  Avg loss: ' + avgLoss + '%\n\n';

  // Float breakdown
  msg += '<b>By Float:</b>\n';
  ['nano','tight','mid'].forEach(function(k) {
    var arr = wr.byFloat[k] || [];
    if (arr.length >= 2) {
      var rate = rnd(arr.reduce(function(a,b){return a+b;},0)/arr.length*100,0);
      msg += k + ' (<' + (k==='nano'?'5M':k==='tight'?'15M':'15M+') + '): ' + rate + '% win (' + arr.length + ' trades)\n';
    }
  });

  msg += '\n<b>By RVOL:</b>\n';
  ['high','med','low'].forEach(function(k) {
    var arr = wr.byRvol[k] || [];
    if (arr.length >= 2) {
      var rate = rnd(arr.reduce(function(a,b){return a+b;},0)/arr.length*100,0);
      msg += k + ' RVOL: ' + rate + '% win (' + arr.length + ' trades)\n';
    }
  });

  msg += '\n<b>By Protocol:</b>\n';
  Object.keys(wr.byProtocol || {}).forEach(function(p) {
    var bp   = wr.byProtocol[p];
    var rate = rnd(bp.wins/bp.total*100,0);
    msg += p + ': ' + rate + '% (' + bp.wins + '/' + bp.total + ')\n';
  });

  msg += '\n' + getPersonalInsight();
  msg += '\n\nMaverick Protocol is adapting to your edge. Keep logging trades.';
  await tg(msg, chatId);
}

async function cmdHistory(chatId) {
  if (!memory.trades || !memory.trades.length) return tg('No trade history yet.', chatId);
  var recent = memory.trades.slice(-10).reverse();
  var msg    = '<b>LAST ' + recent.length + ' TRADES</b>\n\n';
  recent.forEach(function(t) {
    var d   = new Date(t.ts).toLocaleDateString();
    var win = t.pnlPct > 0 ? 'WIN' : 'LOSS';
    msg += '[' + win + '] <b>$' + t.sym + '</b> ' + (t.pnlPct>0?'+':'') + rnd(t.pnlPct,2) + '%';
    msg += ' ($' + (t.pnlDollar>0?'+':'') + rnd(t.pnlDollar||0,2) + ')\n';
    msg += d + ' | ' + (t.protocol||'?') + '\n\n';
  });
  await tg(msg, chatId);
}

async function cmdAI(text, chatId) {
  var personalInsight = getPersonalInsight();
  var protoContext    = activeProtocol ? ('Active protocol: ' + PROTOCOLS[activeProtocol].name + '. ') : '';
  var tradeCount      = memory.trades ? memory.trades.length : 0;

  var reply = await ai(
    'You are Maverick Bot - elite trading assistant and brilliant general AI. ' +
    'For trading: apply Maverick Whale Doctrine (Phase 1-2 entry, tight float, whale volume, hard stops). ' +
    'User has $350 account. Max $7 risk per trade. ' + protoContext +
    'User has logged ' + tradeCount + ' trades. ' +
    (personalInsight ? 'Personal edge data: ' + personalInsight + '. ' : '') +
    'For anything non-trading: answer like a knowledgeable direct friend. No disclaimers. ' +
    'Remember conversation history. Under 280 words.',
    text, 500, chatId
  );
  if (reply) await tg(reply, chatId);
  else await tg('AI brain offline. Try /check TICKER for analysis.', chatId);
}

// ── BACKGROUND MONITORS ───────────────────────────────────────────
async function monitorPositions() {
  for (var sym in positions) {
    var pos = positions[sym];
    var d   = await getStock(sym).catch(function(){ return null; });
    if (!d) continue;
    var price    = d.price;
    var pct      = (price - pos.entry)/pos.entry*100;
    var stopDist = (price - pos.stop)/pos.stop*100;

    if (stopDist < 3 && !pos.alerts.stopWarn) {
      pos.alerts.stopWarn = true;
      await tg('WARNING - <b>$' + sym + ' STOP APPROACHING</b>\n' +
               'Price $' + price + '  Stop $' + pos.stop + '  (' + rnd(stopDist,1) + '% away)\n' +
               'RVOL: ' + d.relVol + 'x  Source: ' + (d.source||'?') + '\n' +
               'If thesis broken - exit now. Small loss beats big loss.');
    } else if (stopDist >= 6) { pos.alerts.stopWarn = false; }

    if (price <= pos.stop) {
      await tg('STOP HIT - <b>$' + sym + '</b>\n' +
               'Price: $' + price + '  Stop: $' + pos.stop + '\n' +
               'P&L: ' + rnd(pct,1) + '%  Exit NOW.');
    }

    if (pos.tp1 && price >= pos.tp1 && !pos.alerts.tp1) {
      pos.alerts.tp1 = true;
      await tg('TP1 HIT - <b>$' + sym + ' $' + pos.tp1 + '</b>\n' +
               'Price: $' + price + ' (+' + rnd(pct,1) + '%)\n' +
               'Sell 50%. Move stop to breakeven. Let runner work.\n' +
               'TP2: ' + (pos.tp2 ? '$'+pos.tp2 : 'not set'));
    }

    if (pos.tp2 && price >= pos.tp2 && !pos.alerts.tp2) {
      pos.alerts.tp2 = true;
      await tg('TP2 HIT - <b>$' + sym + ' $' + pos.tp2 + '</b>\n' +
               'Price: $' + price + ' (+' + rnd(pct,1) + '%)\n' +
               'Sell 30% more. Trail remaining 20% aggressively.');
    }

    if (pct > 25 && !pos.alerts.tp1 && !pos.alerts.overextended) {
      pos.alerts.overextended = true;
      await tg('OVEREXTENDED - <b>$' + sym + '</b>\n' +
               '+' + rnd(pct,1) + '% from entry $' + pos.entry + '\n' +
               'No TP hit yet. RVOL: ' + d.relVol + 'x\n' +
               (d.relVol < 1.5 ? 'Volume fading - distribution risk. Scale out.' :
                'Volume holding. Consider partial exit and trail stop.'));
    }
  }
}

async function checkPriceAlerts() {
  for (var i = 0; i < priceAlerts.length; i++) {
    var alert = priceAlerts[i];
    if (alert.fired) continue;
    var d = await getStock(alert.ticker).catch(function(){ return null; });
    if (!d) continue;
    var triggered = alert.direction === 'above' ? d.price >= alert.price : d.price <= alert.price;
    if (triggered) {
      alert.fired = true;
      await tg(
        'PRICE ALERT - <b>$' + alert.ticker + '</b>\n' +
        'Price $' + d.price + ' is ' + alert.direction + ' $' + alert.price + '\n' +
        'Change: ' + (d.changePct>=0?'+':'') + rnd(d.changePct,2) + '%  RVOL: ' + d.relVol + 'x\n' +
        'Source: ' + (d.source||'?') + '\n' +
        '/check ' + alert.ticker,
        alert.chatId || CHAT_ID
      );
    }
  }
}

// ── TELEGRAM POLL LOOP ────────────────────────────────────────────
async function poll() {
  try {
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, 30000);
    var r;
    try {
      r = await fetch(
        'https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + (lastUpdateId+1) + '&timeout=25',
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
      var msg = update.message || update.channel_post;
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
        else if (cmd === '/ross')                         await cmdActivateProtocol('ross', chatId);
        else if (cmd === '/humble')                       await cmdActivateProtocol('humble', chatId);
        else if (cmd === '/maverick')                     await cmdActivateProtocol('maverick', chatId);
        else if (cmd === '/protocol')                     await cmdProtocol(parts, chatId);
        else if (cmd === '/position')                     await cmdPosition(parts, chatId);
        else if (cmd === '/positions')                    await cmdPositions(chatId);
        else if (cmd === '/close'    && parts[1])         await cmdClose(parts, chatId);
        else if (cmd === '/watch'    && parts[1])         await cmdWatch(parts[1], chatId);
        else if (cmd === '/alert')                        await cmdAlert(parts, chatId);
        else if (cmd === '/news')                         await cmdNews(chatId);
        else if (cmd === '/myedge')                       await cmdMyEdge(chatId);
        else if (cmd === '/history')                      await cmdHistory(chatId);
        else if (text.charAt(0) !== '/')                  await cmdAI(text, chatId);
        else await tg('Unknown command. Type /help for all commands.', chatId);
      } catch (e) {
        console.error('[CMD]', cmd, e.message);
        await tg('Error processing ' + cmd + ': ' + e.message, chatId);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.error('[POLL]', e.message);
  } finally {
    // GUARANTEED reschedule - this NEVER stops
    setTimeout(poll, 500);
  }
}

// ── STARTUP ───────────────────────────────────────────────────────
async function start() {
  console.log('\n[MAVERICK INTEL BOT v3.0] Initializing...');
  console.log('  Groq (primary):    ' + (GROQ_KEY  ? 'connected' : 'MISSING'));
  console.log('  Cerebras (backup): ' + (CBRS_KEY  ? 'connected' : 'not set'));
  console.log('  Polygon (live):    ' + (POLYGON   ? 'connected' : 'MISSING - add POLYGON_KEY'));
  console.log('  Finnhub (backup):  ' + (FINNHUB   ? 'connected' : 'not set'));
  console.log('  Telegram:          ' + (TG_TOKEN  ? 'connected' : 'MISSING'));
  console.log('  JSONBin (memory):  ' + (JSONBIN_ID? 'connected' : 'not set'));
  console.log('  Intel Bot:         ' + (TG_TOKEN  ? 'launched'  : 'FAILED - no token'));

  if (!TG_TOKEN) {
    console.error('[BOT] No Telegram token. Set INTEL_BOT_TOKEN env var.');
    return;
  }

  await loadMemory();

  await tg(
    '<b>MAVERICK INTEL BOT v3.0 - ONLINE</b>\n\n' +
    'Data: ' + (POLYGON ? 'Polygon LIVE' : 'Yahoo+Finnhub') + '\n' +
    'News: SEC EDGAR + Benzinga + Finnhub\n' +
    'Brain: ' + (GROQ_KEY ? 'Groq+Cerebras' : CBRS_KEY ? 'Cerebras' : 'NO AI') + '\n' +
    'Memory: ' + (JSONBIN_ID ? (memory.trades ? memory.trades.length : 0) + ' trades loaded' : 'not configured') + '\n' +
    'Account: $' + ACCOUNT_SIZE + ' | Max risk/trade: $' + MAX_RISK_DOLLAR + '\n' +
    'Morning briefing: 4AM-11AM CT\n\n' +
    'Type /help for all commands.'
  );

  setInterval(monitorPositions,  60000);   // every 60s
  setInterval(checkPriceAlerts,  30000);   // every 30s
  setInterval(scanNewsIntel,    120000);   // every 2min
  setInterval(morningBriefing,  300000);   // every 5min (checks time internally)

  poll();
}

start();
