import { clock, inr } from '../services/format.js';

export default function CandleStructurePanel({ analysis }) {
  if (!analysis) return null;
  const { structure, candlePatterns, breakout, divergence, vwap, macd } = analysis;
  const trendTone = structure.trend === 'BULLISH' ? 'bull' : structure.trend === 'BEARISH' ? 'bear' : 'neutral';
  const falseMove = /FALSE/.test(breakout.status);
  return (
    <div className="row g-3">
      <div className="col-12 col-lg-4">
        <section className="glass panel h-100">
          <h2 className="panel-title"><i className="bi bi-diagram-3" /> MARKET STRUCTURE</h2>
          <dl className="kv">
            <div><dt>Trend</dt><dd><span className={`pill ${trendTone}`}>{structure.trend}</span></dd></div>
            <div><dt>Structure</dt><dd>{structure.structure}</dd></div>
            <div><dt>Trend strength</dt><dd>{structure.strength}%</dd></div>
          </dl>
          <div className="conf-track"><i style={{ width: `${structure.strength}%` }} /></div>
          <p className="fine">
            {structure.lastSwingHigh && <>Last swing high {inr(structure.lastSwingHigh.price)}. </>}
            {structure.lastSwingLow && <>Last swing low {inr(structure.lastSwingLow.price)}.</>}
          </p>
          <h3 className="sub-title">VWAP &amp; MACD</h3>
          <ul className="why">
            <li>{vwap.available ? `Price ${vwap.relation.toLowerCase()} VWAP (${vwap.distancePct >= 0 ? '+' : ''}${vwap.distancePct.toFixed(2)}%)` : 'VWAP is only calculated on intraday timeframes'}{vwap.event ? ` - ${vwap.event}` : ''}</li>
            <li>{macd.available ? `MACD: ${macd.label}; histogram ${macd.histogramTrend.toLowerCase()}${macd.zeroCross ? `; zero-line cross ${macd.zeroCross.toLowerCase()}` : ''}` : 'MACD warming up'}</li>
          </ul>
        </section>
      </div>
      <div className="col-12 col-lg-4">
        <section className="glass panel h-100">
          <h2 className="panel-title"><i className="bi bi-exclamation-diamond" /> Breakouts &amp; divergence</h2>
          {falseMove
            ? <div className="note warn strong"><i className="bi bi-exclamation-triangle-fill" /> <span><b>⚠ {breakout.status.replace(/_/g, ' ')}</b><br />{breakout.message}<br /><em>Do not enter immediately.</em></span></div>
            : breakout.status === 'NONE'
              ? <p className="muted">{breakout.message}</p>
              : <div className={`note ${/BREAKOUT/.test(breakout.status) ? 'bull' : 'bear'}`}><i className="bi bi-lightning-charge-fill" /> <span><b>{breakout.status}</b> at {inr(breakout.level)}<br />{breakout.message}</span></div>}
          {breakout.warnings?.length > 0 && !falseMove && <ul className="warnings">{breakout.warnings.map((w) => <li key={w}><i className="bi bi-exclamation-triangle-fill" /> {w}</li>)}</ul>}
          <h3 className="sub-title">RSI divergence</h3>
          {divergence.active
            ? <div className={`note ${divergence.active.type === 'BULLISH' ? 'bull' : 'bear'}`}><i className="bi bi-activity" /> <span><b>{divergence.active.label}</b><br />{divergence.active.detail} ({clock(divergence.active.from.time, false)} → {clock(divergence.active.to.time, false)})</span></div>
            : <p className="muted">No recent RSI divergence.</p>}
        </section>
      </div>
      <div className="col-12 col-lg-4">
        <section className="glass panel h-100">
          <h2 className="panel-title"><i className="bi bi-bar-chart-steps" /> Candle patterns</h2>
          {candlePatterns.length === 0 ? <p className="muted">No notable pattern on the last two candles.</p> : (
            <ul className="patterns">
              {candlePatterns.map((p) => (
                <li key={`${p.name}${p.barIndex}`}>
                  <div className="pt-top"><b>{p.name}</b><span className={`pill ${p.bias === 'bullish' ? 'bull' : p.bias === 'bearish' ? 'bear' : 'neutral'}`}>{p.bias}</span></div>
                  <div className="pt-meter"><i style={{ width: `${p.strength}%` }} /><span>Strength {p.strength}%</span></div>
                  <div className="pt-meaning">{p.meaning}{p.age === 1 ? ' (previous candle)' : ''}</div>
                  {p.context.length > 0 && <div className="fine">{p.context.join(' · ')}</div>}
                </li>
              ))}
            </ul>
          )}
          <p className="fine">A single candle pattern is never treated as confirmation. Candles carry only 10 of the 100 signal points.</p>
        </section>
      </div>
    </div>
  );
}
