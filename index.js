require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.static(__dirname));

// ── ENV ──────────────────────────────────────────────────────────
const FINNHUB      = process.env.FINNHUB_KEY      || '';
const CEREBRAS_KEY = process.env.CEREBRAS_KEY     || '';
const GROQ_KEY     = process.env.GROQ_KEY         || '';
const GROQ_KEY_2   = process.env.GROQ_KEY_2       || '';
const TG_TOKEN     = process.env.TELEGRAM_TOKEN   || '';
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID || '';
const BOT_USER     = process.env.TG_BOT_USERNAME  || '';
const JBIN_BIN     = process.env.JSONBIN_BIN      || '';
const JBIN_KEY     = process.env.JSONBIN_KEY      || '';

// ── UTILS ────────────────────────────────────────────────────────
const clamp   = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const rnd     = (n, d = 2)  => +Number(n).toFixed(d);
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; };

// ── FINNHUB ──────────────────────────────────────────────────────
async function fh(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const r = await fetch(`https://finnhub.io/api/v1${endpoint}${sep}token=${FINNHUB}`);
  return r.json();
}

// ── GROQ / CEREBRAS AI ENGINE ────────────────────────────────────
// Primary: Groq (fastest, most reliable)
// Backup:  Cerebras
async function callAI(systemPrompt, userPrompt, maxTokens = 1200) {
  // PRIMARY — Groq
  const groqKey = GROQ_KEY || GROQ_KEY_2;
  if (groqKey) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model:       'llama-3.1-8b-instant',
          max_tokens:  maxTokens,
          temperature: 0.15,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   }
          ]
        })
      });
      const d    = await r.json();
      const text = d?.choices?.[0]?.message?.content || '';
      if (text) { const parsed = safeParseJSON(text); if (parsed) return parsed; }
    } catch (e) { console.error('[Groq]', e.message); }
  }
  // BACKUP — Cerebras
  if (CEREBRAS_KEY) {
    try {
      const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CEREBRAS_KEY}` },
        body: JSON.stringify({
          model:       'llama3.1-8b',
          max_tokens:  maxTokens,
          temperature: 0.15,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   }
          ]
        })
      });
      const d    = await r.json();
      const text = d?.choices?.[0]?.message?.content || '';
      if (text) { const parsed = safeParseJSON(text); if (parsed) return parsed; }
    } catch (e) { console.error('[Cerebras]', e.message); }
  }
  return null; // Falls through to computed fallback
}

function safeParseJSON(text) {
  try {
    // Strip markdown code fences if present
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (_) {
    // Try to extract JSON block
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
    return null;
  }
}

// ── JSONBIN (persistent storage) ─────────────────────────────────
async function jbinGet() {
  if (!JBIN_BIN || !JBIN_KEY) return {};
  try {
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JBIN_BIN}/latest`, {
      headers: { 'X-Master-Key': JBIN_KEY }
    });
    const d = await r.json();
    return d?.record || {};
  } catch (_) { return {}; }
}
async function jbinSet(data) {
  if (!JBIN_BIN || !JBIN_KEY) return;
  try {
    await fetch(`https://api.jsonbin.io/v3/b/${JBIN_BIN}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JBIN_KEY },
      body:    JSON.stringify(data)
    });
  } catch (_) {}
}

// ── FALLBACK COMPUTE ENGINE (used when AI unavailable) ───────────
function computeMMR(price, relVol, floatShares, changePct) {
  const fM         = floatShares / 1e6;
  const floatScore = fM < 1 ? 25 : fM < 5 ? 22 : fM < 10 ? 18 : fM < 15 ? 12 : 5;
  const rvolScore  = relVol >= 10 ? 25 : relVol >= 5 ? 20 : relVol >= 3 ? 15 : relVol >= 1.5 ? 8 : 2;
  const priceScore = price < 1 ? 20 : price < 3 ? 18 : price < 5 ? 14 : price < 10 ? 10 : 5;
  const momScore   = Math.abs(changePct) >= 20 ? 20 : Math.abs(changePct) >= 10 ? 15 : Math.abs(changePct) >= 5 ? 10 : 4;
  const total      = clamp(floatScore + rvolScore + priceScore + momScore, 0, 100);
  const grade      = total >= 85 ? 'A+' : total >= 75 ? 'A' : total >= 65 ? 'B+' : total >= 55 ? 'B' : total >= 45 ? 'C' : 'D';
  return { total, grade, floatRotation: rnd(relVol * 0.3, 1), rvol: rnd(relVol, 1), passesFilter: total >= 60, isSupernovaCandidate: total >= 85 && relVol >= 10 };
}

function computeFallbackVerdict(price, changePct, relVol, floatShares, mmr, news) {
  const hasNews = news.length > 0 && news[0].ageH < 8;
  const verdict = mmr.total >= 70 && changePct > 0 && relVol > 2 ? 'BUY' :
                  mmr.total < 45 || changePct < -10               ? 'DONT_BUY' : 'WATCH';
  const conv    = clamp(mmr.total + (hasNews ? 10 : 0) + (relVol > 3 ? 5 : 0), 10, 97);
  const atr     = price * 0.03;
  return {
    verdict, conviction: Math.round(conv),
    headline: verdict === 'BUY' ? `MMR ${mmr.grade} — accumulation pattern detected` :
              verdict === 'WATCH' ? `Wait for volume confirmation above $${rnd(price*1.02,2)}` :
              'Risk outweighs reward — stand down',
    reasoning: [
      `MMR Score: ${mmr.total}/100 — Grade ${mmr.grade}`,
      `RVOL: ${mmr.rvol}x average volume`,
      `Float: ${rnd(floatShares/1e6,1)}M shares`,
      hasNews ? `Catalyst: ${news[0].headline.slice(0,60)}...` : 'No fresh catalyst detected'
    ],
    key_risk:      'Micro-cap binary risk. Always use a hard stop.',
    chart_pattern: changePct > 5 ? 'Breakout' : changePct < -5 ? 'Breakdown' : 'Consolidation',
    entry_zone:    verdict === 'BUY' ? { low: rnd(price*0.99,2), high: rnd(price*1.02,2) } : null,
    stop_loss:     rnd(price - atr*1.5, 2),
    target_1:      rnd(price + atr*2,   2),
    target_2:      rnd(price + atr*3.5, 2),
    target_3:      rnd(price + atr*5,   2),
    risk_reward:   rnd((atr*2)/(atr*1.5), 1),
    trigger_to_watch: verdict === 'WATCH' ? `15-min close above $${rnd(price*1.03,2)} on 3x RVOL` : null
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
  const strength   = Math.round(clamp(bullish ? 50 + relVol*5 + changePct : 35, 25, 97));
  const mk = (m = 1) => ({
    signalType, signalStrength: Math.round(strength*m), confluenceScore: Math.round(strength*m*0.9),
    tpLevel:  signalType==='BUY' ? rnd(price*1.15,2) : null,
    tp2Level: signalType==='BUY' ? rnd(price*1.30,2) : null,
    slLevel:  signalType==='BUY' ? rnd(price*0.93,2) : null,
    trend: changePct >= 0 ? 'BULLISH' : 'BEARISH', momentum: rnd(changePct,1)
  });
  return { daily: mk(1), fourhour: mk(0.92), onehour: mk(0.87), fifteen: mk(0.82) };
}

function computeStress(price, stop, tp1, mmr) {
  const rr      = tp1 > stop ? rnd((tp1-price)/(price-stop),2) : 2;
  const winRate = clamp(0.35 + mmr.total/400, 0.25, 0.65);
  const risk    = price - stop;
  const shares  = risk > 0 ? Math.floor((1000*0.02)/risk) : 50;
  const pieces  = shares > 150 ? 4 : shares > 75 ? 2 : 1;
  const ev      = rnd(winRate*(tp1-price) - (1-winRate)*(price-stop), 2);
  return {
    paths: 1000, pathEfficiency: Math.round(winRate*100),
    riskOfRuin:     Math.round(clamp((1-winRate)*65, 5, 60)),
    expectedValue:  ev,
    verdict:        winRate > 0.65 ? 'INSTITUTIONAL GRADE' : winRate > 0.5 ? 'FAVORABLE' : 'MARGINAL',
    kellyCriterion: rnd(Math.max(0, winRate-(1-winRate)/rr)*100, 0),
    portfolioRiskPct: rnd(risk*shares/1000*100, 1),
    positionShares: shares,
    stagger: { pieces, sharesEach: Math.floor(shares/pieces), intervalMin: 3 }
  };
}

function computeBPI(price, relVol, changePct) {
  const score   = clamp(Math.round(50 + changePct*1.2 + relVol*3), 10, 98);
  const poc     = rnd(price*0.985, 2);
  const clusters = [1,0.98,0.965,0.955,0.94].map((m,i) => ({ price: rnd(price*m,2), vol: Math.round(relVol*(10000-i*2000)) }));
  const [hi,lo] = [price*1.08, price*0.88];
  const fibonacci = [0.786,0.618,0.5,0.382,0.236].map(r => ({ label: String(r), price: rnd(lo+(hi-lo)*r,2) }));
  return {
    score, poc, demandZone: poc, clusters, fibonacci,
    label:               score >= 75 ? 'STRONG INSTITUTIONAL FLOOR' : score >= 55 ? 'SUPPORT ZONE' : 'WEAK FLOOR',
    verdict:             score >= 75 ? 'High probability pivot zone.' : score >= 55 ? 'Moderate support — wait for volume confirmation.' : 'Weak floor — breakdown risk elevated.',
    historicalPivotProb: score, pivotsInZone: Math.round(score/20), totalPivots: 10,
    sweepDetected: changePct < -3 && relVol > 2,
    nearFib:       fibonacci.find(f => Math.abs(f.price-price)/price < 0.02)?.label || null, nearRound: null
  };
}

function computeShark(price, changePct, relVol, floatShares) {
  const floatRot = rnd(relVol*0.25, 2);
  const velocity = clamp(Math.round(relVol*8 + Math.abs(changePct)*1.5), 0, 100);
  const xDelta   = Math.round((changePct>0?1:-1) * clamp(Math.abs(changePct)*2,0,50));
  const buyP     = clamp(50+xDelta, 5, 95);
  const heat     = clamp(Math.round(relVol*10+Math.abs(changePct)), 0, 100);
  const score    = clamp(Math.round(velocity*0.35+(floatRot>1?20:5)+heat*0.25+(changePct>5?10:0)), 0, 100);
  const regime   = relVol>3&&changePct>0?'EXPANSION':changePct<-5?'DISTRIBUTION':relVol>1.5?'CAUTION':'RANGING';
  return {
    score, sharkScore: score,
    regime: { regime, detail: `RVOL ${rnd(relVol,1)}x · ${changePct>=0?'+':''}${rnd(changePct,2)}% today`, longEnabled: regime!=='DISTRIBUTION' },
    phaseVelocity: { velocity, label: velocity>=65?'IGNITION':velocity>=45?'BUILDING':velocity>=25?'WARMING':'COLD', detail: velocity>=65?'Phase 2 ignition':'Accumulation phase', rvolScore: Math.round(relVol*8), rsiScore: Math.round(clamp(Math.abs(changePct)*1.5,0,25)), priceScore: Math.round(Math.abs(changePct)*0.5), isFastBreak: velocity>=75&&relVol>5 },
    floatExhaustion: { floatRotation: floatRot, score: clamp(Math.round(floatRot*40),0,100), label: floatRot>1.5?'LIQUIDITY VACUUM':'NORMAL LIQUIDITY', detail: `Float ${rnd(floatShares/1e6,1)}M · ${floatRot}x rotation`, vacuum: floatRot>1.5, extremeVacuum: floatRot>3, minutesToExhaust: floatRot>1.5?Math.round(floatShares/1e6*600/relVol):null },
    xray: { delta: xDelta, label: xDelta>20?'WHALE ABSORPTION':xDelta<-20?'DISTRIBUTION DETECTED':'BALANCED FLOW', buyPressure: buyP, sellPressure: 100-buyP, aggressiveBuy: Math.round(buyP*1000*relVol), aggressiveSell: Math.round((100-buyP)*1000*relVol), tickCount: Math.round(relVol*20) },
    crowdHeat: { heat, label: heat>=80?'INFERNO':heat>=60?'HOT':heat>=40?'WARM':'COLD WATERS', detail: heat>=60?'Retail crowd arriving — Phase 2 window':'Low retail interest — accumulation phase', action: heat>=75?'ENTER — crowd just arriving':heat>=50?'WATCH — building':'WAIT — crowd not here yet' }
  };
}

// ── AI PROMPTS ───────────────────────────────────────────────────

const LION_SYSTEM = `You are LION BRAIN — an elite institutional trading analyst specializing in micro-cap and penny stocks.
You apply the Maverick Whale Doctrine: identify Phase 1-2 accumulation, exit before Phase 4 distribution.
Core rules: float under 15M is elite, RVOL above 2x is whale signal, positive BVPS required, no ATM shelf tolerated.
Price zones: under $1 = best, $1-3 = low premium, $3-5 = good enough.
Respond ONLY with valid JSON, no markdown, no explanation outside the JSON.`;

const LION_PROMPT = (data) => `Analyze this stock and return a JSON object with EXACTLY these fields:
{
  "verdict": "BUY" or "WATCH" or "DONT_BUY",
  "conviction": integer 0-100,
  "headline": "one punchy line max 80 chars",
  "reasoning": ["reason 1","reason 2","reason 3","reason 4"],
  "key_risk": "single biggest risk",
  "chart_pattern": "pattern name",
  "entry_zone": {"low": number, "high": number} or null,
  "stop_loss": number,
  "target_1": number,
  "target_2": number,
  "target_3": number,
  "risk_reward": number,
  "trigger_to_watch": "string or null",
  "whale_phase": integer 1-5,
  "regime": "EXPANSION" or "CAUTION" or "RANGING" or "DISTRIBUTION"
}

Market data: ${JSON.stringify(data)}`;

const SHARK_SYSTEM = `You are SHARK BRAIN — a flow-based micro-structure analyst. You detect whale accumulation through volume, float rotation, and price velocity. Respond ONLY with valid JSON.`;

const SHARK_PROMPT = (data) => `Analyze this ticker's shark signals. Return JSON with:
{
  "score": 0-100,
  "regime": "EXPANSION" or "CAUTION" or "RANGING" or "DISTRIBUTION",
  "regimeDetail": "one line",
  "longEnabled": true or false,
  "velocityLabel": "IGNITION" or "BUILDING" or "WARMING" or "COLD",
  "velocityDetail": "one line",
  "isFastBreak": true or false,
  "floatVacuum": true or false,
  "xrayLabel": "WHALE ABSORPTION" or "BALANCED FLOW" or "DISTRIBUTION DETECTED",
  "xrayDelta": integer -50 to 50,
  "buyPressure": 0-100,
  "heatLabel": "INFERNO" or "HOT" or "WARM" or "COLD WATERS",
  "heatAction": "one line action",
  "summary": "2-sentence trading implication"
}

Data: ${JSON.stringify(data)}`;

const ADVISOR_SYSTEM = `You are the Maverick Trading Advisor — an elite institutional trading coach for micro-cap stocks.
Rules you enforce: Maverick Whale Doctrine (Phase 1-2 entry, Phase 3 exit), $1,000 max per trade, 2% risk, pre-trade checklist required.
Be direct, specific, no fluff. Reference actual doctrine when relevant.
Keep responses under 200 words.`;

// ── ROUTES ───────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', botUsername: BOT_USER,
    services: {
      cerebras:  !!CEREBRAS_KEY,
      groq:      !!GROQ_KEY,
      finnhub:   !!FINNHUB,
      telegram:  !!(TG_TOKEN && TG_CHAT),
      jsonbin:   !!(JBIN_BIN && JBIN_KEY)
    }
  });
});

// ── MAIN ANALYZE — Cerebras-powered ─────────────────────────────
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

    if (!quote || !quote.c) return res.status(400).json({ error: `No price data for ${sym}` });

    const price       = quote.c;
    const changePct   = quote.dp || 0;
    const m           = (metrics?.metric) || {};
    const floatShares = (m.sharesFloat || 5) * 1e6;
    const marketCap   = profile.marketCapitalization ? profile.marketCapitalization * 1e6 : null;
    const avgVol10    = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume'] * 1e6 : 500000;
    const relVol      = rnd((quote.v || avgVol10) / Math.max(avgVol10, 1), 2);
    const shortPct    = m.shortInterestPercentOfFloat || 0;

    const news = Array.isArray(newsRaw) ? newsRaw.slice(0, 5).map(n => ({
      headline: n.headline, source: n.source,
      ageH: Math.round((Date.now()/1000 - n.datetime)/3600)
    })) : [];

    // Base computed values (always available)
    const mmr   = computeMMR(price, relVol, floatShares, changePct);
    const tf    = computeTimeframes(price, changePct, relVol);
    const lux   = computeLuxAlgo(price, changePct, relVol);
    const bpi   = computeBPI(price, relVol, changePct);
    const shark = computeShark(price, changePct, relVol, floatShares);

    // AI-powered verdict via Cerebras (falls back to formula if unavailable)
    const aiInput = {
      ticker: sym, price, changePct, relVol, floatM: rnd(floatShares/1e6,2),
      marketCap: marketCap ? `$${rnd(marketCap/1e6,1)}M` : 'unknown',
      sector: profile.finnhubIndustry || 'unknown',
      shortPct, mmrScore: mmr.total, mmrGrade: mmr.grade,
      week52High: m['52WeekHigh'] || null, week52Low: m['52WeekLow'] || null,
      recentNews: news.slice(0,3).map(n => n.headline),
      bpiScore: bpi.score, sharkScore: shark.score,
      sharkRegime: shark.regime.regime
    };

    const aiVerdict = await callAI(LION_SYSTEM, LION_PROMPT(aiInput), 1000);
    const verdict   = aiVerdict || computeFallbackVerdict(price, changePct, relVol, floatShares, mmr, news);

    // Normalize AI verdict fields to match what frontend expects
    if (aiVerdict) {
      verdict.conviction  = clamp(verdict.conviction || 50, 0, 100);
      verdict.stop_loss   = verdict.stop_loss   || rnd(price * 0.93, 2);
      verdict.target_1    = verdict.target_1    || rnd(price * 1.15, 2);
      verdict.target_2    = verdict.target_2    || rnd(price * 1.30, 2);
      verdict.target_3    = verdict.target_3    || rnd(price * 1.50, 2);
      verdict.risk_reward = verdict.risk_reward || rnd((verdict.target_1 - price)/(price - verdict.stop_loss), 1);
    }

    const stress = computeStress(price, verdict.stop_loss, verdict.target_1, mmr);
    const macro  = { regime: verdict.regime || shark.regime.regime, penalty: shark.regime.regime==='DISTRIBUTION'?-15:5 };

    const mce = {
      beta:               rnd(1 + (floatShares<5e6?1.5:0.5) + relVol*0.2, 2),
      macroRegime:        macro.regime,
      verdict:            `${changePct>=0?'Relative strength':'Under pressure'} vs broad market`,
      spyTrend: 'NEUTRAL', qqqTrend: 'NEUTRAL',
      scenario:           { drop1: rnd(-1.5,2), drop2: rnd(-3,2), rally1: rnd(1.5,2) },
      convictionTax:      0,
      isRelativeStrength: changePct > 2 && relVol > 2
    };

    const instAlpha = {
      score:   clamp(Math.round(mmr.total*0.8 + relVol*3), 0, 100),
      verdict: mmr.total>=70?'INSTITUTIONAL ACCUMULATION':mmr.total>=50?'NEUTRAL':'DISTRIBUTION',
      action:  mmr.total>=70?'Institutional footprint confirmed — align with whale':'Wait for clearer signal',
      signals: relVol>3?[`${relVol}x avg volume — institutional order flow`]:['No strong institutional signal']
    };

    const altData = {
      curiosity:       relVol>4?'SPIKING':relVol>2?'ELEVATED':'STABLE',
      curiosityDetail: `${relVol}x avg volume`,
      crowdRisk:       relVol>8?'OVERCROWDED':'CLEAN',
      crowdDetail:     relVol>8?'Late-stage FOMO risk':'Crowd not overcrowded',
      velocity:        changePct>5?'ACCELERATING':changePct<-5?'DETERIORATING':'STABLE',
      total:           Math.round(relVol*2 + (changePct>0?3:0)),
      verdict:         mmr.total>=70?'ACCUMULATION PHASE':'NEUTRAL'
    };

    res.json({
      ticker: sym,
      data: {
        quote: { price, changePct, high: quote.h, low: quote.l, floatShares, marketCap, sector: profile.finnhubIndustry||'n/a', source: 'finnhub', relVolume: relVol },
        timeframes: tf, news
      },
      verdict, luxAlgo: lux, stress, macro,
      levels: { stop: verdict.stop_loss, tp1: verdict.target_1, tp2: verdict.target_2 },
      mmr, mce, instAlpha, altData, bpi, shark,
      aiPowered: !!aiVerdict
    });
  } catch (e) {
    console.error('[/api/analyze]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── SHARK — AI-powered ───────────────────────────────────────────
app.post('/api/shark', async (req, res) => {
  try {
    const sym = (req.body.ticker || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'Ticker required' });
    const [quote, metrics] = await Promise.all([fh(`/quote?symbol=${sym}`), fh(`/stock/metric?symbol=${sym}&metric=all`)]);
    if (!quote?.c) return res.status(400).json({ error: `No data for ${sym}` });
    const m           = metrics?.metric || {};
    const floatShares = (m.sharesFloat || 5) * 1e6;
    const avgVol      = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume']*1e6 : 500000;
    const relVol      = rnd((quote.v||avgVol)/Math.max(avgVol,1), 2);
    const base        = computeShark(quote.c, quote.dp||0, relVol, floatShares);

    const aiData = { ticker: sym, price: quote.c, changePct: quote.dp||0, relVol, floatM: rnd(floatShares/1e6,2) };
    const ai     = await callAI(SHARK_SYSTEM, SHARK_PROMPT(aiData), 600);

    if (ai) {
      // Merge AI insights into shark structure
      base.score = ai.score || base.score;
      base.regime.regime      = ai.regime || base.regime.regime;
      base.regime.detail      = ai.regimeDetail || base.regime.detail;
      base.regime.longEnabled = ai.longEnabled ?? base.regime.longEnabled;
      base.phaseVelocity.label   = ai.velocityLabel  || base.phaseVelocity.label;
      base.phaseVelocity.detail  = ai.velocityDetail || base.phaseVelocity.detail;
      base.phaseVelocity.isFastBreak = ai.isFastBreak ?? base.phaseVelocity.isFastBreak;
      base.xray.label      = ai.xrayLabel  || base.xray.label;
      base.xray.delta      = ai.xrayDelta  ?? base.xray.delta;
      base.xray.buyPressure= ai.buyPressure ?? base.xray.buyPressure;
      base.crowdHeat.label  = ai.heatLabel  || base.crowdHeat.label;
      base.crowdHeat.action = ai.heatAction || base.crowdHeat.action;
      base.aiSummary = ai.summary || null;
    }
    res.json({ symbol: sym, ...base, aiPowered: !!ai });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CHAT / ADVISOR — Cerebras-powered ───────────────────────────
const chatSessions = {};
app.post('/api/chat', async (req, res) => {
  try {
    const { message = '', sessionId = 'default', context = {} } = req.body;
    if (!chatSessions[sessionId]) chatSessions[sessionId] = [];
    chatSessions[sessionId].push({ role: 'user', content: message });

    let reply;
    if (GROQ_KEY || CEREBRAS_KEY) {
      // Primary: Groq — Backup: Cerebras
      const useGroq = !!(GROQ_KEY || GROQ_KEY_2);
      const key     = useGroq ? (GROQ_KEY || GROQ_KEY_2) : CEREBRAS_KEY;
      const url     = useGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.cerebras.ai/v1/chat/completions';
      const model   = useGroq ? 'llama-3.1-8b-instant' : 'llama3.1-8b';
      try {
        const r  = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model, max_tokens: 400, temperature: 0.4,
            messages: [{ role: 'system', content: ADVISOR_SYSTEM }, ...history]
          })
        });
        const d = await r.json();
        reply   = d?.choices?.[0]?.message?.content || null;
      } catch (_) {}
    }

    // Fallback rule-based
    if (!reply) reply = advisorFallback(message.toLowerCase());
    chatSessions[sessionId].push({ role: 'assistant', content: reply });
    res.json({ reply, sessionId });
  } catch (e) {
    res.json({ reply: 'Advisor offline — check your API keys.', sessionId: req.body.sessionId });
  }
});

app.post('/api/chat/clear', (req, res) => { delete chatSessions[req.body.sessionId]; res.json({ success: true }); });

function advisorFallback(m) {
  if (m.includes('entry')||m.includes('buy'))   return 'Phase 1-2 accumulation only. RVOL above 2x, float under 15M. No chasing.';
  if (m.includes('stop')||m.includes('loss'))   return 'Hard stop 1.5x ATR below entry. Never widen. That is your risk contract.';
  if (m.includes('target')||m.includes('exit')) return 'TP1 +2x ATR (50% off), TP2 +3.5x ATR (30% off), runner to catalyst.';
  if (m.includes('float'))                       return 'Under 5M elite. 5-15M workable. Over 15M needs extraordinary catalyst.';
  if (m.includes('whale'))                       return 'Enter Phase 1-2. Exit Phase 3. 13D + HTB + above-avg volume = footprint.';
  return 'Run a Lion Analysis on your ticker for the full institutional read.';
}

// ── LUXALGO ──────────────────────────────────────────────────────
app.post('/api/luxalgo', async (req, res) => {
  try {
    const sym = (req.body.ticker||'').toUpperCase().trim();
    const [quote, metrics] = await Promise.all([fh(`/quote?symbol=${sym}`), fh(`/stock/metric?symbol=${sym}&metric=all`)]);
    if (!quote?.c) return res.json({});
    const m      = metrics?.metric || {};
    const avgVol = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume']*1e6 : 500000;
    const relVol = rnd((quote.v||avgVol)/Math.max(avgVol,1), 2);
    res.json(computeLuxAlgo(quote.c, quote.dp||0, relVol));
  } catch (e) { res.json({}); }
});

// ── SIGNALS ──────────────────────────────────────────────────────
app.get('/api/signals', async (req, res) => {
  try {
    const news    = await fh(`/news?category=general`);
    const clean   = s => { const t=(s||'').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase(); return t||'MARKET'; };
    const signals = Array.isArray(news) ? news.filter(n=>n.headline).slice(0,10).map((n,i) => ({
      id: i, type: i<3?'MOMENTUM':i<6?'CATALYST':'EARNINGS',
      symbol: clean(n.related), name: n.source||'News', text: n.headline||'—',
      tags: [i<3?'HIGH':'MODERATE'], strength: i<3?'HIGH':'MODERATE', ts: (n.datetime||0)*1000
    })) : [];
    res.json({ signals });
  } catch (e) { res.json({ signals: [] }); }
});

// ── CATALYST ─────────────────────────────────────────────────────
app.post('/api/catalyst-scan', async (req, res) => {
  try {
    const news  = await fh(`/news?category=general`);
    const clean = s => { const t=(s||'').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase(); return t||'—'; };
    const catalysts = Array.isArray(news) ? news.filter(n=>n.headline).slice(0,15).map((n,i) => ({
      id: i, tier: i<3?1:i<8?2:3, ticker: clean(n.related), type: 'NEWS',
      headline: n.headline||'—', summary: n.summary||'', source: n.source||'—',
      url: n.url||'', ts: (n.datetime||0)*1000, score: Math.round(95-i*3)
    })) : [];
    res.json({ catalysts });
  } catch (e) { res.json({ catalysts: [] }); }
});

app.get('/api/catalyst-feed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit)||20, 40);
    const news  = await fh(`/news?category=general`);
    const clean = s => { const t=(s||'').split(',')[0].replace(/[^A-Z0-9]/gi,'').trim().toUpperCase(); return t||'—'; };
    const catalysts = Array.isArray(news) ? news.filter(n=>n.headline).slice(0,limit).map((n,i) => ({
      id: i, tier: i<3?1:i<8?2:3, ticker: clean(n.related), type: 'NEWS',
      headline: n.headline||'—', summary: n.summary||'', source: n.source||'—',
      url: n.url||'', ts: (n.datetime||0)*1000, score: Math.round(95-i*2)
    })) : [];
    res.json({ catalysts, total: catalysts.length });
  } catch (e) { res.json({ catalysts: [], total: 0 }); }
});

// ── CHART CANDLES ────────────────────────────────────────────────
app.get('/api/candles', async (req, res) => {
  try {
    const sym        = (req.query.symbol||'').toUpperCase().trim();
    const resolution = req.query.resolution || 'D';
    const now        = Math.floor(Date.now()/1000);
    const from       = now - 60*60*24*90;
    if (!sym) return res.status(400).json({ error: 'symbol required' });
    const data = await fh(`/stock/candle?symbol=${sym}&resolution=${resolution}&from=${from}&to=${now}`);
    if (!data || data.s==='no_data') return res.json({ candles: [], symbol: sym });
    const candles = (data.t||[]).map((t,i) => ({ time: t, open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i], volume: data.v[i] }));
    res.json({ candles, symbol: sym, resolution });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SQUEEZE ──────────────────────────────────────────────────────
app.post('/api/squeeze-check', async (req, res) => {
  try {
    const sym = (req.body.ticker||'').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'Ticker required' });
    const [quote, metrics] = await Promise.all([fh(`/quote?symbol=${sym}`), fh(`/stock/metric?symbol=${sym}&metric=all`)]);
    if (!quote?.c) return res.status(400).json({ error: `No data for ${sym}` });
    const m           = metrics?.metric || {};
    const price       = quote.c, changePct = quote.dp||0;
    const avgVol      = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume']*1e6 : 500000;
    const relVol      = rnd((quote.v||avgVol)/Math.max(avgVol,1), 2);
    const floatShares = (m.sharesFloat||5)*1e6;
    const shortPct    = m.shortInterestPercentOfFloat || 10;
    const phase       = shortPct>30&&relVol>2?2:shortPct>20?1:0;
    const compression = clamp(Math.round(shortPct*1.5+relVol*5), 0, 100);
    const atr         = rnd(price*0.025, 2);
    const stopCluster = rnd(price*0.95, 2);
    const t1Target    = rnd(price*1.15, 2);
    const t2Target    = rnd(price*1.30, 2);
    res.json({
      symbol: sym, price, shortPct, relVol, floatShares, atr,
      phase:       { phase, color: phase>=2?'#22c55e':phase===1?'#f0b429':'#243548', intensity: compression },
      painPct: changePct, stopCluster, t1Target, t2Target,
      squeezeProb: clamp(Math.round(shortPct*1.2+relVol*5), 0, 95),
      riskReward:  rnd((t1Target-price)/(price-stopCluster), 2),
      coil: { isCoiled: compression>60&&relVol<1.5, compression, atrTightness: Math.round(50+relVol*5), rvol: relVol, orderBlockLow: rnd(price*0.97,2), orderBlockHigh: rnd(price*1.01,2), triggerPrice: rnd(price*1.02,2), advice: 'Wait for RVOL above 2x then enter on 1-min close above trigger.' },
      lux:     computeLuxAlgo(price, changePct, relVol).daily,
      mmr:     computeMMR(price, relVol, floatShares, changePct),
      levels:  { stop: stopCluster, tp1: t1Target, tp2: t2Target },
      dilution:{ detected: false }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/squeeze-scan', (req, res) => res.json({ squeezes: [], message: 'Squeeze scan requires real-time short interest feed.' }));

// ── PROBABILITY ──────────────────────────────────────────────────
app.post('/api/probability', async (req, res) => {
  try {
    const { ticker, entry, stop, target, account=1000 } = req.body;
    if (!entry||!stop||!target) return res.status(400).json({ error: 'entry, stop, and target required' });
    const rr      = rnd((target-entry)/(entry-stop), 2);
    const winRate = clamp(0.4+rr*0.05, 0.25, 0.65);
    const ev      = rnd(winRate*(target-entry)-(1-winRate)*(entry-stop), 3);
    const kelly   = rnd(Math.max(0,winRate-(1-winRate)/rr)*100, 1);
    let currentPrice = null;
    if (ticker) { try { const q=await fh(`/quote?symbol=${ticker.toUpperCase()}`); currentPrice=q.c||null; } catch(_){} }
    res.json({ ticker: ticker?ticker.toUpperCase():null, entry, stop, target, rr, winRate: rnd(winRate*100,1), expectedValue: ev, kelly, maxShares: entry>stop?Math.floor(account*0.02/(entry-stop)):0, verdict: ev>0&&rr>1.5?'FAVORABLE':ev>0?'MARGINAL':'DO NOT TAKE', currentPrice });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SHADOW SCORE (JSONBin-backed) ────────────────────────────────
app.get('/api/shadow-score', async (req, res) => {
  try {
    const store = await jbinGet();
    res.json({ score: store.shadowScore||'0.00', savings: store.savings||0, trades: store.trades||0 });
  } catch (e) { res.json({ score: '0.00', savings: 0, trades: 0 }); }
});

// ── BACKTEST (JSONBin-backed) ────────────────────────────────────
app.get('/api/backtest', async (req, res) => {
  try {
    const store = await jbinGet();
    res.json(store.backtest || { trades: [], winRate: 0, avgRR: 0, totalPL: 0 });
  } catch (e) { res.json({ trades: [], winRate: 0, avgRR: 0, totalPL: 0 }); }
});

// ── STUBS ────────────────────────────────────────────────────────
app.post('/api/supernova',   (req,res)=>res.json({candidates:[],message:'Supernova scan requires real-time feed.'}));
app.post('/api/whale-scan',  (req,res)=>res.json({whales:[],message:'Whale scan monitoring dark pool activity.'}));
app.get ('/api/movers',      (req,res)=>res.json({gainers:[],losers:[],message:'Movers require premium Finnhub.'}));

// ── ALERT ────────────────────────────────────────────────────────
app.post('/api/alert', async (req, res) => {
  try {
    const { symbol, condition, value } = req.body;
    if (TG_TOKEN && TG_CHAT) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id: TG_CHAT, text: `⚡ MAVERICK ALERT\n${symbol} — ${condition} $${value}`, parse_mode:'HTML' })
      });
    }
    res.json({ success: true, message: `Alert set: ${symbol} ${condition} $${value}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FRONTEND ─────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nMAVERICK COCKPIT ONLINE — port ${PORT}`);
  console.log(`  Groq AI (primary):      ${GROQ_KEY     ? '✅ connected' : '❌ MISSING'}`);
  console.log(`  Cerebras AI (backup):   ${CEREBRAS_KEY ? '✅ connected' : '⚠️  not set'}`);
  console.log(`  Finnhub:                ${FINNHUB      ? '✅ connected' : '❌ MISSING'}`);
  console.log(`  Telegram:               ${TG_TOKEN&&TG_CHAT ? '✅ connected' : '❌ MISSING'}`);
  console.log(`  JSONBin:                ${JBIN_BIN&&JBIN_KEY ? '✅ connected' : '⚠️  not set'}`);
  console.log('');

  if (CEREBRAS_KEY || GROQ_KEY) {
    try { require('./cerebras-bot'); console.log('  Intel Bot:    ✅ launched'); }
    catch (e) { console.error('  Intel Bot:    ❌', e.message); }
  }
});
