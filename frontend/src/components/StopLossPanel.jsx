import { clock, inr } from '../services/format.js';

export default function StopLossPanel({ result, loading, error, direction, onDirection, onAnalyze, onClear, disabled }) {
  const s = result?.setup;
  return (
    <section className="glass panel h-100">
      <h2 className="panel-title"><i className="bi bi-shield-check" /> Stop loss &amp; targets</h2>
      <div className="sl-actions">
        <button type="button" className="btn-primary-x" onClick={onAnalyze} disabled={loading || disabled}>
          {loading ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-crosshair2" />} ANALYZE STOP LOSS
        </button>
        <div className="seg sm" role="group" aria-label="Trade direction">
          {['AUTO', 'LONG', 'SHORT'].map((d) => <button key={d} type="button" className={direction === d ? 'on' : ''} onClick={() => onDirection(d)}>{d}</button>)}
        </div>
      </div>
      {error && <div className="note bear"><i className="bi bi-exclamation-octagon" /> {error}</div>}
      {!s && !error && <p className="muted">Calculates a stop based on swing structure, support/resistance, VWAP, EMAs, ATR and volume, then draws entry, stop and targets on the chart.</p>}
      {s && (
        <>
          <dl className="sl-grid">
            <div><dt>RECOMMENDED ENTRY</dt><dd className="blue">{inr(s.entry)}</dd></div>
            <div><dt>STOP LOSS</dt><dd className="down">{inr(s.stopLoss)}</dd></div>
            <div><dt>RISK</dt><dd>{inr(s.risk)}</dd></div>
            <div><dt>TARGET 1</dt><dd className="up">{inr(s.target1)}</dd></div>
            <div><dt>TARGET 2</dt><dd className="up">{inr(s.target2)}</dd></div>
            <div><dt>RISK/REWARD</dt><dd>1 : {s.rr1.toFixed(2)}</dd></div>
          </dl>
          <div className="conf"><span>Confidence {s.confidence}%</span><div className="conf-track"><i style={{ width: `${s.confidence}%` }} /></div></div>
          <div className="sl-meta">{s.direction} · {s.status} · calculated {clock(result.asOf)}</div>
          {result.warnings.map((w) => <div className="note warn" key={w}><i className="bi bi-exclamation-triangle-fill" /> {w}</div>)}
          <h3 className="sub-title">Why this stop</h3>
          <ul className="why">{s.stop.rationale.map((r) => <li key={r}>{r}</li>)}</ul>
          <ul className="factors">{s.stop.factors.map((f) => <li key={f.name}><span>{f.name}</span><b>{f.value}</b></li>)}</ul>
          <button type="button" className="btn-soft" onClick={onClear}><i className="bi bi-eraser" /> Clear from chart</button>
          <p className="fine">Levels are fixed at the time of analysis and alerts watch them live. Run it again to refresh.</p>
        </>
      )}
    </section>
  );
}
