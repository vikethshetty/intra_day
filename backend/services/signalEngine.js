/**
 * Signal engine: transparent 100-point scoring, signal hysteresis, trade setup and backtest.
 *
 *  TREND 20 + MOMENTUM 20 + VOLUME 20 + STRUCTURE 20 + CANDLE 10 + MARKET CONTEXT 10 = 100
 *
 * Both a LONG and a SHORT score are computed on every bar. The higher one is the
 * "lean"; it only becomes a BUY/SELL signal when the score is high enough, the
 * two sides are clearly separated, enough of the 7-point confirmation checklist
 * passes, and there is no false-breakout warning. Otherwise the answer is WAIT.
 */
import { clamp, istMinutes, roundToTick, TICK } from '../utils/indicators.js';
import {
  buildSnapshot, calculateStopLoss, calculateTargets,
} from './technicalAnalysisService.js';
import { aggregateDailyCandles, getHistoryContext } from './historyContextService.js';

export const sideOf = (signal) => (/BUY/.test(signal) ? 'LONG' : /SELL/.test(signal) ? 'SHORT' : null);

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */
function scoreSide(snap, side) {
  const long = side === 'LONG';
  const { v, price, structure, volume, macd, vwap, breakout, patternBias, levels } = snap;
  const atr = v.atr;
  const above = (a, b) => (long ? a > b : a < b); // "bullish-for-this-side" comparison

  /* TREND (20): weighted yes/no tests, scaled to the tests that have enough data. */
  const tests = [];
  if (v.ema20 != null) tests.push([5, above(price, v.ema20)]);
  if (v.ema9 != null && v.ema20 != null) tests.push([4, above(v.ema9, v.ema20)]);
  if (v.ema20 != null && v.ema50 != null) tests.push([4, above(v.ema20, v.ema50)]);
  if (v.ema200 != null) tests.push([3, above(price, v.ema200)]);
  if (v.adx != null) tests.push([4, v.adx >= 20 && (long ? v.plusDI > v.minusDI : v.minusDI > v.plusDI)]);
  const availW = tests.reduce((s, t) => s + t[0], 0);
  const okW = tests.reduce((s, t) => s + (t[1] ? t[0] : 0), 0);
  const trend = availW ? Math.round((okW / availW) * 20) : 0;

  /* MOMENTUM (20): RSI zone 8 + MACD>signal 5 + histogram 3 + MACD vs zero 4 */
  let mom = 0;
  if (v.rsi != null) {
    const r = long ? v.rsi : 100 - v.rsi; // mirror for shorts
    mom += r >= 50 && r <= 65 ? 8 : r > 65 && r <= 70 ? 6 : r >= 45 && r < 50 ? 4 : r > 70 && r <= 80 ? 3 : r >= 40 && r < 45 ? 2 : r > 80 ? 1 : 0;
  }
  if (macd.available) {
    mom += (long ? macd.bias === 'bullish' : macd.bias === 'bearish') ? 5 : 0;
    mom += macd.histogramTrend === (long ? 'INCREASING' : 'DECREASING') ? 3 : 0;
    mom += (long ? macd.aboveZero : !macd.aboveZero) ? 4 : 0;
  } else mom = Math.round(mom * 2);
  mom = clamp(mom, 0, 20);

  /* VOLUME (20): participation ratio 12 + directional pressure 8 */
  const r = volume.ratio;
  let vol = r >= 2 ? 12 : r >= 1.5 ? 10 : r >= 1.2 ? 8 : r >= 1 ? 6 : r >= 0.8 ? 3 : 0;
  const pr = long ? volume.pressure : -volume.pressure;
  vol += pr > 0.25 ? 8 : pr > 0.1 ? 5 : pr > -0.1 ? 2 : 0;

  /* STRUCTURE (20): HH/HL 8 + VWAP side 5 + breakout / level context 7 */
  let str = 0;
  const raw = structure.trend;
  str += raw === (long ? 'BULLISH' : 'BEARISH') ? 8 : raw === 'SIDEWAYS' ? 3 : 0;
  str += vwap.available ? ((long ? vwap.relation === 'ABOVE' : vwap.relation === 'BELOW') ? 5 : 0) : 2;
  const brkSide = breakout.direction === (long ? 'UP' : 'DOWN');
  const nearStatic = (arr) => arr.find((l) => !l.dynamic);
  const supportNear = nearStatic(levels.support);
  const resistNear = nearStatic(levels.resistance);
  if (brkSide && (breakout.status === 'BREAKOUT' || breakout.status === 'BREAKDOWN')) str += breakout.confirmed || breakout.retestHold ? 7 : 4;
  else if (long && supportNear && price - supportNear.price <= 0.6 * atr) str += 4;
  else if (!long && resistNear && resistNear.price - price <= 0.6 * atr) str += 4;
  else if (long && resistNear && resistNear.price - price <= 0.3 * atr) str += 2;
  else if (!long && supportNear && price - supportNear.price <= 0.3 * atr) str += 2;
  if (brkSide && /FALSE/.test(breakout.status)) str -= 4;
  str = clamp(str, 0, 20);

  /* CANDLE (10): neutral candle = 3, aligned patterns up to 10, opposing patterns down to 0 */
  const net = long ? patternBias : -patternBias;
  const candle = Math.round(clamp(net >= 0 ? 3 + 7 * net : 3 + 3 * net, 0, 10));

  /* MARKET CONTEXT (10): 2.5 each - vs previous close, vs day open, EMA slope, tradable time of day */
  let ctxPts = 0;
  if (v.prevClose != null) ctxPts += above(price, v.prevClose) ? 2.5 : 0;
  ctxPts += above(price, v.dayOpen) ? 2.5 : 0;
  const slopeNow = v.ema50 ?? v.ema20;
  const slopePrev = v.ema50 != null ? v.ema50Prev : v.ema20Prev;
  if (slopeNow != null && slopePrev != null) ctxPts += above(slopeNow, slopePrev) ? 2.5 : 0;
  const mins = v.minutesIST;
  ctxPts += mins == null || (mins >= 9 * 60 + 30 && mins <= 15 * 60) || mins < 5 * 60 ? 2.5 : 0; // avoid open/close noise
  const market = Math.round(ctxPts);

  /* 7-point confirmation checklist (spec section 15) */
  const checks = [
    { key: 'vwap', label: long ? 'Price above VWAP' : 'Price below VWAP', ok: vwap.available ? (long ? vwap.relation === 'ABOVE' : vwap.relation === 'BELOW') : v.ema20 != null && above(price, v.ema20), note: vwap.available ? null : 'VWAP n/a - EMA 20 used' },
    { key: 'ema', label: long ? 'EMA 9 above EMA 20' : 'EMA 9 below EMA 20', ok: v.ema9 != null && v.ema20 != null && above(v.ema9, v.ema20) },
    { key: 'rsi', label: long ? 'RSI above 50 and below 70' : 'RSI below 50 and above 30', ok: v.rsi != null && (long ? v.rsi > 50 && v.rsi < 70 : v.rsi < 50 && v.rsi > 30) },
    { key: 'macd', label: long ? 'MACD bullish' : 'MACD bearish', ok: macd.available && macd.bias === (long ? 'bullish' : 'bearish') },
    { key: 'volume', label: 'Volume above average', ok: volume.ratio >= 1 },
    { key: 'break', label: long ? 'Breakout / retest confirmed' : 'Breakdown / retest confirmed', ok: brkSide && (breakout.status === 'BREAKOUT' || breakout.status === 'BREAKDOWN') && (breakout.confirmed || breakout.retestHold) },
    { key: 'candle', label: long ? 'Bullish candle structure' : 'Bearish candle structure', ok: net > 0.15 || (long ? snap.candle.close > snap.candle.open && (snap.candle.close - snap.candle.low) / ((snap.candle.high - snap.candle.low) || 1) >= 0.6 : snap.candle.close < snap.candle.open && (snap.candle.high - snap.candle.close) / ((snap.candle.high - snap.candle.low) || 1) >= 0.6) },
  ];
  const components = [
    { key: 'trend', label: 'TREND', score: trend, max: 20 },
    { key: 'momentum', label: 'MOMENTUM', score: mom, max: 20 },
    { key: 'volume', label: 'VOLUME', score: vol, max: 20 },
    { key: 'structure', label: 'STRUCTURE', score: str, max: 20 },
    { key: 'candle', label: 'CANDLE', score: candle, max: 10 },
    { key: 'market', label: 'MARKET', score: market, max: 10 },
  ];
  return { side, components, total: components.reduce((s, c) => s + c.score, 0), checks, met: checks.filter((c) => c.ok).length };
}

