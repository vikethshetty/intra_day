import {
  MarketDataError, getCandles, getQuote, buildQuote, getMarketStatus, getProviderStatus, normalizeInterval, searchSymbols, INTERVALS,
} from '../services/marketDataService.js';
import {
  buildContext, buildSnapshot, describeIndicators, detectEvents,
} from '../services/technicalAnalysisService.js';
import {
  calculateEntryScore, computeSignalTimeline, signalHistory, buildTradeSetup, runBacktest, sideOf,
} from '../services/signalEngine.js';
import { generateScenarioAnalysis } from '../services/predictionEngine.js';
import { buildIntradayCall } from '../services/intradayService.js';
import { getDailyTop10Batch } from '../services/dailyScannerService.js';

const DISCLAIMER = 'Technical-analysis estimates for personal study only. Not financial advice. Probabilities are not guarantees; markets can move against any setup. This app never places trades.';
const TAIL = 6;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const e = err instanceof MarketDataError ? err : new MarketDataError('INTERNAL', 'Unexpected analysis error. Check the backend console.', 500);
    if (!(err instanceof MarketDataError)) console.error(err);
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    res.status(e.status || 500).json({ ok: false, error: { code: e.code, message: e.message, retryAfter: e.retryAfter ?? null }, provider: getProviderStatus() });
  }
};

/** [{time,value}] from an aligned array. Optionally break the line at the first bar of each day (VWAP). */
function toPoints(candles, arr, { breakOnDay = false, from = 0 } = {}) {
  const out = [];
  for (let i = from; i < candles.length; i++) {
    if (arr[i] == null) continue;
    if (breakOnDay && (i === 0 || Math.floor((candles[i].time + 19800) / 86400) !== Math.floor((candles[i - 1].time + 19800) / 86400))) {
      out.push({ time: candles[i].time });
    } else out.push({ time: candles[i].time, value: arr[i] });
  }
  return out;
}

function buildSeries(ctx, mode) {
  const { candles, series } = ctx;
  if (mode === 'none') return null;
  const from = mode === 'tail' ? Math.max(0, candles.length - TAIL) : 0;
  const P = (arr, o) => toPoints(candles, arr, { from, ...o });
  return {
    ema9: P(series.ema9), ema20: P(series.ema20), ema50: P(series.ema50), ema200: P(series.ema200),
    sma20: P(series.sma20), sma50: P(series.sma50),
    vwap: P(series.vwap, { breakOnDay: true }),
    bbUpper: P(series.bb.upper), bbMiddle: P(series.bb.middle), bbLower: P(series.bb.lower),
    rsi: P(series.rsi), macd: P(series.macd.macd), macdSignal: P(series.macd.signal), macdHist: P(series.macd.histogram),
  };
}

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const slimLevels = (levels, n = 3) => ({
  resistance: levels.resistance.slice(0, n).map((l) => ({ name: l.name, price: r2(l.price), label: l.label, strength: l.strength, dynamic: l.dynamic })),
  support: levels.support.slice(0, n).map((l) => ({ name: l.name, price: r2(l.price), label: l.label, strength: l.strength, dynamic: l.dynamic })),
  pivots: levels.pivots,
  fib: levels.fib,
  poc: levels.poc,
});

/* ------------------------------------------------------------------ */
/* Core analysis (cached per candle-set object)                         */
/* ------------------------------------------------------------------ */
const analysisCache = new WeakMap();

