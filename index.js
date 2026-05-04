require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const fetch       = require('node-fetch');
const http        = require('http');

// ── ENV ──────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;

if (!TELEGRAM_TOKEN || !FINNHUB_KEY) {
  console.error('❌ Missing TELEGRAM_TOKEN or FINNHUB_KEY in environment');
  process.exit(1);
}

// ── BOT INIT ─────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ── STATE ─────────────────────────────────────────────────────────────────────
const watches     = new Map(); // chatId → watch object
const trades      = new Map(); // chatId → trade object
const subscribers = new Map(); // symbol → Set<chatId>
const volTracker  = new Map(); // symbol → { vol1min, lastReset }

// ── FINNHUB WEBSOCKET ─────────────────────────────────────────────────────────
let ws;

function connectFinnhub() {
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  ws.on('open', () => {
    console.log('✅ Finnhub WebSocket connected');
    for (const sym of subscribers.keys()) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
    }
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'trade' && Array.isArray(msg.data)) {
        for (const t of msg.data) onTick(t.s, t.p, t.v);
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    console.log('🔄 Finnhub WS closed — reconnecting in 3s');
    setTimeout(connectFinnhub, 3000);
  });

  ws.on('error', err => console.error('Finnhub WS error:', err.message));
}

function wsSend(sym, action) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: action, symbol: sym }));
}

function addSub(sym, chatId) {
  if (!subscribers.has(sym)) subscribers.set(sym, new Set());
  const first = subscribers.get(sym).size === 0;
  subscribers.get(sym).add(chatId);
  if (first) wsSend(sym, 'subscribe');
}

function removeSub(sym, chatId) {
  const s = subscribers.get(sym);
  if (!s) return;
  s.delete(chatId);
  if (s.size === 0) { subscribers.delete(sym); wsSend(sym, 'unsubscribe'); }
}

// ── FINNHUB REST ──────────────────────────────────────────────────────────────
async function getQuote(sym) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
    return await r.json();
  } catch (_) { return null; }
}

async function getAvgVolume(sym) {
  try {
    const to   = Math.floor(Date.now() / 1000);
    const from = to - 30 * 86400;
    const r    = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${sym}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d    = await r.json();
    if (d.v && d.v.length > 0) return d.v.reduce((a, b) => a + b, 0) / d.v.length;
  } catch (_) {}
  return null;
}

// ── TRADE MATH ────────────────────────────────────────────────────────────────
function calcLevels(entry) {
  // ATR proxy: 3% stop for sub-$10, 2% for $10-$30, 1.5% for $30+
  const stopPct = entry < 10 ? 0.03 : entry < 30 ? 0.02 : 0.015;
  const stop    = +(entry * (1 - stopPct)).toFixed(2);
  const risk    = entry - stop;
  return {
    stop,
    t1: +(entry + risk * 2.0).toFixed(2),   // 2:1
    t2: +(entry + risk * 3.5).toFixed(2),   // 3.5:1
    t3: +(entry + risk * 5.5).toFixed(2),   // 5.5:1
    risk: +risk.toFixed(2),
  };
}

function avgCost(trade) {
  const base  = trade.entryPrice * trade.shares;
  const extra = trade.adds.reduce((s, a) => s + a.price * a.shares, 0);
  const total = trade.shares + trade.adds.reduce((s, a) => s + a.shares, 0);
  return +(( base + extra ) / total).toFixed(2);
}

function totalShares(trade) {
  return trade.shares + trade.adds.reduce((s, a) => s + a.shares, 0);
}

function totalPnl(trade, exitPrice) {
  const base  = (exitPrice - trade.entryPrice) * trade.shares;
  const extra = trade.adds.reduce((s, a) => s + (exitPrice - a.price) * a.shares, 0);
  return +(base + extra).toFixed(2);
}

