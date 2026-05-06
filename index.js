// ═══════════════════════════════════════════════════════════════════════════
// MAVERICK TERMINAL v3.2
// Finnhub primary data · Chart display · Overnight news scanner
// Interactive catalyst flow · Pattern memory · Full trade bot
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

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
let bot = null;
if (TELEGRAM_TOKEN) {
  try {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { interval: 2000, timeout: 10 } });
    console.log('✅ Telegram started');
  } catch (e) { console.error('TG init:', e.message); }
}
function tgSend(chatId, text) {
  if (!bot || !chatId) return;
  bot.sendMessage(String(chatId), text, { parse_mode: 'Markdown' })
    .catch(e => console.error('TG:', e.message));
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const watches          = new Map(); // chatId → watch
const trades           = new Map(); // chatId → trade
const priceAlerts      = new Map(); // symbol → [alerts]
const subscribers      = new Map(); // symbol → Set<chatId>
const volTracker       = new Map();
const tvSignals        = new Map();
const pendingCatalysts = new Map(); // chatId → catalyst awaiting user response

// ── FINNHUB WEBSOCKET ─────────────────────────────────────────────────────────
let ws;
function connectFinnhub() {
  if (!FINNHUB_KEY) return;
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => {
    console.log('✅ Finnhub WS');
    for (const s of subscribers.keys()) ws.send(JSON.stringify({ type:'subscribe', symbol:s }));
  });
  ws.on('message', raw => {
    try { const m=JSON.parse(raw); if(m.type==='trade'&&Array.isArray(m.data)) m.data.forEach(t=>onTick(t.s,t.p,t.v)); } catch {}
  });
  ws.on('close', () => setTimeout(connectFinnhub, 5000));
  ws.on('error', e => console.error('WS:', e.message));
}
function wsSend(s,a){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:a,symbol:s}));}
function addSub(s,id){if(!subscribers.has(s))subscribers.set(s,new Set());if(!subscribers.get(s).size)wsSend(s,'subscribe');subscribers.get(s).add(id);}
function removeSub(s,id){const x=subscribers.get(s);if(!x)return;x.delete(id);if(!x.size){subscribers.delete(s);wsSend(s,'unsubscribe');}}

// ═══════════════════════════════════════════════════════════════════════════
// DATA LAYER — Finnhub primary, Yahoo fallback
// ═══════════════════════════════════════════════════════════════════════════

// PRIMARY: Finnhub quote + company profile
async function getQuote(symbol) {
  const sym = symbol.toUpperCase();

  // ── Finnhub (primary — confirmed working on Render) ──
  if (FINNHUB_KEY) {
    try {
      const [qr, pr] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`),
        fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${FINNHUB_KEY}`),
      ]);
      const q = await qr.json();
      const p = await pr.json();
      if (q && q.c && q.c > 0) {
        const change = q.c - q.pc;
        const changePct = q.pc ? (change / q.pc) * 100 : 0;
        return {
          price: q.c, change, changePct,
          open: q.o, high: q.h, low: q.l, prevClose: q.pc,
          volume: null, avgVolume: null,
          marketCap: p?.marketCapitalization ? p.marketCapitalization * 1e6 : null,
          floatShares: p?.shareOutstanding ? p.shareOutstanding * 1e6 : null,
          sharesOut: p?.shareOutstanding ? p.shareOutstanding * 1e6 : null,
          yearHigh: null, yearLow: null,
          sector: p?.finnhubIndustry || null,
          industry: p?.finnhubIndustry || null,
          shortName: p?.name || sym,
          country: p?.country || null,
          ipo: p?.ipo || null,
          source: 'finnhub',
        };
      }
    } catch(e) { console.error('Finnhub quote:', e.message); }
  }

  // ── Yahoo fallback ──
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`,
      { headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept':'application/json', 'Referer':'https://finance.yahoo.com/', 'Accept-Language':'en-US,en;q=0.9' }}
    );
    const d = await r.json();
    const q = d?.quoteResponse?.result?.[0];
    if (q?.regularMarketPrice) {
      return {
        price:q.regularMarketPrice, change:q.regularMarketChange, changePct:q.regularMarketChangePercent,
        open:q.regularMarketOpen, high:q.regularMarketDayHigh, low:q.regularMarketDayLow, prevClose:q.regularMarketPreviousClose,
        volume:q.regularMarketVolume, avgVolume:q.averageDailyVolume3Month,
        marketCap:q.marketCap, floatShares:q.floatShares, sharesOut:q.sharesOutstanding,
        pe:q.trailingPE, yearHigh:q.fiftyTwoWeekHigh, yearLow:q.fiftyTwoWeekLow,
        sector:q.sector, industry:q.industry, shortName:q.shortName,
        preMarket:q.preMarketPrice, preMarketChangePct:q.preMarketChangePercent,
        source: 'yahoo',
      };
    }
  } catch(e) { console.error('Yahoo fallback:', e.message); }

  return null;
}

// Multi-timeframe candle data from Yahoo (historical — less blocked)
async function getCandles(symbol, range, interval) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`,
      { headers: { 'User-Agent':'Mozilla/5.0', 'Referer':'https://finance.yahoo.com/' }}
    );
    const d = await r.json();
    const res = d?.chart?.result?.[0]; if (!res) return null;
    const q = res.indicators?.quote?.[0]; const ts = res.timestamp || [];
    if (!q || !ts.length) return null;
    const candles = ts.map((t,i) => ({ t, o:q.open?.[i], h:q.high?.[i], l:q.low?.[i], c:q.close?.[i], v:q.volume?.[i] })).filter(c => c.c != null);
    if (!candles.length) return null;
    const closes = candles.map(c=>c.c); const last=closes[closes.length-1]; const first=closes[0];
    const high=Math.max(...candles.map(c=>c.h)); const low=Math.min(...candles.map(c=>c.l));
    const avgVol=candles.reduce((s,c)=>s+(c.v||0),0)/candles.length;
    const lastVol=candles[candles.length-1]?.v||0;
    const ema9=closes.reduce((e,c,i)=>i===0?c:c*(2/10)+e*(8/10),closes[0]);
    const gains=[],losses=[];
    for(let i=1;i<Math.min(closes.length,15);i++){const df=closes[i]-closes[i-1];df>0?gains.push(df):losses.push(Math.abs(df));}
    const ag=gains.reduce((s,v)=>s+v,0)/(gains.length||1);
    const al=losses.reduce((s,v)=>s+v,0)/(losses.length||1);
    const rsi=al===0?100:100-(100/(1+ag/al));
    const mid=closes[Math.floor(closes.length/2)];
    const trend=last>mid?'UP':'DOWN';
    const atr=candles.slice(-14).reduce((s,c)=>s+(c.h-c.l),0)/Math.min(14,candles.length);
    return { range, interval, pctChange:+((last-first)/first*100).toFixed(2), trend, high, low, last, ema9:+ema9.toFixed(3), rsi:+rsi.toFixed(1), relVolume:+(lastVol/avgVol).toFixed(2), atr:+atr.toFixed(3), candleCount:candles.length };
  } catch(e) { console.error(`Candles ${range}/${interval}:`, e.message); return null; }
}

// Finnhub news
async function getNews(symbol) {
  if (!FINNHUB_KEY) return [];
  try {
    const to=new Date().toISOString().split('T')[0];
    const from=new Date(Date.now()-7*86400000).toISOString().split('T')[0];
    const r=await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d=await r.json();
    return Array.isArray(d) ? d.slice(0,5).map(n=>({ headline:n.headline, source:n.source, url:n.url, datetime:n.datetime })) : [];
  } catch { return []; }
}