function analyze(data) {
  const hit = analysisCache.get(data);
  if (hit) return hit;
  const ctx = buildContext(data.candles, data.interval);
  const i = ctx.candles.length - 1;
  const key = `${data.providerId}|${data.symbol}|${data.interval}`;
  const timeline = computeSignalTimeline(ctx, key);
  const snap = buildSnapshot(ctx, i);
  const scoring = calculateEntryScore(snap);
  const entry = timeline[i];
  const stable = entry.stable;
  const stableSide = sideOf(stable);
  const view = stableSide ? (stableSide === 'LONG' ? scoring.long : scoring.short) : scoring;
  const setup = buildTradeSetup(ctx, i, snap, scoring, stable);
  const prediction = generateScenarioAnalysis(ctx, snap, scoring, timeline);
  const backtest = runBacktest(ctx, timeline, key);
  const history = signalHistory(timeline);
  const lastChange = [...timeline].reverse().find((e) => e.changed);

  const markers = [];
  // Chart arrows only for actionable signals (BUY / STRONG BUY / SELL / STRONG SELL), latest 12, to keep the chart readable.
  const actionable = [...history].reverse().filter((h) => /^(STRONG )?(BUY|SELL)$/.test(h.signal)).slice(-12);
  for (const h of actionable) markers.push({ time: h.time, kind: /BUY/.test(h.signal) ? 'BUY' : 'SELL', text: h.signal, price: h.price });
  if (snap.divergence.bullish) markers.push({ time: snap.divergence.bullish.to.time, kind: 'DIV_BULL', text: 'Bull div', price: snap.divergence.bullish.to.price });
  if (snap.divergence.bearish) markers.push({ time: snap.divergence.bearish.to.time, kind: 'DIV_BEAR', text: 'Bear div', price: snap.divergence.bearish.to.price });

  const out = {
    ctx, snap, scoring, timeline, setup, stable, stableSide,
    payload: {
      asOf: snap.time,
      price: snap.price,
      indicators: { rows: describeIndicators(snap), values: snap.v },
      candlePatterns: snap.patterns,
      structure: snap.structure,
      levels: slimLevels(snap.levels),
      volume: snap.volume,
      vwap: snap.vwap,
      macd: snap.macd,
      divergence: snap.divergence,
      breakout: snap.breakout,
      signal: {
        label: stable,
        raw: scoring.signal,
        pending: entry.pendingLabel,
        direction: stableSide || scoring.direction,
        lean: scoring.direction,
        score: view.total,
        components: view.components,
        checks: view.checks,
        met: view.met,
        longScore: scoring.long.total,
        shortScore: scoring.short.total,
        reasons: scoring.reasons,
        warnings: scoring.warnings,
        since: lastChange?.time ?? null,
        note: stable === 'WAIT' ? 'No setup has enough confirmed evidence right now.' : null,
      },
      setup,
      prediction,
      events: detectEvents(ctx, snap),
      signalHistory: history,
      markers,
      backtest,
      disclaimer: DISCLAIMER,
    },
  };
  analysisCache.set(data, out);
  return out;
}

async function loadAnalysis(req, { allowBodyInterval = false } = {}) {
  const interval = normalizeInterval((allowBodyInterval ? req.body?.interval : null) ?? req.query.interval ?? '1m');
  const data = await getCandles(req.params.symbol, interval);
  return { data, a: analyze(data), interval };
}

async function quoteFor(symbol, data) {
  try {
    const q = await getQuote(symbol);
    return q.quote;
  } catch {
    return buildQuote(data.candles, data.meta); // fall back to the candles already loaded
  }
}

const header = (data) => ({
  symbol: data.symbol, providerSymbol: data.providerSymbol, name: data.meta.name, exchange: data.meta.exchange,
  currency: data.meta.currency, source: data.source, interval: data.interval, fetchedAt: data.fetchedAt,
  candleLagSec: data.candleLagSec || 0, liveMerged: !!data.liveMerged,
});

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */
export const health = (req, res) => {
  res.json({ ok: true, time: Date.now(), provider: getProviderStatus(), intervals: Object.keys(INTERVALS) });
};

export const search = wrap(async (req, res) => {
  const out = await searchSymbols(String(req.query.q || ''));
  res.json({ ok: true, ...out });
});

export const dailyTop10 = wrap(async (req, res) => {
  res.json(await getDailyTop10Batch(req.query.offset));
});

export const marketOverview = wrap(async (req, res) => {
  const { quote, data } = await getQuote(req.params.symbol);
  res.json({ ok: true, ...header(data), interval: '1m', quote, marketStatus: getMarketStatus(Date.now(), quote.lastCandleTime), provider: getProviderStatus() });
});

export const marketQuote = wrap(async (req, res) => {
  const { quote, data } = await getQuote(req.params.symbol);
  res.json({ ok: true, ...header(data), interval: '1m', quote, marketStatus: getMarketStatus(Date.now(), quote.lastCandleTime) });
});

export const marketCandles = wrap(async (req, res) => {
  const interval = normalizeInterval(req.query.interval || '1m');
  const data = await getCandles(req.params.symbol, interval);
  const limit = Math.min(Number(req.query.limit) || data.candles.length, data.candles.length);
  res.json({ ok: true, ...header(data), count: limit, candles: data.candles.slice(-limit) });
});

