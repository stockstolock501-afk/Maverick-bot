/**
 * MAVERICK INTEL BOT v2.0
 * Full-featured trading intelligence + general AI assistant
 */

require('dotenv').config();
const fetch = require('node-fetch');

// ── CONFIG ───────────────────────────────────────────────────────
const TG_TOKEN = process.env.INTEL_BOT_TOKEN   || process.env.TELEGRAM_TOKEN   || '';
const CHAT_ID  = process.env.INTEL_BOT_CHAT    || process.env.TELEGRAM_CHAT_ID || '';
const FINNHUB  = process.env.FINNHUB_KEY        || '';
const GROQ_KEY = process.env.GROQ_KEY           || process.env.GROQ_KEY_2       || '';
const CBRS_KEY = process.env.CEREBRAS_KEY       || '';

// ── STATE ────────────────────────────────────────────────────────
const positions   = {}; // { SYM: { entry, stop, tp1, tp2, shares, alerts:{} } }
const watchlist   = {}; // { SYM: { added } }
const priceAlerts = []; // [{ ticker, price, direction, chatId, fired }]
const chatHistory = {}; // { chatId: [ {role, content} ] }
let lastUpdateId   = 0;
let lastNewsTs     = Math.floor(Date.now() / 1000) - 3600;
const sentHeadlines = new Set();

// Default scan universe — expands as user adds via /watch
const BASE_SCAN = ['MARA','RIOT','SOFI','HOOD','SNDL','FFIE','MULN','ATER','BBIG','PROG','GFAI','GMBL','BFRI','NKLA'];

// ── HELPERS ──────────────────────────────────────────────────────
const rnd = (n, d = 2) => +Number(n).toFixed(d);

async function fh(ep) {
  try {
    const sep  = ep.includes('?') ? '&' : '?';
    const r    = await fetch(`https://finnhub.io/api/v1${ep}${sep}token=${FINNHUB}`);
    const text = await r.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text);
  } catch (e) {
    console.error('[Finnhub]', ep.split('?')[0], e.message);
    return null;
  }
}

async function tg(text, chatId = CHAT_ID) {
  if (!TG_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('[TG]', e.message); }
}

