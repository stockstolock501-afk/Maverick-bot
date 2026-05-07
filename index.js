// ═══════════════════════════════════════════════════════════════════════════
// MAVERICK TERMINAL v3.4 — COMPLETE CONSOLIDATED
// Fixes: Groq models · Fresh news · Catalyst scan · Chart tab
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

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── GROQ — CORRECT MODELS FROM YOUR ACCOUNT ──────────────────────────────────
// Source: your /api/groq-test showed these are live on your account
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',        // primary — your main model
  'llama-3.1-8b-instant',           // fast fallback
  'meta-llama/llama-4-scout-17b-16e-instruct', // newer fallback
  'qwen-qwq-32b',                   // additional fallback
];

async function groqCall(system, user, maxTokens = 1500) {
  if (!GROQ_KEY) { console.error('GROQ_KEY missing'); return null; }
  for (const model of GROQ_MODELS) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.25, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!r.ok) { const err = await r.text(); console.error(`Groq [${model}] ${r.status}: ${err.slice(0,150)}`); continue; }
      const d = await r.json();
      const text = d.choices?.[0]?.message?.content || '';
      if (!text) { console.error(`Groq [${model}] empty`); continue; }
      const m = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim().match(/\{[\s\S]*\}/);
      if (!m) { console.error(`Groq [${model}] no JSON`); continue; }
      return JSON.parse(m[0]);
    } catch (e) { console.error(`Groq [${model}]: ${e.message}`); }
  }
  return null;
}

async function groqText(system, user, maxTokens = 500) {
  if (!GROQ_KEY) return null;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: maxTokens, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
let bot = null;
async function initTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    await new Promise(r => setTimeout(r, 1000));
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { interval: 2000, params: { timeout: 10, allowed_updates: ['message'] } } });
    console.log('✅ Telegram started');
    setupTelegramHandlers();
  } catch (e) { console.error('TG init:', e.message); }
}
function tgSend(chatId, text) { if (!bot || !chatId) return; bot.sendMessage(String(chatId), text, { parse_mode: 'Markdown' }).catch(e => console.error('TG:', e.message)); }

// ── STATE ─────────────────────────────────────────────────────────────────────
const watches      = new Map();
const trades       = new Map();
const priceAlerts  = new Map();
const subscribers  = new Map();
const volTracker   = new Map();
const tvSignals    = new Map();
const chatSessions = new Map();
const scanCache    = new Map();

// ── FINNHUB WS ────────────────────────────────────────────────────────────────
let ws;
function connectFinnhub() {
  if (!FINNHUB_KEY) return;
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => { console.log('✅ Finnhub WS'); for (const s of subscribers.keys()) ws.send(JSON.stringify({ type:'subscribe', symbol:s })); });
  ws.on('message', raw => { try { const m=JSON.parse(raw); if(m.type==='trade'&&Array.isArray(m.data)) m.data.forEach(t=>onTick(t.s,t.p,t.v)); } catch {} });
  ws.on('close', () => setTimeout(connectFinnhub, 5000));
  ws.on('error', e => { if (!e.message.includes('429')) console.error('WS:', e.message); });
}
function wsSend(s,a){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:a,symbol:s}));}
function addSub(s,id){if(!subscribers.has(s))subscribers.set(s,new Set());if(!subscribers.get(s).size)wsSend(s,'subscribe');subscribers.get(s).add(id);}
function removeSub(s,id){const x=subscribers.get(s);if(!x)return;x.delete(id);if(!x.size){subscribers.delete(s);wsSend(s,'unsubscribe');}}

// ═══════════════════════════════════════════════════════════════════════════
// DATA LAYER
// ═══════════════════════════════════════════════════════════════════════════

async function getQuote(symbol) {
  const sym = symbol.toUpperCase();
  if (FINNHUB_KEY) {
    try {
      const [qr, pr] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`),
        fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${FINNHUB_KEY}`),
      ]);
      const q = await qr.json(); const p = await pr.json();
      if (q?.c > 0) { const ch=q.c-q.pc; return { price:q.c, change:ch, changePct:q.pc?(ch/q.pc)*100:0, open:q.o, high:q.h, low:q.l, prevClose:q.pc, marketCap:p?.marketCapitalization?p.marketCapitalization*1e6:null, floatShares:p?.shareOutstanding?p.shareOutstanding*1e6:null, sector:p?.finnhubIndustry||null, shortName:p?.name||sym, source:'finnhub' }; }
    } catch (e) { console.error('Finnhub quote:', e.message); }
  }
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`, { headers:{'User-Agent':'Mozilla/5.0','Referer':'https://finance.yahoo.com/','Cache-Control':'no-cache'} });
    const d = await r.json(); const q = d?.quoteResponse?.result?.[0];
    if (q?.regularMarketPrice) return { price:q.regularMarketPrice, change:q.regularMarketChange, changePct:q.regularMarketChangePercent, open:q.regularMarketOpen, high:q.regularMarketDayHigh, low:q.regularMarketDayLow, prevClose:q.regularMarketPreviousClose, volume:q.regularMarketVolume, avgVolume:q.averageDailyVolume3Month, marketCap:q.marketCap, floatShares:q.floatShares, yearHigh:q.fiftyTwoWeekHigh, yearLow:q.fiftyTwoWeekLow, sector:q.sector, shortName:q.shortName, preMarket:q.preMarketPrice, preMarketChangePct:q.preMarketChangePercent, source:'yahoo' };
  } catch (e) { console.error('Yahoo:', e.message); }
  return null;
}

async function getCandles(symbol, range, interval) {
  try {
    const bust = `&_=${Date.now()}`; // cache bust
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}${bust}`, { headers:{'User-Agent':'Mozilla/5.0','Referer':'https://finance.yahoo.com/','Cache-Control':'no-cache'} });
    const d = await r.json(); const res = d?.chart?.result?.[0]; if(!res)return null;
    const q=res.indicators?.quote?.[0]; const ts=res.timestamp||[]; if(!q||!ts.length)return null;
    const candles=ts.map((t,i)=>({t,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:q.volume?.[i]})).filter(c=>c.c!=null);
    if(!candles.length)return null;
    const closes=candles.map(c=>c.c); const last=closes[closes.length-1]; const first=closes[0];
    const high=Math.max(...candles.map(c=>c.h)); const low=Math.min(...candles.map(c=>c.l));
    const avgVol=candles.reduce((s,c)=>s+(c.v||0),0)/candles.length; const lastVol=candles[candles.length-1]?.v||0;
    const ema9=closes.reduce((e,c,i)=>i===0?c:c*(2/10)+e*(8/10),closes[0]);
    const gains=[],losses=[];
    for(let i=1;i<Math.min(closes.length,15);i++){const df=closes[i]-closes[i-1];df>0?gains.push(df):losses.push(Math.abs(df));}
    const ag=gains.reduce((s,v)=>s+v,0)/(gains.length||1); const al=losses.reduce((s,v)=>s+v,0)/(losses.length||1);
    const rsi=al===0?100:100-(100/(1+ag/al));
    const atr=candles.slice(-14).reduce((s,c)=>s+(c.h-c.l),0)/Math.min(14,candles.length);
    return { range,interval,pctChange:+((last-first)/first*100).toFixed(2),trend:last>closes[Math.floor(closes.length/2)]?'UP':'DOWN',high,low,last,ema9:+ema9.toFixed(3),rsi:+rsi.toFixed(1),relVolume:+(lastVol/avgVol).toFixed(2),atr:+atr.toFixed(3),candleCount:candles.length };
  } catch(e){return null;}
}

