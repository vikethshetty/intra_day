import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDailyTop10Batch, fetchNifty50Top10Batch, fetchHealth, normalizeError } from '../services/api.js';
import Nifty50Backtest from './Nifty50Backtest.jsx';

const inr = (value) => Number.isFinite(value)
  ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value)
  : '—';
const signalTone = (signal) => /BUY/.test(signal) ? 'bull' : /SELL/.test(signal) ? 'bear' : 'warn';
const asOf = (seconds) => seconds
  ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(new Date(seconds * 1000))
  : '—';

function istDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const savedScanKey = (providerId, universe) => `daily-top10-${universe}:${providerId}:${istDateKey()}`;
const emptyScan = (providerId, universe) => ({
  date: istDateKey(), universeLabel: universe === 'nifty50' ? 'NIFTY 50 constituents' : 'NSE equity shares', universeCount: 0, offset: 0,
  providerId, processedCount: 0, scannedCount: 0, skippedCount: 0, results: [], complete: false,
});

function loadSavedScan(providerId, universe) {
  try {
    const value = JSON.parse(localStorage.getItem(savedScanKey(providerId, universe)) || 'null');
    return value?.date === istDateKey() ? value : null;
  } catch { return null; }
}

function saveScan(scan, universe) {
  try { localStorage.setItem(savedScanKey(scan.providerId, universe), JSON.stringify(scan)); } catch { /* continue this scan without browser persistence */ }
}

function mergeTop10(previous, batch) {
  const bySymbol = new Map([...previous, ...batch].map((item) => [item.symbol, item]));
  return [...bySymbol.values()]
    .sort((a, b) => b.confidence - a.confidence || b.signalStrength - a.signalStrength || b.confirmations - a.confirmations)
    .slice(0, 10);
}

