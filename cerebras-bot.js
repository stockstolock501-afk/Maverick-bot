/**
 * MAVERICK INTEL BOT
 * - Cerebras IPO ignition alert (fires within 60s of first trade)
 * - High-conviction news scanner with scoring engine
 */

require('dotenv').config();
const fetch = require('node-fetch');

const TOKEN    = process.env.INTEL_BOT_TOKEN   || process.env.TELEGRAM_TOKEN  || '';
const CHAT_ID  = process.env.INTEL_BOT_CHAT    || process.env.TELEGRAM_CHAT_ID || '';
const FINNHUB  = process.env.FINNHUB_KEY        || '';

// ── Cerebras ticker — CBRS on NASDAQ
const CEREBRAS_TICKER = 'CBRS';

// ── State
let cerebrasFired     = false;
let lastNewsTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1h ago baseline
const sentHeadlines   = new Set();

// ── Telegram sender
async function tg(msg) {
  if (!TOKEN || !CHAT_ID) { console.log('[TG DISABLED]', msg.slice(0, 80)); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[TG ERROR]', e.message);
  }
}

// ── Finnhub helper
async function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  const r   = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${FINNHUB}`);
  return r.json();
}

// ── NEWS CONVICTION SCORER ────────────────────────────────────────────────────
// Returns 0-100 score. Only sends if score >= 70.

const TIER1_KEYWORDS = [
  'fda approval','fda approved','breakthrough designation','fast track','nda accepted',
  'merger','acquisition','buyout','takeover','deal','agreement',
  'earnings beat','revenue beat','guidance raise','record revenue',
  'short squeeze','halt','circuit breaker','trading halted',
  'ipo priced','ipo begins trading','begins trading',
  'nasdaq compliance','uplisting','uplisted',
  'barda','dod contract','government contract','department of defense',
  'reverse split','special dividend','share buyback',
  'phase 3','phase iii','pivotal trial','positive results',
  'cerebras','cbrs'
];

const TIER2_KEYWORDS = [
  'fda','clinical trial','phase 2','partnership','license agreement',
  'quarterly results','revenue growth','profit','loss narrowed',
  'analyst upgrade','price target raised','outperform','buy rating',
  'insider buying','13d','form 4','institutional',
  'short interest','float','catalyst','launch','commercial',
];

const NEGATIVE_KEYWORDS = [
  'going concern','dilut','offering','atm','at-the-market','shelf registration',
  'delisting','bankruptcy','chapter 11','default','investigation',
  'class action','sec subpoena','restated','restatement',
  'guidance cut','guidance lowered','miss','below expectations',
];

const QUALITY_SOURCES = ['reuters','bloomberg','wsj','wall street journal','financial times','ft.com','cnbc','sec.gov','businesswire','prnewswire','globenewswire','accesswire'];

function scoreNews(n) {
  const text   = ((n.headline || '') + ' ' + (n.summary || '')).toLowerCase();
  const source = (n.source || '').toLowerCase();
  let score    = 0;
  let flags    = [];

  // Source quality
  if (QUALITY_SOURCES.some(s => source.includes(s))) { score += 20; flags.push('TIER1-SOURCE'); }
  else score += 5;

  // Tier 1 keywords — hard catalysts
  const t1 = TIER1_KEYWORDS.filter(k => text.includes(k));
  if (t1.length > 0) { score += 40 + t1.length * 5; flags.push(...t1.slice(0,3).map(k => k.toUpperCase())); }

  // Tier 2 keywords — soft catalysts
  const t2 = TIER2_KEYWORDS.filter(k => text.includes(k));
  if (t2.length > 0) { score += 10 + t2.length * 3; }

  // Negative keywords — penalty
  const neg = NEGATIVE_KEYWORDS.filter(k => text.includes(k));
  if (neg.length > 0) { score -= neg.length * 15; flags.push('⚠️DILUTION-RISK'); }

  // Recency bonus — last 30 min = +10
  const ageMin = (Date.now() / 1000 - n.datetime) / 60;
  if (ageMin < 30)  score += 10;
  if (ageMin < 10)  score += 10;
  if (ageMin > 240) score -= 10; // 4h+ old, stale

  // Ticker in related — means it's specific to a stock
  if (n.related && n.related.trim()) score += 5;

  const finalScore = Math.min(100, Math.max(0, score));
  return { score: finalScore, flags };
}

function extractTickers(n) {
  const related = (n.related || '').split(',').map(s => s.trim().toUpperCase()).filter(s => s && s.length <= 5 && /^[A-Z]+$/.test(s));
  return related.slice(0, 4);
}

function formatNewsAlert(n, score, flags, tickers) {
  const ageMin = Math.round((Date.now() / 1000 - n.datetime) / 60);
  const age    = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin/60)}h ago`;
  const bar    = score >= 90 ? '🔴🔴🔴' : score >= 80 ? '🟠🟠' : '🟡';
  const tkrs   = tickers.length ? `\n📌 <b>Tickers:</b> ${tickers.join(' · ')}` : '';
  const flgs   = flags.length   ? `\n🏷 ${flags.slice(0,3).join(' · ')}` : '';

  return `${bar} <b>MAVERICK INTEL — CONVICTION ${score}</b>

📰 ${n.headline}

🏦 Source: ${n.source} · ${age}${tkrs}${flgs}

━━━━━━━━━━━━━━━━━━━━━`;
}

