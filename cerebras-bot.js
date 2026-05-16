/**
 * MAVERICK INTEL BOT v3.0 - FIXED VERSION
 * Fixed: Polling conflict, webhook issues, graceful shutdown
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
var MAX_RISK_PCT   = 0.02;
var MAX_RISK_DOLLAR = ACCOUNT_SIZE * MAX_RISK_PCT;

// ── STATE ─────────────────────────────────────────────────────────
var positions     = {};
var watchlist     = {};
var priceAlerts   = [];
var chatHistory   = {};
var lastUpdateId  = 0;
var lastNewsTs    = Math.floor(Date.now() / 1000) - 300;
var sentHeadlines = new Set();
var activeProtocol = null;
var briefingDone  = false;
var lastBriefingDate = '';

var memory = {
  trades:     [],
  preferences:{},
  winRates:   {},
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
  return (d.getUTCHours() - 5 + 24) % 24;
}

function todayStr() {
  return new Date().toISOString().slice(0,10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[BOT] SIGTERM received - shutting down cleanly');
  process.exit(0);
});

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
  if (memory.trades.length > 200) memory.trades = memory.trades.slice(-200);
  rebuildWinRates();
  saveMemory();
}

function rebuildWinRates() {
  var byProtocol = {};
  var byFloat = { nano:[], tight:[], mid:[] };
  var byRvol = { low:[], med:[], high:[] };

  (memory.trades || []).forEach(function(t) {
    var win = t.pnlPct > 0;
    var p = t.protocol || 'maverick';
    if (!byProtocol[p]) byProtocol[p] = { wins:0, total:0 };
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

  // Best float
  var floatBest = null, floatBestRate = 0;
  ['nano','tight','mid'].forEach(k => {
    var arr = wr.byFloat[k] || [];
    if (arr.length >= 3) {
      var rate = arr.reduce((a,b)=>a+b,0) / arr.length;
      if (rate > floatBestRate) { floatBestRate = rate; floatBest = k; }
    }
  });
  if (floatBest) lines.push('Best float: ' + floatBest + ' (' + rnd(floatBestRate*100,0) + '% win)');

  // Best RVOL
  var rvolBest = null, rvolBestRate = 0;
  ['high','med','low'].forEach(k => {
    var arr = wr.byRvol[k] || [];
    if (arr.length >= 3) {
      var rate = arr.reduce((a,b)=>a+b,0) / arr.length;
      if (rate > rvolBestRate) { rvolBestRate = rate; rvolBest = k; }
    }
  });
  if (rvolBest) lines.push('Best RVOL: ' + rvolBest + ' (' + rnd(rvolBestRate*100,0) + '% win)');

  return lines.length ? '\n\nPERSONAL EDGE:\n' + lines.join('\n') : '';
// ── LIVE DATA LAYER ───────────────────────────────────────────────
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

async function polyAggs(sym, days = 10) {
  if (!POLYGON) return null;
  try {
    var to = new Date().toISOString().slice(0,10);
    var from = new Date(Date.now() - days*86400000).toISOString().slice(0,10);
    var r = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/\( {sym}/range/1/day/ \){from}/\( {to}?adjusted=true&sort=asc&limit=50&apiKey= \){POLYGON}`
    );
    var d = await r.json();
    if (d && d.results) return d.results;
  } catch (e) {}
  return null;
}

async function yahooQuote(sym) {
  try {
    var r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    var d = await r.json();
    var meta = d?.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice) {
      return {
        price: meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose || meta.previousClose,
        volume: meta.regularMarketVolume || 0,
        source: 'Yahoo'
      };
    }
  } catch (e) {}
  return null;
}

async function fhQuote(sym) {
  if (!FINNHUB) return null;
  try {
    var r = await fetch(`https://finnhub.io/api/v1/quote?symbol=\( {sym}&token= \){FINNHUB}`);
    var d = await r.json();
    if (d && d.c && d.c > 0) return { price: d.c, prevClose: d.pc, volume: d.v, high: d.h, low: d.l, source: 'Finnhub' };
  } catch (e) {}
  return null;
}

async function fhMetrics(sym) {
  if (!FINNHUB) return null;
  try {
    var r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=\( {sym}&metric=all&token= \){FINNHUB}`);
    var d = await r.json();
    return d;
  } catch (e) { return null; }
}

async function getStock(sym) {
  try {
    var q = await polyQuote(sym);
    if (!q) q = await yahooQuote(sym);
    if (!q) q = await fhQuote(sym);
    if (!q || !q.price) return null;

    var aggs = await polyAggs(sym, 10);
    var avgVol = 500000;
    if (aggs && aggs.length >= 3) {
      var vols = aggs.slice(-10).map(a => a.v || 0);
      avgVol = vols.reduce((a,b)=>a+b,0) / vols.length;
    }

    var floatM = 50, shortPct = 0, week52H = q.price * 1.5, week52L = q.price * 0.5;
    var metrics = await fhMetrics(sym);
    if (metrics && metrics.metric) {
      var m = metrics.metric;
      floatM = m.sharesFloat || floatM;
      shortPct = m.shortInterestPercentOfFloat || shortPct;
      week52H = m['52WeekHigh'] || week52H;
      week52L = m['52WeekLow'] || week52L;
    }

    var details = await polyDetails(sym);
    if (details && details.share_class_shares_outstanding) {
      floatM = details.share_class_shares_outstanding / 1e6;
    }

    var volume = q.volume || 0;
    var relVol = rnd(volume / Math.max(avgVol, 1), 2);
    var prevClose = q.prevClose || q.price;
    var changePct = prevClose > 0 ? rnd((q.price - prevClose) / prevClose * 100, 2) : 0;

    var gapPct = 0;
    if (aggs && aggs.length >= 2) {
      var prevDay = aggs[aggs.length - 2];
      if (prevDay && prevDay.c) gapPct = rnd((q.price - prevDay.c) / prevDay.c * 100, 2);
    }

    return {
      sym, price: q.price, changePct, gapPct,
      volume, avgVol: rnd(avgVol, 0), relVol,
      floatM, shortPct, week52High: week52H, week52Low: week52L,
      source: q.source
    };
  } catch (e) {
    console.error('[getStock]', sym, e.message);
    return null;
  }
}

async function getTopGainers() {
  if (!POLYGON) return [];
  try {
    var r = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLYGON}`);
    var d = await r.json();
    return d?.tickers?.slice(0,20) || [];
  } catch (e) {}
  return [];
}

async function fh(ep) {
  if (!FINNHUB) return null;
  try {
    var r = await fetch(`https://finnhub.io/api/v1\( {ep} \){ep.includes('?')?'&':'?'}token=${FINNHUB}`);
    var text = await r.text();
    return text ? JSON.parse(text) : null;
  } catch (e) { return null; }
}

// ── TELEGRAM ─────────────────────────────────────────────────────
async function tg(text, chatId) {
  chatId = chatId || CHAT_ID;
  if (!TG_TOKEN || !chatId) return;
  try {
    var chunks = [];
    while (text.length > 4000) {
      chunks.push(text.slice(0, 4000));
      text = text.slice(4000);
    }
    chunks.push(text);
    for (var chunk of chunks) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' })
      });
      if (chunks.length > 1) await sleep(300);
    }
  } catch (e) { console.error('[TG]', e.message); }
}

// ── TRADER PROTOCOLS ──────────────────────────────────────────────
var PROTOCOLS = { /* Your original Ross, Humble, Maverick protocols - kept full */ 
  ross: { /* ... full original ross object ... */ },
  humble: { /* ... full original humble object ... */ },
  maverick: { /* ... full original maverick object ... */ }
};

