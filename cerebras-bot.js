/**
 * MAVERICK INTEL BOT v2.0
 * Trading intelligence + general AI assistant
 * Fixed: poll loop uses finally block so it NEVER dies
 */

require('dotenv').config();
const fetch = require('node-fetch');

// ── CONFIG ────────────────────────────────────────────────────────
const TG_TOKEN = process.env.INTEL_BOT_TOKEN  || process.env.TELEGRAM_TOKEN   || '';
const CHAT_ID  = process.env.INTEL_BOT_CHAT   || process.env.TELEGRAM_CHAT_ID || '';
const FINNHUB  = process.env.FINNHUB_KEY       || '';
const GROQ_KEY = process.env.GROQ_KEY          || process.env.GROQ_KEY_2       || '';
const CBRS_KEY = process.env.CEREBRAS_KEY      || '';

// ── STATE ─────────────────────────────────────────────────────────
const positions    = {};
const watchlist    = {};
const priceAlerts  = [];
const chatHistory  = {};
let lastUpdateId   = 0;
let lastNewsTs     = Math.floor(Date.now() / 1000) - 3600;
const sentHeadlines = new Set();

const BASE_SCAN = ['MARA','RIOT','SOFI','HOOD','SNDL','FFIE','MULN','ATER','BBIG','PROG','GFAI','GMBL','BFRI','NKLA'];

// ── HELPERS ───────────────────────────────────────────────────────
const rnd = (n, d = 2) => +Number(n).toFixed(d);

async function fh(ep) {
  try {
    const sep  = ep.includes('?') ? '&' : '?';
    const r    = await fetch('https://finnhub.io/api/v1' + ep + sep + 'token=' + FINNHUB);
    const text = await r.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text);
  } catch (e) {
    console.error('[Finnhub]', ep.split('?')[0], e.message);
    return null;
  }
}

async function tg(text, chatId) {
  chatId = chatId || CHAT_ID;
  if (!TG_TOKEN || !chatId) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('[TG]', e.message); }
}

// ── AI BRAIN ─────────────────────────────────────────────────────
async function ai(system, user, maxTokens, chatId) {
  maxTokens = maxTokens || 500;
  const history = (chatId && chatHistory[chatId]) ? chatHistory[chatId].slice(-6) : [];
  const messages = [{ role: 'system', content: system }].concat(history).concat([{ role: 'user', content: user }]);

  if (GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, temperature: 0.35, messages: messages })
      });
      const d    = await r.json();
      const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
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

  if (CBRS_KEY) {
    try {
      const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CBRS_KEY },
        body: JSON.stringify({ model: 'llama3.1-8b', max_tokens: maxTokens, temperature: 0.35, messages: messages })
      });
      const d    = await r.json();
      const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (text) return text;
    } catch (e) { console.error('[Cerebras]', e.message); }
  }
  return null;
}

// ── STOCK DATA ────────────────────────────────────────────────────
async function getStock(sym) {
  try {
    const results = await Promise.all([
      fh('/quote?symbol=' + sym),
      fh('/stock/metric?symbol=' + sym + '&metric=all'),
      fh('/stock/profile2?symbol=' + sym)
    ]);
    const quote   = results[0];
    const metrics = results[1];
    const profile = results[2];
    if (!quote || !quote.c || quote.c === 0) return null;
    const m      = (metrics && metrics.metric) ? metrics.metric : {};
    const avgVol = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume'] * 1e6 : 500000;
    const relVol = rnd((quote.v || avgVol) / Math.max(avgVol, 1), 2);
    return {
      sym:        sym,
      price:      quote.c,
      changePct:  quote.dp || 0,
      high:       quote.h,
      low:        quote.l,
      prevClose:  quote.pc,
      volume:     quote.v || 0,
      relVol:     relVol,
      floatM:     m.sharesFloat                 || 50,
      shortPct:   m.shortInterestPercentOfFloat || 0,
      week52High: m['52WeekHigh']               || quote.c * 1.5,
      week52Low:  m['52WeekLow']                || quote.c * 0.5,
      sector:     (profile && profile.finnhubIndustry) ? profile.finnhubIndustry : 'Unknown',
      atr:        rnd(quote.c * 0.025, 4)
    };
  } catch (e) { return null; }
}

