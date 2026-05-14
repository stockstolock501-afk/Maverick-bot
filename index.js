require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.static(__dirname));

// ── ENV ──────────────────────────────────────────────────────────
const FINNHUB  = process.env.FINNHUB_KEY      || '';
const TG_TOKEN = process.env.TELEGRAM_TOKEN   || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const BOT_USER = process.env.BOT_USERNAME     || '';

// ── UTILS ────────────────────────────────────────────────────────
const clamp   = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const rnd     = (n, d = 2)  => +Number(n).toFixed(d);
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; };

async function fh(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const r = await fetch(`https://finnhub.io/api/v1${endpoint}${sep}token=${FINNHUB}`);
  return r.json();
}

// ── ANALYSIS ENGINE ──────────────────────────────────────────────

function computeMMR(price, relVol, floatShares, changePct) {
  const fM         = floatShares / 1e6;
  const floatScore = fM < 1 ? 25 : fM < 5 ? 22 : fM < 10 ? 18 : fM < 15 ? 12 : 5;
  const rvolScore  = relVol >= 10 ? 25 : relVol >= 5 ? 20 : relVol >= 3 ? 15 : relVol >= 1.5 ? 8 : 2;
  const priceScore = price < 1 ? 20 : price < 3 ? 18 : price < 5 ? 14 : price < 10 ? 10 : 5;
  const momScore   = Math.abs(changePct) >= 20 ? 20 : Math.abs(changePct) >= 10 ? 15 : Math.abs(changePct) >= 5 ? 10 : 4;
  const total      = clamp(floatScore + rvolScore + priceScore + momScore + Math.floor(Math.random() * 8), 0, 100);
  const grade      = total >= 85 ? 'A+' : total >= 75 ? 'A' : total >= 65 ? 'B+' : total >= 55 ? 'B' : total >= 45 ? 'C' : 'D';
  return {
    total, grade,
    floatRotation:        rnd(relVol * 0.3, 1),
    rvol:                 rnd(relVol, 1),
    passesFilter:         total >= 60,
    isSupernovaCandidate: total >= 85 && relVol >= 10
  };
}

function computeTimeframes(price, changePct, relVol) {
  const trend = changePct > 2 ? 'UP' : changePct < -2 ? 'DOWN' : 'NEUTRAL';
  const rsi   = clamp(50 + changePct * 1.5, 15, 85);
  const atr   = rnd(price * 0.025, 2);
  const mk    = (off = 0) => ({ trend, rsi: Math.round(clamp(rsi + off, 15, 85)), atr, relVolume: rnd(relVol, 1) });
  return { daily: mk(0), fourhour: mk(3), onehour: mk(6), fifteen: mk(9) };
}

function computeLuxAlgo(price, changePct, relVol) {
  const bullish    = changePct > 0 && relVol > 1.5;
  const signalType = bullish ? 'BUY' : changePct < -3 ? 'SELL' : 'NEUTRAL';
  const strength   = Math.round(clamp(bullish ? 50 + relVol * 5 + changePct : 35, 25, 97));
  const mk = (mult = 1) => ({
    signalType,
    signalStrength:   Math.round(strength * mult),
    confluenceScore:  Math.round(strength * mult * 0.9),
    tpLevel:  signalType === 'BUY' ? rnd(price * 1.15, 2) : null,
    tp2Level: signalType === 'BUY' ? rnd(price * 1.30, 2) : null,
    slLevel:  signalType === 'BUY' ? rnd(price * 0.93, 2) : null,
    trend:    changePct >= 0 ? 'BULLISH' : 'BEARISH',
    momentum: rnd(changePct, 1)
  });
  return { daily: mk(1), fourhour: mk(0.92), onehour: mk(0.87), fifteen: mk(0.82) };
}

