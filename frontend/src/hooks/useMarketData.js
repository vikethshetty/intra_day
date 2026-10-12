import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAnalysis, normalizeError } from '../services/api.js';

/** Merge the last few candles/points from a "tail" response into the full buffers (no page reload, no refetch of history). */
function mergeTail(buf, res) {
  const tail = res.candles;
  if (!tail?.length) return null;
  const t0 = tail[0].time;
  const lastKnown = buf.candles[buf.candles.length - 1].time;
  if (t0 > lastKnown) return null; // gap (e.g. laptop slept) -> caller reloads everything
  const cut = (arr) => { let k = arr.length; while (k > 0 && arr[k - 1].time >= t0) k--; return arr.slice(0, k); };
  const series = {};
  for (const key of Object.keys(buf.series)) series[key] = [...cut(buf.series[key]), ...(res.series?.[key] || [])];
  return { candles: [...cut(buf.candles), ...tail], series };
}

function pollDelay(res) {
  if (typeof document !== 'undefined' && document.hidden) return 30000;
  if (!res.marketStatus?.isOpen) return 45000;
  return { '1m': 4000, '3m': 4000, '5m': 5000, '15m': 10000, '30m': 10000, '1H': 15000, '1D': 30000 }[res.interval] ?? 8000;
}

/**
 * Loads the full analysis once, then polls cheap "tail" updates.
 * On failure the previous (real) data stays visible but is flagged stale; nothing is invented.
 */
export function useMarketData(symbol, interval) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null, lastSuccess: null, nextRetryAt: null });
  const [feed, setFeed] = useState(null);
  const [token, setToken] = useState(0);
  const bufRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let fails = 0;
    const key = `${symbol}|${interval}`;
    bufRef.current = null;
    setFeed(null);
    setState({ status: 'loading', data: null, error: null, lastSuccess: null, nextRetryAt: null });

    const schedule = (ms) => { timer = setTimeout(() => tick(false), ms); };

    async function tick(forceFull) {
      const buf = bufRef.current;
      const mode = !buf || forceFull ? 'full' : 'tail';
      try {
        const res = await fetchAnalysis(symbol, interval, mode);
        if (cancelled) return;
        let candles, series;
        if (mode === 'full') ({ candles, series } = res);
        else {
          const merged = mergeTail(buf, res);
          if (!merged) return tick(true);
          ({ candles, series } = merged);
        }
        bufRef.current = { candles, series };
        fails = 0;
        setFeed((prev) => ({ key, seq: (prev?.seq || 0) + 1, full: mode === 'full', candles, series }));
        const { candles: _c, series: _s, ...rest } = res;
        setState({ status: 'ok', data: rest, error: null, lastSuccess: Date.now(), nextRetryAt: null });
        schedule(pollDelay(res));
      } catch (err) {
        if (cancelled) return;
        const e = normalizeError(err);
        fails += 1;
        const fatal = ['INVALID_SYMBOL', 'INVALID_INTERVAL', 'BAD_REQUEST'].includes(e.code);
        const config = ['PROVIDER_NOT_CONFIGURED', 'MISSING_API_KEY'].includes(e.code);
        const delay = fatal ? null : config ? 15000 : e.code === 'RATE_LIMIT' ? (e.retryAfter || 30) * 1000 : Math.min(30000, 3000 * 2 ** (fails - 1));
        setState((s) => ({ ...s, status: 'error', error: e, nextRetryAt: delay ? Date.now() + delay : null }));
        if (delay) schedule(delay);
      }
    }

    tick(true);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [symbol, interval, token]);

  const reload = useCallback(() => setToken((t) => t + 1), []);
  return { ...state, feed, reload };
}