// ── TICK HANDLER ──────────────────────────────────────────────────────────────
function onTick(sym, price, vol) {
  // Rolling 1-min volume
  if (!volTracker.has(sym)) volTracker.set(sym, { vol1min: 0, lastReset: Date.now() });
  const vt = volTracker.get(sym);
  if (Date.now() - vt.lastReset > 60000) { vt.vol1min = 0; vt.lastReset = Date.now(); }
  vt.vol1min += vol;

  // ── WATCHES ───────────────────────────────────────────────────────────────
  for (const [chatId, w] of watches) {
    if (w.symbol !== sym || w.entryConfirmed) continue;
    w.currentPrice = price;

    if (price >= w.entryLevel) {
      const avgPerMin = w.avgVolume ? w.avgVolume / 390 : null;
      const volRatio  = avgPerMin ? vt.vol1min / avgPerMin : 99;

      if (volRatio >= 1.5) {
        w.entryConfirmed = true;
        const lv = calcLevels(price);
        w.levels = lv;

        send(chatId,
          `🔥 *ENTRY CONFIRMED — ${sym}*\n\n` +
          `✅ Price: *$${price.toFixed(2)}*\n` +
          `📊 Volume: *${volRatio.toFixed(1)}x* average — REAL BREAKOUT\n\n` +
          `📋 *LEVELS:*\n` +
          `🛑 Stop Loss: *$${lv.stop}*\n` +
          `🎯 Target 1: *$${lv.t1}* (2:1 R:R)\n` +
          `🎯 Target 2: *$${lv.t2}* (3.5:1 R:R)\n` +
          `🎯 Target 3: *$${lv.t3}* (5.5:1 R:R)\n\n` +
          `When you're in text:\n` +
          `_in at ${price.toFixed(2)} with 200 shares_`
        );
      }
    }
  }

  // ── ACTIVE TRADES ─────────────────────────────────────────────────────────
  for (const [chatId, tr] of trades) {
    if (tr.symbol !== sym) continue;
    const prev = tr.currentPrice || tr.entryPrice;
    tr.currentPrice = price;

    const now       = Date.now();
    const minsIn    = (now - tr.entryTime) / 60000;
    const pnl       = totalPnl(tr, price);
    const pnlPct    = (((price - tr.avgCost) / tr.avgCost) * 100).toFixed(2);
    const avgPerMin = tr.avgVolume ? tr.avgVolume / 390 : null;
    const volRatio  = avgPerMin ? vt.vol1min / avgPerMin : 0;

    // Update high water mark & trailing stop
    if (price > tr.hwm) {
      tr.hwm = price;
      if (tr.t1Hit) {
        // Trail at 40% retracement of gains from entry
        const newTrail = +(price - (price - tr.avgCost) * 0.40).toFixed(2);
        if (newTrail > tr.trailingStop) tr.trailingStop = newTrail;
      }
    }

    // ── STOP HIT ────────────────────────────────────────────────────────────
    if (!tr.stopAlerted && price <= tr.stopLoss) {
      tr.stopAlerted = true;
      send(chatId,
        `🚨 *STOP LOSS HIT — ${sym}*\n\n` +
        `Price: *$${price.toFixed(2)}*\n` +
        `Stop was: *$${tr.stopLoss}*\n` +
        `P&L: *-$${Math.abs(pnl).toFixed(2)}* (${pnlPct}%)\n\n` +
        `❌ *EXIT NOW.*\n` +
        `Text: _out at ${price.toFixed(2)}_`
      );
    }

    // ── TRAILING STOP HIT (only after T1) ───────────────────────────────────
    if (tr.t1Hit && !tr.trailAlerted && price <= tr.trailingStop) {
      tr.trailAlerted = true;
      send(chatId,
        `⚠️ *TRAIL STOP HIT — ${sym}*\n\n` +
        `Price dropped to *$${price.toFixed(2)}*\n` +
        `Trail stop: *$${tr.trailingStop}*\n` +
        `Locked profit: *+$${pnl.toFixed(2)}*\n\n` +
        `Protect your gains.\nText: _out at ${price.toFixed(2)}_`
      );
    }

    // ── TARGET 1 ─────────────────────────────────────────────────────────────
    if (!tr.t1Hit && price >= tr.targets.t1) {
      tr.t1Hit       = true;
      tr.stopLoss    = tr.avgCost;   // move stop to breakeven
      tr.stopAlerted = false;
      tr.trailAlerted = false;
      const p = totalPnl(tr, tr.targets.t1);
      send(chatId,
        `🎯 *TARGET 1 HIT — ${sym}*\n\n` +
        `Price: *$${price.toFixed(2)}*\n` +
        `Full position profit: *+$${p.toFixed(2)}*\n\n` +
        `✅ *RECOMMENDED ACTION:*\n` +
        `• Sell 50% here (lock $${(p * 0.5).toFixed(2)})\n` +
        `• Stop moved to BREAKEVEN: *$${tr.avgCost}*\n` +
        `• Trail stop now active on remaining\n\n` +
        `🎯 Next target: *$${tr.targets.t2}*`
      );
    }

    // ── TARGET 2 ─────────────────────────────────────────────────────────────
    if (!tr.t2Hit && price >= tr.targets.t2) {
      tr.t2Hit = true;
      const p = totalPnl(tr, tr.targets.t2);
      send(chatId,
        `🎯🎯 *TARGET 2 HIT — ${sym}*\n\n` +
        `Price: *$${price.toFixed(2)}*\n` +
        `Full position profit: *+$${p.toFixed(2)}*\n\n` +
        `✅ *RECOMMENDED:* Sell remaining shares\n` +
        `🚀 OR hold a moon bag to T3: *$${tr.targets.t3}*\n` +
        `🔄 Trail stop: *$${tr.trailingStop}*`
      );
    }

    // ── 45-MIN OVERSTAY WARNING ───────────────────────────────────────────────
    if (!tr.warn45 && minsIn >= 45) {
      tr.warn45 = true;
      send(chatId,
        `⏱ *45-MIN WARNING — ${sym}*\n\n` +
        `In trade: *${minsIn.toFixed(0)} minutes*\n` +
        `P&L: *${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}* (${pnlPct}%)\n` +
        `Price: *$${price.toFixed(2)}*\n\n` +
        `⚠️ Momentum fades 45-90 min in.\n` +
        `${!tr.t1Hit ? '🎯 T1 not hit yet — re-evaluate thesis.' : '✅ T1 was hit — consider full exit.'}\n\n` +
        `Text _status_ to check levels.\nText _out at [price]_ to close.`
      );
    }

    // ── 90-MIN FINAL WARNING ──────────────────────────────────────────────────
    if (!tr.warn90 && minsIn >= 90) {
      tr.warn90 = true;
      send(chatId,
        `🚨 *90-MIN WARNING — ${sym}*\n\n` +
        `You've been in *${minsIn.toFixed(0)} minutes*\n` +
        `P&L: *${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}*\n\n` +
        `Most day trade momentum is DONE by now.\n` +
        `*Strongly consider exiting.*\n` +
        `Text: _out at ${price.toFixed(2)}_`
      );
    }

    // ── ADD TO POSITION SIGNAL ────────────────────────────────────────────────
    if (!tr.addSent && tr.t1Hit && !tr.t2Hit && !tr.trailAlerted) {
      const pctGain   = ((price - tr.avgCost) / tr.avgCost) * 100;
      const priceHold = price > prev * 0.995; // not dropping fast

      if (pctGain > 4 && volRatio > 2.0 && priceHold) {
        tr.addSent = true;
        const addStop = +(price * 0.985).toFixed(2);
        send(chatId,
          `📈 *ADD SIGNAL — ${sym}*\n\n` +
          `Strong momentum with no reversal signs 🚀\n` +
          `Volume: *${volRatio.toFixed(1)}x* average\n` +
          `Move from entry: *+${pctGain.toFixed(1)}%*\n\n` +
          `✅ *LOW RISK TO ADD*\n` +
          `Tight stop on add: *$${addStop}* (1.5% trail)\n` +
          `Next target: *$${tr.targets.t2}*\n\n` +
          `Text: _added 100 at ${price.toFixed(2)}_`
        );
      }
    }
  }
}

