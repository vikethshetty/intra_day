/**
 * Candlestick pattern detection.
 *
 * Important design rule: a candle pattern is NEVER treated as sufficient
 * confirmation on its own. Each pattern carries a "strength" (a transparent
 * heuristic built from the pattern's base reliability + trend context + volume
 * + proximity to a support/resistance level) and the signal engine only gives
 * candles 10 of the 100 points.
 */
import { clamp } from '../utils/indicators.js';

/** ATR at index i, falling back to the mean candle range if ATR is still warming up. */
export function atrAt(ctx, i) {
  const a = ctx.series.atr[i];
  if (a != null && a > 0) return a;
  const from = Math.max(0, i - 13);
  let s = 0;
  for (let j = from; j <= i; j++) s += ctx.candles[j].high - ctx.candles[j].low;
  return s / (i - from + 1) || ctx.candles[i].close * 0.002;
}

const body = (c) => Math.abs(c.close - c.open);
const range = (c) => c.high - c.low;
const upperWick = (c) => c.high - Math.max(c.open, c.close);
const lowerWick = (c) => Math.min(c.open, c.close) - c.low;
const isBull = (c) => c.close > c.open;
const isBear = (c) => c.close < c.open;

/** Direction of the move over the `n` bars *before* bar i (relative to ATR). */
function priorTrend(ctx, i, n = 5) {
  if (i < n) return 'FLAT';
  const move = ctx.candles[i - 1].close - ctx.candles[i - n].close;
  const atr = atrAt(ctx, i);
  if (move < -0.8 * atr) return 'DOWN';
  if (move > 0.8 * atr) return 'UP';
  return 'FLAT';
}

function volRatioAt(ctx, k) {
  const ma = ctx.series.volMA[k];
  return ma > 0 ? ctx.candles[k].volume / ma : null;
}

const BASE = {
  'Bullish Engulfing': 62, 'Bearish Engulfing': 62, Hammer: 56, 'Inverted Hammer': 48, 'Shooting Star': 56,
  Doji: 38, 'Morning Star': 70, 'Evening Star': 70, 'Three White Soldiers': 72, 'Three Black Crows': 72,
  'Inside Bar': 38, 'Outside Bar': 45, 'Strong Bullish Candle': 55, 'Strong Bearish Candle': 55,
};

/** Raw pattern detection for the bar at index k (no strength adjustment yet). */
function rawPatternsAt(ctx, k) {
  const { candles } = ctx;
  if (k < 1) return [];
  const c = candles[k];
  const p = candles[k - 1];
  const atr = atrAt(ctx, k);
  const r = range(c);
  const out = [];
  const add = (name, bias, meaning) => out.push({ name, bias, meaning });
  if (r < 0.25 * atr && !(c.high < p.high && c.low > p.low)) return out; // micro-candle noise

  const trend = priorTrend(ctx, k);

  // Engulfing: current real body fully covers the previous real body, opposite colour.
  if (isBear(p) && isBull(c) && c.close >= p.open && c.open <= p.close && body(c) > body(p))
    add('Bullish Engulfing', 'bullish', 'Potential bullish reversal');
  if (isBull(p) && isBear(c) && c.open >= p.close && c.close <= p.open && body(c) > body(p))
    add('Bearish Engulfing', 'bearish', 'Potential bearish reversal');

  // Pin-bar family: long wick one side, small body on the other.
  const b = Math.max(body(c), r * 0.02);
  const hammerShape = lowerWick(c) >= 2 * b && upperWick(c) <= Math.max(0.35 * b, 0.1 * r) && body(c) <= 0.4 * r;
  const invShape = upperWick(c) >= 2 * b && lowerWick(c) <= Math.max(0.35 * b, 0.1 * r) && body(c) <= 0.4 * r;
  if (hammerShape && trend !== 'UP') add('Hammer', 'bullish', 'Sellers pushed lower but buyers rejected it - possible bullish reversal');
  if (invShape && trend === 'DOWN') add('Inverted Hammer', 'bullish', 'Possible bullish reversal - needs a bullish follow-through candle');
  if (invShape && trend === 'UP') add('Shooting Star', 'bearish', 'Buyers rejected at the highs - possible bearish reversal');

  if (body(c) <= 0.1 * r && r >= 0.4 * atr) add('Doji', 'neutral', 'Indecision - wait for direction');

  // Three-candle patterns
  if (k >= 2) {
    const a = candles[k - 2];
    const m = candles[k - 1];
    const aBody = body(a);
    const bigA = aBody >= 0.5 * range(a) && aBody >= 0.7 * atr;
    if (bigA && isBear(a) && body(m) <= 0.35 * aBody && Math.max(m.open, m.close) <= a.close + 0.2 * aBody && isBull(c) && c.close > (a.open + a.close) / 2)
      add('Morning Star', 'bullish', 'Three-candle bullish reversal');
    if (bigA && isBull(a) && body(m) <= 0.35 * aBody && Math.min(m.open, m.close) >= a.close - 0.2 * aBody && isBear(c) && c.close < (a.open + a.close) / 2)
      add('Evening Star', 'bearish', 'Three-candle bearish reversal');
    const strong = (x) => body(x) >= 0.55 * range(x) && body(x) >= 0.4 * atr;
    if (isBull(a) && isBull(m) && isBull(c) && strong(a) && strong(m) && strong(c) && m.close > a.close && c.close > m.close
      && m.open >= a.open && m.open <= a.close && c.open >= m.open && c.open <= m.close)
      add('Three White Soldiers', 'bullish', 'Sustained buying across three candles');
    if (isBear(a) && isBear(m) && isBear(c) && strong(a) && strong(m) && strong(c) && m.close < a.close && c.close < m.close
      && m.open <= a.open && m.open >= a.close && c.open <= m.open && c.open >= m.close)
      add('Three Black Crows', 'bearish', 'Sustained selling across three candles');
  }

  // Range relationships
  if (c.high < p.high && c.low > p.low) add('Inside Bar', 'neutral', "Compression inside the previous candle - a break of its range decides direction");
  if (c.high > p.high && c.low < p.low && r >= 0.8 * atr)
    add('Outside Bar', isBull(c) ? 'bullish' : isBear(c) ? 'bearish' : 'neutral', isBull(c) ? 'Range expansion with bulls in control' : 'Range expansion with bears in control');

  // Marubozu-like momentum candles
  if (isBull(c) && body(c) >= 0.65 * r && body(c) >= atr) add('Strong Bullish Candle', 'bullish', 'Strong buying pressure');
  if (isBear(c) && body(c) >= 0.65 * r && body(c) >= atr) add('Strong Bearish Candle', 'bearish', 'Strong selling pressure');
  return out;
}