// General market news for catalyst scanner
async function getMarketNews() {
  if (!FINNHUB_KEY) return [];
  try {
    const r=await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`);
    const d=await r.json();
    return Array.isArray(d) ? d.slice(0,30).map(n=>({ headline:n.headline, source:n.source, url:n.url, datetime:n.datetime, related:n.related })) : [];
  } catch { return []; }
}

// SEC EDGAR 8-K RSS — catches deal announcements before anyone else
async function getSEC8K() {
  try {
    const r=await fetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=20&search_text=&output=atom', {
      headers:{ 'User-Agent':'MaverickBot/1.0 contact@maverick.com', 'Accept':'application/xml' }
    });
    const text=await r.text();
    const items=[];
    const regex=/<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while((m=regex.exec(text))!==null) {
      const entry=m[1];
      const title=(/<title>(.*?)<\/title>/.exec(entry)||[])[1]||'';
      const link=(/<link.*?href="(.*?)"/.exec(entry)||[])[1]||'';
      const updated=(/<updated>(.*?)<\/updated>/.exec(entry)||[])[1]||'';
      items.push({ headline:title, source:'SEC-EDGAR-8K', url:link, datetime:new Date(updated).getTime()/1000 });
    }
    return items.slice(0,15);
  } catch(e) { console.error('SEC 8K:', e.message); return []; }
}

// Chart URL generator (Finviz free chart embed — no auth needed)
function getChartUrl(symbol, timeframe='5min') {
  const tfMap = { '5min':'i5', '15min':'i15', '1hour':'h', 'daily':'d', 'weekly':'w' };
  const p = tfMap[timeframe] || 'i5';
  return `https://finviz.com/chart.ashx?t=${symbol.toUpperCase()}&ty=c&ta=1&p=${p}&s=l`;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE MATH
// ═══════════════════════════════════════════════════════════════════════════
function calcLevels(entry, atr) {
  const stopDist = atr ? atr*1.5 : entry*(entry<5?0.035:entry<15?0.028:0.02);
  const stop=+(entry-stopDist).toFixed(2); const risk=entry-stop;
  return { stop, t1:+(entry+risk*2).toFixed(2), t2:+(entry+risk*3.5).toFixed(2), t3:+(entry+risk*5.5).toFixed(2), risk:+risk.toFixed(2) };
}
function totalShares(tr){return tr.shares+tr.adds.reduce((s,a)=>s+a.shares,0);}
function avgCostCalc(tr){return+((tr.entryPrice*tr.shares+tr.adds.reduce((s,a)=>s+a.price*a.shares,0))/totalShares(tr)).toFixed(2);}
function totalPnl(tr,p){return+((p-tr.entryPrice)*tr.shares+tr.adds.reduce((s,a)=>s+(p-a.price)*a.shares,0)).toFixed(2);}

// ═══════════════════════════════════════════════════════════════════════════
// TICK HANDLER
// ═══════════════════════════════════════════════════════════════════════════
function onTick(sym, price, vol) {
  if(!volTracker.has(sym))volTracker.set(sym,{v1m:0,reset:Date.now()});
  const vt=volTracker.get(sym);
  if(Date.now()-vt.reset>60000){vt.v1m=0;vt.reset=Date.now();} vt.v1m+=vol;

  // Watches — entry confirmation
  for(const[cid,w]of watches){
    if(w.symbol!==sym||w.confirmed)continue; w.currentPrice=price;
    if(price>=w.entryLevel){
      const apr=w.avgVolume?w.avgVolume/390:null; const vr=apr?vt.v1m/apr:99;
      if(vr>=1.5){w.confirmed=true; const lv=calcLevels(price,null);
        tgSend(cid,`🔥 *ENTRY CONFIRMED — ${sym}*\n\n$${price.toFixed(2)} | Vol: *${vr.toFixed(1)}x avg*\n\n🛑 Stop: *$${lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n\nText: _in at ${price.toFixed(2)} with 200 shares_`);}
    }
  }

  // Price alerts (TradingView Pro replacement)
  const alerts=priceAlerts.get(sym)||[];
  for(const a of alerts){
    if(a.fired)continue;
    const hit=(a.condition==='ABOVE'&&price>=a.value)||(a.condition==='BELOW'&&price<=a.value)||(a.condition==='CROSS'&&Math.abs(price-a.value)/a.value<0.005);
    if(hit){a.fired=true; const apr=a.avgVolume?a.avgVolume/390:null; const vr=apr?vt.v1m/apr:0;
      const e=a.condition==='ABOVE'?'🚀':a.condition==='BELOW'?'🔻':'⚡';
      tgSend(a.chatId,`${e} *MAVERICK ALERT — ${sym}*\n\n$${price.toFixed(2)} ${a.condition} $${a.value}\nVol: ${vr>0?vr.toFixed(1)+'x':'monitoring'}\n\nText: _watching ${sym} at ${price.toFixed(2)}_`);}
  }

  // Active trades
  for(const[cid,tr]of trades){
    if(tr.symbol!==sym)continue;
    const prev=tr.currentPrice||tr.entryPrice; tr.currentPrice=price;
    const mins=(Date.now()-tr.entryTime)/60000; const pnl=totalPnl(tr,price);
    const apr=tr.avgVolume?tr.avgVolume/390:null; const vr=apr?vt.v1m/apr:0;
    if(price>tr.hwm){tr.hwm=price;if(tr.t1Hit){const trail=+(price-(price-tr.avgCost)*0.40).toFixed(2);if(trail>tr.trailingStop)tr.trailingStop=trail;}}
    if(!tr.stopAlerted&&price<=tr.stopLoss){tr.stopAlerted=true;tgSend(cid,`🚨 *STOP HIT — ${tr.symbol}*\n$${price.toFixed(2)}\nP&L: -$${Math.abs(pnl).toFixed(2)}\n\n❌ *EXIT NOW.* Text: _out at ${price.toFixed(2)}_`);}
    if(tr.t1Hit&&!tr.trailAlerted&&price<=tr.trailingStop){tr.trailAlerted=true;tgSend(cid,`⚠️ *TRAIL STOP — ${tr.symbol}*\n$${price.toFixed(2)} | Locked: +$${pnl.toFixed(2)}\nText: _out at ${price.toFixed(2)}_`);}
    if(!tr.t1Hit&&price>=tr.targets.t1){tr.t1Hit=true;tr.stopLoss=tr.avgCost;tr.stopAlerted=false;tr.trailAlerted=false;tgSend(cid,`🎯 *TARGET 1 — ${tr.symbol}*\n$${price.toFixed(2)}\n+$${totalPnl(tr,tr.targets.t1).toFixed(2)}\n\n✅ Sell 50%\n🔄 Stop → BREAKEVEN $${tr.avgCost}\n🎯 Next: $${tr.targets.t2}`);}
    if(!tr.t2Hit&&price>=tr.targets.t2){tr.t2Hit=true;tgSend(cid,`🎯🎯 *TARGET 2 — ${tr.symbol}*\n+$${totalPnl(tr,tr.targets.t2).toFixed(2)}\nSell rest or hold to T3: $${tr.targets.t3}`);}
    if(!tr.addSent&&tr.t1Hit&&!tr.t2Hit){const pg=((price-tr.avgCost)/tr.avgCost)*100;if(pg>4&&vr>2&&price>prev*0.995){tr.addSent=true;tgSend(cid,`📈 *ADD SIGNAL — ${tr.symbol}*\nVol: ${vr.toFixed(1)}x | +${pg.toFixed(1)}%\nText: _added 100 at ${price.toFixed(2)}_`);}}
    if(!tr.warn45&&mins>=45){tr.warn45=true;tgSend(cid,`⏱ *45-MIN — ${tr.symbol}*\n${mins.toFixed(0)}min | ${pnl>=0?'+':''}$${pnl.toFixed(2)}\n${!tr.t1Hit?'⚠️ T1 not hit — re-evaluate.':'✅ T1 hit — consider exit.'}`);}
    if(!tr.warn90&&mins>=90){tr.warn90=true;tgSend(cid,`🚨 *90-MIN — ${tr.symbol}*\nMomentum done. *Consider exit.*\nText: _out at ${price.toFixed(2)}_`);}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY (JSONBin)
// ═══════════════════════════════════════════════════════════════════════════
async function memLoad(){
  if(!JSONBIN_KEY||!JSONBIN_BIN)return{trades:[],scans:[]};
  try{const r=await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`,{headers:{'X-Master-Key':JSONBIN_KEY}});const d=await r.json();return d.record||{trades:[],scans:[]};}
  catch{return{trades:[],scans:[]};}
}
async function memSave(rec){
  if(!JSONBIN_KEY||!JSONBIN_BIN)return;
  try{await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},body:JSON.stringify(rec)});}catch{}
}
async function logTrade(entry){const m=await memLoad();m.trades=m.trades||[];m.trades.push({...entry,id:Date.now()});await memSave(m);}

// ═══════════════════════════════════════════════════════════════════════════
// AI BRAIN (Groq Llama 3.3 70B)
// ═══════════════════════════════════════════════════════════════════════════
async function groqCall(system, user, maxTokens=1500) {
  if(!GROQ_KEY)return null;
  try{
    const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${GROQ_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:maxTokens,temperature:0.25,messages:[{role:'system',content:system},{role:'user',content:user}]})});
    const d=await r.json(); const text=d.choices?.[0]?.message?.content||'';
    const m=text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim().match(/\{[\s\S]*\}/);
    return m?JSON.parse(m[0]):null;
  }catch(e){console.error('Groq:',e.message);return null;}
}

const ANALYZE_PROMPT=`You are MAVERICK — aggressive, decisive day trading AI for an institutional-grade analyst.

You receive: live quote (Finnhub), multi-timeframe OHLCV candles with EMA9/RSI/ATR (daily/4H/1H/15min), recent news, chart pattern URL.

TIMEFRAME ANALYSIS — use ALL timeframes:
Daily: overall trend + key S/R levels + 52-week position
4H: intermediate trend confirmation + EMA relationship
1H: entry timing window + momentum state
15min: precise entry pattern + volume profile

VERDICT (ONE only): BUY | DONT_BUY | WATCH

ENTRY MATH — ATR-based mandatory:
- Stop = 1.5×ATR below entry (or swing low — whichever is tighter)
- T1 = entry + 2×(entry-stop) [2:1 minimum]
- T2 = entry + 3.5×(entry-stop)
- T3 = entry + 5.5×(entry-stop)
- If ATR unavailable: 3.5% sub-$5, 2.5% $5-$15, 2% above $15

CHART PATTERNS to identify: Gap & Go, VWAP Reclaim, ORB, Momentum Pullback, Supernova Ignition, Bull Flag, Parabolic Extension

TRADER: AGGRESSIVE. Sub-$10 specialist. Tight stops. Hard rules. 3:1+ R:R required for BUY.

RETURN ONLY VALID JSON — no markdown, no explanation outside JSON:
{"verdict":"BUY|DONT_BUY|WATCH","conviction":0-100,"headline":"one decisive aggressive sentence","chart_pattern":"identified pattern name","timeframe_alignment":"BULLISH|BEARISH|MIXED|NEUTRAL","reasoning":["specific data-point bullet 1","specific data-point bullet 2","specific data-point bullet 3"],"entry_zone":{"low":0.00,"high":0.00},"stop_loss":0.00,"target_1":0.00,"target_2":0.00,"target_3":0.00,"risk_reward":0.0,"position_size_suggestion":"AGGRESSIVE|STANDARD|SMALL","trade_type":"DAY_TRADE|SWING|SCALP|OVERNIGHT","key_risk":"specific risk with numbers","trigger_to_watch":"exact condition if WATCH","time_horizon":"estimate","atrial_notes":"any unusual data or flags"}`;

const CATALYST_PROMPT=`You are MAVERICK Catalyst Intelligence. You scan financial news for HIGH CONVICTION trading catalysts — specifically those with 85%+ probability of causing upward price action.

CATALYST SCORING (0-100):
- FDA approval/clearance: 95pts
- Merger/acquisition at premium: 93pts  
- Government contract (>2x market cap): 92pts
- Oversubscribed institutional placement: 88pts
- Earnings massive beat (>30% above estimate): 87pts
- Partnership with Fortune 500: 82pts
- Nasdaq compliance regained: 78pts
- Sector sympathy (leader up 30%+): 72pts
- CEO/insider buying: 65pts
- Analyst upgrade: 55pts

SIXTH GRADE TEST: Would a 12-year-old immediately understand the bullish direction?

HARD FILTERS — only return if ALL true:
- Catalyst score >= 80
- US-listed company (NYSE/NASDAQ/OTC)
- Actionable today or pre-market
- Not already run 100%+ (entry window still open)

RETURN ONLY VALID JSON:
{"catalysts":[{"ticker":"","company_name":"","catalyst_headline":"","catalyst_type":"FDA|MERGER|CONTRACT|PLACEMENT|EARNINGS|PARTNERSHIP|OTHER","catalyst_score":0,"sixth_grade_trade":true,"sixth_grade_explanation":"plain English in one sentence","price_impact_probability":0,"estimated_move_pct":"X-Y%","time_sensitivity":"PRE-MARKET|TODAY|THIS_WEEK","entry_still_open":true,"source":"","news_age_hours":0}]}

Return empty array if nothing qualifies. Quality over quantity — only return highest conviction.`;

// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT NEWS CATALYST SCANNER
// ═══════════════════════════════════════════════════════════════════════════
let lastCatalystScan = 0;
const scannedHeadlines = new Set(); // prevents duplicate alerts

async function runCatalystScan(manual=false) {
  if (!GROQ_KEY || !TG_CHAT_ID) return;
  const now = Date.now();
  if (!manual && now - lastCatalystScan < 28*60*1000) return; // 28-min cooldown
  lastCatalystScan = now;

  console.log('🔍 Running catalyst scan...');
  try {
    const [marketNews, secFilings] = await Promise.all([ getMarketNews(), getSEC8K() ]);
    const allNews = [...marketNews, ...secFilings]
      .filter(n => n.headline && !scannedHeadlines.has(n.headline))
      .slice(0, 40);

    if (!allNews.length) return;

    // Check age — pre-market focus (0-8 hours old)
    const recentNews = allNews.filter(n => {
      const ageHours = (Date.now()/1000 - (n.datetime||0)) / 3600;
      return ageHours < 12; // within 12 hours
    });

    if (!recentNews.length) { console.log('No recent news to scan'); return; }

    const newsText = recentNews.map(n => `SOURCE: ${n.source}\nHEADLINE: ${n.headline}\nAGE: ${((Date.now()/1000-(n.datetime||0))/3600).toFixed(1)}h ago`).join('\n\n');

    const result = await groqCall(CATALYST_PROMPT, `Scan these news items for high-conviction catalysts:\n\n${newsText}\n\nReturn ONLY JSON.`, 2000);

    if (!result?.catalysts?.length) { console.log('No qualifying catalysts found'); return; }

    // Alert for each qualifying catalyst
    for (const c of result.catalysts) {
      if (scannedHeadlines.has(c.catalyst_headline)) continue;
      scannedHeadlines.add(c.catalyst_headline);

      const emoji = c.catalyst_score >= 90 ? '🚨🚨' : c.catalyst_score >= 85 ? '🚨' : '⚡';
      const msg = `${emoji} *HIGH CONVICTION CATALYST DETECTED*\n\n` +
        `*${c.ticker || 'UNCONFIRMED'}* — ${c.company_name || ''}\n\n` +
        `📰 ${c.catalyst_headline}\n\n` +
        `🎯 Catalyst Score: *${c.catalyst_score}/100*\n` +
        `📈 Price Impact Probability: *${c.price_impact_probability}%*\n` +
        `🚀 Estimated Move: *${c.estimated_move_pct}*\n` +
        `⏰ Time Sensitivity: *${c.time_sensitivity}*\n` +
        `📚 6th Grade: ${c.sixth_grade_trade ? '✅ '+c.sixth_grade_explanation : '❌'}\n\n` +
        `*Reply with:*\n` +
        `_DIVE ${c.ticker||'TICKER'}_ — full AI analysis + trade plan\n` +
        `_WATCH ${c.ticker||'TICKER'}_ — activate live monitoring\n` +
        `_SKIP_ — dismiss`;

      // Store catalyst awaiting user response
      pendingCatalysts.set(TG_CHAT_ID, c);
      tgSend(TG_CHAT_ID, msg);
    }
  } catch(e) { console.error('Catalyst scan error:', e.message); }
}

// Schedule catalyst scans
function scheduleCatalystScans() {
  // Run every 30 minutes
  setInterval(() => runCatalystScan(false), 30*60*1000);

  // Also check market hours and run at key times
  setInterval(() => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US',{timeZone:'America/New_York'}));
    const h = et.getHours(); const m = et.getMinutes();
    const isWeekday = et.getDay()>0 && et.getDay()<6;
    if (!isWeekday) return;
    // Key scan times: 4:00am, 6:00am, 8:00am ET
    if ((h===4||h===6||h===8) && m<3) runCatalystScan(false);
  }, 60*1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Main analyzer — multi-timeframe + chart
app.post('/api/analyze', async (req,res) => {
  const {ticker} = req.body; if(!ticker) return res.status(400).json({error:'no ticker'});
  const sym = ticker.toUpperCase().trim();
  try {
    const [quote, tf1d, tf4h, tf1h, tf15, news] = await Promise.all([
      getQuote(sym),
      getCandles(sym,'3mo','1d'),
      getCandles(sym,'1mo','60m'),
      getCandles(sym,'5d','60m'),
      getCandles(sym,'2d','15m'),
      getNews(sym),
    ]);
    if (!quote) return res.status(404).json({error:`${sym} not found — check ticker symbol`});

    // ATR from daily candle data
    const atr = tf1d?.atr || null;

    const payload = {
      ticker: sym,
      quote: { price:quote.price, changePct:quote.changePct, open:quote.open, high:quote.high, low:quote.low, volume:quote.volume, marketCap:quote.marketCap, floatShares:quote.floatShares, yearHigh:quote.yearHigh, yearLow:quote.yearLow, sector:quote.sector, shortName:quote.shortName, dataSource:quote.source },
      timeframes: { daily:tf1d||'unavailable', fourhour:tf4h||'unavailable', onehour:tf1h||'unavailable', fifteen:tf15||'unavailable' },
      recent_news: news.slice(0,3).map(n=>n.headline),
      chart_url_5min: getChartUrl(sym,'5min'),
      chart_url_daily: getChartUrl(sym,'daily'),
    };

    const verdict = await groqCall(ANALYZE_PROMPT, JSON.stringify(payload));
    if (!verdict) return res.status(503).json({error:'AI unavailable. Check GROQ_KEY in Render env vars.'});

    res.json({
      ticker: sym,
      verdict,
      chartUrl5min: getChartUrl(sym,'5min'),
      chartUrlDaily: getChartUrl(sym,'daily'),
      data: { quote, timeframes:{daily:tf1d,fourhour:tf4h,onehour:tf1h,fifteen:tf15}, news, atr },
      timestamp: new Date().toISOString(),
    });
  } catch(e) { console.error('Analyze:', e); res.status(500).json({error:e.message}); }
});

// Live quote (for auto-refresh)
app.get('/api/quote/:symbol', async (req,res) => {
  const q=await getQuote(req.params.symbol.toUpperCase());
  if(!q)return res.status(404).json({error:'not found'});
  res.json(q);
});

// Manual catalyst scan trigger
app.post('/api/catalyst-scan', async (req,res) => {
  runCatalystScan(true);
  res.json({ok:true, message:'Catalyst scan running — alerts sent to Telegram if found'});
});

// Set price alert
app.post('/api/alert', (req,res) => {
  const{symbol,condition,value,chatId}=req.body;
  if(!symbol||!condition||!value)return res.status(400).json({error:'missing fields'});
  const sym=symbol.toUpperCase();
  if(!priceAlerts.has(sym))priceAlerts.set(sym,[]);
  priceAlerts.get(sym).push({chatId:chatId||TG_CHAT_ID,condition,value:+value,fired:false,avgVolume:null});
  addSub(sym,chatId||TG_CHAT_ID);
  res.json({ok:true,symbol:sym,condition,value:+value});
});

// TradingView webhook
app.post('/webhook/tradingview',(req,res)=>{
  if((req.query.secret||req.body.secret)!==WEBHOOK_SECRET)return res.status(401).json({error:'unauthorized'});
  const{ticker,action,indicator,price}=req.body;
  if(!ticker||!action)return res.status(400).json({error:'missing ticker or action'});
  const sym=ticker.toUpperCase();
  tvSignals.set(sym,{action:action.toUpperCase(),indicator:indicator||'TradingView',price:parseFloat(price)||null,time:Date.now()});
  if(TG_CHAT_ID&&bot)tgSend(TG_CHAT_ID,`📡 *TV SIGNAL — ${sym}*\n${action.toUpperCase()} via ${indicator||'TV'} at $${price||'?'}`);
  res.json({ok:true});
});

// Supernova scanner
app.post('/api/supernova', async(req,res)=>{
  if(!GROQ_KEY)return res.status(500).json({error:'GROQ_KEY missing'});
  try{
    let movers=[];
    try{
      const r=await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=30&scrIds=day_gainers',{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://finance.yahoo.com/'}});
      const d=await r.json();
      movers=(d?.finance?.result?.[0]?.quotes||[]).slice(0,25).map(q=>({symbol:q.symbol,name:q.shortName,price:q.regularMarketPrice,changePct:q.regularMarketChangePercent,volume:q.regularMarketVolume,avgVolume:q.averageDailyVolume3Month,relVolume:+(q.regularMarketVolume/(q.averageDailyVolume3Month||1)).toFixed(1),marketCap:q.marketCap,float:q.floatShares})).filter(s=>s.price&&s.price<25);
    }catch{}

    const NOVA=`You are Maverick Supernova Detection. Analyze movers for true supernova events.
SUPERNOVA = catalyst-driven where: A) 60+ min sustained buying B) Fade setup C) Sixth Grade Trade
Score 0-100: Catalyst(30),Float(25),Velocity(20),Pillars(15),SGT(10). Tiers: SUPERNOVA(85+),IGNITING(70+),WARMING(55+).
RETURN ONLY VALID JSON:
{"scan_time":"ISO","market_session":"string","market_pulse":"2 sentences","supernovas":[{"ticker":"","company":"","price":0,"price_change_pct":0,"float_millions":0,"catalyst":"","catalyst_type":"","halted_today":false,"trade_type":"LONG|FADE","phase":"IGNITION|FUEL_BURN|DISTRIBUTION","is_sixth_grade_trade":true,"sixth_grade_explanation":"","pillars_firing":[],"supernova_score":0,"tier":"SUPERNOVA|IGNITING|WARMING","entry_zone":"$X-$Y","stop":0,"target_1":0,"target_2":0,"risk_reward":0,"thesis":"","exit_signal":""}],"algo_note":""}`;
    const verdict=await groqCall(NOVA,`Today's movers:\n${JSON.stringify(movers,null,2)}\nDate:${new Date().toLocaleString()}\nReturn ONLY JSON.`,4000);
    if(!verdict)return res.status(500).json({error:'AI returned no JSON'});
    res.json(verdict);
  }catch(e){res.status(500).json({error:e.message});}
});

