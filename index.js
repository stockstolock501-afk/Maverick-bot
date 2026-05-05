require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const fetch       = require('node-fetch');
const http        = require('http');

// ── ENV ──────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const JSONBIN_KEY    = process.env.JSONBIN_KEY;   // free at jsonbin.io
const JSONBIN_BIN    = process.env.JSONBIN_BIN;   // created on first run
const GROQ_KEY       = process.env.GROQ_KEY;      // free at console.groq.com

if (!TELEGRAM_TOKEN || !FINNHUB_KEY) {
  console.error('❌ Missing TELEGRAM_TOKEN or FINNHUB_KEY');
  process.exit(1);
}

// ── BOT ───────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ── TRADE STATE ───────────────────────────────────────────────────────────────
const watches     = new Map();
const trades      = new Map();
const subscribers = new Map();
const volTracker  = new Map();

// ── JSONBIN TRADE LOG ─────────────────────────────────────────────────────────
// Free at jsonbin.io — stores all trades as JSON forever
async function logLoad() {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return [];
  try {
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_KEY }
    });
    const d = await r.json();
    return d.record?.trades || [];
  } catch { return []; }
}

async function logSave(trades) {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return;
  try {
    await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
      body: JSON.stringify({ trades })
    });
  } catch {}
}

async function logTrade(entry) {
  const all = await logLoad();
  all.push({ ...entry, id: Date.now() });
  await logSave(all);
}

// ── GROQ AI ANALYSIS ──────────────────────────────────────────────────────────
async function groqAnalyze(prompt) {
  if (!GROQ_KEY) return null;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        messages: [
          { role: 'system', content: 'You are a professional day trading analyst. Be concise, precise, and direct. Max 3 sentences per response.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

// ── FINNHUB WEBSOCKET ─────────────────────────────────────────────────────────
let ws;
function connectFinnhub() {
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => {
    console.log('✅ Finnhub WS connected');
    for (const sym of subscribers.keys()) ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'trade' && Array.isArray(msg.data))
        msg.data.forEach(t => onTick(t.s, t.p, t.v));
    } catch {}
  });
  ws.on('close', () => { console.log('🔄 WS reconnecting...'); setTimeout(connectFinnhub, 3000); });
  ws.on('error', e => console.error('WS error:', e.message));
}

function wsSub(sym, action) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: action, symbol: sym }));
}
function addSub(sym, id) {
  if (!subscribers.has(sym)) subscribers.set(sym, new Set());
  if (!subscribers.get(sym).size) wsSub(sym, 'subscribe');
  subscribers.get(sym).add(id);
}
function removeSub(sym, id) {
  const s = subscribers.get(sym);
  if (!s) return;
  s.delete(id);
  if (!s.size) { subscribers.delete(sym); wsSub(sym, 'unsubscribe'); }
}

// ── FINNHUB REST ──────────────────────────────────────────────────────────────
async function getQuote(sym) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
    return await r.json();
  } catch { return null; }
}
async function getAvgVolume(sym) {
  try {
    const to = Math.floor(Date.now() / 1000), from = to - 30 * 86400;
    const r  = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${sym}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d  = await r.json();
    if (d.v?.length) return d.v.reduce((a, b) => a + b, 0) / d.v.length;
  } catch {}
  return null;
}
async function getNews(sym) {
  try {
    const to   = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    const r    = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d    = await r.json();
    return d?.[0]?.headline || null;
  } catch { return null; }
}

// ── TRADE MATH ────────────────────────────────────────────────────────────────
function calcLevels(entry, customStop) {
  const stopPct = entry < 5 ? 0.035 : entry < 10 ? 0.028 : entry < 30 ? 0.02 : 0.015;
  const stop    = customStop || +(entry * (1 - stopPct)).toFixed(2);
  const risk    = entry - stop;
  return {
    stop,
    t1: +(entry + risk * 2).toFixed(2),
    t2: +(entry + risk * 3.5).toFixed(2),
    t3: +(entry + risk * 5.5).toFixed(2),
    risk: +risk.toFixed(2),
  };
}
function totalShares(tr) { return tr.shares + tr.adds.reduce((s, a) => s + a.shares, 0); }
function avgCostCalc(tr) {
  const base = tr.entryPrice * tr.shares + tr.adds.reduce((s, a) => s + a.price * a.shares, 0);
  return +(base / totalShares(tr)).toFixed(2);
}
function totalPnl(tr, exitPrice) {
  return +((exitPrice - tr.entryPrice) * tr.shares + tr.adds.reduce((s, a) => s + (exitPrice - a.price) * a.shares, 0)).toFixed(2);
}