// ── FRESH NEWS — Multiple sources, real-time ──────────────────────────────────
async function getFreshNews(symbol) {
  const news = [];
  // Source 1: Finnhub company news (most reliable)
  if (FINNHUB_KEY) {
    try {
      const to=new Date().toISOString().split('T')[0]; const from=new Date(Date.now()-3*86400000).toISOString().split('T')[0];
      const r=await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${FINNHUB_KEY}&_=${Date.now()}`);
      const d=await r.json();
      if(Array.isArray(d)) d.slice(0,5).forEach(n=>news.push({headline:n.headline,source:n.source,url:n.url,datetime:n.datetime,ageH:+((Date.now()/1000-n.datetime)/3600).toFixed(1)}));
    } catch {}
  }
  // Source 2: Yahoo Finance search news
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5&_=${Date.now()}`,{headers:{'User-Agent':'Mozilla/5.0'}});
    const d=await r.json();
    (d?.news||[]).slice(0,3).forEach(n=>{if(!news.find(x=>x.headline===n.title))news.push({headline:n.title,source:n.publisher,url:n.link,datetime:n.providerPublishTime,ageH:+((Date.now()/1000-(n.providerPublishTime||0))/3600).toFixed(1)});});
  } catch {}
  return news.sort((a,b)=>b.datetime-a.datetime).slice(0,6);
}

async function getMarketNewsFresh() {
  const news = [];
  if (FINNHUB_KEY) {
    try {
      const r=await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}&_=${Date.now()}`);
      const d=await r.json();
      if(Array.isArray(d)) { const recent=d.filter(n=>(Date.now()/1000-n.datetime)<7200); recent.forEach(n=>news.push({headline:n.headline,source:n.source,url:n.url,datetime:n.datetime,related:n.related,ageH:+((Date.now()/1000-n.datetime)/3600).toFixed(1)})); }
    } catch {}
    // Also get Finnhub merger/biotech news
    try {
      const r=await fetch(`https://finnhub.io/api/v1/news?category=merger&token=${FINNHUB_KEY}&_=${Date.now()}`);
      const d=await r.json();
      if(Array.isArray(d)) d.filter(n=>(Date.now()/1000-n.datetime)<7200).forEach(n=>news.push({headline:n.headline,source:n.source,url:n.url,datetime:n.datetime,related:n.related,ageH:+((Date.now()/1000-n.datetime)/3600).toFixed(1)}));
    } catch {}
  }
  return news.sort((a,b)=>b.datetime-a.datetime).slice(0,40);
}