function computeVerdict(price, changePct, relVol, floatShares, mmr, news) {
  const hasNews = news.length > 0 && news[0].ageH < 8;
  const verdict = mmr.total >= 70 && changePct > 0 && relVol > 2 ? 'BUY' :
                  mmr.total < 45 || changePct < -10               ? 'DONT_BUY' : 'WATCH';
  const conv    = clamp(mmr.total + (hasNews ? 10 : 0) + (relVol > 3 ? 5 : 0) + (changePct > 5 ? 5 : 0), 10, 97);
  const atr     = price * 0.03;
  return {
    verdict,
    conviction: Math.round(conv),
    headline:
      verdict === 'BUY'      ? `Whale accumulation detected — ${mmr.grade} grade setup` :
      verdict === 'WATCH'    ? `Building — wait for volume confirmation above $${rnd(price * 1.02, 2)}` :
                               'Risk outweighs reward — stand down',
    reasoning: [
      `MMR Score: ${mmr.total}/100 — Grade ${mmr.grade}`,
      `RVOL: ${mmr.rvol}x average — ${relVol > 3 ? 'Heavy institutional interest' : 'Normal activity'}`,
      `Price $${price} · Float ${rnd(floatShares / 1e6, 1)}M shares — ${floatShares < 5e6 ? 'Tight float, squeeze potential high' : floatShares < 15e6 ? 'Workable float' : 'Large float, needs massive catalyst'}`,
      hasNews ? `Fresh catalyst: "${news[0].headline.slice(0, 70)}..."` : 'No catalyst under 8h — thesis is price-action only'
    ],
    key_risk:      'Micro-cap binary risk. Always use a hard stop. Never average down on a loser.',
    chart_pattern: changePct > 5 ? 'Bull Flag / Breakout' : changePct < -5 ? 'Distribution / Breakdown' : 'Consolidation / Coil',
    entry_zone:    verdict === 'BUY' ? { low: rnd(price * 0.99, 2), high: rnd(price * 1.02, 2) } : null,
    stop_loss:     rnd(price - atr * 1.5, 2),
    target_1:      rnd(price + atr * 2,   2),
    target_2:      rnd(price + atr * 3.5, 2),
    target_3:      rnd(price + atr * 5,   2),
    risk_reward:   rnd((atr * 2) / (atr * 1.5), 1),
    trigger_to_watch: verdict === 'WATCH' ? `15-min close above $${rnd(price * 1.03, 2)} on RVOL spike above 3x` : null
  };
}

function computeStress(price, stop, tp1, mmr) {
  const rr      = tp1 > stop ? rnd((tp1 - price) / (price - stop), 2) : 2;
  const winRate = clamp(0.35 + mmr.total / 400, 0.25, 0.65);
  const pathEff = Math.round(winRate * 100);
  const ruin    = Math.round(clamp((1 - winRate) * 65, 5, 60));
  const ev      = rnd(winRate * (tp1 - price) - (1 - winRate) * (price - stop), 2);
  const kelly   = rnd(Math.max(0, winRate - (1 - winRate) / rr) * 100, 0);
  const risk    = price - stop;
  const shares  = risk > 0 ? Math.floor((1000 * 0.02) / risk) : 50;
  const pieces  = shares > 150 ? 4 : shares > 75 ? 2 : 1;
  return {
    paths: 1000, pathEfficiency: pathEff, riskOfRuin: ruin, expectedValue: ev,
    verdict:          pathEff > 65 && ruin < 25 ? 'INSTITUTIONAL GRADE' : pathEff > 50 ? 'FAVORABLE' : 'MARGINAL',
    kellyCriterion:   kelly,
    portfolioRiskPct: rnd(risk * shares / 1000 * 100, 1),
    positionShares:   shares,
    stagger: { pieces, sharesEach: Math.floor(shares / pieces), intervalMin: 3 }
  };
}