// ── TICK HANDLER ──────────────────────────────────────────────────────────────
function onTick(sym, price, vol) {
  // Volume tracking
  if (!volTracker.has(sym)) volTracker.set(sym, { v1m: 0, reset: Date.now() });
  const vt = volTracker.get(sym);
  if (Date.now() - vt.reset > 60000) { vt.v1m = 0; vt.reset = Date.now(); }
  vt.v1m += vol;

  // ── WATCHES ─────────────────────────────────────────────────────────────────
  for (const [chatId, w] of watches) {
    if (w.symbol !== sym || w.confirmed) continue;
    w.currentPrice = price;
    if (price >= w.entryLevel) {
      const avgPerMin = w.avgVolume ? w.avgVolume / 390 : null;
      const volRatio  = avgPerMin ? vt.v1m / avgPerMin : 99;
      if (volRatio >= 1.5) {
        w.confirmed = true;
        const lv = calcLevels(price, w.customStop);
        w.levels = lv;
        send(chatId,
          `🔥 *ENTRY CONFIRMED — ${sym}*\n\n` +
          `✅ Price: *$${price.toFixed(2)}* | Volume: *${volRatio.toFixed(1)}x avg*\n\n` +
          `🛑 Stop: *$${lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n🎯 T3: *$${lv.t3}*\n\n` +
          `Text: _in at ${price.toFixed(2)} with 200 shares_`
        );
      }
    }
  }

  // ── ACTIVE TRADES ────────────────────────────────────────────────────────────
  for (const [chatId, tr] of trades) {
    if (tr.symbol !== sym) continue;
    const prev = tr.currentPrice || tr.entryPrice;
    tr.currentPrice = price;
    const minsIn  = (Date.now() - tr.entryTime) / 60000;
    const pnl     = totalPnl(tr, price);
    const pnlPct  = (((price - tr.avgCost) / tr.avgCost) * 100).toFixed(2);
    const avgPMin = tr.avgVolume ? tr.avgVolume / 390 : null;
    const volR    = avgPMin ? vt.v1m / avgPMin : 0;

    // High water mark + trail
    if (price > tr.hwm) {
      tr.hwm = price;
      if (tr.t1Hit) {
        const trail = +(price - (price - tr.avgCost) * 0.40).toFixed(2);
        if (trail > tr.trailingStop) tr.trailingStop = trail;
      }
    }

    // STOP HIT
    if (!tr.stopAlerted && price <= tr.stopLoss) {
      tr.stopAlerted = true;
      send(chatId, `🚨 *STOP HIT — ${sym}*\nPrice: *$${price.toFixed(2)}* | Stop: *$${tr.stopLoss}*\nP&L: *-$${Math.abs(pnl).toFixed(2)}*\n\n❌ *EXIT NOW.* Text: _out at ${price.toFixed(2)}_`);
    }

    // TRAILING STOP
    if (tr.t1Hit && !tr.trailAlerted && price <= tr.trailingStop) {
      tr.trailAlerted = true;
      send(chatId, `⚠️ *TRAIL STOP — ${sym}*\nPrice: *$${price.toFixed(2)}* | Trail: *$${tr.trailingStop}*\nLocked profit: *+$${pnl.toFixed(2)}*\n\nText: _out at ${price.toFixed(2)}_`);
    }

    // TARGET 1
    if (!tr.t1Hit && price >= tr.targets.t1) {
      tr.t1Hit = true; tr.stopLoss = tr.avgCost; tr.stopAlerted = false; tr.trailAlerted = false;
      const p = totalPnl(tr, tr.targets.t1);
      send(chatId, `🎯 *TARGET 1 — ${sym}*\nPrice: *$${price.toFixed(2)}* | Profit: *+$${p.toFixed(2)}*\n\n✅ Sell 50% → lock $${(p*0.5).toFixed(2)}\n🔄 Stop → BREAKEVEN: *$${tr.avgCost}*\n🎯 Next: *$${tr.targets.t2}*`);
    }

    // TARGET 2
    if (!tr.t2Hit && price >= tr.targets.t2) {
      tr.t2Hit = true;
      const p = totalPnl(tr, tr.targets.t2);
      send(chatId, `🎯🎯 *TARGET 2 — ${sym}*\nPrice: *$${price.toFixed(2)}* | Profit: *+$${p.toFixed(2)}*\n\n✅ Sell rest OR hold moon bag to T3: *$${tr.targets.t3}*`);
    }

    // ADD SIGNAL
    if (!tr.addSent && tr.t1Hit && !tr.t2Hit && !tr.trailAlerted) {
      const pctGain = ((price - tr.avgCost) / tr.avgCost) * 100;
      if (pctGain > 4 && volR > 2 && price > prev * 0.995) {
        tr.addSent = true;
        send(chatId, `📈 *ADD SIGNAL — ${sym}*\nVol: *${volR.toFixed(1)}x* | Move: *+${pctGain.toFixed(1)}%* | No reversal\n\n✅ Low risk to add\nTight stop on add: *$${(price*0.985).toFixed(2)}*\nText: _added 100 at ${price.toFixed(2)}_`);
      }
    }

    // 45 MIN WARNING
    if (!tr.warn45 && minsIn >= 45) {
      tr.warn45 = true;
      send(chatId, `⏱ *45-MIN WARNING — ${sym}*\nIn: *${minsIn.toFixed(0)}min* | P&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}* (${pnlPct}%)\n\n${!tr.t1Hit ? '⚠️ T1 not hit — re-evaluate.' : '✅ T1 hit — consider full exit.'}\n\nText _status_ or _out at [price]_`);
    }

    // 90 MIN WARNING
    if (!tr.warn90 && minsIn >= 90) {
      tr.warn90 = true;
      send(chatId, `🚨 *90-MIN — ${sym}*\nYou've been in *${minsIn.toFixed(0)} minutes*\nP&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}*\n\nDay trade momentum is typically exhausted.\n*Strongly consider exiting.*\nText: _out at ${price.toFixed(2)}_`);
    }
  }
}