// ── AI BRAIN — Groq primary, Cerebras backup ─────────────────────
async function ai(system, user, maxTokens = 500, chatId = null) {
  // Build history for conversational context
  const history = chatId && chatHistory[chatId]
    ? chatHistory[chatId].slice(-6)
    : [];

  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: user }
  ];

  // PRIMARY: Groq
  if (GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, temperature: 0.35, messages })
      });
      const d    = await r.json();
      const text = d?.choices?.[0]?.message?.content;
      if (text) {
        if (chatId) {
          if (!chatHistory[chatId]) chatHistory[chatId] = [];
          chatHistory[chatId].push({ role: 'user', content: user }, { role: 'assistant', content: text });
          if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);
        }
        return text;
      }
    } catch (e) { console.error('[Groq]', e.message); }
  }
  // BACKUP: Cerebras
  if (CBRS_KEY) {
    try {
      const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CBRS_KEY}` },
        body: JSON.stringify({ model: 'llama3.1-8b', max_tokens: maxTokens, temperature: 0.35, messages })
      });
      const d    = await r.json();
      const text = d?.choices?.[0]?.message?.content;
      if (text) return text;
    } catch (e) { console.error('[Cerebras]', e.message); }
  }
  return null;
}

// ── STOCK DATA ────────────────────────────────────────────────────
async function getStock(sym) {
  try {
    const [quote, metrics, profile] = await Promise.all([
      fh(`/quote?symbol=${sym}`),
      fh(`/stock/metric?symbol=${sym}&metric=all`),
      fh(`/stock/profile2?symbol=${sym}`)
    ]);
    if (!quote?.c || quote.c === 0) return null;
    const m      = metrics?.metric || {};
    const avgVol = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume'] * 1e6 : 500000;
    const relVol = rnd((quote.v || avgVol) / Math.max(avgVol, 1), 2);
    return {
      sym, price: quote.c, changePct: quote.dp || 0,
      high: quote.h, low: quote.l, prevClose: quote.pc,
      volume: quote.v || 0, relVol,
      floatM:    m.sharesFloat          || 50,
      shortPct:  m.shortInterestPercentOfFloat || 0,
      week52High: m['52WeekHigh']        || quote.c * 1.5,
      week52Low:  m['52WeekLow']         || quote.c * 0.5,
      sector:    profile?.finnhubIndustry || 'Unknown',
      atr:       rnd(quote.c * 0.025, 4)
    };
  } catch (_) { return null; }
}

// ── SETUP SCORER ─────────────────────────────────────────────────
function scoreSetup(d) {
  let score = 0;
  const flags = [];

  if      (d.floatM < 1)  { score += 25; flags.push('NANO FLOAT 🔥'); }
  else if (d.floatM < 5)  { score += 20; flags.push('TIGHT FLOAT'); }
  else if (d.floatM < 15) { score += 12; flags.push('WORKABLE FLOAT'); }

  if      (d.relVol >= 10) { score += 25; flags.push(`RVOL ${d.relVol}x 🔥`); }
  else if (d.relVol >= 5)  { score += 20; flags.push(`RVOL ${d.relVol}x`); }
  else if (d.relVol >= 3)  { score += 12; flags.push(`RVOL ${d.relVol}x`); }
  else if (d.relVol >= 2)  { score +=  6; flags.push(`RVOL ${d.relVol}x`); }
  else if (d.relVol < 0.8) score -= 5;

  if      (d.changePct >= 20) { score += 20; flags.push(`+${rnd(d.changePct,1)}% MOVER 🚀`); }
  else if (d.changePct >= 10) { score += 15; flags.push(`+${rnd(d.changePct,1)}%`); }
  else if (d.changePct >= 5)  { score +=  8; }
  else if (d.changePct <  0)  { score -=  5; }

  if      (d.price < 1) { score += 10; flags.push('SUB-$1'); }
  else if (d.price < 3) score += 8;
  else if (d.price < 5) score += 5;

  if (d.shortPct > 30 && d.relVol > 3) { score += 15; flags.push('SQUEEZE SETUP 🦈'); }
  else if (d.shortPct > 20)             { score +=  8; flags.push(`SHORT ${rnd(d.shortPct,1)}%`); }

  const pctFrom52H = (d.week52High - d.price) / d.week52High * 100;
  if (pctFrom52H < 3 && d.changePct > 0) { score += 10; flags.push('52W BREAKOUT'); }

  return { score: Math.min(100, score), flags };
}

// ── COMMAND HANDLERS ──────────────────────────────────────────────

async function cmdStart(chatId) {
  await tg(`🤖 <b>MAVERICK INTEL BOT v2.0</b>

<b>📊 STOCK COMMANDS</b>
/check TICKER — Full AI analysis
/scan — Find breakout setups now
/squeeze — High conviction squeeze scan
/news — Top market catalysts

<b>💼 TRADE TRACKING</b>
/position TICKER ENTRY STOP TP1 TP2 SHARES
/positions — View all open trades
/close TICKER — Close a tracked trade
/watch TICKER — Add to scan universe
/alert TICKER PRICE above|below — Price alert

<b>🤖 AI ASSISTANT</b>
Just type anything — trading or not.
I remember our conversation.
`, chatId);
}

async function cmdCheck(sym, chatId) {
  await tg(`⏳ Running Lion Analysis on $${sym}...`, chatId);
  const d = await getStock(sym);
  if (!d) return tg(`❌ No data for $${sym}. Check the ticker.`, chatId);

  const { score, flags } = scoreSetup(d);
  const atr = d.atr;

  const analysis = await ai(
    `You are MAVERICK LION BRAIN — an elite micro-cap trading analyst.
Apply the Maverick Whale Doctrine: enter Phase 1-2 accumulation, exit before Phase 4 distribution.
Key rules: float under 15M preferred, RVOL above 2x is whale signal, positive price action required.
Price zones: under $1 best, $1-$3 low premium, $3-$5 good enough.
Give a clear verdict: BUY / WATCH / PASS.
Include: specific entry zone, hard stop price, TP1 and TP2 targets, risk/reward, and 1-sentence whale phase assessment.
Write like you're talking to a 6th grader. Direct. No fluff. Max 220 words.`,
    `Analyze $${sym}:
Price: $${d.price} (${d.changePct >= 0 ? '+' : ''}${rnd(d.changePct, 2)}%)
RVOL: ${d.relVol}x | Float: ${d.floatM}M | Short: ${d.shortPct}%
ATR: $${atr} | Setup Score: ${score}/100
Flags: ${flags.join(', ') || 'none'}
52W Range: $${d.week52Low} - $${d.week52High}
Sector: ${d.sector}`,
    350, chatId
  );

  const bar = score >= 85 ? '🟢🟢🟢' : score >= 70 ? '🟢🟢' : score >= 55 ? '🟡' : '🔴';

  await tg(`${bar} <b>$${sym} — LION BRAIN ANALYSIS</b>

💰 <b>$${d.price}</b> (${d.changePct >= 0 ? '+' : ''}${rnd(d.changePct, 2)}%)
📊 RVOL: <b>${d.relVol}x</b> · Float: <b>${d.floatM}M</b>
🩳 Short: ${rnd(d.shortPct, 1)}% · Score: <b>${score}/100</b>
🏷 ${flags.join(' · ') || 'No standout signals'}

${analysis || '⚠️ AI offline — showing computed levels only.'}

<b>Quick Levels:</b>
🛑 Stop: $${rnd(d.price - atr * 1.5, 4)}
🎯 TP1:  $${rnd(d.price + atr * 2, 4)}
🎯 TP2:  $${rnd(d.price + atr * 3.5, 4)}`, chatId);
}