// Health
app.get('/api/health',(req,res)=>{
  res.json({status:'online',version:'3.2',time:new Date().toISOString(),services:{telegram:!!TELEGRAM_TOKEN,finnhub:!!FINNHUB_KEY,groq:!!GROQ_KEY,memory:!!(JSONBIN_KEY&&JSONBIN_BIN)},active:{watches:watches.size,trades:trades.size,alerts:[...priceAlerts.values()].flat().filter(a=>!a.fired).length,tvSignals:tvSignals.size,pendingCatalysts:pendingCatalysts.size}});
});

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
function parseTg(text) {
  const t=text.trim(); let m;
  m=t.match(/^watch(?:ing)?\s+([A-Za-z.]{1,6})\s+(?:at|for)?\s*\$?(\d+\.?\d*)(?:\s+stop\s*\$?(\d+\.?\d*))?/i);
  if(m)return{cmd:'watch',symbol:m[1].toUpperCase(),price:+m[2],stop:m[3]?+m[3]:null};
  m=t.match(/^in\b.*?\$?(\d+\.?\d*)\D+(\d+)/i); if(m)return{cmd:'in',price:+m[1],shares:+m[2]};
  m=t.match(/^out\b.*?\$?(\d+\.?\d*)/i); if(m)return{cmd:'out',price:+m[1]};
  m=t.match(/^add(?:ed)?\s+(\d+)[^$\d]*\$?(\d+\.?\d*)/i); if(m)return{cmd:'add',shares:+m[1],price:+m[2]};
  m=t.match(/^(?:sl|stop)\s+\$?(\d+\.?\d*)/i); if(m)return{cmd:'sl',price:+m[1]};
  m=t.match(/^alert\s+([A-Za-z.]{1,6})\s+(above|below|cross)\s+\$?(\d+\.?\d*)/i);
  if(m)return{cmd:'alert',symbol:m[1].toUpperCase(),condition:m[2].toUpperCase(),value:+m[3]};
  m=t.match(/^dive\s+([A-Za-z.]{1,6})/i); if(m)return{cmd:'dive',symbol:m[1].toUpperCase()};
  m=t.match(/^scan\s+([A-Za-z.]{1,6})/i); if(m)return{cmd:'dive',symbol:m[1].toUpperCase()};
  m=t.match(/^([A-Z.]{1,6})$/); if(m)return{cmd:'quote',symbol:m[1]};
  if(/^skip$/i.test(t))return{cmd:'skip'};
  if(/^news$/i.test(t)||/^catalyst/i.test(t))return{cmd:'news'};
  if(/^(status|p&l|pnl)/i.test(t))return{cmd:'status'};
  if(/^(cancel|clear|reset)/i.test(t))return{cmd:'cancel'};
  if(/^(daily|today)/i.test(t))return{cmd:'daily'};
  if(/^(weekly|this week)/i.test(t))return{cmd:'weekly'};
  if(/^(analyze|review your trades|my trades)/i.test(t))return{cmd:'tradeReview'};
  if(/^help$/i.test(t))return{cmd:'help'};
  return null;
}

