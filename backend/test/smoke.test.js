/**
 * Smoke test. Runs the real Express app against a LOCAL mock server that speaks the
 * Yahoo chart JSON format. The synthetic candles exist ONLY inside this test file;
 * the application itself never generates or fabricates market data.
 *
 * Run:  npm test
 */
import http from 'node:http';
import assert from 'node:assert/strict';

// ---- synthetic candle generator (seeded, test-only) -----------------------
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function makeSession(rand, dayStartUtc, open, drift) {
  const rows = [];
  let p = open;
  for (let m = 0; m < 375; m++) {
    const o = p;
    const shock = (rand() - 0.5) * 0.9 + drift;
    const c = Math.max(1, o + shock);
    const h = Math.max(o, c) + rand() * 0.35;
    const l = Math.min(o, c) - rand() * 0.35;
    const spike = rand() < 0.04 ? 3 : 1;
    rows.push({ t: dayStartUtc + (9 * 60 + 15 + m) * 60 - 19800, o, h, l, c, v: Math.round((20000 + rand() * 30000) * spike * (m < 15 ? 2 : 1)) });
    p = c;
  }
  return rows;
}

function makeDays(nDays, seed) {
  const rand = rng(seed);
  const days = [];
  const now = new Date();
  let d = Math.floor(now.getTime() / 86400000) * 86400; // today 00:00 UTC (sec)
  d -= 86400;
  let price = 4300;
  const all = [];
  while (days.length < nDays) {
    const dow = new Date(d * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) days.unshift(d);
    d -= 86400;
  }
  days.forEach((day, k) => {
    const rows = makeSession(rand, day, price, k % 2 ? 0.01 : -0.006);
    price = rows[rows.length - 1].c;
    all.push(...rows);
  });
  return all;
}

const ROWS = makeDays(5, 42);

function yahooJson(sym, interval) {
  const step = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1d': 375 }[interval] || 1;
  const agg = [];
  for (let i = 0; i < ROWS.length; i += step) {
    const g = ROWS.slice(i, i + step);
    agg.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[g.length - 1].c, v: g.reduce((s, x) => s + x.v, 0) });
  }
  const last = agg[agg.length - 1];
  return {
    chart: {
      result: [{
        meta: { symbol: sym, longName: 'Hero MotoCorp Ltd (MOCK)', currency: 'INR', exchangeName: 'NSI', regularMarketPrice: last.c, regularMarketTime: last.t, chartPreviousClose: agg[0].o },
        timestamp: agg.map((x) => x.t),
        indicators: { quote: [{ open: agg.map((x) => x.o), high: agg.map((x) => x.h), low: agg.map((x) => x.l), close: agg.map((x) => x.c), volume: agg.map((x) => x.v) }] },
      }],
      error: null,
    },
  };
}

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/\/v8\/finance\/chart\/(.+)$/);
  res.setHeader('Content-Type', 'application/json');
  if (!m) { res.statusCode = 404; return res.end('{}'); }
  const sym = decodeURIComponent(m[1]);
  if (sym.startsWith('BADSYM')) { res.statusCode = 404; return res.end(JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } })); }
  if (sym.startsWith('LIMITED')) { res.statusCode = 429; return res.end('{}'); }
  return res.end(JSON.stringify(yahooJson(sym, u.searchParams.get('interval'))));
});
await new Promise((r) => mock.listen(0, r));
process.env.YAHOO_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
process.env.MARKET_DATA_PROVIDER = 'yahoo';

const { default: app } = await import('../app.js');
const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓', name); }).catch((e) => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });

console.log('Backend smoke tests');
await ok('health reports provider', async () => { const r = await get('/health'); assert.equal(r.body.ok, true); assert.equal(r.body.provider.configured, true); });
await ok('alias HEROMOTORS resolves + candles', async () => {
  const r = await get('/market/HEROMOTORS/candles?interval=1m');
  assert.equal(r.status, 200); assert.equal(r.body.symbol, 'HEROMOTOCO'); assert.ok(r.body.candles.length > 1800);
});
await ok('quote has price/prevClose/change', async () => {
  const r = await get('/market/HEROMOTORS/quote');
  const q = r.body.quote; assert.ok(q.price > 0 && q.previousClose > 0 && Number.isFinite(q.changePct)); assert.ok(q.high >= q.low);
  assert.ok(['OPEN', 'CLOSED', 'AFTER_MARKET', 'PRE_OPEN'].includes(r.body.marketStatus.state));
});
await ok('market overview', async () => { const r = await get('/market/RELIANCE'); assert.equal(r.status, 200); assert.ok(r.body.name); });
for (const tf of ['1m', '3m', '5m', '15m', '30m', '1H', '1D']) {
  await ok(`analysis ${tf}`, async () => {
    const r = await get(`/analysis/HEROMOTORS?interval=${tf}`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const a = r.body.analysis;
    assert.ok(r.body.candles.length > 3 && r.body.series.ema9);
    assert.ok(a.signal.label && a.signal.components.length === 6);
    assert.ok(a.intraday.headline && a.intraday.verdict && a.intraday.plan.stopLoss > 0);
    assert.equal(a.signal.components.reduce((s, c) => s + c.max, 0), 100);
    const sp = a.prediction.scenarios;
    assert.equal(sp.bullish.probability + sp.bearish.probability + sp.sideways.probability, 100);
    assert.ok(a.setup.stopLoss > 0 && a.setup.risk > 0);
    assert.ok(a.disclaimer);
  });
}
await ok('3m candles are aggregated from 1m', async () => {
  const one = (await get('/market/HEROMOTORS/candles?interval=1m')).body.candles;
  const three = (await get('/market/HEROMOTORS/candles?interval=3m')).body.candles;
  assert.ok(three.length < one.length / 2); assert.equal(three.reduce((s, c) => s + c.volume, 0), one.reduce((s, c) => s + c.volume, 0));
});
await ok('tail mode returns only recent points', async () => {
  const r = await get('/analysis/HEROMOTORS?interval=1m&series=tail');
  assert.ok(r.body.candles.length <= 6 && r.body.series.ema20.length <= 6);
});
await ok('indicators & signals endpoints', async () => {
  const i = await get('/analysis/HEROMOTORS/indicators?interval=1m'); assert.ok(i.body.indicators.rows.length >= 6);
  const s = await get('/analysis/HEROMOTORS/signals?interval=1m'); assert.ok(Array.isArray(s.body.history)); assert.ok(s.body.backtest.label);
});
await ok('stop-loss: auto, LONG, SHORT are on the correct side of entry', async () => {
  for (const direction of ['AUTO', 'LONG', 'SHORT']) {
    const r = await post('/analysis/HEROMOTORS/stoploss', { direction, interval: '1m' });
    assert.equal(r.status, 200); const s = r.body.setup;
    if (s.direction === 'LONG') assert.ok(s.stopLoss < s.entry && s.target1 > s.entry && s.target2 > s.target1);
    else assert.ok(s.stopLoss > s.entry && s.target1 < s.entry && s.target2 < s.target1);
    assert.ok(s.rr1 > 0 && s.confidence <= 90); assert.ok(r.body.draw.some((d) => d.type === 'STOP_LOSS'));
  }
});
await ok('prediction endpoint', async () => { const r = await post('/analysis/HEROMOTORS/prediction', { interval: '5m' }); assert.equal(r.status, 200); assert.ok(r.body.prediction.method.length); });
await ok('backtest returns coherent stats', async () => {
  const b = (await get('/analysis/HEROMOTORS?interval=1m&series=none')).body.analysis.backtest;
  assert.equal(b.sufficient, true); assert.equal(b.wins + b.losses, b.signals);
});
await ok('invalid symbol -> 404 INVALID_SYMBOL', async () => { const r = await get('/market/BADSYM/quote'); assert.equal(r.status, 404); assert.equal(r.body.error.code, 'INVALID_SYMBOL'); });
await ok('malformed symbol -> 400', async () => { const r = await get('/market/%3Cscript%3E/quote'); assert.equal(r.status, 400); });
await ok('rate limit -> 429 RATE_LIMIT', async () => { const r = await get('/market/LIMITED/quote'); assert.equal(r.status, 429); assert.equal(r.body.error.code, 'RATE_LIMIT'); });
await ok('bad interval -> 400', async () => { const r = await get('/market/RELIANCE/candles?interval=7m'); assert.equal(r.status, 400); });
await ok('search returns local suggestions', async () => { const r = await get('/search?q=hero'); assert.ok(r.body.results.some((x) => x.symbol === 'HEROMOTOCO')); });
await ok('unknown route -> JSON 404', async () => { const r = await get('/nope'); assert.equal(r.status, 404); assert.equal(r.body.ok, false); });

// Provider failure paths (no fabricated data)
process.env.YAHOO_BASE_URL = 'http://127.0.0.1:1';
await ok('network failure -> NETWORK error, no data', async () => {
  const r = await get('/market/TCS/quote'); assert.equal(r.status, 503); assert.equal(r.body.error.code, 'NETWORK'); assert.equal(r.body.quote, undefined);
});
process.env.MARKET_DATA_PROVIDER = 'YOUR_PROVIDER';
await ok('unconfigured provider -> clear message, server alive', async () => {
  const h = await get('/health'); assert.equal(h.body.provider.configured, false);
  const r = await get('/market/TCS/quote'); assert.equal(r.status, 503); assert.equal(r.body.error.code, 'PROVIDER_NOT_CONFIGURED');
});
process.env.MARKET_DATA_PROVIDER = 'twelvedata'; delete process.env.MARKET_DATA_API_KEY;
await ok('missing API key -> PROVIDER_NOT_CONFIGURED', async () => { const r = await get('/market/TCS/quote'); assert.equal(r.status, 503); assert.match(r.body.error.message, /API key/); });

srv.close(); mock.close();
console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