// ── SEND HELPER ───────────────────────────────────────────────────────────────
function send(chatId, text) {
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(e => {
    console.error('Send error:', e.message);
  });
}

// ── MESSAGE PARSER ────────────────────────────────────────────────────────────
function parse(text) {
  const t = text.trim();

  // watch / watching LFVN at 5.10  |  watch LFVN 5.10  |  watching PN for 3.80
  let m = t.match(/^watch(?:ing)?\s+([A-Za-z]{1,5})\s+(?:at|for)?\s*\$?(\d+\.?\d*)/i);
  if (m) return { cmd:'watch', symbol:m[1].toUpperCase(), price:+m[2] };

  // in at 3.85 with 200 shares  |  in 3.85 200
  m = t.match(/^in\b.*?\$?(\d+\.?\d*)\D+(\d+)/i);
  if (m) return { cmd:'in', price:+m[1], shares:+m[2] };

  // out at 6.20  |  out 6.20
  m = t.match(/^out\b.*?\$?(\d+\.?\d*)/i);
  if (m) return { cmd:'out', price:+m[1] };

  // added 100 at 5.50  |  added 100 shares at 5.50
  m = t.match(/^add(?:ed)?\s+(\d+)[^$\d]*\$?(\d+\.?\d*)/i);
  if (m) return { cmd:'add', shares:+m[1], price:+m[2] };

  // sl 4.88  |  stop loss 4.88  |  stop 4.88
  m = t.match(/^(?:sl|stop(?:\s*loss)?)\s+\$?(\d+\.?\d*)/i);
  if (m) return { cmd:'sl', price:+m[1] };

  // just a ticker
  m = t.match(/^([A-Z]{1,5})$/);
  if (m) return { cmd:'quote', symbol:m[1] };

  if (/^(status|p&l|pnl|where|how am i)/i.test(t)) return { cmd:'status' };
  if (/^(cancel|clear|reset|stop watching)/i.test(t)) return { cmd:'cancel' };
  if (/^help$/i.test(t)) return { cmd:'help' };

  return null;
}

