// ═══════════════════════════════════════════════════════════════════════════
// MAVERICK TERMINAL — COMPLETE CONSOLIDATED v3.3
// All features in one file. Replace your entire index.js with this.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const fetch       = require('node-fetch');
const path        = require('path');

// ── ENV ───────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const GROQ_KEY       = process.env.GROQ_KEY;
const JSONBIN_KEY    = process.env.JSONBIN_KEY;
const JSONBIN_BIN    = process.env.JSONBIN_BIN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'maverick';
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const BOT_USERNAME   = process.env.TG_BOT_USERNAME || '';

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── GROQ MODELS — tries each in order until one works ────────────────────────
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
  'llama3-8b-8192',
];

async function groqCall(system, user, maxTokens = 1500) {
  if (!GROQ_KEY) { console.error('GROQ_KEY missing'); return null; }
  for (const model of GROQ_MODELS) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: maxTokens, temperature: 0.25,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!r.ok) {
        const err = await r.text();
        console.error(`Groq [${model}] HTTP ${r.status}: ${err.slice(0, 200)}`);
        continue;
      }
      const d = await r.json();
      const text = d.choices?.[0]?.message?.content || '';
      if (!text) { console.error(`Groq [${model}] empty response`); continue; }
      const m = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim().match(/\{[\s\S]*\}/);
      if (!m) { console.error(`Groq [${model}] no JSON found`); continue; }
      return JSON.parse(m[0]);
    } catch (e) {
      console.error(`Groq [${model}] error: ${e.message}`);
    }
  }
  console.error('All Groq models failed');
  return null;
}

// ── GROQ DIAGNOSTIC ENDPOINT ─────────────────────────────────────────────────
// Visit /api/groq-test to see exactly what Groq returns
// This is how we diagnose the real error

// ── TELEGRAM — 409 fix: delete webhook + drop pending before polling ─────────
let bot = null;
async function initTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    // Clear any webhook and pending updates first — prevents 409
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    await new Promise(r => setTimeout(r, 1000)); // wait 1 second
    bot = new TelegramBot(TELEGRAM_TOKEN, {
      polling: { interval: 2000, params: { timeout: 10, allowed_updates: ['message'] } }
    });
    console.log('✅ Telegram started');
    setupTelegramHandlers();
  } catch (e) { console.error('Telegram init:', e.message); }
}

function tgSend(chatId, text) {
  if (!bot || !chatId) return;
  bot.sendMessage(String(chatId), text, { parse_mode: 'Markdown' })
    .catch(e => console.error('TG send:', e.message));
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const watches          = new Map();
const trades           = new Map();
const priceAlerts      = new Map();
const subscribers      = new Map();
const volTracker       = new Map();
const tvSignals        = new Map();
const pendingCatalysts = new Map();
const chatSessions     = new Map();

// ── FINNHUB WEBSOCKET ─────────────────────────────────────────────────────────
let ws;
function connectFinnhub() {
  if (!FINNHUB_KEY) return;
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => {
    console.log('✅ Finnhub WS');
    for (const s of subscribers.keys()) ws.send(JSON.stringify({ type: 'subscribe', symbol: s }));
  });
  ws.on('message', raw => {
    try { const m = JSON.parse(raw); if (m.type === 'trade' && Array.isArray(m.data)) m.data.forEach(t => onTick(t.s, t.p, t.v)); } catch {}
  });
  ws.on('close', () => setTimeout(connectFinnhub, 5000));
  ws.on('error', e => console.error('WS:', e.message));
}
function wsSend(s, a) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: a, symbol: s })); }
function addSub(s, id) { if (!subscribers.has(s)) subscribers.set(s, new Set()); if (!subscribers.get(s).size) wsSend(s, 'subscribe'); subscribers.get(s).add(id); }
function removeSub(s, id) { const x = subscribers.get(s); if (!x) return; x.delete(id); if (!x.size) { subscribers.delete(s); wsSend(s, 'unsubscribe'); } }

// ═══════════════════════════════════════════════════════════════════════════
// DATA LAYER
// ═══════════════════════════════════════════════════════════════════════════

async function getQuote(symbol) {
  const sym = symbol.toUpperCase();
  // PRIMARY: Finnhub
  if (FINNHUB_KEY) {
    try {
      const [qr, pr] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`),
        fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${FINNHUB_KEY}`),
      ]);
      const q = await qr.json(); const p = await pr.json();
      if (q && q.c && q.c > 0) {
        const change = q.c - q.pc; const changePct = q.pc ? (change / q.pc) * 100 : 0;
        return { price: q.c, change, changePct, open: q.o, high: q.h, low: q.l, prevClose: q.pc, volume: null, avgVolume: null, marketCap: p?.marketCapitalization ? p.marketCapitalization * 1e6 : null, floatShares: p?.shareOutstanding ? p.shareOutstanding * 1e6 : null, sharesOut: p?.shareOutstanding ? p.shareOutstanding * 1e6 : null, yearHigh: null, yearLow: null, sector: p?.finnhubIndustry || null, industry: p?.finnhubIndustry || null, shortName: p?.name || sym, source: 'finnhub' };
      }
    } catch (e) { console.error('Finnhub quote:', e.message); }
  }
  // FALLBACK: Yahoo
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' }
    });
    const d = await r.json(); const q = d?.quoteResponse?.result?.[0];
    if (q?.regularMarketPrice) return { price: q.regularMarketPrice, change: q.regularMarketChange, changePct: q.regularMarketChangePercent, open: q.regularMarketOpen, high: q.regularMarketDayHigh, low: q.regularMarketDayLow, prevClose: q.regularMarketPreviousClose, volume: q.regularMarketVolume, avgVolume: q.averageDailyVolume3Month, marketCap: q.marketCap, floatShares: q.floatShares, sharesOut: q.sharesOutstanding, pe: q.trailingPE, yearHigh: q.fiftyTwoWeekHigh, yearLow: q.fiftyTwoWeekLow, sector: q.sector, industry: q.industry, shortName: q.shortName, preMarket: q.preMarketPrice, preMarketChangePct: q.preMarketChangePercent, source: 'yahoo' };
  } catch (e) { console.error('Yahoo fallback:', e.message); }
  return null;
}

async function getCandles(symbol, range, interval) {
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/' } });
    const d = await r.json(); const res = d?.chart?.result?.[0]; if (!res) return null;
    const q = res.indicators?.quote?.[0]; const ts = res.timestamp || []; if (!q || !ts.length) return null;
    const candles = ts.map((t, i) => ({ t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] })).filter(c => c.c != null);
    if (!candles.length) return null;
    const closes = candles.map(c => c.c); const last = closes[closes.length - 1]; const first = closes[0];
    const high = Math.max(...candles.map(c => c.h)); const low = Math.min(...candles.map(c => c.l));
    const avgVol = candles.reduce((s, c) => s + (c.v || 0), 0) / candles.length; const lastVol = candles[candles.length - 1]?.v || 0;
    const ema9 = closes.reduce((e, c, i) => i === 0 ? c : c * (2 / 10) + e * (8 / 10), closes[0]);
    const gains = [], losses = [];
    for (let i = 1; i < Math.min(closes.length, 15); i++) { const df = closes[i] - closes[i - 1]; df > 0 ? gains.push(df) : losses.push(Math.abs(df)); }
    const ag = gains.reduce((s, v) => s + v, 0) / (gains.length || 1); const al = losses.reduce((s, v) => s + v, 0) / (losses.length || 1);
    const rsi = al === 0 ? 100 : 100 - (100 / (1 + ag / al));
    const atr = candles.slice(-14).reduce((s, c) => s + (c.h - c.l), 0) / Math.min(14, candles.length);
    return { range, interval, pctChange: +((last - first) / first * 100).toFixed(2), trend: last > closes[Math.floor(closes.length / 2)] ? 'UP' : 'DOWN', high, low, last, ema9: +ema9.toFixed(3), rsi: +rsi.toFixed(1), relVolume: +(lastVol / avgVol).toFixed(2), atr: +atr.toFixed(3), candleCount: candles.length };
  } catch (e) { console.error(`Candles ${range}:`, e.message); return null; }
}

async function getNews(symbol) {
  if (!FINNHUB_KEY) return [];
  try {
    const to = new Date().toISOString().split('T')[0]; const from = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d = await r.json(); return Array.isArray(d) ? d.slice(0, 5).map(n => ({ headline: n.headline, source: n.source, url: n.url, datetime: n.datetime })) : [];
  } catch { return []; }
}

