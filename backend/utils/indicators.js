/**
 * Pure indicator math. Every function returns an array aligned 1:1 with the
 * input candles; values that cannot be computed yet (warm-up) are `null`.
 * All calculations are causal: value[i] only uses data up to and including i.
 * That property is what lets the backtester and signal timeline reuse them
 * without look-ahead bias.
 */

export const IST_OFFSET = 19800; // IST = UTC+5:30, in seconds
export const TICK = 0.05; // NSE equity tick size

/** Calendar-day key in IST (used to reset VWAP / day high-low each session). */
export const istDayKey = (t) => Math.floor((t + IST_OFFSET) / 86400);
/** Minutes since midnight IST. */
export const istMinutes = (t) => Math.floor(((t + IST_OFFSET) % 86400) / 60);

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** Round a price to the NSE tick. mode: 'nearest' | 'down' | 'up' */
export function roundToTick(price, mode = 'nearest') {
  const q = price / TICK;
  const r = mode === 'down' ? Math.floor(q + 1e-9) : mode === 'up' ? Math.ceil(q - 1e-9) : Math.round(q);
  return Number((r * TICK).toFixed(2));
}

export function calculateSMA(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (standard charting convention). */
export function calculateEMA(values, period) {
  const out = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = start; i < start + period; i++) sum += values[i];
  let prev = sum / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function calculateRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const toRsi = () => (avgG === 0 && avgL === 0 ? 50 : avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  out[period] = toRsi();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

/** MACD = EMA(fast) - EMA(slow); signal = EMA(MACD, signalPeriod); histogram = MACD - signal. */
export function calculateMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macd = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
  const signal = calculateEMA(macd, signalPeriod);
  const histogram = macd.map((m, i) => (m != null && signal[i] != null ? m - signal[i] : null));
  return { macd, signal, histogram };
}

/**
 * Session VWAP: cumulative(typical price * volume) / cumulative(volume),
 * reset at the start of every IST trading day. Not meaningful on daily candles.
 * If a session has no volume at all the value stays null (we never guess).
 */
export function calculateVWAP(candles, interval) {
  const out = new Array(candles.length).fill(null);
  if (interval === '1D') return out;
  let day = null;
  let pv = 0;
  let vv = 0;
  candles.forEach((c, i) => {
    const key = istDayKey(c.time);
    if (key !== day) {
      day = key;
      pv = 0;
      vv = 0;
    }
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vv += c.volume;
    out[i] = vv > 0 ? pv / vv : null;
  });
  return out;
}

/** Wilder's Average True Range. */
export function calculateATR(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's ADX with +DI / -DI.
 *  +DM/-DM: the larger of the up-move / down-move (if positive), else 0
 *  DI = 100 * smoothed DM / smoothed TR;  DX = 100 * |+DI - -DI| / (+DI + -DI)
 *  ADX = Wilder average of DX.  ADX < 20 weak/no trend, 20-25 emerging, > 25 trending.
 */
export function calculateADX(candles, period = 14) {
  const n = candles.length;
  const adx = new Array(n).fill(null);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  if (n < period * 2 + 1) return { adx, plusDI, minusDI };

  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - pc), Math.abs(candles[i].low - pc));
  }
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += pdm[i];
    mS += mdm[i];
  }
  const dx = new Array(n).fill(null);
  const calc = (i) => {
    const p = trS === 0 ? 0 : (100 * pS) / trS;
    const m = trS === 0 ? 0 : (100 * mS) / trS;
    plusDI[i] = p;
    minusDI[i] = m;
    dx[i] = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  };
  calc(period);
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + pdm[i];
    mS = mS - mS / period + mdm[i];
    calc(i);
  }
  let seed = 0;
  for (let i = period; i < period * 2; i++) seed += dx[i];
  adx[period * 2 - 1] = seed / period;
  for (let i = period * 2; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  return { adx, plusDI, minusDI };
}

/** Bollinger Bands: SMA +/- mult * population standard deviation. bandwidth = (upper-lower)/middle. */
export function calculateBollingerBands(closes, period = 20, mult = 2) {
  const n = closes.length;
  const upper = new Array(n).fill(null);
  const middle = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const bandwidth = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    middle[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
    bandwidth[i] = mean > 0 ? (upper[i] - lower[i]) / mean : null;
  }
  return { upper, middle, lower, bandwidth };
}

/**
 * Fractal swing points: a swing high is a bar whose high is the highest within
 * `left` bars before and `right` bars after it (mirror for lows).
 * `confirmedAt` = index + right: a swing is only *known* once `right` further
 * bars have printed, so consumers must filter on confirmedAt <= currentIndex.
 */
export function findSwings(candles, left = 3, right = 3) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (j < i) {
        if (candles[j].high > candles[i].high) isHigh = false;
        if (candles[j].low < candles[i].low) isLow = false;
      } else {
        if (candles[j].high >= candles[i].high) isHigh = false;
        if (candles[j].low <= candles[i].low) isLow = false;
      }
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, time: candles[i].time, price: candles[i].high, confirmedAt: i + right });
    if (isLow) lows.push({ index: i, time: candles[i].time, price: candles[i].low, confirmedAt: i + right });
  }
  return { highs, lows };
}