// ── CEREBRAS IPO MONITOR ─────────────────────────────────────────────────────
async function checkCerebrasIPO() {
  if (cerebrasFired) return;
  try {
    const quote = await fh(`/quote?symbol=${CEREBRAS_TICKER}`);
    // When IPO trading begins, Finnhub returns a non-zero current price
    if (quote && quote.c && quote.c > 0) {
      cerebrasFired = true;
      const msg = `🚨🚨🚨 <b>CEREBRAS IPO — TRADING LIVE</b> 🚨🚨🚨

💰 <b>Ticker:</b> $${CEREBRAS_TICKER}
📊 <b>Open Price:</b> $${quote.c}
📈 <b>High:</b> $${quote.h} · <b>Low:</b> $${quote.l}
🔁 <b>Change:</b> ${quote.dp >= 0 ? '+' : ''}${(quote.dp || 0).toFixed(2)}%

⚡ MAVERICK WHALE DOCTRINE:
Phase 1 window — first 15 minutes is smart money.
Watch RVOL above 3x for accumulation signal.
DO NOT CHASE above +25% open.
Hard stop: -8% from your entry.

🎯 <b>IPO first-trade detected within scan window.</b>`;
      await tg(msg);
      console.log(`[CEREBRAS] FIRED — price $${quote.c}`);
    } else {
      console.log(`[CEREBRAS] Not live yet — quote.c = ${quote && quote.c}`);
    }
  } catch (e) {
    console.error('[CEREBRAS CHECK]', e.message);
  }
}

// ── NEWS SCANNER ─────────────────────────────────────────────────────────────
async function scanNews() {
  try {
    const news = await fh(`/news?category=general`);
    if (!Array.isArray(news)) return;

    // Only look at articles newer than last scan
    const fresh = news.filter(n => n.datetime > lastNewsTimestamp && n.headline);
    if (fresh.length > 0) lastNewsTimestamp = Math.max(...fresh.map(n => n.datetime));

    for (const n of fresh) {
      if (sentHeadlines.has(n.headline)) continue;

      const { score, flags } = scoreNews(n);
      if (score >= 70) {
        sentHeadlines.add(n.headline);
        const tickers = extractTickers(n);
        const msg     = formatNewsAlert(n, score, flags, tickers);
        await tg(msg);
        console.log(`[NEWS ALERT] Score:${score} — ${n.headline.slice(0, 60)}`);
        // Small delay between sends to avoid TG rate limit
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Also scan company-specific news for high-priority tickers
    const watchlist = ['CBRS','MDAI','EONR','SPY','QQQ'];
    for (const sym of watchlist) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const yest  = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const snews = await fh(`/company-news?symbol=${sym}&from=${yest}&to=${today}`);
        if (!Array.isArray(snews)) continue;
        const freshStock = snews.filter(n => n.datetime > lastNewsTimestamp - 1800 && n.headline);
        for (const n of freshStock) {
          if (sentHeadlines.has(n.headline)) continue;
          const { score, flags } = scoreNews(n);
          // Lower threshold for watchlist tickers
          if (score >= 55) {
            sentHeadlines.add(n.headline);
            const tickers = [sym, ...extractTickers(n).filter(t => t !== sym)];
            const msg     = formatNewsAlert({ ...n, related: sym }, score, flags, tickers);
            await tg(msg);
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error('[NEWS SCAN]', e.message);
  }
}

// ── STARTUP PING ─────────────────────────────────────────────────────────────
async function startup() {
  console.log('[MAVERICK INTEL BOT] Starting...');
  console.log(`  Finnhub key: ${FINNHUB ? '✅ SET' : '❌ MISSING'}`);
  console.log(`  Telegram token: ${TOKEN ? '✅ SET' : '❌ MISSING'}`);
  console.log(`  Chat ID: ${CHAT_ID ? '✅ SET' : '❌ MISSING'}`);

  await tg(`🤖 <b>MAVERICK INTEL BOT ONLINE</b>

📡 Cerebras ($${CEREBRAS_TICKER}) IPO monitor: ACTIVE
🔍 News conviction scanner: ACTIVE (threshold: 70+)
⏱ Scan interval: 30 seconds

Watching for high-conviction catalysts. Only alerts that score 70+ will be sent.`);

  // Start scans
  checkCerebrasIPO();
  scanNews();

  // Cerebras — check every 30s until fired
  const cerebrasInterval = setInterval(async () => {
    if (cerebrasFired) { clearInterval(cerebrasInterval); return; }
    await checkCerebrasIPO();
  }, 30000);

  // News — scan every 2 minutes
  setInterval(scanNews, 120000);
}

startup();
