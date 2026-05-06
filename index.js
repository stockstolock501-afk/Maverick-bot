require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const fetch       = require('node-fetch');
const path        = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const GROQ_KEY       = process.env.GROQ_KEY;
const JSONBIN_KEY    = process.env.JSONBIN_KEY;
const JSONBIN_BIN    = process.env.JSONBIN_BIN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'maverick';
const TG_CHAT_ID     = process.env.TG_CHAT_ID;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
let bot = null;
if (TELEGRAM_TOKEN) {
  try { bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { interval:2000, timeout:10 } }); console.log('✅ Telegram started'); }
  catch (e) { console.error('TG init:', e.message); }
}
function tgSend(chatId, text) {
  if (!bot||!chatId) return;
  bot.sendMessage(String(chatId), text, { parse_mode:'Markdown' }).catch(e => console.error('TG:', e.message));
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const watches     = new Map();
const trades      = new Map();
const priceAlerts = new Map();
const subscribers = new Map();
const volTracker  = new Map();
const tvSignals   = new Map();

// ── FINNHUB WS ────────────────────────────────────────────────────────────────
let ws;
function connectFinnhub() {
  if (!FINNHUB_KEY) return;
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => { console.log('✅ Finnhub WS'); for (const s of subscribers.keys()) ws.send(JSON.stringify({type:'subscribe',symbol:s})); });
  ws.on('message', raw => { try { const m=JSON.parse(raw); if(m.type==='trade'&&Array.isArray(m.data)) m.data.forEach(t=>onTick(t.s,t.p,t.v)); } catch{} });
  ws.on('close', () => setTimeout(connectFinnhub, 5000));
  ws.on('error', e => console.error('WS:', e.message));
}
function wsSub(s,a){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:a,symbol:s}));}
function addSub(s,id){if(!subscribers.has(s))subscribers.set(s,new Set());if(!subscribers.get(s).size)wsSub(s,'subscribe');subscribers.get(s).add(id);}
function removeSub(s,id){const x=subscribers.get(s);if(!x)return;x.delete(id);if(!x.size){subscribers.delete(s);wsSub(s,'unsubscribe');}}

// ── DATA FETCH ────────────────────────────────────────────────────────────────
async async function yahooQuote(sym) {
  // PRIMARY: Finnhub (reliable from server, key already working)
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
          preMarket: null, preMarketChangePct: null,
          source: 'finnhub',
        };
      }
    } catch(e) { console.error('Finnhub quote:', e.message); }
  }
  // FALLBACK: Yahoo with browser headers
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`,
      { headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept':'application/json', 'Referer':'https://finance.yahoo.com/' }}
    );
    const d = await r.json();
    const q = d?.quoteResponse?.result?.[0];
    if (q?.regularMarketPrice) {
      return { price:q.regularMarketPrice, change:q.regularMarketChange, changePct:q.regularMarketChangePercent, open:q.regularMarketOpen, high:q.regularMarketDayHigh, low:q.regularMarketDayLow, prevClose:q.regularMarketPreviousClose, volume:q.regularMarketVolume, avgVolume:q.averageDailyVolume3Month, marketCap:q.marketCap, floatShares:q.floatShares, sharesOut:q.sharesOutstanding, pe:q.trailingPE, yearHigh:q.fiftyTwoWeekHigh, yearLow:q.fiftyTwoWeekLow, sector:q.sector, industry:q.industry, shortName:q.shortName, preMarket:q.preMarketPrice, preMarketChangePct:q.preMarketChangePercent, source:'yahoo' };
    }
  } catch(e) { console.error('Yahoo fallback:', e.message); }
  return null;
}

async function yahooCandles(sym,range,interval) {
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}`,{headers:{'User-Agent':'Mozilla/5.0'}});
    const d=await r.json(); const res=d?.chart?.result?.[0]; if(!res)return null;
    const q=res.indicators?.quote?.[0]; const ts=res.timestamp||[]; if(!q||!ts.length)return null;
    const candles=ts.map((t,i)=>({t,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:q.volume?.[i]})).filter(c=>c.c!=null);
    if(!candles.length)return null;
    const closes=candles.map(c=>c.c); const last=closes[closes.length-1]; const first=closes[0];
    const high=Math.max(...candles.map(c=>c.h)); const low=Math.min(...candles.map(c=>c.l));
    const avgVol=candles.reduce((s,c)=>s+(c.v||0),0)/candles.length; const lastVol=candles[candles.length-1]?.v||0;
    const ema9=closes.reduce((e,c,i)=>i===0?c:c*(2/10)+e*(1-2/10),closes[0]);
    const gains=[],losses=[];
    for(let i=1;i<Math.min(closes.length,15);i++){const df=closes[i]-closes[i-1];df>0?gains.push(df):losses.push(Math.abs(df));}
    const ag=gains.reduce((s,v)=>s+v,0)/(gains.length||1); const al=losses.reduce((s,v)=>s+v,0)/(losses.length||1);
    const rsi=al===0?100:100-(100/(1+ag/al));
    const mid=closes[Math.floor(closes.length/2)];
    return {range,interval,pctChange:+((last-first)/first*100).toFixed(2),trend:last>mid?'UP':'DOWN',high,low,last,ema9:+ema9.toFixed(2),rsi:+rsi.toFixed(1),relVolume:+(lastVol/avgVol).toFixed(2),candleCount:candles.length};
  } catch(e){console.error(`Candles ${range}:`,e.message);return null;}
}

