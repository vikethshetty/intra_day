import { useEffect, useState } from 'react';
import { fetchTrackingData, normalizeError } from '../services/api.js';

function duringNseSession() {
  const ist = new Date(Date.now() + 330 * 60000);
  const day = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30;
}

/** Fetch Upstox candles only while a trade is being tracked during NSE market hours. */
export function useTrackingMarketData(symbol, interval, enabled) {
  const [state, setState] = useState({ data: null, error: null, updatedAt: null });

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    if (!enabled || !duringNseSession()) {
      setState({ data: null, error: null, updatedAt: null });
      return undefined;
    }

    const poll = async () => {
      try {
        const data = await fetchTrackingData(symbol, interval);
        if (cancelled) return;
        setState({ data, error: null, updatedAt: Date.now() });
        timer = setTimeout(poll, document.hidden ? 30000 : 5000);
      } catch (err) {
        if (cancelled) return;
        const error = normalizeError(err);
        setState((old) => ({ ...old, error }));
        const delay = error.code === 'RATE_LIMIT' ? (error.retryAfter || 30) * 1000 : 10000;
        timer = setTimeout(poll, delay);
      }
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [symbol, interval, enabled]);

  return state;
}