async function getSEC8K() {
  try {
    const r=await fetch(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=20&search_text=&output=atom&_=${Date.now()}`,{headers:{'User-Agent':'MaverickBot/1.0 bot@maverick.com'}});
    const text=await r.text(); const items=[]; const regex=/<entry>([\s\S]*?)<\/entry>/g; let m;
    while((m=regex.exec(text))!==null){const entry=m[1];const title=(/<title>(.*?)<\/title>/.exec(entry)||[])[1]||'';const link=(/<link.*?href="(.*?)"/.exec(entry)||[])[1]||'';const updated=(/<updated>(.*?)<\/updated>/.exec(entry)||[])[1]||'';const ageMin=(Date.now()-new Date(updated).getTime())/60000;items.push({headline:title,source:'SEC-8K',url:link,datetime:new Date(updated).getTime()/1000,ageH:+(ageMin/60).toFixed(1)});}
    return items.slice(0,15);
  } catch{return[];}
}

// ── LUXALGO SIGNAL ENGINE ─────────────────────────────────────────────────────
function luxAlgoSignal(candles) {
  if(!candles||candles.candleCount<20)return null;
  const{last:price,high,low,ema9,rsi,atr,relVolume,trend,pctChange}=candles;
  const atrVal=atr||(high-low)*0.5;
  const ema21=ema9*(trend==='UP'?0.985:1.015);
  const ema50=ema9*(trend==='UP'?0.970:1.030);
  const upperBand=+(ema21+atrVal*1.5).toFixed(2);
  const lowerBand=+(ema21-atrVal*1.5).toFixed(2);
  const bullishFan=ema9>ema21&&ema21>ema50;
  const bearishFan=ema9<ema21&&ema21<ema50;
  const bandPosition=atrVal>0?(price-lowerBand)/(upperBand-lowerBand):0.5;
  const bullishOB=+(low+(high-low)*0.15).toFixed(2);
  const fvgDetected=atrVal>(high-low)*0.3&&relVolume>2;
  const fvgLevel=+(trend==='UP'?low+atrVal*0.5:high-atrVal*0.5).toFixed(2);
  const bullishBOS=trend==='UP'&&pctChange>3&&relVolume>1.5;
  const bullishPts=[bullishFan,price>ema21,rsi>40&&rsi<65,relVolume>1.2,bullishBOS,Math.abs(price-bullishOB)/price<0.05,fvgDetected&&trend==='UP'].filter(Boolean).length;
  const bearishPts=[bearishFan,price<ema21,rsi<50&&rsi>30,relVolume>1.2,trend==='DOWN'&&pctChange<-3&&relVolume>1.5,Math.abs(price-(high-(high-low)*0.15))/price<0.05].filter(Boolean).length;
  let signalType='NEUTRAL',signalStrength=0,tpLevel=null,tp2Level=null,slLevel=null;
  if(bullishPts>=4&&rsi<70){signalType='BUY';signalStrength=Math.round(bullishPts/7*100);tpLevel=+(price+atrVal*2).toFixed(2);tp2Level=+(price+atrVal*3.5).toFixed(2);slLevel=+(price-atrVal*1.5).toFixed(2);}
  else if(bearishPts>=4&&rsi>30){signalType='SELL';signalStrength=Math.round(bearishPts/6*100);tpLevel=+(price-atrVal*2).toFixed(2);slLevel=+(price+atrVal*1.5).toFixed(2);}
  return{signalType,signalStrength,tpLevel,tp2Level,slLevel,ema9:+ema9.toFixed(2),ema21:+ema21.toFixed(2),upperBand,lowerBand,atrVal:+atrVal.toFixed(3),bullishOB,fvgDetected,fvgLevel,bos:bullishBOS?'BULLISH':trend==='DOWN'&&pctChange<-3?'BEARISH':'NONE',bandPosition:+bandPosition.toFixed(2),rsi,trend,confluenceScore:bullishPts+'/7'};
}

// ── TRADE MATH ────────────────────────────────────────────────────────────────
function calcLevels(entry){const sp=entry<5?0.035:entry<15?0.028:0.02;const stop=+(entry*(1-sp)).toFixed(2);const risk=entry-stop;return{stop,t1:+(entry+risk*2).toFixed(2),t2:+(entry+risk*3.5).toFixed(2),t3:+(entry+risk*5.5).toFixed(2),risk:+risk.toFixed(2)};}
function totalShares(tr){return tr.shares+tr.adds.reduce((s,a)=>s+a.shares,0);}
function avgCostCalc(tr){return+((tr.entryPrice*tr.shares+tr.adds.reduce((s,a)=>s+a.price*a.shares,0))/totalShares(tr)).toFixed(2);}
function totalPnl(tr,p){return+((p-tr.entryPrice)*tr.shares+tr.adds.reduce((s,a)=>s+(p-a.price)*a.shares,0)).toFixed(2);}

// ── TICK HANDLER ──────────────────────────────────────────────────────────────
function onTick(sym,price,vol){
  if(!volTracker.has(sym))volTracker.set(sym,{v1m:0,reset:Date.now()});
  const vt=volTracker.get(sym);if(Date.now()-vt.reset>60000){vt.v1m=0;vt.reset=Date.now();}vt.v1m+=vol;
  for(const[cid,w]of watches){if(w.symbol!==sym||w.confirmed)continue;w.currentPrice=price;if(price>=w.entryLevel){const apr=w.avgVolume?w.avgVolume/390:null;const vr=apr?vt.v1m/apr:99;if(vr>=1.5){w.confirmed=true;const lv=calcLevels(price);tgSend(cid,`🔥 *ENTRY CONFIRMED — ${sym}*\n\n$${price.toFixed(2)} | Vol: *${vr.toFixed(1)}x*\n\n🛑 Stop: *$${lv.stop}*\n🎯 T1: *$${lv.t1}*\n🎯 T2: *$${lv.t2}*\n\nText: _in at ${price.toFixed(2)} with 200 shares_`);}}}
  const alerts=priceAlerts.get(sym)||[];
  for(const a of alerts){if(a.fired)continue;const hit=(a.condition==='ABOVE'&&price>=a.value)||(a.condition==='BELOW'&&price<=a.value);if(hit){a.fired=true;tgSend(a.chatId,`${a.condition==='ABOVE'?'🚀':'🔻'} *ALERT — ${sym}*\n$${price.toFixed(2)} ${a.condition} $${a.value}\nText: _watching ${sym} at ${price.toFixed(2)}_`);}}
  for(const[cid,tr]of trades){
    if(tr.symbol!==sym)continue;const prev=tr.currentPrice||tr.entryPrice;tr.currentPrice=price;
    const mins=(Date.now()-tr.entryTime)/60000;const pnl=totalPnl(tr,price);const apr=tr.avgVolume?tr.avgVolume/390:null;const vr=apr?vt.v1m/apr:0;
    if(price>tr.hwm){tr.hwm=price;if(tr.t1Hit){const trail=+(price-(price-tr.avgCost)*0.40).toFixed(2);if(trail>tr.trailingStop)tr.trailingStop=trail;}}
    if(!tr.stopAlerted&&price<=tr.stopLoss){tr.stopAlerted=true;tgSend(cid,`🚨 *STOP HIT — ${tr.symbol}*\n$${price.toFixed(2)}\nP&L: -$${Math.abs(pnl).toFixed(2)}\n❌ *EXIT NOW.*`);}
    if(tr.t1Hit&&!tr.trailAlerted&&price<=tr.trailingStop){tr.trailAlerted=true;tgSend(cid,`⚠️ *TRAIL STOP — ${tr.symbol}*\nLocked: +$${pnl.toFixed(2)}\nText: _out at ${price.toFixed(2)}_`);}
    if(!tr.t1Hit&&price>=tr.targets.t1){tr.t1Hit=true;tr.stopLoss=tr.avgCost;tr.stopAlerted=false;tr.trailAlerted=false;tgSend(cid,`🎯 *T1 HIT — ${tr.symbol}* +$${totalPnl(tr,tr.targets.t1).toFixed(2)}\n✅ Sell 50% | Stop→BE $${tr.avgCost}`);}
    if(!tr.t2Hit&&price>=tr.targets.t2){tr.t2Hit=true;tgSend(cid,`🎯🎯 *T2 HIT — ${tr.symbol}* +$${totalPnl(tr,tr.targets.t2).toFixed(2)}`);}
    if(!tr.addSent&&tr.t1Hit&&!tr.t2Hit){const pg=((price-tr.avgCost)/tr.avgCost)*100;if(pg>4&&vr>2&&price>prev*0.995){tr.addSent=true;tgSend(cid,`📈 *ADD SIGNAL — ${tr.symbol}*\nVol:${vr.toFixed(1)}x | +${pg.toFixed(1)}%\nText: _added 100 at ${price.toFixed(2)}_`);}}
    if(!tr.warn45&&mins>=45){tr.warn45=true;tgSend(cid,`⏱ *45-MIN — ${tr.symbol}*\n${mins.toFixed(0)}min | ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);}
    if(!tr.warn90&&mins>=90){tr.warn90=true;tgSend(cid,`🚨 *90-MIN — ${tr.symbol}*\nText: _out at ${price.toFixed(2)}_`);}
  }
}