/**
 * Detect patterns on the latest bar (age 0) and the one before it (age 1),
 * with a 0-100 strength each.
 * strength = base reliability
 *          + 8  if the pattern appears at the end of a move it would reverse
 *          + 8  if volume >= 1.5x average, - 8 if volume < 0.7x average
 *          + 8  if it forms within 0.5 ATR of a static support/resistance level
 */
export function detectCandlestickPatterns(ctx, i, levels = null) {
  const found = [];
  for (let age = 0; age <= 1; age++) {
    const k = i - age;
    if (k < 1) continue;
    const trend = priorTrend(ctx, k);
    const vr = volRatioAt(ctx, k);
    const atr = atrAt(ctx, k);
    const c = ctx.candles[k];
    for (const pat of rawPatternsAt(ctx, k)) {
      let s = BASE[pat.name] ?? 40;
      const ctxNotes = [];
      const reversalBull = pat.bias === 'bullish' && /Hammer|Engulfing|Morning/.test(pat.name);
      const reversalBear = pat.bias === 'bearish' && /Shooting|Engulfing|Evening/.test(pat.name);
      if ((reversalBull && trend === 'DOWN') || (reversalBear && trend === 'UP')) { s += 8; ctxNotes.push('Forms after a move it would reverse'); }
      if (vr != null && vr >= 1.5) { s += 8; ctxNotes.push(`Volume ${vr.toFixed(1)}x average`); }
      else if (vr != null && vr < 0.7) { s -= 8; ctxNotes.push('Below-average volume'); }
      if (levels?.all) {
        const near = levels.all.find((l) => !l.dynamic && Math.abs((pat.bias === 'bearish' ? c.high : c.low) - l.price) <= 0.5 * atr);
        if (near && pat.bias !== 'neutral') { s += 8; ctxNotes.push(`Near ${near.labels?.[0] || 'key level'}`); }
      }
      found.push({
        name: pat.name,
        bias: pat.bias,
        strength: Math.round(clamp(s, 20, 95)),
        meaning: pat.meaning,
        age,
        barIndex: k,
        time: c.time,
        volumeRatio: vr != null ? Number(vr.toFixed(2)) : null,
        context: ctxNotes,
        needsConfirmation: true,
      });
    }
  }
  return found;
}

/** Net candle bias in [-1, 1] from detected patterns (latest bar weighs more). */
export function candleBias(patterns) {
  let net = 0;
  for (const p of patterns) {
    if (p.bias === 'neutral') continue;
    const w = p.age === 0 ? 1 : 0.6;
    net += (p.bias === 'bullish' ? 1 : -1) * (p.strength / 100) * w;
  }
  return clamp(net, -1, 1);
}