async function yahooNews(sym) {
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${sym}&newsCount=5`,{headers:{'User-Agent':'Mozilla/5.0'}});
    const d=await r.json(); return (d?.news||[]).slice(0,4).map(n=>({headline:n.title,source:n.publisher}));
  } catch{return[];}
}

async function finnhubNews(sym) {
  if(!FINNHUB_KEY)return[];
  try {
    const to=new Date().toISOString().split('T')[0]; const from=new Date(Date.now()-7*86400000).toISOString().split('T')[0];
    const r=await fetch(`https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d=await r.json(); return Array.isArray(d)?d.slice(0,4).map(n=>({headline:n.headline,source:n.source})):[];
  } catch{return[];}
}

// ── TRADE MATH ────────────────────────────────────────────────────────────────
function calcLevels(entry){
  const sp=entry<5?0.035:entry<15?0.028:0.02; const stop=+(entry*(1-sp)).toFixed(2); const risk=entry-stop;
  return{stop,t1:+(entry+risk*2).toFixed(2),t2:+(entry+risk*3.5).toFixed(2),t3:+(entry+risk*5.5).toFixed(2),risk:+risk.toFixed(2)};
}
function totalShares(tr){return tr.shares+tr.adds.reduce((s,a)=>s+a.shares,0);}
function avgCostCalc(tr){return+((tr.entryPrice*tr.shares+tr.adds.reduce((s,a)=>s+a.price*a.shares,0))/totalShares(tr)).toFixed(2);}
function totalPnl(tr,p){return+((p-tr.entryPrice)*tr.shares+tr.adds.reduce((s,a)=>s+(p-a.price)*a.shares,0)).toFixed(2);}

