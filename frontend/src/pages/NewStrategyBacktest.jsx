import { useMemo, useRef, useState } from 'react';
import { fetchStrategyBacktestBatch, normalizeError } from '../services/api.js';

const STRATEGIES = [
  ['opening-range-retest', 'A · Opening Range Breakout + Retest'],
  ['trend-pullback', 'B · Trend Pullback Continuation'],
  ['vwap-reclaim', 'C · VWAP Reclaim + Momentum'],
  ['volatility-expansion', 'D · Volatility Expansion Breakout'],
  ['structure-break-retest', 'E · Market Structure Break + Retest'],
];
const todayIndia = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (date, days) => {
  const out = new Date(`${date}T00:00:00Z`);
  out.setUTCDate(out.getUTCDate() + days);
  return out.toISOString().slice(0, 10);
};
const dateLabel = (date) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
}).format(new Date(`${date}T12:00:00+05:30`));
const dateTime = (seconds) => seconds == null ? '—' : new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(seconds * 1000));
const price = (value) => value == null ? '—' : `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function totals(results = []) {
  const all = results.flatMap((item) => (item.trades || []).map((trade) => ({ ...trade, symbol: item.symbol })))
    .sort((a, b) => (a.exitTime ?? Infinity) - (b.exitTime ?? Infinity) || a.symbol.localeCompare(b.symbol));
  const closed = all.filter((trade) => trade.closed);
  const wins = closed.filter((trade) => trade.netR > 0).length;
  let equity = 1, peak = 1, maxDrawdown = 0;
  closed.forEach((trade) => {
    equity *= 1 + 0.01 * trade.netR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  });
  return {
    all, closed,
    wins,
    stops: closed.filter((trade) => trade.why === 'stop').length,
    targets: closed.filter((trade) => trade.why === 'target').length,
    open: all.filter((trade) => !trade.closed).length,
    winRate: closed.length ? 100 * wins / closed.length : null,
    grossR: closed.reduce((sum, trade) => sum + trade.grossR, 0),
    netR: closed.reduce((sum, trade) => sum + trade.netR, 0),
    maxDrawdownPct: 100 * maxDrawdown,
    cost: closed.reduce((sum, trade) => sum + trade.costPerShare, 0),
  };
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv(data, stats, strategyLabel) {
  const headers = ['Strategy', 'Symbol', 'Direction', 'Signal time (IST)', 'Entry time (IST)', 'Confidence %', 'Passed checks', 'Total checks', 'Entry', 'Stop', 'Target (2R)', 'Exit', 'Exit time (IST)', 'Outcome', 'Gross PnL/share', 'Estimated cost/share', 'Net PnL/share', 'Gross R', 'Net R', 'Cost bps each side'];
  const lines = [headers, ...stats.all.map((trade) => [
    strategyLabel, trade.symbol, trade.direction, dateTime(trade.signalTime), dateTime(trade.entryTime), trade.confidence,
    trade.passedChecks, trade.totalChecks, trade.entry, trade.stop, trade.target, trade.exit, dateTime(trade.exitTime), trade.why,
    trade.grossPnlPerShare, trade.costPerShare, trade.netPnlPerShare, trade.grossR, trade.netR, trade.costBpsPerSide,
  ])].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${lines}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `strategy-backtest-${data.strategyId}-${data.startDate}-to-${data.endDate}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function NewStrategyBacktest({ universe = 'nifty50', symbols = [] }) {
  const isDailyTop10 = universe === 'dailyTop10';
  const today = todayIndia();
  const [strategyId, setStrategyId] = useState(STRATEGIES[0][0]);
  const [startDate, setStartDate] = useState(() => addDays(todayIndia(), -7));
  const [endDate, setEndDate] = useState(today);
  const [confidenceMode, setConfidenceMode] = useState('gt');
  const [confidenceLow, setConfidenceLow] = useState(70);
  const [confidenceHigh, setConfidenceHigh] = useState(85);
  const [costBpsPerSide, setCostBpsPerSide] = useState(0);
  const [progress, setProgress] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const running = useRef(false);
  const progressRef = useRef(null);
  const universeCount = isDailyTop10 ? symbols.length : 50;
  const strategyLabel = STRATEGIES.find(([id]) => id === strategyId)?.[1] || strategyId;
  const filterKey = `${strategyId}|${universe}|${[...symbols].sort().join(',')}|${startDate}|${endDate}|${confidenceMode}|${confidenceLow}|${confidenceHigh}|${costBpsPerSide}`;

  const clearPrevious = () => {
    setData(null);
    setProgress(null);
    progressRef.current = null;
    setError(null);
  };

  const run = async (restart = false) => {
    if (running.current || (isDailyTop10 && !symbols.length)) return;
    if (!startDate || !endDate || startDate > endDate) { setError({ message: 'Choose a start date on or before the end date.' }); return; }
    if (![confidenceLow, confidenceHigh].every((value) => String(value).trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100)
      || (confidenceMode === 'between' && Number(confidenceLow) > Number(confidenceHigh))) {
      setError({ message: 'Choose valid whole-number confidence percentages from 0 to 100.' }); return;
    }
    if (!Number.isFinite(Number(costBpsPerSide)) || Number(costBpsPerSide) < 0 || Number(costBpsPerSide) > 1000) {
      setError({ message: 'Estimated cost must be between 0 and 1000 basis points per side.' }); return;
    }

    running.current = true;
    setLoading(true);
    setError(null);
    const symbolKey = [...symbols].sort().join(',');
    const filters = { strategyId, universe, symbols: symbols.join(','), startDate, endDate, confidenceMode, confidenceLow, confidenceHigh, costBpsPerSide };
    let current = restart || !progressRef.current || progressRef.current.filterKey !== filterKey || progressRef.current.symbolKey !== symbolKey
      ? { filterKey, symbolKey, filters, offset: 0, results: [], universeCount }
      : progressRef.current;
    setData(null);
    setProgress(current);
    progressRef.current = current;
    try {
      while (current.offset < current.universeCount) {
        const batch = await fetchStrategyBacktestBatch({ ...current.filters, offset: current.offset });
        const bySymbol = new Map([...current.results, ...batch.results].map((item) => [item.symbol, item]));
        current = {
          ...current,
          offset: batch.nextOffset,
          universeCount: batch.universeCount,
          strategy: batch.strategy,
          provider: batch.provider,
          interval: batch.interval,
          confidence: batch.confidence,
          costBpsPerSide: batch.costBpsPerSide,
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

  const stats = useMemo(() => totals(data?.results || []), [data]);
  const canRun = !isDailyTop10 || symbols.length > 0;
  const changeStart = (value) => { setStartDate(value); if (value > endDate) setEndDate(value); clearPrevious(); };
  const changeEnd = (value) => { setEndDate(value); if (value < startDate) setStartDate(value); clearPrevious(); };
  const confidenceText = confidenceMode === 'between' ? `${confidenceLow}%–${confidenceHigh}%`
    : confidenceMode === 'lt' ? `< ${confidenceLow}%`
      : confidenceMode === 'exact' ? `= ${confidenceLow}%` : `> ${confidenceLow}%`;

  return (
    <main className="app-shell daily-shell">
      <header className="topbar glass daily-header">
        <div className="brand"><span className="brand-mark"><i className="bi bi-bezier2" /></span><div><h1>NEW STRATEGY BACKTEST</h1><p>Five independent deterministic strategy hypotheses</p></div></div>
        <button type="button" className="btn-soft" onClick={() => run(true)} disabled={loading || !canRun}>
          <i className={`bi ${loading ? 'bi-arrow-repeat spin' : 'bi-play-fill'}`} /> {loading ? 'Running…' : 'Run backtest'}
        </button>
      </header>

      <section className="daily-intro glass backtest-controls strategy-controls">
        <label className="strategy-picker">Select strategy<select value={strategyId} onChange={(event) => { setStrategyId(event.target.value); clearPrevious(); }} disabled={loading}>{STRATEGIES.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
        <div className="backtest-date-controls">
          <label>Start date<input type="date" value={startDate} min={addDays(today, -55)} max={endDate || today} onChange={(event) => changeStart(event.target.value)} disabled={loading} /></label>
          <label>End date<input type="date" value={endDate} min={startDate || addDays(today, -55)} max={today} onChange={(event) => changeEnd(event.target.value)} disabled={loading} /></label>
        </div>
        <div className="backtest-confidence-controls">
          <label>Confidence filter<select value={confidenceMode} onChange={(event) => { setConfidenceMode(event.target.value); clearPrevious(); }} disabled={loading}>
            <option value="gt">Greater than</option><option value="lt">Less than</option><option value="between">Between</option><option value="exact">Exactly</option>
          </select></label>
          {confidenceMode === 'between' ? <div className="backtest-range-inputs"><label>From (%)<input type="number" min="0" max="100" step="1" value={confidenceLow} onChange={(event) => { setConfidenceLow(event.target.value); clearPrevious(); }} disabled={loading} /></label><span>to</span><label>To (%)<input type="number" min="0" max="100" step="1" value={confidenceHigh} onChange={(event) => { setConfidenceHigh(event.target.value); clearPrevious(); }} disabled={loading} /></label></div>
            : <label>Threshold (%)<input type="number" min="0" max="100" step="1" value={confidenceLow} onChange={(event) => { setConfidenceLow(event.target.value); clearPrevious(); }} disabled={loading} /></label>}
        </div>
        <label className="strategy-cost">Estimated transaction cost (bps per side)<input type="number" min="0" max="1000" step="0.1" value={costBpsPerSide} onChange={(event) => { setCostBpsPerSide(event.target.value); clearPrevious(); }} disabled={loading} /><small>Enter your estimated fees and slippage per order side. Default is 0 bps.</small></label>
        <p className="backtest-control-hint">Historical analysis uses Yahoo Finance only: completed 15-minute entry candles and completed hourly trend. Yahoo limits intraday history to about 60 days, so the selected start date must be within the latest 55 days; hourly candles are also loaded to initialize the trend filter.</p>
      </section>

      <section className="daily-summary glass backtest-meta">
        <span>Strategy <b>{strategyLabel}</b></span>
        <span>Confidence rule <b>{confidenceText}</b></span>
        <span>Dates <b>{dateLabel(startDate)} – {dateLabel(endDate)}</b></span>
        <span>Universe <b>{isDailyTop10 ? `Current Daily Top 10 · ${universeCount}` : 'Nifty 50 · 50'}</b></span>
      </section>

      {isDailyTop10 && !symbols.length && <div className="glass empty"><i className="bi bi-bar-chart-line" /><p>Run the Daily Top 10 scan first. This backtest uses those ranked shares.</p></div>}
      {loading && <div className="glass loading-card"><span className="spinner-border spinner-border-sm" /><div><b>Running {strategyLabel} on {isDailyTop10 ? 'Daily Top 10' : 'Nifty 50'}…</b><p>{progress?.offset || 0} of {progress?.universeCount || universeCount} shares processed</p><div className="daily-confidence-track"><i style={{ width: `${Math.min(100, Math.floor(((progress?.offset || 0) / (progress?.universeCount || universeCount || 1)) * 100))}%` }} /></div></div></div>}
      {error && <div className="banner err"><i className="bi bi-exclamation-triangle-fill" /><div className="banner-body"><strong>Strategy backtest paused</strong>{error.message}<div className="banner-hint"><button type="button" className="btn-soft" onClick={() => run(false)} disabled={loading}>Resume backtest</button></div></div></div>}

      {data && <>
        <section className="daily-summary glass strategy-results-meta">
          <span>Historical feed <b>{data.provider} · 15m + 1H</b></span><span>Completed date range <b>{dateLabel(data.startDate || startDate)} – {dateLabel(data.endDate || endDate)}</b></span>
          <span>Costs <b>{data.costBpsPerSide} bps per side</b></span>
          <button type="button" className="btn-soft" onClick={() => exportCsv(data, stats, strategyLabel)} disabled={!stats.all.length}><i className="bi bi-file-earmark-spreadsheet" /> Export Excel CSV</button>
        </section>
        <div className="daily-summary backtest-results">
          <article className="glass"><small>Qualified signals</small><b>{data.results.reduce((sum, item) => sum + (item.signalsCount || 0), 0)}</b></article>
          <article className="glass"><small>Closed trades</small><b>{stats.closed.length}</b></article>
          <article className="glass"><small>Target exits</small><b className="up">{stats.targets}</b></article>
          <article className="glass"><small>Stop exits</small><b className="down">{stats.stops}</b></article>
          <article className="glass"><small>Win rate</small><b>{stats.winRate == null ? '—' : `${stats.winRate.toFixed(1)}%`}</b></article>
          <article className="glass"><small>Gross realized result</small><b>{stats.closed.length ? `${stats.grossR.toFixed(2)}R` : '—'}</b></article>
          <article className="glass"><small>Net realized result</small><b className={stats.netR >= 0 ? 'up' : 'down'}>{stats.closed.length ? `${stats.netR.toFixed(2)}R` : '—'}</b></article>
          <article className="glass"><small>1% risk-per-trade drawdown estimate</small><b>{stats.closed.length ? `${stats.maxDrawdownPct.toFixed(2)}%` : '—'}</b></article>
          <article className="glass"><small>Open at selected-data end</small><b>{stats.open}</b></article>
        </div>
        {data.skippedCount > 0 && <p className="fine">{data.skippedCount} shares had insufficient historical candles and were excluded.</p>}
        {stats.all.length ? <section className="glass backtest-trade-list">
          <h2 className="panel-title"><i className="bi bi-list-check" /> Trade results</h2>
          <div className="table-responsive"><table className="table align-middle mb-0"><thead><tr><th>Share</th><th>Signal time</th><th>Side</th><th>Confidence</th><th>Checks</th><th>Entry</th><th>Stop</th><th>Target</th><th>Exit</th><th>Outcome</th><th>Gross R</th><th>Net R</th></tr></thead>
            <tbody>{stats.all.map((trade, index) => <tr key={`${trade.symbol}-${trade.entryTime}-${index}`}>
              <td><b>{trade.symbol}</b></td><td>{dateTime(trade.signalTime)}</td><td>{trade.direction}</td><td>{trade.confidence}%</td>
              <td>{trade.passedChecks}/{trade.totalChecks}</td><td>{price(trade.entry)}</td><td>{price(trade.stop)}</td><td>{price(trade.target)}</td>
              <td>{price(trade.exit)}</td><td>{trade.why}</td><td>{trade.grossR == null ? '—' : trade.grossR.toFixed(2)}</td>
              <td className={trade.netR == null ? '' : trade.netR >= 0 ? 'up' : 'down'}>{trade.netR == null ? '—' : trade.netR.toFixed(2)}</td>
            </tr>)}</tbody></table></div>
        </section> : <div className="glass empty"><i className="bi bi-bar-chart-line" /><p>No signals met the selected strategy and confidence rule in this date range.</p></div>}
      </>}

      <footer className="disclaimer daily-disclaimer"><i className="bi bi-shield-exclamation" /><p>These are deterministic test hypotheses, not proven profitable strategies. Confidence is the share of checklist rules passed; it is not a calibrated win probability. Signals use only completed 15-minute bars, a completed-hour trend filter, next-bar-open entries, 2R targets, ATR-buffered stops, and conservative stop-first handling if both stop and target are touched in one candle. Exits are forced by 15:15 IST. Cost estimates are user-entered; zero is assumed until changed. The result is a backtest, not a live order.</p></footer>
    </main>
  );
}
