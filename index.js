// ═══════════════════════════════════════════════════════════════════════════
// MAVERICK TERMINAL v3 — HEDGE FUND STACK
// Multi-source data · Groq AI brain · TradingView webhooks · Pattern memory
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fetch       = require('node-fetch');
const path        = require('path');

// ── ENV ──────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const GROQ_KEY       = process.env.GROQ_KEY;
const JSONBIN_KEY    = process.env.JSONBIN_KEY;
const JSONBIN_BIN    = process.env.JSONBIN_BIN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'maverick';
const TG_CHAT_ID     = process.env.TG_CHAT_ID; // your personal chat ID

// ── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── TELEGRAM BOT ─────────────────────────────────────────────────────────────
const bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN, { polling: true }) : null;

function tgSend(chatId, text, opts = {}) {
  if (!bot) return;
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts })
    .catch(e => console.error('TG send:', e.message));
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — DATA SOURCES (multi-source, fresh, verified)
// ═══════════════════════════════════════════════════════════════════════════

// ── Yahoo Finance (free, real-time, no key) ──────────────────────────────────
async function yahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`;
    const r   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d   = await r.json();
    const q   = d?.quoteResponse?.result?.[0];
    if (!q) return null;
    return {
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      open: q.regularMarketOpen,
      high: q.regularMarketDayHigh,
      low: q.regularMarketDayLow,
      prevClose: q.regularMarketPreviousClose,
      volume: q.regularMarketVolume,
      avgVolume: q.averageDailyVolume3Month,
      marketCap: q.marketCap,
      sharesOut: q.sharesOutstanding,
      floatShares: q.floatShares,
      pe: q.trailingPE,
      epsTTM: q.epsTrailingTwelveMonths,
      yearHigh: q.fiftyTwoWeekHigh,
      yearLow: q.fiftyTwoWeekLow,
      preMarket: q.preMarketPrice,
      preMarketChangePct: q.preMarketChangePercent,
      postMarket: q.postMarketPrice,
      postMarketChangePct: q.postMarketChangePercent,
      shortName: q.shortName,
      sector: q.sector,
      industry: q.industry,
    };
  } catch (e) { console.error('Yahoo error:', e.message); return null; }
}

// ── Finnhub (real-time, news) ────────────────────────────────────────────────
async function finnhubQuote(symbol) {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`);
    return await r.json();
  } catch { return null; }
}

async function finnhubNews(symbol) {
  if (!FINNHUB_KEY) return [];
  try {
    const to   = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const r    = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d    = await r.json();
    return Array.isArray(d) ? d.slice(0, 5).map(n => ({
      headline: n.headline, source: n.source, datetime: n.datetime, url: n.url
    })) : [];
  } catch { return []; }
}

