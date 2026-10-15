import { useMemo, useRef, useState } from 'react';
import { fetchDailyTop10BacktestBatch, fetchNifty50BacktestBatch, normalizeError } from '../services/api.js';

const PERIODS = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 21, label: '3 weeks' },
  { days: 30, label: '1 month' },
  { days: 60, label: '2 months' },
];
const price = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const dt = (seconds) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(new Date(seconds * 1000));

function summarize(stockResults) {
  const trades = stockResults.flatMap((stock) => (stock.trades || []).map((trade) => ({ ...trade, symbol: stock.symbol })))
    .sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  const wins = trades.filter((trade) => trade.R > 0).length;
  return {
    calls: trades.length,
    trades,
    targets: trades.filter((trade) => trade.why === 'target').length,
    stops: trades.filter((trade) => trade.why === 'stop').length,
    timed: trades.filter((trade) => trade.why === 'time').length,
    winRate: trades.length ? (wins / trades.length) * 100 : null,
    avgRR: trades.length ? trades.reduce((sum, trade) => sum + trade.rr, 0) / trades.length : null,
    totalR: trades.reduce((sum, trade) => sum + trade.R, 0),
    avgR: trades.length ? trades.reduce((sum, trade) => sum + trade.R, 0) / trades.length : null,
  };
}