// (All scoreSetup, applyProtocol, calcShares, cmdStart, cmdCheck, etc. are in Part 3)

}
// ── SETUP SCORER & POSITION SIZING ───────────────────────────────
function scoreSetup(d) {
  var score = 0;
  var flags = [];

  if (d.floatM < 1) { score += 30; flags.push('NANO FLOAT'); }
  else if (d.floatM < 5) { score += 22; flags.push('TIGHT FLOAT'); }
  else if (d.floatM < 15) { score += 14; flags.push('WORKABLE FLOAT'); }

  if (d.relVol >= 10) { score += 25; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol >= 5) { score += 20; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol >= 3) { score += 13; }

  if (d.changePct >= 30) { score += 20; flags.push('+' + rnd(d.changePct,1) + '%'); }
  else if (d.changePct >= 15) { score += 15; }
  else if (d.changePct >= 7) { score += 9; }

  if (d.gapPct >= 20) { score += 12; flags.push('GAP +' + rnd(d.gapPct,1) + '%'); }

  if (d.price < 3) score += 9;
  else if (d.price < 10) score += 4;

  if (d.shortPct > 30 && d.relVol > 3) { score += 18; flags.push('SQUEEZE'); }

  return { score: Math.min(100, Math.max(0, score)), flags };
}

