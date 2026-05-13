require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const brain = require('./brain');

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/audit', async (req, res) => {
    try {
        const sym = req.body.ticker.toUpperCase();
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${process.env.FINNHUB_KEY}`);
        const d = await r.json();

        const intel = brain.getInstitutionalIntel(d.c, d.dp, 5000000);
        const plan = brain.calculateTradePlan(d.c);
        const prob = brain.runEnsemble(d.c);
        const lux = brain.calculateLuxSignals(d.dp, 5000000);

        res.json({
            symbol: sym, price: d.c, change: d.dp,
            intel, plan, prob, lux,
            kelly: brain.getKelly(prob),
            verdict: intel.velocity > 70 ? 'STRIKE AUTHORIZED' : 'MONITORING'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log('MAVERICK ELITE ONLINE'));