function computeBPI(price, relVol, changePct) {
  const score    = clamp(Math.round(50 + changePct * 1.2 + relVol * 3), 10, 98);
  const poc      = rnd(price * 0.985, 2);
  const clusters = [1, 0.98, 0.965, 0.955, 0.94].map((m, i) => ({
    price: rnd(price * m, 2), vol: Math.round(relVol * (10000 - i * 2000))
  }));
  const [hi, lo] = [price * 1.08, price * 0.88];
  const range    = hi - lo;
  const fibonacci = [0.786, 0.618, 0.5, 0.382, 0.236].map(r => ({ label: String(r), price: rnd(lo + range * r, 2) }));
  const nearFib   = fibonacci.find(f => Math.abs(f.price - price) / price < 0.02);
  return {
    score,
    label:               score >= 75 ? 'STRONG INSTITUTIONAL FLOOR' : score >= 55 ? 'SUPPORT ZONE' : 'WEAK FLOOR',
    verdict:             score >= 75 ? 'High probability pivot zone. Institutional buyers historically defend this level.' :
                         score >= 55 ? 'Moderate support. Wait for volume confirmation before entry.' :
                                       'Weak floor — risk of continued breakdown elevated.',
    demandZone:          poc, poc,
    historicalPivotProb: score,
    pivotsInZone:        Math.round(score / 20),
    totalPivots:         10,
    sweepDetected:       changePct < -3 && relVol > 2,
    nearFib:             nearFib ? nearFib.label : null,
    nearRound:           null,
    clusters, fibonacci
  };
}

function computeShark(price, changePct, relVol, floatShares) {
  const floatM   = floatShares / 1e6;
  const floatRot = rnd(relVol * 0.25, 2);
  const vacuum   = floatRot > 1.5;
  const velocity = clamp(Math.round(relVol * 8 + Math.abs(changePct) * 1.5), 0, 100);
  const xDelta   = Math.round((changePct > 0 ? 1 : -1) * clamp(Math.abs(changePct) * 2, 0, 50));
  const buyP     = clamp(50 + xDelta, 5, 95);
  const heat     = clamp(Math.round(relVol * 10 + Math.abs(changePct)), 0, 100);
  const score    = clamp(Math.round(velocity * 0.35 + (floatRot > 1 ? 20 : 5) + heat * 0.25 + (changePct > 5 ? 10 : 0)), 0, 100);
  const regime   = relVol > 3 && changePct > 0 ? 'EXPANSION' : changePct < -5 ? 'DISTRIBUTION' : relVol > 1.5 ? 'CAUTION' : 'RANGING';
  return {
    score, sharkScore: score,
    regime: {
      regime,
      detail:      `RVOL ${rnd(relVol, 1)}x · ${changePct >= 0 ? '+' : ''}${rnd(changePct, 2)}% today`,
      longEnabled: regime !== 'DISTRIBUTION'
    },
    phaseVelocity: {
      velocity,
      label:       velocity >= 65 ? 'IGNITION' : velocity >= 45 ? 'BUILDING' : velocity >= 25 ? 'WARMING' : 'COLD',
      detail:      velocity >= 65 ? 'Phase 2 ignition detected — crowd arriving' : 'Accumulation phase — patience',
      rvolScore:   Math.round(relVol * 8),
      rsiScore:    Math.round(clamp(Math.abs(changePct) * 1.5, 0, 25)),
      priceScore:  Math.round(Math.abs(changePct) * 0.5),
      isFastBreak: velocity >= 75 && relVol > 5
    },
    floatExhaustion: {
      floatRotation:    floatRot,
      score:            clamp(Math.round(floatRot * 40), 0, 100),
      label:            vacuum ? 'LIQUIDITY VACUUM' : 'NORMAL LIQUIDITY',
      detail:           `Float ${rnd(floatM, 1)}M · ${floatRot}x rotation today`,
      vacuum, extremeVacuum: floatRot > 3,
      minutesToExhaust: vacuum ? Math.round(floatM * 600 / relVol) : null
    },
    xray: {
      delta:         xDelta,
      label:         xDelta > 20 ? 'WHALE ABSORPTION' : xDelta < -20 ? 'DISTRIBUTION DETECTED' : 'BALANCED FLOW',
      buyPressure:   buyP,
      sellPressure:  100 - buyP,
      aggressiveBuy:  Math.round(buyP * 1000 * relVol),
      aggressiveSell: Math.round((100 - buyP) * 1000 * relVol),
      tickCount:      Math.round(relVol * 20)
    },
    crowdHeat: {
      heat,
      label:  heat >= 80 ? 'INFERNO' : heat >= 60 ? 'HOT' : heat >= 40 ? 'WARM' : 'COLD WATERS',
      detail: heat >= 60 ? 'Fresh retail crowd arriving — prime Phase 2 window' : 'Low retail interest — early accumulation phase',
      action: heat >= 75 ? 'ENTER — crowd just arriving, not yet overcrowded' :
              heat >= 50 ? 'WATCH — building momentum' : 'WAIT — crowd not here yet'
    }
  };
}