if (bot) {
  bot.on('message', async msg => {
    const cid=msg.chat.id; const text=(msg.text||'').trim(); if(!text)return;
    console.log(`[TG ${cid}] ${msg.from?.first_name}: ${text}`);
    const p=parseTg(text);
    if(!p){tgSend(cid,`Text _help_ for all commands.`);return;}

    switch(p.cmd) {
      case 'watch': {
        tgSend(cid,`🔍 Pulling live data on *${p.symbol}*...`);
        const q=await getQuote(p.symbol);
        if(!q){tgSend(cid,`❌ *${p.symbol}* not found. Check the ticker symbol.`);return;}
        const lv=calcLevels(p.price,null);
        watches.set(cid,{symbol:p.symbol,entryLevel:p.price,customStop:p.stop,currentPrice:q.price,avgVolume:q.avgVolume,confirmed:false});
        addSub(p.symbol,cid);
        tgSend(cid,`👁 *WATCHING ${p.symbol}*\n\nNow: *$${q.price?.toFixed(2)}* | Trigger: *$${p.price}*\n\n🛑 Stop: *$${p.stop||lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n🎯 T3: *$${lv.t3}*\n\n🔴 Finnhub live monitoring active\nI'll alert when $${p.price} breaks with volume confirmation.`);
        break;
      }
      case 'in': {
        const w=watches.get(cid);
        if(!w){tgSend(cid,`Set a watch first: _watching LFVN at 5.10_`);return;}
        const lv=calcLevels(p.price,null);
        const tr={symbol:w.symbol,entryPrice:p.price,shares:p.shares,entryTime:Date.now(),currentPrice:p.price,hwm:p.price,avgCost:p.price,stopLoss:w.customStop||lv.stop,trailingStop:lv.stop,targets:{t1:lv.t1,t2:lv.t2,t3:lv.t3},avgVolume:w.avgVolume,adds:[],t1Hit:false,t2Hit:false,stopAlerted:false,trailAlerted:false,warn45:false,warn90:false,addSent:false};
        trades.set(cid,tr);watches.delete(cid);addSub(w.symbol,cid);
        tgSend(cid,`✅ *IN — ${w.symbol}*\n\n*$${p.price}* × *${p.shares} shares* = *$${(p.price*p.shares).toFixed(2)}*\n\n🛑 STOP: *$${tr.stopLoss}* (max -$${(lv.risk*p.shares).toFixed(2)})\n🎯 T1: *$${lv.t1}* (+$${((lv.t1-p.price)*p.shares).toFixed(2)})\n🎯 T2: *$${lv.t2}* (+$${((lv.t2-p.price)*p.shares).toFixed(2)})\n🎯 T3: *$${lv.t3}* 🚀\n\n🔴 Live monitoring: stop·targets·trail·45min·adds`);
        break;
      }
      case 'out': {
        const tr=trades.get(cid);
        if(!tr){tgSend(cid,`No active trade. Start with: _watching [TICKER] at [price]_`);return;}
        const pnl=totalPnl(tr,p.price);const ts=totalShares(tr);const mins=((Date.now()-tr.entryTime)/60000).toFixed(0);const pct=(((p.price-tr.avgCost)/tr.avgCost)*100).toFixed(2);
        await logTrade({symbol:tr.symbol,date:new Date().toISOString().split('T')[0],entryPrice:tr.entryPrice,exitPrice:p.price,shares:ts,avgCost:tr.avgCost,pnl,pnlPct:+pct,minutesInTrade:+mins,t1Hit:tr.t1Hit,t2Hit:tr.t2Hit});
        removeSub(tr.symbol,cid);trades.delete(cid);
        tgSend(cid,`${pnl>0?'💰':'📉'} *CLOSED — ${tr.symbol}*\n\n$${tr.entryPrice} → *$${p.price}* | ${ts} shares | ${mins}min\n\n${pnl>0?'✅':'❌'} *P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}* (${pct}%)\n\n${pnl>0?'🔥 Banked. Clean execution, Maverick.':'💪 Stop respected. Capital preserved. Next setup.'}\nText _daily_ to see today's P&L.`);
        break;
      }
      case 'add': {
        const tr=trades.get(cid);if(!tr){tgSend(cid,`No active trade.`);return;}
        tr.adds.push({shares:p.shares,price:p.price});tr.avgCost=avgCostCalc(tr);
        tgSend(cid,`📈 *ADDED — ${tr.symbol}*\n+${p.shares} shares @ $${p.price}\nTotal: ${totalShares(tr)} shares | New avg: *$${tr.avgCost}*`);
        break;
      }
      case 'sl': {
        const tr=trades.get(cid);const w=watches.get(cid);
        if(tr){tr.stopLoss=p.price;tr.stopAlerted=false;tgSend(cid,`✅ Stop updated → *$${p.price}* on *${tr.symbol}*`);}
        else if(w){w.customStop=p.price;tgSend(cid,`✅ Stop set → *$${p.price}* on *${w.symbol}*`);}
        else tgSend(cid,`No active trade or watch.`);
        break;
      }
      case 'alert': {
        if(!priceAlerts.has(p.symbol))priceAlerts.set(p.symbol,[]);
        priceAlerts.get(p.symbol).push({chatId:cid,condition:p.condition,value:p.value,fired:false,avgVolume:null});
        addSub(p.symbol,cid);
        tgSend(cid,`🔔 *ALERT SET — ${p.symbol}*\nFires when price goes *${p.condition}* *$${p.value}*\n\n✅ Monitored via Finnhub real-time feed\n_No TradingView Pro needed._`);
        break;
      }
      case 'dive': {
        // Deep dive analysis — same as web analyze but sent via Telegram
        tgSend(cid,`🔍 Running full multi-timeframe analysis on *${p.symbol}*...\nPulling: Finnhub quote · Yahoo candles · 4 timeframes · News · AI synthesis`);
        try{
          const [quote,tf1d,tf4h,tf1h,tf15,news]=await Promise.all([getQuote(p.symbol),getCandles(p.symbol,'3mo','1d'),getCandles(p.symbol,'1mo','60m'),getCandles(p.symbol,'5d','60m'),getCandles(p.symbol,'2d','15m'),getNews(p.symbol)]);
          if(!quote){tgSend(cid,`❌ *${p.symbol}* not found.`);return;}
          const payload={ticker:p.symbol,quote:{price:quote.price,changePct:quote.changePct,open:quote.open,high:quote.high,low:quote.low,volume:quote.volume,marketCap:quote.marketCap,floatShares:quote.floatShares,sector:quote.sector,shortName:quote.shortName},timeframes:{daily:tf1d||'unavailable',fourhour:tf4h||'unavailable',onehour:tf1h||'unavailable',fifteen:tf15||'unavailable'},recent_news:news.slice(0,3).map(n=>n.headline)};
          const v=await groqCall(ANALYZE_PROMPT,JSON.stringify(payload));
          if(!v){tgSend(cid,`❌ AI unavailable. Check GROQ_KEY.`);return;}
          const emoji={BUY:'🟢',DONT_BUY:'🔴',WATCH:'🟡'}[v.verdict]||'⚪';
          const chartUrl=getChartUrl(p.symbol,'5min');
          let msg=`${emoji} *${p.symbol}* — *${v.verdict.replace('_',' ')}*\nConviction: *${v.conviction}/100*\n\n${v.headline}\n\n`;
          msg+=`📊 Pattern: *${v.chart_pattern||'N/A'}*\nTrend Alignment: *${v.timeframe_alignment}*\n\n`;
          msg+=`*Reasoning:*\n${(v.reasoning||[]).map(r=>`• ${r}`).join('\n')}\n\n`;
          if(v.verdict==='BUY'){
            msg+=`📋 *TRADE PLAN:*\n`;
            msg+=`Entry: *$${v.entry_zone?.low}–$${v.entry_zone?.high}*\n`;
            msg+=`Stop: *$${v.stop_loss}*\nT1: *$${v.target_1}*\nT2: *$${v.target_2}*\nT3: *$${v.target_3||'—'}*\n`;
            msg+=`R:R: *${v.risk_reward}:1* | Size: *${v.position_size_suggestion}*\n`;
            msg+=`Type: *${v.trade_type}* | Time: *${v.time_horizon}*\n\n`;
            msg+=`⚠️ Risk: ${v.key_risk}\n\n`;
            msg+=`Text: _watching ${p.symbol} at ${v.entry_zone?.low}_\n`;
            msg+=`📈 Chart: ${chartUrl}`;
          }else if(v.verdict==='WATCH'){
            msg+=`⏳ Trigger: ${v.trigger_to_watch}\n⚠️ Risk: ${v.key_risk}\n📈 Chart: ${chartUrl}`;
          }else{
            msg+=`⚠️ ${v.key_risk}`;
          }
          tgSend(cid,msg);
        }catch(e){tgSend(cid,`❌ Analysis error: ${e.message}`);}
        break;
      }
      case 'news': {
        tgSend(cid,`🔍 *Running catalyst scan...*\nSearching: Finnhub news + SEC 8-K filings\nFocused on: pre-market/overnight catalysts\n\nResults coming in 15-30 seconds...`);
        runCatalystScan(true);
        break;
      }
      case 'skip': {
        pendingCatalysts.delete(cid);
        tgSend(cid,`✅ Dismissed. Monitoring continues.\nText _news_ to run a fresh catalyst scan.`);
        break;
      }
      case 'quote': {
        const q=await getQuote(p.symbol);
        if(!q){tgSend(cid,`❌ *${p.symbol}* not found.`);return;}
        const chg=(q.changePct>=0?'+':'')+q.changePct?.toFixed(2)+'%';
        const preStr=q.preMarket?` | Pre-mkt: $${q.preMarket?.toFixed(2)} (${(q.preMarketChangePct>=0?'+':'')+q.preMarketChangePct?.toFixed(2)}%)`:'';
        tgSend(cid,`📊 *${p.symbol}* — *$${q.price?.toFixed(2)}* (${chg})${preStr}\nH: $${q.high?.toFixed(2)} | L: $${q.low?.toFixed(2)} | Prev: $${q.prevClose?.toFixed(2)}\n${q.marketCap?'Mkt Cap: $'+(q.marketCap/1e6).toFixed(0)+'M':''} ${q.floatShares?'| Float: '+(q.floatShares/1e6).toFixed(1)+'M':''}\n${q.sector?'Sector: '+q.sector:''}\nSource: ${q.source||'live'}\n\n_watching ${p.symbol} at ${q.price?.toFixed(2)}_\n_dive ${p.symbol}_ for full AI analysis`);
        break;
      }
      case 'status': {
        const tr=trades.get(cid);const w=watches.get(cid);
        if(tr){const price=tr.currentPrice||tr.entryPrice;const pnl=totalPnl(tr,price);const mins=((Date.now()-tr.entryTime)/60000).toFixed(0);
          tgSend(cid,`📊 *LIVE STATUS — ${tr.symbol}*\n\nEntry: $${tr.entryPrice} | Now: *$${price.toFixed(2)}*\nAvg: $${tr.avgCost} | Shares: ${totalShares(tr)}\nP&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}* | Time: ${mins}min\n\n🛑 Stop: *$${tr.stopLoss}*\n🔄 Trail: *$${tr.trailingStop}*\n🎯 T1: $${tr.targets.t1} ${tr.t1Hit?'✅':'⏳'}\n🎯 T2: $${tr.targets.t2} ${tr.t2Hit?'✅':'⏳'}`);}
        else if(w)tgSend(cid,`👁 Watching *${w.symbol}* → trigger $${w.entryLevel} | Now: $${w.currentPrice?.toFixed(2)||'...'}`)
        else tgSend(cid,`No active watch or trade.\n\n_watching [TICKER] at [price]_`);
        break;
      }
      case 'cancel': {
        const sym=watches.get(cid)?.symbol||trades.get(cid)?.symbol;
        if(sym)removeSub(sym,cid);watches.delete(cid);trades.delete(cid);
        tgSend(cid,`✅ Cleared. Ready for next trade.\n\n_watching [TICKER] at [price]_`);
        break;
      }
      case 'daily': {
        const mem=await memLoad();const today=new Date().toISOString().split('T')[0];
        const list=(mem.trades||[]).filter(t=>t.date===today);
        if(!list.length){tgSend(cid,`No trades logged today.\nClose a trade with _out at [price]_ to log it.`);return;}
        const total=list.reduce((s,t)=>s+t.pnl,0);const wins=list.filter(t=>t.pnl>0);
        tgSend(cid,`📊 *TODAY — ${today}*\n\nTrades: *${list.length}* | Wins: *${wins.length}* (${((wins.length/list.length)*100).toFixed(0)}%)\nTotal P&L: *${total>=0?'+':''}$${total.toFixed(2)}*\n\n`+list.map(t=>`${t.pnl>=0?'✅':'❌'} ${t.symbol} ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)} (${t.minutesInTrade}min)`).join('\n'));
        break;
      }
      case 'weekly': {
        const mem=await memLoad();
        const list=(mem.trades||[]).filter(t=>(Date.now()-new Date(t.date).getTime())<7*86400000);
        if(!list.length){tgSend(cid,`No trades this week.`);return;}
        const total=list.reduce((s,t)=>s+t.pnl,0);const wins=list.filter(t=>t.pnl>0);
        const avgWin=wins.length?(wins.reduce((s,t)=>s+t.pnl,0)/wins.length).toFixed(2):0;
        const losses=list.filter(t=>t.pnl<=0);const avgLoss=losses.length?(losses.reduce((s,t)=>s+t.pnl,0)/losses.length).toFixed(2):0;
        tgSend(cid,`📊 *THIS WEEK*\n\nTrades: *${list.length}* | Wins: *${wins.length}* (${((wins.length/list.length)*100).toFixed(0)}%)\nTotal P&L: *${total>=0?'+':''}$${total.toFixed(2)}*\nAvg Win: +$${avgWin} | Avg Loss: $${avgLoss}\n\nRecent:\n`+list.slice(-5).reverse().map(t=>`${t.pnl>=0?'✅':'❌'} ${t.symbol} ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}`).join('\n'));
        break;
      }
      case 'tradeReview': {
        if(!GROQ_KEY){tgSend(cid,`Add GROQ_KEY for AI analysis.`);return;}
        const mem=await memLoad();const tlist=(mem.trades||[]).slice(-20);
        if(tlist.length<3){tgSend(cid,`Need 3+ completed trades for AI analysis.`);return;}
        tgSend(cid,`🤖 Analyzing your last ${tlist.length} trades...`);
        const summary=tlist.map(t=>`${t.symbol}: ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}, ${t.minutesInTrade}min, T1:${t.t1Hit}, T2:${t.t2Hit}`).join('\n');
        const ai=await groqCall('You are an aggressive day trading coach. From the trade data, identify 3 specific mistakes costing money, 2 strengths, and 1 actionable adjustment. Use exact numbers. Be direct.', `Trades:\n${summary}`, 500);
        tgSend(cid,`🤖 *AI TRADE REVIEW*\n\n${ai?JSON.stringify(ai).replace(/[{}]/g,''):'Analysis unavailable.'}`);
        break;
      }
      case 'help': {
        tgSend(cid,
          `🤖 *MAVERICK BOT v3.2*\n\n` +
          `*TRADE COMMANDS:*\n` +
          `_watching LFVN at 5.10_ — set watch\n` +
          `_watching LFVN at 5.10 stop 4.80_ — custom stop\n` +
          `_in at 5.11 with 200 shares_ — log entry\n` +
          `_added 100 at 5.50_ — add to position\n` +
          `_sl 4.88_ — update stop loss\n` +
          `_out at 5.85_ — close + log P&L\n` +
          `_status_ — live P&L check\n` +
          `_cancel_ — reset everything\n\n` +
          `*ANALYSIS:*\n` +
          `_LFVN_ — live quote\n` +
          `_dive LFVN_ — full AI analysis + chart + trade plan\n` +
          `_news_ — scan catalysts now (overnight/pre-market)\n\n` +
          `*ALERTS (replaces TradingView):*\n` +
          `_alert LFVN above 5.50_ — breakout alert\n` +
          `_alert LFVN below 4.80_ — stop zone alert\n\n` +
          `*REPORTS:*\n` +
          `_daily_ — today's P&L\n` +
          `_weekly_ — 7-day report\n` +
          `_analyze_ — AI reviews your trades\n\n` +
          `*CATALYST FLOW:*\n` +
          `When I detect a catalyst I ask you:\n` +
          `_DIVE [TICKER]_ — deep analysis\n` +
          `_WATCH [TICKER]_ — live monitor\n` +
          `_SKIP_ — dismiss`
        );
        break;
      }
    }
  });

  bot.on('polling_error', e => console.error('Polling:', e.message));
}
// ═══════════════════════════════════════════════════════════════════════════
// MAVERICK SMART MONEY FOOTPRINTS ENGINE
// Paste this block into index.js BEFORE the app.get('*'...) catch-all line
// ═══════════════════════════════════════════════════════════════════════════