// ── MEMORY ────────────────────────────────────────────────────────────────────
async function memLoad(){if(!JSONBIN_KEY||!JSONBIN_BIN)return{trades:[],scans:[]};try{const r=await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`,{headers:{'X-Master-Key':JSONBIN_KEY}});const d=await r.json();return d.record||{trades:[],scans:[]};}catch{return{trades:[],scans:[]};}}
async function memSave(rec){if(!JSONBIN_KEY||!JSONBIN_BIN)return;try{await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},body:JSON.stringify(rec)});}catch{}}
async function logTrade(entry){const m=await memLoad();m.trades=m.trades||[];m.trades.push({...entry,id:Date.now()});await memSave(m);}

// ═══════════════════════════════════════════════════════════════════════════
// AI PROMPTS
// ═══════════════════════════════════════════════════════════════════════════
const ANALYZE_PROMPT=`You are MAVERICK — aggressive, decisive day trading AI. Use ALL timeframes. LuxAlgo signals are primary confirmation.
VERDICTS: BUY | DONT_BUY | WATCH. Stop=1.5xATR. T1=2x risk. T2=3.5x.
RETURN ONLY VALID JSON:
{"verdict":"BUY|DONT_BUY|WATCH","conviction":0-100,"headline":"one decisive sentence","chart_pattern":"pattern","timeframe_alignment":"BULLISH|BEARISH|MIXED|NEUTRAL","reasoning":["bullet1","bullet2","bullet3"],"entry_zone":{"low":0.00,"high":0.00},"stop_loss":0.00,"target_1":0.00,"target_2":0.00,"target_3":0.00,"risk_reward":0.0,"position_size_suggestion":"AGGRESSIVE|STANDARD|SMALL","trade_type":"DAY_TRADE|SWING|SCALP","key_risk":"specific risk","trigger_to_watch":"if WATCH","time_horizon":"estimate"}`;

const CATALYST_PROMPT=`You are MAVERICK Catalyst Intelligence. Find HIGH CONVICTION catalysts: FDA approval=95pts, Merger/acquisition=93pts, Gov contract>2x mktcap=92pts, Oversubscribed placement=88pts, Earnings beat>30%=87pts.
Only return score>=75. US-listed only. Fresh news only (<8 hours old).
RETURN ONLY VALID JSON — if nothing qualifies return {"catalysts":[]}:
{"catalysts":[{"ticker":"","company_name":"","catalyst_headline":"","catalyst_type":"FDA|MERGER|CONTRACT|PLACEMENT|EARNINGS|OTHER","catalyst_score":0,"sixth_grade_explanation":"plain English","price_impact_probability":0,"estimated_move_pct":"X-Y%","time_sensitivity":"PRE-MARKET|TODAY|THIS_WEEK","source":""}]}`;

const ADVISOR_PROMPT=`You are MAVERICK's personal hedge fund AI advisor. Portfolio: $348 (keep $100 reserve, tradeable=$248, max/trade=$86).
Phase 2/3 player. Sub-$10. Aggressive. Never fights dilution/ATMs.
Position size formula: Risk=(entry-stop), Shares=max_risk/risk. Max risk=3% of portfolio.
Direct and decisive. Under 200 words. Use exact numbers.`;

// ═══════════════════════════════════════════════════════════════════════════
// CATALYST SCANNER — FIXED VERSION
// ═══════════════════════════════════════════════════════════════════════════
const scannedHeadlines = new Set();
let lastCatalystScan = 0;

async function runCatalystScan(manual = false) {
  if (!GROQ_KEY) { console.log('Catalyst scan: no GROQ_KEY'); return; }
  const now = Date.now();
  if (!manual && now - lastCatalystScan < 28 * 60 * 1000) return;
  lastCatalystScan = now;
  console.log('⚡ Running catalyst scan...');
  try {
    const [marketNews, secFilings] = await Promise.all([getMarketNewsFresh(), getSEC8K()]);
    const allNews = [...marketNews, ...secFilings]
      .filter(n => n.headline && !scannedHeadlines.has(n.headline) && n.ageH < 8)
      .slice(0, 35);

    console.log(`Catalyst scan: ${allNews.length} fresh items to analyze`);
    if (!allNews.length) { console.log('No fresh news to scan'); return; }

    const newsText = allNews.map(n => `HEADLINE: ${n.headline}\nSOURCE: ${n.source}\nAGE: ${n.ageH}h ago\nTICKER: ${n.related || 'unknown'}`).join('\n---\n');

    // Use groqText for non-JSON parsing
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: 2000, temperature: 0.2, messages: [{ role: 'system', content: CATALYST_PROMPT }, { role: 'user', content: `Analyze these news items for high-conviction catalysts (score≥75 only):\n\n${newsText}\n\nReturn ONLY valid JSON.` }] })
    });
    if (!r.ok) { console.error('Catalyst Groq error:', r.status); return; }
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content || '';
    const m = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim().match(/\{[\s\S]*\}/);
    if (!m) { console.log('Catalyst: AI returned no JSON'); return; }
    const result = JSON.parse(m[0]);

    if (!result?.catalysts?.length) { console.log('Catalyst scan: no qualifying catalysts found'); return; }

    for (const c of result.catalysts) {
      if (!c.catalyst_headline || scannedHeadlines.has(c.catalyst_headline)) continue;
      scannedHeadlines.add(c.catalyst_headline);
      if (TG_CHAT_ID && bot) {
        const emoji = c.catalyst_score >= 90 ? '🚨🚨' : '🚨';
        tgSend(TG_CHAT_ID, `${emoji} *CATALYST DETECTED*\n\n*${c.ticker || 'SEE BELOW'}* — ${c.company_name}\n\n📰 ${c.catalyst_headline}\n\n🎯 Score: *${c.catalyst_score}/100*\n📈 Probability: *${c.price_impact_probability}%*\n🚀 Move: *${c.estimated_move_pct}*\n📚 ${c.sixth_grade_explanation}\n\nReply: _dive ${c.ticker || 'TICKER'}_`);
      }
    }
    console.log(`Catalyst scan: ${result.catalysts.length} alerts sent`);
  } catch (e) { console.error('Catalyst scan error:', e.message); }
}

function scheduleCatalystScans() {
  setInterval(() => runCatalystScan(false), 28 * 60 * 1000);
  setInterval(() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = et.getHours(); const m = et.getMinutes(); const isWeekday = et.getDay() > 0 && et.getDay() < 6;
    if (!isWeekday) return;
    if ((h === 4 || h === 6 || h === 8) && m < 2) runCatalystScan(false);
  }, 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTINUOUS SCANNER
// ═══════════════════════════════════════════════════════════════════════════
let scanCycleCount = 0;
function getScanInterval() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(); const min = et.getMinutes(); const total = h * 60 + min;
  const isWeekday = et.getDay() > 0 && et.getDay() < 6;
  if (!isWeekday || total < 4*60 || total >= 16*60) return null;
  if (total < 9.5*60) return 3; if (total < 11*60) return 1.5; if (total < 15.5*60) return 4; return 1.5;
}

async function continuousScanCycle() {
  if (!getScanInterval()) return;
  scanCycleCount++;
  const candidates = new Set();
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=day_gainers', { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com/', 'Cache-Control': 'no-cache' } });
    const d = await r.json();
    (d?.finance?.result?.[0]?.quotes || []).filter(q => q.regularMarketPrice < 10 && q.regularMarketChangePercent > 15).forEach(q => candidates.add(q.symbol));
  } catch {}
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=most_actives', { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } });
    const d = await r.json();
    (d?.finance?.result?.[0]?.quotes || []).filter(q => { const rv = q.regularMarketVolume / (q.averageDailyVolume3Month || 1); return q.regularMarketPrice < 10 && rv > 8; }).forEach(q => candidates.add(q.symbol));
  } catch {}
  for (const sym of [...candidates].slice(0, 6)) {
    const last = scanCache.get(sym);
    if (last && (Date.now() - last) < 90 * 60 * 1000) continue;
    try {
      const [quote, tf1d, tf15, news] = await Promise.all([getQuote(sym), getCandles(sym, '3mo', '1d'), getCandles(sym, '2d', '15m'), getFreshNews(sym)]);
      if (!quote) continue;
      let score = 0;
      if (news.length > 0 && news[0].ageH < 4) score++;
      if (quote.floatShares && quote.floatShares < 5e6) score++;
      if (quote.price >= 0.5 && quote.price <= 10) score++;
      if (tf1d && tf1d.relVolume >= 5) score++;
      if (Math.abs(quote.changePct || 0) >= 15) score++;
      if (tf15 && tf15.trend === 'UP' && tf15.rsi > 50 && tf15.rsi < 75) score++;
      if (tf1d) { const lux = luxAlgoSignal(tf1d); if (lux?.signalType === 'BUY' && lux.signalStrength > 50) score++; }
      if (score >= 4 && TG_CHAT_ID && bot) {
        scanCache.set(sym, Date.now());
        const tier = score >= 7 ? '🚨🚨🚨 PERFECT TRADE' : score >= 6 ? '🚨🚨 NEAR PERFECT' : '🚨 STRONG SETUP';
        tgSend(TG_CHAT_ID, `${tier} — *${sym}*\nScore: *${score}/7* conditions\n$${quote.price?.toFixed(2)} | +${quote.changePct?.toFixed(1)}%\n\nText: _dive ${sym}_`);
      }
      await new Promise(r => setTimeout(r, 300));
    } catch {}
  }
}

function startContinuousScanner() {
  console.log('🔄 Continuous scanner armed (4am-4pm ET)');
  const run = async () => { await continuousScanCycle().catch(e => console.error('Scan:', e.message)); const iv = getScanInterval(); setTimeout(run, (iv || 5) * 60 * 1000); };
  setTimeout(run, 30000);
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Groq test
app.get('/api/groq-test', async (req, res) => {
  if (!GROQ_KEY) return res.json({ error: 'GROQ_KEY not set', key_present: false });
  try {
    const modelsR = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': `Bearer ${GROQ_KEY}` } });
    const modelsD = await modelsR.json();
    const testR = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: GROQ_MODELS[0], max_tokens: 10, messages: [{ role: 'user', content: 'Say OK' }] }) });
    const testD = await testR.json();
    res.json({ key_present: true, key_starts_with: GROQ_KEY.slice(0,8)+'...', models_status: modelsR.status, models_available: modelsD.data?.map(m => m.id) || modelsD, completion_status: testR.status, completion_result: testD.choices?.[0]?.message?.content || testD });
  } catch (e) { res.json({ error: e.message }); }
});

// Analyze
app.post('/api/analyze', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).json({ error: 'no ticker' });
  const sym = ticker.toUpperCase().trim();
  try {
    const [quote, tf1d, tf4h, tf1h, tf15, news] = await Promise.all([getQuote(sym), getCandles(sym,'3mo','1d'), getCandles(sym,'1mo','60m'), getCandles(sym,'5d','60m'), getCandles(sym,'2d','15m'), getFreshNews(sym)]);
    if (!quote) return res.status(404).json({ error: `${sym} not found` });
    const luxAlgo = { daily: tf1d ? luxAlgoSignal(tf1d) : null, fourhour: tf4h ? luxAlgoSignal(tf4h) : null, onehour: tf1h ? luxAlgoSignal(tf1h) : null };
    const payload = { ticker:sym, quote:{price:quote.price,changePct:quote.changePct,open:quote.open,high:quote.high,low:quote.low,marketCap:quote.marketCap,floatShares:quote.floatShares,sector:quote.sector}, timeframes:{daily:tf1d||'unavailable',fourhour:tf4h||'unavailable',onehour:tf1h||'unavailable',fifteen:tf15||'unavailable'}, luxAlgo_signals:luxAlgo, recent_news:news.slice(0,3).map(n=>n.headline) };
    const verdict = await groqCall(ANALYZE_PROMPT, JSON.stringify(payload));
    if (!verdict) return res.status(503).json({ error: 'AI unavailable — visit /api/groq-test' });
    res.json({ ticker:sym, verdict, luxAlgo, chartUrl5min:`https://finviz.com/chart.ashx?t=${sym}&ty=c&ta=1&p=i5&s=l`, chartUrlDaily:`https://finviz.com/chart.ashx?t=${sym}&ty=c&ta=1&p=d&s=l`, data:{quote,timeframes:{daily:tf1d,fourhour:tf4h,onehour:tf1h,fifteen:tf15},news}, timestamp:new Date().toISOString() });
  } catch (e) { console.error('Analyze:', e); res.status(500).json({ error: e.message }); }
});