async function cmdScan(chatId) {
  await tg('🔍 Scanning for setups...', chatId);
  const universe = [...new Set([...BASE_SCAN, ...Object.keys(watchlist)])].slice(0, 20);
  const settled  = await Promise.allSettled(universe.map(s => getStock(s)));
  const results  = [];

  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const { score, flags } = scoreSetup(r.value);
    if (score >= 55) results.push({ ...r.value, score, flags });
  }
  results.sort((a, b) => b.score - a.score);

  if (!results.length) return tg('📭 No high-conviction setups right now. Markets may be quiet.', chatId);

  let msg = `🎯 <b>MAVERICK SCAN — TOP SETUPS</b>\n\n`;
  for (const d of results.slice(0, 6)) {
    const bar = d.score >= 85 ? '🔴' : d.score >= 70 ? '🟠' : '🟡';
    msg += `${bar} <b>$${d.sym}</b> — ${d.score}/100
   $${d.price} · ${d.changePct >= 0 ? '+' : ''}${rnd(d.changePct, 1)}% · RVOL ${d.relVol}x
   ${d.flags.slice(0, 3).join(' · ')}
   Stop $${rnd(d.price - d.atr * 1.5, 4)} · TP $${rnd(d.price + d.atr * 2, 4)}\n\n`;
  }
  msg += `Use /check TICKER for full AI read.`;
  await tg(msg, chatId);
}