// ── TICK HANDLER ──────────────────────────────────────────────────────────────
function onTick(sym,price,vol){
  if(!volTracker.has(sym))volTracker.set(sym,{v1m:0,reset:Date.now()});
  const vt=volTracker.get(sym); if(Date.now()-vt.reset>60000){vt.v1m=0;vt.reset=Date.now();} vt.v1m+=vol;

  // Watches
  for(const[cid,w]of watches){
    if(w.symbol!==sym||w.confirmed)continue; w.currentPrice=price;
    if(price>=w.entryLevel){const apr=w.avgVolume?w.avgVolume/390:null;const vr=apr?vt.v1m/apr:99;
      if(vr>=1.5){w.confirmed=true;const lv=calcLevels(price);
        tgSend(cid,`🔥 *ENTRY CONFIRMED — ${sym}*\n\n$${price.toFixed(2)} | Vol: ${vr.toFixed(1)}x\n\n🛑 Stop: *$${lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n\nText: _in at ${price.toFixed(2)} with 200 shares_`);}}
  }

  // Price alerts (replaces TradingView Pro)
  const alerts=priceAlerts.get(sym)||[];
  for(const a of alerts){
    if(a.fired)continue;
    const hit=(a.condition==='ABOVE'&&price>=a.value)||(a.condition==='BELOW'&&price<=a.value)||(a.condition==='CROSS'&&Math.abs(price-a.value)/a.value<0.005);
    if(hit){a.fired=true;const apr=a.avgVolume?a.avgVolume/390:null;const vr=apr?vt.v1m/apr:0;
      const e=a.condition==='ABOVE'?'🚀':a.condition==='BELOW'?'🔻':'⚡';
      tgSend(a.chatId,`${e} *ALERT FIRED — ${sym}*\n\n$${price.toFixed(2)} ${a.condition} $${a.value}\nVol: ${vr>0?vr.toFixed(1)+'x avg':'monitoring'}\n\n_Internal alert — no TradingView Pro needed._\nText: _watching ${sym} at ${price.toFixed(2)}_`);}
  }

  // Active trades
  for(const[cid,tr]of trades){
    if(tr.symbol!==sym)continue;
    const prev=tr.currentPrice||tr.entryPrice; tr.currentPrice=price;
    const mins=(Date.now()-tr.entryTime)/60000; const pnl=totalPnl(tr,price);
    const apr=tr.avgVolume?tr.avgVolume/390:null; const vr=apr?vt.v1m/apr:0;
    if(price>tr.hwm){tr.hwm=price;if(tr.t1Hit){const trail=+(price-(price-tr.avgCost)*0.40).toFixed(2);if(trail>tr.trailingStop)tr.trailingStop=trail;}}
    if(!tr.stopAlerted&&price<=tr.stopLoss){tr.stopAlerted=true;tgSend(cid,`🚨 *STOP HIT — ${tr.symbol}*\n$${price.toFixed(2)} | P&L: -$${Math.abs(pnl).toFixed(2)}\n\n❌ *EXIT NOW.* Text: _out at ${price.toFixed(2)}_`);}
    if(tr.t1Hit&&!tr.trailAlerted&&price<=tr.trailingStop){tr.trailAlerted=true;tgSend(cid,`⚠️ *TRAIL STOP — ${tr.symbol}*\n$${price.toFixed(2)} | Locked: +$${pnl.toFixed(2)}\nText: _out at ${price.toFixed(2)}_`);}
    if(!tr.t1Hit&&price>=tr.targets.t1){tr.t1Hit=true;tr.stopLoss=tr.avgCost;tr.stopAlerted=false;tr.trailAlerted=false;tgSend(cid,`🎯 *TARGET 1 — ${tr.symbol}*\n$${price.toFixed(2)} | +$${totalPnl(tr,tr.targets.t1).toFixed(2)}\n\n✅ Sell 50%\n🔄 Stop → BREAKEVEN $${tr.avgCost}\n🎯 Next: $${tr.targets.t2}`);}
    if(!tr.t2Hit&&price>=tr.targets.t2){tr.t2Hit=true;tgSend(cid,`🎯🎯 *TARGET 2 — ${tr.symbol}*\n+$${totalPnl(tr,tr.targets.t2).toFixed(2)}\nSell rest or hold to T3: $${tr.targets.t3}`);}
    if(!tr.addSent&&tr.t1Hit&&!tr.t2Hit){const pg=((price-tr.avgCost)/tr.avgCost)*100;if(pg>4&&vr>2&&price>prev*0.995){tr.addSent=true;tgSend(cid,`📈 *ADD SIGNAL — ${tr.symbol}*\nVol: ${vr.toFixed(1)}x | +${pg.toFixed(1)}%\nText: _added 100 at ${price.toFixed(2)}_`);}}
    if(!tr.warn45&&mins>=45){tr.warn45=true;tgSend(cid,`⏱ *45-MIN — ${tr.symbol}*\n${mins.toFixed(0)}min | ${pnl>=0?'+':''}$${pnl.toFixed(2)}\n${!tr.t1Hit?'⚠️ T1 not hit — re-evaluate.':'✅ T1 hit — consider exit.'}`);}
    if(!tr.warn90&&mins>=90){tr.warn90=true;tgSend(cid,`🚨 *90-MIN — ${tr.symbol}*\nMomentum done. *Consider exit.*\nText: _out at ${price.toFixed(2)}_`);}
  }
}

// ── MEMORY ────────────────────────────────────────────────────────────────────
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