// ── Phase Detection Algorithm ──────────────────────────────────────────────
function detectPhase(dailyCandles, currentPrice) {
  if (!dailyCandles || dailyCandles.candleCount < 10) {
    return { phase: 0, confidence: 0, description: 'Insufficient data', signals: [] };
  }

  const { high, low, last, ema9, rsi, relVolume, atr, pctChange } = dailyCandles;
  const priceRange = high - low;
  const pricePosition = priceRange > 0 ? (currentPrice - low) / priceRange : 0.5; // 0=at lows, 1=at highs

  let phase = 0, confidence = 0, description = '', signals = [];

  // Phase 1 — Quiet Accumulation
  // Price near lows, RSI recovering from oversold, volume low
  if (pricePosition < 0.30 && rsi < 50 && rsi > 25 && relVolume < 1.2) {
    phase = 1; confidence = 65 + Math.round((0.30 - pricePosition) * 100);
    description = 'Institutions quietly absorbing supply near lows. Retail uninterested.';
    signals.push('Price in bottom 30% of range');
    signals.push('RSI recovering from oversold (' + rsi + ')');
    signals.push('Below-average volume = quiet absorption');
    if (pctChange > -5 && pctChange < 5) signals.push('Price not breaking down despite low interest');
  }

  // Phase 2 — Price Defense (Maverick's ENTRY zone)
  else if (pricePosition >= 0.15 && pricePosition <= 0.50 && rsi >= 40 && rsi <= 65) {
    phase = 2; confidence = 70 + Math.round(Math.abs(0.35 - pricePosition) * 50);
    description = 'DEFENDED. Institutions protecting their entry. Buy every dip pattern active.';
    signals.push('Price in consolidation zone (defended range)');
    signals.push('RSI healthy and rising (' + rsi + ')');
    signals.push('Higher lows forming — institutions absorbing each dip');
    if (relVolume > 0.8 && relVolume < 1.5) signals.push('Controlled volume = institutional hand');
    if (atr) signals.push('ATR $' + atr.toFixed(2) + ' — use for stop placement');
  }

  // Phase 3 — Distribution / Markup (Maverick's RIDE zone)
  else if (pricePosition > 0.50 && pricePosition <= 0.80 && rsi > 50 && pctChange > 0) {
    phase = 3; confidence = 72 + Math.round(pricePosition * 20);
    description = 'MARKUP IN PROGRESS. Institutions distributing into retail buying. Ride with them.';
    signals.push('Price in upper half of range — breakout territory');
    signals.push('RSI bullish momentum (' + rsi + ')');
    signals.push('Positive price change confirms directional move');
    if (relVolume > 1.3) signals.push('Volume expanding = institutions inviting retail in');
  }

  // Phase 4 — FOMO Distribution
  else if (pricePosition > 0.80 && rsi > 70) {
    phase = 4; confidence = 75;
    description = 'DANGER. FOMO zone. Institutions selling into retail euphoria. Do NOT buy.';
    signals.push('Price at 80%+ of range — extended');
    signals.push('RSI overbought (' + rsi + ') — reversal risk high');
    signals.push('Whales distributing. Retail is the exit liquidity.');
  }

  // Phase 5 — Bag Holding / Decline
  else if (pctChange < -15 || (pricePosition < 0.25 && rsi < 35)) {
    phase = 5; confidence = 68;
    description = 'DECLINE. Institutions gone. Retail holding the bag. Avoid.';
    signals.push('Price declining sharply from highs');
    signals.push('RSI in bearish territory (' + rsi + ')');
    signals.push('Smart money has exited. Do not catch falling knife.');
  }

  // Uncertain — transitional
  else {
    phase = 0; confidence = 45;
    description = 'TRANSITIONAL. Phase unclear. Wait for definition.';
    signals.push('Mixed signals — no clean phase identified');
    signals.push('Wait for price to define direction');
  }

  return { phase, confidence, description, signals, pricePosition: +(pricePosition * 100).toFixed(0), rsi, relVolume };
}

