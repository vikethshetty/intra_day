/**
 * Technical analysis engine.
 *
 * `buildContext(candles, interval)` pre-computes every indicator series once.
 * `buildSnapshot(ctx, i)` then evaluates the market "as of" candle i using only
 * information available at that time (no look-ahead), which is what allows the
 * same code to power the live view, the signal timeline and the backtest.
 */
import * as ind from '../utils/indicators.js';
import { clamp, roundToTick, istMinutes } from '../utils/indicators.js';
import { atrAt, detectCandlestickPatterns, candleBias } from './candleAnalysisService.js';

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */
export function buildContext(candles, interval) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const isDaily = interval === '1D';
  const series = {
    ema9: ind.calculateEMA(closes, 9),
    ema20: ind.calculateEMA(closes, 20),
    ema50: ind.calculateEMA(closes, 50),
    ema200: ind.calculateEMA(closes, 200),
    sma20: ind.calculateSMA(closes, 20),
    sma50: ind.calculateSMA(closes, 50),
    rsi: ind.calculateRSI(closes, 14),
    macd: ind.calculateMACD(closes),
    vwap: ind.calculateVWAP(candles, interval),
    bb: ind.calculateBollingerBands(closes, 20, 2),
    atr: ind.calculateATR(candles, 14),
    adx: ind.calculateADX(candles, 14),
    volMA: ind.calculateSMA(volumes, 20),
  };

  // Session bookkeeping: running day high/low (causal) and the list of days.
  const dayOf = new Array(candles.length);
  const dayHighRun = new Array(candles.length);
  const dayLowRun = new Array(candles.length);
  const days = [];
  let lastKey = null;
  candles.forEach((c, i) => {
    const key = isDaily ? i : ind.istDayKey(c.time);
    if (key !== lastKey) {
      days.push({ key, start: i, open: c.open, high: c.high, low: c.low, close: c.close, end: i });
      lastKey = key;
    }
    const d = days[days.length - 1];
    d.high = Math.max(d.high, c.high);
    d.low = Math.min(d.low, c.low);
    d.close = c.close;
    d.end = i;
    dayOf[i] = days.length - 1;
    dayHighRun[i] = d.high;
    dayLowRun[i] = d.low;
  });

  const lr = isDaily ? 2 : 3;
  const swings = ind.findSwings(candles, lr, lr);
  return { candles, interval, isDaily, closes, volumes, series, dayOf, days, dayHighRun, dayLowRun, swings };
}

/** Swings that were already confirmed at bar i and lie within `lookback` bars. */
export function confirmedSwings(ctx, i, lookback = 120) {
  const from = i - lookback;
  const f = (arr) => arr.filter((s) => s.confirmedAt <= i && s.index >= from);
  return { highs: f(ctx.swings.highs), lows: f(ctx.swings.lows) };
}

const val = (arr, i) => (i >= 0 && arr[i] != null ? arr[i] : null);

/* ------------------------------------------------------------------ */
/* Volume                                                              */
/* ------------------------------------------------------------------ */
/**
 * Volume strength. Baseline = average volume of the 20 bars BEFORE the bar.
 * The latest candle is usually still forming, so the ratio used for
 * confirmation is the larger of (latest bar, previous bar) vs. baseline.
 * Pressure = volume-weighted close-location value over the last 10 bars
 * (+1 closes at highs on volume, -1 closes at lows on volume).
 */
export function calculateVolumeStrength(ctx, i) {
  const { candles, series } = ctx;
  const ratioAt = (k) => {
    const base = val(series.volMA, k - 1);
    return base > 0 ? candles[k].volume / base : null;
  };
  const rNow = ratioAt(i);
  const rPrev = i > 0 ? ratioAt(i - 1) : null;
  const ratio = Math.max(rNow ?? 0, rPrev ?? 0) || (rNow ?? 0);
  const average = val(series.volMA, i - 1);

  const avgOf = (a, b) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, a); k <= b; k++) { s += candles[k].volume; n++; }
    return n ? s / n : 0;
  };
  const recent = avgOf(i - 2, i);
  const before = avgOf(i - 5, i - 3);
  const trend = before > 0 ? (recent / before > 1.15 ? 'INCREASING' : recent / before < 0.87 ? 'DECREASING' : 'STEADY') : 'STEADY';

  let num = 0, den = 0;
  for (let k = Math.max(0, i - 9); k <= i; k++) {
    const c = candles[k];
    const r = c.high - c.low;
    const mfm = r > 0 ? (c.close - c.low - (c.high - c.close)) / r : 0;
    num += mfm * c.volume;
    den += c.volume;
  }
  const pressure = den > 0 ? num / den : 0;
  const label = ratio >= 2 ? 'VERY HIGH' : ratio >= 1.5 ? 'HIGH' : ratio >= 0.8 ? 'NORMAL' : ratio >= 0.5 ? 'LOW' : 'VERY LOW';
  const interpretation = ratio >= 2 ? 'Very strong participation' : ratio >= 1.5 ? 'Strong participation' : ratio >= 1 ? 'Healthy participation' : ratio >= 0.7 ? 'Light participation' : 'Weak participation - breakouts on this volume are unreliable';
  return {
    current: candles[i].volume,
    average,
    ratio: Number(ratio.toFixed(2)),
    ratioLatest: rNow != null ? Number(rNow.toFixed(2)) : null,
    label,
    spike: ratio >= 2,
    trend,
    pressure: Number(pressure.toFixed(2)),
    pressureLabel: pressure > 0.15 ? 'BUYING PRESSURE' : pressure < -0.15 ? 'SELLING PRESSURE' : 'BALANCED',
    interpretation,
  };
}

/* ------------------------------------------------------------------ */
/* Trend strength + market structure                                   */
/* ------------------------------------------------------------------ */
/**
 * Trend strength 0-100 (direction-agnostic):
 *   40 pts ADX (50+ = full)   30 pts EMA alignment   30 pts clean HH/HL or LH/LL structure
 */