// ── SEND ──────────────────────────────────────────────────────────────────────
function send(chatId, text) {
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(e => console.error('Send:', e.message));
}

// ── PARSE ─────────────────────────────────────────────────────────────────────
function parse(text) {
  const t = text.trim();
  let m;

  m = t.match(/^watch(?:ing)?\s+([A-Za-z]{1,5})\s+(?:at|for)?\s*\$?(\d+\.?\d*)(?:\s+stop\s*\$?(\d+\.?\d*))?/i);
  if (m) return { cmd: 'watch', symbol: m[1].toUpperCase(), price: +m[2], stop: m[3] ? +m[3] : null };

  m = t.match(/^in\b.*?\$?(\d+\.?\d*)\D+(\d+)/i);
  if (m) return { cmd: 'in', price: +m[1], shares: +m[2] };

  m = t.match(/^out\b.*?\$?(\d+\.?\d*)/i);
  if (m) return { cmd: 'out', price: +m[1] };

  m = t.match(/^add(?:ed)?\s+(\d+)[^$\d]*\$?(\d+\.?\d*)/i);
  if (m) return { cmd: 'add', shares: +m[1], price: +m[2] };

  m = t.match(/^(?:sl|stop(?:\s*loss)?)\s+\$?(\d+\.?\d*)/i);
  if (m) return { cmd: 'sl', price: +m[1] };

  m = t.match(/^([A-Z]{1,5})$/);
  if (m) return { cmd: 'quote', symbol: m[1] };

  if (/^(status|p&l|pnl|where)/i.test(t))  return { cmd: 'status' };
  if (/^(cancel|clear|reset)/i.test(t))     return { cmd: 'cancel' };
  if (/^help$/i.test(t))                    return { cmd: 'help' };

  // Trade log commands
  if (/^(daily|today.*trades?|trades? today)/i.test(t))   return { cmd: 'daily' };
  if (/^(weekly|week.*trades?|this week)/i.test(t))        return { cmd: 'weekly' };
  if (/^(monthly|month.*trades?|this month)/i.test(t))     return { cmd: 'monthly' };
  if (/^(history|all trades?|log)/i.test(t))               return { cmd: 'history' };
  if (/^(analyze|analysis|review)/i.test(t))               return { cmd: 'analyze' };

  return null;
}

