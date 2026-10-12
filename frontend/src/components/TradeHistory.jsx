import { useState } from 'react';
import { clock, dayTime, inr, signalTone } from '../services/format.js';

export default function TradeHistory({ history, alerts }) {
  const [tab, setTab] = useState('signals');
  return (
    <section className="glass panel h-100">
      <div className="panel-head">
        <h2 className="panel-title"><i className="bi bi-journal-text" /> Signal history</h2>
        <div className="seg sm" role="tablist">
          <button type="button" className={tab === 'signals' ? 'on' : ''} onClick={() => setTab('signals')}>Signal changes</button>
          <button type="button" className={tab === 'alerts' ? 'on' : ''} onClick={() => setTab('alerts')}>Alerts{alerts.length ? ` (${alerts.length})` : ''}</button>
        </div>
      </div>
      {tab === 'signals' ? (
        history?.length ? (
          <div className="table-scroll">
            <table className="hist">
              <thead><tr><th>Time (IST)</th><th>Signal</th><th>Price</th><th>Score</th><th>Why</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={`${h.time}${h.signal}`}>
                    <td>{dayTime(h.time)}</td>
                    <td><span className={`pill ${signalTone(h.signal) === 'wait' ? 'warn' : signalTone(h.signal)}`}>{h.signal}</span></td>
                    <td>{inr(h.price)}</td><td>{h.score}</td><td className="why-cell">{h.why || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No signal changes yet in the loaded candles.</p>
      ) : alerts.length ? (
        <ul className="alert-log">
          {alerts.map((a) => <li key={a.uid} className={a.severity}><i className={`bi ${a.icon}`} /><div><b>{a.title}</b><span>{a.message}</span></div><time>{clock(a.at)}</time></li>)}
        </ul>
      ) : <p className="muted">Alerts appear here while you keep the page open: breakouts, VWAP crosses, volume spikes, RSI extremes, and entry / stop-loss / target levels after you run the stop-loss analysis.</p>}
      <p className="fine">Signals change only when real candle data changes, and only after two consecutive candles agree.</p>
    </section>
  );
}