export function calculateTrendStrength(ctx, i, structureTrend = 'SIDEWAYS') {
  const { series } = ctx;
  const adx = val(series.adx.adx, i);
  const adxPts = adx != null ? clamp(adx / 50, 0, 1) * 40 : 15;
  const e = [val(series.ema9, i), val(series.ema20, i), val(series.ema50, i), val(series.ema200, i)];
  let bull = 0, bear = 0, pairs = 0;
  for (let k = 0; k < 3; k++) {
    if (e[k] != null && e[k + 1] != null) {
      pairs++;
      if (e[k] > e[k + 1]) bull++; else if (e[k] < e[k + 1]) bear++;
    }
  }
  const emaPts = pairs ? (Math.max(bull, bear) / pairs) * 30 : 10;
  const structPts = structureTrend === 'SIDEWAYS' ? 8 : 30;
  return Math.round(clamp(adxPts + emaPts + structPts, 0, 100));
}

/** Higher-high / higher-low (etc.) classification from confirmed swing points. */
export function detectMarketStructure(ctx, i) {
  const { highs, lows } = confirmedSwings(ctx, i, 150);
  const price = ctx.candles[i].close;
  const eps = price * 0.0003;
  const cmp = (a, b) => (a > b + eps ? 'H' : a < b - eps ? 'L' : 'E');
  const h = highs.slice(-3);
  const l = lows.slice(-3);
  let highRel = null, lowRel = null;
  if (h.length >= 2) highRel = cmp(h[h.length - 1].price, h[h.length - 2].price);
  if (l.length >= 2) lowRel = cmp(l[l.length - 1].price, l[l.length - 2].price);

  let trend = 'SIDEWAYS';
  let structure = 'Not enough confirmed swings yet';
  if (highRel && lowRel) {
    if (highRel === 'H' && lowRel === 'H') { trend = 'BULLISH'; structure = 'Higher High + Higher Low'; }
    else if (highRel === 'L' && lowRel === 'L') { trend = 'BEARISH'; structure = 'Lower High + Lower Low'; }
    else if (highRel === 'H' && lowRel === 'L') structure = 'Expanding range (Higher High + Lower Low)';
    else if (highRel === 'L' && lowRel === 'H') structure = 'Contracting range (Lower High + Higher Low)';
    else if (highRel === 'H') { trend = 'BULLISH'; structure = 'Higher High, flat low'; }
    else if (lowRel === 'H') { trend = 'BULLISH'; structure = 'Higher Low, flat high'; }
    else if (highRel === 'L') { trend = 'BEARISH'; structure = 'Lower High, flat low'; }
    else if (lowRel === 'L') { trend = 'BEARISH'; structure = 'Lower Low, flat high'; }
    else structure = 'Flat highs and lows';
  }
  const lastHigh = h[h.length - 1] || null;
  const lastLow = l[l.length - 1] || null;
  // A close beyond the last opposing swing means the structure is breaking.
  let broken = false;
  if (trend === 'BULLISH' && lastLow && price < lastLow.price) broken = true;
  if (trend === 'BEARISH' && lastHigh && price > lastHigh.price) broken = true;
  if (broken) structure += ' (structure break in progress)';
  const strength = calculateTrendStrength(ctx, i, trend);
  return {
    trend: broken ? 'SIDEWAYS' : trend,
    rawTrend: trend,
    structure,
    strength,
    highRel, lowRel,
    lastSwingHigh: lastHigh ? { price: lastHigh.price, time: lastHigh.time } : null,
    lastSwingLow: lastLow ? { price: lastLow.price, time: lastLow.time } : null,
    broken,
  };
}

/* ------------------------------------------------------------------ */
/* Support / resistance                                                */
/* ------------------------------------------------------------------ */
function volumeProfile(ctx, i, bars = 300, bins = 30) {
  const from = Math.max(0, i - bars + 1);
  let lo = Infinity, hi = -Infinity;
  for (let k = from; k <= i; k++) { lo = Math.min(lo, ctx.candles[k].low); hi = Math.max(hi, ctx.candles[k].high); }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array(bins).fill(0);
  for (let k = from; k <= i; k++) {
    const c = ctx.candles[k];
    const tp = (c.high + c.low + c.close) / 3;
    vol[Math.min(bins - 1, Math.floor((tp - lo) / step))] += c.volume;
  }
  const max = Math.max(...vol);
  if (!(max > 0)) return null;
  const nodes = vol.map((v, b) => ({ price: lo + (b + 0.5) * step, v })).filter((n) => n.v >= 0.7 * max).sort((a, b) => b.v - a.v);
  return { poc: nodes[0].price, nodes: nodes.slice(0, 3).map((n) => n.price) };
}

/**
 * Collect candidate levels from many sources, merge those closer than a
 * tolerance (confluence), and rank them. Strength grows with confluence.
 */