// ── AI ────────────────────────────────────────────────────────────────────────
const AI_PROMPT=`You are MAVERICK — aggressive, decisive day trading AI.
You receive multi-timeframe Yahoo Finance data (daily/4H/1H/15min). Use ALL timeframes for trend alignment.

TIMEFRAME RULES:
- Daily: overall trend + key S/R
- 4H: intermediate trend
- 1H: entry timing  
- 15min: precise entry + pattern

VERDICTS: BUY | DONT_BUY | WATCH

ENTRY MATH (ATR-based):
- Stop = 1.5×ATR below entry (use swing low if tighter)
- T1 = entry + 2×(entry-stop), T2 = entry + 3.5×(entry-stop)
- No ATR: 3.5% stop sub-$5, 2.5% for $5-15, 2% above $15

TRADER: AGGRESSIVE. Sub-$10 specialist. Hard stops always respected.

RETURN ONLY VALID JSON no markdown:
{"verdict":"BUY|DONT_BUY|WATCH","conviction":0-100,"headline":"one decisive sentence","reasoning":["bullet1","bullet2","bullet3"],"entry_zone":{"low":0.00,"high":0.00},"stop_loss":0.00,"target_1":0.00,"target_2":0.00,"risk_reward":0.0,"position_size_suggestion":"AGGRESSIVE|STANDARD|SMALL","trade_type":"DAY_TRADE|SWING|SCALP","key_risk":"specific risk","trigger_to_watch":"condition if WATCH","time_horizon":"estimate"}`;

async function groqCall(system,user,maxTokens=1500){
  if(!GROQ_KEY)return null;
  try{
    const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${GROQ_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:maxTokens,temperature:0.25,messages:[{role:'system',content:system},{role:'user',content:user}]})});
    const d=await r.json(); const text=d.choices?.[0]?.message?.content||''; const m=text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim().match(/\{[\s\S]*\}/);
    return m?JSON.parse(m[0]):null;
  }catch(e){console.error('Groq:',e.message);return null;}
}

// ── API ROUTES ────────────────────────────────────────────────────────────────

// Main analyzer — multi-timeframe
app.post('/api/analyze', async (req,res) => {
  const {ticker}=req.body; if(!ticker)return res.status(400).json({error:'no ticker'});
  const sym=ticker.toUpperCase().trim();
  try{
    const [quote,tf1d,tf4h,tf1h,tf15,news,fhNews]=await Promise.all([
      yahooQuote(sym), yahooCandles(sym,'3mo','1d'), yahooCandles(sym,'1mo','60m'),
      yahooCandles(sym,'5d','60m'), yahooCandles(sym,'2d','15m'),
      yahooNews(sym), finnhubNews(sym),
    ]);
    if(!quote)return res.status(404).json({error:`${sym} not found`});
    const allNews=[...(fhNews.length?fhNews:news)].slice(0,4);
    const payload={ticker:sym,quote:{price:quote.price,changePct:quote.changePct,open:quote.open,high:quote.high,low:quote.low,volume:quote.volume,avgVolume:quote.avgVolume,marketCap:quote.marketCap,floatShares:quote.floatShares,yearHigh:quote.yearHigh,yearLow:quote.yearLow,sector:quote.sector},timeframes:{daily:tf1d||'unavailable',fourhour:tf4h||'unavailable',onehour:tf1h||'unavailable',fifteen:tf15||'unavailable'},recent_news:allNews.map(n=>n.headline).slice(0,3),tradingview_signal:getTvSignal(sym)};
    const verdict=await groqCall(AI_PROMPT,JSON.stringify(payload));
    if(!verdict)return res.status(503).json({error:'AI unavailable. Check GROQ_KEY.'});
    res.json({ticker:sym,verdict,data:{quote,timeframes:{daily:tf1d,fourhour:tf4h,onehour:tf1h,fifteen:tf15},news:allNews},timestamp:new Date().toISOString()});
  }catch(e){console.error('Analyze:',e);res.status(500).json({error:e.message});}
});

// Live quote auto-refresh
app.get('/api/quote/:symbol', async (req,res) => {
  const q=await yahooQuote(req.params.symbol.toUpperCase());
  if(!q)return res.status(404).json({error:'not found'});
  res.json(q);
});

