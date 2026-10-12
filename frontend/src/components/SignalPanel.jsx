import { clock, signalTone } from '../services/format.js';

export default function SignalPanel({ signal }) {
  if (!signal) return <section className="glass panel h-100"><h2 className="panel-title"><i className="bi bi-broadcast" /> Signal</h2><p className="muted">Waiting for data…</p></section>;
  const tone = signalTone(signal.label);
  const lean = signal.label === 'WAIT';
  return (
    <section className="glass panel h-100">
      <h2 className="panel-title"><i className="bi bi-broadcast" /> Signal</h2>
      <div className={`sig-hero ${tone}`}>
        <div className="sig-label">{signal.label}</div>
        <div className="sig-score"><b>{signal.score}</b><span>/100</span></div>
      </div>
      <div className="sig-sub">
        {lean ? `Leaning ${signal.lean === 'LONG' ? 'bullish' : 'bearish'}, not actionable` : `${signal.direction === 'LONG' ? 'Long' : 'Short'} bias`}
        {signal.since && <> · since {clock(signal.since, false)}</>}
      </div>
      {signal.pending && <div className="note warn"><i className="bi bi-hourglass-split" /> Next candle would read <b>{signal.pending}</b>. The displayed signal only changes after two consecutive candles agree.</div>}

      <ul className="score-rows">
        {signal.components.map((c) => (
          <li key={c.key}>
            <span className="sc-name">{c.label}</span>
            <span className="sc-bar"><i className={tone} style={{ width: `${(c.score / c.max) * 100}%` }} /></span>
            <span className="sc-val">{c.score}/{c.max}</span>
          </li>
        ))}
        <li className="sc-total"><span className="sc-name">TOTAL</span><span className="sc-val">{signal.score}/100</span></li>
      </ul>

      <h3 className="sub-title">Confirmations ({signal.met}/7)</h3>
      <ul className="checks">
        {signal.checks.map((c) => (
          <li key={c.key} className={c.ok ? 'ok' : 'no'}>
            <i className={`bi ${c.ok ? 'bi-check-circle-fill' : 'bi-circle'}`} />{c.label}{c.note ? <small> ({c.note})</small> : null}
          </li>
        ))}
      </ul>
      {signal.warnings.length > 0 && (
        <ul className="warnings">{signal.warnings.map((w) => <li key={w}><i className="bi bi-exclamation-triangle-fill" /> {w}</li>)}</ul>
      )}
      <p className="fine">Why: {signal.reasons.length ? signal.reasons.slice(0, 4).join(' · ') : 'few conditions are aligned'}. Bullish score {signal.longScore}, bearish score {signal.shortScore}.</p>
    </section>
  );
}