export function detectSupportResistance(ctx, i, { light = false } = {}) {
  const { candles, series } = ctx;
  const price = candles[i].close;
  const atr = atrAt(ctx, i);
  const di = ctx.dayOf[i];
  const prev = di > 0 ? ctx.days[di - 1] : null;
  const cands = [];
  const add = (p, label, source, weight, dynamic = false) => {
    if (p != null && Number.isFinite(p) && p > 0) cands.push({ price: p, label, source, weight, dynamic });
  };

  if (prev) {
    add(prev.high, 'Prev day high', 'prevDay', 3);
    add(prev.low, 'Prev day low', 'prevDay', 3);
  }
  if (!ctx.isDaily) {
    add(ctx.dayHighRun[i], 'Day high', 'day', 2.5);
    add(ctx.dayLowRun[i], 'Day low', 'day', 2.5);
  }
  const sw = confirmedSwings(ctx, i, 200);
  sw.highs.forEach((s) => add(s.price, 'Swing high', 'swing', 2));
  sw.lows.forEach((s) => add(s.price, 'Swing low', 'swing', 2));

  // Classic pivot points from the previous session (H, L, C).
  let pivots = null;
  if (prev) {
    const P = (prev.high + prev.low + prev.close) / 3;
    const rg = prev.high - prev.low;
    pivots = {
      P, R1: 2 * P - prev.low, S1: 2 * P - prev.high,
      R2: P + rg, S2: P - rg,
      R3: prev.high + 2 * (P - prev.low), S3: prev.low - 2 * (prev.high - P),
    };
    add(P, 'Pivot', 'pivot', 1.5);
    ['R1', 'R2', 'R3', 'S1', 'S2', 'S3'].forEach((k) => add(pivots[k], `Pivot ${k}`, 'pivot', 2));
  }

  let fib = null;
  let poc = null;
  if (!light) {
    // Fibonacci retracements of the most recent swing range (last 120 bars).
    const from = Math.max(0, i - 119);
    let hi = -Infinity, lo = Infinity, hiI = from, loI = from;
    for (let k = from; k <= i; k++) {
      if (candles[k].high > hi) { hi = candles[k].high; hiI = k; }
      if (candles[k].low < lo) { lo = candles[k].low; loI = k; }
    }
    if (hi > lo) {
      fib = {};
      [0.236, 0.382, 0.5, 0.618, 0.786].forEach((r) => {
        const p = loI < hiI ? hi - (hi - lo) * r : lo + (hi - lo) * r; // retracement of the up-leg or down-leg
        fib[`${(r * 100).toFixed(1)}%`] = p;
        add(p, `Fib ${(r * 100).toFixed(1)}%`, 'fib', 1.5);
      });
    }
    const vp = volumeProfile(ctx, i);
    if (vp) {
      poc = vp.poc;
      add(vp.poc, 'Volume POC', 'volume', 2);
      vp.nodes.slice(1).forEach((n) => add(n, 'High-volume node', 'volume', 1.2));
    }
  }
  add(val(series.vwap, i), 'VWAP', 'vwap', 1.5, true);
  add(val(series.ema20, i), 'EMA 20', 'ema', 1, true);
  add(val(series.ema50, i), 'EMA 50', 'ema', 1, true);
  add(val(series.ema200, i), 'EMA 200', 'ema', 1.2, true);

  // Merge levels that sit within ~0.2 ATR (or 0.07% of price) of each other.
  const tol = Math.max(0.2 * atr, price * 0.0007);
  cands.sort((a, b) => a.price - b.price);
  const groups = [];
  let cur = null;
  for (const c of cands) {
    if (cur && c.price - cur.last <= tol) { cur.items.push(c); cur.last = c.price; }
    else { cur = { items: [c], last: c.price }; groups.push(cur); }
  }
  const all = groups.map((g) => {
    const w = g.items.reduce((s, x) => s + x.weight, 0);
    const p = g.items.reduce((s, x) => s + x.price * x.weight, 0) / w;
    const labels = [...new Set(g.items.map((x) => x.label))];
    return {
      price: p,
      labels,
      label: labels.slice(0, 2).join(' + '),
      sources: [...new Set(g.items.map((x) => x.source))],
      dynamic: g.items.every((x) => x.dynamic),
      weight: w,
      strength: Math.round(clamp(20 + w * 10, 0, 95)),
    };
  });
  const resistance = all.filter((l) => l.price > price).sort((a, b) => a.price - b.price).map((l, k) => ({ ...l, name: `R${k + 1}` }));
  const support = all.filter((l) => l.price <= price).sort((a, b) => b.price - a.price).map((l, k) => ({ ...l, name: `S${k + 1}` }));
  return { price, resistance, support, all, pivots, fib, poc };
}

/* ------------------------------------------------------------------ */
/* Divergence                                                          */
/* ------------------------------------------------------------------ */
/**
 * RSI divergence between the last two confirmed swings:
 *  bullish: price makes a LOWER low while RSI makes a HIGHER low
 *  bearish: price makes a HIGHER high while RSI makes a LOWER high
 */
export function detectDivergence(ctx, i) {
  const { highs, lows } = confirmedSwings(ctx, i, 90);
  const rsi = ctx.series.rsi;
  const recentLimit = 30;
  let bullish = null, bearish = null;
  if (lows.length >= 2) {
    const a = lows[lows.length - 2], b = lows[lows.length - 1];
    const ra = rsi[a.index], rb = rsi[b.index];
    if (ra != null && rb != null && b.price < a.price * 0.9997 && rb > ra + 2 && b.index - a.index >= 4 && i - b.index <= recentLimit)
      bullish = { type: 'BULLISH', label: 'BULLISH DIVERGENCE', detail: 'Price: Lower Low, RSI: Higher Low', from: { time: a.time, price: a.price, rsi: ra }, to: { time: b.time, price: b.price, rsi: rb }, age: i - b.index };
  }
  if (highs.length >= 2) {
    const a = highs[highs.length - 2], b = highs[highs.length - 1];
    const ra = rsi[a.index], rb = rsi[b.index];
    if (ra != null && rb != null && b.price > a.price * 1.0003 && rb < ra - 2 && b.index - a.index >= 4 && i - b.index <= recentLimit)
      bearish = { type: 'BEARISH', label: 'BEARISH DIVERGENCE', detail: 'Price: Higher High, RSI: Lower High', from: { time: a.time, price: a.price, rsi: ra }, to: { time: b.time, price: b.price, rsi: rb }, age: i - b.index };
  }
  let active = null;
  if (bullish && bearish) active = bullish.age <= bearish.age ? bullish : bearish;
  else active = bullish || bearish;
  return { bullish, bearish, active };
}

