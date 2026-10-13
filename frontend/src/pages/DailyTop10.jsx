import { useCallback, useEffect, useState } from 'react';
import { fetchDailyTop10, normalizeError } from '../services/api.js';

const inr = (value) => Number.isFinite(value)
  ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value)
  : '—';
const signalTone = (signal) => /BUY/.test(signal) ? 'bull' : /SELL/.test(signal) ? 'bear' : 'warn';
const asOf = (seconds) => seconds
  ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(new Date(seconds * 1000))
  : '—';

export default function DailyTop10({ onAnalyze }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await fetchDailyTop10();
      setData(result);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(true), 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <main className="app-shell daily-shell">
      <header className="topbar glass daily-header">
        <div className="brand">
          <span className="brand-mark"><i className="bi bi-trophy-fill" /></span>
          <div><h1>DAILY TOP 10</h1><p>Highest technical setup confidence in the scan list</p></div>
        </div>
        <div className="daily-header-meta">
          {data && <span><span className="k">Scan date</span><b>{data.date}</b></span>}
          {data && <span><span className="k">Market data</span><b>{data.provider}</b></span>}
          <button type="button" className="btn-soft" onClick={() => load()} disabled={loading}>
            <i className={`bi ${loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'}`} /> {loading ? 'Scanning…' : 'Refresh scan'}
          </button>
        </div>
      </header>

      <section className="daily-intro glass">
        <div><b>How this list is ranked</b><p>Each share is scored using the app’s existing 5-minute indicators, signal checks, market structure, and setup-confidence formula.</p></div>
        <div className="daily-caveat"><i className="bi bi-info-circle" /><span>Confidence is a technical score, not the chance of profit. A <b>WAIT</b> signal is not an entry.</span></div>
      </section>

      {error && <div className="banner err"><i className="bi bi-exclamation-triangle-fill" /><div className="banner-body"><strong>Could not load today’s scan</strong>{error.message}<div className="banner-hint"><button className="btn-soft" type="button" onClick={() => load()} disabled={loading}>Try again</button></div></div></div>}

      {loading && !data && <div className="glass loading-card"><span className="spinner-border spinner-border-sm" /> Scanning the NSE watchlist and calculating setup confidence…</div>}

      {data && <>
        <div className="daily-summary">
          <span><b>{data.scannedCount}</b> of {data.universeCount} shares scanned</span>
          <span>5-minute candles</span>
          <span>{data.cached ? 'Showing cached scan' : 'Updated'} · {new Date(data.generatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST</span>
        </div>
        {data.results.length ? <div className="daily-list">
          {data.results.map((stock, index) => (
            <article className="daily-stock glass" key={stock.symbol}>
              <div className="daily-stock-top">
                <span className="daily-rank">{String(index + 1).padStart(2, '0')}</span>
                <div className="daily-stock-name"><h2>{stock.symbol}</h2><p>{stock.name} · {stock.exchange}</p></div>
                <span className={`pill big ${signalTone(stock.signal)}`}>{stock.signal}</span>
              </div>
              <div className="daily-confidence">
                <div className="daily-confidence-label"><span>Setup confidence</span><b>{stock.confidence}%</b></div>
                <div className="daily-confidence-track"><i style={{ width: `${stock.confidence}%` }} /></div>
              </div>
              <div className="daily-stock-stats">
                <span><small>Price</small><b>{inr(stock.price)}</b></span>
                <span><small>Direction</small><b>{stock.direction === 'LONG' ? 'Bullish' : 'Bearish'}</b></span>
                <span><small>Confirmations</small><b>{stock.confirmations}/7</b></span>
                <span><small>Signal strength</small><b>{stock.signalStrength}/100</b></span>
              </div>
              <div className="daily-plan">
                <span>Entry <b>{inr(stock.entry)}</b></span>
                <span>Stop <b>{inr(stock.stopLoss)}</b></span>
                <span>Target 1 <b>{inr(stock.target1)}</b></span>
                <span>Target 2 <b>{inr(stock.target2)}</b></span>
              </div>
              {stock.warnings.length > 0 && <p className="daily-warning"><i className="bi bi-exclamation-triangle" /> {stock.warnings.join(' · ')}</p>}
              <div className="daily-stock-bottom"><small>Latest candle {asOf(stock.asOf)} IST · {stock.status}</small><button type="button" className="btn-soft" onClick={() => onAnalyze(stock.symbol)}>Analyze share <i className="bi bi-arrow-right" /></button></div>
            </article>
          ))}
        </div> : <div className="glass empty"><i className="bi bi-bar-chart-line" /><p>No shares had enough data to rank. Try again when market data is available.</p></div>}
        {data.skipped.length > 0 && <p className="fine">Skipped {data.skipped.length} shares because data was unavailable or incomplete.</p>}
      </>}

      <footer className="disclaimer daily-disclaimer"><i className="bi bi-shield-exclamation" /><p>{data?.disclaimer} The scan uses a limited NSE watchlist, not every listed share. Market data, indicators, and signals can be delayed or wrong. This application does not place trades.</p></footer>
    </main>
  );
}