export function calculateEntryScore(snap) {
  const L = scoreSide(snap, 'LONG');
  const S = scoreSide(snap, 'SHORT');
  const best = L.total >= S.total ? L : S;
  const direction = best.side;
  const margin = Math.abs(L.total - S.total);
  const long = direction === 'LONG';
  const b = snap.breakout;
  const falseMove = (long && b.direction === 'UP' || !long && b.direction === 'DOWN') && /FALSE/.test(b.status);

  let tier = best.total >= 80 ? 3 : best.total >= 65 ? 2 : best.total >= 55 ? 1 : 0;
  if (margin < 10) tier = 0;
  if (tier === 3 && best.met < 6) tier = 2;
  if (tier === 2 && best.met < 5) tier = 1;
  if (tier === 1 && best.met < 4) tier = 0;
  if (falseMove) tier = 0;
  const names = ['WAIT', long ? 'WEAK BUY' : 'WEAK SELL', long ? 'BUY' : 'SELL', long ? 'STRONG BUY' : 'STRONG SELL'];
  const signal = names[tier];

  const reasons = [];
  best.checks.filter((c) => c.ok).forEach((c) => reasons.push(c.label));
  if (snap.structure.trend !== 'SIDEWAYS') reasons.push(`Market structure ${snap.structure.trend.toLowerCase()} (${snap.structure.structure})`);
  const warnings = [];
  if (falseMove) warnings.push(b.message);
  if (long && snap.v.rsi >= 70) warnings.push('RSI overbought - chasing risk');
  if (!long && snap.v.rsi <= 30) warnings.push('RSI oversold - chasing risk');
  if (snap.volume.ratio < 0.8) warnings.push('Volume below average - moves lack participation');
  if (margin < 10) warnings.push('Bullish and bearish evidence are nearly balanced');
  if (best.met < 4 && best.total >= 55) warnings.push(`Only ${best.met}/7 confirmations pass`);
  if (long && snap.divergence.bearish) warnings.push('Bearish RSI divergence');
  if (!long && snap.divergence.bullish) warnings.push('Bullish RSI divergence');
  if (long && snap.structure.trend === 'BEARISH') warnings.push('Trading against bearish structure');
  if (!long && snap.structure.trend === 'BULLISH') warnings.push('Trading against bullish structure');

  return {
    direction, signal, total: best.total, margin, tier,
    components: best.components, checks: best.checks, met: best.met,
    long: { total: L.total, components: L.components, checks: L.checks, met: L.met },
    short: { total: S.total, components: S.components, checks: S.checks, met: S.met },
    reasons, warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Timeline with hysteresis                                            */
/* ------------------------------------------------------------------ */
const timelineCache = new Map();
const WARMUP = 30;

/**
 * Signal for every bar. To stop the displayed signal flickering, the STABLE signal
 * only changes after the new raw signal has appeared on 2 consecutive bars.
 * Completed bars are cached (their values can never change), so each poll only
 * recomputes the forming bar.
 */
export function computeSignalTimeline(ctx, cacheKey) {
  const { candles } = ctx;
  const n = candles.length;
  let entries = [];
  const cached = timelineCache.get(cacheKey);
  if (cached) {
    const L = cached.length;
    if (L > 0 && L <= n - 1 && candles[L - 1].time === cached[L - 1].time) entries = cached.slice();
  }
  for (let i = entries.length; i < n; i++) {
    const c = candles[i];
    if (i < WARMUP) {
      entries.push({ i, time: c.time, price: c.close, raw: 'WAIT', stable: 'WAIT', pendingLabel: null, pendingCount: 0, score: 0, direction: 'LONG', longTotal: 0, shortTotal: 0, changed: false, why: null });
      continue;
    }
    const sc = calculateEntryScore(buildSnapshot(ctx, i));
    const prev = entries[i - 1];
    let stable = prev.stable, pl = prev.pendingLabel, pc = prev.pendingCount, changed = false;
    if (sc.signal === stable) { pl = null; pc = 0; }
    else {
      if (pl === sc.signal) pc++; else { pl = sc.signal; pc = 1; }
      if (pc >= 2) { stable = sc.signal; pl = null; pc = 0; changed = true; }
    }
    entries.push({
      i, time: c.time, price: c.close, raw: sc.signal, stable, pendingLabel: pl, pendingCount: pc,
      score: sc.total, direction: sc.direction, longTotal: sc.long.total, shortTotal: sc.short.total, changed,
      why: changed ? [...sc.reasons.slice(0, 3), ...sc.warnings.slice(0, 1)].join('; ') || null : null,
    });
  }
  timelineCache.set(cacheKey, entries.slice(0, Math.max(0, n - 1)));
  if (timelineCache.size > 30) timelineCache.delete(timelineCache.keys().next().value);
  return entries;
}

export function signalHistory(timeline, limit = 40) {
  const out = [];
  for (const e of timeline) {
    if (e.changed) out.push({ time: e.time, signal: e.stable, price: e.price, score: e.score, why: e.why });
  }
  return out.slice(-limit).reverse();
}

/* ------------------------------------------------------------------ */
/* Trade setup                                                         */
/* ------------------------------------------------------------------ */
export function setupConfidence(scoring, snap, direction, historyContext = null) {
  const s = direction === 'LONG' ? scoring.long : scoring.short;
  let c = 0.6 * s.total + 0.25 * (s.met / 7) * 100 + 0.15 * snap.structure.strength;
  if (/POSSIBLE_FALSE|FALSE/.test(snap.breakout.status)) c -= 15;
  if (direction === 'LONG' && snap.structure.trend === 'BEARISH') c -= 10;
  if (direction === 'SHORT' && snap.structure.trend === 'BULLISH') c -= 10;
  if (historyContext?.available && direction === 'LONG' && historyContext.trend === 'BEARISH') c -= 10;
  if (historyContext?.available && direction === 'SHORT' && historyContext.trend === 'BULLISH') c -= 10;
  if (snap.volume.ratio < 0.8) c -= 5;
  return Math.round(clamp(c, 15, 90)); // capped below 100: nothing here is certain
}

export function buildTradeSetup(ctx, i, snap, scoring, stableSignal, directionOverride = null, entryOverride = null, historyContext = null) {
  const stableSide = sideOf(stableSignal);
  const direction = directionOverride || stableSide || scoring.direction;
  const long = direction === 'LONG';
  const { levels, v, price } = snap;
  const atr = v.atr;
  const staticLevel = (arr) => arr.find((l) => !l.dynamic);
  const ahead = long ? staticLevel(levels.resistance) : staticLevel(levels.support);
  const gap = ahead ? Math.abs(ahead.price - price) : null;
  const b = snap.breakout;
  const brokeSide = b.direction === (long ? 'UP' : 'DOWN') && (b.status === 'BREAKOUT' || b.status === 'BREAKDOWN');
  const extended = v.ema20 != null && (long ? price - v.ema20 > 2 * atr : v.ema20 - price > 2 * atr);
  const active = !directionOverride && stableSide === direction;
  const verb = long ? 'BUY' : 'SELL';
  const tf = ctx.interval === '1m' || ctx.interval === '3m' ? '5-minute' : ctx.interval;

  let status, entry, confirmation = null;
  let trigger = ahead ? roundToTick(ahead.price + (long ? 1 : -1) * 0.1 * atr, long ? 'up' : 'down') : null;
  const matchingPattern = snap.patterns.find((pattern) => pattern.age <= 1
    && (long ? pattern.bias === 'bullish' : pattern.bias === 'bearish'));
  let patternTrigger = null, patternRange = 0;
  if (matchingPattern) {
    const name = matchingPattern.name;
    const patternLength = /Morning Star|Evening Star|Three White Soldiers|Three Black Crows/.test(name) ? 3 : /Engulfing/.test(name) ? 2 : 1;
    const patternBars = ctx.candles.slice(Math.max(0, matchingPattern.barIndex - patternLength + 1), matchingPattern.barIndex + 1);
    if (patternBars.length) {
      const patternHigh = Math.max(...patternBars.map((candle) => candle.high));
      const patternLow = Math.min(...patternBars.map((candle) => candle.low));
      patternRange = patternHigh - patternLow;
      patternTrigger = roundToTick(
      long ? patternHigh + 0.1 * atr : patternLow - 0.1 * atr,
      long ? 'up' : 'down',
      );
    }
  }
  if (patternTrigger != null) trigger = trigger == null ? patternTrigger : (long ? Math.max(trigger, patternTrigger) : Math.min(trigger, patternTrigger));
  if (entryOverride != null) { status = 'USER-DEFINED ENTRY'; entry = entryOverride; }
  else if (directionOverride) { status = `MANUAL ${verb} AT CURRENT PRICE`; entry = price; }
  else if (!active) {
    status = 'WAIT';
    entry = trigger ?? price;
    confirmation = trigger ? `Wait for a ${tf} candle close ${long ? 'above' : 'below'} ₹${trigger.toFixed(2)} with above-average volume` : 'Wait for clearer evidence';
  } else if (extended) {
    const pb = long ? levels.support[0] : levels.resistance[0];
    status = 'WAIT FOR PULLBACK';
    entry = pb ? roundToTick(pb.price) : price;
    confirmation = `Price is more than 2 ATR from EMA 20 - wait for a pullback toward ₹${entry.toFixed(2)} that holds`;
  } else if (matchingPattern && trigger != null && (long ? price < trigger : price > trigger)) {
    status = `${verb} ON CONFIRMATION`;
    entry = trigger;
    confirmation = `Wait for a candle-pattern breakout: ${matchingPattern.name} candle close ${long ? 'above' : 'below'} ₹${trigger.toFixed(2)} with follow-through`;
  } else if (!brokeSide && ahead && gap <= 0.8 * atr) {
    status = `${verb} ON CONFIRMATION`;
    entry = trigger;
    confirmation = `${tf} candle close ${long ? 'above' : 'below'} ₹${trigger.toFixed(2)} with above-average volume`;
  } else {
    status = `${verb} NOW (CONDITIONS MET)`;
    entry = price;
  }

  const sl = calculateStopLoss(ctx, i, direction, levels, { entry, structure: snap.structure, volume: snap.volume });
  const tg = calculateTargets(ctx, i, direction, entry, sl.stopLoss, levels);
  if (matchingPattern) {
    const measuredTarget1 = entry + (long ? 1 : -1) * patternRange;
    const measuredTarget2 = entry + (long ? 2 : -2) * patternRange;
    const target1Reward = long ? measuredTarget1 - entry : entry - measuredTarget1;
    const target2Reward = long ? measuredTarget2 - entry : entry - measuredTarget2;
    if (patternRange > 0 && target1Reward >= sl.risk && (long ? measuredTarget1 < tg.target1 : measuredTarget1 > tg.target1)) {
      tg.target1 = roundToTick(measuredTarget1, long ? 'down' : 'up');
      tg.target1Note = `one-candle measured move from ${matchingPattern.name}`;
    }
    if (patternRange > 0 && target2Reward > target1Reward && (long ? measuredTarget2 < tg.target2 : measuredTarget2 > tg.target2)) {
      tg.target2 = roundToTick(measuredTarget2, long ? 'down' : 'up');
      tg.target2Note = `two-candle-range projection from ${matchingPattern.name}`;
    }
    tg.reward1 = Math.abs(tg.target1 - entry);
    tg.reward2 = Math.abs(tg.target2 - entry);
    tg.rr1 = sl.risk > 0 ? tg.reward1 / sl.risk : null;
    tg.rr2 = sl.risk > 0 ? tg.reward2 / sl.risk : null;
  }
  const confidence = setupConfidence(scoring, snap, direction, historyContext);
  const s = long ? scoring.long : scoring.short;
  return {
    direction, status, active,
    entry, stopLoss: sl.stopLoss, risk: sl.risk, riskPct: sl.riskPct,
    target1: tg.target1, target2: tg.target2, reward1: tg.reward1, reward2: tg.reward2, rr1: tg.rr1, rr2: tg.rr2,
    target1Note: tg.target1Note, target2Note: tg.target2Note,
    signalStrength: s.total, confidence, confirmation,
    historyContext,
    candlePattern: matchingPattern ? { name: matchingPattern.name, bias: matchingPattern.bias, strength: matchingPattern.strength, trigger: patternTrigger } : null,
    invalidation: `Setup invalid if price ${long ? 'falls below' : 'rises above'} ₹${sl.stopLoss.toFixed(2)}`,
    stop: sl,
    checks: s.checks, met: s.met,
  };
}

/* ------------------------------------------------------------------ */
/* Backtest                                                            */
/* ------------------------------------------------------------------ */
const backtestCache = new Map();

/**
 * Replays the exact live signal logic over history (completed candles only).
 *  - entry on the OPEN of the bar after a new BUY/STRONG BUY or SELL/STRONG SELL (stable) signal
 *  - stop-loss and target 1 come from the same calculateStopLoss/calculateTargets used live
 *  - stop checked first when a bar touches both (conservative)
 *  - intraday trades are closed at the last bar of the session; max hold 60 bars
 *  - drawdown assumes risking 1% of equity per trade, compounded; no brokerage or slippage
 */
export function runBacktest(ctx, timeline, cacheKey, options = {}) {
  const { candles } = ctx;
  const n = candles.length;
  const { startTime = null, endTime = null, minConfidence = 0, maxConfidence = 100, includeTrades = false, useHistoryConfidence = false } = options;
  let last = n - 2;
  while (last >= 0 && endTime != null && candles[last].time > endTime) last--;
  const ck = `${cacheKey}|${n}|${candles[n - 1].time}|${startTime}|${endTime}|${minConfidence}|${maxConfidence}|${includeTrades}|${useHistoryConfidence}`;
  if (backtestCache.has(ck)) return backtestCache.get(ck);
  const label = 'HISTORICAL BACKTEST - past results do not predict or guarantee future performance';
  if (n < 150) {
    return { sufficient: false, label, message: `Needs at least 150 candles to backtest (loaded ${n}). Try a lower timeframe.` };
  }
  const trades = [];
  let pos = null;
  const strongSide = (s) => (['BUY', 'STRONG BUY'].includes(s) ? 'LONG' : ['SELL', 'STRONG SELL'].includes(s) ? 'SHORT' : null);
  for (let j = WARMUP + 2; j <= last; j++) {
    if (!pos) {
      const prev = timeline[j - 1];
      const dir = strongSide(prev.stable);
      const isNew = dir && strongSide(timeline[j - 2].stable) !== dir;
      const sameDay = ctx.isDaily || ctx.dayOf[j] === ctx.dayOf[j - 1];
      const timeOk = ctx.isDaily || istMinutes(candles[j].time) <= 14 * 60 + 45;
      if (isNew && sameDay && timeOk && (startTime == null || candles[j].time >= startTime)) {
        const entry = candles[j].open;
        const snap = buildSnapshot(ctx, j - 1);
        const scoring = calculateEntryScore(snap);
        const historyContext = useHistoryConfidence ? getHistoryContext(aggregateDailyCandles(candles.slice(0, j))) : null;
        if (!useHistoryConfidence || historyContext.available) {
          const setup = buildTradeSetup(ctx, j - 1, snap, scoring, prev.stable, null, entry, historyContext);
          const okSide = dir === 'LONG' ? setup.stopLoss < entry && setup.target1 > entry : setup.stopLoss > entry && setup.target1 < entry;
          if (okSide && setup.risk > 0 && setup.confidence >= minConfidence && setup.confidence <= maxConfidence) {
            pos = {
              symbol: ctx.symbol || null,
              dir, entry, stop: setup.stopLoss, t1: setup.target1, t2: setup.target2,
              risk: setup.risk, rr: setup.rr1, confidence: setup.confidence,
              pattern: setup.candlePattern?.name || null,
              start: j, time: candles[j].time,
            };
          }
        }
      }
    }
    if (pos && j >= pos.start) {
      const c = candles[j];
      const long = pos.dir === 'LONG';
      const endOfSession = !ctx.isDaily && (j === last || ctx.dayOf[j + 1] !== ctx.dayOf[j]);
      let exit = null, R = 0, why = null;
      if (long ? c.low <= pos.stop : c.high >= pos.stop) { exit = pos.stop; R = -1; why = 'stop'; }
      else if (long ? c.high >= pos.t1 : c.low <= pos.t1) { exit = pos.t1; R = pos.rr; why = 'target'; }
      else if (endOfSession || j - pos.start >= 60 || j === last) { exit = c.close; R = ((long ? 1 : -1) * (exit - pos.entry)) / pos.risk; why = 'time'; }
      if (exit != null) { trades.push({ ...pos, exit, R, why, endTime: c.time }); pos = null; }
    }
  }
  const wins = trades.filter((t) => t.R > 0).length;
  const losses = trades.length - wins;
  const grossWin = trades.filter((t) => t.R > 0).reduce((s, t) => s + t.R, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.R <= 0).reduce((s, t) => s + t.R, 0));
  let eq = 1, peak = 1, maxDd = 0;
  for (const t of trades) {
    eq *= 1 + 0.01 * t.R;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  const result = {
    sufficient: true, label,
    signals: trades.length, wins, losses,
    winRate: trades.length ? (wins / trades.length) * 100 : null,
    avgRewardRisk: trades.length ? trades.reduce((s, t) => s + t.rr, 0) / trades.length : null,
    avgRealizedR: trades.length ? trades.reduce((s, t) => s + t.R, 0) / trades.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownPct: maxDd * 100,
    from: candles[0].time, to: candles[last].time, candlesTested: last + 1,
    message: trades.length === 0 ? 'No qualifying BUY/SELL signals occurred in the loaded history.' : trades.length < 20 ? `Small sample (${trades.length} trades) - treat these statistics as weak evidence.` : null,
    assumptions: `Entry at next bar open; ${useHistoryConfidence ? `confidence ${minConfidence}%–${maxConfidence}% using historical daily context; ` : ''}stop-first on ambiguous bars; 1% equity risked per trade; no brokerage/slippage/taxes.`,
  };
  if (includeTrades) result.trades = trades;
  backtestCache.set(ck, result);
  if (backtestCache.size > 30) backtestCache.delete(backtestCache.keys().next().value);
  return result;
}

export { TICK };