async function cmdSqueeze(chatId) {
  await tg('🦈 Running squeeze scan...', chatId);
  const universe = [...new Set([...BASE_SCAN, ...Object.keys(watchlist)])].slice(0, 20);
  const settled  = await Promise.allSettled(universe.map(s => getStock(s)));
  const results  = [];

  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const d     = r.value;
    const sqScr = Math.min(100, Math.round(d.shortPct * 1.5 + d.relVol * 5 + (d.floatM < 10 ? 15 : 0)));
    if (sqScr >= 35 || d.shortPct >= 15) results.push({ ...d, sqScr });
  }
  results.sort((a, b) => b.sqScr - a.sqScr);

  if (!results.length) return tg('📭 No notable squeeze setups detected.', chatId);

  let msg = `🦈 <b>SQUEEZE SCAN</b>\n\n`;
  for (const d of results.slice(0, 5)) {
    const phase = d.shortPct > 30 && d.relVol > 2 ? '🔴 PHASE 2' : d.shortPct > 15 ? '🟡 PHASE 1' : '⚪ WATCH';
    msg += `${phase} <b>$${d.sym}</b> — Squeeze Score: ${d.sqScr}/100
   Short: ${rnd(d.shortPct, 1)}% · RVOL: ${d.relVol}x · Float: ${d.floatM}M
   Trigger: $${rnd(d.price * 1.02, 4)} · Stop: $${rnd(d.price * 0.95, 4)}\n\n`;
  }
  msg += `<i>Phase 2 = shorts actively covering + retail piling in.</i>`;
  await tg(msg, chatId);
}

async function cmdPosition(parts, chatId) {
  // /position TICKER ENTRY STOP TP1 TP2 SHARES
  const [, sym, entry, stop, tp1, tp2, shares] = parts;
  if (!sym || !entry || !stop || !tp1) {
    return tg(`<b>Usage:</b> /position TICKER ENTRY STOP TP1 TP2 SHARES
<b>Example:</b> /position MDAI 1.50 1.38 1.80 2.10 500`, chatId);
  }
  const ticker = sym.toUpperCase();
  const rr     = rnd((+tp1 - +entry) / (+entry - +stop), 2);
  positions[ticker] = {
    entry: +entry, stop: +stop, tp1: +tp1,
    tp2: tp2 ? +tp2 : null, shares: shares ? +shares : 100,
    entryTime: Date.now(),
    alerts: { stopWarn: false, tp1: false, tp2: false, overextended: false }
  };
  await tg(`✅ <b>$${ticker} TRACKED</b>

Entry:  $${entry}
Stop:   $${stop} (${rnd((+stop - +entry) / +entry * 100, 1)}%)
TP1:    $${tp1} (+${rnd((+tp1 - +entry) / +entry * 100, 1)}%)
TP2:    ${tp2 ? `$${tp2} (+${rnd((+tp2 - +entry) / +entry * 100, 1)}%)` : 'not set'}
Shares: ${shares || 100}
R:R:    ${rr}:1

🔔 I'll warn you when price approaches your stop or hits targets.`, chatId);
}

async function cmdPositions(chatId) {
  const keys = Object.keys(positions);
  if (!keys.length) return tg('📭 No open positions.\n\nUse /position TICKER ENTRY STOP TP1 to track a trade.', chatId);

  let msg = `📊 <b>OPEN POSITIONS</b>\n\n`;
  for (const sym of keys) {
    const pos = positions[sym];
    const d   = await getStock(sym).catch(() => null);
    if (!d) { msg += `<b>$${sym}</b> — data unavailable\n\n`; continue; }
    const pl      = rnd((d.price - pos.entry) / pos.entry * 100, 2);
    const plDollar= rnd((d.price - pos.entry) * pos.shares, 2);
    const stopDist= rnd((d.price - pos.stop) / d.price * 100, 1);
    const tp1Dist = pos.tp1 ? rnd((pos.tp1 - d.price) / d.price * 100, 1) : null;
    const icon    = pl >= 0 ? '📈' : '📉';
    msg += `${icon} <b>$${sym}</b>
   Entry $${pos.entry} → Now $${d.price}
   P&L: ${pl >= 0 ? '+' : ''}${pl}% ($${plDollar >= 0 ? '+' : ''}${plDollar})
   Stop: $${pos.stop} (${stopDist}% away) ${stopDist < 3 ? '⚠️' : ''}
   TP1: ${pos.tp1 ? `$${pos.tp1} (${tp1Dist}% away)` : '—'}
   RVOL: ${d.relVol}x\n\n`;
  }
  await tg(msg, chatId);
}

