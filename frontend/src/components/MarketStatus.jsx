import { useEffect, useState } from 'react';
import { clock } from '../services/format.js';

export default function MarketStatus({ status, lastCandleTime, closedNote }) {
  if (!status) return <div className="mstatus"><span className="dot neutral" /><span>Checking market…</span></div>;
  const tone = status.state === 'OPEN' ? 'bull' : status.state === 'PRE_OPEN' ? 'warn' : 'bear';
  return (
    <div className="mstatus" title={status.note || ''}>
      <span className={`dot ${tone} ${status.isOpen && !status.dataStale ? 'pulse' : ''}`} />
      <div>
        <div className="mstatus-label">{status.label}</div>
        <div className="mstatus-sub">
          {status.dataStale ? 'No fresh candles - possible holiday or delay' : status.isOpen ? 'Live candles' : closedNote || `Showing last available candle${lastCandleTime ? ` (${clock(lastCandleTime)})` : ''}`}
        </div>
      </div>
    </div>
  );
}

const CONFIG_CODES = ['PROVIDER_NOT_CONFIGURED', 'MISSING_API_KEY'];

/** Shown whenever live data cannot be loaded. Never replaces real data with invented values. */
export function DataBanner({ error, lastSuccess, nextRetryAt, onRetry, hasData }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!error) return null;
  const secs = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : null;
  const config = CONFIG_CODES.includes(error.code);
  const title = config ? 'Market-data provider needs configuration'
    : error.code === 'INVALID_SYMBOL' ? 'Symbol not found'
    : error.code === 'RATE_LIMIT' ? 'Data provider is rate-limiting requests'
    : error.code === 'NO_DATA' ? 'No candles available'
    : 'LIVE DATA UNAVAILABLE';
  return (
    <div className={`banner ${config ? 'cfg' : 'err'}`} role="alert">
      <i className={`bi ${config ? 'bi-gear-wide-connected' : 'bi-exclamation-octagon-fill'}`} />
      <div className="banner-body">
        <strong>{title}</strong>
        <div>{error.message}</div>
        {config && <div className="banner-hint">Open <code>backend/.env</code>, set <code>MARKET_DATA_PROVIDER</code> (and <code>MARKET_DATA_API_KEY</code> if your provider needs one), then restart the backend. The default <code>yahoo</code> needs no key.</div>}
        <div className="banner-meta">
          {secs != null && <span><i className="bi bi-arrow-repeat" /> Retrying in {secs}s…</span>}
          {lastSuccess ? <span>Last successful update: {clock(lastSuccess)}{hasData ? ' (showing last real data, marked stale)' : ''}</span> : <span>No successful update yet - nothing is shown rather than guessing prices.</span>}
        </div>
      </div>
      <button type="button" className="btn-soft" onClick={onRetry}>Retry now</button>
    </div>
  );
}