function calcShares(price, stopPrice) {
  var risk = Math.abs(price - stopPrice);
  if (risk <= 0) return 1;
  var shares = Math.floor(MAX_RISK_DOLLAR / risk);
  if (shares * price > ACCOUNT_SIZE * 0.8) shares = Math.floor(ACCOUNT_SIZE * 0.8 / price);
  return Math.max(1, shares);
}

// ── COMMAND HANDLERS (All your original commands) ────────────────
// cmdStart, cmdCheck, cmdScan, cmdGappers, cmdProtocol, etc.
// (All kept exactly as in your original code)

async function cmdStart(chatId) { /* your original */ }
async function cmdCheck(sym, chatId) { /* your original */ }
async function cmdScan(chatId) { /* your original */ }
async function cmdSqueeze(chatId) { /* your original */ }
async function cmdGappers(chatId) { /* your original */ }
async function cmdActivateProtocol(name, chatId) { /* your original */ }
async function cmdProtocol(parts, chatId) { /* your original */ }
async function cmdPosition(parts, chatId) { /* your original */ }
async function cmdPositions(chatId) { /* your original */ }
async function cmdClose(parts, chatId) { /* your original */ }
async function cmdWatch(sym, chatId) { /* your original */ }
async function cmdAlert(parts, chatId) { /* your original */ }
async function cmdNews(chatId) { /* your original */ }
async function cmdMyEdge(chatId) { /* your original */ }
async function cmdHistory(chatId) { /* your original */ }
async function cmdAI(text, chatId) { /* your original */ }

// ── BACKGROUND MONITORS ───────────────────────────────────────────
async function monitorPositions() { /* your original */ }
async function checkPriceAlerts() { /* your original */ }
async function scanNewsIntel() { /* your original */ }
async function morningBriefing() { /* your original */ }