// Set price alert (TradingView replacement)
app.post('/api/alert', (req,res) => {
  const{symbol,condition,value,chatId}=req.body;
  if(!symbol||!condition||!value)return res.status(400).json({error:'missing fields'});
  const sym=symbol.toUpperCase();
  if(!priceAlerts.has(sym))priceAlerts.set(sym,[]);
  priceAlerts.get(sym).push({chatId:chatId||TG_CHAT_ID,condition,value:+value,fired:false,avgVolume:null});
  addSub(sym,chatId||TG_CHAT_ID);
  res.json({ok:true,symbol:sym,condition,value:+value});
});

// Get active alerts
app.get('/api/alerts',(req,res)=>{
  const out={};for(const[s,a]of priceAlerts)out[s]=a.filter(x=>!x.fired);
  res.json(out);
});

// TradingView webhook (free tier sends no alert, but we still receive manual pings)
app.post('/webhook/tradingview',(req,res)=>{
  if((req.query.secret||req.body.secret)!==WEBHOOK_SECRET)return res.status(401).json({error:'unauthorized'});
  const{ticker,action,indicator,price,message}=req.body;
  if(!ticker||!action)return res.status(400).json({error:'missing ticker or action'});
  const sym=ticker.toUpperCase();
  tvSignals.set(sym,{action:action.toUpperCase(),indicator:indicator||'TradingView',price:parseFloat(price)||null,time:Date.now(),message:message||''});
  if(TG_CHAT_ID&&bot)tgSend(TG_CHAT_ID,`📡 *TV SIGNAL — ${sym}*\n${action.toUpperCase()} via ${indicator||'TV'} at $${price||'?'}`);
  res.json({ok:true});
});

function getTvSignal(sym){const s=tvSignals.get(sym);if(!s)return null;if(Date.now()-s.time>30*60*1000){tvSignals.delete(sym);return null;}return s;}

// Supernova scanner
app.post('/api/supernova', async(req,res)=>{
  if(!GROQ_KEY)return res.status(500).json({error:'GROQ_KEY missing'});
  try{
    let movers=[];
    try{
      const r=await fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=30&scrIds=day_gainers',{headers:{'User-Agent':'Mozilla/5.0'}});
      const d=await r.json();
      movers=(d?.finance?.result?.[0]?.quotes||[]).slice(0,25).map(q=>({symbol:q.symbol,name:q.shortName,price:q.regularMarketPrice,changePct:q.regularMarketChangePercent,volume:q.regularMarketVolume,avgVolume:q.averageDailyVolume3Month,relVolume:+(q.regularMarketVolume/(q.averageDailyVolume3Month||1)).toFixed(1),marketCap:q.marketCap,float:q.floatShares})).filter(s=>s.price&&s.price<25);
    }catch{}
    const NOVA_PROMPT=`You are the Maverick Supernova Detection Algorithm. Analyze top movers and identify TRUE supernova events.
SUPERNOVA = catalyst-driven stock where: A) 60+ min buying from shorts/float/binary catalyst B) Fade setup C) Sixth Grade Trade (12yr-old sees direction)
Score 0-100: Catalyst(30pts),Float(25pts),Velocity(20pts),Pillars(15pts),SGT(10pts)
TIERS: SUPERNOVA(85+),IGNITING(70+),WARMING(55+). Exclude below 55.
RETURN ONLY VALID JSON:
{"scan_time":"ISO","market_session":"string","market_pulse":"1-2 sentences","supernovas":[{"ticker":"","company":"","price":0,"price_change_pct":0,"float_millions":0,"catalyst":"","catalyst_type":"","halted_today":false,"trade_type":"LONG|FADE","phase":"IGNITION|FUEL_BURN|DISTRIBUTION","is_sixth_grade_trade":true,"sixth_grade_explanation":"","pillars_firing":[],"supernova_score":0,"tier":"SUPERNOVA|IGNITING|WARMING","entry_zone":"$X-$Y","stop":0,"target_1":0,"target_2":0,"risk_reward":0,"thesis":"","exit_signal":""}],"algo_note":""}`;
    const verdict=await groqCall(NOVA_PROMPT,`Today's movers:\n${JSON.stringify(movers,null,2)}\nDate:${new Date().toLocaleString()}\nReturn ONLY JSON.`,4000);
    if(!verdict)return res.status(500).json({error:'AI returned no JSON'});
    res.json(verdict);
  }catch(e){res.status(500).json({error:e.message});}
});

