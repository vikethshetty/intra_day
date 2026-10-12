import { inr } from '../services/format.js';

function Row({ l, price, kind }) {
  const dist = ((l.price - price) / price) * 100;
  return (
    <li className={`sr-row ${kind}`}>
      <span className="sr-name">{l.name}</span>
      <span className="sr-price">{inr(l.price)}</span>
      <span className="sr-meta" title={l.label}>{l.label}{l.dynamic ? ' (dynamic)' : ''}</span>
      <span className="sr-dist">{dist >= 0 ? '+' : ''}{dist.toFixed(2)}%</span>
      <span className="sr-bar" aria-label={`Strength ${l.strength}%`}><i style={{ width: `${l.strength}%` }} /></span>
    </li>
  );
}

export default function SupportResistance({ levels, price }) {
  if (!levels || price == null) return <section className="glass panel h-100"><h2 className="panel-title"><i className="bi bi-distribute-vertical" /> Support &amp; resistance</h2><p className="muted">Waiting for data…</p></section>;
  return (
    <section className="glass panel h-100">
      <h2 className="panel-title"><i className="bi bi-distribute-vertical" /> Support &amp; resistance</h2>
      <div className="sr-head bear">RESISTANCE</div>
      <ul className="sr-list">{[...levels.resistance].reverse().map((l) => <Row key={l.name} l={l} price={price} kind="res" />)}</ul>
      <div className="sr-current"><span>CURRENT</span><b>{inr(price)}</b></div>
      <div className="sr-head bull">SUPPORT</div>
      <ul className="sr-list">{levels.support.map((l) => <Row key={l.name} l={l} price={price} kind="sup" />)}</ul>
      <p className="fine">Built from previous-day and current-day high/low, swing points, pivots, Fibonacci, volume profile, VWAP and EMAs. Levels that coincide score higher.</p>
    </section>
  );
}