// ── COMMAND HANDLERS ──────────────────────────────────────────────────────────
async function cmdWatch(chatId, symbol, entryLevel) {
  // Clear any existing watch for this chat
  const old = watches.get(chatId);
  if (old) removeSub(old.symbol, chatId);
  watches.delete(chatId);

  send(chatId, `🔍 Scanning *${symbol}*...`);

  const [quote, avgVol] = await Promise.all([getQuote(symbol), getAvgVolume(symbol)]);

  if (!quote || !quote.c || quote.c === 0) {
    send(chatId, `❌ Can't find *${symbol}*. Check the ticker and try again.`);
    return;
  }

  const lv   = calcLevels(entryLevel);
  const curr = quote.c;
  const dist = (((entryLevel - curr) / curr) * 100).toFixed(2);
  const distLabel = entryLevel > curr
    ? `${dist}% above current — waiting`
    : `✅ Already at/above level`;

  watches.set(chatId, {
    symbol, entryLevel, currentPrice: curr,
    avgVolume: avgVol, entryConfirmed: false, levels: lv,
  });

  addSub(symbol, chatId);

  send(chatId,
    `👁 *WATCHING ${symbol}*\n\n` +
    `Entry trigger: *$${entryLevel}*\n` +
    `Current price: *$${curr}*  (${distLabel})\n` +
    `30-day avg vol: ${avgVol ? (avgVol / 1e6).toFixed(2) + 'M' : 'n/a'}\n\n` +
    `📋 *PRE-CALC LEVELS:*\n` +
    `🛑 Stop Loss: *$${lv.stop}*  (risk $${lv.risk}/share)\n` +
    `🎯 Target 1: *$${lv.t1}*  (2:1)\n` +
    `🎯 Target 2: *$${lv.t2}*  (3.5:1)\n` +
    `🎯 Target 3: *$${lv.t3}*  (5.5:1)\n\n` +
    `🔴 *LIVE monitoring via Finnhub real-time feed*\n` +
    `I'll alert you the moment $${entryLevel} breaks WITH volume confirmation.`
  );
}

async function cmdIn(chatId, entryPrice, shares) {
  const watch  = watches.get(chatId);
  const symbol = watch?.symbol;

  if (!symbol) {
    send(chatId, `❌ Tell me what you're watching first:\n_watching LFVN at 5.10_`);
    return;
  }

  const avgVol = watch.avgVolume;
  const lv     = calcLevels(entryPrice);

  const trade = {
    symbol, entryPrice, shares,
    entryTime: Date.now(),
    currentPrice: entryPrice,
    hwm: entryPrice,
    avgCost: entryPrice,
    stopLoss: lv.stop,
    trailingStop: lv.stop,
    targets: { t1: lv.t1, t2: lv.t2, t3: lv.t3 },
    avgVolume: avgVol,
    adds: [],
    t1Hit: false, t2Hit: false,
    stopAlerted: false, trailAlerted: false,
    warn45: false, warn90: false, addSent: false,
  };

  trades.set(chatId, trade);
  watches.delete(chatId);
  // Keep subscription alive
  addSub(symbol, chatId);

  const cost    = (entryPrice * shares).toFixed(2);
  const riskAmt = (lv.risk * shares).toFixed(2);
  const t1p     = ((lv.t1 - entryPrice) * shares).toFixed(2);
  const t2p     = ((lv.t2 - entryPrice) * shares).toFixed(2);

  send(chatId,
    `✅ *IN THE TRADE — ${symbol}*\n\n` +
    `Entry: *$${entryPrice}* × *${shares} shares*\n` +
    `Cost basis: *$${cost}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🛑 *STOP LOSS: $${lv.stop}*\n` +
    `   Max risk: *-$${riskAmt}*\n\n` +
    `🎯 *TARGET 1: $${lv.t1}*\n` +
    `   Profit: *+$${t1p}*  → sell 50%\n\n` +
    `🎯 *TARGET 2: $${lv.t2}*\n` +
    `   Profit: *+$${t2p}*  → sell remainder\n\n` +
    `🎯 *TARGET 3: $${lv.t3}*  🚀 moon bag\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🔴 *LIVE MONITORING ACTIVE*\n` +
    `Alerts: stop hit · targets · 45-min · trail stop · add signals\n\n` +
    `Text _out at [price]_ when you exit.\nText _status_ anytime for update.`
  );
}