// ── COMMANDS ──────────────────────────────────────────────────────────────────

async function cmdWatch(chatId, symbol, entryLevel, customStop) {
  const old = watches.get(chatId);
  if (old) removeSub(old.symbol, chatId);
  watches.delete(chatId);

  send(chatId, `🔍 Pulling live data on *${symbol}*...`);
  const [quote, avgVol, news] = await Promise.all([getQuote(symbol), getAvgVolume(symbol), getNews(symbol)]);

  if (!quote?.c) { send(chatId, `❌ Can't find *${symbol}*. Check ticker.`); return; }

  const lv   = calcLevels(entryLevel, customStop);
  const curr = quote.c;
  const dist = entryLevel > curr
    ? `${(((entryLevel-curr)/curr)*100).toFixed(1)}% above — waiting`
    : `✅ At/above level now`;

  watches.set(chatId, { symbol, entryLevel, customStop, currentPrice: curr, avgVolume: avgVol, confirmed: false, levels: lv });
  addSub(symbol, chatId);

  // AI quick take
  let aiNote = '';
  if (GROQ_KEY && news) {
    const ai = await groqAnalyze(`Stock: ${symbol} at $${curr}. Recent news: "${news}". Entry level: $${entryLevel}. Short thesis on conviction to trade this.`);
    if (ai) aiNote = `\n\n🤖 *AI Read:* ${ai}`;
  }

  send(chatId,
    `👁 *WATCHING ${symbol}*\n\n` +
    `Trigger: *$${entryLevel}* | Now: *$${curr}* (${dist})\n` +
    `30d avg vol: ${avgVol ? (avgVol/1e6).toFixed(2)+'M' : 'n/a'}\n` +
    (news ? `📰 ${news.slice(0,80)}...\n` : '') +
    `\n🛑 Stop: *$${lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n🎯 T3: *$${lv.t3}*` +
    aiNote +
    `\n\n🔴 Live Finnhub feed active.`
  );
}

async function cmdIn(chatId, entryPrice, shares) {
  const w = watches.get(chatId);
  if (!w) { send(chatId, `❌ Set a watch first: _watching LFVN at 5.10_`); return; }

  const lv = calcLevels(entryPrice, w.customStop);
  const tr = {
    symbol: w.symbol, entryPrice, shares, entryTime: Date.now(),
    currentPrice: entryPrice, hwm: entryPrice, avgCost: entryPrice,
    stopLoss: lv.stop, trailingStop: lv.stop,
    targets: { t1: lv.t1, t2: lv.t2, t3: lv.t3 },
    avgVolume: w.avgVolume, adds: [],
    t1Hit: false, t2Hit: false, stopAlerted: false,
    trailAlerted: false, warn45: false, warn90: false, addSent: false,
  };

  trades.set(chatId, tr);
  watches.delete(chatId);
  addSub(w.symbol, chatId);

  const cost    = (entryPrice * shares).toFixed(2);
  const riskAmt = (lv.risk * shares).toFixed(2);

  send(chatId,
    `✅ *IN — ${w.symbol}*\n\n` +
    `Entry: *$${entryPrice}* × *${shares} shares* = *$${cost}*\n\n` +
    `🛑 *STOP: $${lv.stop}* (max loss -$${riskAmt})\n` +
    `🎯 *T1: $${lv.t1}* (+$${((lv.t1-entryPrice)*shares).toFixed(2)}) → sell 50%\n` +
    `🎯 *T2: $${lv.t2}* (+$${((lv.t2-entryPrice)*shares).toFixed(2)}) → sell rest\n` +
    `🎯 *T3: $${lv.t3}* 🚀 moon bag\n\n` +
    `🔴 Monitoring: stop · targets · trail · 45-min · add signals\n` +
    `Text _out at [price]_ to close.`
  );
}