async function cmdClose(sym, chatId) {
  const ticker = sym.toUpperCase();
  if (!positions[ticker]) return tg(`❌ No tracked position for $${ticker}`, chatId);
  const pos = positions[ticker];
  delete positions[ticker];
  const d   = await getStock(ticker).catch(() => null);
  if (d) {
    const pl      = rnd((d.price - pos.entry) / pos.entry * 100, 2);
    const plDollar= rnd((d.price - pos.entry) * pos.shares, 2);
    await tg(`🏁 <b>$${ticker} CLOSED</b>
   Entry: $${pos.entry} | Exit: $${d.price}
   P&L: ${pl >= 0 ? '+' : ''}${pl}% ($${plDollar >= 0 ? '+' : ''}${plDollar})
   Shares: ${pos.shares}`, chatId);
  } else {
    await tg(`✅ $${ticker} position removed.`, chatId);
  }
}

async function cmdWatch(sym, chatId) {
  const ticker = sym.toUpperCase();
  watchlist[ticker] = { added: Date.now() };
  await tg(`👁 <b>$${ticker}</b> added to scan universe.\nIt'll appear in /scan and /squeeze results.`, chatId);
}

async function cmdAlert(parts, chatId) {
  const [, sym, price, direction] = parts;
  if (!sym || !price) {
    return tg(`<b>Usage:</b> /alert TICKER PRICE above|below
<b>Example:</b> /alert MDAI 2.00 above`, chatId);
  }
  priceAlerts.push({ ticker: sym.toUpperCase(), price: +price, direction: direction || 'above', chatId, fired: false });
  await tg(`🔔 Alert set: $${sym.toUpperCase()} ${direction || 'above'} $${price}`, chatId);
}