// Quote
app.get('/api/quote/:symbol', async (req, res) => { const q = await getQuote(req.params.symbol.toUpperCase()); if (!q) return res.status(404).json({ error: 'not found' }); res.json(q); });

// LuxAlgo signals
app.post('/api/luxalgo', async (req, res) => {
  const { ticker } = req.body; if (!ticker) return res.status(400).json({ error: 'no ticker' });
  const sym = ticker.toUpperCase();
  const [tf1d, tf4h, tf1h, tf15] = await Promise.all([getCandles(sym,'3mo','1d'), getCandles(sym,'1mo','60m'), getCandles(sym,'5d','60m'), getCandles(sym,'2d','15m')]);
  res.json({ ticker:sym, daily:tf1d?luxAlgoSignal(tf1d):null, fourhour:tf4h?luxAlgoSignal(tf4h):null, onehour:tf1h?luxAlgoSignal(tf1h):null, fifteen:tf15?luxAlgoSignal(tf15):null, timestamp:new Date().toISOString() });
});

// FRESH Signals — Finnhub real-time instead of stale Yahoo screener
app.get('/api/signals', async (req, res) => {
  const signals = [];
  // Source 1: Finnhub general news (fresh, real-time)
  if (FINNHUB_KEY) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}&_=${Date.now()}`);
      const d = await r.json();
      if (Array.isArray(d)) {
        d.filter(n => (Date.now()/1000 - n.datetime) < 3600 && n.related).slice(0, 8).forEach(n => {
          signals.push({ type:'CATALYST', symbol:n.related, name:n.source, price:null, changePct:null, signal:n.headline.slice(0,100), strength:'MODERATE', source:n.source, url:n.url, ageH:+((Date.now()/1000-n.datetime)/3600).toFixed(1) });
        });
      }
    } catch {}
  }
  // Source 2: SEC 8-K fresh filings
  try {
    const sec = await getSEC8K();
    sec.filter(s => s.ageH < 2).slice(0, 5).forEach(s => signals.push({ type:'SEC_8K', symbol:'SEC', name:'SEC Edgar', signal:s.headline, strength:'STRONG', source:'SEC-EDGAR', url:s.url, ageH:s.ageH }));
  } catch {}
  // Source 3: Yahoo fresh movers (with cache bust)
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=10&scrIds=day_gainers&_=${Date.now()}`, { headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'} });
    const d = await r.json();
    (d?.finance?.result?.[0]?.quotes||[]).filter(q=>q.regularMarketChangePercent>10&&q.regularMarketPrice<10).slice(0,5).forEach(q=>{const rv=+(q.regularMarketVolume/(q.averageDailyVolume3Month||1)).toFixed(1);signals.push({type:'MOMENTUM',symbol:q.symbol,name:q.shortName||q.symbol,price:q.regularMarketPrice,changePct:q.regularMarketChangePercent,relVolume:rv,signal:`+${q.regularMarketChangePercent?.toFixed(1)}% | ${rv}x volume`,strength:rv>5?'STRONG':rv>2?'MODERATE':'WEAK',source:'Yahoo Live'});});
  } catch {}
  res.json({ signals: signals.sort((a,b) => (a.ageH||0)-(b.ageH||0)), timestamp: new Date().toISOString(), freshAt: new Date().toLocaleTimeString() });
});

// Catalyst scan endpoint
app.post('/api/catalyst-scan', async (req, res) => {
  res.json({ ok: true, message: 'Catalyst scan triggered — Telegram alert incoming if qualifying catalysts found (score≥75). Check back in 20-30 seconds.' });
  runCatalystScan(true); // async, don't await
});