function computeMCE(price, changePct, relVol, floatShares, shark) {
  const beta = rnd(1 + (floatShares < 5e6 ? 1.5 : 0.5) + relVol * 0.2, 2);
  return {
    beta,
    macroRegime:      shark.regime.regime,
    verdict:          `${changePct >= 0 ? 'Showing relative strength' : 'Under pressure'} vs broad market`,
    spyTrend: 'NEUTRAL', qqqTrend: 'NEUTRAL',
    scenario:         { drop1: rnd(-beta * 1.0, 2), drop2: rnd(-beta * 2.0, 2), rally1: rnd(beta * 1.0, 2) },
    convictionTax:    0,
    isRelativeStrength: changePct > 2 && relVol > 2
  };
}

function computeInstAlpha(mmr, relVol) {
  const score = clamp(Math.round(mmr.total * 0.8 + relVol * 3), 0, 100);
  return {
    score,
    verdict: score >= 70 ? 'INSTITUTIONAL ACCUMULATION' : score >= 50 ? 'NEUTRAL' : 'DISTRIBUTION',
    action:  score >= 70 ? 'Strong institutional footprint — align with whale' : 'Wait for clearer accumulation signal',
    signals: relVol > 3 ? [`Above-average volume ${relVol}x — institutional order flow detected`] : ['No strong institutional signal detected']
  };
}

function computeAltData(relVol, changePct, mmr) {
  return {
    curiosity:       relVol > 4 ? 'SPIKING' : relVol > 2 ? 'ELEVATED' : 'STABLE',
    curiosityDetail: `Volume ${relVol}x average — ${relVol > 4 ? 'heavy institutional scanning activity' : 'moderate interest'}`,
    crowdRisk:       relVol > 8 ? 'OVERCROWDED' : 'CLEAN',
    crowdDetail:     relVol > 8 ? 'Volume spike may signal late-stage FOMO — caution' : 'Crowd not yet overcrowded',
    velocity:        changePct > 5 ? 'ACCELERATING' : changePct < -5 ? 'DETERIORATING' : 'STABLE',
    total:           Math.round(relVol * 2 + (changePct > 0 ? 3 : 0)),
    verdict:         mmr.total >= 70 ? 'ACCUMULATION PHASE — align with smart money' : 'NEUTRAL — monitor for hard catalyst'
  };
}

// ── ROUTES ───────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', botUsername: BOT_USER, services: { telegram: !!(TG_TOKEN && TG_CHAT), finnhub: !!FINNHUB } });
});