async function cmdOut(chatId, exitPrice) {
  const tr = trades.get(chatId);
  if (!tr) { send(chatId, `No active trade.`); return; }

  const pnl    = totalPnl(tr, exitPrice);
  const ts     = totalShares(tr);
  const mins   = ((Date.now() - tr.entryTime) / 60000).toFixed(0);
  const pnlPct = (((exitPrice - tr.avgCost) / tr.avgCost) * 100).toFixed(2);
  const isWin  = pnl > 0;

  // Log the trade
  const record = {
    symbol: tr.symbol, date: new Date().toISOString().split('T')[0],
    entryPrice: tr.entryPrice, exitPrice, shares: ts,
    avgCost: tr.avgCost, pnl, pnlPct: +pnlPct,
    minutesInTrade: +mins, t1Hit: tr.t1Hit, t2Hit: tr.t2Hit,
  };
  await logTrade(record);

  removeSub(tr.symbol, chatId);
  trades.delete(chatId);

  send(chatId,
    `${isWin ? '💰' : '📉'} *CLOSED — ${tr.symbol}*\n\n` +
    `$${tr.entryPrice} → *$${exitPrice}* | ${ts} shares | ${mins}min\n\n` +
    `${isWin ? '✅' : '❌'} *P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}* (${pnlPct}%)\n\n` +
    `${isWin ? '🔥 Banked. Well executed.' : '💪 Stop respected. Capital preserved.'}\n` +
    `Text _daily_ to see today's P&L.`
  );
}

function cmdAdd(chatId, shares, price) {
  const tr = trades.get(chatId);
  if (!tr) { send(chatId, `No active trade.`); return; }
  tr.adds.push({ shares, price });
  tr.avgCost = avgCostCalc(tr);
  send(chatId,
    `📈 *ADDED — ${tr.symbol}*\n` +
    `+${shares} shares @ $${price}\n` +
    `Total: ${totalShares(tr)} shares | Avg: *$${tr.avgCost}*\n` +
    `Stop: *$${tr.stopLoss}*`
  );
}

function cmdSl(chatId, newStop) {
  const tr = trades.get(chatId);
  const w  = watches.get(chatId);
  if (tr) { tr.stopLoss = newStop; tr.stopAlerted = false; send(chatId, `✅ Stop → *$${newStop}* on *${tr.symbol}*`); }
  else if (w) { w.customStop = newStop; send(chatId, `✅ Stop set → *$${newStop}* on *${w.symbol}*`); }
  else send(chatId, `No active trade.`);
}

async function cmdQuote(chatId, sym) {
  const q = await getQuote(sym);
  if (!q?.c) { send(chatId, `❌ Can't fetch *${sym}*.`); return; }
  const chg = q.dp >= 0 ? `+${q.dp?.toFixed(2)}%` : `${q.dp?.toFixed(2)}%`;
  send(chatId, `📊 *${sym}* — *$${q.c}* (${chg})\nH: $${q.h} | L: $${q.l} | Prev: $${q.pc}\n\n_watching ${sym} at ${q.c}_`);
}

function cmdStatus(chatId) {
  const tr = trades.get(chatId);
  const w  = watches.get(chatId);
  if (tr) {
    const p    = tr.currentPrice || tr.entryPrice;
    const pnl  = totalPnl(tr, p);
    const pct  = (((p - tr.avgCost) / tr.avgCost) * 100).toFixed(2);
    const mins = ((Date.now() - tr.entryTime) / 60000).toFixed(0);
    send(chatId,
      `📊 *LIVE — ${tr.symbol}*\n\n` +
      `Entry: $${tr.entryPrice} | Now: *$${p.toFixed(2)}*\n` +
      `Avg: $${tr.avgCost} | Shares: ${totalShares(tr)}\n` +
      `P&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}* (${pct}%)\n` +
      `Time: *${mins}min*\n\n` +
      `🛑 Hard stop: *$${tr.stopLoss}*\n` +
      `🔄 Trail: *$${tr.trailingStop}*\n` +
      `🎯 T1: $${tr.targets.t1} ${tr.t1Hit?'✅':'⏳'} | T2: $${tr.targets.t2} ${tr.t2Hit?'✅':'⏳'}`
    );
  } else if (w) {
    send(chatId, `👁 Watching *${w.symbol}* → trigger $${w.entryLevel} | Now: $${w.currentPrice?.toFixed(2)||'...'}`);
  } else {
    send(chatId, `No active trade.\nText: _watching [TICKER] at [price]_`);
  }
}