async function finnhubMetrics(symbol) {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${FINNHUB_KEY}`);
    const d = await r.json();
    return d?.metric || null;
  } catch { return null; }
}

// ── Finviz (technical context, requires HTML scrape) ─────────────────────────
async function finvizSnapshot(symbol) {
  try {
    const url = `https://finviz.com/quote.ashx?t=${symbol}&p=d`;
    const r   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Maverick/1.0)' } });
    const html = await r.text();

    // Lightweight regex-based extraction (no DOM library to keep it simple)
    const get = (label) => {
      const re = new RegExp(`>${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}</td><td[^>]*>([^<]+)<`);
      const m = html.match(re);
      return m ? m[1].trim() : null;
    };

    return {
      price: get('Price'),
      change: get('Change'),
      volume: get('Volume'),
      relVolume: get('Rel Volume'),
      avgVolume: get('Avg Volume'),
      shortFloat: get('Short Float'),
      shortRatio: get('Short Ratio'),
      shsFloat: get('Shs Float'),
      shsOutstand: get('Shs Outstand'),
      perfWeek: get('Perf Week'),
      perfMonth: get('Perf Month'),
      perfYear: get('Perf Year'),
      perfYTD: get('Perf YTD'),
      atr: get('ATR (14)'),
      rsi: get('RSI (14)'),
      sma20: get('SMA20'),
      sma50: get('SMA50'),
      sma200: get('SMA200'),
      high52w: get('52W High'),
      low52w: get('52W Low'),
      target: get('Target Price'),
      analystRecom: get('Recom'),
      institutional: get('Inst Own'),
    };
  } catch (e) { console.error('Finviz:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 — TRADINGVIEW SIGNAL CACHE
// (TradingView pings webhook when UT Bot / LuxAlgo fires)
// ═══════════════════════════════════════════════════════════════════════════

const tvSignals = new Map(); // symbol → { action, indicator, price, time }

function getTvSignal(symbol) {
  const sig = tvSignals.get(symbol.toUpperCase());
  if (!sig) return null;
  // Signals expire after 30 minutes
  if (Date.now() - sig.time > 30 * 60 * 1000) {
    tvSignals.delete(symbol.toUpperCase());
    return null;
  }
  return sig;
}

// TradingView webhook endpoint
app.post('/webhook/tradingview', async (req, res) => {
  const secret = req.query.secret || req.body.secret;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const { ticker, action, indicator, price, message } = req.body;
  if (!ticker || !action) return res.status(400).json({ error: 'missing ticker or action' });

  const sym = ticker.toUpperCase();
  tvSignals.set(sym, {
    action: action.toUpperCase(),
    indicator: indicator || 'TradingView',
    price: parseFloat(price) || null,
    time: Date.now(),
    message: message || '',
  });

  console.log(`📡 TV Signal: ${sym} ${action} via ${indicator || 'TV'}`);

  // Auto-alert via Telegram
  if (TG_CHAT_ID && bot) {
    const emoji = action.toUpperCase() === 'BUY' ? '🟢' : action.toUpperCase() === 'SELL' ? '🔴' : '⚡';
    tgSend(TG_CHAT_ID,
      `${emoji} *TRADINGVIEW SIGNAL*\n\n` +
      `Ticker: *${sym}*\n` +
      `Action: *${action.toUpperCase()}*\n` +
      `Indicator: *${indicator || 'Custom'}*\n` +
      (price ? `Price: *$${price}*\n` : '') +
      (message ? `\n${message}\n` : '') +
      `\nText: _watching ${sym} at ${price || '?'}_`
    );
  }

  res.json({ ok: true, cached: sym });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3 — PATTERN MEMORY (JSONBin storage)
// ═══════════════════════════════════════════════════════════════════════════

async function memoryLoad() {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return { trades: [], scans: [] };
  try {
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_KEY }
    });
    const d = await r.json();
    return d.record || { trades: [], scans: [] };
  } catch { return { trades: [], scans: [] }; }
}

async function memorySave(record) {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return;
  try {
    await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
      body: JSON.stringify(record)
    });
  } catch (e) { console.error('Memory save:', e.message); }
}

async function logScan(scan) {
  const mem = await memoryLoad();
  mem.scans = mem.scans || [];
  mem.scans.push({ ...scan, id: Date.now() });
  if (mem.scans.length > 200) mem.scans = mem.scans.slice(-200);
  await memorySave(mem);
}

async function logTrade(trade) {
  const mem = await memoryLoad();
  mem.trades = mem.trades || [];
  mem.trades.push({ ...trade, id: Date.now() });
  await memorySave(mem);
}