function cmdOut(chatId, exitPrice) {
  const trade = trades.get(chatId);
  if (!trade) {
    send(chatId, `No active trade. Start with: _watching [TICKER] at [price]_`);
    return;
  }

  const pnl      = totalPnl(trade, exitPrice);
  const ts       = totalShares(trade);
  const minsIn   = ((Date.now() - trade.entryTime) / 60000).toFixed(0);
  const pnlPct   = (((exitPrice - trade.avgCost) / trade.avgCost) * 100).toFixed(2);
  const isWin    = pnl > 0;

  removeSub(trade.symbol, chatId);
  trades.delete(chatId);

  send(chatId,
    `${isWin ? '💰' : '📉'} *TRADE CLOSED — ${trade.symbol}*\n\n` +
    `Entry: *$${trade.entryPrice}*  →  Exit: *$${exitPrice}*\n` +
    `Avg cost: *$${trade.avgCost}*  |  Shares: *${ts}*\n` +
    `Time in: *${minsIn} min*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${isWin ? '✅' : '❌'} *P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}*\n` +
    `Return: *${pnlPct}%*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${isWin
      ? '🔥 Clean execution, Maverick. Bank it.'
      : '💪 Stop respected. Capital preserved. Next setup.'}\n\n` +
    `Ready. Text: _watching [TICKER] at [price]_`
  );
}

function cmdAdd(chatId, shares, price) {
  const trade = trades.get(chatId);
  if (!trade) { send(chatId, `No active trade to add to.`); return; }

  trade.adds.push({ shares, price });
  trade.avgCost = avgCost(trade);
  const ts = totalShares(trade);

  send(chatId,
    `📈 *POSITION UPDATED — ${trade.symbol}*\n\n` +
    `Added: *${shares} shares @ $${price}*\n` +
    `Total shares: *${ts}*\n` +
    `New avg cost: *$${trade.avgCost}*\n` +
    `New stop loss: *$${trade.stopLoss}*\n\n` +
    `Monitoring continues. Text _status_ anytime.`
  );
}

function cmdSl(chatId, newStop) {
  const trade = trades.get(chatId);
  const watch = watches.get(chatId);
  if (trade) {
    trade.stopLoss = newStop;
    trade.stopAlerted = false;
    send(chatId, `✅ Stop loss updated → *$${newStop}* for *${trade.symbol}*`);
  } else if (watch) {
    watch.levels.stop = newStop;
    send(chatId, `✅ Stop loss set → *$${newStop}* for *${watch.symbol}*`);
  } else {
    send(chatId, `No active trade. Start with: _watching [TICKER] at [price]_`);
  }
}

async function cmdQuote(chatId, symbol) {
  const q = await getQuote(symbol);
  if (!q || !q.c) { send(chatId, `❌ Can't fetch *${symbol}*. Check ticker.`); return; }
  const chg = q.dp >= 0 ? `+${q.dp?.toFixed(2)}%` : `${q.dp?.toFixed(2)}%`;
  send(chatId,
    `📊 *${symbol}*\n` +
    `Price: *$${q.c}*  (${chg})\n` +
    `O: $${q.o}  H: $${q.h}  L: $${q.l}\n` +
    `Prev close: $${q.pc}\n\n` +
    `To watch: _watching ${symbol} at ${q.c}_`
  );
}