function cmdCancel(chatId) {
  const sym = watches.get(chatId)?.symbol || trades.get(chatId)?.symbol;
  if (sym) removeSub(sym, chatId);
  watches.delete(chatId); trades.delete(chatId);
  send(chatId, `✅ Cleared. Ready.\n\nText: _watching [TICKER] at [price]_`);
}

// ── TRADE LOG COMMANDS ────────────────────────────────────────────────────────

function filterTrades(all, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return all.filter(t => new Date(t.date) >= cutoff);
}

function tradeSummary(label, list) {
  if (!list.length) return `No trades in ${label}.`;
  const wins    = list.filter(t => t.pnl > 0);
  const losses  = list.filter(t => t.pnl <= 0);
  const total   = list.reduce((s, t) => s + t.pnl, 0);
  const winRate = ((wins.length / list.length) * 100).toFixed(0);
  const avgWin  = wins.length  ? (wins.reduce((s,t)=>s+t.pnl,0)/wins.length).toFixed(2) : '0';
  const avgLoss = losses.length? (losses.reduce((s,t)=>s+t.pnl,0)/losses.length).toFixed(2): '0';
  const best    = list.reduce((a,b) => a.pnl > b.pnl ? a : b);
  const worst   = list.reduce((a,b) => a.pnl < b.pnl ? a : b);

  let msg = `📊 *${label.toUpperCase()} REPORT*\n\n`;
  msg += `Trades: *${list.length}* | Win rate: *${winRate}%*\n`;
  msg += `${total>=0?'✅':'❌'} Total P&L: *${total>=0?'+':''}$${total.toFixed(2)}*\n\n`;
  msg += `🏆 Avg win: *+$${avgWin}* | Avg loss: *$${avgLoss}*\n`;
  msg += `🔝 Best: *${best.symbol}* +$${best.pnl.toFixed(2)}\n`;
  msg += `💀 Worst: *${worst.symbol}* $${worst.pnl.toFixed(2)}\n\n`;
  msg += `Recent trades:\n`;
  list.slice(-5).reverse().forEach(t => {
    msg += `${t.pnl>=0?'✅':'❌'} ${t.symbol} ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)} (${t.pnlPct}%) ${t.minutesInTrade}min\n`;
  });
  return msg;
}

async function cmdDaily(chatId) {
  const all  = await logLoad();
  const today = new Date().toISOString().split('T')[0];
  const list = all.filter(t => t.date === today);
  send(chatId, tradeSummary("Today", list));
}

async function cmdWeekly(chatId) {
  const all  = await logLoad();
  const list = filterTrades(all, 7);
  send(chatId, tradeSummary("This Week", list));
}

async function cmdMonthly(chatId) {
  const all  = await logLoad();
  const list = filterTrades(all, 30);
  send(chatId, tradeSummary("This Month", list));
}

async function cmdHistory(chatId) {
  const all = await logLoad();
  if (!all.length) { send(chatId, `No trades logged yet.`); return; }
  let msg = `📋 *ALL TRADES* (last 10)\n\n`;
  all.slice(-10).reverse().forEach((t,i) => {
    msg += `${i+1}. ${t.date} | *${t.symbol}* | ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)} | ${t.minutesInTrade}min\n`;
  });
  send(chatId, msg);
}