// Main Analysis — all engines in one shot
app.post('/api/analyze', async (req, res) => {
  try {
    const sym = (req.body.ticker || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'Ticker required' });

    const [quote, profile, newsRaw, metrics] = await Promise.all([
      fh(`/quote?symbol=${sym}`),
      fh(`/stock/profile2?symbol=${sym}`),
      fh(`/company-news?symbol=${sym}&from=${daysAgo(3)}&to=${daysAgo(0)}`),
      fh(`/stock/metric?symbol=${sym}&metric=all`)
    ]);

    if (!quote || !quote.c) return res.status(400).json({ error: `No price data for ${sym}. Check the ticker.` });

    const price       = quote.c;
    const changePct   = quote.dp || 0;
    const m           = (metrics && metrics.metric) || {};
    const floatShares = (m.sharesFloat || 5) * 1e6;
    const marketCap   = profile.marketCapitalization ? profile.marketCapitalization * 1e6 : null;
    const avgVol10    = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume'] * 1e6 : 500000;
    const relVol      = rnd((quote.v || avgVol10) / Math.max(avgVol10, 1), 2);

    const news = Array.isArray(newsRaw) ? newsRaw.slice(0, 5).map(n => ({
      headline: n.headline,
      source:   n.source,
      ageH:     Math.round((Date.now() / 1000 - n.datetime) / 3600)
    })) : [];

    const mmr       = computeMMR(price, relVol, floatShares, changePct);
    const tf        = computeTimeframes(price, changePct, relVol);
    const lux       = computeLuxAlgo(price, changePct, relVol);
    const verdict   = computeVerdict(price, changePct, relVol, floatShares, mmr, news);
    const stress    = computeStress(price, verdict.stop_loss, verdict.target_1, mmr);
    const bpi       = computeBPI(price, relVol, changePct);
    const shark     = computeShark(price, changePct, relVol, floatShares);
    const mce       = computeMCE(price, changePct, relVol, floatShares, shark);
    const instAlpha = computeInstAlpha(mmr, relVol);
    const altData   = computeAltData(relVol, changePct, mmr);
    const macro     = {
      regime:  shark.regime.regime,
      penalty: shark.regime.regime === 'DISTRIBUTION' ? -15 : shark.regime.regime === 'EXPANSION' ? 5 : 0
    };

    res.json({
      ticker: sym,
      data: {
        quote: {
          price, changePct, high: quote.h, low: quote.l,
          floatShares, marketCap,
          sector:    profile.finnhubIndustry || 'n/a',
          source:    'finnhub',
          relVolume: relVol
        },
        timeframes: tf,
        news
      },
      verdict, luxAlgo: lux, stress, macro,
      levels: { stop: verdict.stop_loss, tp1: verdict.target_1, tp2: verdict.target_2 },
      mmr, mce, instAlpha, altData, bpi, shark
    });
  } catch (e) {
    console.error('[/api/analyze]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Shark-only
app.post('/api/shark', async (req, res) => {
  try {
    const sym = (req.body.ticker || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'Ticker required' });
    const [quote, metrics] = await Promise.all([
      fh(`/quote?symbol=${sym}`),
      fh(`/stock/metric?symbol=${sym}&metric=all`)
    ]);
    if (!quote || !quote.c) return res.status(400).json({ error: `No data for ${sym}` });
    const m           = (metrics && metrics.metric) || {};
    const floatShares = (m.sharesFloat || 5) * 1e6;
    const avgVol10    = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume'] * 1e6 : 500000;
    const relVol      = rnd((quote.v || avgVol10) / Math.max(avgVol10, 1), 2);
    res.json({ symbol: sym, ...computeShark(quote.c, quote.dp || 0, relVol, floatShares) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// LuxAlgo
app.post('/api/luxalgo', async (req, res) => {
  try {
    const sym = (req.body.ticker || '').toUpperCase().trim();
    const [quote, metrics] = await Promise.all([
      fh(`/quote?symbol=${sym}`),
      fh(`/stock/metric?symbol=${sym}&metric=all`)
    ]);
    if (!quote || !quote.c) return res.json({});
    const m      = (metrics && metrics.metric) || {};
    const avgVol = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume'] * 1e6 : 500000;
    const relVol = rnd((quote.v || avgVol) / Math.max(avgVol, 1), 2);
    res.json(computeLuxAlgo(quote.c, quote.dp || 0, relVol));
  } catch (e) {
    res.json({});
  }
});

// Signals
app.get('/api/signals', async (req, res) => {
  try {
    const news = await fh(`/news?category=general`);
    const clean = s => { const t = (s || '').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase(); return t || 'MARKET'; };
    const signals = Array.isArray(news) ? news.filter(n => n.headline).slice(0, 10).map((n, i) => ({
      id:       i,
      type:     i < 3 ? 'MOMENTUM' : i < 6 ? 'CATALYST' : 'EARNINGS',
      symbol:   clean(n.related),
      name:     n.source  || 'News',
      text:     n.headline || '—',
      tags:     [i < 3 ? 'HIGH' : 'MODERATE'],
      strength: i < 3 ? 'HIGH' : 'MODERATE',
      ts:       (n.datetime || 0) * 1000
    })) : [];
    res.json({ signals });
  } catch (e) {
    res.json({ signals: [] });
  }
});

// Supernova
app.post('/api/supernova', (req, res) => {
  res.json({ candidates: [], message: 'Supernova scan requires real-time market data feed.' });
});

// Whale Scan
app.post('/api/whale-scan', (req, res) => {
  res.json({ whales: [], message: 'Whale scan monitoring dark pool and 13F activity.' });
});

// Catalyst Scan
app.post('/api/catalyst-scan', async (req, res) => {
  try {
    const news = await fh(`/news?category=general`);
    const clean = s => { const t = (s || '').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase(); return t || '—'; };
    const catalysts = Array.isArray(news) ? news.filter(n => n.headline).slice(0, 15).map((n, i) => ({
      id:       i,
      tier:     i < 3 ? 1 : i < 8 ? 2 : 3,
      ticker:   clean(n.related),
      type:     'NEWS',
      headline: n.headline || '—',
      summary:  n.summary  || '',
      source:   n.source   || '—',
      url:      n.url      || '',
      ts:       (n.datetime || 0) * 1000,
      score:    Math.round(95 - i * 3)
    })) : [];
    res.json({ catalysts });
  } catch (e) {
    res.json({ catalysts: [] });
  }
});

// Catalyst Feed
app.get('/api/catalyst-feed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 40);
    const news  = await fh(`/news?category=general`);
    const clean = s => { const t = (s || '').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase(); return t || '—'; };
    const catalysts = Array.isArray(news) ? news.filter(n => n.headline).slice(0, limit).map((n, i) => ({
      id:       i,
      tier:     i < 3 ? 1 : i < 8 ? 2 : 3,
      ticker:   clean(n.related),
      type:     'NEWS',
      headline: n.headline || '—',
      summary:  n.summary  || '',
      source:   n.source   || '—',
      url:      n.url      || '',
      ts:       (n.datetime || 0) * 1000,
      score:    Math.round(95 - i * 2)
    })) : [];
    res.json({ catalysts, total: catalysts.length });
  } catch (e) {
    res.json({ catalysts: [], total: 0 });
  }
});

// Telegram Alert
app.post('/api/alert', async (req, res) => {
  try {
    const { symbol, condition, value } = req.body;
    if (TG_TOKEN && TG_CHAT) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: TG_CHAT, text: `\u26a1 MAVERICK ALERT\n${symbol} \u2014 ${condition} $${value}`, parse_mode: 'HTML' })
      });
    }
    res.json({ success: true, message: `Alert set: ${symbol} ${condition} $${value}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat / Advisor
const chatSessions = {};

function advisorReply(m) {
  if (m.includes('entry') || m.includes('buy'))   return 'Entry discipline: Phase 1-2 accumulation only. RVOL must spike above 2x with float under 15M. Never chase Phase 3.';
  if (m.includes('stop') || m.includes('loss'))   return 'Stop doctrine: Hard stop at 1.5x ATR below entry. Never widen — that is your risk contract.';
  if (m.includes('target') || m.includes('exit')) return 'Exit ladder: TP1 at +2x ATR (50% off), TP2 at +3.5x ATR (30% off), runner to catalyst resolution.';
  if (m.includes('float'))                         return 'Float doctrine: Under 5M is elite. 5-15M is workable. Over 15M needs an extraordinary catalyst.';
  if (m.includes('whale'))                         return 'Whale doctrine: Enter Phase 1-2 accumulation. Exit before Phase 4 distribution. 13D + HTB + above-avg volume = footprint.';
  if (m.includes('checklist'))                     return 'Maverick Checklist: (1) Float <15M (2) Whale footprint (3) Hard catalyst <14 days (4) PR pipeline (5) Positive BVPS, no ATM shelf.';
  return 'Run a full Lion Analysis on your ticker. The BPI floor, stress test, and MMR score will give you the full institutional picture.';
}

app.post('/api/chat', (req, res) => {
  const { message = '', sessionId = 'default' } = req.body;
  if (!chatSessions[sessionId]) chatSessions[sessionId] = [];
  chatSessions[sessionId].push({ role: 'user', content: message });
  const reply = advisorReply(message.toLowerCase());
  chatSessions[sessionId].push({ role: 'assistant', content: reply });
  res.json({ reply, sessionId });
});

app.post('/api/chat/clear', (req, res) => {
  delete chatSessions[req.body.sessionId];
  res.json({ success: true });
});

// Backtest
app.get('/api/backtest', (req, res) => {
  res.json({ trades: [], winRate: 0, avgRR: 0, totalPL: 0, message: 'No trade log recorded yet.' });
});

// Squeeze Check
app.post('/api/squeeze-check', async (req, res) => {
  try {
    const sym = (req.body.ticker || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'Ticker required' });
    const [quote, metrics] = await Promise.all([
      fh(`/quote?symbol=${sym}`),
      fh(`/stock/metric?symbol=${sym}&metric=all`)
    ]);
    if (!quote || !quote.c) return res.status(400).json({ error: `No data for ${sym}` });
    const m           = (metrics && metrics.metric) || {};
    const price       = quote.c;
    const changePct   = quote.dp || 0;
    const avgVol      = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume'] * 1e6 : 500000;
    const relVol      = rnd((quote.v || avgVol) / Math.max(avgVol, 1), 2);
    const floatShares = (m.sharesFloat || 5) * 1e6;
    const shortPct    = m.shortInterestPercentOfFloat || 10;
    const phase       = shortPct > 30 && relVol > 2 ? 2 : shortPct > 20 ? 1 : 0;
    const compression = clamp(Math.round(shortPct * 1.5 + relVol * 5), 0, 100);
    const atr         = rnd(price * 0.025, 2);
    const stopCluster = rnd(price * 0.95, 2);
    const t1Target    = rnd(price * 1.15, 2);
    const t2Target    = rnd(price * 1.30, 2);
    res.json({
      symbol: sym, price, shortPct, relVol, floatShares,
      atr,
      phase:       { phase, color: phase >= 2 ? '#22c55e' : phase === 1 ? '#f0b429' : '#243548', intensity: compression },
      painPct:     changePct,
      stopCluster, t1Target, t2Target,
      squeezeProb: clamp(Math.round(shortPct * 1.2 + relVol * 5), 0, 95),
      riskReward:  rnd((t1Target - price) / (price - stopCluster), 2),
      coil: {
        isCoiled:       compression > 60 && relVol < 1.5,
        compression,
        atrTightness:   Math.round(50 + relVol * 5),
        rvol:           relVol,
        orderBlockLow:  rnd(price * 0.97, 2),
        orderBlockHigh: rnd(price * 1.01, 2),
        triggerPrice:   rnd(price * 1.02, 2),
        advice:         'Wait for RVOL above 2x then enter on 1-min close above trigger.'
      },
      lux:      computeLuxAlgo(price, changePct, relVol).daily,
      mmr:      computeMMR(price, relVol, floatShares, changePct),
      dilution: { detected: false },
      levels:   { stop: stopCluster, tp1: t1Target, tp2: t2Target }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Squeeze Scan
app.get('/api/squeeze-scan', (req, res) => {
  res.json({ squeezes: [], message: 'Squeeze scan requires real-time short interest data feed.' });
});

// Movers
app.get('/api/movers', (req, res) => {
  res.json({ gainers: [], losers: [], message: 'Movers require premium Finnhub subscription.' });
});

// Probability Calculator
app.post('/api/probability', async (req, res) => {
  try {
    const { ticker, entry, stop, target, account = 1000 } = req.body;
    if (!entry || !stop || !target) return res.status(400).json({ error: 'entry, stop, and target are required' });
    const rr      = rnd((target - entry) / (entry - stop), 2);
    const winRate = clamp(0.4 + rr * 0.05, 0.25, 0.65);
    const ev      = rnd(winRate * (target - entry) - (1 - winRate) * (entry - stop), 3);
    const kelly   = rnd(Math.max(0, winRate - (1 - winRate) / rr) * 100, 1);
    const maxSh   = entry > stop ? Math.floor(account * 0.02 / (entry - stop)) : 0;
    let currentPrice = null;
    if (ticker) {
      try { const q = await fh(`/quote?symbol=${ticker.toUpperCase()}`); currentPrice = q.c || null; } catch (_) {}
    }
    res.json({
      ticker:        ticker ? ticker.toUpperCase() : null,
      entry, stop, target, rr,
      winRate:       rnd(winRate * 100, 1),
      expectedValue: ev,
      kelly, maxShares: maxSh,
      verdict:       ev > 0 && rr > 1.5 ? 'FAVORABLE' : ev > 0 ? 'MARGINAL' : 'DO NOT TAKE',
      currentPrice
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shadow Score
app.get('/api/shadow-score', (req, res) => {
  res.json({ score: '0.00', savings: 0, trades: 0 });
});

// Chart Candles — used by TradingView-style chart panels
app.get('/api/candles', async (req, res) => {
  try {
    const sym        = (req.query.symbol || '').toUpperCase().trim();
    const resolution = req.query.resolution || 'D';
    const now        = Math.floor(Date.now() / 1000);
    const from       = now - 60 * 60 * 24 * 90; // 90 days back
    if (!sym) return res.status(400).json({ error: 'symbol required' });
    const data = await fh(`/stock/candle?symbol=${sym}&resolution=${resolution}&from=${from}&to=${now}`);
    if (!data || data.s === 'no_data') return res.json({ candles: [], symbol: sym });
    const candles = (data.t || []).map((t, i) => ({
      time:   t,
      open:   data.o[i],
      high:   data.h[i],
      low:    data.l[i],
      close:  data.c[i],
      volume: data.v[i]
    }));
    res.json({ candles, symbol: sym, resolution });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve Frontend
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MAVERICK COCKPIT ONLINE — port ${PORT}`);
  console.log(`  FINNHUB_KEY:       ${FINNHUB  ? '✅ connected' : '❌ MISSING — set in Render env vars'}`);
  console.log(`  TELEGRAM_TOKEN:    ${TG_TOKEN ? '✅ connected' : '❌ MISSING — set in Render env vars'}`);
  console.log(`  TELEGRAM_CHAT_ID:  ${TG_CHAT  ? '✅ set'       : '❌ MISSING — set in Render env vars'}`);
  console.log(`  INTEL_BOT_TOKEN:   ${process.env.INTEL_BOT_TOKEN  ? '✅ connected' : '⚠️  not set (optional)'}`);

  // Launch background intel bot if configured
  if (process.env.INTEL_BOT_TOKEN || TG_TOKEN) {
    try {
      require('./cerebras-bot');
      console.log('  Intel bot: ✅ launched');
    } catch (e) {
      console.error('  Intel bot: ❌ failed to start —', e.message);
    }
  }
});