// ── Price Defense Score (how many times a level has been defended) ──────────
function scorePriceDefense(candles) {
  if (!candles) return { score: 0, level: null, count: 0 };
  // Use the candle low as approximate support
  const supportLevel = candles.low;
  const tolerance = candles.atr || supportLevel * 0.03;
  // We estimate bounces from the range contraction
  const rangeVsAtR = candles.atr > 0 ? (candles.high - candles.low) / candles.atr : 0;
  const estimatedBounces = Math.max(1, Math.round(Math.min(rangeVsAtR / 3, 8)));
  const score = Math.min(100, estimatedBounces * 15 + (candles.rsi > 40 && candles.rsi < 65 ? 20 : 0));
  return { score, level: +supportLevel.toFixed(2), count: estimatedBounces };
}

// ── Institutional Data (Finnhub + SEC EDGAR) ───────────────────────────────
async function getInstitutionalData(symbol) {
  const results = { earnings: null, ownership: null, recommendations: null, insiders: null };

  if (!FINNHUB_KEY) return results;

  try {
    // Earnings calendar and estimates
    const now = Math.floor(Date.now() / 1000);
    const [earningsR, recR] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${symbol}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/recommendation?symbol=${symbol}&token=${FINNHUB_KEY}`),
    ]);
    const earningsD = await earningsR.json();
    const recD = await recR.json();

    // Next earnings
    if (earningsD?.earningsCalendar?.length) {
      const upcoming = earningsD.earningsCalendar
        .filter(e => new Date(e.date).getTime() > Date.now())
        .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
      if (upcoming) {
        results.earnings = {
          date: upcoming.date,
          epsEstimate: upcoming.epsEstimate,
          revenueEstimate: upcoming.revenueEstimate,
          daysUntil: Math.ceil((new Date(upcoming.date) - Date.now()) / 86400000),
        };
      }
    }

    // Analyst recommendations (buying pressure proxy)
    if (Array.isArray(recD) && recD.length) {
      const latest = recD[0];
      results.recommendations = {
        strongBuy: latest.strongBuy || 0,
        buy: latest.buy || 0,
        hold: latest.hold || 0,
        sell: latest.sell || 0,
        strongSell: latest.strongSell || 0,
        period: latest.period,
      };
    }
  } catch(e) { console.error('Institutional data:', e.message); }

  return results;
}

// ── Volume Pattern Analysis ────────────────────────────────────────────────
function analyzeVolumePattern(tf1d, tf1h) {
  if (!tf1d) return { pattern: 'UNKNOWN', accumScore: 0, signals: [] };
  const signals = [];
  let accumScore = 50; // neutral

  // High volume on dips (accumulation) vs high volume on rallies (distribution)
  if (tf1d.relVolume > 1.5 && tf1d.trend === 'UP') {
    accumScore += 15; signals.push('High volume on uptrend = institutional buying');
  }
  if (tf1d.relVolume > 1.5 && tf1d.trend === 'DOWN') {
    accumScore -= 20; signals.push('High volume on downtrend = distribution warning');
  }
  if (tf1d.rsi < 50 && tf1d.relVolume < 0.8) {
    accumScore += 10; signals.push('Quiet tape at low RSI = stealth accumulation pattern');
  }
  if (tf1h && tf1h.trend === 'UP' && tf1d.trend === 'DOWN') {
    accumScore += 8; signals.push('1H turning up while daily still down = early reversal');
  }
  if (tf1d.pctChange > 20 && tf1d.relVolume > 3) {
    accumScore -= 25; signals.push('Parabolic volume = FOMO, not smart money');
  }

  const pattern = accumScore >= 65 ? 'ACCUMULATION' : accumScore <= 35 ? 'DISTRIBUTION' : 'NEUTRAL';
  return { pattern, accumScore: Math.max(0, Math.min(100, accumScore)), signals };
}

// ── Overall Footprint Score ────────────────────────────────────────────────
function calcFootprintScore(phase, defense, volPattern, institutional) {
  let score = 0;
  const signals = [];

  // Phase scoring (Phase 2 and 3 are ideal)
  if (phase.phase === 2) { score += 35; signals.push('🔥 PHASE 2 — Price defense active (Maverick sweet spot)'); }
  else if (phase.phase === 3) { score += 28; signals.push('🔥 PHASE 3 — Markup in progress (ride the whale)'); }
  else if (phase.phase === 1) { score += 18; signals.push('👀 PHASE 1 — Quiet accumulation (early position)'); }
  else if (phase.phase === 4) { score -= 20; signals.push('⚠️ PHASE 4 — FOMO zone (whale exit)'); }
  else if (phase.phase === 5) { score -= 35; signals.push('❌ PHASE 5 — Bag holding (avoid)'); }

  // Price defense
  if (defense.count >= 3) { score += 20; signals.push('🛡️ Support defended ' + defense.count + 'x at $' + defense.level); }
  else if (defense.count >= 2) { score += 12; signals.push('🛡️ Support tested ' + defense.count + 'x at $' + defense.level); }

  // Volume pattern
  if (volPattern.pattern === 'ACCUMULATION') { score += 18; signals.push('📊 Volume pattern = ACCUMULATION (whales buying)'); }
  else if (volPattern.pattern === 'DISTRIBUTION') { score -= 15; signals.push('📊 Volume pattern = DISTRIBUTION (whales selling)'); }

  // Institutional signals
  if (institutional?.earnings?.daysUntil <= 14 && institutional.earnings.daysUntil > 0) {
    score += 15; signals.push('⚡ CATALYST: Earnings in ' + institutional.earnings.daysUntil + ' days');
  }
  if (institutional?.recommendations) {
    const r = institutional.recommendations;
    const bullish = r.strongBuy + r.buy;
    const bearish = r.sell + r.strongSell;
    if (bullish > bearish * 2) { score += 10; signals.push('📈 Analyst consensus: ' + bullish + ' BUY vs ' + bearish + ' SELL'); }
  }

  return { score: Math.max(0, Math.min(100, score)), signals };
}

// ── FOOTPRINTS API ROUTE ───────────────────────────────────────────────────
app.post('/api/footprints', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  const sym = ticker.toUpperCase().trim();

  try {
    // Pull all data in parallel
    const [quote, tf1d, tf4h, tf1h, tf15, news, institutional] = await Promise.all([
      getQuote(sym),
      getCandles(sym, '3mo', '1d'),
      getCandles(sym, '1mo', '60m'),
      getCandles(sym, '5d', '60m'),
      getCandles(sym, '2d', '15m'),
      getNews(sym),
      getInstitutionalData(sym),
    ]);

    if (!quote) return res.status(404).json({ error: sym + ' not found' });

    // Run all analyses
    const phase       = detectPhase(tf1d, quote.price);
    const defense     = scorePriceDefense(tf1d);
    const volPattern  = analyzeVolumePattern(tf1d, tf1h);
    const footprint   = calcFootprintScore(phase, defense, volPattern, institutional);
    const chartUrl    = getChartUrl(sym, 'daily');

    res.json({
      ticker: sym,
      quote,
      phase,
      defense,
      volPattern,
      institutional,
      footprint,
      chartUrl,
      timeframes: { daily: tf1d, fourhour: tf4h, onehour: tf1h, fifteen: tf15 },
      news: news.slice(0, 3),
      timestamp: new Date().toISOString(),
    });
  } catch(e) {
    console.error('Footprints error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── FOOTPRINTS DEEP DIVE (full AI analysis) ────────────────────────────────
app.post('/api/footprints/deepdive', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'no ticker' });
  if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_KEY not set' });
  const sym = ticker.toUpperCase().trim();

  try {
    // Get base footprint data first
    const fpRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/footprints`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: sym })
    });
    const fp = await fpRes.json();
    if (fp.error) return res.status(404).json({ error: fp.error });

    const DEEPDIVE_PROMPT = `You are MAVERICK Smart Money Analyst — the most sophisticated institutional footprint reader on the street.

TRADING PHILOSOPHY:
- We swim WITH whales, never against them
- We eat their leftovers (Phase 2 and 3 entries)
- We ANTICIPATE their arrival, not react to it
- The whales ARE the catalyst. Retail is our exit liquidity.
- We never fight dilution, ATMs, or active distribution

5 PHASES:
Phase 1 — Quiet Accumulation: Institutions loading quietly, retail unaware
Phase 2 — PRICE DEFENSE: Institutions protecting entry, buying every dip (MAVERICK ENTRY)
Phase 3 — MARKUP/DISTRIBUTION: Breakout begins, ride with the whale (MAVERICK RIDE)
Phase 4 — FOMO Distribution: Whales selling into euphoria (AVOID/FADE)
Phase 5 — Bag Holding: Institutions gone, avoid (AVOID)

4 WHALE FOOTPRINTS TO DETECT:
1. CATALYST ANTICIPATION: Earnings whisper, FDA date, contract expected, options flow
2. PRICE DEFENSE: Exact level defended 3+ times, volume spike on dips, fade on rallies
3. BID STACKING: Volume at key levels, block accumulation off-hours, round number support
4. INSTITUTIONAL ACCUMULATION: 13F changes, analyst upgrades post-accumulation, ownership rise

YOUR JOB: Analyze ALL data. Take a clear, aggressive position. Name the footprints. Tell Maverick exactly what to do.

RETURN ONLY VALID JSON:
{
  "phase_detected": 1-5,
  "phase_confidence": 0-100,
  "phase_name": "QUIET_ACCUMULATION|PRICE_DEFENSE|MARKUP|FOMO_DISTRIBUTION|BAG_HOLDING",
  "maverick_verdict": "ENTER_NOW|ENTER_ON_DIP|WATCH_FOR_PHASE2|RIDE_IT|FADE|AVOID",
  "conviction": 0-100,
  "headline": "one decisive sentence in Maverick's voice",
  "footprints_detected": [
    {"footprint": "name", "signal": "specific evidence", "strength": "STRONG|MODERATE|WEAK"}
  ],
  "whale_activity": "What are the whales doing RIGHT NOW based on data",
  "anticipated_catalyst": "What catalyst are whales positioned for, if any",
  "defended_level": 0.00,
  "entry_zone": {"low": 0.00, "high": 0.00},
  "stop_loss": 0.00,
  "target_1": 0.00,
  "target_2": 0.00,
  "risk_reward": 0.0,
  "time_to_move": "estimate of when the move happens",
  "key_risk": "what would invalidate the thesis",
  "reasoning": ["3-5 specific data bullets with numbers"]
}`;

    const verdict = await groqCall(DEEPDIVE_PROMPT, JSON.stringify({
      ticker: sym,
      current_price: fp.quote?.price,
      price_change_pct: fp.quote?.changePct,
      market_cap: fp.quote?.marketCap,
      float_shares: fp.quote?.floatShares,
      sector: fp.quote?.sector,
      phase_preliminary: fp.phase,
      defense_analysis: fp.defense,
      volume_pattern: fp.volPattern,
      footprint_score: fp.footprint,
      institutional_data: fp.institutional,
      timeframe_daily: fp.timeframes?.daily,
      timeframe_4h: fp.timeframes?.fourhour,
      timeframe_1h: fp.timeframes?.onehour,
      recent_news: fp.news?.map(n => n.headline),
    }));

    if (!verdict) return res.status(503).json({ error: 'AI unavailable' });

    res.json({ ticker: sym, verdict, baseData: fp, timestamp: new Date().toISOString() });
  } catch(e) {
    console.error('Deep dive error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// END FOOTPRINTS ENGINE — paste ends here
// ═══════════════════════════════════════════════════════════════════════════

// ── FRONTEND ──────────────────────────────────────────────────────────────────
app.get('*', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
connectFinnhub();
scheduleCatalystScans();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 MAVERICK TERMINAL v3.2`);
  console.log(`   Telegram:  ${TELEGRAM_TOKEN?'✅':'❌'}`);
  console.log(`   Finnhub:   ${FINNHUB_KEY?'✅':'❌'}`);
  console.log(`   Groq AI:   ${GROQ_KEY?'✅':'❌'}`);
  console.log(`   Memory:    ${JSONBIN_KEY?'✅':'⚠️ optional'}`);
  console.log(`   Catalyst:  Scanning at 4am, 6am, 8am ET + every 30min\n`);
});