async function cmdAnalyze(chatId) {
  if (!GROQ_KEY) { send(chatId, `Add GROQ_KEY to Railway env for AI analysis (free at console.groq.com)`); return; }
  const all = await logLoad();
  if (all.length < 3) { send(chatId, `Need at least 3 completed trades for analysis.`); return; }

  send(chatId, `🤖 Running AI analysis on your trades...`);
  const summary = all.slice(-20).map(t =>
    `${t.symbol}: ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}, held ${t.minutesInTrade}min, T1 hit: ${t.t1Hit}`
  ).join('\n');

  const ai = await groqAnalyze(
    `Analyze these day trades and identify the trader's 3 biggest mistakes and 2 biggest strengths. Be specific.\n\nTrades:\n${summary}`
  );
  send(chatId, `🤖 *AI TRADE ANALYSIS*\n\n${ai || 'Analysis unavailable.'}`);
}

function cmdHelp(chatId) {
  send(chatId,
    `🤖 *MAVERICK TRADE BOT v2*\n\n` +
    `*TRADE FLOW:*\n` +
    `_watching LFVN at 5.10_ — watch\n` +
    `_watching LFVN at 5.10 stop 4.80_ — custom stop\n` +
    `_in at 5.11 with 200 shares_ — log entry\n` +
    `_added 100 at 5.50_ — add to position\n` +
    `_sl 4.88_ — override stop\n` +
    `_out at 5.85_ — close + log P&L\n` +
    `_status_ — live P&L\n` +
    `_LFVN_ — quick quote\n` +
    `_cancel_ — reset\n\n` +
    `*TRADE LOG:*\n` +
    `_daily_ — today's P&L report\n` +
    `_weekly_ — 7-day report\n` +
    `_monthly_ — 30-day report\n` +
    `_history_ — last 10 trades\n` +
    `_analyze_ — AI reviews your trading\n\n` +
    `Auto alerts: entry confirm · stop · T1 · T2 · trail · 45min · 90min · add signals`
  );
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  if (!text) return;
  console.log(`[${chatId}] ${msg.from?.first_name}: ${text}`);

  const p = parse(text);
  if (!p) { send(chatId, `Text _help_ for commands.\nOr: _watching [TICKER] at [price]_`); return; }

  switch (p.cmd) {
    case 'watch':   return cmdWatch(chatId, p.symbol, p.price, p.stop);
    case 'in':      return cmdIn(chatId, p.price, p.shares);
    case 'out':     return cmdOut(chatId, p.price);
    case 'add':     return cmdAdd(chatId, p.shares, p.price);
    case 'sl':      return cmdSl(chatId, p.price);
    case 'quote':   return cmdQuote(chatId, p.symbol);
    case 'status':  return cmdStatus(chatId);
    case 'cancel':  return cmdCancel(chatId);
    case 'help':    return cmdHelp(chatId);
    case 'daily':   return cmdDaily(chatId);
    case 'weekly':  return cmdWeekly(chatId);
    case 'monthly': return cmdMonthly(chatId);
    case 'history': return cmdHistory(chatId);
    case 'analyze': return cmdAnalyze(chatId);
  }
});

bot.on('polling_error', e => console.error('Polling:', e.message));

// ── AUTO SCANNER (fires every 30min during market hours) ──────────────────────
// Sends Telegram alerts when supernova conditions detected via Finnhub
async function autoScan() {
  const now   = new Date();
  const dayOfWeek = now.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return; // no weekends

  const etHour = (now.getUTCHours() - 5 + 24) % 24;
  const etMin  = now.getUTCMinutes();
  const totalMin = etHour * 60 + etMin;
  if (totalMin < 9*60+25 || totalMin > 16*60) return; // market hours only

  // Alert all subscribed chats — placeholder for future scan integration
  console.log('Auto-scan tick:', new Date().toLocaleTimeString());
}

setInterval(autoScan, 30 * 60 * 1000);

// ── KEEP-ALIVE ────────────────────────────────────────────────────────────────
connectFinnhub();
http.createServer((_, res) => res.end('Maverick Bot v2 alive')).listen(3000, () => {
  console.log('🤖 Maverick Trade Bot v2 running');
  console.log(`   Finnhub: ✅ | Trade Log: ${JSONBIN_KEY?'✅':'⚠️ add JSONBIN_KEY'} | AI: ${GROQ_KEY?'✅':'⚠️ add GROQ_KEY'}`);
});