export default function DailyTop10({ onAnalyze, universe = 'nse' }) {
  const nifty50 = universe === 'nifty50';
  const [data, setData] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('analysis');
  const running = useRef(false);

  const load = useCallback(async (restart = false) => {
    if (running.current) return;
    running.current = true;
    setLoading(true);
    setError(null);

    let providerId;
    try {
      const health = await fetchHealth();
      providerId = health.provider?.id;
    } catch (err) {
      setError(normalizeError(err));
      setLoading(false);
      running.current = false;
      return;
    }
    let current = restart ? emptyScan(providerId, universe) : loadSavedScan(providerId, universe) || emptyScan(providerId, universe);
    if (current.complete && !restart) {
      setData(current);
      setProgress(current);
      setLoading(false);
      running.current = false;
      return;
    }
    setData(null);
    setProgress(current);

    try {
      while (!current.complete) {
        const batch = nifty50 ? await fetchNifty50Top10Batch(current.offset) : await fetchDailyTop10Batch(current.offset);
        current = {
          date: batch.date,
          providerId: batch.providerId,
          provider: batch.provider,
          universeLabel: batch.universeLabel,
          universeCount: batch.universeCount,
          offset: batch.nextOffset,
          processedCount: current.processedCount + batch.processedCount,
          scannedCount: current.scannedCount + batch.scannedCount,
          skippedCount: current.skippedCount + batch.skippedCount,
          results: mergeTop10(current.results, batch.results),
          complete: batch.done,
          generatedAt: batch.generatedAt,
        };
        saveScan(current, universe);
        setProgress(current);
      }
      setData(current);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
      running.current = false;
    }
  }, [nifty50, universe]);

  useEffect(() => {
    load();
  }, [load]);

  const percent = progress?.universeCount
    ? Math.min(100, Math.floor((progress.processedCount / progress.universeCount) * 100))
    : 0;

  return (
    <>
    {!nifty50 && <nav className="nifty-subnav" aria-label="Daily Top 10 sections">
      <button type="button" className={view === 'analysis' ? 'on' : ''} onClick={() => setView('analysis')}>Top 10 analysis</button>
      <button type="button" className={view === 'backtest' ? 'on' : ''} onClick={() => setView('backtest')} disabled={!data?.complete || loading} title={!data?.complete ? 'Complete the Daily Top 10 scan first' : undefined}>Backtesting</button>
    </nav>}
    {!nifty50 && view === 'backtest' ? <Nifty50Backtest universe="dailyTop10" symbols={data?.results?.map((stock) => stock.symbol) || []} /> : (
    <main className="app-shell daily-shell">
      <header className="topbar glass daily-header">
        <div className="brand">
          <span className="brand-mark"><i className="bi bi-trophy-fill" /></span>
          <div><h1>{nifty50 ? 'NIFTY 50 ANALYSIS' : 'DAILY TOP 10'}</h1><p>{nifty50 ? 'Top 10 setup confidence among Nifty 50 shares' : 'Highest confidence across NSE-listed equity shares'}</p></div>
        </div>
        <div className="daily-header-meta">
          {(data || progress?.date) && <span><span className="k">Scan date</span><b>{(data || progress).date}</b></span>}
          {(data || progress?.provider) && <span><span className="k">Market data</span><b>{(data || progress).provider || 'Yahoo Finance'}</b></span>}
          <button type="button" className="btn-soft" onClick={() => load(true)} disabled={loading}>
            <i className={`bi ${loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'}`} /> {loading ? 'Scanning…' : nifty50 ? 'Rescan Nifty 50' : 'Rescan full market'}
          </button>
        </div>
      </header>

      <section className="daily-intro glass">
        <div><b>How this list is ranked</b><p>{nifty50 ? 'Only the current Nifty 50 constituents are scanned.' : 'The current NSE mainboard and SME equity lists are scanned.'} Every share needs at least one month of Yahoo Finance 5-minute history. Confidence includes the one-month daily trend; intraday candle patterns can shape entry confirmation and measured targets.</p></div>
        <div className="daily-caveat"><i className="bi bi-info-circle" /><span>Confidence is a technical score, not the chance of profit. A <b>WAIT</b> signal is not an entry.</span></div>
      </section>

      {loading && <div className="glass loading-card">
        <span className="spinner-border spinner-border-sm" />
        <div>
          <b>{progress?.complete ? 'Finishing scan…' : nifty50 ? 'Scanning Nifty 50 shares…' : 'Scanning the full NSE equity list…'}</b>
          <p>{progress?.processedCount || 0} of {progress?.universeCount || '…'} symbols processed · {percent}%</p>
          <div className="daily-confidence-track"><i style={{ width: `${percent}%` }} /></div>
          <small>You can leave and return later; completed batches are saved in this browser and the scan will resume.</small>
        </div>
      </div>}

      {error && <div className="banner err"><i className="bi bi-exclamation-triangle-fill" /><div className="banner-body"><strong>{nifty50 ? 'Nifty 50 scan paused' : 'Full-market scan paused'}</strong>{error.message}<div className="banner-hint"><button className="btn-soft" type="button" onClick={() => load()} disabled={loading}>Resume scan</button></div></div></div>}

      {data && <>
        <div className="daily-summary">
          <span><b>{data.processedCount}</b> of {data.universeCount} {nifty50 ? 'Nifty 50' : 'NSE'} symbols processed</span>
          <span><b>{data.scannedCount}</b> had enough Yahoo candles to score</span>
          <span>5-minute candles · {new Date(data.generatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST</span>
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
              {stock.historyContext && <p className="daily-warning">One-month trend: {stock.historyContext.trend.toLowerCase()} · {stock.historyContext.candleCount} daily candles{stock.candlePattern ? ` · pattern: ${stock.candlePattern.name}` : ''}</p>}
              {stock.warnings.length > 0 && <p className="daily-warning"><i className="bi bi-exclamation-triangle" /> {stock.warnings.join(' · ')}</p>}
              <div className="daily-stock-bottom"><small>Latest candle {asOf(stock.asOf)} IST · {stock.status}</small><button type="button" className="btn-soft" onClick={() => onAnalyze(stock.symbol)}>Analyze share <i className="bi bi-arrow-right" /></button></div>
            </article>
          ))}
        </div> : <div className="glass empty"><i className="bi bi-bar-chart-line" /><p>No symbols had enough Yahoo Finance 5-minute data to rank.</p></div>}
        {data.skippedCount > 0 && <p className="fine">{data.skippedCount} listed symbols had no usable Yahoo Finance data or enough candles and were excluded from the ranking.</p>}
      </>}

      <footer className="disclaimer daily-disclaimer"><i className="bi bi-shield-exclamation" /><p>{nifty50 ? 'This ranking uses the current NIFTY 50 constituent list.' : 'This ranking uses NSE mainboard and SME shares.'} Symbols without enough historical candles are excluded and counted. Confidence is not a probability of profit or a recommendation; this application does not place trades.</p></footer>
    </main>
    )}
    </>
  );
}