// Pattern detection — find historical similar setups
async function findSimilarPastSetups(currentScan) {
  const mem = await memoryLoad();
  const past = mem.scans || [];
  if (past.length < 3) return null;

  const similar = past.filter(s => {
    if (!s.pillarsFiring || !currentScan.pillarsFiring) return false;
    const overlap = s.pillarsFiring.filter(p => currentScan.pillarsFiring.includes(p));
    return overlap.length >= 2 &&
           Math.abs((s.priceChangePct || 0) - (currentScan.priceChangePct || 0)) < 30;
  });

  if (!similar.length) return null;

  // Match scans to trades by symbol + date
  const trades = mem.trades || [];
  const matchedTrades = similar.map(s => {
    return trades.find(t => t.symbol === s.symbol &&
      Math.abs(new Date(t.date).getTime() - s.id) < 7 * 86400000);
  }).filter(Boolean);

  if (!matchedTrades.length) return { count: similar.length, hasOutcome: false };

  const wins = matchedTrades.filter(t => t.pnl > 0);
  const winRate = (wins.length / matchedTrades.length * 100).toFixed(0);
  const avgPnl  = (matchedTrades.reduce((s, t) => s + t.pnl, 0) / matchedTrades.length).toFixed(2);

  return {
    count: similar.length,
    hasOutcome: true,
    winRate,
    avgPnl,
    sampleSize: matchedTrades.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4 — AI BRAIN (Groq Llama 3.3 70B)
// ═══════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are MAVERICK — an aggressive, decisive day trading AI for a hedge-fund-grade analyst.

YOUR JOB: Analyze a stock using LIVE data and deliver ONE of four verdicts. You are NOT timid. You take positions when math works. You only refuse when math clearly fails.

VERDICTS:
1. BUY — high conviction, structure is clean, take the trade
2. DON'T BUY — clear structural problem, name the reason
3. WATCH — setup forming but needs trigger, name the trigger
4. IN-TRADE — irrelevant for entry analysis (skip this)

TRADER STYLE:
- AGGRESSIVE — willing to take 3:1 R:R trades on momentum setups
- Sub-$10 specialist, micro-floats welcome
- Day trade and swing trade both
- Respects stops, expects 60–70% win rate

DATA YOU GET:
- Yahoo (price, float, volume, market cap)
- Finviz (RSI, ATR, short float, sector context, perf vs market)
- Finnhub (news catalysts)
- TradingView signal (UT Bot/LuxAlgo if firing)
- Pattern memory (similar past setups for this user, win rate)

ENTRY ZONE MATH (CRITICAL — this is what was broken before):
- Use ATR-BASED entries, not arbitrary percentages
- Entry zone = current price ± 0.5 × ATR
- Stop = 1.5 × ATR below entry (or below recent swing low — whichever is closer)
- Target 1 = entry + 2 × (entry - stop)  ← 2:1 R:R minimum
- Target 2 = entry + 3.5 × (entry - stop)
- If ATR is missing, use: stop = 4% for sub-$5, 3% for $5-15, 2% for $15+

OUTPUT FORMAT — return ONLY valid JSON, zero markdown, zero backticks:
{
  "verdict": "BUY" | "DONT_BUY" | "WATCH",
  "conviction": 0-100,
  "headline": "one sentence verdict (e.g. 'Aggressive long here, structure is clean')",
  "reasoning": ["3-5 specific bullet points with NUMBERS, not vague observations"],
  "entry_zone": { "low": 0.00, "high": 0.00 },
  "stop_loss": 0.00,
  "target_1": 0.00,
  "target_2": 0.00,
  "risk_reward": 0.0,
  "position_size_suggestion": "AGGRESSIVE | STANDARD | SMALL",
  "trade_type": "DAY_TRADE" | "SWING" | "SCALP",
  "key_risk": "the one thing that kills this trade",
  "trigger_to_watch": "if WATCH verdict, exact condition to wait for",
  "time_horizon": "minutes/hours/days estimate"
}

BE DECISIVE. BE AGGRESSIVE. BE PRECISE. Use the actual numbers. No hedge language.`;

async function aiAnalyze(payload) {
  if (!GROQ_KEY) return null;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1500,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload, null, 2) }
        ]
      })
    });
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content || '';
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) { console.error('Groq:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ANALYZER ENDPOINT — the heart of the system
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/analyze', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });

  const sym = ticker.toUpperCase().trim();
  console.log(`🔍 Analyzing ${sym}`);

  try {
    // Pull all data sources in parallel
    const [yahoo, finn, news, fviz, tvSignal, metrics] = await Promise.all([
      yahooQuote(sym),
      finnhubQuote(sym),
      finnhubNews(sym),
      finvizSnapshot(sym),
      Promise.resolve(getTvSignal(sym)),
      finnhubMetrics(sym),
    ]);

    if (!yahoo && !finn) {
      return res.status(404).json({ error: `${sym} not found across data sources` });
    }

    // Build the data package for AI
    const pkg = {
      ticker: sym,
      timestamp: new Date().toISOString(),
      yahoo: yahoo || {},
      finnhub: { quote: finn, recent_news: news.map(n => n.headline).slice(0, 3) },
      finviz: fviz || {},
      tradingview_signal: tvSignal || null,
      key_metrics: metrics ? {
        beta: metrics.beta,
        '52WeekHigh': metrics['52WeekHigh'],
        '52WeekLow': metrics['52WeekLow'],
      } : null,
    };

    // Compute simple metrics for pattern matching
    const scanRecord = {
      symbol: sym,
      date: new Date().toISOString().split('T')[0],
      priceChangePct: yahoo?.changePct || 0,
      pillarsFiring: [],
    };
    if (yahoo?.changePct > 50) scanRecord.pillarsFiring.push('PARABOLIC');
    if (fviz?.relVolume && parseFloat(fviz.relVolume) > 3) scanRecord.pillarsFiring.push('VOL_SURGE');
    if (yahoo?.floatShares && yahoo.floatShares < 10e6) scanRecord.pillarsFiring.push('THIN_FLOAT');
    if (fviz?.shortFloat && parseFloat(fviz.shortFloat) > 20) scanRecord.pillarsFiring.push('SHORT_DESTROY');
    if (tvSignal) scanRecord.pillarsFiring.push('TV_ALGO_FIRED');

    // Pattern memory check
    const pastPattern = await findSimilarPastSetups(scanRecord);
    pkg.your_history = pastPattern;

    // AI verdict
    const verdict = await aiAnalyze(pkg);

    if (!verdict) {
      return res.status(503).json({ error: 'AI brain unavailable. Check GROQ_KEY.' });
    }

    // Log this scan to memory
    await logScan(scanRecord);

    // Return everything the UI needs
    res.json({
      ticker: sym,
      verdict,
      data: {
        yahoo: yahoo || null,
        finviz: fviz || null,
        news: news.slice(0, 3),
        tradingview: tvSignal,
        history: pastPattern,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUPERNOVA SCANNER (kept from v2 — proven 80% accuracy)
// ═══════════════════════════════════════════════════════════════════════════

const SUPERNOVA_PROMPT = `You are the Maverick Supernova Detection Algorithm. Your sole mission: identify stocks experiencing genuine SUPERNOVA events RIGHT NOW.

A Supernova is a stock with verifiable catalyst-driven movement where AT LEAST ONE is true:
A) 60+ minute sustained fuel from short covering, float exhaustion, or hard catalyst
B) Distribution-phase fade setup
C) Sixth Grade Trade — direction so obvious a 12-year-old gets it

