import { compact } from '../services/format.js';

export default function VolumePanel({ volume }) {
  if (!volume) return <section className="glass panel h-100"><h2 className="panel-title"><i className="bi bi-bar-chart-line" /> Volume</h2><p className="muted">Waiting for data…</p></section>;
  const tone = volume.ratio >= 1.5 ? 'bull' : volume.ratio < 0.7 ? 'warn' : 'neutral';
  const pressure = Math.max(-1, Math.min(1, volume.pressure));
  return (
    <section className="glass panel h-100">
      <h2 className="panel-title"><i className="bi bi-bar-chart-line" /> Volume</h2>
      <div className="vol-hero">
        <span className={`pill big ${tone}`}>{volume.label}</span>
        <span className="vol-ratio">{volume.ratio.toFixed(2)}<small>x average</small></span>
      </div>
      <dl className="kv">
        <div><dt>Current volume</dt><dd>{compact(volume.current)}</dd></div>
        <div><dt>Average volume (20)</dt><dd>{compact(volume.average)}</dd></div>
        <div><dt>Volume trend</dt><dd>{volume.trend.toLowerCase()}</dd></div>
        <div><dt>Spike</dt><dd>{volume.spike ? 'Yes (≥2x)' : 'No'}</dd></div>
      </dl>
      <div className="pressure" aria-label={`Pressure ${volume.pressureLabel}`}>
        <span>Selling</span>
        <div className="pressure-track"><i style={{ left: `${(pressure + 1) * 50}%` }} /></div>
        <span>Buying</span>
      </div>
      <p className="interp"><b>{volume.pressureLabel.charAt(0) + volume.pressureLabel.slice(1).toLowerCase()}.</b> {volume.interpretation}. Breakout signals need volume above average to count as confirmed.</p>
    </section>
  );
}