// ── SETUP SCORER ─────────────────────────────────────────────────
function scoreSetup(d) {
  var score = 0;
  var flags = [];

  if      (d.floatM < 1)  { score += 25; flags.push('NANO FLOAT'); }
  else if (d.floatM < 5)  { score += 20; flags.push('TIGHT FLOAT'); }
  else if (d.floatM < 15) { score += 12; flags.push('WORKABLE FLOAT'); }

  if      (d.relVol >= 10) { score += 25; flags.push('RVOL ' + d.relVol + 'x HIGH'); }
  else if (d.relVol >= 5)  { score += 20; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol >= 3)  { score += 12; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol >= 2)  { score +=  6; flags.push('RVOL ' + d.relVol + 'x'); }
  else if (d.relVol < 0.8) score -= 5;

  if      (d.changePct >= 20) { score += 20; flags.push('+' + rnd(d.changePct,1) + '% MOVER'); }
  else if (d.changePct >= 10) { score += 15; flags.push('+' + rnd(d.changePct,1) + '%'); }
  else if (d.changePct >= 5)  { score +=  8; }
  else if (d.changePct <  0)  { score -=  5; }

  if      (d.price < 1) { score += 10; flags.push('SUB-$1'); }
  else if (d.price < 3) score += 8;
  else if (d.price < 5) score += 5;

  if (d.shortPct > 30 && d.relVol > 3) { score += 15; flags.push('SQUEEZE SETUP'); }
  else if (d.shortPct > 20)             { score +=  8; flags.push('SHORT ' + rnd(d.shortPct,1) + '%'); }

  var pctFrom52H = (d.week52High - d.price) / d.week52High * 100;
  if (pctFrom52H < 3 && d.changePct > 0) { score += 10; flags.push('52W BREAKOUT'); }

  return { score: Math.min(100, score), flags: flags };
}

// ── COMMANDS ──────────────────────────────────────────────────────

async function cmdStart(chatId) {
  await tg(
    '<b>MAVERICK INTEL BOT v2.0</b>\n\n' +
    '<b>STOCK COMMANDS</b>\n' +
    '/check TICKER - Full AI analysis\n' +
    '/scan - Find breakout setups\n' +
    '/squeeze - High conviction squeeze scan\n' +
    '/news - Top market catalysts\n\n' +
    '<b>TRADE TRACKING</b>\n' +
    '/position TICKER ENTRY STOP TP1 TP2 SHARES\n' +
    '/positions - View open trades\n' +
    '/close TICKER - Close a trade\n' +
    '/watch TICKER - Add to scan universe\n' +
    '/alert TICKER PRICE above|below\n\n' +
    '<b>AI ASSISTANT</b>\n' +
    'Type anything - trading or not. I remember our conversation.',
    chatId
  );
}

async function cmdCheck(sym, chatId) {
  await tg('Running Lion Analysis on $' + sym + '...', chatId);
  var d = await getStock(sym);
  if (!d) return tg('No data for $' + sym + '. Check the ticker.', chatId);

  var result = scoreSetup(d);
  var score  = result.score;
  var flags  = result.flags;
  var atr    = d.atr;
  var changeStr = (d.changePct >= 0 ? '+' : '') + rnd(d.changePct, 2) + '%';

  var analysis = await ai(
    'You are MAVERICK LION BRAIN - an elite micro-cap trading analyst. ' +
    'Apply the Maverick Whale Doctrine: enter Phase 1-2 accumulation, exit before Phase 4 distribution. ' +
    'Key rules: float under 15M preferred, RVOL above 2x is whale signal, positive price action required. ' +
    'Give a clear verdict: BUY / WATCH / PASS. ' +
    'Include: specific entry zone, hard stop price, TP1 and TP2 targets, risk/reward, and 1-sentence whale phase assessment. ' +
    'Write like you are talking to a 6th grader. Direct. No fluff. Max 220 words.',
    'Analyze $' + sym + ':\n' +
    'Price: $' + d.price + ' (' + changeStr + ')\n' +
    'RVOL: ' + d.relVol + 'x | Float: ' + d.floatM + 'M | Short: ' + d.shortPct + '%\n' +
    'ATR: $' + atr + ' | Setup Score: ' + score + '/100\n' +
    'Flags: ' + (flags.join(', ') || 'none') + '\n' +
    '52W Range: $' + d.week52Low + ' - $' + d.week52High + '\n' +
    'Sector: ' + d.sector,
    350, chatId
  );

  var bar = score >= 85 ? 'HIGH CONVICTION' : score >= 70 ? 'ELEVATED' : score >= 55 ? 'MODERATE' : 'LOW';

  await tg(
    '<b>$' + sym + ' - LION BRAIN ANALYSIS</b> [' + bar + ']\n\n' +
    '$' + d.price + ' (' + changeStr + ')\n' +
    'RVOL: <b>' + d.relVol + 'x</b>  Float: <b>' + d.floatM + 'M</b>\n' +
    'Short: ' + rnd(d.shortPct,1) + '%  Score: <b>' + score + '/100</b>\n' +
    (flags.length ? flags.join(' | ') + '\n' : '') +
    '\n' +
    (analysis || 'AI offline - showing computed levels only.') +
    '\n\n' +
    '<b>Quick Levels:</b>\n' +
    'Stop: $' + rnd(d.price - atr * 1.5, 4) + '\n' +
    'TP1:  $' + rnd(d.price + atr * 2,   4) + '\n' +
    'TP2:  $' + rnd(d.price + atr * 3.5, 4),
    chatId
  );
}