export default function Nifty50Backtest({ universe = 'nifty50', symbols = [] }) {
  const isDailyTop10 = universe === 'dailyTop10';
  const label = isDailyTop10 ? 'DAILY TOP 10 BACKTEST' : 'NIFTY 50 BACKTEST';
  const [periodDays, setPeriodDays] = useState(7);
  const [progress, setProgress] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const running = useRef(false);
  const progressRef = useRef(null);
  const universeCount = isDailyTop10 ? symbols.length : 50;

  const run = async (restart = false) => {
    if (running.current || (isDailyTop10 && !symbols.length)) return;
    running.current = true;
    setLoading(true);
    setError(null);
    const symbolKey = [...symbols].sort().join(',');
    let current = restart || !progressRef.current || progressRef.current.periodDays !== periodDays || progressRef.current.symbolKey !== symbolKey
      ? { periodDays, symbolKey, offset: 0, endTime: Math.floor(Date.now() / 1000), results: [], universeCount }
      : progressRef.current;
    setData(null);
    setProgress(current);
    progressRef.current = current;
    try {
      while (current.offset < current.universeCount) {
        const batch = isDailyTop10
          ? await fetchDailyTop10BacktestBatch(symbols, current.offset, periodDays, current.endTime)
          : await fetchNifty50BacktestBatch(current.offset, periodDays, current.endTime);
        const bySymbol = new Map([...current.results, ...batch.results].map((item) => [item.symbol, item]));
        current = {
          ...current,
          offset: batch.nextOffset,
          universeCount: batch.universeCount,
          provider: batch.provider,
          interval: batch.interval,
          minConfidence: batch.minConfidence,
          startTime: batch.startTime,
          skippedCount: [...bySymbol.values()].filter((item) => !item.sufficient).length,
          results: [...bySymbol.values()],
          done: batch.done,
        };
        progressRef.current = current;
        setProgress(current);
      }
      setData(current);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
      running.current = false;
    }
  };

  const result = useMemo(() => summarize(data?.results || []), [data]);
  const selectPeriod = (days) => {
    setPeriodDays(days);
    setData(null);
    setProgress(null);
    progressRef.current = null;
    setError(null);
  };
  const canRun = !isDailyTop10 || symbols.length > 0;
  const description = `Replays historical signals using the same setup-confidence formula, with a 70% minimum confidence and one-month trend context. One-hour candles provide Yahoo history for periods up to two months.`;

  return (
    <main className="app-shell daily-shell">
      <header className="topbar glass daily-header">
        <div className="brand">
          <span className="brand-mark"><i className="bi bi-clock-history" /></span>
          <div><h1>{label}</h1><p>Historical confidence-based trade analysis</p></div>
        </div>
        <button type="button" className="btn-soft" onClick={() => run(true)} disabled={loading || !canRun}>
          <i className={`bi ${loading ? 'bi-arrow-repeat spin' : 'bi-play-fill'}`} /> {loading ? 'Running…' : 'Run backtest'}
        </button>
      </header>

      <section className="daily-intro glass">
        <div><b>Choose a historical period</b><p>{description}</p></div>
        <div className="period-choice" role="group" aria-label="Backtest period">
          {PERIODS.map((period) => <button key={period.days} type="button" className={`btn-soft ${periodDays === period.days ? 'on' : ''}`} onClick={() => selectPeriod(period.days)} disabled={loading}>{period.label}</button>)}
        </div>
      </section>

      <section className="daily-summary glass backtest-meta">
        <span>Confidence filter <b>70%+</b></span>
        <span>Shares <b>{isDailyTop10 ? `Current Daily Top 10 · ${universeCount}` : 'Nifty 50 · 50'}</b></span>
      </section>

      {isDailyTop10 && !symbols.length && <div className="glass empty"><i className="bi bi-bar-chart-line" /><p>Run the Daily Top 10 scan first. Backtesting uses those ten ranked shares.</p></div>}
      {loading && <div className="glass loading-card"><span className="spinner-border spinner-border-sm" /><div><b>Backtesting {isDailyTop10 ? 'Daily Top 10 shares' : 'Nifty 50 shares'}…</b><p>{progress?.offset || 0} of {progress?.universeCount || universeCount} processed</p><div className="daily-confidence-track"><i style={{ width: `${Math.min(100, Math.floor(((progress?.offset || 0) / (progress?.universeCount || universeCount || 1)) * 100))}%` }} /></div></div></div>}
      {error && <div className="banner err"><i className="bi bi-exclamation-triangle-fill" /><div className="banner-body"><strong>Backtest paused</strong>{error.message}<div className="banner-hint"><button type="button" className="btn-soft" onClick={() => run(false)} disabled={loading}>Resume backtest</button></div></div></div>}

      {data && <>
        <section className="daily-summary glass"><span>Period <b>{PERIODS.find((item) => item.days === data.periodDays)?.label}</b></span><span>Data <b>{data.provider} · {data.interval} candles</b></span><span>Dates <b>{dt(data.startTime)} – {dt(data.endTime)}</b></span></section>
        <div className="daily-summary backtest-results">
          <article className="glass"><small>Signals triggered</small><b>{result.calls}</b></article>
          <article className="glass"><small>Target 1 reached</small><b className="up">{result.targets}</b></article>
          <article className="glass"><small>Stop loss reached</small><b className="down">{result.stops}</b></article>
          <article className="glass"><small>Win rate</small><b>{result.winRate == null ? '—' : `${result.winRate.toFixed(1)}%`}</b></article>
          <article className="glass"><small>Average planned R:R</small><b>{result.avgRR == null ? '—' : `1 : ${result.avgRR.toFixed(2)}`}</b></article>
          <article className="glass"><small>Cumulative realized R</small><b className={result.totalR >= 0 ? 'up' : 'down'}>{result.calls ? `${result.totalR.toFixed(2)}R` : '—'}</b></article>
          <article className="glass"><small>Average realized R</small><b>{result.avgR == null ? '—' : `${result.avgR.toFixed(2)}R`}</b></article>
          <article className="glass"><small>Exited at session end</small><b>{result.timed}</b></article>
        </div>

        {result.trades.length ? <section className="glass backtest-trade-list">
          <h2 className="panel-title"><i className="bi bi-list-check" /> Trade results</h2>
          <div className="table-responsive"><table className="table align-middle mb-0"><thead><tr><th>Share</th><th>Entry time</th><th>Side</th><th>Confidence</th><th>Entry</th><th>Exit</th><th>Outcome</th><th>Planned R:R</th><th>Result</th></tr></thead>
            <tbody>{result.trades.map((trade, index) => <tr key={`${trade.symbol}-${trade.time}-${index}`}>
              <td><b>{trade.symbol}</b>{trade.pattern && <small className="d-block text-muted">{trade.pattern}</small>}</td>
              <td>{dt(trade.time)}</td><td>{trade.dir}</td><td>{trade.confidence}%</td>
              <td>{price(trade.entry)}</td><td>{price(trade.exit)}</td>
              <td>{trade.why === 'target' ? 'Target 1' : trade.why === 'stop' ? 'Stop loss' : 'Session close'}</td>
              <td>1 : {trade.rr.toFixed(2)}</td><td className={trade.R >= 0 ? 'up' : 'down'}>{trade.R.toFixed(2)}R</td>
            </tr>)}</tbody></table></div>
        </section> : <div className="glass empty"><i className="bi bi-bar-chart-line" /><p>No trades met the confidence and history requirements during this period.</p></div>}
      </>}

      <footer className="disclaimer daily-disclaimer"><i className="bi bi-shield-exclamation" /><p>Results are shown as trade counts and risk multiples (R), without assuming an account size or capital allocation. Combined results across symbols are not a single-account portfolio simulation. The backtest uses a 70% confidence threshold, one-hour Yahoo candles, stop-first handling if stop and target touch in one candle, and excludes brokerage, taxes and slippage. Nifty 50 membership is today’s list applied retrospectively. Past performance does not predict future results.</p></footer>
    </main>
  );
}