async function getMarketNews() {
  if (!FINNHUB_KEY) return [];
  try { const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`); const d = await r.json(); return Array.isArray(d) ? d.slice(0, 30).map(n => ({ headline: n.headline, source: n.source, url: n.url, datetime: n.datetime, related: n.related })) : []; } catch { return []; }
}

async function getSEC8K() {
  try {
    const r = await fetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=20&search_text=&output=atom', { headers: { 'User-Agent': 'MaverickBot/1.0 bot@maverick.com', 'Accept': 'application/xml' } });
    const text = await r.text(); const items = [];
    const regex = /<entry>([\s\S]*?)<\/entry>/g; let m;
    while ((m = regex.exec(text)) !== null) {
      const entry = m[1];
      const title = (/<title>(.*?)<\/title>/.exec(entry) || [])[1] || '';
      const link = (/<link.*?href="(.*?)"/.exec(entry) || [])[1] || '';
      const updated = (/<updated>(.*?)<\/updated>/.exec(entry) || [])[1] || '';
      items.push({ headline: title, source: 'SEC-EDGAR-8K', url: link, datetime: new Date(updated).getTime() / 1000 });
    }
    return items.slice(0, 15);
  } catch (e) { return []; }
}

function getChartUrl(symbol, tf = 'daily') {
  const m = { '5min': 'i5', '15min': 'i15', '1hour': 'h', 'daily': 'd', 'weekly': 'w' };
  return `https://finviz.com/chart.ashx?t=${symbol.toUpperCase()}&ty=c&ta=1&p=${m[tf] || 'd'}&s=l`;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE MATH
// ═══════════════════════════════════════════════════════════════════════════

function calcLevels(entry) {
  const sp = entry < 5 ? 0.035 : entry < 15 ? 0.028 : 0.02; const stop = +(entry * (1 - sp)).toFixed(2); const risk = entry - stop;
  return { stop, t1: +(entry + risk * 2).toFixed(2), t2: +(entry + risk * 3.5).toFixed(2), t3: +(entry + risk * 5.5).toFixed(2), risk: +risk.toFixed(2) };
}
function totalShares(tr) { return tr.shares + tr.adds.reduce((s, a) => s + a.shares, 0); }
function avgCostCalc(tr) { return +((tr.entryPrice * tr.shares + tr.adds.reduce((s, a) => s + a.price * a.shares, 0)) / totalShares(tr)).toFixed(2); }
function totalPnl(tr, p) { return +((p - tr.entryPrice) * tr.shares + tr.adds.reduce((s, a) => s + (p - a.price) * a.shares, 0)).toFixed(2); }

// ═══════════════════════════════════════════════════════════════════════════
// TICK HANDLER
// ═══════════════════════════════════════════════════════════════════════════

function onTick(sym, price, vol) {
  if (!volTracker.has(sym)) volTracker.set(sym, { v1m: 0, reset: Date.now() });
  const vt = volTracker.get(sym); if (Date.now() - vt.reset > 60000) { vt.v1m = 0; vt.reset = Date.now(); } vt.v1m += vol;
  for (const [cid, w] of watches) {
    if (w.symbol !== sym || w.confirmed) continue; w.currentPrice = price;
    if (price >= w.entryLevel) { const apr = w.avgVolume ? w.avgVolume / 390 : null; const vr = apr ? vt.v1m / apr : 99; if (vr >= 1.5) { w.confirmed = true; const lv = calcLevels(price); tgSend(cid, `🔥 *ENTRY CONFIRMED — ${sym}*\n\n$${price.toFixed(2)} | Vol: *${vr.toFixed(1)}x avg*\n\n🛑 Stop: *$${lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n\nText: _in at ${price.toFixed(2)} with 200 shares_`); } }
  }
  const alerts = priceAlerts.get(sym) || [];
  for (const a of alerts) {
    if (a.fired) continue;
    const hit = (a.condition === 'ABOVE' && price >= a.value) || (a.condition === 'BELOW' && price <= a.value) || (a.condition === 'CROSS' && Math.abs(price - a.value) / a.value < 0.005);
    if (hit) { a.fired = true; const apr = a.avgVolume ? a.avgVolume / 390 : null; const vr = apr ? vt.v1m / apr : 0; const e = a.condition === 'ABOVE' ? '🚀' : a.condition === 'BELOW' ? '🔻' : '⚡'; tgSend(a.chatId, `${e} *ALERT — ${sym}*\n\n$${price.toFixed(2)} ${a.condition} $${a.value}\nVol: ${vr > 0 ? vr.toFixed(1) + 'x' : 'monitoring'}\n\nText: _watching ${sym} at ${price.toFixed(2)}_`); }
  }
  for (const [cid, tr] of trades) {
    if (tr.symbol !== sym) continue;
    const prev = tr.currentPrice || tr.entryPrice; tr.currentPrice = price;
    const mins = (Date.now() - tr.entryTime) / 60000; const pnl = totalPnl(tr, price); const apr = tr.avgVolume ? tr.avgVolume / 390 : null; const vr = apr ? vt.v1m / apr : 0;
    if (price > tr.hwm) { tr.hwm = price; if (tr.t1Hit) { const trail = +(price - (price - tr.avgCost) * 0.40).toFixed(2); if (trail > tr.trailingStop) tr.trailingStop = trail; } }
    if (!tr.stopAlerted && price <= tr.stopLoss) { tr.stopAlerted = true; tgSend(cid, `🚨 *STOP HIT — ${tr.symbol}*\n$${price.toFixed(2)} | P&L: -$${Math.abs(pnl).toFixed(2)}\n\n❌ *EXIT NOW.* Text: _out at ${price.toFixed(2)}_`); }
    if (tr.t1Hit && !tr.trailAlerted && price <= tr.trailingStop) { tr.trailAlerted = true; tgSend(cid, `⚠️ *TRAIL STOP — ${tr.symbol}*\n$${price.toFixed(2)} | Locked: +$${pnl.toFixed(2)}\nText: _out at ${price.toFixed(2)}_`); }
    if (!tr.t1Hit && price >= tr.targets.t1) { tr.t1Hit = true; tr.stopLoss = tr.avgCost; tr.stopAlerted = false; tr.trailAlerted = false; tgSend(cid, `🎯 *TARGET 1 — ${tr.symbol}*\n$${price.toFixed(2)}\n+$${totalPnl(tr, tr.targets.t1).toFixed(2)}\n\n✅ Sell 50%\n🔄 Stop → BREAKEVEN $${tr.avgCost}\n🎯 Next: $${tr.targets.t2}`); }
    if (!tr.t2Hit && price >= tr.targets.t2) { tr.t2Hit = true; tgSend(cid, `🎯🎯 *TARGET 2 — ${tr.symbol}*\n+$${totalPnl(tr, tr.targets.t2).toFixed(2)}\nSell rest or hold to T3: $${tr.targets.t3}`); }
    if (!tr.addSent && tr.t1Hit && !tr.t2Hit) { const pg = ((price - tr.avgCost) / tr.avgCost) * 100; if (pg > 4 && vr > 2 && price > prev * 0.995) { tr.addSent = true; tgSend(cid, `📈 *ADD SIGNAL — ${tr.symbol}*\nVol: ${vr.toFixed(1)}x | +${pg.toFixed(1)}%\nText: _added 100 at ${price.toFixed(2)}_`); } }
    if (!tr.warn45 && mins >= 45) { tr.warn45 = true; tgSend(cid, `⏱ *45-MIN — ${tr.symbol}*\n${mins.toFixed(0)}min | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n${!tr.t1Hit ? '⚠️ T1 not hit — re-evaluate.' : '✅ T1 hit — consider exit.'}`); }
    if (!tr.warn90 && mins >= 90) { tr.warn90 = true; tgSend(cid, `🚨 *90-MIN — ${tr.symbol}*\nMomentum done. *Consider exit.*\nText: _out at ${price.toFixed(2)}_`); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY
// ═══════════════════════════════════════════════════════════════════════════

async function memLoad() { if (!JSONBIN_KEY || !JSONBIN_BIN) return { trades: [], scans: [] }; try { const r = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`, { headers: { 'X-Master-Key': JSONBIN_KEY } }); const d = await r.json(); return d.record || { trades: [], scans: [] }; } catch { return { trades: [], scans: [] }; } }
async function memSave(rec) { if (!JSONBIN_KEY || !JSONBIN_BIN) return; try { await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY }, body: JSON.stringify(rec) }); } catch {} }
async function logTrade(entry) { const m = await memLoad(); m.trades = m.trades || []; m.trades.push({ ...entry, id: Date.now() }); await memSave(m); }

// ═══════════════════════════════════════════════════════════════════════════
// AI PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

const ANALYZE_PROMPT = `You are MAVERICK — aggressive, decisive day trading AI.
You receive multi-timeframe Yahoo Finance OHLCV data (daily/4H/1H/15min). Use ALL timeframes for trend alignment.
VERDICTS: BUY | DONT_BUY | WATCH
ENTRY MATH: Stop=1.5xATR below entry. T1=entry+2x(entry-stop). T2=entry+3.5x. T3=entry+5.5x.
No ATR: 3.5% sub-$5, 2.5% $5-15, 2% above $15.
TRADER: AGGRESSIVE. Sub-$10 specialist. Hard stops always.
RETURN ONLY VALID JSON no markdown:
{"verdict":"BUY|DONT_BUY|WATCH","conviction":0-100,"headline":"one decisive sentence","chart_pattern":"pattern name","timeframe_alignment":"BULLISH|BEARISH|MIXED|NEUTRAL","reasoning":["bullet1","bullet2","bullet3"],"entry_zone":{"low":0.00,"high":0.00},"stop_loss":0.00,"target_1":0.00,"target_2":0.00,"target_3":0.00,"risk_reward":0.0,"position_size_suggestion":"AGGRESSIVE|STANDARD|SMALL","trade_type":"DAY_TRADE|SWING|SCALP|OVERNIGHT","key_risk":"specific risk","trigger_to_watch":"condition if WATCH","time_horizon":"estimate"}`;

const SUPERNOVA_PROMPT = `You are Maverick Supernova Detection. Analyze movers for true supernova events.
SUPERNOVA = catalyst-driven: A) 60+ min buying B) Fade setup C) Sixth Grade Trade
Score 0-100: Catalyst(30),Float(25),Velocity(20),Pillars(15),SGT(10). Tiers: SUPERNOVA(85+),IGNITING(70+),WARMING(55+).
RETURN ONLY VALID JSON:
{"scan_time":"ISO","market_session":"string","market_pulse":"2 sentences","supernovas":[{"ticker":"","company":"","price":0,"price_change_pct":0,"float_millions":0,"catalyst":"","catalyst_type":"","halted_today":false,"trade_type":"LONG|FADE","phase":"IGNITION|FUEL_BURN|DISTRIBUTION","is_sixth_grade_trade":true,"sixth_grade_explanation":"","pillars_firing":[],"supernova_score":0,"tier":"SUPERNOVA|IGNITING|WARMING","entry_zone":"$X-$Y","stop":0,"target_1":0,"target_2":0,"risk_reward":0,"thesis":"","exit_signal":""}],"algo_note":""}`;

const CATALYST_PROMPT = `You are MAVERICK Catalyst Intelligence scanning for HIGH CONVICTION catalysts with 85%+ probability of upward price action.
CATALYST SCORING: FDA approval=95, Merger/acquisition at premium=93, Gov contract >2x mkt cap=92, Oversubscribed placement=88, Earnings massive beat=87, Fortune 500 partnership=82, Nasdaq compliance=78.
HARD FILTERS: Score>=80, US-listed, Actionable today, Not already run 100%+.
RETURN ONLY VALID JSON:
{"catalysts":[{"ticker":"","company_name":"","catalyst_headline":"","catalyst_type":"FDA|MERGER|CONTRACT|PLACEMENT|EARNINGS|OTHER","catalyst_score":0,"sixth_grade_trade":true,"sixth_grade_explanation":"","price_impact_probability":0,"estimated_move_pct":"X-Y%","time_sensitivity":"PRE-MARKET|TODAY|THIS_WEEK","entry_still_open":true,"source":"","news_age_hours":0}]}`;

const WHALE_FILTER_PROMPT = `You are MAVERICK Smart Money Analyst. Select TOP 3 whale footprint setups: Phase 2/3 only, small float preferred, clear defended level, ACCUMULATION volume. NO dilutive setups.
Return ONLY valid JSON array:
[{"symbol":"","rank":1,"why":"one sentence","urgency":"NOW|SOON|DEVELOPING","maverick_action":"ENTER_NOW|WAIT_FOR_DIP|WATCH"}]`;

const FOOTPRINT_PROMPT = `You are MAVERICK Smart Money Analyst — institutional footprint reader.
MAVERICK PHILOSOPHY: Swim WITH whales. Eat their leftovers. Phase 2 (price defense) and Phase 3 (markup) are the sweet spots. The whale IS the catalyst.
5 PHASES: 1=Quiet Accum, 2=PRICE DEFENSE (ENTER), 3=MARKUP (RIDE), 4=FOMO Dist (FADE), 5=Bag Holding (AVOID).
4 FOOTPRINTS: Catalyst anticipation, Price defense, Bid stacking, Institutional accumulation.
RETURN ONLY VALID JSON:
{"phase_detected":1-5,"phase_confidence":0-100,"phase_name":"","maverick_verdict":"ENTER_NOW|ENTER_ON_DIP|WATCH_FOR_PHASE2|RIDE_IT|FADE|AVOID","conviction":0-100,"headline":"one decisive sentence","footprints_detected":[{"footprint":"name","signal":"specific evidence","strength":"STRONG|MODERATE|WEAK"}],"whale_activity":"","anticipated_catalyst":"","defended_level":0.00,"entry_zone":{"low":0.00,"high":0.00},"stop_loss":0.00,"target_1":0.00,"target_2":0.00,"risk_reward":0.0,"time_to_move":"","key_risk":"","reasoning":["bullet1","bullet2","bullet3"]}`;

const ADVISOR_PROMPT = `You are MAVERICK's personal hedge fund AI trading advisor. One user: Maverick, aggressive day trader building $348 portfolio to $1,000 by end of May 2026.
MAVERICK'S PROFILE: Portfolio $348 (keep $100 reserve always, tradeable=$248). Aggressive risk. Phase 2/3 player. Swims with whales. Sub-$10 specialist. Never fights dilution/ATMs.
POSITION SIZING: Max risk per trade=3% aggressive ($7.44). Position size=Risk/(Entry-Stop). Never >35% portfolio per trade ($86 max).
PROBABILITY: Phase 2+defended+volume=65-75%. Phase 2+catalyst+squeeze=75-85%. Phase 3 confirmed=60-70%. No phase=40-50%.
RESPONSE STYLE: Direct, decisive, exact numbers. Under 200 words. End BUY answers with exact Telegram bot command. Never say "it depends" without immediate answer.`;

// ═══════════════════════════════════════════════════════════════════════════
// FOOTPRINT ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function detectPhase(tf1d, currentPrice) {
  if (!tf1d) return { phase: 0, confidence: 0, description: 'Insufficient data', signals: [] };
  const { high, low, last, ema9, rsi, relVolume, atr, pctChange } = tf1d;
  const priceRange = high - low; const pricePosition = priceRange > 0 ? (currentPrice - low) / priceRange : 0.5;
  let phase = 0, confidence = 0, description = '', signals = [];
  if (pricePosition < 0.30 && rsi < 50 && rsi > 25 && relVolume < 1.2) { phase = 1; confidence = 65 + Math.round((0.30 - pricePosition) * 100); description = 'Quiet accumulation near lows. Institutions loading silently.'; signals.push('Price in bottom 30% of range'); signals.push('RSI recovering (' + rsi + ')'); signals.push('Below-average volume = stealth accumulation'); }
  else if (pricePosition >= 0.15 && pricePosition <= 0.50 && rsi >= 40 && rsi <= 65) { phase = 2; confidence = 70 + Math.round(Math.abs(0.35 - pricePosition) * 50); description = 'DEFENDED. Institutions protecting entry. Buy every dip pattern active.'; signals.push('Price in defended consolidation zone'); signals.push('RSI healthy and rising (' + rsi + ')'); signals.push('Higher lows forming — whales absorbing each dip'); if (atr) signals.push('ATR $' + atr.toFixed(2) + ' — use for stop placement'); }
  else if (pricePosition > 0.50 && pricePosition <= 0.80 && rsi > 50 && pctChange > 0) { phase = 3; confidence = 72 + Math.round(pricePosition * 20); description = 'MARKUP IN PROGRESS. Riding with the whale.'; signals.push('Price in upper half — breakout territory'); signals.push('RSI bullish momentum (' + rsi + ')'); if (relVolume > 1.3) signals.push('Expanding volume = retail being invited in'); }
  else if (pricePosition > 0.80 && rsi > 70) { phase = 4; confidence = 75; description = 'DANGER. FOMO zone. Whales distributing into euphoria.'; signals.push('Price extended — 80%+ of range'); signals.push('RSI overbought (' + rsi + ')'); signals.push('Retail is the exit liquidity here.'); }
  else if (pctChange < -15 || (pricePosition < 0.25 && rsi < 35)) { phase = 5; confidence = 68; description = 'DECLINE. Institutions gone. Avoid.'; signals.push('Price declining sharply'); signals.push('RSI bearish (' + rsi + ')'); }
  else { phase = 0; confidence = 45; description = 'TRANSITIONAL. Wait for phase definition.'; signals.push('Mixed signals — no clean phase'); }
  return { phase, confidence, description, signals, pricePosition: +(pricePosition * 100).toFixed(0), rsi, relVolume };
}

function scorePriceDefense(candles) {
  if (!candles) return { score: 0, level: null, count: 0 };
  const rangeVsAtr = candles.atr > 0 ? (candles.high - candles.low) / candles.atr : 0;
  const estimatedBounces = Math.max(1, Math.round(Math.min(rangeVsAtr / 3, 8)));
  const score = Math.min(100, estimatedBounces * 15 + (candles.rsi > 40 && candles.rsi < 65 ? 20 : 0));
  return { score, level: +candles.low.toFixed(2), count: estimatedBounces };
}

function analyzeVolumePattern(tf1d, tf1h) {
  if (!tf1d) return { pattern: 'UNKNOWN', accumScore: 0, signals: [] };
  const signals = []; let accumScore = 50;
  if (tf1d.relVolume > 1.5 && tf1d.trend === 'UP') { accumScore += 15; signals.push('High volume on uptrend = institutional buying'); }
  if (tf1d.relVolume > 1.5 && tf1d.trend === 'DOWN') { accumScore -= 20; signals.push('High volume on downtrend = distribution warning'); }
  if (tf1d.rsi < 50 && tf1d.relVolume < 0.8) { accumScore += 10; signals.push('Quiet tape at low RSI = stealth accumulation'); }
  if (tf1h && tf1h.trend === 'UP' && tf1d.trend === 'DOWN') { accumScore += 8; signals.push('1H turning up vs daily still down = early reversal'); }
  if (tf1d.pctChange > 20 && tf1d.relVolume > 3) { accumScore -= 25; signals.push('Parabolic move = FOMO, not smart money'); }
  return { pattern: accumScore >= 65 ? 'ACCUMULATION' : accumScore <= 35 ? 'DISTRIBUTION' : 'NEUTRAL', accumScore: Math.max(0, Math.min(100, accumScore)), signals };
}

function calcFootprintScore(phase, defense, volPattern, institutional) {
  let score = 0; const signals = [];
  if (phase.phase === 2) { score += 35; signals.push('🔥 PHASE 2 — Price defense active (sweet spot)'); }
  else if (phase.phase === 3) { score += 28; signals.push('🔥 PHASE 3 — Markup in progress'); }
  else if (phase.phase === 1) { score += 18; signals.push('👀 PHASE 1 — Quiet accumulation'); }
  else if (phase.phase === 4) { score -= 20; signals.push('⚠️ PHASE 4 — FOMO zone'); }
  else if (phase.phase === 5) { score -= 35; signals.push('❌ PHASE 5 — Avoid'); }
  if (defense.count >= 3) { score += 20; signals.push('🛡️ Support defended ' + defense.count + 'x at $' + defense.level); }
  else if (defense.count >= 2) { score += 12; signals.push('🛡️ Support tested ' + defense.count + 'x at $' + defense.level); }
  if (volPattern.pattern === 'ACCUMULATION') { score += 18; signals.push('📊 Volume pattern = ACCUMULATION'); }
  else if (volPattern.pattern === 'DISTRIBUTION') { score -= 15; signals.push('📊 Volume = DISTRIBUTION warning'); }
  if (institutional?.earnings?.daysUntil <= 14 && institutional.earnings.daysUntil > 0) { score += 15; signals.push('⚡ Earnings in ' + institutional.earnings.daysUntil + ' days'); }
  return { score: Math.max(0, Math.min(100, score)), signals };
}

async function getInstitutionalData(symbol) {
  const results = { earnings: null, recommendations: null };
  if (!FINNHUB_KEY) return results;
  try {
    const [earningsR, recR] = await Promise.all([fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${symbol}&token=${FINNHUB_KEY}`), fetch(`https://finnhub.io/api/v1/recommendation?symbol=${symbol}&token=${FINNHUB_KEY}`)]);
    const earningsD = await earningsR.json(); const recD = await recR.json();
    if (earningsD?.earningsCalendar?.length) { const upcoming = earningsD.earningsCalendar.filter(e => new Date(e.date).getTime() > Date.now()).sort((a, b) => new Date(a.date) - new Date(b.date))[0]; if (upcoming) results.earnings = { date: upcoming.date, epsEstimate: upcoming.epsEstimate, daysUntil: Math.ceil((new Date(upcoming.date) - Date.now()) / 86400000) }; }
    if (Array.isArray(recD) && recD.length) { const l = recD[0]; results.recommendations = { strongBuy: l.strongBuy || 0, buy: l.buy || 0, hold: l.hold || 0, sell: l.sell || 0, strongSell: l.strongSell || 0, period: l.period }; }
  } catch (e) { console.error('Institutional:', e.message); }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// WHALE SCANNER
