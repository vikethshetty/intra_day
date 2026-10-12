import { toneOf } from '../services/format.js';

export default function IndicatorPanel({ rows }) {
  return (
    <section className="glass panel h-100">
      <h2 className="panel-title"><i className="bi bi-sliders2" /> Indicators</h2>
      {!rows?.length ? <p className="muted">Waiting for data…</p> : (
        <ul className="ind-list">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="ind-top">
                <span className="ind-name">{r.label}</span>
                <span className="ind-val">{r.value}</span>
              </div>
              <div className="ind-bottom">
                <span className={`pill ${toneOf(r.tone)}`}>{r.state}</span>
                {r.detail && <span className="ind-detail">{r.detail}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