async function cmdScan(chatId) {
  await tg('Scanning for setups...', chatId);
  var universe = Object.keys(watchlist).concat(BASE_SCAN).filter(function(v,i,a){ return a.indexOf(v)===i; }).slice(0,20);
  var settled  = await Promise.allSettled(universe.map(function(s){ return getStock(s); }));
  var results  = [];

  for (var i = 0; i < settled.length; i++) {
    var r = settled[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    var sr = scoreSetup(r.value);
    if (sr.score >= 55) results.push(Object.assign({}, r.value, { score: sr.score, flags: sr.flags }));
  }
  results.sort(function(a,b){ return b.score - a.score; });

  if (!results.length) return tg('No high-conviction setups right now. Markets may be quiet.', chatId);

  var msg = '<b>MAVERICK SCAN - TOP SETUPS</b>\n\n';
  for (var j = 0; j < Math.min(6, results.length); j++) {
    var d   = results[j];
    var lbl = d.score >= 85 ? 'HOT' : d.score >= 70 ? 'WARM' : 'WATCH';
    msg += '[' + lbl + '] <b>$' + d.sym + '</b> - ' + d.score + '/100\n';
    msg += '$' + d.price + '  ' + (d.changePct >= 0 ? '+' : '') + rnd(d.changePct,1) + '%  RVOL ' + d.relVol + 'x\n';
    msg += (d.flags.slice(0,3).join(' | ') || '') + '\n';
    msg += 'Stop $' + rnd(d.price - d.atr*1.5,4) + '  TP $' + rnd(d.price + d.atr*2,4) + '\n\n';
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
    var sqSc = Math.min(100, Math.round(d.shortPct * 1.5 + d.relVol * 5 + (d.floatM < 10 ? 15 : 0)));
    if (sqSc >= 35 || d.shortPct >= 15) results.push(Object.assign({}, d, { sqSc: sqSc }));
  }
  results.sort(function(a,b){ return b.sqSc - a.sqSc; });

  if (!results.length) return tg('No notable squeeze setups detected.', chatId);

  var msg = '<b>SQUEEZE SCAN</b>\n\n';
  for (var j = 0; j < Math.min(5, results.length); j++) {
    var d     = results[j];
    var phase = (d.shortPct > 30 && d.relVol > 2) ? 'PHASE 2' : d.shortPct > 15 ? 'PHASE 1' : 'WATCH';
    msg += '[' + phase + '] <b>$' + d.sym + '</b> - Squeeze Score: ' + d.sqSc + '/100\n';
    msg += 'Short: ' + rnd(d.shortPct,1) + '%  RVOL: ' + d.relVol + 'x  Float: ' + d.floatM + 'M\n';
    msg += 'Trigger: $' + rnd(d.price*1.02,4) + '  Stop: $' + rnd(d.price*0.95,4) + '\n\n';
  }
  msg += 'Phase 2 = shorts actively covering + retail piling in.';
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
    return tg('Usage: /position TICKER ENTRY STOP TP1 TP2 SHARES\nExample: /position MDAI 1.50 1.38 1.80 2.10 500', chatId);
  }
  var ticker = sym.toUpperCase();
  var rr     = rnd((+tp1 - +entry) / (+entry - +stop), 2);
  positions[ticker] = {
    entry:  +entry,
    stop:   +stop,
    tp1:    +tp1,
    tp2:    tp2 ? +tp2 : null,
    shares: shares ? +shares : 100,
    entryTime: Date.now(),
    alerts: { stopWarn: false, tp1: false, tp2: false, overextended: false }
  };
  await tg(
    '<b>$' + ticker + ' TRACKED</b>\n\n' +
    'Entry:  $' + entry + '\n' +
    'Stop:   $' + stop + ' (' + rnd((+stop - +entry) / +entry * 100, 1) + '%)\n' +
    'TP1:    $' + tp1 + ' (+' + rnd((+tp1 - +entry) / +entry * 100, 1) + '%)\n' +
    'TP2:    ' + (tp2 ? '$' + tp2 : 'not set') + '\n' +
    'Shares: ' + (shares || 100) + '\n' +
    'R:R:    ' + rr + ':1\n\n' +
    'I will alert you when price approaches stop or hits targets.',
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
    var pl       = rnd((d.price - pos.entry) / pos.entry * 100, 2);
    var plDollar = rnd((d.price - pos.entry) * pos.shares, 2);
    var stopDist = rnd((d.price - pos.stop) / d.price * 100, 1);
    var tp1Dist  = pos.tp1 ? rnd((pos.tp1 - d.price) / d.price * 100, 1) : null;
    msg += (pl >= 0 ? 'UP' : 'DOWN') + ' <b>$' + sym + '</b>\n';
    msg += 'Entry $' + pos.entry + ' -> Now $' + d.price + '\n';
    msg += 'P&L: ' + (pl >= 0 ? '+' : '') + pl + '% ($' + (plDollar >= 0 ? '+' : '') + plDollar + ')\n';
    msg += 'Stop: $' + pos.stop + ' (' + stopDist + '% away)' + (stopDist < 3 ? ' WARNING' : '') + '\n';
    msg += 'TP1: ' + (pos.tp1 ? '$' + pos.tp1 + ' (' + tp1Dist + '% away)' : 'not set') + '\n';
    msg += 'RVOL: ' + d.relVol + 'x\n\n';
  }
  await tg(msg, chatId);
}