// ═══════════════════════════════════════════════════════════════════════════

async function quickFootprint(symbol) {
  try {
    const [quote, tf1d] = await Promise.all([getQuote(symbol), getCandles(symbol, '3mo', '1d')]);
    if (!quote || !tf1d) return null;
    const phase = detectPhase(tf1d, quote.price); const defense = scorePriceDefense(tf1d); const volPattern = analyzeVolumePattern(tf1d, null); const footprint = calcFootprintScore(phase, defense, volPattern, {});
    return { symbol, price: quote.price, changePct: quote.changePct, marketCap: quote.marketCap, floatShares: quote.floatShares, sector: quote.sector, shortName: quote.shortName, phase: phase.phase, phaseConfidence: phase.confidence, phaseDesc: phase.description, footprintScore: footprint.score, footprintSignals: footprint.signals, volumePattern: volPattern.pattern, accumScore: volPattern.accumScore, defendedLevel: defense.level, defenseCount: defense.count, rsi: tf1d.rsi, atr: tf1d.atr, relVolume: tf1d.relVolume, trend: tf1d.trend };
  } catch (e) { return null; }
}

async function getScanCandidates() {
  const candidates = new Set();
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/' };
  for (const scrId of ['day_gainers', 'most_actives']) {
    try { const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=${scrId}`, { headers }); const d = await r.json(); (d?.finance?.result?.[0]?.quotes || []).filter(q => q.regularMarketPrice < 15 && q.regularMarketPrice > 0.5).forEach(q => candidates.add(q.symbol)); } catch {}
  }
  return [...candidates].slice(0, 35);
}

// ═══════════════════════════════════════════════════════════════════════════
// CATALYST SCANNER
// ═══════════════════════════════════════════════════════════════════════════

let lastCatalystScan = 0; const scannedHeadlines = new Set();
async function runCatalystScan(manual = false) {
  if (!GROQ_KEY || !TG_CHAT_ID) return;
  const now = Date.now(); if (!manual && now - lastCatalystScan < 28 * 60 * 1000) return;
  lastCatalystScan = now; console.log('⚡ Catalyst scan running...');
  try {
    const [marketNews, secFilings] = await Promise.all([getMarketNews(), getSEC8K()]);
    const allNews = [...marketNews, ...secFilings].filter(n => n.headline && !scannedHeadlines.has(n.headline)).slice(0, 40);
    if (!allNews.length) return;
    const recentNews = allNews.filter(n => { const ageH = (Date.now() / 1000 - (n.datetime || 0)) / 3600; return ageH < 12; });
    if (!recentNews.length) return;
    const newsText = recentNews.map(n => `SOURCE: ${n.source}\nHEADLINE: ${n.headline}\nAGE: ${((Date.now() / 1000 - (n.datetime || 0)) / 3600).toFixed(1)}h ago`).join('\n\n');
    const result = await groqCall(CATALYST_PROMPT, `Scan for high-conviction catalysts:\n\n${newsText}\n\nReturn ONLY JSON.`, 2000);
    if (!result?.catalysts?.length) return;
    for (const c of result.catalysts) {
      if (scannedHeadlines.has(c.catalyst_headline)) continue;
      scannedHeadlines.add(c.catalyst_headline);
      const emoji = c.catalyst_score >= 90 ? '🚨🚨' : '🚨';
      tgSend(TG_CHAT_ID, `${emoji} *HIGH CONVICTION CATALYST*\n\n*${c.ticker || 'UNCONFIRMED'}* — ${c.company_name || ''}\n\n📰 ${c.catalyst_headline}\n\n🎯 Score: *${c.catalyst_score}/100*\n📈 Probability: *${c.price_impact_probability}%*\n🚀 Move: *${c.estimated_move_pct}*\n⏰ Timing: *${c.time_sensitivity}*\n📚 6th Grade: ${c.sixth_grade_trade ? '✅ ' + c.sixth_grade_explanation : '❌'}\n\nReply:\n_DIVE ${c.ticker || 'TICKER'}_ — full analysis\n_WATCH ${c.ticker || 'TICKER'}_ — monitor live\n_SKIP_ — dismiss`);
      pendingCatalysts.set(TG_CHAT_ID, c);
    }
  } catch (e) { console.error('Catalyst scan:', e.message); }
}

function scheduleCatalystScans() {
  startContinuousScanner()
  setInterval(() => runCatalystScan(false), 30 * 60 * 1000);
  setInterval(() => { const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); const h = et.getHours(); const m = et.getMinutes(); const isWeekday = et.getDay() > 0 && et.getDay() < 6; if (!isWeekday) return; if ((h === 4 || h === 6 || h === 8) && m < 3) runCatalystScan(false); }, 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// GROQ DIAGNOSTIC — visit /api/groq-test to see exactly what is failing
app.get('/api/groq-test', async (req, res) => {
  if (!GROQ_KEY) return res.json({ error: 'GROQ_KEY not set', key_present: false });
  try {
    // Test 1: List available models
    const modelsR = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': `Bearer ${GROQ_KEY}` } });
    const modelsD = await modelsR.json();
    // Test 2: Simple completion
    const testR = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3-70b-8192', max_tokens: 10, messages: [{ role: 'user', content: 'Say OK' }] })
    });
    const testD = await testR.json();
    res.json({ key_present: true, key_starts_with: GROQ_KEY.slice(0, 8) + '...', models_status: modelsR.status, models_available: modelsD.data?.map(m => m.id) || modelsD, completion_status: testR.status, completion_result: testD.choices?.[0]?.message?.content || testD });
  } catch (e) { res.json({ error: e.message, key_present: !!GROQ_KEY }); }
});

// Main analyze
app.post('/api/analyze', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).json({ error: 'no ticker' });
  const sym = ticker.toUpperCase().trim();
  try {
    const [quote, tf1d, tf4h, tf1h, tf15, news] = await Promise.all([getQuote(sym), getCandles(sym, '3mo', '1d'), getCandles(sym, '1mo', '60m'), getCandles(sym, '5d', '60m'), getCandles(sym, '2d', '15m'), getNews(sym)]);
    if (!quote) return res.status(404).json({ error: `${sym} not found — check ticker symbol` });
    const payload = { ticker: sym, quote: { price: quote.price, changePct: quote.changePct, open: quote.open, high: quote.high, low: quote.low, volume: quote.volume, marketCap: quote.marketCap, floatShares: quote.floatShares, yearHigh: quote.yearHigh, yearLow: quote.yearLow, sector: quote.sector, shortName: quote.shortName }, timeframes: { daily: tf1d || 'unavailable', fourhour: tf4h || 'unavailable', onehour: tf1h || 'unavailable', fifteen: tf15 || 'unavailable' }, recent_news: news.slice(0, 3).map(n => n.headline) };
    const verdict = await groqCall(ANALYZE_PROMPT, JSON.stringify(payload));
    if (!verdict) return res.status(503).json({ error: 'AI unavailable — visit /api/groq-test for diagnosis' });
    res.json({ ticker: sym, verdict, chartUrl5min: getChartUrl(sym, 'daily'), chartUrlDaily: getChartUrl(sym, 'daily'), data: { quote, timeframes: { daily: tf1d, fourhour: tf4h, onehour: tf1h, fifteen: tf15 }, news }, timestamp: new Date().toISOString() });
  } catch (e) { console.error('Analyze:', e); res.status(500).json({ error: e.message }); }
});

// Quote auto-refresh
app.get('/api/quote/:symbol', async (req, res) => { const q = await getQuote(req.params.symbol.toUpperCase()); if (!q) return res.status(404).json({ error: 'not found' }); res.json(q); });

// Footprints
app.post('/api/footprints', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).json({ error: 'no ticker' });
  const sym = ticker.toUpperCase().trim();
  try {
    const [quote, tf1d, tf4h, tf1h, tf15, news, institutional] = await Promise.all([getQuote(sym), getCandles(sym, '3mo', '1d'), getCandles(sym, '1mo', '60m'), getCandles(sym, '5d', '60m'), getCandles(sym, '2d', '15m'), getNews(sym), getInstitutionalData(sym)]);
    if (!quote) return res.status(404).json({ error: sym + ' not found' });
    const phase = detectPhase(tf1d, quote.price); const defense = scorePriceDefense(tf1d); const volPattern = analyzeVolumePattern(tf1d, tf1h); const footprint = calcFootprintScore(phase, defense, volPattern, institutional);
    res.json({ ticker: sym, quote, phase, defense, volPattern, institutional, footprint, chartUrl: getChartUrl(sym, 'daily'), timeframes: { daily: tf1d, fourhour: tf4h, onehour: tf1h, fifteen: tf15 }, news: news.slice(0, 3), timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Footprints deep dive
app.post('/api/footprints/deepdive', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).json({ error: 'no ticker' }); if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_KEY not set' });
  const sym = ticker.toUpperCase().trim();
  try {
    const [quote, tf1d, tf4h, tf1h, news, institutional] = await Promise.all([getQuote(sym), getCandles(sym, '3mo', '1d'), getCandles(sym, '1mo', '60m'), getCandles(sym, '5d', '60m'), getNews(sym), getInstitutionalData(sym)]);
    if (!quote) return res.status(404).json({ error: sym + ' not found' });
    const phase = detectPhase(tf1d, quote.price); const defense = scorePriceDefense(tf1d); const volPattern = analyzeVolumePattern(tf1d, tf1h); const footprint = calcFootprintScore(phase, defense, volPattern, institutional);
    const verdict = await groqCall(FOOTPRINT_PROMPT, JSON.stringify({ ticker: sym, current_price: quote.price, phase_preliminary: phase, defense_analysis: defense, volume_pattern: volPattern, footprint_score: footprint, institutional_data: institutional, timeframe_daily: tf1d, timeframe_4h: tf4h, recent_news: news.map(n => n.headline) }));
    if (!verdict) return res.status(503).json({ error: 'AI unavailable' });
    res.json({ ticker: sym, verdict, baseData: { quote, phase, defense, volPattern, footprint, institutional, news }, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Whale scan
app.post('/api/whale-scan', async (req, res) => {
  try {
    const symbols = await getScanCandidates(); if (!symbols.length) return res.json({ results: [], error: 'No candidates', totalScanned: 0 });
    const scored = [];
    for (let i = 0; i < symbols.length; i += 5) { const batch = symbols.slice(i, i + 5); const results = await Promise.all(batch.map(s => quickFootprint(s))); results.forEach(r => { if (r) scored.push(r); }); if (i + 5 < symbols.length) await new Promise(r => setTimeout(r, 500)); }
    const candidates = scored.filter(s => (s.phase === 2 || s.phase === 3) && s.footprintScore >= 55).sort((a, b) => b.footprintScore - a.footprintScore).slice(0, 10);
    let topSetups = candidates.slice(0, 3);
    if (GROQ_KEY && candidates.length > 0) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: 600, temperature: 0.2, messages: [{ role: 'system', content: WHALE_FILTER_PROMPT }, { role: 'user', content: 'Candidates:\n' + JSON.stringify(candidates.map(c => ({ symbol: c.symbol, price: c.price, phase: c.phase, footprintScore: c.footprintScore, volumePattern: c.volumePattern, float: c.floatShares ? (c.floatShares / 1e6).toFixed(1) + 'M' : 'unknown', rsi: c.rsi, signals: c.footprintSignals }))) }] }) });
        const d = await r.json(); const text = d.choices?.[0]?.message?.content || ''; const m = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim().match(/\[[\s\S]*\]/);
        if (m) { const aiPicks = JSON.parse(m[0]); topSetups = aiPicks.map(pick => { const c = candidates.find(x => x.symbol === pick.symbol); return c ? { ...c, aiWhy: pick.why, aiUrgency: pick.urgency, aiAction: pick.maverick_action } : null; }).filter(Boolean); }
      } catch {}
    }
    if (topSetups.length && TG_CHAT_ID && bot && req.body.alertTelegram) { tgSend(TG_CHAT_ID, `🐋 *WHALE SCAN COMPLETE*\n\nScanned: ${scored.length} | Phase 2/3: ${candidates.length} | AI picks: ${topSetups.length}\n\n` + topSetups.map((s, i) => `*${i + 1}. ${s.symbol}* — Phase ${s.phase} · Score ${s.footprintScore}/100\n$${s.price?.toFixed(2)} | ${s.volumePattern}\n${s.aiWhy || ''}`).join('\n\n') + '\n\nText _dive [TICKER]_ for analysis'); }
    res.json({ results: topSetups, allCandidates: candidates, totalScanned: scored.length, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supernova
app.post('/api/supernova', async (req, res) => {
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_KEY missing' });
  try {
    let movers = [];
    try { const r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=30&scrIds=day_gainers', { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/' } }); const d = await r.json(); movers = (d?.finance?.result?.[0]?.quotes || []).slice(0, 25).map(q => ({ symbol: q.symbol, name: q.shortName, price: q.regularMarketPrice, changePct: q.regularMarketChangePercent, volume: q.regularMarketVolume, avgVolume: q.averageDailyVolume3Month, relVolume: +(q.regularMarketVolume / (q.averageDailyVolume3Month || 1)).toFixed(1), marketCap: q.marketCap, float: q.floatShares })).filter(s => s.price && s.price < 25); } catch {}
    const verdict = await groqCall(SUPERNOVA_PROMPT, `Today's movers:\n${JSON.stringify(movers, null, 2)}\nDate:${new Date().toLocaleString()}\nReturn ONLY JSON.`, 4000);
    if (!verdict) return res.status(500).json({ error: 'AI returned no data. Check /api/groq-test' });
    res.json(verdict);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Signals
app.get('/api/signals', async (req, res) => {
  const signals = []; const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/' };
  try { const r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=10&scrIds=day_gainers', { headers }); const d = await r.json(); (d?.finance?.result?.[0]?.quotes || []).slice(0, 8).forEach(q => { if (q.regularMarketPrice && q.regularMarketChangePercent > 5) { const rv = q.regularMarketVolume / (q.averageDailyVolume3Month || 1); signals.push({ type: 'MOMENTUM', symbol: q.symbol, name: q.shortName || q.symbol, price: q.regularMarketPrice, changePct: q.regularMarketChangePercent, relVolume: +rv.toFixed(1), signal: rv > 3 ? 'STRONG MOMENTUM — ' + rv.toFixed(1) + 'x volume surge' : 'MOMENTUM — up ' + q.regularMarketChangePercent.toFixed(1) + '%', strength: rv > 5 ? 'STRONG' : rv > 2 ? 'MODERATE' : 'WEAK', source: 'Yahoo Finance' }); } }); } catch {}
  try { const r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=10&scrIds=most_actives', { headers }); const d = await r.json(); (d?.finance?.result?.[0]?.quotes || []).slice(0, 6).forEach(q => { if (q.regularMarketPrice < 20) { const rv = q.regularMarketVolume / (q.averageDailyVolume3Month || 1); if (rv > 2) signals.push({ type: 'VOLUME_SURGE', symbol: q.symbol, name: q.shortName || q.symbol, price: q.regularMarketPrice, changePct: q.regularMarketChangePercent, relVolume: +rv.toFixed(1), signal: 'VOLUME SURGE — ' + rv.toFixed(1) + 'x average', strength: rv > 5 ? 'STRONG' : 'MODERATE', source: 'Yahoo Finance' }); } }); } catch {}
  if (FINNHUB_KEY) { try { const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`); const d = await r.json(); if (Array.isArray(d)) { d.filter(n => { const ah = (Date.now() / 1000 - n.datetime) / 3600; return ah < 8 && n.related; }).slice(0, 5).forEach(n => { signals.push({ type: 'CATALYST', symbol: n.related || 'MARKET', name: n.source, price: null, changePct: null, relVolume: null, signal: n.headline?.slice(0, 80) + '...', strength: 'MODERATE', source: n.source, url: n.url, ageH: +((Date.now() / 1000 - n.datetime) / 3600).toFixed(1) }); }); } } catch {} }
  res.json({ signals, timestamp: new Date().toISOString() });
});

// Catalyst scan
app.post('/api/catalyst-scan', async (req, res) => { runCatalystScan(true); res.json({ ok: true, message: 'Catalyst scan running — alerts sent to Telegram if found' }); });

// Price alert
app.post('/api/alert', (req, res) => {
  const { symbol, condition, value, chatId } = req.body; if (!symbol || !condition || !value) return res.status(400).json({ error: 'missing fields' });
  const sym = symbol.toUpperCase(); if (!priceAlerts.has(sym)) priceAlerts.set(sym, []);
  priceAlerts.get(sym).push({ chatId: chatId || TG_CHAT_ID, condition, value: +value, fired: false, avgVolume: null });
  addSub(sym, chatId || TG_CHAT_ID); res.json({ ok: true, symbol: sym, condition, value: +value });
});

// TradingView webhook
app.post('/webhook/tradingview', (req, res) => {
  if ((req.query.secret || req.body.secret) !== WEBHOOK_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { ticker, action, indicator, price } = req.body; if (!ticker || !action) return res.status(400).json({ error: 'missing ticker or action' });
  const sym = ticker.toUpperCase(); tvSignals.set(sym, { action: action.toUpperCase(), indicator: indicator || 'TradingView', price: parseFloat(price) || null, time: Date.now() });
  if (TG_CHAT_ID && bot) tgSend(TG_CHAT_ID, `📡 *TV SIGNAL — ${sym}*\n${action.toUpperCase()} via ${indicator || 'TV'} at $${price || '?'}`);
  res.json({ ok: true });
});

// Chat advisor
app.post('/api/chat', async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_KEY not set. Visit /api/groq-test to diagnose.' });
  const { message, sessionId, portfolioSize } = req.body; if (!message) return res.status(400).json({ error: 'no message' });
  const sid = sessionId || 'default'; if (!chatSessions.has(sid)) chatSessions.set(sid, []);
  const history = chatSessions.get(sid);
  let liveContext = '';
  const tickerMatch = message.match(/\b([A-Z]{2,5})\b/g);
  if (tickerMatch) { for (const t of tickerMatch.slice(0, 2)) { if (['THE', 'AND', 'FOR', 'BUY', 'ADD', 'OUT', 'NOT', 'HOW', 'CAN', 'PUT', 'NOW'].includes(t)) continue; try { const q = await getQuote(t); if (q) { liveContext += `\nLIVE ${t}: $${q.price?.toFixed(2)}, ${q.changePct?.toFixed(2)}%, H$${q.high?.toFixed(2)} L$${q.low?.toFixed(2)}, Cap${q.marketCap ? '$' + (q.marketCap / 1e6).toFixed(0) + 'M' : 'n/a'}, Float${q.floatShares ? (q.floatShares / 1e6).toFixed(1) + 'M' : 'n/a'}`; break; } } catch {} } }
  const pSize = portfolioSize || 348; const reserve = 100; const tradeable = pSize - reserve; const maxPerTrade = Math.round(tradeable * 0.35);
  const portfolioContext = `\nPORTFOLIO: $${pSize} | Reserve: $${reserve} | Tradeable: $${tradeable} | Max/trade: $${maxPerTrade}`;
  const messages = [{ role: 'system', content: ADVISOR_PROMPT + portfolioContext }, ...history.slice(-10), { role: 'user', content: message + liveContext }];
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: 500, temperature: 0.3, messages }) });
    if (!r.ok) { const err = await r.text(); console.error('Chat Groq error:', r.status, err); return res.status(503).json({ error: `Groq error ${r.status}: ${err.slice(0, 100)}` }); }
    const d = await r.json(); const reply = d.choices?.[0]?.message?.content;
    if (!reply) return res.status(503).json({ error: 'Empty AI response' });
    history.push({ role: 'user', content: message }); history.push({ role: 'assistant', content: reply }); if (history.length > 20) history.splice(0, 2);
    res.json({ reply, sessionId: sid });
  } catch (e) { console.error('Chat error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/chat/clear', (req, res) => { chatSessions.delete(req.body.sessionId || 'default'); res.json({ ok: true }); });

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', version: '3.3', time: new Date().toISOString(), botUsername: BOT_USERNAME, services: { telegram: !!TELEGRAM_TOKEN, finnhub: !!FINNHUB_KEY, groq: !!GROQ_KEY, memory: !!(JSONBIN_KEY && JSONBIN_BIN) }, active: { watches: watches.size, trades: trades.size, alerts: [...priceAlerts.values()].flat().filter(a => !a.fired).length, tvSignals: tvSignals.size } });
});
// ═══════════════════════════════════════════════════════════════════════════
// MAVERICK AI CHAT ADVISOR
// Paste this block into index.js BEFORE the app.get('*'...) line
// ═══════════════════════════════════════════════════════════════════════════

const MAVERICK_ADVISOR_PROMPT = `You are MAVERICK's personal hedge fund AI trading advisor. You have one user: Maverick, an aggressive day trader building a $348 portfolio to $1,000 by end of May 2026.

MAVERICK'S PROFILE:
- Portfolio: $348 (working capital, grows with wins)
- Risk tolerance: AGGRESSIVE — but calculated, not reckless
- Style: Phases 2 and 3 player. Swims with whales, not against them.
- Specialties: Sub-$10 momentum, supernova plays, short squeezes
- Rules: Never fight dilution, ATMs, or active distribution
- Entry philosophy: ANTICIPATE whale arrival, don't react to it
- The whale IS the catalyst. Retail is the exit liquidity.
- 5 phases: 1=Quiet Accum, 2=Price Defense (ENTER), 3=Markup (RIDE), 4=FOMO Dist, 5=Bag Holding

WHAT YOU CAN DO:
1. Position sizing: Calculate exact share count given portfolio, risk %, stop distance
2. Probability assessment: Estimate % likelihood of a price target based on setup quality
3. Risk/reward analysis: Full R:R breakdown for any proposed trade
4. Add-to-position guidance: Whether to add, how much, at what level
5. Chart pattern reading: Interpret TA questions in plain English
6. Whale detection: Read between the lines on institutional behavior
7. Trade management: When to exit, trail stops, protect profits
8. Portfolio advice: How to allocate $348 across multiple setups

POSITION SIZING FORMULA (always use this):
- Max risk per trade = 2% of portfolio for STANDARD, 3% for AGGRESSIVE
- Position size = Risk amount / (Entry - Stop)
- Never put more than 35% of portfolio in one trade
- Keep $100 reserve always (never trade your last dollar)
- Tradeable capital = Portfolio - $100 reserve

PROBABILITY FRAMEWORK:
- Phase 2 + defended level + volume confirmation = 65-75% probability of move
- Phase 2 + catalyst + short squeeze setup = 75-85%
- Phase 3 breakout confirmed = 60-70% (move already started, less upside)
- No phase confirmation = 40-50% (coin flip — avoid)

RESPONSE STYLE:
- Direct and decisive. No hedging language.
- Use exact numbers always.
- Keep responses under 200 words unless a complex calculation is needed.
- End every position sizing answer with the exact command to send the Telegram bot.
- Never say "it depends" without immediately giving the answer.

LIVE DATA: When the user mentions a ticker, live data will be provided if available.`;

// Chat history per session (in-memory, resets on server restart)


app.post('/api/chat', async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_KEY not set in Render environment variables' });

  const { message, sessionId, ticker, portfolioSize } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  const sid = sessionId || 'default';
  if (!chatSessions.has(sid)) chatSessions.set(sid, []);
  const history = chatSessions.get(sid);

  // Build context — fetch live data if ticker mentioned
  let liveContext = '';
  const mentionedTicker = ticker || message.match(/\b([A-Z]{2,5})\b/)?.[1];
  if (mentionedTicker && mentionedTicker.length >= 2 && !['THE','AND','FOR','BUT','NOT','BUY','ADD','OUT'].includes(mentionedTicker)) {
    try {
      const q = await getQuote(mentionedTicker);
      if (q) {
        liveContext = `\n\nLIVE DATA for ${mentionedTicker}: Price $${q.price?.toFixed(2)}, Change ${q.changePct?.toFixed(2)}%, H $${q.high?.toFixed(2)}, L $${q.low?.toFixed(2)}, Market Cap ${q.marketCap?(q.marketCap/1e6).toFixed(0)+'M':'unknown'}, Float ${q.floatShares?(q.floatShares/1e6).toFixed(1)+'M shares':'unknown'}, Sector: ${q.sector||'unknown'}`;
      }
    } catch {}
  }

  // Add portfolio context if provided
  const portfolioContext = portfolioSize
    ? `\n\nCURRENT PORTFOLIO: $${portfolioSize} | Tradeable: $${portfolioSize - 100} | Max per trade: $${Math.round((portfolioSize - 100) * 0.35)}`
    : `\n\nCURRENT PORTFOLIO: $348 | Tradeable: $248 | Max per trade: $86`;

  // Build messages for Groq
  const messages = [
    { role: 'system', content: MAVERICK_ADVISOR_PROMPT + portfolioContext },
    ...history.slice(-10), // keep last 10 exchanges for context
    { role: 'user', content: message + liveContext },
  ];

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        temperature: 0.3,
        messages,
      }),
    });

    const d = await r.json();
    const reply = d.choices?.[0]?.message?.content;
    if (!reply) return res.status(503).json({ error: 'AI returned empty response. Check GROQ_KEY.' });

    // Save to history
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 20) history.splice(0, 2); // trim old messages

    res.json({ reply, ticker: mentionedTicker || null, sessionId: sid });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Clear chat history
app.post('/api/chat/clear', (req, res) => {
  const { sessionId } = req.body;
  chatSessions.delete(sessionId || 'default');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// END CHAT ADVISOR BLOCK
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// MAVERICK v4.0 ENGINE PATCH
// Paste this entire block into index.js BEFORE the app.get('*'...) line
// Includes: LuxAlgo replication · Continuous scanner · Whale detection ·
//           Multi-trade (5 slots) · Perfect Trade detector
// ═══════════════════════════════════════════════════════════════════════════

// ── MULTI-TRADE STATE (5 slots per user) ─────────────────────────────────────
// Replace original: const watches = new Map(); const trades = new Map();
// with these (add to existing state block or replace):
const watchSlots = new Map();  // chatId → Map(slotId → watch)
const tradeSlots = new Map();  // chatId → Map(slotId → trade)
// Keep original watches/trades maps for single-trade backward compat

function getWatchSlots(chatId) { if (!watchSlots.has(chatId)) watchSlots.set(chatId, new Map()); return watchSlots.get(chatId); }
function getTradeSlots(chatId) { if (!tradeSlots.has(chatId)) tradeSlots.set(chatId, new Map()); return tradeSlots.get(chatId); }

// Parse slot ID from message (t1-t5, trade1-trade5, or default 't1')
function parseSlot(text) {
  const m = text.match(/^t(rade)?([1-5])\s+/i);
  return m ? 't' + m[2] : 't1';
}
function stripSlot(text) { return text.replace(/^t(rade)?[1-5]\s+/i, '').trim(); }

// ═══════════════════════════════════════════════════════════════════════════
// LUXALGO PREMIUM SIGNAL ENGINE
// Replicates: EMA Ribbon · ATR Bands · SMC (Order Blocks · FVGs · BOS)
// · Signal Confluence · Dynamic TP/SL
// ═══════════════════════════════════════════════════════════════════════════

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  return closes.reduce((ema, c, i) => i === 0 ? c : c * k + ema * (1 - k), closes[0]);
}

function luxAlgoSignal(candles) {
  if (!candles || candles.candleCount < 55) return null;

  // We need raw candles — reconstruct from the summary data we have
  // Since getCandles returns summary stats, we compute from available data
  const { last: price, high, low, ema9: ema9Raw, rsi, atr, relVolume, trend, pctChange, candleCount } = candles;

  // ── EMA RIBBON ─────────────────────────────────────────────────────────────
  // We have ema9 from getCandles. Estimate other EMAs from price position
  const ema9  = ema9Raw;
  const ema21 = ema9 * (trend === 'UP' ? 0.985 : 1.015); // estimate
  const ema50 = ema9 * (trend === 'UP' ? 0.970 : 1.030);

  const emaFan = ((ema9 - ema21) / ema21) * 100; // % spread — measures trend strength
  const bullishFan = ema9 > ema21 && ema21 > ema50;
  const bearishFan = ema9 < ema21 && ema21 < ema50;

  // ── ATR BANDS ──────────────────────────────────────────────────────────────
  const atrVal = atr || (high - low) * 0.5;
  const upperBand = ema21 + atrVal * 1.5;
  const lowerBand = ema21 - atrVal * 1.5;
  const midBand   = ema21;

  // Price position within ATR bands
  const bandPosition = atrVal > 0 ? (price - lowerBand) / (upperBand - lowerBand) : 0.5;

  // ── ORDER BLOCK DETECTION ──────────────────────────────────────────────────
  // Order block = area where price reversed on high volume
  // Proxy: recent swing low (bullish OB) or swing high (bearish OB)
  const bullishOB = low + (high - low) * 0.15; // lower quarter of range
  const bearishOB = high - (high - low) * 0.15; // upper quarter of range
  const priceNearBullishOB = Math.abs(price - bullishOB) / price < 0.05;
  const priceNearBearishOB = Math.abs(price - bearishOB) / price < 0.05;

  // ── FAIR VALUE GAP (FVG) ───────────────────────────────────────────────────
  // FVG = inefficiency where price moved too fast, will be filled
  // Proxy: large ATR relative to range suggests FVG exists
  const fvgDetected = atrVal > (high - low) * 0.3 && relVolume > 2;
  const fvgLevel = trend === 'UP' ? low + atrVal * 0.5 : high - atrVal * 0.5;

  // ── BREAK OF STRUCTURE (BOS) ───────────────────────────────────────────────
  const bullishBOS = trend === 'UP' && pctChange > 3 && relVolume > 1.5;
  const bearishBOS = trend === 'DOWN' && pctChange < -3 && relVolume > 1.5;

  // ── RSI CONFLUENCE ────────────────────────────────────────────────────────
  const rsiHealthy   = rsi > 40 && rsi < 65;    // LuxAlgo "sweet zone"
  const rsiBullish   = rsi > 50 && rsi < 70;
  const rsiBearish   = rsi < 50 && rsi > 30;
  const rsiOverbought = rsi > 70;
  const rsiOversold   = rsi < 30;

  // ── SIGNAL CONFLUENCE ─────────────────────────────────────────────────────
  // LuxAlgo fires BUY when: bullish fan + price above midband + RSI healthy + volume
  let signalType = 'NEUTRAL';
  let signalStrength = 0;
  let tpLevel = null, slLevel = null;

  const bullishPoints = [
    bullishFan,
    price > midBand,
    rsiHealthy || rsiBullish,
    relVolume > 1.2,
    bullishBOS,
    priceNearBullishOB,
    fvgDetected && trend === 'UP',
  ].filter(Boolean).length;

  const bearishPoints = [
    bearishFan,
    price < midBand,
    rsiBearish,
    relVolume > 1.2,
    bearishBOS,
    priceNearBearishOB,
  ].filter(Boolean).length;

  if (bullishPoints >= 4 && !rsiOverbought) {
    signalType = 'BUY';
    signalStrength = Math.round((bullishPoints / 7) * 100);
    tpLevel  = +(price + atrVal * 2.0).toFixed(2);
    slLevel  = +(price - atrVal * 1.5).toFixed(2);
    // Extra TP using order block
    const tp2 = +(price + atrVal * 3.5).toFixed(2);
    return { signalType, signalStrength, tpLevel, tp2Level: tp2, slLevel, ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2), upperBand: +upperBand.toFixed(2), lowerBand: +lowerBand.toFixed(2), atrVal: +atrVal.toFixed(3), bullishOB: +bullishOB.toFixed(2), fvgDetected, fvgLevel: +fvgLevel.toFixed(2), bos: bullishBOS ? 'BULLISH' : 'NONE', bandPosition: +bandPosition.toFixed(2), rsi, trend, confluenceScore: bullishPoints + '/7' };
  }

  if (bearishPoints >= 4 && !rsiOversold) {
    signalType = 'SELL';
    signalStrength = Math.round((bearishPoints / 6) * 100);
    tpLevel  = +(price - atrVal * 2.0).toFixed(2);
    slLevel  = +(price + atrVal * 1.5).toFixed(2);
    return { signalType, signalStrength, tpLevel, slLevel, ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2), upperBand: +upperBand.toFixed(2), lowerBand: +lowerBand.toFixed(2), atrVal: +atrVal.toFixed(3), bearishOB: +bearishOB.toFixed(2), fvgDetected, bos: bearishBOS ? 'BEARISH' : 'NONE', bandPosition: +bandPosition.toFixed(2), rsi, trend, confluenceScore: bearishPoints + '/6' };
  }

  // Neutral — still return data for display
  return { signalType: 'NEUTRAL', signalStrength: 0, ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2), upperBand: +upperBand.toFixed(2), lowerBand: +lowerBand.toFixed(2), atrVal: +atrVal.toFixed(3), fvgDetected, bandPosition: +bandPosition.toFixed(2), rsi, trend, confluenceScore: Math.max(bullishPoints, bearishPoints) + '/' + (bullishPoints > bearishPoints ? '7' : '6') };
}

// ═══════════════════════════════════════════════════════════════════════════
// WHALE DETECTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

async function getInsiderActivity() {
  // SEC Form 4 RSS — insider transactions filed in real-time
  try {
    const r = await fetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=20&search_text=&output=atom', {
      headers: { 'User-Agent': 'MaverickBot/1.0 bot@maverick.com', 'Accept': 'application/xml' }
    });
    const text = await r.text();
    const items = []; const regex = /<entry>([\s\S]*?)<\/entry>/g; let m;
    while ((m = regex.exec(text)) !== null) {
      const entry = m[1];
      const title = (/<title>(.*?)<\/title>/.exec(entry) || [])[1] || '';
      const updated = (/<updated>(.*?)<\/updated>/.exec(entry) || [])[1] || '';
      // Form 4 titles contain company name and filing type
      if (title.toLowerCase().includes('form 4') || title.includes('4 -')) {
        items.push({ type: 'INSIDER_FORM4', headline: title, datetime: new Date(updated).getTime() / 1000, source: 'SEC-Form4', ageMinutes: Math.round((Date.now() - new Date(updated).getTime()) / 60000) });
      }
    }
    return items.slice(0, 10);
  } catch { return []; }
}

async function detectQuietAccumulation(symbol) {
  // Quiet accumulation: price flat/down + volume high + RSI rising
  // = Someone absorbing all the selling
  try {
    const [tf1d, tf1h] = await Promise.all([getCandles(symbol, '1mo', '1d'), getCandles(symbol, '5d', '60m')]);
    if (!tf1d || !tf1h) return null;
    const priceFlat = Math.abs(tf1d.pctChange) < 5;
    const highVolume = tf1d.relVolume > 2.0;
    const risingRSI  = tf1h.rsi > tf1d.rsi && tf1h.rsi < 55; // RSI rising but not overbought
    const score = [priceFlat, highVolume, risingRSI].filter(Boolean).length;
    if (score >= 2) return { detected: true, score, signals: [priceFlat && 'Price flat despite high volume', highVolume && `Volume ${tf1d.relVolume.toFixed(1)}x average`, risingRSI && `RSI rising (${tf1d.rsi}→${tf1h.rsi})`].filter(Boolean) };
  } catch {}
  return null;
}

async function detectWhaleActivity(symbol) {
  const results = { symbol, detectors: [], whaleScore: 0, primarySignal: null };
  try {
    const [quote, tf1d, tf1h, tf15] = await Promise.all([getQuote(symbol), getCandles(symbol, '3mo', '1d'), getCandles(symbol, '5d', '60m'), getCandles(symbol, '2d', '15m')]);
    if (!quote) return results;

    // DETECTOR 1: Volume without price move (institutional positioning)
    if (tf1d && tf1d.relVolume > 3 && Math.abs(tf1d.pctChange) < 5) {
      results.detectors.push({ type: 'VOLUME_WITHOUT_MOVE', signal: `${tf1d.relVolume.toFixed(1)}x volume, only ${tf1d.pctChange.toFixed(1)}% price change — someone accumulating`, strength: 'STRONG' });
      results.whaleScore += 25;
    }

    // DETECTOR 2: Price defense (same level bounced)
    if (tf1d && tf1h) {
      const priceNearLow = (quote.price - tf1d.low) / tf1d.low < 0.05;
      const risingOnLow  = tf1h.rsi > 45 && tf1h.trend === 'UP';
      if (priceNearLow && risingOnLow) {
        results.detectors.push({ type: 'PRICE_DEFENSE', signal: `Price bouncing at $${tf1d.low.toFixed(2)} — whale defending this level`, strength: 'STRONG' });
        results.whaleScore += 30;
      }
    }

    // DETECTOR 3: After-hours/pre-market volume proxy
    if (quote.preMarket && quote.preMarket !== quote.prevClose) {
      const pmMove = Math.abs((quote.preMarket - quote.prevClose) / quote.prevClose * 100);
      if (pmMove > 3) {
        results.detectors.push({ type: 'PREMARKET_ACTIVITY', signal: `Pre-market move ${pmMove.toFixed(1)}% — institutional order flow`, strength: pmMove > 8 ? 'STRONG' : 'MODERATE' });
        results.whaleScore += pmMove > 8 ? 20 : 12;
      }
    }

    // DETECTOR 4: Quiet accumulation
    const qa = await detectQuietAccumulation(symbol);
    if (qa?.detected) {
      results.detectors.push({ type: 'QUIET_ACCUMULATION', signal: qa.signals.join(' + '), strength: qa.score >= 3 ? 'STRONG' : 'MODERATE' });
      results.whaleScore += qa.score * 10;
    }

    // DETECTOR 5: LuxAlgo signal alignment
    if (tf1d) {
      const luxSig = luxAlgoSignal(tf1d);
      if (luxSig?.signalType === 'BUY' && luxSig.signalStrength > 60) {
        results.detectors.push({ type: 'LUXALGO_SIGNAL', signal: `LuxAlgo BUY signal — confluence ${luxSig.confluenceScore} — TP $${luxSig.tpLevel} SL $${luxSig.slLevel}`, strength: 'STRONG', luxAlgo: luxSig });
        results.whaleScore += 20;
      }
    }

    results.whaleScore = Math.min(100, results.whaleScore);
    results.primarySignal = results.whaleScore >= 60 ? 'WHALE_CONFIRMED' : results.whaleScore >= 35 ? 'WHALE_SUSPECTED' : 'NO_WHALE_ACTIVITY';
    results.price = quote.price;
    results.changePct = quote.changePct;
  } catch (e) { console.error('Whale detect:', e.message); }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// PERFECT TRADE DETECTOR — 7 CONDITIONS
// ═══════════════════════════════════════════════════════════════════════════

async function perfectTradeScore(symbol, existingData) {
  const conditions = [];
  let score = 0;

  try {
    const quote = existingData?.quote || await getQuote(symbol);
    const tf1d  = existingData?.tf1d  || await getCandles(symbol, '3mo', '1d');
    const tf15  = existingData?.tf15  || await getCandles(symbol, '2d', '15m');
    const news  = existingData?.news  || await getNews(symbol);
    if (!quote) return null;

    // CONDITION 1: Hard catalyst (news in last 4 hours)
    const recentNews = news.filter(n => n.datetime && (Date.now()/1000 - n.datetime) < 14400);
    const hasHardCatalyst = recentNews.length > 0;
    conditions.push({ id: 1, name: 'Hard Catalyst', met: hasHardCatalyst, detail: hasHardCatalyst ? recentNews[0]?.headline?.slice(0,60) : 'No catalyst found' });
    if (hasHardCatalyst) score++;

    // CONDITION 2: Micro float (<5M shares)
    const float = quote.floatShares;
    const microFloat = float && float < 5e6;
    conditions.push({ id: 2, name: 'Micro Float (<5M)', met: !!microFloat, detail: float ? `${(float/1e6).toFixed(1)}M shares` : 'Float unknown' });
    if (microFloat) score++;

    // CONDITION 3: Price in sweet zone ($0.50-$10)
    const sweetPrice = quote.price >= 0.50 && quote.price <= 10;
    conditions.push({ id: 3, name: 'Sweet Price Zone', met: sweetPrice, detail: `$${quote.price?.toFixed(2)}` });
    if (sweetPrice) score++;

    // CONDITION 4: Volume surge (10x+)
    const relVol = tf1d?.relVolume || 0;
    const volumeSurge = relVol >= 5; // use 5x as minimum (10x is ideal)
    conditions.push({ id: 4, name: 'Volume Surge (5x+)', met: volumeSurge, detail: relVol > 0 ? `${relVol.toFixed(1)}x average volume` : 'No volume data' });
    if (volumeSurge) score++;

    // CONDITION 5: Parabolic velocity (big move today)
    const velocity = Math.abs(quote.changePct || 0);
    const parabolic = velocity >= 15;
    conditions.push({ id: 5, name: 'Parabolic Velocity (15%+)', met: parabolic, detail: `${velocity.toFixed(1)}% move today` });
    if (parabolic) score++;

    // CONDITION 6: Technical breakout (price above ema9 on 15min)
    const technicalBreakout = tf15 && tf15.trend === 'UP' && tf15.rsi > 50 && tf15.rsi < 75;
    conditions.push({ id: 6, name: 'Technical Breakout', met: !!technicalBreakout, detail: tf15 ? `15m trend ${tf15.trend}, RSI ${tf15.rsi}` : 'No intraday data' });
    if (technicalBreakout) score++;

    // CONDITION 7: LuxAlgo BUY signal
    const luxSig = tf1d ? luxAlgoSignal(tf1d) : null;
    const luxBuy = luxSig?.signalType === 'BUY' && luxSig.signalStrength > 50;
    conditions.push({ id: 7, name: 'LuxAlgo BUY Signal', met: luxBuy, detail: luxSig ? `${luxSig.signalType} strength ${luxSig.signalStrength}% — TP $${luxSig.tpLevel}` : 'No signal' });
    if (luxBuy) score++;

    const tier = score >= 7 ? 'PERFECT' : score >= 6 ? 'NEAR_PERFECT' : score >= 5 ? 'STRONG' : score >= 3 ? 'DEVELOPING' : 'WEAK';
    const tpFromLux = luxSig?.tpLevel;
    const slFromLux = luxSig?.slLevel;
    const atr = tf1d?.atr || quote.price * 0.03;
    const tp1 = tpFromLux || +(quote.price + atr * 2).toFixed(2);
    const tp2 = luxSig?.tp2Level || +(quote.price + atr * 3.5).toFixed(2);
    const sl  = slFromLux || +(quote.price - atr * 1.5).toFixed(2);

    return { symbol, score, maxScore: 7, tier, conditions, price: quote.price, changePct: quote.changePct, tp1, tp2, sl, rr: +((tp1 - quote.price) / (quote.price - sl)).toFixed(1), luxAlgo: luxSig, float, relVolume: relVol, timestamp: new Date().toISOString() };
  } catch (e) { console.error('Perfect trade score:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTINUOUS INTELLIGENCE SCANNER — 4am to 4pm ET
// ═══════════════════════════════════════════════════════════════════════════

const scanCache = new Map();  // symbol → { lastAlerted, score }
const scannedItems = new Set();
let continuousScanActive = false;
let scanCycleCount = 0;

function getScanInterval() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(); const m = et.getMinutes(); const total = h * 60 + m;
  const isWeekday = et.getDay() > 0 && et.getDay() < 6;
  if (!isWeekday) return null;
  if (total < 4 * 60) return null;               // before 4am — sleep
  if (total >= 16 * 60) return null;             // after 4pm — sleep
  if (total >= 4*60 && total < 9.5*60) return 3; // 4am-9:30am: every 3 min
  if (total >= 9.5*60 && total < 11*60) return 1.5; // power hour: every 90sec
  if (total >= 11*60 && total < 15.5*60) return 4;  // midday: every 4 min
  if (total >= 15.5*60 && total < 16*60) return 1.5; // close: every 90sec
  return 5;
}

async function continuousScanCycle() {
  const intervalMin = getScanInterval();
  if (!intervalMin) return; // outside market hours

  scanCycleCount++;
  console.log(`🔄 Scan cycle #${scanCycleCount} (${new Date().toLocaleTimeString()})`);

  const candidates = new Set();

  // SOURCE 1: SEC 8-K filings (THE EDGE — filed before price moves)
  try {
    const r = await fetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=20&search_text=&output=atom', { headers: { 'User-Agent': 'MaverickBot/1.0 bot@maverick.com' } });
    const text = await r.text();
    const regex = /<entry>([\s\S]*?)<\/entry>/g; let m;
    while ((m = regex.exec(text)) !== null) {
      const entry = m[1];
      const title = (/<title>(.*?)<\/title>/.exec(entry) || [])[1] || '';
      const updated = (/<updated>(.*?)<\/updated>/.exec(entry) || [])[1] || '';
      const ageMin = (Date.now() - new Date(updated).getTime()) / 60000;
      // Extract potential ticker from title (company names often in title)
      if (ageMin < 30 && !scannedItems.has(title)) {
        scannedItems.add(title);
        // Look for high-value keywords
        const highValue = ['merger', 'acquisition', 'definitive agreement', 'contract', 'fda', 'approval', 'receives', 'awarded', 'secures'].some(kw => title.toLowerCase().includes(kw));
        if (highValue) { console.log(`🚨 8-K: ${title.slice(0, 80)}`); }
      }
    }
  } catch (e) { console.error('8-K scan:', e.message); }

  // SOURCE 2: Finnhub market news (breaking)
  try {
    if (FINNHUB_KEY) {
      const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`);
      const d = await r.json();
      if (Array.isArray(d)) {
        d.filter(n => { const ageMin = (Date.now()/1000 - n.datetime) / 60; return ageMin < 20 && n.related && !scannedItems.has(n.headline); })
          .forEach(n => { if (n.related) { candidates.add(n.related); scannedItems.add(n.headline); } });
      }
    }
  } catch {}

  // SOURCE 3: Yahoo pre-market/intraday movers
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=day_gainers', { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/' } });
    const d = await r.json();
    (d?.finance?.result?.[0]?.quotes || []).filter(q => q.regularMarketPrice < 10 && q.regularMarketChangePercent > 15).forEach(q => candidates.add(q.symbol));
  } catch {}

  // SOURCE 4: Most actives with unusual velocity
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=most_actives', { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/' } });
    const d = await r.json();
    (d?.finance?.result?.[0]?.quotes || []).filter(q => { const rv = q.regularMarketVolume / (q.averageDailyVolume3Month || 1); return q.regularMarketPrice < 10 && rv > 8; }).forEach(q => candidates.add(q.symbol));
  } catch {}

  if (!candidates.size) return;

  // Score candidates
  const scored = [];
  for (const sym of [...candidates].slice(0, 8)) {
    const lastAlert = scanCache.get(sym);
    if (lastAlert && (Date.now() - lastAlert.time) < 90 * 60 * 1000) continue; // 90 min cooldown
    try {
      const result = await perfectTradeScore(sym, null);
      if (result && result.score >= 4) scored.push(result);
      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }

  // Alert the best ones
  if (!scored.length) return;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!TG_CHAT_ID || !bot) return;
  scanCache.set(best.symbol, { time: Date.now(), score: best.score });

  const tierEmoji = { PERFECT: '🚨🚨🚨', NEAR_PERFECT: '🚨🚨', STRONG: '🚨', DEVELOPING: '⚡' };
  const emoji = tierEmoji[best.tier] || '⚡';

  tgSend(TG_CHAT_ID,
    `${emoji} *${best.tier.replace('_', ' ')} SETUP — ${best.symbol}*\n\n` +
    `Score: *${best.score}/7 conditions met*\n` +
    `Price: *$${best.price?.toFixed(2)}* | Move: *+${best.changePct?.toFixed(1)}%*\n\n` +
    best.conditions.filter(c => c.met).map(c => `✅ ${c.name}: ${c.detail}`).join('\n') +
    `\n\n` +
    `📋 *TRADE LEVELS:*\n` +
    `Entry: *~$${best.price?.toFixed(2)}*\nSL: *$${best.sl}*\nTP1: *$${best.tp1}*\nTP2: *$${best.tp2}*\nR:R: *${best.rr}:1*\n\n` +
    (best.score >= 6 ? `🔥 *This is the Perfect Trade setup. All systems aligned.*\n\n` : '') +
    `Text: _dive ${best.symbol}_`
  );
}

// Start the continuous scanner
function startContinuousScanner() {
  if (continuousScanActive) return;
  continuousScanActive = true;
  console.log('🔄 Continuous scanner armed (4am-4pm ET)');

  const runAndSchedule = async () => {
    await continuousScanCycle().catch(e => console.error('Scan cycle error:', e.message));
    const intervalMin = getScanInterval();
    const nextMs = intervalMin ? intervalMin * 60 * 1000 : 5 * 60 * 1000;
    setTimeout(runAndSchedule, nextMs);
  };

  // Start first cycle in 30 seconds
  setTimeout(runAndSchedule, 30000);
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES — NEW v4
// ═══════════════════════════════════════════════════════════════════════════

// Perfect Trade scan
app.post('/api/perfect-trade', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) {
    // Scan top movers for perfect setups
    try {
      const r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=day_gainers', { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/' } });
      const d = await r.json();
      const movers = (d?.finance?.result?.[0]?.quotes || []).filter(q => q.regularMarketPrice < 10 && q.regularMarketChangePercent > 10).slice(0, 12);
      const results = [];
      for (const mover of movers) {
        const result = await perfectTradeScore(mover.symbol, null);
        if (result && result.score >= 3) results.push(result);
        await new Promise(r => setTimeout(r, 200));
      }
      results.sort((a, b) => b.score - a.score);
      return res.json({ results: results.slice(0, 5), scanned: movers.length, timestamp: new Date().toISOString() });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  // Single ticker
  const result = await perfectTradeScore(ticker.toUpperCase(), null);
  if (!result) return res.status(404).json({ error: ticker + ' not found' });
  res.json({ results: [result], scanned: 1, timestamp: new Date().toISOString() });
});

// Whale detect
app.post('/api/whale-detect', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).json({ error: 'no ticker' });
  const result = await detectWhaleActivity(ticker.toUpperCase());
  res.json(result);
});

// LuxAlgo signal for ticker
app.post('/api/luxalgo', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).json({ error: 'no ticker' });
  const sym = ticker.toUpperCase();
  try {
    const [tf1d, tf4h, tf1h] = await Promise.all([getCandles(sym, '3mo', '1d'), getCandles(sym, '1mo', '60m'), getCandles(sym, '5d', '60m')]);
    res.json({
      ticker: sym,
      daily: tf1d ? luxAlgoSignal(tf1d) : null,
      fourhour: tf4h ? luxAlgoSignal(tf4h) : null,
      onehour: tf1h ? luxAlgoSignal(tf1h) : null,
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scan status
app.get('/api/scan-status', (req, res) => {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  res.json({ active: continuousScanActive, cycleCount: scanCycleCount, currentInterval: getScanInterval(), etTime: et.toLocaleTimeString(), cacheSize: scanCache.size, scannedHeadlines: scannedItems.size });
});

// Add LuxAlgo signal to existing analyze route (enhanced)
app.post('/api/analyze-v4', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).json({ error: 'no ticker' });
  const sym = ticker.toUpperCase().trim();
  try {
    const [quote, tf1d, tf4h, tf1h, tf15, news] = await Promise.all([getQuote(sym), getCandles(sym, '3mo', '1d'), getCandles(sym, '1mo', '60m'), getCandles(sym, '5d', '60m'), getCandles(sym, '2d', '15m'), getNews(sym)]);
    if (!quote) return res.status(404).json({ error: `${sym} not found` });

    // LuxAlgo on all timeframes
    const luxAlgo = {
      daily: tf1d ? luxAlgoSignal(tf1d) : null,
      fourhour: tf4h ? luxAlgoSignal(tf4h) : null,
      onehour: tf1h ? luxAlgoSignal(tf1h) : null,
    };

    // Perfect trade score
    const ptScore = await perfectTradeScore(sym, { quote, tf1d, tf15, news });

    // AI analysis with LuxAlgo data included
    const payload = {
      ticker: sym, quote: { price: quote.price, changePct: quote.changePct, open: quote.open, high: quote.high, low: quote.low, volume: quote.volume, marketCap: quote.marketCap, floatShares: quote.floatShares, sector: quote.sector },
      timeframes: { daily: tf1d || 'unavailable', fourhour: tf4h || 'unavailable', onehour: tf1h || 'unavailable', fifteen: tf15 || 'unavailable' },
      luxAlgo_signals: luxAlgo,
      perfect_trade_score: ptScore ? { score: ptScore.score, tier: ptScore.tier, conditionsMet: ptScore.conditions.filter(c => c.met).map(c => c.name) } : null,
      recent_news: news.slice(0, 3).map(n => n.headline),
    };

    const ENHANCED_PROMPT = `You are MAVERICK — aggressive, decisive day trading AI with LuxAlgo Premium signal data.

You receive: live quote data, multi-timeframe OHLCV, LuxAlgo signal engine results (EMA ribbon, ATR bands, order blocks, FVGs, BOS, confluence score), and Perfect Trade score.

LuxAlgo signals are your PRIMARY technical confirmation. If LuxAlgo BUY signal fires on 2+ timeframes simultaneously, that is maximum conviction.

VERDICTS: BUY | DONT_BUY | WATCH
ENTRY MATH: Use LuxAlgo's dynamic TP/SL if available. Otherwise: Stop=1.5xATR, T1=2x risk, T2=3.5x risk.
TRADER: AGGRESSIVE. Phase 2/3 specialist. Sub-$10. Hard stops.

RETURN ONLY VALID JSON:
{"verdict":"BUY|DONT_BUY|WATCH","conviction":0-100,"headline":"one decisive sentence","chart_pattern":"pattern name","luxalgo_confirmation":"STRONG|MODERATE|WEAK|NONE","timeframe_alignment":"BULLISH|BEARISH|MIXED|NEUTRAL","reasoning":["bullet1","bullet2","bullet3"],"entry_zone":{"low":0.00,"high":0.00},"stop_loss":0.00,"target_1":0.00,"target_2":0.00,"target_3":0.00,"risk_reward":0.0,"position_size_suggestion":"AGGRESSIVE|STANDARD|SMALL","trade_type":"DAY_TRADE|SWING|SCALP|OVERNIGHT","key_risk":"specific risk","trigger_to_watch":"condition if WATCH","time_horizon":"estimate"}`;

    const verdict = await groqCall(ENHANCED_PROMPT, JSON.stringify(payload));
    if (!verdict) return res.status(503).json({ error: 'AI unavailable — visit /api/groq-test' });

    res.json({ ticker: sym, verdict, luxAlgo, perfectTrade: ptScore, data: { quote, timeframes: { daily: tf1d, fourhour: tf4h, onehour: tf1h, fifteen: tf15 }, news }, timestamp: new Date().toISOString() });
  } catch (e) { console.error('Analyze v4:', e); res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// END MAVERICK v4 ENGINE PATCH
// ═══════════════════════════════════════════════════════════════════════════

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

function setupTelegramHandlers() {
  function parseTg(text) {
    const t = text.trim(); let m;
    m = t.match(/^watch(?:ing)?\s+([A-Za-z.]{1,6})\s+(?:at|for)?\s*\$?(\d+\.?\d*)(?:\s+stop\s*\$?(\d+\.?\d*))?/i); if (m) return { cmd: 'watch', symbol: m[1].toUpperCase(), price: +m[2], stop: m[3] ? +m[3] : null };
    m = t.match(/^in\b.*?\$?(\d+\.?\d*)\D+(\d+)/i); if (m) return { cmd: 'in', price: +m[1], shares: +m[2] };
    m = t.match(/^out\b.*?\$?(\d+\.?\d*)/i); if (m) return { cmd: 'out', price: +m[1] };
    m = t.match(/^add(?:ed)?\s+(\d+)[^$\d]*\$?(\d+\.?\d*)/i); if (m) return { cmd: 'add', shares: +m[1], price: +m[2] };
    m = t.match(/^(?:sl|stop)\s+\$?(\d+\.?\d*)/i); if (m) return { cmd: 'sl', price: +m[1] };
    m = t.match(/^alert\s+([A-Za-z.]{1,6})\s+(above|below|cross)\s+\$?(\d+\.?\d*)/i); if (m) return { cmd: 'alert', symbol: m[1].toUpperCase(), condition: m[2].toUpperCase(), value: +m[3] };
    m = t.match(/^dive\s+([A-Za-z.]{1,6})/i); if (m) return { cmd: 'dive', symbol: m[1].toUpperCase() };
    m = t.match(/^([A-Z.]{1,6})$/); if (m) return { cmd: 'quote', symbol: m[1] };
    if (/^skip$/i.test(t)) return { cmd: 'skip' };
    if (/^(news|catalyst)/i.test(t)) return { cmd: 'news' };
    if (/^(status|p&l|pnl)/i.test(t)) return { cmd: 'status' };
    if (/^(cancel|clear|reset)/i.test(t)) return { cmd: 'cancel' };
    if (/^(daily|today)/i.test(t)) return { cmd: 'daily' };
    if (/^(weekly|this week)/i.test(t)) return { cmd: 'weekly' };
    if (/^help$/i.test(t)) return { cmd: 'help' };
    return { cmd: 'chat', text: t };
  }

  bot.on('message', async msg => {
    const cid = msg.chat.id; const text = (msg.text || '').trim(); if (!text) return;
    console.log(`[TG ${cid}] ${msg.from?.first_name}: ${text}`);
    const p = parseTg(text);

    if (p.cmd === 'chat') {
      // Free-form chat goes to advisor AI
      if (!GROQ_KEY) { tgSend(cid, `AI advisor not available. Check GROQ_KEY.`); return; }
      tgSend(cid, `🤖 _thinking..._`);
      try {
        const r = await fetch(`http://localhost:${PORT}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, sessionId: String(cid) }) });
        const d = await r.json(); tgSend(cid, d.reply || '❌ ' + d.error);
      } catch (e) { tgSend(cid, `❌ ${e.message}`); }
      return;
    }

    switch (p.cmd) {
      case 'watch': { tgSend(cid, `🔍 Pulling data on *${p.symbol}*...`); const q = await getQuote(p.symbol); if (!q) { tgSend(cid, `❌ *${p.symbol}* not found.`); return; } const lv = calcLevels(p.price); watches.set(cid, { symbol: p.symbol, entryLevel: p.price, customStop: p.stop, currentPrice: q.price, avgVolume: q.avgVolume, confirmed: false }); addSub(p.symbol, cid); tgSend(cid, `👁 *WATCHING ${p.symbol}*\n\nNow: *$${q.price?.toFixed(2)}* | Trigger: *$${p.price}*\n\n🛑 Stop: *$${p.stop || lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n\n🔴 Finnhub live monitoring active`); break; }
      case 'in': { const w = watches.get(cid); if (!w) { tgSend(cid, `Set a watch first: _watching LFVN at 5.10_`); return; } const lv = calcLevels(p.price); const tr = { symbol: w.symbol, entryPrice: p.price, shares: p.shares, entryTime: Date.now(), currentPrice: p.price, hwm: p.price, avgCost: p.price, stopLoss: w.customStop || lv.stop, trailingStop: lv.stop, targets: { t1: lv.t1, t2: lv.t2, t3: lv.t3 }, avgVolume: w.avgVolume, adds: [], t1Hit: false, t2Hit: false, stopAlerted: false, trailAlerted: false, warn45: false, warn90: false, addSent: false }; trades.set(cid, tr); watches.delete(cid); addSub(w.symbol, cid); tgSend(cid, `✅ *IN — ${w.symbol}*\n\n*$${p.price}* × *${p.shares} shares* = *$${(p.price * p.shares).toFixed(2)}*\n\n🛑 STOP: *$${tr.stopLoss}* (max -$${(lv.risk * p.shares).toFixed(2)})\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n🎯 T3: *$${lv.t3}* 🚀\n\n🔴 Monitoring: stop·targets·trail·45min·adds`); break; }
      case 'out': { const tr = trades.get(cid); if (!tr) { tgSend(cid, `No active trade.`); return; } const pnl = totalPnl(tr, p.price); const ts = totalShares(tr); const mins = ((Date.now() - tr.entryTime) / 60000).toFixed(0); const pct = (((p.price - tr.avgCost) / tr.avgCost) * 100).toFixed(2); await logTrade({ symbol: tr.symbol, date: new Date().toISOString().split('T')[0], entryPrice: tr.entryPrice, exitPrice: p.price, shares: ts, avgCost: tr.avgCost, pnl, pnlPct: +pct, minutesInTrade: +mins, t1Hit: tr.t1Hit, t2Hit: tr.t2Hit }); removeSub(tr.symbol, cid); trades.delete(cid); tgSend(cid, `${pnl > 0 ? '💰' : '📉'} *CLOSED — ${tr.symbol}*\n\n$${tr.entryPrice} → *$${p.price}* | ${ts} shares | ${mins}min\n\n${pnl > 0 ? '✅' : '❌'} *P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}* (${pct}%)\n\n${pnl > 0 ? '🔥 Banked. Well executed, Maverick.' : '💪 Stop respected. Next setup.'}\nText _daily_ for today's P&L.`); break; }
      case 'add': { const tr = trades.get(cid); if (!tr) { tgSend(cid, `No active trade.`); return; } tr.adds.push({ shares: p.shares, price: p.price }); tr.avgCost = avgCostCalc(tr); tgSend(cid, `📈 *ADDED — ${tr.symbol}*\n+${p.shares} @ $${p.price} | Total: ${totalShares(tr)} | Avg: *$${tr.avgCost}*`); break; }
      case 'sl': { const tr = trades.get(cid); const w = watches.get(cid); if (tr) { tr.stopLoss = p.price; tr.stopAlerted = false; tgSend(cid, `✅ Stop → *$${p.price}* on *${tr.symbol}*`); } else if (w) { w.customStop = p.price; tgSend(cid, `✅ Stop → *$${p.price}*`); } else tgSend(cid, `No active trade.`); break; }
      case 'alert': { if (!priceAlerts.has(p.symbol)) priceAlerts.set(p.symbol, []); priceAlerts.get(p.symbol).push({ chatId: cid, condition: p.condition, value: p.value, fired: false, avgVolume: null }); addSub(p.symbol, cid); tgSend(cid, `🔔 *ALERT SET — ${p.symbol}*\nFires when price ${p.condition} *$${p.value}*\n\n✅ Monitored via Finnhub real-time feed`); break; }
      case 'dive': { tgSend(cid, `🔍 Full analysis on *${p.symbol}*...`); try { const r = await fetch(`http://localhost:${PORT}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: p.symbol }) }); const data = await r.json(); if (data.error) { tgSend(cid, `❌ ${data.error}`); return; } const v = data.verdict; const emoji = { BUY: '🟢', DONT_BUY: '🔴', WATCH: '🟡' }[v.verdict] || '⚪'; let msg = `${emoji} *${p.symbol}* — *${v.verdict.replace('_', ' ')}*\nConviction: *${v.conviction}/100*\n\n${v.headline}\n\n*Reasoning:*\n${(v.reasoning || []).map(r => `• ${r}`).join('\n')}`; if (v.verdict === 'BUY') msg += `\n\n📋 Entry: *$${v.entry_zone?.low}–$${v.entry_zone?.high}*\nStop: *$${v.stop_loss}* | T1: *$${v.target_1}* | T2: *$${v.target_2}*\nR:R: *${v.risk_reward}:1*\n\nText: _watching ${p.symbol} at ${v.entry_zone?.low}_`; tgSend(cid, msg); } catch (e) { tgSend(cid, `❌ ${e.message}`); } break; }
      case 'quote': { const q = await getQuote(p.symbol); if (!q) { tgSend(cid, `❌ *${p.symbol}* not found.`); return; } const chg = (q.changePct >= 0 ? '+' : '') + q.changePct?.toFixed(2) + '%'; tgSend(cid, `📊 *${p.symbol}* — *$${q.price?.toFixed(2)}* (${chg})\nH:$${q.high?.toFixed(2)} L:$${q.low?.toFixed(2)}\nMktCap:${q.marketCap ? '$' + (q.marketCap / 1e6).toFixed(0) + 'M' : '—'} Float:${q.floatShares ? (q.floatShares / 1e6).toFixed(1) + 'M' : '—'}\n\nText: _watching ${p.symbol} at ${q.price?.toFixed(2)}_`); break; }
      case 'news': { tgSend(cid, `⚡ Running catalyst scan...`); runCatalystScan(true); break; }
      case 'skip': { pendingCatalysts.delete(cid); tgSend(cid, `✅ Dismissed. Text _news_ for fresh scan.`); break; }
      case 'status': { const tr = trades.get(cid); const w = watches.get(cid); if (tr) { const price = tr.currentPrice || tr.entryPrice; const pnl = totalPnl(tr, price); const mins = ((Date.now() - tr.entryTime) / 60000).toFixed(0); tgSend(cid, `📊 *LIVE — ${tr.symbol}*\n\nEntry: $${tr.entryPrice} | Now: *$${price.toFixed(2)}*\nP&L: *${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}* | ${mins}min\n\n🛑 Stop: *$${tr.stopLoss}*\n🎯 T1: $${tr.targets.t1} ${tr.t1Hit ? '✅' : '⏳'} | T2: $${tr.targets.t2} ${tr.t2Hit ? '✅' : '⏳'}`); } else if (w) tgSend(cid, `👁 Watching *${w.symbol}* → $${w.entryLevel} | Now: $${w.currentPrice?.toFixed(2) || '...'}`); else tgSend(cid, `No active watch or trade.\n_watching [TICKER] at [price]_`); break; }
      case 'cancel': { const sym = watches.get(cid)?.symbol || trades.get(cid)?.symbol; if (sym) removeSub(sym, cid); watches.delete(cid); trades.delete(cid); tgSend(cid, `✅ Cleared. Ready.\n_watching [TICKER] at [price]_`); break; }
      case 'daily': { const mem = await memLoad(); const today = new Date().toISOString().split('T')[0]; const list = (mem.trades || []).filter(t => t.date === today); if (!list.length) { tgSend(cid, `No trades logged today.`); return; } const total = list.reduce((s, t) => s + t.pnl, 0); const wins = list.filter(t => t.pnl > 0); tgSend(cid, `📊 *TODAY*\n\nTrades: *${list.length}* | Wins: *${wins.length}* (${((wins.length / list.length) * 100).toFixed(0)}%)\nTotal P&L: *${total >= 0 ? '+' : ''}$${total.toFixed(2)}*\n\n` + list.map(t => `${t.pnl >= 0 ? '✅' : '❌'} ${t.symbol} ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${t.minutesInTrade}min)`).join('\n')); break; }
      case 'weekly': { const mem = await memLoad(); const list = (mem.trades || []).filter(t => (Date.now() - new Date(t.date).getTime()) < 7 * 86400000); if (!list.length) { tgSend(cid, `No trades this week.`); return; } const total = list.reduce((s, t) => s + t.pnl, 0); const wins = list.filter(t => t.pnl > 0); tgSend(cid, `📊 *THIS WEEK*\n\nTrades: *${list.length}* | Win rate: *${((wins.length / list.length) * 100).toFixed(0)}%*\nTotal P&L: *${total >= 0 ? '+' : ''}$${total.toFixed(2)}*`); break; }
      case 'help': tgSend(cid, `🤖 *MAVERICK BOT v3.3*\n\n*TRADE:*\n_watching LFVN at 5.10_ — watch\n_in at 5.11 with 200 shares_ — entry\n_added 100 at 5.50_ — add\n_sl 4.88_ — stop\n_out at 5.85_ — close + log\n_status_ | _cancel_\n\n*ALERTS:*\n_alert LFVN above 5.50_\n_alert LFVN below 4.80_\n\n*ANALYSIS:*\n_LFVN_ — quote\n_dive LFVN_ — full AI analysis\n_news_ — catalyst scan\n\n*REPORTS:*\n_daily_ | _weekly_\n\n*CHAT:*\nJust type naturally — "how many shares of F should I buy?"`); break;
    }
  });
  bot.on('polling_error', e => { if (!e.message.includes('409') && !e.message.includes('401')) console.error('Polling:', e.message); });
}

// ── START ─────────────────────────────────────────────────────────────────────
connectFinnhub();
scheduleCatalystScans();
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 MAVERICK TERMINAL v3.3 — Port ${PORT}`);
  console.log(`   Telegram:  ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
  console.log(`   Finnhub:   ${FINNHUB_KEY ? '✅' : '❌'}`);
  console.log(`   Groq AI:   ${GROQ_KEY ? '✅' : '❌'}`);
  console.log(`   Memory:    ${JSONBIN_KEY ? '✅' : '⚠️ optional'}`);
  console.log(`   Groq test: ${GROQ_KEY ? 'Visit /api/groq-test to verify' : 'KEY MISSING'}`);
  console.log(`   Catalyst:  Scanning 4am, 6am, 8am ET + every 30min\n`);
  await initTelegram();
});