async function cmdNews(chatId) {
  await tg('📰 Pulling top catalysts...', chatId);
  const news  = await fh('/news?category=general').catch(() => null);
  if (!Array.isArray(news)) return tg('❌ News unavailable right now.', chatId);
  const clean = s => (s||'').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase() || '—';
  let msg = `📰 <b>TOP CATALYSTS</b>\n\n`;
  news.filter(n => n.headline).slice(0, 8).forEach((n, i) => {
    const ageMin = Math.round((Date.now()/1000 - n.datetime) / 60);
    const age    = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin/60)}h`;
    msg += `${i+1}. <b>${clean(n.related)}</b> · ${age} ago\n${n.headline}\n\n`;
  });
  await tg(msg, chatId);
}

async function cmdAI(text, chatId) {
  const reply = await ai(
    `You are the Maverick Trading Bot — an elite trading assistant AND brilliant general AI.
For trading: apply Maverick Whale Doctrine (Phase 1-2 entry, tight float, whale volume, hard stops).
For anything else: answer like a knowledgeable, direct friend. No disclaimers, no fluff.
You have memory of this conversation. Keep responses under 280 words. Use plain text — avoid heavy markdown.`,
    text, 500, chatId
  );
  if (reply) await tg(reply, chatId);
  else await tg('⚠️ AI brain offline. Try /check TICKER for stock analysis.', chatId);
}

// ── BACKGROUND MONITORS ──────────────────────────────────────────

async function monitorPositions() {
  for (const [sym, pos] of Object.entries(positions)) {
    const d = await getStock(sym).catch(() => null);
    if (!d) continue;
    const price    = d.price;
    const pct      = (price - pos.entry) / pos.entry * 100;
    const stopDist = (price - pos.stop) / pos.stop * 100;

    // Stop approaching warning (within 3%)
    if (stopDist < 3 && !pos.alerts.stopWarn) {
      pos.alerts.stopWarn = true;
      await tg(`⚠️⚠️ <b>$${sym} — STOP APPROACHING</b>
Price $${price} is only ${rnd(stopDist, 1)}% from stop at $${pos.stop}
RVOL: ${d.relVol}x ${d.relVol > 2 ? '⚡ Volume spiking' : '· Normal volume'}
If thesis is broken — exit. Do not let a small loss become a big one.`);
    } else if (stopDist >= 6) {
      pos.alerts.stopWarn = false; // Reset after bouncing
    }

    // Stop hit
    if (price <= pos.stop) {
      await tg(`🛑 <b>$${sym} STOP HIT</b>
Price: $${price} | Stop: $${pos.stop}
P&L: ${rnd(pct, 1)}%
Exit NOW. Protect the account.`);
    }

    // TP1 hit
    if (pos.tp1 && price >= pos.tp1 && !pos.alerts.tp1) {
      pos.alerts.tp1 = true;
      await tg(`🎯 <b>$${sym} TP1 HIT — $${pos.tp1}</b>
Price: $${price} (+${rnd(pct, 1)}%)
Maverick rule: Sell 50% here. Move stop to breakeven. Let runner work.
TP2: ${pos.tp2 ? `$${pos.tp2}` : 'set your next target with /position'}`);
    }

    // TP2 hit
    if (pos.tp2 && price >= pos.tp2 && !pos.alerts.tp2) {
      pos.alerts.tp2 = true;
      await tg(`💰 <b>$${sym} TP2 HIT — $${pos.tp2}</b>
Price: $${price} (+${rnd(pct, 1)}%)
Sell another 30%. Trail the remaining 20% aggressively.`);
    }

    // Overextended — up big without hitting a TP
    if (pct > 25 && !pos.alerts.tp1 && !pos.alerts.overextended) {
      pos.alerts.overextended = true;
      await tg(`📡 <b>$${sym} OVEREXTENDED</b>
+${rnd(pct, 1)}% from entry $${pos.entry} — no TP set for this level.
RVOL: ${d.relVol}x ${d.relVol < 1.5 ? '⚠️ Volume fading — distribution risk' : ''}
Whale Doctrine: Consider scaling out before crowd turns to seller.`);
    }
  }
}

async function checkPriceAlerts() {
  for (const alert of priceAlerts.filter(a => !a.fired)) {
    const d = await getStock(alert.ticker).catch(() => null);
    if (!d) continue;
    const triggered = alert.direction === 'above' ? d.price >= alert.price : d.price <= alert.price;
    if (triggered) {
      alert.fired = true;
      await tg(`🔔 <b>PRICE ALERT — $${alert.ticker}</b>
${alert.direction === 'above' ? '📈' : '📉'} Price $${d.price} is ${alert.direction} $${alert.price}
Change: ${d.changePct >= 0 ? '+' : ''}${rnd(d.changePct, 2)}% · RVOL: ${d.relVol}x
Use /check ${alert.ticker} for full analysis.`, alert.chatId || CHAT_ID);
    }
  }
}

async function scanNewsIntel() {
  try {
    const news = await fh('/news?category=general');
    if (!Array.isArray(news)) return;
    const TIER1 = ['fda approval','fda approved','merger','acquisition','buyout','earnings beat','short squeeze','trading halted','halt','ipo','barda','government contract','phase 3','reverse split','buyback','uplisting','nasdaq compliance'];
    const NEG   = ['going concern','dilut','offering','atm shelf','bankruptcy','delisting','class action','default'];
    const fresh = news.filter(n => n.datetime > lastNewsTs && n.headline);
    if (fresh.length) lastNewsTs = Math.max(...fresh.map(n => n.datetime));
    for (const n of fresh) {
      if (sentHeadlines.has(n.headline)) continue;
      const text = (n.headline + ' ' + (n.summary||'')).toLowerCase();
      const hits = TIER1.filter(k => text.includes(k));
      const negs = NEG.filter(k => text.includes(k));
      if (hits.length > 0 && negs.length === 0) {
        sentHeadlines.add(n.headline);
        const ageMin = Math.round((Date.now()/1000 - n.datetime) / 60);
        const clean  = s => (s||'').split(',')[0].replace(/[^A-Z]/gi,'').trim().toUpperCase() || '—';
        await tg(`🔴 <b>HIGH CONVICTION CATALYST</b>
📰 ${n.headline}
🏦 ${n.source} · ${ageMin}m ago
📌 ${clean(n.related)} · <i>${hits.slice(0,3).join(', ')}</i>

/check ${clean(n.related)}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  } catch (e) { console.error('[NEWS SCAN]', e.message); }
}

