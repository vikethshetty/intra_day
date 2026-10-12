import { useCallback, useEffect, useMemo, useState } from 'react';

const istDate = () => new Date(Date.now() + 19800 * 1000).toISOString().slice(0, 10);
const KEY = (s) => `lia.track.${s}`;
const load = (s) => {
  try { const t = JSON.parse(localStorage.getItem(KEY(s)) || 'null'); return t && t.date === istDate() ? t : null; } catch { return null; }
};

/**
 * Walks the candles that printed after you started tracking and decides where the trade stands.
 * Stop is checked before targets inside one candle (conservative). After Target 1 the suggested
 * stop trails to the entry price (breakeven).
 */
export function evaluateTrade(t, candles, price) {
  if (!t) return null;
  const long = t.direction === 'LONG';
  const after = candles.filter((c) => c.time > t.startedAt);
  const bars = price != null ? [...after, { time: Infinity, high: price, low: price }] : after;
  let entered = t.entered0, enteredAt = t.entered0 ? t.startedAt : null;
  let t1 = false, t1At = null, status = entered ? 'IN_TRADE' : 'WAITING', exit = null;
  for (const c of bars) {
    if (!entered) {
      if (long ? c.high >= t.entry : c.low <= t.entry) { entered = true; enteredAt = c.time; status = 'IN_TRADE'; } else continue;
    }
    const stop = t1 ? t.entry : t.stopLoss;
    const stopHit = long ? c.low <= stop : c.high >= stop;
    const t2Hit = long ? c.high >= t.target2 : c.low <= t.target2;
    const t1Hit = long ? c.high >= t.target1 : c.low <= t.target1;
    if (stopHit) { status = t1 ? 'BREAKEVEN' : 'STOPPED'; exit = { price: stop, time: c.time }; break; }
    if (t2Hit) { status = 'T2'; exit = { price: t.target2, time: c.time }; break; }
    if (t1Hit && !t1) { t1 = true; t1At = c.time; status = 'T1'; }
  }
  const ref = exit ? exit.price : price;
  const pnl = entered && ref != null ? (long ? ref - t.entry : t.entry - ref) : null;
  return { ...t, status, entered, enteredAt, t1, t1At, exit, pnl, pnlPct: pnl != null ? (pnl / t.entry) * 100 : null, done: !!exit };
}

export function useTrackedTrade(symbol, candles, price) {
  const [tracked, setTracked] = useState(() => load(symbol));
  useEffect(() => { setTracked(load(symbol)); }, [symbol]);

  const track = useCallback((plan, nowPrice) => {
    const long = plan.direction === 'LONG';
    const conditional = long ? plan.entry > nowPrice * 1.0005 : plan.entry < nowPrice * 0.9995; // entry is a trigger beyond the current price
    const t = { symbol, date: istDate(), direction: plan.direction, entry: plan.entry, stopLoss: plan.stopLoss, target1: plan.target1, target2: plan.target2, startedAt: Math.floor(Date.now() / 1000), entered0: !conditional };
    try { localStorage.setItem(KEY(symbol), JSON.stringify(t)); } catch { /* storage unavailable */ }
    setTracked(t);
  }, [symbol]);
  const clear = useCallback(() => { try { localStorage.removeItem(KEY(symbol)); } catch { /* ignore */ } setTracked(null); }, [symbol]);

  const state = useMemo(() => evaluateTrade(tracked, candles || [], price), [tracked, candles, price]);
  return { tracked, state, track, clear };
}