function cmdStatus(chatId) {
  const trade = trades.get(chatId);
  const watch = watches.get(chatId);

  if (trade) {
    const price  = trade.currentPrice || trade.entryPrice;
    const pnl    = totalPnl(trade, price);
    const pnlPct = (((price - trade.avgCost) / trade.avgCost) * 100).toFixed(2);
    const minsIn = ((Date.now() - trade.entryTime) / 60000).toFixed(0);
    const ts     = totalShares(trade);

    send(chatId,
      `📊 *LIVE STATUS — ${trade.symbol}*\n\n` +
      `Entry: $${trade.entryPrice}  |  Now: *$${price.toFixed(2)}*\n` +
      `Avg cost: $${trade.avgCost}  |  Shares: ${ts}\n` +
      `P&L: *${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}* (${pnlPct}%)\n` +
      `Time in trade: *${minsIn} min*\n\n` +
      `🛑 Hard stop: *$${trade.stopLoss}*\n` +
      `🔄 Trail stop: *$${trade.trailingStop}*\n` +
      `🎯 T1: $${trade.targets.t1} ${trade.t1Hit ? '✅' : '⏳'}\n` +
      `🎯 T2: $${trade.targets.t2} ${trade.t2Hit ? '✅' : '⏳'}\n` +
      `🎯 T3: $${trade.targets.t3}\n\n` +
      `Text _out at [price]_ to close.`
    );
  } else if (watch) {
    const price = watch.currentPrice;
    send(chatId,
      `👁 *WATCHING ${watch.symbol}*\n\n` +
      `Entry trigger: *$${watch.entryLevel}*\n` +
      `Current price: *$${price?.toFixed(2) || '...'}*\n` +
      `Status: ${watch.entryConfirmed ? '✅ CONFIRMED' : '⏳ Waiting for breakout + volume'}`
    );
  } else {
    send(chatId, `No active watch or trade.\nStart with: _watching [TICKER] at [price]_`);
  }
}

function cmdCancel(chatId) {
  const watch = watches.get(chatId);
  const trade = trades.get(chatId);
  const sym   = watch?.symbol || trade?.symbol;
  if (sym) removeSub(sym, chatId);
  watches.delete(chatId);
  trades.delete(chatId);
  send(chatId, `✅ Cleared all. Ready for next trade.\n\nText: _watching [TICKER] at [price]_`);
}

function cmdHelp(chatId) {
  send(chatId,
    `🤖 *MAVERICK TRADE BOT*\n\n` +
    `*HOW TO USE:*\n\n` +
    `👁 *Start a watch:*\n` +
    `_watching LFVN at 5.10_\n\n` +
    `✅ *Log your entry:*\n` +
    `_in at 5.11 with 200 shares_\n\n` +
    `📈 *Add to position:*\n` +
    `_added 100 at 5.50_\n\n` +
    `🛑 *Override stop loss:*\n` +
    `_sl 4.88_\n\n` +
    `💰 *Close trade:*\n` +
    `_out at 6.20_\n\n` +
    `📊 *Check status:*\n` +
    `_status_\n\n` +
    `🔍 *Quick quote:*\n` +
    `_LFVN_\n\n` +
    `❌ *Cancel/reset:*\n` +
    `_cancel_\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `I monitor live 24/7.\n` +
    `I alert on: entry confirm, stop hit,\n` +
    `targets, 45-min warning, trail stop,\n` +
    `add opportunities, and exit P&L.`
  );
}

// ── MAIN MESSAGE ROUTER ───────────────────────────────────────────────────────
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  if (!text) return;

  // Log user identity on first contact
  console.log(`MSG [${chatId}] ${msg.from?.first_name || 'User'}: ${text}`);

  const p = parse(text);
  if (!p) {
    // Friendly fallback
    send(chatId, `Text _help_ to see all commands.\nOr start with: _watching [TICKER] at [price]_`);
    return;
  }

  switch (p.cmd) {
    case 'watch':  return cmdWatch(chatId, p.symbol, p.price);
    case 'in':     return cmdIn(chatId, p.price, p.shares);
    case 'out':    return cmdOut(chatId, p.price);
    case 'add':    return cmdAdd(chatId, p.shares, p.price);
    case 'sl':     return cmdSl(chatId, p.price);
    case 'quote':  return cmdQuote(chatId, p.symbol);
    case 'status': return cmdStatus(chatId);
    case 'cancel': return cmdCancel(chatId);
    case 'help':   return cmdHelp(chatId);
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));

// ── START ─────────────────────────────────────────────────────────────────────
connectFinnhub();

// Keep-alive HTTP server (UptimeRobot pings this)
http.createServer((_, res) => res.end('Maverick Bot alive')).listen(3000, () => {
  console.log('🤖 Maverick Trade Bot running on port 3000');
});