async function cmdClose(sym, chatId) {
  var ticker = sym.toUpperCase();
  if (!positions[ticker]) return tg('No tracked position for $' + ticker, chatId);
  var pos = positions[ticker];
  delete positions[ticker];
  var d = await getStock(ticker).catch(function(){ return null; });
  if (d) {
    var pl       = rnd((d.price - pos.entry) / pos.entry * 100, 2);
    var plDollar = rnd((d.price - pos.entry) * pos.shares, 2);
    await tg(
      '<b>$' + ticker + ' CLOSED</b>\n' +
      'Entry: $' + pos.entry + ' | Exit: $' + d.price + '\n' +
      'P&L: ' + (pl >= 0 ? '+' : '') + pl + '% ($' + (plDollar >= 0 ? '+' : '') + plDollar + ')\n' +
      'Shares: ' + pos.shares,
      chatId
    );
  } else {
    await tg('$' + ticker + ' position removed.', chatId);
  }
}

async function cmdWatch(sym, chatId) {
  var ticker = sym.toUpperCase();
  watchlist[ticker] = { added: Date.now() };
  await tg('$' + ticker + ' added to scan universe. It will appear in /scan and /squeeze results.', chatId);
}

async function cmdAlert(parts, chatId) {
  var sym       = parts[1];
  var price     = parts[2];
  var direction = parts[3];
  if (!sym || !price) {
    return tg('Usage: /alert TICKER PRICE above|below\nExample: /alert MDAI 2.00 above', chatId);
  }
  priceAlerts.push({ ticker: sym.toUpperCase(), price: +price, direction: direction || 'above', chatId: chatId, fired: false });
  await tg('Alert set: $' + sym.toUpperCase() + ' ' + (direction || 'above') + ' $' + price, chatId);
}

async function cmdNews(chatId) {
  await tg('Pulling top catalysts...', chatId);
  var news = await fh('/news?category=general').catch(function(){ return null; });
  if (!Array.isArray(news)) return tg('News unavailable right now.', chatId);
  var msg = '<b>TOP CATALYSTS</b>\n\n';
  var items = news.filter(function(n){ return n.headline; }).slice(0,8);
  for (var i = 0; i < items.length; i++) {
    var n       = items[i];
    var ageMin  = Math.round((Date.now()/1000 - n.datetime) / 60);
    var age     = ageMin < 60 ? (ageMin + 'm') : (Math.round(ageMin/60) + 'h');
    var related = (n.related || '').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase() || '-';
    msg += (i+1) + '. <b>' + related + '</b> - ' + age + ' ago\n' + n.headline + '\n\n';
  }
  await tg(msg, chatId);
}