// ── TELEGRAM POLL LOOP ───────────────────────────────────────────
async function poll() {
  try {
    // AbortController fixes node-fetch v2 timeout (the { timeout } option is silently ignored)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let r;
    try {
      r = await fetch(
        `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`,
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timer);
    }
    const d = await r.json();
    if (!d.ok || !d.result?.length) {
      if (!d.ok) console.error('[POLL] Telegram error:', d.description || JSON.stringify(d));
      return;
    }
    for (const update of d.result) {
      lastUpdateId = update.update_id;
      // Support both direct messages and group/channel posts
      const msg = update.message || update.channel_post;
      if (!msg?.text) continue;
      const chatId = String(msg.chat.id);
      const text   = msg.text.trim();
      const parts  = text.split(/\s+/);
      const cmd    = parts[0].toLowerCase().split('@')[0];
      console.log(`[MSG] chatId=${chatId} cmd=${cmd}`);
      try {
        if      (cmd === '/start' || cmd === '/help')  await cmdStart(chatId);
        else if (cmd === '/check'   && parts[1])       await cmdCheck(parts[1].toUpperCase(), chatId);
        else if (cmd === '/scan')                      await cmdScan(chatId);
        else if (cmd === '/squeeze')                   await cmdSqueeze(chatId);
        else if (cmd === '/position')                  await cmdPosition(parts, chatId);
        else if (cmd === '/positions')                 await cmdPositions(chatId);
        else if (cmd === '/close'   && parts[1])       await cmdClose(parts[1], chatId);
        else if (cmd === '/watch'   && parts[1])       await cmdWatch(parts[1], chatId);
        else if (cmd === '/alert')                     await cmdAlert(parts, chatId);
        else if (cmd === '/news')                      await cmdNews(chatId);
        else if (!text.startsWith('/'))                await cmdAI(text, chatId);
        else await tg('Unknown command. Type /help for the menu.', chatId);
      } catch (e) {
        console.error('[CMD]', cmd, e.message);
        await tg(`⚠️ Error: ${e.message}`, chatId);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.message?.includes('timeout')) {
      // silent retry — normal long-poll timeout
    } else {
      console.error('[POLL]', e.message);
    }
  }
  // Always reschedule no matter what
  setTimeout(poll, 500);
}

// ── STARTUP ───────────────────────────────────────────────────────
async function start() {
  console.log('\n[MAVERICK INTEL BOT v2.0] Initializing...');
  console.log(`  Groq (primary):  ${GROQ_KEY ? '✅' : '❌ MISSING'}`);
  console.log(`  Cerebras (backup): ${CBRS_KEY ? '✅' : '⚠️  not set'}`);
  console.log(`  Finnhub:         ${FINNHUB  ? '✅' : '❌ MISSING'}`);
  console.log(`  Telegram:        ${TG_TOKEN ? '✅' : '❌ MISSING'}`);
  console.log(`  Intel Bot:       ${TG_TOKEN ? '✅ launched' : '❌'}`);

  if (!TG_TOKEN) { console.error('[BOT] No Telegram token. Bot disabled.'); return; }

  await tg(`🤖 <b>MAVERICK INTEL BOT v2.0 — ONLINE</b>

✅ Position monitor (60s)
✅ Price alerts (30s)
✅ News catalyst scanner (2min)
🧠 Brain: ${GROQ_KEY ? 'Groq primary + Cerebras backup' : CBRS_KEY ? 'Cerebras only' : '⚠️ NO AI — check keys'}

Type /help for all commands.`);

  setInterval(monitorPositions, 60000);
  setInterval(checkPriceAlerts, 30000);
  setInterval(scanNewsIntel,   120000);

  poll(); // Start long-poll loop
}

start();