// Health
app.get('/api/health',(req,res)=>{
  res.json({status:'online',time:new Date().toISOString(),version:'3.1',services:{telegram:!!TELEGRAM_TOKEN,finnhub:!!FINNHUB_KEY,groq:!!GROQ_KEY,memory:!!(JSONBIN_KEY&&JSONBIN_BIN)},tv_signals_active:tvSignals.size,active_watches:watches.size,active_trades:trades.size,active_alerts:[...priceAlerts.values()].flat().filter(a=>!a.fired).length});
});

// ── TELEGRAM HANDLERS ─────────────────────────────────────────────────────────
function parseTg(text){
  const t=text.trim(); let m;
  m=t.match(/^watch(?:ing)?\s+([A-Za-z]{1,5})\s+(?:at|for)?\s*\$?(\d+\.?\d*)(?:\s+stop\s*\$?(\d+\.?\d*))?/i);
  if(m)return{cmd:'watch',symbol:m[1].toUpperCase(),price:+m[2],stop:m[3]?+m[3]:null};
  m=t.match(/^in\b.*?\$?(\d+\.?\d*)\D+(\d+)/i); if(m)return{cmd:'in',price:+m[1],shares:+m[2]};
  m=t.match(/^out\b.*?\$?(\d+\.?\d*)/i); if(m)return{cmd:'out',price:+m[1]};
  m=t.match(/^add(?:ed)?\s+(\d+)[^$\d]*\$?(\d+\.?\d*)/i); if(m)return{cmd:'add',shares:+m[1],price:+m[2]};
  m=t.match(/^(?:sl|stop)\s+\$?(\d+\.?\d*)/i); if(m)return{cmd:'sl',price:+m[1]};
  m=t.match(/^alert\s+([A-Za-z]{1,5})\s+(above|below|cross)\s+\$?(\d+\.?\d*)/i);
  if(m)return{cmd:'alert',symbol:m[1].toUpperCase(),condition:m[2].toUpperCase(),value:+m[3]};
  m=t.match(/^([A-Z]{1,5})$/); if(m)return{cmd:'quote',symbol:m[1]};
  if(/^(status|p&l|pnl)/i.test(t))return{cmd:'status'};
  if(/^(cancel|clear|reset)/i.test(t))return{cmd:'cancel'};
  if(/^(daily|today)/i.test(t))return{cmd:'daily'};
  if(/^(analyze|review)/i.test(t))return{cmd:'analyze'};
  if(/^help$/i.test(t))return{cmd:'help'};
  return null;
}