async function cmdAI(text, chatId) {
  var reply = await ai(
    'You are the Maverick Trading Bot - an elite trading assistant AND brilliant general AI. ' +
    'For trading: apply Maverick Whale Doctrine (Phase 1-2 entry, tight float, whale volume, hard stops). ' +
    'For anything else: answer like a knowledgeable, direct friend. No disclaimers, no fluff. ' +
    'You have memory of this conversation. Keep responses under 280 words.',
    text, 500, chatId
  );
  if (reply) await tg(reply, chatId);
  else await tg('AI brain offline. Try /check TICKER for stock analysis.', chatId);
}

// ── BACKGROUND MONITORS ───────────────────────────────────────────

async function monitorPositions() {
  for (var sym in positions) {
    var pos = positions[sym];
    var d   = await getStock(sym).catch(function(){ return null; });
    if (!d) continue;
    var price    = d.price;
    var pct      = (price - pos.entry) / pos.entry * 100;
    var stopDist = (price - pos.stop) / pos.stop * 100;

    if (stopDist < 3 && !pos.alerts.stopWarn) {
      pos.alerts.stopWarn = true;
      await tg(
        'WARNING: <b>$' + sym + ' STOP APPROACHING</b>\n' +
        'Price $' + price + ' is only ' + rnd(stopDist,1) + '% from stop at $' + pos.stop + '\n' +
        'RVOL: ' + d.relVol + 'x\n' +
        'If thesis is broken - exit. Do not let a small loss become a big one.'
      );
    } else if (stopDist >= 6) {
      pos.alerts.stopWarn = false;
    }

    if (price <= pos.stop) {
      await tg(
        'STOP HIT: <b>$' + sym + '</b>\n' +
        'Price: $' + price + ' | Stop: $' + pos.stop + '\n' +
        'P&L: ' + rnd(pct,1) + '%\n' +
        'Exit NOW. Protect the account.'
      );
    }

    if (pos.tp1 && price >= pos.tp1 && !pos.alerts.tp1) {
      pos.alerts.tp1 = true;
      await tg(
        'TP1 HIT: <b>$' + sym + ' - $' + pos.tp1 + '</b>\n' +
        'Price: $' + price + ' (+' + rnd(pct,1) + '%)\n' +
        'Maverick rule: Sell 50% here. Move stop to breakeven. Let runner work.\n' +
        'TP2: ' + (pos.tp2 ? '$' + pos.tp2 : 'not set')
      );
    }

    if (pos.tp2 && price >= pos.tp2 && !pos.alerts.tp2) {
      pos.alerts.tp2 = true;
      await tg(
        'TP2 HIT: <b>$' + sym + ' - $' + pos.tp2 + '</b>\n' +
        'Price: $' + price + ' (+' + rnd(pct,1) + '%)\n' +
        'Sell another 30%. Trail the remaining 20% aggressively.'
      );
    }

    if (pct > 25 && !pos.alerts.tp1 && !pos.alerts.overextended) {
      pos.alerts.overextended = true;
      await tg(
        'OVEREXTENDED: <b>$' + sym + '</b>\n' +
        '+' + rnd(pct,1) + '% from entry $' + pos.entry + '\n' +
        'RVOL: ' + d.relVol + 'x ' + (d.relVol < 1.5 ? '- Volume fading, distribution risk' : '') + '\n' +
        'Whale Doctrine: Consider scaling out before crowd turns to seller.'
      );
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
        'PRICE ALERT: <b>$' + alert.ticker + '</b>\n' +
        'Price $' + d.price + ' is ' + alert.direction + ' $' + alert.price + '\n' +
        'Change: ' + (d.changePct >= 0 ? '+' : '') + rnd(d.changePct,2) + '%  RVOL: ' + d.relVol + 'x\n' +
        'Use /check ' + alert.ticker + ' for full analysis.',
        alert.chatId || CHAT_ID
      );
    }
  }
}

