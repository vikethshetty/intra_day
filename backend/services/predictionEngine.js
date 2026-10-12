/**
 * Transparent, rule-based scenario engine. No machine learning, no randomness.
 *
 * Probability = blend of
 *  (1) EVIDENCE share  - bullish / bearish / sideways evidence scores from the live
 *      indicator state (the same 100-point scores used by the signal engine,
 *      squared so that the dominant side stands out, and a sideways score built
 *      from ADX, Bollinger squeeze, structure and volume), and
 *  (2) HISTORICAL share - how often, in THIS symbol's loaded candles, bars with a
 *      similar bias were followed (HORIZON bars later) by a move of more than
 *      +/-0.5 ATR up, down, or by a flat outcome. Its weight grows with the sample
 *      size n:  w = min(0.45, n / (n + 60)).
 *
 * Output is a statistical tendency over the next HORIZON candles. It is NOT a
 * forecast of a price or a time.
 */
import { clamp } from '../utils/indicators.js';

export const HORIZON = 10;

/** Sideways evidence 0-100 from ADX, squeeze, structure, and thin volume. */
function sidewaysScore(snap) {
  let s = 0;
  const { v, structure, volume } = snap;
  if (v.adx != null) s += v.adx < 20 ? 35 : v.adx < 25 ? 15 : 0;
  if (v.squeeze) s += 25;
  if (structure.trend === 'SIDEWAYS') s += 25;
  if (volume.ratio < 0.8) s += 15;
  return clamp(s, 0, 100);
}

/** Empirical outcome frequencies for bars whose bias bucket matches the current one. */
function historicalStats(ctx, timeline, bucketNow) {
  const { candles } = ctx;
  const n = candles.length;
  let up = 0, down = 0, flat = 0;
  for (let j = 30; j < n - 1 - HORIZON; j++) {
    const e = timeline[j];
    const diff = e.longTotal - e.shortTotal;
    const bucket = diff >= 15 ? 'BULL' : diff <= -15 ? 'BEAR' : 'NEUTRAL';
    if (bucket !== bucketNow) continue;
    const atr = ctx.series.atr[j];
    if (!atr) continue;
    const move = (candles[j + HORIZON].close - candles[j].close) / atr;
    if (move > 0.5) up++;
    else if (move < -0.5) down++;
    else flat++;
  }
  const total = up + down + flat;
  return { up, down, flat, n: total };
}