/* ------------------------------------------------------------------ */
/* VWAP + MACD                                                         */
/* ------------------------------------------------------------------ */
export function detectVwapEvents(ctx, i) {
  const { candles, series } = ctx;
  const vw = series.vwap[i];
  if (vw == null) return { available: false, relation: 'N/A', event: null, bias: 'neutral' };
  const c = candles[i];
  const relation = c.close > vw ? 'ABOVE' : c.close < vw ? 'BELOW' : 'AT';
  const volRatio = (k) => { const b = val(series.volMA, k - 1); return b > 0 ? candles[k].volume / b : 0; };
  let event = null, bias = 'neutral', at = null;
  for (let j = i; j >= Math.max(1, i - 2); j--) {
    const a = series.vwap[j], b = series.vwap[j - 1];
    if (a == null || b == null || ctx.dayOf[j] !== ctx.dayOf[j - 1]) continue;
    const up = candles[j - 1].close <= b && candles[j].close > a;
    const down = candles[j - 1].close >= b && candles[j].close < a;
    const vr = Math.max(volRatio(j), volRatio(Math.min(i, j + 1)));
    if (up) {
      event = vr >= 1.5 ? 'BULLISH VWAP BREAKOUT' : vr >= 1 ? 'BULLISH VWAP RECLAIM' : 'VWAP cross above (low volume - unconfirmed)';
      bias = vr >= 1 ? 'bullish' : 'neutral'; at = j; break;
    }
    if (down) {
      event = vr >= 1 ? 'BEARISH VWAP BREAKDOWN' : 'VWAP lost (low volume - unconfirmed)';
      bias = vr >= 1 ? 'bearish' : 'neutral'; at = j; break;
    }
  }
  if (!event) {
    const r = c.high - c.low;
    if (relation === 'BELOW' && r > 0 && c.high >= vw * 0.9995 && c.close < vw && upperWickOf(c) >= 0.4 * r) { event = 'BEARISH VWAP REJECTION'; bias = 'bearish'; at = i; }
    if (relation === 'ABOVE' && r > 0 && c.low <= vw * 1.0005 && c.close > vw && lowerWickOf(c) >= 0.4 * r) { event = 'BULLISH VWAP SUPPORT (bounce)'; bias = 'bullish'; at = i; }
  }
  return { available: true, value: vw, relation, distancePct: ((c.close - vw) / vw) * 100, event, bias, time: at != null ? candles[at].time : null, barIndex: at };
}
const upperWickOf = (c) => c.high - Math.max(c.open, c.close);
const lowerWickOf = (c) => Math.min(c.open, c.close) - c.low;

export function analyzeMacd(ctx, i) {
  const { macd, signal, histogram } = ctx.series.macd;
  if (macd[i] == null || signal[i] == null) return { available: false, bias: 'neutral', label: 'Warming up' };
  let crossover = null, crossAge = null;
  for (let j = i; j >= Math.max(1, i - 2); j--) {
    if (macd[j - 1] == null || signal[j - 1] == null) continue;
    const prev = macd[j - 1] - signal[j - 1];
    const now = macd[j] - signal[j];
    if (prev <= 0 && now > 0) { crossover = 'BULLISH'; crossAge = i - j; break; }
    if (prev >= 0 && now < 0) { crossover = 'BEARISH'; crossAge = i - j; break; }
  }
  let zeroCross = null;
  for (let j = i; j >= Math.max(1, i - 2); j--) {
    if (macd[j - 1] != null && macd[j] != null) {
      if (macd[j - 1] <= 0 && macd[j] > 0) { zeroCross = 'UP'; break; }
      if (macd[j - 1] >= 0 && macd[j] < 0) { zeroCross = 'DOWN'; break; }
    }
  }
  const h = [histogram[i], histogram[i - 1], histogram[i - 2]];
  let histogramTrend = 'MIXED';
  if (h.every((x) => x != null)) {
    if (h[0] > h[1] && h[1] > h[2]) histogramTrend = 'INCREASING';
    else if (h[0] < h[1] && h[1] < h[2]) histogramTrend = 'DECREASING';
  }
  const bias = macd[i] > signal[i] ? 'bullish' : 'bearish';
  const label = crossover ? `${crossover === 'BULLISH' ? 'Bullish' : 'Bearish'} crossover` : bias === 'bullish' ? 'Bullish (MACD above signal)' : 'Bearish (MACD below signal)';
  return { available: true, macd: macd[i], signal: signal[i], histogram: histogram[i], bias, crossover, crossAge, histogramTrend, zeroCross, aboveZero: macd[i] > 0, label };
}

/* ------------------------------------------------------------------ */
/* Breakouts / false breakouts                                         */
/* ------------------------------------------------------------------ */
/**
 * Looks at the last ~8 bars for a close through a significant static level.
 *  UP   : close crosses above a level           -> BREAKOUT
 *  DOWN : close crosses below a level           -> BREAKDOWN
 * Quality checks: volume vs average, rejection wick, close location in the bar,
 * RSI divergence. If the close falls back through the level (or the bar only
 * poked through and closed back), it is a FALSE breakout/breakdown. If it is
 * still holding but >=2 warnings are present it is flagged POSSIBLE_FALSE_*.
 */