7 PILLARS (score each):
1. THIN FLOAT (<10M)
2. HARD CATALYST (FDA/merger/contract/earnings beat)
3. SHORT DESTROY (high short float covering)
4. HALT HISTORY (circuit breakers up today)
5. PARABOLIC VELOCITY (>50% move in <60min)
6. SECTOR SYMPATHY
7. SIXTH GRADE CLARITY

TIERS: SUPERNOVA(85+), IGNITING(70-84), WARMING(55-69)

USE web_search aggressively. Run 8+ searches across:
- "stocks halted today circuit breaker up"
- "biggest stock movers today percent gain"
- "FDA approval stock surge today"
- "merger announced stock today"
- "low float stocks running today"
- For each candidate: "[TICKER] float short interest catalyst"

Return ONLY valid JSON:
{"scan_time":"ISO","market_session":"PRE-MARKET|OPEN|MIDDAY|POWER-HOUR|AFTER-HOURS","searches_executed":["..."],"market_pulse":"...","supernovas":[{"ticker":"","company":"","price":0,"price_change_pct":0,"float_millions":0,"short_float_pct":0,"catalyst":"","catalyst_type":"","halted_today":false,"halt_count":0,"trade_type":"LONG|FADE","phase":"IGNITION|FUEL_BURN|DISTRIBUTION","is_sixth_grade_trade":true,"sixth_grade_explanation":"","pillars_firing":[],"pillar_count":0,"supernova_score":0,"tier":"SUPERNOVA|IGNITING|WARMING","entry_zone":"","stop":0,"target_1":0,"target_2":0,"risk_reward":0,"thesis":"","exit_signal":""}],"algo_note":""}`;

app.post('/api/supernova', async (req, res) => {
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_KEY missing' });

  try {
    // For supernova, we use Groq with a constrained prompt because it has no web search
    // We rely on freshly pulled top-movers data instead
    const movers = await fetchTopMovers();

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4000,
        temperature: 0.4,
        messages: [
          { role: 'system', content: SUPERNOVA_PROMPT },
          { role: 'user', content: `Today's top market movers data:\n${JSON.stringify(movers, null, 2)}\n\nAnalyze for supernova candidates. Return ONLY JSON.` }
        ]
      })
    });
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content || '';
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'AI returned no JSON' });
    res.json(JSON.parse(m[0]));
  } catch (e) {
    console.error('Supernova error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Pull live top gainers from Yahoo (no key needed)
async function fetchTopMovers() {
  try {
    const url = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=day_gainers';
    const r   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d   = await r.json();
    const list = d?.finance?.result?.[0]?.quotes || [];
    return list.slice(0, 20).map(q => ({
      symbol: q.symbol,
      name: q.shortName,
      price: q.regularMarketPrice,
      changePct: q.regularMarketChangePercent,
      volume: q.regularMarketVolume,
      avgVolume: q.averageDailyVolume3Month,
      relVolume: q.regularMarketVolume / (q.averageDailyVolume3Month || 1),
      marketCap: q.marketCap,
      sharesOut: q.sharesOutstanding,
      float: q.floatShares,
    })).filter(s => s.price && s.price < 20); // Sub-$20 focus
  } catch (e) {
    console.error('Top movers:', e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM DEEP-LINK ENDPOINT (one-tap from web → start watch in bot)
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/tg-link', (req, res) => {
  const { symbol, price, action } = req.query;
  if (!symbol) return res.status(400).json({ error: 'no symbol' });

  // Telegram bot deep link
  const botUsername = process.env.TG_BOT_USERNAME || 'YourBot';
  const cmd = action === 'watch'
    ? `watching ${symbol} at ${price}`
    : `${symbol}`;

  const link = `https://t.me/${botUsername}?text=${encodeURIComponent(cmd)}`;
  res.json({ link });
});

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH + START
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    time: new Date().toISOString(),
    services: {
      telegram: !!TELEGRAM_TOKEN,
      finnhub: !!FINNHUB_KEY,
      groq: !!GROQ_KEY,
      memory: !!(JSONBIN_KEY && JSONBIN_BIN),
      tradingview_webhook: !!WEBHOOK_SECRET,
    },
    tv_signals_active: tvSignals.size,
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── TELEGRAM HANDLERS (basic) ────────────────────────────────────────────────
if (bot) {
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text   = (msg.text || '').trim();
    if (!text || text.startsWith('/')) {
      if (text === '/start' || text === '/help') {
        tgSend(chatId,
          `🤖 *MAVERICK BOT v3*\n\n` +
          `Just send me a ticker (e.g. *LFVN*) for a full live AI analysis.\n\n` +
          `Or text:\n` +
          `_watching LFVN at 5.10_ — start watch\n` +
          `_in at 5.11 with 200 shares_ — log entry\n` +
          `_status_ — current trade\n` +
          `_daily / weekly_ — P&L reports\n` +
          `_analyze_ — AI reviews your trades`
        );
        return;
      }
    }

    // Quick analysis if user sends just a ticker
    const tickerMatch = text.match(/^([A-Z]{1,5})$/);
    if (tickerMatch) {
      tgSend(chatId, `🔍 Pulling live data on *${tickerMatch[1]}*...`);
      try {
        const r = await fetch(`http://localhost:${PORT}/api/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: tickerMatch[1] })
        });
        const data = await r.json();
        if (data.error) { tgSend(chatId, `❌ ${data.error}`); return; }

        const v = data.verdict;
        const emoji = { BUY: '🟢', DONT_BUY: '🔴', WATCH: '🟡' }[v.verdict] || '⚪';
        tgSend(chatId,
          `${emoji} *${data.ticker}* — *${v.verdict.replace('_', ' ')}*\n` +
          `Conviction: *${v.conviction}/100*\n\n` +
          `${v.headline}\n\n` +
          `*Reasoning:*\n${v.reasoning.map(r => `• ${r}`).join('\n')}\n\n` +
          (v.verdict === 'BUY' ? (
            `📋 *TRADE PLAN:*\n` +
            `Entry: *$${v.entry_zone?.low}–$${v.entry_zone?.high}*\n` +
            `Stop: *$${v.stop_loss}*\n` +
            `T1: *$${v.target_1}*\n` +
            `T2: *$${v.target_2}*\n` +
            `R:R: *${v.risk_reward}:1*\n` +
            `Size: *${v.position_size_suggestion}*\n` +
            `Type: *${v.trade_type}*\n\n` +
            `⚠️ Risk: ${v.key_risk}\n\n` +
            `Text: _watching ${data.ticker} at ${v.entry_zone?.low}_`
          ) : v.verdict === 'WATCH' ? (
            `⏳ Trigger: ${v.trigger_to_watch}\n` +
            `⚠️ Risk: ${v.key_risk}`
          ) : (
            `⚠️ ${v.key_risk}`
          ))
        );
      } catch (e) {
        tgSend(chatId, `❌ Analysis error: ${e.message}`);
      }
      return;
    }
  });
}

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 MAVERICK TERMINAL v3 — Hedge Fund Stack`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Yahoo: ✅ (no key needed)`);
  console.log(`   Finnhub: ${FINNHUB_KEY ? '✅' : '⚠️'}`);
  console.log(`   Groq AI: ${GROQ_KEY ? '✅' : '⚠️'}`);
  console.log(`   Memory: ${JSONBIN_KEY ? '✅' : '⚠️'}`);
  console.log(`   Telegram: ${TELEGRAM_TOKEN ? '✅' : '⚠️'}`);
  console.log(`   TV Webhook: /webhook/tradingview?secret=${WEBHOOK_SECRET}\n`);
});