export function generateScenarioAnalysis(ctx, snap, scoring, timeline) {
  const { price, levels, v, volume, structure } = snap;
  const atr = v.atr;
  const fmt = (x) => `₹${x.toFixed(2)}`;

  const L = scoring.long.total;
  const S = scoring.short.total;
  const side = sidewaysScore(snap);
  const evidence = { bull: (L / 100) ** 2, bear: (S / 100) ** 2, side: (side / 100) ** 2 * 0.9 };
  const eSum = evidence.bull + evidence.bear + evidence.side || 1;
  let p = { bull: evidence.bull / eSum, bear: evidence.bear / eSum, side: evidence.side / eSum };

  const diff = L - S;
  const bucket = diff >= 15 ? 'BULL' : diff <= -15 ? 'BEAR' : 'NEUTRAL';
  const hist = historicalStats(ctx, timeline, bucket);
  const w = hist.n >= 20 ? Math.min(0.45, hist.n / (hist.n + 60)) : 0;
  if (w > 0) {
    p = {
      bull: (1 - w) * p.bull + w * (hist.up / hist.n),
      bear: (1 - w) * p.bear + w * (hist.down / hist.n),
      side: (1 - w) * p.side + w * (hist.flat / hist.n),
    };
  }
  // Never express certainty: clamp to 5-85% then renormalise to exactly 100.
  const c = { bull: clamp(p.bull, 0.05, 0.85), bear: clamp(p.bear, 0.05, 0.85), side: clamp(p.side, 0.05, 0.85) };
  const cs = c.bull + c.bear + c.side;
  const pct = { bull: Math.round((c.bull / cs) * 100), bear: Math.round((c.bear / cs) * 100), side: 0 };
  pct.side = 100 - pct.bull - pct.bear;

  const r1 = levels.resistance[0], r2 = levels.resistance[1];
  const s1 = levels.support[0], s2 = levels.support[1];
  const swingLow = structure.lastSwingLow?.price;
  const swingHigh = structure.lastSwingHigh?.price;

  const bullTrigger = r1 ? r1.price : price + atr;
  const bearTrigger = s1 ? s1.price : price - atr;
  const bullInval = s1 ? Math.min(s1.price, swingLow ?? s1.price) : price - 1.5 * atr;
  const bearInval = r1 ? Math.max(r1.price, swingHigh ?? r1.price) : price + 1.5 * atr;
  const bullZone = [bullTrigger, r2 ? r2.price : bullTrigger + 1.5 * atr];
  const bearZone = [s2 ? s2.price : bearTrigger - 1.5 * atr, bearTrigger];

  const yes = (b) => !!b;
  const bullishConfirm = [
    { label: 'Price above VWAP', met: yes(snap.vwap.available ? snap.vwap.relation === 'ABOVE' : v.ema20 != null && price > v.ema20) },
    { label: 'RSI above 50', met: yes(v.rsi != null && v.rsi > 50) },
    { label: 'EMA 9 above EMA 20', met: yes(v.ema9 != null && v.ema20 != null && v.ema9 > v.ema20) },
    { label: 'Volume expansion (≥1.5x average)', met: volume.ratio >= 1.5 },
  ];
  const bearishConfirm = [
    { label: 'Price below VWAP', met: yes(snap.vwap.available ? snap.vwap.relation === 'BELOW' : v.ema20 != null && price < v.ema20) },
    { label: 'RSI below 45', met: yes(v.rsi != null && v.rsi < 45) },
    { label: 'EMA 9 below EMA 20 (bearish crossover)', met: yes(v.ema9 != null && v.ema20 != null && v.ema9 < v.ema20) },
    { label: 'Selling volume increase', met: volume.ratio >= 1.5 && volume.pressure < -0.1 },
  ];
  const lo = s1 ? s1.price : price - atr;
  const hi = r1 ? r1.price : price + atr;
  const dominant = pct.bull >= pct.bear && pct.bull >= pct.side ? 'bullish' : pct.bear >= pct.side ? 'bearish' : 'sideways';

  const stats = hist.n >= 20
    ? `Historical share (${Math.round(w * 100)}% weight): in ${hist.n} similar past bars on this symbol, ${Math.round((hist.up / hist.n) * 100)}% rose, ${Math.round((hist.down / hist.n) * 100)}% fell and ${Math.round((hist.flat / hist.n) * 100)}% stayed flat over the next ${HORIZON} candles (±0.5 ATR).`
    : `Not enough comparable history (${hist.n} similar bars, need 20) - probabilities use live indicator evidence only.`;

  return {
    horizonBars: HORIZON,
    dominant,
    scenarios: {
      bullish: {
        key: 'bullish', title: 'Bullish scenario', probability: pct.bull,
        evidenceScore: L,
        trigger: `Break above ${fmt(bullTrigger)} with at least 1.5x average volume (now ${volume.ratio}x)`,
        invalidation: `Falls below ${fmt(bullInval)}`,
        expectedZone: { low: bullZone[0], high: bullZone[1], text: `${fmt(bullZone[0])} - ${fmt(bullZone[1])}` },
        confirmations: bullishConfirm,
      },
      bearish: {
        key: 'bearish', title: 'Bearish scenario', probability: pct.bear,
        evidenceScore: S,
        trigger: `Break below ${fmt(bearTrigger)} with at least 1.5x average volume (now ${volume.ratio}x)`,
        invalidation: `Rises above ${fmt(bearInval)}`,
        expectedZone: { low: bearZone[0], high: bearZone[1], text: `${fmt(bearZone[0])} - ${fmt(bearZone[1])}` },
        confirmations: bearishConfirm,
      },
      sideways: {
        key: 'sideways', title: 'Sideways scenario', probability: pct.side,
        evidenceScore: side,
        trigger: `Price keeps rotating between ${fmt(lo)} and ${fmt(hi)} without a volume-backed break`,
        invalidation: `A close beyond ${fmt(lo)} or ${fmt(hi)} on above-average volume`,
        expectedZone: { low: lo, high: hi, text: `${fmt(lo)} - ${fmt(hi)}` },
        confirmations: [
          { label: 'ADX below 20 (no trend)', met: yes(v.adx != null && v.adx < 20) },
          { label: 'Bollinger squeeze', met: !!v.squeeze },
          { label: 'Volume below average', met: volume.ratio < 1 },
        ],
      },
    },
    method: [
      `Evidence: bullish ${L}/100, bearish ${S}/100, sideways ${side}/100 (squared and normalised).`,
      stats,
      'Probabilities are clamped to 5-85% so no scenario is ever presented as certain.',
    ],
    historical: { ...hist, weight: Number(w.toFixed(2)), bucket },
    disclaimer: `Statistical tendency over the next ~${HORIZON} candles based on technical conditions. Not a price target, not a timed forecast, not financial advice.`,
  };
}