export function detectBreakout(ctx, i, levels, divergence) {
  const { candles, series } = ctx;
  const price = candles[i].close;
  const atr = atrAt(ctx, i);
  const statics = levels.all.filter((l) => !l.dynamic && Math.abs(l.price - price) <= 3 * atr).sort((a, b) => b.strength - a.strength);
  const lookback = Math.min(8, i - 1);
  const volRatio = (k) => { const b = val(series.volMA, k - 1); return b > 0 ? candles[k].volume / b : 0; };

  let best = null;
  for (const L of statics) {
    const tol = L.price * 0.0003;
    for (let j = i; j >= i - lookback && j >= 1; j--) {
      const c = candles[j], pc = candles[j - 1].close;
      let type = null;
      if (pc <= L.price && c.close > L.price + tol) type = 'UP';
      else if (pc >= L.price && c.close < L.price - tol) type = 'DOWN';
      else if (c.high > L.price + tol && c.close < L.price && pc < L.price) type = 'UP_FAIL';
      else if (c.low < L.price - tol && c.close > L.price && pc > L.price) type = 'DOWN_FAIL';
      if (type) {
        const age = i - j;
        if (!best || age < best.age || (age === best.age && L.strength > best.level.strength)) best = { level: L, j, type, age };
        break;
      }
    }
  }
  if (!best) return { status: 'NONE', message: 'No recent break of a significant level.' };

  const { level: L, j, type, age } = best;
  const c = candles[j];
  const r = c.high - c.low || 1e-9;
  const vr = Math.max(volRatio(j), j < i ? volRatio(j + 1) : 0);
  const base = { level: L.price, levelLabel: L.label, age, time: c.time, barIndex: j, volumeRatio: Number(vr.toFixed(2)) };
  const warnings = [];

  if (type === 'UP_FAIL' || type === 'DOWN_FAIL') {
    const up = type === 'UP_FAIL';
    return {
      ...base, direction: up ? 'UP' : 'DOWN', status: up ? 'FALSE_BREAKOUT' : 'FALSE_BREAKDOWN', confirmed: false, retestHold: false,
      warnings: [up ? 'Price pushed above the level but the candle closed back below it' : 'Price pushed below the level but the candle closed back above it'],
      message: up ? `FALSE BREAKOUT at ₹${L.price.toFixed(2)} - price was rejected. Do not enter on the spike.` : `FALSE BREAKDOWN at ₹${L.price.toFixed(2)} - sellers failed to hold below. Do not short the spike.`,
    };
  }

  const up = type === 'UP';
  // Has price kept closing on the breakout side of the level since the break?
  let holds = true;
  for (let k = j; k <= i; k++) if (up ? candles[k].close < L.price : candles[k].close > L.price) holds = false;
  if (!holds) {
    return {
      ...base, direction: up ? 'UP' : 'DOWN', status: up ? 'FALSE_BREAKOUT' : 'FALSE_BREAKDOWN', confirmed: false, retestHold: false,
      warnings: ['Price closed back through the level after the break'],
      message: up ? `⚠ FALSE BREAKOUT: price broke ₹${L.price.toFixed(2)} but closed back below it.` : `⚠ FALSE BREAKDOWN: price broke ₹${L.price.toFixed(2)} but closed back above it.`,
    };
  }

  if (vr < 1.0) warnings.push(`Weak volume (${vr.toFixed(2)}x average)`);
  const wick = up ? upperWickOf(c) : lowerWickOf(c);
  if (wick >= 0.5 * r) warnings.push('Long rejection wick on the break candle');
  const closeLoc = up ? (c.close - c.low) / r : (c.high - c.close) / r;
  if (closeLoc < 0.4) warnings.push('Break candle closed in the weak part of its range');
  if (up && divergence?.bearish) warnings.push('Bearish RSI divergence present');
  if (!up && divergence?.bullish) warnings.push('Bullish RSI divergence present');

  const confirmedVol = vr >= 1.3 && warnings.length <= 1;
  // Retest: price came back to the level (within 0.3 ATR) and held.
  let retestHold = false;
  for (let k = j + 1; k <= i; k++) {
    if (up && candles[k].low <= L.price + 0.3 * atr && candles[k].close > L.price) retestHold = true;
    if (!up && candles[k].high >= L.price - 0.3 * atr && candles[k].close < L.price) retestHold = true;
  }
  const possibleFalse = warnings.length >= 2 && !retestHold;
  const status = possibleFalse ? (up ? 'POSSIBLE_FALSE_BREAKOUT' : 'POSSIBLE_FALSE_BREAKDOWN') : up ? 'BREAKOUT' : 'BREAKDOWN';
  const word = up ? 'breakout' : 'breakdown';
  const message = possibleFalse
    ? `⚠ POSSIBLE FALSE ${word.toUpperCase()} at ₹${L.price.toFixed(2)} - ${warnings.join('; ')}. Do not enter immediately; wait for a retest that holds.`
    : `${word.toUpperCase()} of ₹${L.price.toFixed(2)} ${confirmedVol ? 'with volume confirmation' : 'without strong volume confirmation yet'}${retestHold ? ' and a holding retest' : ''}.`;
  return { ...base, direction: up ? 'UP' : 'DOWN', status, confirmed: confirmedVol, retestHold, warnings, message };
}

/** Convenience wrapper: returns the breakout result only when it is a false/possibly-false move. */
export function detectFalseBreakout(ctx, i, levels, divergence) {
  const b = detectBreakout(ctx, i, levels, divergence);
  return /FALSE/.test(b.status) ? b : null;
}

/* ------------------------------------------------------------------ */
/* Stop-loss and targets                                               */
/* ------------------------------------------------------------------ */
/**
 * Technically-justified stop-loss.
 *  1. Collect protective anchors on the correct side of entry:
 *     recent confirmed swing points, static support/resistance, VWAP / EMA 20 / EMA 50, signal-candle extreme.
 *  2. Drop anchors closer than 0.5 ATR (inside normal noise) or farther than 3.5 ATR.
 *  3. Prefer the nearest STRUCTURAL anchor (swing / S-R). Else nearest dynamic anchor. Else entry -/+ 1.5 ATR.
 *  4. Add a volatility buffer: 0.30 ATR base, +0.10 if ATR% > 0.5, +0.20 if ATR% > 1.0, +0.10 if volume is thin.
 *  5. Keep total risk between 0.8 ATR and 3 ATR, then round to the 0.05 NSE tick.
 */
