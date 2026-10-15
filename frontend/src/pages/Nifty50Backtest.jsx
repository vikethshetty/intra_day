import { useMemo, useRef, useState } from 'react';
import { fetchDailyTop10BacktestBatch, fetchNifty50BacktestBatch, normalizeError } from '../services/api.js';

const todayInIndia = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const shiftDate = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const dateLabel = (date) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
}).format(new Date(`${date}T12:00:00+05:30`));
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

function confidenceBounds(mode, value, lower, upper) {
  if (mode === 'lte') return { minConfidence: 0, maxConfidence: value };
  if (mode === 'between') return { minConfidence: lower, maxConfidence: upper };
  if (mode === 'exact') return { minConfidence: value, maxConfidence: value };
  return { minConfidence: value, maxConfidence: 100 };
}

export default function Nifty50Backtest({ universe = 'nifty50', symbols = [] }) {
  const isDailyTop10 = universe === 'dailyTop10';
  const label = isDailyTop10 ? 'DAILY TOP 10 BACKTEST' : 'NIFTY 50 BACKTEST';
  const today = todayInIndia();
  const earliestDate = shiftDate(today, -365);
  const [startDate, setStartDate] = useState(() => shiftDate(todayInIndia(), -7));
  const [endDate, setEndDate] = useState(today);
  const [confidenceMode, setConfidenceMode] = useState('gte');
  const [confidenceValue, setConfidenceValue] = useState(70);
  const [confidenceLower, setConfidenceLower] = useState(70);
  const [confidenceUpper, setConfidenceUpper] = useState(85);
  const [progress, setProgress] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const running = useRef(false);
  const progressRef = useRef(null);
  const universeCount = isDailyTop10 ? symbols.length : 50;

  const bounds = confidenceBounds(confidenceMode, Number(confidenceValue), Number(confidenceLower), Number(confidenceUpper));
  const filterKey = `${startDate}|${endDate}|${confidenceMode}|${bounds.minConfidence}|${bounds.maxConfidence}`;
  const filters = { startDate, endDate, ...bounds };

  const clearPrevious = () => {
    setData(null);
    setProgress(null);
    progressRef.current = null;
    setError(null);
  };

  const run = async (restart = false) => {
    if (running.current || (isDailyTop10 && !symbols.length)) return;
    if (!startDate || !endDate || startDate > endDate) {
      setError({ message: 'Choose a start date on or before the end date.' });
      return;
    }
    const activeValues = confidenceMode === 'between' ? [confidenceLower, confidenceUpper] : [confidenceValue];
    if (activeValues.some((value) => String(value).trim() === '' || !Number.isInteger(Number(value))) || bounds.minConfidence < 0 || bounds.maxConfidence > 100 || bounds.minConfidence > bounds.maxConfidence) {
      setError({ message: 'Choose confidence values from 0 to 100, with the lower value no greater than the upper value.' });
      return;
    }

    running.current = true;
    setLoading(true);
    setError(null);
    const symbolKey = [...symbols].sort().join(',');
    let current = restart || !progressRef.current || progressRef.current.filterKey !== filterKey || progressRef.current.symbolKey !== symbolKey
      ? { filterKey, filters, symbolKey, offset: 0, results: [], universeCount }
      : progressRef.current;
    setData(null);
    setProgress(current);
    progressRef.current = current;
    try {
      while (current.offset < current.universeCount) {
        const batch = isDailyTop10
          ? await fetchDailyTop10BacktestBatch(symbols, current.offset, current.filters)
          : await fetchNifty50BacktestBatch(current.offset, current.filters);
        const bySymbol = new Map([...current.results, ...batch.results].map((item) => [item.symbol, item]));
        current = {
          ...current,
          offset: batch.nextOffset,
          universeCount: batch.universeCount,
          provider: batch.provider,
          interval: batch.interval,
          minConfidence: batch.minConfidence,
          maxConfidence: batch.maxConfidence,
          startDate: batch.startDate,
          endDate: batch.endDate,
          startTime: batch.startTime,
          endTime: batch.endTime,
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
  const canRun = !isDailyTop10 || symbols.length > 0;
  const description = 'Choose a historical calendar range and confidence rule. The backtest replays Yahoo Finance one-hour candles using the same setup-confidence formula and one-month trend context. Select dates within the latest year.';
  const confidenceDescription = confidenceMode === 'between'
    ? `${bounds.minConfidence}%–${bounds.maxConfidence}%`
    : confidenceMode === 'lte' ? `≤ ${bounds.maxConfidence}%`
      : confidenceMode === 'exact' ? `= ${bounds.minConfidence}%`
        : `≥ ${bounds.minConfidence}%`;

  const changeStart = (value) => {
    setStartDate(value);
    if (value && value > endDate) setEndDate(value);
    clearPrevious();
  };
  const changeEnd = (value) => {
    setEndDate(value);
    if (value && value < startDate) setStartDate(value);
    clearPrevious();
  };

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

      <section className="daily-intro glass backtest-controls">
        <div className="backtest-date-controls">
          <label>Start date<input type="date" value={startDate} min={earliestDate} max={endDate || today} onChange={(event) => changeStart(event.target.value)} disabled={loading} /></label>
          <label>End date<input type="date" value={endDate} min={startDate || earliestDate} max={today} onChange={(event) => changeEnd(event.target.value)} disabled={loading} /></label>
        </div>
        <div className="backtest-confidence-controls">
          <label>Confidence rule
            <select value={confidenceMode} onChange={(event) => { setConfidenceMode(event.target.value); clearPrevious(); }} disabled={loading}>
              <option value="gte">Greater than or equal to</option>
              <option value="lte">Less than or equal to</option>
              <option value="between">Between</option>
              <option value="exact">Exactly</option>
            </select>
          </label>
          {confidenceMode === 'between' ? <div className="backtest-range-inputs">
            <label>From<input type="number" min="0" max="100" step="1" value={confidenceLower} onChange={(event) => { setConfidenceLower(event.target.value); clearPrevious(); }} disabled={loading} /></label>
            <span>to</span>
            <label>To<input type="number" min="0" max="100" step="1" value={confidenceUpper} onChange={(event) => { setConfidenceUpper(event.target.value); clearPrevious(); }} disabled={loading} /></label>
          </div> : <label>Confidence (%)<input type="number" min="0" max="100" step="1" value={confidenceValue} onChange={(event) => { setConfidenceValue(event.target.value); clearPrevious(); }} disabled={loading} /></label>}
        </div>
        <p className="backtest-control-hint">{description}</p>
      </section>

      <section className="daily-summary glass backtest-meta">
        <span>Confidence filter <b>{confidenceDescription}</b></span>
        <span>Date range <b>{startDate && endDate ? `${dateLabel(startDate)} – ${dateLabel(endDate)}` : 'Select dates'}</b></span>
        <span>Shares <b>{isDailyTop10 ? `Current Daily Top 10 · ${universeCount}` : 'Nifty 50 · 50'}</b></span>
      </section>

      {isDailyTop10 && !symbols.length && <div className="glass empty"><i className="bi bi-bar-chart-line" /><p>Run the Daily Top 10 scan first. Backtesting uses those ten ranked shares.</p></div>}
      {loading && <div className="glass loading-card"><span className="spinner-border spinner-border-sm" /><div><b>Backtesting {isDailyTop10 ? 'Daily Top 10 shares' : 'Nifty 50 shares'}…</b><p>{progress?.offset || 0} of {progress?.universeCount || universeCount} processed</p><div className="daily-confidence-track"><i style={{ width: `${Math.min(100, Math.floor(((progress?.offset || 0) / (progress?.universeCount || universeCount || 1)) * 100))}%` }} /></div></div></div>}
      {error && <div className="banner err"><i className="bi bi-exclamation-triangle-fill" /><div className="banner-body"><strong>Backtest paused</strong>{error.message}<div className="banner-hint"><button type="button" className="btn-soft" onClick={() => run(false)} disabled={loading}>Resume backtest</button></div></div></div>}

      {data && <>
        <section className="daily-summary glass"><span>Dates <b>{dateLabel(data.startDate)} – {dateLabel(data.endDate)}</b></span><span>Data <b>{data.provider} · {data.interval} candles</b></span><span>Confidence <b>{data.minConfidence}%–{data.maxConfidence}%</b></span></section>
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
        </section> : <div className="glass empty"><i className="bi bi-bar-chart-line" /><p>No trades matched the selected dates and confidence filter.</p></div>}
      </>}

      <footer className="disclaimer daily-disclaimer"><i className="bi bi-shield-exclamation" /><p>Results are shown as trade counts and risk multiples (R), without assuming an account size or capital allocation. Combined results across symbols are not a single-account portfolio simulation. The backtest uses the selected confidence range, Yahoo Finance one-hour candles requested for up to one year (availability can vary by symbol), stop-first handling if stop and target touch in one candle, and excludes brokerage, taxes and slippage. Nifty 50 membership is today’s list applied retrospectively. Past performance does not predict future results.</p></footer>
    </main>
  );
}
