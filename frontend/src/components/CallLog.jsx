import { clock, inr } from '../services/format.js';

const TEXT = (s) => {
  if (s === 'STRONG BUY' || s === 'BUY') return { icon: 'bi-arrow-up-circle-fill', tone: 'bull', text: 'YES - BUY signal' };
  if (s === 'STRONG SELL' || s === 'SELL') return { icon: 'bi-arrow-down-circle-fill', tone: 'bear', text: 'SELL signal' };
  if (s === 'WEAK BUY') return { icon: 'bi-dash-circle', tone: 'wait', text: 'Weak buy lean - not actionable' };
  if (s === 'WEAK SELL') return { icon: 'bi-dash-circle', tone: 'wait', text: 'Weak sell lean - not actionable' };
  return { icon: 'bi-pause-circle', tone: 'wait', text: 'Signal cleared - WAIT' };
};

export default function CallLog({ history, dayStart, interval }) {
  const today = (history || []).filter((h) => h.time >= dayStart);
  return (
    <section className="glass panel h-100">
      <h2 className="panel-title"><i className="bi bi-journal-text" /> Today's call log <small className="muted">({interval} chart)</small></h2>
      {today.length === 0 ? <p className="muted">No signal change yet today.</p> : (
        <ul className="alert-log">
          {today.map((h) => {
            const t = TEXT(h.signal);
            return (
              <li key={`${h.time}${h.signal}`} className={t.tone}>
                <i className={`bi ${t.icon}`} />
                <div><b>{t.text} at {inr(h.price)}</b><span>{h.why || `Score ${h.score}/100`}</span></div>
                <time>{clock(h.time, false)}</time>
              </li>
            );
          })}
        </ul>
      )}
      <p className="fine">A call changes only after two candles agree, so it does not flicker. Earlier calls are history - act only on the live call above.</p>
    </section>
  );
}