export function calculateStopLoss(ctx, i, direction, levels, { entry = null, structure = null, volume = null } = {}) {
  const { candles, series } = ctx;
  const long = direction === 'LONG';
  const e = entry ?? candles[i].close;
  const atr = atrAt(ctx, i);
  const sw = confirmedSwings(ctx, i, 60);
  const anchors = [];
  const push = (price, label, kind) => { if (price != null) anchors.push({ price, label, kind }); };

  (long ? sw.lows : sw.highs).slice(-3).forEach((s) => push(s.price, long ? 'recent swing low' : 'recent swing high', 'swing'));
  levels.all.filter((l) => !l.dynamic).forEach((l) => push(l.price, `${l.label} level`, 'level'));
  push(val(series.vwap, i), 'VWAP', 'dynamic');
  push(val(series.ema20, i), 'EMA 20', 'dynamic');
  push(val(series.ema50, i), 'EMA 50', 'dynamic');
  const lastTwo = candles.slice(Math.max(0, i - 1), i + 1);
  push(long ? Math.min(...lastTwo.map((c) => c.low)) : Math.max(...lastTwo.map((c) => c.high)), 'signal candle extreme', 'candle');

  const valid = anchors
    .filter((a) => (long ? e - a.price : a.price - e) >= 0.5 * atr && (long ? e - a.price : a.price - e) <= 3.5 * atr)
    .sort((a, b) => (long ? b.price - a.price : a.price - b.price));
  const structural = valid.find((a) => (a.kind === 'swing' || a.kind === 'level') && (long ? e - a.price : a.price - e) <= 2.5 * atr);
  const anchor = structural || valid[0] || null;

  const atrPct = (atr / e) * 100;
  let k = 0.3;
  if (atrPct > 1.0) k += 0.2; else if (atrPct > 0.5) k += 0.1;
  const thin = volume && volume.ratio < 0.8;
  if (thin) k += 0.1;
  const buffer = k * atr;

  const notes = [];
  let raw;
  if (anchor) {
    raw = long ? anchor.price - buffer : anchor.price + buffer;
    notes.push(`${long ? 'Below' : 'Above'} ${anchor.label} at ₹${anchor.price.toFixed(2)} (${anchor.kind === 'swing' || anchor.kind === 'level' ? 'structural level' : 'dynamic level'})`);
  } else {
    raw = long ? e - 1.5 * atr : e + 1.5 * atr;
    notes.push('No protective level found within 0.5-3.5 ATR; using 1.5 x ATR from entry');
  }
  notes.push(`Volatility buffer ₹${buffer.toFixed(2)} = ${k.toFixed(2)} x ATR(14) ₹${atr.toFixed(2)}${thin ? ' (extra for thin volume)' : ''}`);

  let risk = Math.abs(e - raw);
  let capped = null;
  if (risk < 0.8 * atr) { raw = long ? e - 0.8 * atr : e + 0.8 * atr; capped = 'widened to the 0.8 ATR minimum so normal noise does not stop the trade'; }
  if (risk > 3 * atr) { raw = long ? e - 3 * atr : e + 3 * atr; capped = 'limited to 3 ATR maximum risk - setup is wide, consider smaller size'; }
  if (capped) notes.push(`Risk ${capped}`);
  const stop = roundToTick(raw, long ? 'down' : 'up');
  risk = Math.abs(e - stop);

  const factors = [
    { name: 'ATR (14)', value: `₹${atr.toFixed(2)} (${atrPct.toFixed(2)}% of price)` },
    { name: 'Anchor', value: anchor ? `${anchor.label} ₹${anchor.price.toFixed(2)}` : 'ATR fallback' },
    { name: 'VWAP', value: val(series.vwap, i) != null ? `₹${val(series.vwap, i).toFixed(2)}` : 'n/a' },
    { name: 'EMA 20 / 50', value: `${val(series.ema20, i)?.toFixed(2) ?? 'n/a'} / ${val(series.ema50, i)?.toFixed(2) ?? 'n/a'}` },
    { name: 'Volume', value: volume ? `${volume.label} (${volume.ratio}x)` : 'n/a' },
    { name: 'Market structure', value: structure ? `${structure.trend} - ${structure.structure}` : 'n/a' },
  ];
  return { direction, entry: e, stopLoss: stop, risk, riskPct: (risk / e) * 100, atr, buffer, anchor, rationale: notes, factors };
}

/**
 * Targets: T1 = nearest static level between 1.0R and 2.2R in the trade direction
 * (placed just before the level), else 1.5R. T2 = next level between T1 and 4R, else 2.5R.
 */