if(bot){
  bot.on('message',async msg=>{
    const cid=msg.chat.id; const text=(msg.text||'').trim(); if(!text)return;
    console.log(`[TG ${cid}] ${msg.from?.first_name}: ${text}`);
    const p=parseTg(text);
    if(!p){tgSend(cid,`Text _help_ for commands.`);return;}
    switch(p.cmd){
      case'watch':{
        tgSend(cid,`🔍 Pulling data on *${p.symbol}*...`);
        const q=await yahooQuote(p.symbol);
        if(!q){tgSend(cid,`❌ Can't find *${p.symbol}*`);return;}
        const lv=calcLevels(p.price);
        watches.set(cid,{symbol:p.symbol,entryLevel:p.price,customStop:p.stop,currentPrice:q.price,avgVolume:q.avgVolume,confirmed:false,levels:lv});
        addSub(p.symbol,cid);
        tgSend(cid,`👁 *WATCHING ${p.symbol}*\n\nTrigger: *$${p.price}* | Now: *$${q.price?.toFixed(2)}*\n\n🛑 Stop: *$${p.stop||lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n\n🔴 Live Finnhub monitoring active`);
        break;}
      case'in':{
        const w=watches.get(cid);
        if(!w){tgSend(cid,`Set a watch first: _watching LFVN at 5.10_`);return;}
        const lv=calcLevels(p.price);
        const tr={symbol:w.symbol,entryPrice:p.price,shares:p.shares,entryTime:Date.now(),currentPrice:p.price,hwm:p.price,avgCost:p.price,stopLoss:w.customStop||lv.stop,trailingStop:lv.stop,targets:{t1:lv.t1,t2:lv.t2,t3:lv.t3},avgVolume:w.avgVolume,adds:[],t1Hit:false,t2Hit:false,stopAlerted:false,trailAlerted:false,warn45:false,warn90:false,addSent:false};
        trades.set(cid,tr);watches.delete(cid);addSub(w.symbol,cid);
        tgSend(cid,`✅ *IN — ${w.symbol}*\n\n*$${p.price}* × *${p.shares} shares* = *$${(p.price*p.shares).toFixed(2)}*\n\n🛑 STOP: *$${tr.stopLoss}* (max -$${(lv.risk*p.shares).toFixed(2)})\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n🎯 T3: *$${lv.t3}* 🚀\n\n🔴 Monitoring: stop·targets·trail·45min·add`);
        break;}
      case'out':{
        const tr=trades.get(cid);
        if(!tr){tgSend(cid,`No active trade.`);return;}
        const pnl=totalPnl(tr,p.price);const ts=totalShares(tr);const mins=((Date.now()-tr.entryTime)/60000).toFixed(0);const pct=(((p.price-tr.avgCost)/tr.avgCost)*100).toFixed(2);
        await logTrade({symbol:tr.symbol,date:new Date().toISOString().split('T')[0],entryPrice:tr.entryPrice,exitPrice:p.price,shares:ts,avgCost:tr.avgCost,pnl,pnlPct:+pct,minutesInTrade:+mins,t1Hit:tr.t1Hit,t2Hit:tr.t2Hit});
        removeSub(tr.symbol,cid);trades.delete(cid);
        tgSend(cid,`${pnl>0?'💰':'📉'} *CLOSED — ${tr.symbol}*\n\n$${tr.entryPrice} → *$${p.price}* | ${ts} shares | ${mins}min\n\n${pnl>0?'✅':'❌'} *P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}* (${pct}%)\n\n${pnl>0?'🔥 Banked. Well executed, Maverick.':'💪 Stop respected. Next setup.'}\nText _daily_ for today's P&L.`);
        break;}
      case'add':{const tr=trades.get(cid);if(!tr){tgSend(cid,`No active trade.`);return;}tr.adds.push({shares:p.shares,price:p.price});tr.avgCost=avgCostCalc(tr);tgSend(cid,`📈 *ADDED — ${tr.symbol}*\n+${p.shares} @ $${p.price} | Total: ${totalShares(tr)} | Avg: *$${tr.avgCost}*`);break;}
      case'sl':{const tr=trades.get(cid);const w=watches.get(cid);if(tr){tr.stopLoss=p.price;tr.stopAlerted=false;tgSend(cid,`✅ Stop → *$${p.price}* on *${tr.symbol}*`);}else if(w){w.customStop=p.price;tgSend(cid,`✅ Stop set → *$${p.price}*`);}else tgSend(cid,`No active trade.`);break;}
      case'alert':{
        if(!priceAlerts.has(p.symbol))priceAlerts.set(p.symbol,[]);
        priceAlerts.get(p.symbol).push({chatId:cid,condition:p.condition,value:p.value,fired:false,avgVolume:null});
        addSub(p.symbol,cid);
        tgSend(cid,`🔔 *ALERT SET — ${p.symbol}*\nFires when price ${p.condition} *$${p.value}*\n\n✅ No TradingView Pro needed.\nMonitoring via Finnhub real-time feed.`);
        break;}
      case'quote':{const q=await yahooQuote(p.symbol);if(!q){tgSend(cid,`❌ *${p.symbol}* not found.`);return;}const chg=(q.changePct>=0?'+':'')+q.changePct?.toFixed(2)+'%';tgSend(cid,`📊 *${p.symbol}* — *$${q.price?.toFixed(2)}* (${chg})\nH:$${q.high?.toFixed(2)} L:$${q.low?.toFixed(2)}\nVol:${q.volume?(q.volume/1e6).toFixed(2)+'M':'—'} Float:${q.floatShares?(q.floatShares/1e6).toFixed(1)+'M':'—'}\n\nText: _watching ${p.symbol} at ${q.price?.toFixed(2)}_`);break;}
      case'status':{
        const tr=trades.get(cid);const w=watches.get(cid);
        if(tr){const price=tr.currentPrice||tr.entryPrice;const pnl=totalPnl(tr,price);const mins=((Date.now()-tr.entryTime)/60000).toFixed(0);tgSend(cid,`📊 *LIVE — ${tr.symbol}*\n\nEntry: $${tr.entryPrice} | Now: *$${price.toFixed(2)}*\nP&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}* | ${mins}min\n\n🛑 Stop: *$${tr.stopLoss}*\n🔄 Trail: *$${tr.trailingStop}*\n🎯 T1: $${tr.targets.t1} ${tr.t1Hit?'✅':'⏳'} | T2: $${tr.targets.t2} ${tr.t2Hit?'✅':'⏳'}`);}
        else if(w)tgSend(cid,`👁 Watching *${w.symbol}* → $${w.entryLevel} | Now: $${w.currentPrice?.toFixed(2)||'...'}`)
        else tgSend(cid,`No active trade.\n_watching [TICKER] at [price]_`);
        break;}
      case'cancel':{const sym=watches.get(cid)?.symbol||trades.get(cid)?.symbol;if(sym)removeSub(sym,cid);watches.delete(cid);trades.delete(cid);tgSend(cid,`✅ Cleared. Ready.\n_watching [TICKER] at [price]_`);break;}
      case'daily':{
        const mem=await memLoad();const today=new Date().toISOString().split('T')[0];
        const list=(mem.trades||[]).filter(t=>t.date===today);
        if(!list.length){tgSend(cid,`No trades logged today. Close with _out at [price]_`);return;}
        const total=list.reduce((s,t)=>s+t.pnl,0);const wins=list.filter(t=>t.pnl>0);
        tgSend(cid,`📊 *TODAY*\n\nTrades: *${list.length}* | Wins: *${wins.length}* (${((wins.length/list.length)*100).toFixed(0)}%)\nTotal P&L: *${total>=0?'+':''}$${total.toFixed(2)}*\n\n`+list.map(t=>`${t.pnl>=0?'✅':'❌'} ${t.symbol} ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)} (${t.minutesInTrade}min)`).join('\n'));
        break;}
      case'analyze':{
        if(!GROQ_KEY){tgSend(cid,`Add GROQ_KEY for AI analysis.`);return;}
        const mem=await memLoad();const tlist=(mem.trades||[]).slice(-20);
        if(tlist.length<3){tgSend(cid,`Need 3+ completed trades for AI analysis.`);return;}
        tgSend(cid,`🤖 Analyzing your last ${tlist.length} trades...`);
        const summary=tlist.map(t=>`${t.symbol}: ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}, ${t.minutesInTrade}min, T1:${t.t1Hit}`).join('\n');
        const ai=await groqCall('You are an aggressive day trading coach. Identify 3 specific mistakes and 2 strengths. Be direct, use exact numbers from the data.',`Trades:\n${summary}`,400);
        tgSend(cid,`🤖 *AI TRADE REVIEW*\n\n${ai?JSON.stringify(ai):'Analysis unavailable.'}`);
        break;}
      case'help':tgSend(cid,`🤖 *MAVERICK BOT v3.1*\n\n*TRADE:*\n_watching LFVN at 5.10_ — watch\n_watching LFVN at 5.10 stop 4.80_ — custom stop\n_in at 5.11 with 200 shares_ — log entry\n_added 100 at 5.50_ — add\n_sl 4.88_ — change stop\n_out at 5.85_ — close + log\n_status_ — live P&L\n_cancel_ — reset\n\n*ALERTS (no TradingView needed):*\n_alert LFVN above 5.50_ — price breakout alert\n_alert LFVN below 4.80_ — stop zone alert\n\n*REPORTS:*\n_daily_ — today's P&L\n_analyze_ — AI reviews your trades\n_LFVN_ — quick quote`);break;
    }
  });
  bot.on('polling_error',e=>console.error('Polling:',e.message));
}

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

connectFinnhub();
const PORT=process.env.PORT||3000;
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n🚀 MAVERICK TERMINAL v3.1 — Port ${PORT}`);
  console.log(`   Telegram: ${TELEGRAM_TOKEN?'✅':'❌'} | Finnhub: ${FINNHUB_KEY?'✅':'❌'} | Groq: ${GROQ_KEY?'✅':'❌'} | Memory: ${JSONBIN_KEY?'✅':'⚠️ optional'}`);
  console.log(`   TV Webhook: /webhook/tradingview?secret=${WEBHOOK_SECRET}\n`);
});