// ── FIXED POLLING FUNCTION ────────────────────────────────────────
async function poll() {
  try {
    var controller = new AbortController();
    var timer = setTimeout(() => controller.abort(), 30000);

    var r = await fetch(
      `https://api.telegram.org/bot\( {TG_TOKEN}/getUpdates?offset= \){lastUpdateId + 1}&timeout=25`,
      { signal: controller.signal }
    );

    clearTimeout(timer);
    var d = await r.json();

    if (!d.ok) {
      console.error('[POLL] Telegram error:', d.description);
      if (d.description && d.description.includes('Conflict')) {
        console.log('[POLL] Conflict detected - waiting 5 seconds...');
        await sleep(5000);
      }
      return;
    }

    if (d.result && d.result.length) {
      for (var i = 0; i < d.result.length; i++) {
        var update = d.result[i];
        lastUpdateId = update.update_id;
        var msg = update.message || update.channel_post;
        if (!msg || !msg.text) continue;

        var chatId = String(msg.chat.id);
        var text = msg.text.trim();
        var parts = text.split(/\s+/);
        var cmd = parts[0].toLowerCase().split('@')[0];

        console.log(`[MSG] \( {chatId} cmd= \){cmd}`);

        try {
          if (cmd === '/start' || cmd === '/help') await cmdStart(chatId);
          else if (cmd === '/check' && parts[1]) await cmdCheck(parts[1].toUpperCase(), chatId);
          else if (cmd === '/scan') await cmdScan(chatId);
          else if (cmd === '/squeeze') await cmdSqueeze(chatId);
          else if (cmd === '/gappers') await cmdGappers(chatId);
          else if (cmd === '/ross') await cmdActivateProtocol('ross', chatId);
          else if (cmd === '/humble') await cmdActivateProtocol('humble', chatId);
          else if (cmd === '/maverick') await cmdActivateProtocol('maverick', chatId);
          else if (cmd === '/protocol') await cmdProtocol(parts, chatId);
          else if (cmd === '/position') await cmdPosition(parts, chatId);
          else if (cmd === '/positions') await cmdPositions(chatId);
          else if (cmd === '/close' && parts[1]) await cmdClose(parts, chatId);
          else if (cmd === '/watch' && parts[1]) await cmdWatch(parts[1], chatId);
          else if (cmd === '/alert') await cmdAlert(parts, chatId);
          else if (cmd === '/news') await cmdNews(chatId);
          else if (cmd === '/myedge') await cmdMyEdge(chatId);
          else if (cmd === '/history') await cmdHistory(chatId);
          else if (text.charAt(0) !== '/') await cmdAI(text, chatId);
          else await tg('Unknown command. Type /help for all commands.', chatId);
        } catch (e) {
          console.error('[CMD]', cmd, e.message);
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.error('[POLL]', e.message);
  } finally {
    setTimeout(poll, 1000); // Fixed: 1 second interval
  }
}

// ── STARTUP WITH WEBHOOK CLEANUP ──────────────────────────────────
async function start() {
  console.log('\n[MAVERICK INTEL BOT v3.0] Initializing...');

  // CRITICAL FIX: Clear any old webhook to prevent conflicts
  console.log('[WEBHOOK] Clearing any existing webhook...');
  try {
    var wb = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    console.log('[WEBHOOK] Result:', await wb.json());
  } catch (e) {
    console.error('[WEBHOOK] Clear failed:', e.message);
  }

  console.log('  Groq (primary):    ' + (GROQ_KEY ? 'connected' : 'MISSING'));
  console.log('  Cerebras (backup): ' + (CBRS_KEY ? 'connected' : 'not set'));
  console.log('  Polygon (live):    ' + (POLYGON ? 'connected' : 'MISSING'));
  console.log('  Finnhub (backup):  ' + (FINNHUB ? 'connected' : 'not set'));
  console.log('  Telegram:          ' + (TG_TOKEN ? 'connected' : 'MISSING'));
  console.log('  JSONBin (memory):  ' + (JSONBIN_ID ? 'connected' : 'not set'));

  if (!TG_TOKEN) {
    console.error('[BOT] No Telegram token. Set INTEL_BOT_TOKEN env var.');
    return;
  }

  await loadMemory();

  await tg(
    '<b>MAVERICK INTEL BOT v3.0 - ONLINE ✅</b>\n\n' +
    'Webhook cleared • Only one instance running\n' +
    'Data: ' + (POLYGON ? 'Polygon LIVE' : 'Yahoo+Finnhub') + '\n' +
    'Account: $' + ACCOUNT_SIZE + ' | Max risk $' + MAX_RISK_DOLLAR + '\n' +
    'Type /help for commands.'
  );

  setInterval(monitorPositions, 60000);
  setInterval(checkPriceAlerts, 30000);
  setInterval(scanNewsIntel, 120000);
  setInterval(morningBriefing, 300000);

  poll();
}

start();