export function calculateTargets(ctx, i, direction, entry, stop, levels) {
  const long = direction === 'LONG';
  const risk = Math.abs(entry - stop);
  const atr = atrAt(ctx, i);
  const dist = (p) => (long ? p - entry : entry - p) / risk;
  const ahead = levels.all.filter((l) => !l.dynamic && dist(l.price) >= 1.0).sort((a, b) => (long ? a.price - b.price : b.price - a.price));
  const pull = (p) => roundToTick(long ? p - 0.1 * atr : p + 0.1 * atr, long ? 'down' : 'up'); // aim just before the level
  let t1 = null, t1Note = null;
  const l1 = ahead.find((l) => dist(l.price) <= 2.2);
  if (l1) { t1 = pull(l1.price); t1Note = `just before ${l1.label} ₹${l1.price.toFixed(2)}`; }
  else { t1 = roundToTick(long ? entry + 1.5 * risk : entry - 1.5 * risk); t1Note = '1.5 x risk (no level in range)'; }
  let t2 = null, t2Note = null;
  const l2 = ahead.find((l) => (long ? l.price > t1 + 0.5 * risk : l.price < t1 - 0.5 * risk) && dist(l.price) <= 4);
  if (l2) { t2 = pull(l2.price); t2Note = `just before ${l2.label} ₹${l2.price.toFixed(2)}`; }
  else { t2 = roundToTick(long ? entry + 2.5 * risk : entry - 2.5 * risk); t2Note = '2.5 x risk (no further level in range)'; }
  const reward1 = Math.abs(t1 - entry);
  const reward2 = Math.abs(t2 - entry);
  return {
    target1: t1, target2: t2, target1Note: t1Note, target2Note: t2Note,
    reward1, reward2, rr1: risk > 0 ? reward1 / risk : null, rr2: risk > 0 ? reward2 / risk : null,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */
export function buildSnapshot(ctx, i, { light = false } = {}) {
  const { candles, series } = ctx;
  const c = candles[i];
  const levels = detectSupportResistance(ctx, i, { light });
  const structure = detectMarketStructure(ctx, i);
  const volume = calculateVolumeStrength(ctx, i);
  const macd = analyzeMacd(ctx, i);
  const vwap = detectVwapEvents(ctx, i);
  const divergence = detectDivergence(ctx, i);
  const breakout = detectBreakout(ctx, i, levels, divergence);
  const patterns = detectCandlestickPatterns(ctx, i, levels);

  const bw = series.bb.bandwidth;
  let squeeze = false;
  if (bw[i] != null) {
    const hist = bw.slice(Math.max(0, i - 100), i + 1).filter((x) => x != null).sort((a, b) => a - b);
    if (hist.length >= 30) squeeze = bw[i] <= hist[Math.floor(hist.length * 0.2)];
  }
  const bbRange = series.bb.upper[i] != null ? series.bb.upper[i] - series.bb.lower[i] : null;
  const di = ctx.dayOf[i];
  const prevClose = di > 0 ? ctx.days[di - 1].close : null;
  const mins = istMinutes(c.time);

  return {
    index: i,
    time: c.time,
    price: c.close,
    candle: c,
    v: {
      ema9: val(series.ema9, i), ema20: val(series.ema20, i), ema50: val(series.ema50, i), ema200: val(series.ema200, i),
      ema20Prev: val(series.ema20, i - 10), ema50Prev: val(series.ema50, i - 10),
      sma20: val(series.sma20, i), sma50: val(series.sma50, i),
      rsi: val(series.rsi, i), rsiPrev: val(series.rsi, i - 1),
      atr: atrAt(ctx, i), adx: val(series.adx.adx, i), plusDI: val(series.adx.plusDI, i), minusDI: val(series.adx.minusDI, i),
      vwap: val(series.vwap, i), vwapPrev: val(series.vwap, i - 5),
      bbUpper: val(series.bb.upper, i), bbMiddle: val(series.bb.middle, i), bbLower: val(series.bb.lower, i),
      percentB: bbRange > 0 ? (c.close - series.bb.lower[i]) / bbRange : null,
      squeeze,
      prevClose,
      dayOpen: ctx.days[di].open,
      minutesIST: mins,
    },
    levels, structure, volume, macd, vwap, divergence, breakout, patterns,
    patternBias: candleBias(patterns),
    trendStrength: structure.strength,
  };
}

/* ------------------------------------------------------------------ */
/* Presentation helpers                                                */
/* ------------------------------------------------------------------ */
export function describeIndicators(snap) {
  const { v, price, macd, volume, vwap, structure } = snap;
  const rows = [];
  const rsi = v.rsi;
  if (rsi != null) {
    const [state, tone] = rsi >= 70 ? ['OVERBOUGHT', 'warn'] : rsi >= 55 ? ['BULLISH', 'bull'] : rsi >= 45 ? ['NEUTRAL', 'neutral'] : rsi > 30 ? ['BEARISH', 'bear'] : ['OVERSOLD', 'warn'];
    rows.push({ key: 'rsi', label: 'RSI (14)', value: rsi.toFixed(1), state, tone });
  }
  if (macd.available) {
    const detail = [macd.histogramTrend !== 'MIXED' ? `Histogram ${macd.histogramTrend.toLowerCase()}` : null, macd.zeroCross ? `Zero-line cross ${macd.zeroCross.toLowerCase()}` : null].filter(Boolean).join(' · ');
    rows.push({ key: 'macd', label: 'MACD', value: macd.macd.toFixed(3), state: macd.label, tone: macd.bias === 'bullish' ? 'bull' : 'bear', detail: `Signal ${macd.signal.toFixed(3)} · Hist ${macd.histogram.toFixed(3)}${detail ? ' · ' + detail : ''}` });
  }
  if (vwap.available) {
    rows.push({ key: 'vwap', label: 'VWAP', value: `₹${vwap.value.toFixed(2)}`, state: vwap.relation === 'ABOVE' ? 'Price above VWAP' : vwap.relation === 'BELOW' ? 'Price below VWAP' : 'Price at VWAP', tone: vwap.relation === 'ABOVE' ? 'bull' : vwap.relation === 'BELOW' ? 'bear' : 'neutral', detail: vwap.event || `${vwap.distancePct >= 0 ? '+' : ''}${vwap.distancePct.toFixed(2)}% from VWAP` });
  } else {
    rows.push({ key: 'vwap', label: 'VWAP', value: 'n/a', state: 'Session VWAP is only shown on intraday timeframes', tone: 'neutral' });
  }
  if (v.ema9 != null && v.ema20 != null) {
    const bull = v.ema9 > v.ema20;
    const long = v.ema50 != null ? (v.ema20 > v.ema50 ? '20 > 50' : '20 < 50') : null;
    rows.push({ key: 'ema', label: 'EMA 9 / 20', value: `${v.ema9.toFixed(2)} / ${v.ema20.toFixed(2)}`, state: bull ? '9 > 20 BULLISH' : '9 < 20 BEARISH', tone: bull ? 'bull' : 'bear', detail: [long, v.ema200 != null ? (price > v.ema200 ? 'Price > EMA200' : 'Price < EMA200') : 'EMA200 needs 200 candles'].filter(Boolean).join(' · ') });
  }
  if (v.sma20 != null) rows.push({ key: 'sma', label: 'SMA 20 / 50', value: `${v.sma20.toFixed(2)} / ${v.sma50 != null ? v.sma50.toFixed(2) : 'n/a'}`, state: price > v.sma20 ? 'Price above SMA20' : 'Price below SMA20', tone: price > v.sma20 ? 'bull' : 'bear' });
  if (v.bbUpper != null) {
    const pb = v.percentB;
    rows.push({ key: 'bb', label: 'Bollinger (20, 2)', value: `${v.bbLower.toFixed(2)} - ${v.bbUpper.toFixed(2)}`, state: v.squeeze ? 'SQUEEZE (low volatility)' : pb > 1 ? 'Above upper band' : pb < 0 ? 'Below lower band' : pb > 0.8 ? 'Near upper band' : pb < 0.2 ? 'Near lower band' : 'Inside bands', tone: v.squeeze ? 'warn' : 'neutral', detail: `Middle ${v.bbMiddle.toFixed(2)} · %B ${(pb * 100).toFixed(0)}%` });
  }
  rows.push({ key: 'atr', label: 'ATR (14)', value: `₹${v.atr.toFixed(2)}`, state: `${((v.atr / price) * 100).toFixed(2)}% of price`, tone: 'neutral' });
  if (v.adx != null) {
    const a = v.adx;
    const state = a < 15 ? 'NO TREND' : a < 20 ? 'WEAK TREND' : a < 30 ? 'MODERATE TREND' : a < 40 ? 'STRONG TREND' : 'VERY STRONG TREND';
    rows.push({ key: 'adx', label: 'ADX (14)', value: a.toFixed(1), state, tone: a >= 20 ? (v.plusDI > v.minusDI ? 'bull' : 'bear') : 'neutral', detail: `+DI ${v.plusDI.toFixed(1)} · -DI ${v.minusDI.toFixed(1)}` });
  }
  rows.push({ key: 'volume', label: 'Volume', value: volume.label, state: volume.interpretation, tone: volume.ratio >= 1.5 ? 'bull' : volume.ratio < 0.7 ? 'warn' : 'neutral', detail: `${volume.ratio}x average · ${volume.pressureLabel.toLowerCase()}` });
  return rows;
}

/** Events worth alerting on, derived only from real data. Each id is stable per occurrence. */
export function detectEvents(ctx, snap) {
  const { candles, series } = ctx;
  const i = snap.index;
  const ev = [];
  const push = (type, severity, title, message, time, extra = {}) => ev.push({ id: `${type}_${time}${extra.key ? '_' + extra.key : ''}`, type, severity, title, message, time, ...extra });
  const b = snap.breakout;
  if (b.status === 'BREAKOUT' && b.age <= 1) push('BREAKOUT', 'bull', 'Resistance breakout', `₹${b.level.toFixed(2)} breakout · volume ${b.volumeRatio}x average · ${b.confirmed ? 'confirmation: strong' : 'confirmation: not yet strong'}`, b.time, { key: Math.round(b.level) });
  if (b.status === 'BREAKDOWN' && b.age <= 1) push('BREAKDOWN', 'bear', 'Support breakdown', `₹${b.level.toFixed(2)} breakdown · volume ${b.volumeRatio}x average · ${b.confirmed ? 'confirmation: strong' : 'confirmation: not yet strong'}`, b.time, { key: Math.round(b.level) });
  if (/FALSE/.test(b.status) && b.age <= 2) push('FALSE_BREAKOUT', 'warn', b.status.replace(/_/g, ' '), b.message, b.time, { key: Math.round(b.level) });
  if (snap.vwap.event && snap.vwap.time && /RECLAIM|BREAKOUT|BREAKDOWN|REJECTION/.test(snap.vwap.event)) push('VWAP_CROSS', snap.vwap.bias === 'bullish' ? 'bull' : snap.vwap.bias === 'bearish' ? 'bear' : 'warn', snap.vwap.event, `Price ₹${snap.price.toFixed(2)} vs VWAP ₹${snap.vwap.value.toFixed(2)}`, snap.vwap.time);
  if (snap.volume.spike) push('VOLUME_SPIKE', 'warn', 'Volume spike', `Volume ${snap.volume.ratio}x average (${snap.volume.interpretation.toLowerCase()})`, candles[i].time);
  const rsi = snap.v.rsi;
  if (rsi != null) {
    const streak = (test) => { let j = i; while (j > 0 && series.rsi[j - 1] != null && test(series.rsi[j - 1]) && i - j < 60) j--; return j; };
    if (rsi >= 70) push('RSI_OVERBOUGHT', 'warn', 'RSI overbought', `RSI ${rsi.toFixed(1)} ≥ 70 - momentum stretched, avoid chasing`, candles[streak((x) => x >= 70)].time);
    if (rsi <= 30) push('RSI_OVERSOLD', 'warn', 'RSI oversold', `RSI ${rsi.toFixed(1)} ≤ 30 - selling stretched, watch for a reversal`, candles[streak((x) => x <= 30)].time);
  }
  if (snap.macd.crossover && snap.macd.crossAge <= 1) push('MACD_CROSS', snap.macd.crossover === 'BULLISH' ? 'bull' : 'bear', `MACD ${snap.macd.crossover.toLowerCase()} crossover`, 'Use as confirmation only, not as a standalone signal', candles[i - snap.macd.crossAge].time);
  if (snap.divergence.active && snap.divergence.active.age <= 3) push('DIVERGENCE', snap.divergence.active.type === 'BULLISH' ? 'bull' : 'bear', snap.divergence.active.label, snap.divergence.active.detail, snap.divergence.active.to.time);
  return ev;
}