export const analysisFull = wrap(async (req, res) => {
  const { data, a, interval } = await loadAnalysis(req);
  const mode = ['full', 'tail', 'none'].includes(req.query.series) ? req.query.series : 'full';
  const quote = await quoteFor(req.params.symbol, data);
  const candles = mode === 'tail' ? data.candles.slice(-TAIL) : data.candles;
  const marketStatus = getMarketStatus(Date.now(), quote.lastCandleTime);
  // Time-dependent, so computed per request (not cached with the candle analysis).
  const intraday = buildIntradayCall({ snap: a.snap, scoring: a.scoring, setup: a.setup, stable: a.stable, marketStatus, interval });
  res.json({
    ok: true, ...header(data), interval, mode,
    quote, marketStatus,
    candles, series: buildSeries(a.ctx, mode),
    analysis: { ...a.payload, intraday },
    provider: getProviderStatus(),
  });
});

export const analysisIndicators = wrap(async (req, res) => {
  const { data, a, interval } = await loadAnalysis(req);
  const p = a.payload;
  res.json({
    ok: true, ...header(data), interval, asOf: p.asOf,
    indicators: p.indicators, macd: p.macd, vwap: p.vwap, volume: p.volume, structure: p.structure,
    levels: p.levels, candlePatterns: p.candlePatterns, divergence: p.divergence, breakout: p.breakout,
  });
});

export const analysisSignals = wrap(async (req, res) => {
  const { data, a, interval } = await loadAnalysis(req);
  const p = a.payload;
  res.json({ ok: true, ...header(data), interval, asOf: p.asOf, signal: p.signal, setup: p.setup, history: p.signalHistory, events: p.events, backtest: p.backtest, disclaimer: DISCLAIMER });
});

export const analysisStopLoss = wrap(async (req, res) => {
  const { data, a, interval } = await loadAnalysis(req, { allowBodyInterval: true });
  const want = String(req.body?.direction || 'AUTO').toUpperCase();
  if (!['AUTO', 'LONG', 'SHORT'].includes(want)) throw new MarketDataError('BAD_REQUEST', 'direction must be AUTO, LONG or SHORT.', 400);
  const entryOverride = req.body?.entry != null && Number.isFinite(Number(req.body.entry)) ? Number(req.body.entry) : null;
  const { ctx, snap, scoring, stable, stableSide } = a;
  const i = ctx.candles.length - 1;
  const manual = want !== 'AUTO';
  const setup = buildTradeSetup(ctx, i, snap, scoring, stable, manual ? want : null, entryOverride);
  const warnings = [];
  if (!setup.active && !manual) warnings.push('There is no active BUY/SELL signal. These levels are a conditional plan - do not enter until the confirmation listed in Trade Setup happens.');
  if (manual && stableSide && stableSide !== want) warnings.push(`You chose ${want} but the current signal leans ${stableSide}. This trade is against the prevailing bias.`);
  if (manual && !stableSide && scoring.direction !== want) warnings.push(`Current evidence leans ${scoring.direction}, not ${want}.`);
  if (/FALSE/.test(snap.breakout.status)) warnings.push(snap.breakout.message);
  const lv = snap.levels;
  const draw = [
    { type: 'ENTRY', price: setup.entry, label: 'ENTRY' },
    { type: 'STOP_LOSS', price: setup.stopLoss, label: 'STOP LOSS' },
    { type: 'TARGET_1', price: setup.target1, label: 'TARGET 1' },
    { type: 'TARGET_2', price: setup.target2, label: 'TARGET 2' },
    ...lv.support.slice(0, 2).map((l) => ({ type: 'SUPPORT', price: r2(l.price), label: l.name })),
    ...lv.resistance.slice(0, 2).map((l) => ({ type: 'RESISTANCE', price: r2(l.price), label: l.name })),
  ];
  if (snap.v.vwap != null) draw.push({ type: 'VWAP', price: r2(snap.v.vwap), label: 'VWAP' });
  res.json({ ok: true, ...header(data), interval, asOf: snap.time, price: snap.price, setup, draw, warnings, disclaimer: DISCLAIMER });
});

export const analysisPrediction = wrap(async (req, res) => {
  const { data, a, interval } = await loadAnalysis(req, { allowBodyInterval: true });
  res.json({ ok: true, ...header(data), interval, asOf: a.payload.asOf, signal: a.payload.signal, prediction: a.payload.prediction, disclaimer: DISCLAIMER });
});
