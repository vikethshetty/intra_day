import { dayTime } from '../services/format.js';

export default function BacktestPanel({ backtest }) {
  if (!backtest) return null;
  return (
    <section className="glass panel h-100">
      <h2 className="panel-title"><i className="bi bi-clock-history" /> Backtest</h2>
      <div className="note warn"><i className="bi bi-info-circle-fill" /> {backtest.label}</div>
      {!backtest.sufficient ? <p className="muted">{backtest.message}</p> : (
        <>
          <dl className="bt-grid">
            <div><dt>Signals</dt><dd>{backtest.signals}</dd></div>
            <div><dt>Winning trades</dt><dd className="up">{backtest.wins}</dd></div>
            <div><dt>Losing trades</dt><dd className="down">{backtest.losses}</dd></div>
            <div><dt>Win rate</dt><dd>{backtest.winRate != null ? `${backtest.winRate.toFixed(1)}%` : '—'}</dd></div>
            <div><dt>Avg reward/risk (planned)</dt><dd>{backtest.avgRewardRisk != null ? backtest.avgRewardRisk.toFixed(2) : '—'}</dd></div>
            <div><dt>Avg result per trade</dt><dd className={backtest.avgRealizedR >= 0 ? 'up' : 'down'}>{backtest.avgRealizedR != null ? `${backtest.avgRealizedR.toFixed(2)} R` : '—'}</dd></div>
            <div><dt>Profit factor</dt><dd>{backtest.profitFactor != null ? backtest.profitFactor.toFixed(2) : '—'}</dd></div>
            <div><dt>Maximum drawdown</dt><dd>{backtest.maxDrawdownPct.toFixed(1)}%</dd></div>
          </dl>
          {backtest.message && <div className="note neutral"><i className="bi bi-exclamation-circle" /> {backtest.message}</div>}
          <p className="fine">Tested {backtest.candlesTested} candles, {dayTime(backtest.from)} → {dayTime(backtest.to)}. {backtest.assumptions}</p>
        </>
      )}
    </section>
  );
}