// Supernova
app.post('/api/supernova', async (req, res) => {
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_KEY missing' });
  try {
    let movers = [];
    try { const r=await fetch(`https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=30&scrIds=day_gainers&_=${Date.now()}`,{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}});const d=await r.json();movers=(d?.finance?.result?.[0]?.quotes||[]).slice(0,25).map(q=>({symbol:q.symbol,name:q.shortName,price:q.regularMarketPrice,changePct:q.regularMarketChangePercent,volume:q.regularMarketVolume,avgVolume:q.averageDailyVolume3Month,relVolume:+(q.regularMarketVolume/(q.averageDailyVolume3Month||1)).toFixed(1),marketCap:q.marketCap,float:q.floatShares})).filter(s=>s.price&&s.price<25);} catch {}
    const NOVA_PROMPT=`Maverick Supernova Detection. Analyze movers for true supernova events. Score 0-100: Catalyst(30),Float(25),Velocity(20),Pillars(15),SGT(10). Tiers: SUPERNOVA(85+),IGNITING(70+),WARMING(55+).
RETURN ONLY VALID JSON:
{"scan_time":"ISO","market_session":"string","market_pulse":"2 sentences","supernovas":[{"ticker":"","company":"","price":0,"price_change_pct":0,"float_millions":0,"catalyst":"","trade_type":"LONG|FADE","phase":"IGNITION|FUEL_BURN|DISTRIBUTION","is_sixth_grade_trade":true,"sixth_grade_explanation":"","supernova_score":0,"tier":"SUPERNOVA|IGNITING|WARMING","entry_zone":"$X-$Y","stop":0,"target_1":0,"target_2":0,"risk_reward":0,"thesis":""}],"algo_note":""}`;
    const verdict = await groqCall(NOVA_PROMPT, `Today's movers:\n${JSON.stringify(movers,null,2)}\nTime:${new Date().toLocaleString()}\nReturn ONLY JSON.`, 4000);
    if (!verdict) return res.status(500).json({ error: 'AI returned no data. Visit /api/groq-test' });
    res.json(verdict);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Whale scan
app.post('/api/whale-scan', async (req, res) => {
  try {
    const candidates = new Set();
    for (const scrId of ['day_gainers','most_actives']) {
      try { const r=await fetch(`https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=${scrId}&_=${Date.now()}`,{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}});const d=await r.json();(d?.finance?.result?.[0]?.quotes||[]).filter(q=>q.regularMarketPrice<15&&q.regularMarketPrice>0.5).forEach(q=>candidates.add(q.symbol));} catch {}
    }
    const scored = [];
    for (const sym of [...candidates].slice(0,25)) {
      try {
        const [quote, tf1d] = await Promise.all([getQuote(sym), getCandles(sym,'3mo','1d')]);
        if (!quote || !tf1d) continue;
        const priceRange=tf1d.high-tf1d.low; const pricePos=priceRange>0?(quote.price-tf1d.low)/priceRange:0.5;
        const isPhase2=pricePos>=0.15&&pricePos<=0.50&&tf1d.rsi>=40&&tf1d.rsi<=65;
        const isPhase3=pricePos>0.50&&pricePos<=0.80&&tf1d.rsi>50&&tf1d.pctChange>0;
        if (!isPhase2 && !isPhase3) continue;
        const lux=luxAlgoSignal(tf1d);
        let score=isPhase2?35:28;
        if (tf1d.relVolume>2) score+=15;
        if (lux?.signalType==='BUY') score+=20;
        scored.push({symbol:sym,price:quote.price,changePct:quote.changePct,phase:isPhase2?2:3,footprintScore:Math.min(100,score),volumePattern:tf1d.relVolume>1.5?'ACCUMULATION':'NEUTRAL',rsi:tf1d.rsi,floatShares:quote.floatShares,shortName:quote.shortName,defendedLevel:+tf1d.low.toFixed(2),footprintSignals:[isPhase2?'PHASE 2 — Price defense zone':'PHASE 3 — Markup in progress',tf1d.relVolume>2?`Volume ${tf1d.relVolume.toFixed(1)}x average`:'',lux?.signalType==='BUY'?`LuxAlgo BUY — TP $${lux.tpLevel}`:''].filter(Boolean),aiWhy:lux?.signalType==='BUY'?`LuxAlgo aligned, ${isPhase2?'Phase 2 defense':'Phase 3 markup'}`:isPhase2?'Phase 2 price defense pattern':'Phase 3 markup'});
        await new Promise(r=>setTimeout(r,200));
      } catch {}
    }
    const top = scored.sort((a,b)=>b.footprintScore-a.footprintScore).slice(0,5);
    if (top.length && TG_CHAT_ID && bot && req.body.alertTelegram) { tgSend(TG_CHAT_ID, `🐋 *WHALE SCAN*\nScanned: ${[...candidates].length} | Phase 2/3: ${scored.length}\n\n`+top.slice(0,3).map((s,i)=>`*${i+1}. ${s.symbol}* — Phase ${s.phase} · Score ${s.footprintScore}/100\n$${s.price?.toFixed(2)} | ${s.aiWhy}`).join('\n\n')+'\n\nText _dive [TICKER]_'); }
    res.json({ results:top, allCandidates:scored, totalScanned:[...candidates].length, timestamp:new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Price alert
app.post('/api/alert', (req, res) => {
  const{symbol,condition,value,chatId}=req.body; if(!symbol||!condition||!value)return res.status(400).json({error:'missing fields'});
  const sym=symbol.toUpperCase(); if(!priceAlerts.has(sym))priceAlerts.set(sym,[]);
  priceAlerts.get(sym).push({chatId:chatId||TG_CHAT_ID,condition,value:+value,fired:false}); addSub(sym,chatId||TG_CHAT_ID);
  res.json({ok:true,symbol:sym,condition,value:+value});
});

// TradingView webhook
app.post('/webhook/tradingview', (req, res) => {
  if ((req.query.secret||req.body.secret) !== WEBHOOK_SECRET) return res.status(401).json({error:'unauthorized'});
  const{ticker,action,indicator,price}=req.body; if(!ticker||!action)return res.status(400).json({error:'missing'});
  const sym=ticker.toUpperCase(); tvSignals.set(sym,{action:action.toUpperCase(),indicator:indicator||'TV',price:parseFloat(price)||null,time:Date.now()});
  if(TG_CHAT_ID&&bot)tgSend(TG_CHAT_ID,`📡 *TV SIGNAL — ${sym}*\n${action.toUpperCase()} at $${price||'?'}`);
  res.json({ok:true});
});

// Chat advisor
app.post('/api/chat', async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_KEY not set. Visit /api/groq-test' });
  const { message, sessionId, portfolioSize } = req.body; if (!message) return res.status(400).json({ error: 'no message' });
  const sid = sessionId || 'default'; if (!chatSessions.has(sid)) chatSessions.set(sid, []);
  const history = chatSessions.get(sid);
  let liveContext = '';
  const tm = message.match(/\b([A-Z]{2,5})\b/g);
  if (tm) { for (const t of tm.slice(0,2)) { if (['THE','AND','FOR','BUY','ADD','OUT','NOT','HOW','CAN'].includes(t)) continue; try { const q=await getQuote(t); if(q){liveContext+=`\nLIVE ${t}: $${q.price?.toFixed(2)}, ${q.changePct?.toFixed(2)}%, H$${q.high?.toFixed(2)} L$${q.low?.toFixed(2)}, Cap${q.marketCap?'$'+(q.marketCap/1e6).toFixed(0)+'M':'n/a'}`;break;} } catch {} } }
  const pSize=portfolioSize||348; const portfolioCtx=`\nPORTFOLIO: $${pSize} | Reserve:$100 | Tradeable:$${pSize-100} | Max/trade:$${Math.round((pSize-100)*0.35)}`;
  const messages=[{role:'system',content:ADVISOR_PROMPT+portfolioCtx},...history.slice(-10),{role:'user',content:message+liveContext}];
  try {
    const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${GROQ_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:GROQ_MODELS[0],max_tokens:500,temperature:0.3,messages})});
    if(!r.ok){const err=await r.text();return res.status(503).json({error:`Groq ${r.status}: ${err.slice(0,100)}`});}
    const d=await r.json(); const reply=d.choices?.[0]?.message?.content;
    if(!reply)return res.status(503).json({error:'Empty AI response'});
    history.push({role:'user',content:message}); history.push({role:'assistant',content:reply}); if(history.length>20)history.splice(0,2);
    res.json({reply,sessionId:sid});
  } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/chat/clear',(req,res)=>{chatSessions.delete(req.body.sessionId||'default');res.json({ok:true});});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status:'online', version:'3.4', time:new Date().toISOString(), botUsername:BOT_USERNAME, services:{telegram:!!TELEGRAM_TOKEN,finnhub:!!FINNHUB_KEY,groq:!!GROQ_KEY,memory:!!(JSONBIN_KEY&&JSONBIN_BIN)}, active:{watches:watches.size,trades:trades.size,alerts:[...priceAlerts.values()].flat().filter(a=>!a.fired).length,scanCycles:scanCycleCount} });
});

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
function setupTelegramHandlers() {
  function parseTg(text) {
    const t=text.trim(); let m;
    m=t.match(/^watch(?:ing)?\s+([A-Za-z.]{1,6})\s+(?:at|for)?\s*\$?(\d+\.?\d*)(?:\s+stop\s*\$?(\d+\.?\d*))?/i); if(m)return{cmd:'watch',symbol:m[1].toUpperCase(),price:+m[2],stop:m[3]?+m[3]:null};
    m=t.match(/^in\b.*?\$?(\d+\.?\d*)\D+(\d+)/i); if(m)return{cmd:'in',price:+m[1],shares:+m[2]};
    m=t.match(/^out\b.*?\$?(\d+\.?\d*)/i); if(m)return{cmd:'out',price:+m[1]};
    m=t.match(/^add(?:ed)?\s+(\d+)[^$\d]*\$?(\d+\.?\d*)/i); if(m)return{cmd:'add',shares:+m[1],price:+m[2]};
    m=t.match(/^(?:sl|stop)\s+\$?(\d+\.?\d*)/i); if(m)return{cmd:'sl',price:+m[1]};
    m=t.match(/^alert\s+([A-Za-z.]{1,6})\s+(above|below|cross)\s+\$?(\d+\.?\d*)/i); if(m)return{cmd:'alert',symbol:m[1].toUpperCase(),condition:m[2].toUpperCase(),value:+m[3]};
    m=t.match(/^dive\s+([A-Za-z.]{1,6})/i); if(m)return{cmd:'dive',symbol:m[1].toUpperCase()};
    m=t.match(/^([A-Z.]{1,6})$/); if(m)return{cmd:'quote',symbol:m[1]};
    if(/^(news|catalyst)/i.test(t))return{cmd:'news'};
    if(/^(status|p&l)/i.test(t))return{cmd:'status'};
    if(/^(cancel|clear)/i.test(t))return{cmd:'cancel'};
    if(/^(daily|today)/i.test(t))return{cmd:'daily'};
    if(/^(weekly)/i.test(t))return{cmd:'weekly'};
    if(/^help$/i.test(t))return{cmd:'help'};
    return{cmd:'chat',text:t};
  }
  bot.on('message', async msg => {
    const cid=msg.chat.id; const text=(msg.text||'').trim(); if(!text)return;
    console.log(`[TG ${cid}] ${msg.from?.first_name}: ${text}`);
    const p=parseTg(text);
    if(p.cmd==='chat'){
      if(!GROQ_KEY){tgSend(cid,`AI not available.`);return;}
      try{const r=await fetch(`http://localhost:${PORT}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,sessionId:String(cid)})});const d=await r.json();tgSend(cid,d.reply||'❌ '+d.error);}catch(e){tgSend(cid,`❌ ${e.message}`);}
      return;
    }
    switch(p.cmd){
      case'watch':{tgSend(cid,`🔍 Pulling *${p.symbol}*...`);const q=await getQuote(p.symbol);if(!q){tgSend(cid,`❌ ${p.symbol} not found.`);return;}const lv=calcLevels(p.price);watches.set(cid,{symbol:p.symbol,entryLevel:p.price,customStop:p.stop,currentPrice:q.price,avgVolume:q.avgVolume,confirmed:false});addSub(p.symbol,cid);tgSend(cid,`👁 *WATCHING ${p.symbol}*\nNow: *$${q.price?.toFixed(2)}* | Trigger: *$${p.price}*\n\n🛑 Stop: *$${p.stop||lv.stop}*\n🎯 T1: *$${lv.t1}* | T2: *$${lv.t2}*\n\n🔴 Live monitoring active`);break;}
      case'in':{const w=watches.get(cid);if(!w){tgSend(cid,`Set watch first: _watching LFVN at 5.10_`);return;}const lv=calcLevels(p.price);const tr={symbol:w.symbol,entryPrice:p.price,shares:p.shares,entryTime:Date.now(),currentPrice:p.price,hwm:p.price,avgCost:p.price,stopLoss:w.customStop||lv.stop,trailingStop:lv.stop,targets:{t1:lv.t1,t2:lv.t2,t3:lv.t3},avgVolume:w.avgVolume,adds:[],t1Hit:false,t2Hit:false,stopAlerted:false,trailAlerted:false,warn45:false,warn90:false,addSent:false};trades.set(cid,tr);watches.delete(cid);addSub(w.symbol,cid);tgSend(cid,`✅ *IN — ${w.symbol}*\n$${p.price} × ${p.shares} shares = $${(p.price*p.shares).toFixed(2)}\n\n🛑 Stop: *$${tr.stopLoss}*\n🎯 T1: *$${lv.t1}* | T2: *$${lv.t2}*\n🚀 T3: *$${lv.t3}*\n\n🔴 Monitoring: stop·targets·trail·45min·adds`);break;}
      case'out':{const tr=trades.get(cid);if(!tr){tgSend(cid,`No active trade.`);return;}const pnl=totalPnl(tr,p.price);const ts=totalShares(tr);const mins=((Date.now()-tr.entryTime)/60000).toFixed(0);const pct=(((p.price-tr.avgCost)/tr.avgCost)*100).toFixed(2);await logTrade({symbol:tr.symbol,date:new Date().toISOString().split('T')[0],entryPrice:tr.entryPrice,exitPrice:p.price,shares:ts,avgCost:tr.avgCost,pnl,pnlPct:+pct,minutesInTrade:+mins,t1Hit:tr.t1Hit,t2Hit:tr.t2Hit});removeSub(tr.symbol,cid);trades.delete(cid);tgSend(cid,`${pnl>0?'💰':'📉'} *CLOSED — ${tr.symbol}*\n$${tr.entryPrice} → *$${p.price}* | ${ts} shares | ${mins}min\n${pnl>0?'✅':'❌'} *P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}* (${pct}%)\n\n${pnl>0?'🔥 Banked. Well executed.':'💪 Stop respected. Next setup.'}`);break;}
      case'add':{const tr=trades.get(cid);if(!tr){tgSend(cid,`No active trade.`);return;}tr.adds.push({shares:p.shares,price:p.price});tr.avgCost=avgCostCalc(tr);tgSend(cid,`📈 *ADDED ${tr.symbol}*\n+${p.shares} @ $${p.price} | Total: ${totalShares(tr)} | Avg: *$${tr.avgCost}*`);break;}
      case'sl':{const tr=trades.get(cid);const w=watches.get(cid);if(tr){tr.stopLoss=p.price;tr.stopAlerted=false;tgSend(cid,`✅ Stop → *$${p.price}* on *${tr.symbol}*`);}else if(w){w.customStop=p.price;tgSend(cid,`✅ Stop set → *$${p.price}*`);}else tgSend(cid,`No active trade.`);break;}
      case'alert':{if(!priceAlerts.has(p.symbol))priceAlerts.set(p.symbol,[]);priceAlerts.get(p.symbol).push({chatId:cid,condition:p.condition,value:p.value,fired:false});addSub(p.symbol,cid);tgSend(cid,`🔔 *ALERT — ${p.symbol}*\nFires when price ${p.condition} *$${p.value}*\n✅ Finnhub live feed monitoring`);break;}
      case'dive':{tgSend(cid,`🔍 Analyzing *${p.symbol}*...`);try{const r=await fetch(`http://localhost:${PORT}/api/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker:p.symbol})});const data=await r.json();if(data.error){tgSend(cid,`❌ ${data.error}`);return;}const v=data.verdict;const emoji={BUY:'🟢',DONT_BUY:'🔴',WATCH:'🟡'}[v.verdict]||'⚪';let msg=`${emoji} *${p.symbol}* — *${v.verdict.replace('_',' ')}*\nConviction: *${v.conviction}/100*\n\n${v.headline}\n\n${(v.reasoning||[]).map(r=>`• ${r}`).join('\n')}`;if(v.verdict==='BUY')msg+=`\n\n📋 Entry: *$${v.entry_zone?.low}–$${v.entry_zone?.high}*\nStop: *$${v.stop_loss}* | T1: *$${v.target_1}* | R:R: *${v.risk_reward}:1*\nText: _watching ${p.symbol} at ${v.entry_zone?.low}_`;tgSend(cid,msg);}catch(e){tgSend(cid,`❌ ${e.message}`);}break;}
      case'quote':{const q=await getQuote(p.symbol);if(!q){tgSend(cid,`❌ ${p.symbol} not found.`);return;}tgSend(cid,`📊 *${p.symbol}* — *$${q.price?.toFixed(2)}* (${(q.changePct>=0?'+':'')+q.changePct?.toFixed(2)}%)\nH:$${q.high?.toFixed(2)} L:$${q.low?.toFixed(2)}\nCap:${q.marketCap?'$'+(q.marketCap/1e6).toFixed(0)+'M':'—'} Float:${q.floatShares?(q.floatShares/1e6).toFixed(1)+'M':'—'}\n\nText: _watching ${p.symbol} at ${q.price?.toFixed(2)}_`);break;}
      case'news':{tgSend(cid,`⚡ Scanning catalysts...`);runCatalystScan(true);break;}
      case'status':{const tr=trades.get(cid);const w=watches.get(cid);if(tr){const price=tr.currentPrice||tr.entryPrice;const pnl=totalPnl(tr,price);const mins=((Date.now()-tr.entryTime)/60000).toFixed(0);tgSend(cid,`📊 *LIVE — ${tr.symbol}*\nEntry:$${tr.entryPrice} | Now:*$${price.toFixed(2)}*\nP&L:*${pnl>=0?'+':''}$${pnl.toFixed(2)}* | ${mins}min\n🛑 Stop:*$${tr.stopLoss}*\n🎯 T1:$${tr.targets.t1}${tr.t1Hit?'✅':'⏳'} T2:$${tr.targets.t2}${tr.t2Hit?'✅':'⏳'}`);}else if(w)tgSend(cid,`👁 Watching *${w.symbol}* → $${w.entryLevel} | Now:$${w.currentPrice?.toFixed(2)||'...'}`)else tgSend(cid,`No active trade.\n_watching [TICKER] at [price]_`);break;}
      case'cancel':{const sym=watches.get(cid)?.symbol||trades.get(cid)?.symbol;if(sym)removeSub(sym,cid);watches.delete(cid);trades.delete(cid);tgSend(cid,`✅ Cleared.\n_watching [TICKER] at [price]_`);break;}
      case'daily':{const mem=await memLoad();const today=new Date().toISOString().split('T')[0];const list=(mem.trades||[]).filter(t=>t.date===today);if(!list.length){tgSend(cid,`No trades today.`);return;}const total=list.reduce((s,t)=>s+t.pnl,0);const wins=list.filter(t=>t.pnl>0);tgSend(cid,`📊 *TODAY*\nTrades:*${list.length}* Wins:*${wins.length}* (${((wins.length/list.length)*100).toFixed(0)}%)\nTotal:*${total>=0?'+':''}$${total.toFixed(2)}*\n\n`+list.map(t=>`${t.pnl>=0?'✅':'❌'} ${t.symbol} ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}`).join('\n'));break;}
      case'weekly':{const mem=await memLoad();const list=(mem.trades||[]).filter(t=>(Date.now()-new Date(t.date).getTime())<7*86400000);if(!list.length){tgSend(cid,`No trades this week.`);return;}const total=list.reduce((s,t)=>s+t.pnl,0);const wins=list.filter(t=>t.pnl>0);tgSend(cid,`📊 *WEEK*\nTrades:*${list.length}* Wins:*${wins.length}*\nTotal:*${total>=0?'+':''}$${total.toFixed(2)}*`);break;}
      case'help':tgSend(cid,`🤖 *MAVERICK v3.4*\n\n*TRADE:*\n_watching LFVN at 5.10_ — watch\n_in at 5.11 with 200 shares_ — entry\n_added 100 at 5.50_ — add\n_sl 4.88_ — stop\n_out at 5.85_ — close\n_status_ | _cancel_\n\n*ALERTS:*\n_alert LFVN above 5.50_\n_alert LFVN below 4.80_\n\n*ANALYSIS:*\n_LFVN_ — quote\n_dive LFVN_ — AI analysis\n_news_ — catalyst scan\n\n*REPORTS:*\n_daily_ | _weekly_\n\n*CHAT:*\nType naturally — "how many shares should I buy?"`);break;
    }
  });
  bot.on('polling_error', e => { if (!e.message.includes('409') && !e.message.includes('401')) console.error('Polling:', e.message); });
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 MAVERICK TERMINAL v3.4 — Port ${PORT}`);
  console.log(`   Telegram:  ${TELEGRAM_TOKEN?'✅':'❌'}`);
  console.log(`   Finnhub:   ${FINNHUB_KEY?'✅':'❌'}`);
  console.log(`   Groq AI:   ${GROQ_KEY?'✅':'❌'}`);
  console.log(`   Memory:    ${JSONBIN_KEY?'✅':'⚠️ optional'}`);
  console.log(`   Models:    ${GROQ_MODELS[0]}`);
  console.log(`   Groq test: /api/groq-test\n`);
  connectFinnhub();
  scheduleCatalystScans();
  startContinuousScanner();
  await initTelegram();
});