async function scanNewsIntel() {
  try {
    var news = await fh('/news?category=general');
    if (!Array.isArray(news)) return;
    var TIER1 = ['fda approval','fda approved','merger','acquisition','buyout','earnings beat',
                 'short squeeze','trading halted','halt','ipo','barda','government contract',
                 'phase 3','reverse split','buyback','uplisting','nasdaq compliance'];
    var NEG   = ['going concern','dilut','offering','atm shelf','bankruptcy','delisting',
                 'class action','default'];
    var fresh = news.filter(function(n){ return n.datetime > lastNewsTs && n.headline; });
    if (fresh.length) lastNewsTs = Math.max.apply(null, fresh.map(function(n){ return n.datetime; }));
    for (var i = 0; i < fresh.length; i++) {
      var n    = fresh[i];
      if (sentHeadlines.has(n.headline)) continue;
      var text = (n.headline + ' ' + (n.summary || '')).toLowerCase();
      var hits = TIER1.filter(function(k){ return text.indexOf(k) !== -1; });
      var negs = NEG.filter(function(k){ return text.indexOf(k) !== -1; });
      if (hits.length > 0 && negs.length === 0) {
        sentHeadlines.add(n.headline);
        var ageMin  = Math.round((Date.now()/1000 - n.datetime) / 60);
        var related = (n.related || '').split(',')[0].replace(/[^A-Z]/gi,'').trim().toUpperCase() || '-';
        await tg(
          'HIGH CONVICTION CATALYST\n' +
          n.headline + '\n' +
          n.source + ' - ' + ageMin + 'm ago\n' +
          related + ' | ' + hits.slice(0,3).join(', ') + '\n\n' +
          '/check ' + related
        );
        await new Promise(function(r){ setTimeout(r, 2000); });
      }
    }
  } catch (e) { console.error('[NEWS SCAN]', e.message); }
}

// ── TELEGRAM POLL LOOP ────────────────────────────────────────────
async function poll() {
  try {
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, 30000);
    var r;
    try {
      r = await fetch(
        'https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=25',
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timer);
    }

    var d = await r.json();

    // Empty result is normal - loop continues via finally block below
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
        if      (cmd === '/start' || cmd === '/help') await cmdStart(chatId);
        else if (cmd === '/check'    && parts[1])     await cmdCheck(parts[1].toUpperCase(), chatId);
        else if (cmd === '/scan')                     await cmdScan(chatId);
        else if (cmd === '/squeeze')                  await cmdSqueeze(chatId);
        else if (cmd === '/position')                 await cmdPosition(parts, chatId);
        else if (cmd === '/positions')                await cmdPositions(chatId);
        else if (cmd === '/close'    && parts[1])     await cmdClose(parts[1], chatId);
        else if (cmd === '/watch'    && parts[1])     await cmdWatch(parts[1], chatId);
        else if (cmd === '/alert')                    await cmdAlert(parts, chatId);
        else if (cmd === '/news')                     await cmdNews(chatId);
        else if (text.charAt(0) !== '/')              await cmdAI(text, chatId);
        else await tg('Unknown command. Type /help for the menu.', chatId);
      } catch (e) {
        console.error('[CMD]', cmd, e.message);
        await tg('Error: ' + e.message, chatId);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.error('[POLL]', e.message);
  } finally {
    // CRITICAL: this ALWAYS runs - loop never dies
    setTimeout(poll, 500);
  }
}

// ── STARTUP ───────────────────────────────────────────────────────
async function start() {
  console.log('\n[MAVERICK INTEL BOT v2.0] Initializing...');
  console.log('  Groq (primary):    ' + (GROQ_KEY ? 'connected' : 'MISSING'));
  console.log('  Cerebras (backup): ' + (CBRS_KEY ? 'connected' : 'not set'));
  console.log('  Finnhub:           ' + (FINNHUB  ? 'connected' : 'MISSING'));
  console.log('  Telegram:          ' + (TG_TOKEN ? 'connected' : 'MISSING'));
  console.log('  Intel Bot:         ' + (TG_TOKEN ? 'launched'  : 'FAILED - no token'));

  if (!TG_TOKEN) {
    console.error('[BOT] No Telegram token set. Check INTEL_BOT_TOKEN env var.');
    return;
  }

  await tg(
    '<b>MAVERICK INTEL BOT v2.0 - ONLINE</b>\n\n' +
    'Position monitor: every 60s\n' +
    'Price alerts: every 30s\n' +
    'News catalyst scanner: every 2min\n' +
    'Brain: ' + (GROQ_KEY ? 'Groq primary + Cerebras backup' : CBRS_KEY ? 'Cerebras only' : 'NO AI - check keys') + '\n\n' +
    'Type /help for all commands.'
  );

  setInterval(monitorPositions, 60000);
  setInterval(checkPriceAlerts, 30000);
  setInterval(scanNewsIntel,   120000);

  poll();
}

start();
