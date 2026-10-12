import { clock, inr } from '../services/format.js';

const STATUS = {
  WAITING: { tone: 'wait', title: 'WAITING FOR ENTRY', icon: 'bi-hourglass-split' },
  IN_TRADE: { tone: 'info', title: 'IN TRADE - HOLD', icon: 'bi-activity' },
  T1: { tone: 'bull', title: 'TARGET 1 HIT', icon: 'bi-bullseye' },
  T2: { tone: 'bull', title: 'TARGET 2 HIT - BOOK FULL PROFIT', icon: 'bi-trophy-fill' },
  STOPPED: { tone: 'bear', title: 'STOP LOSS HIT - EXIT NOW', icon: 'bi-x-octagon-fill' },
  BREAKEVEN: { tone: 'wait', title: 'BACK AT ENTRY - EXIT AT BREAKEVEN', icon: 'bi-arrow-left-right' },
};

function message(s, mins) {
  const long = s.direction === 'LONG';
  switch (s.status) {
    case 'WAITING': return `Do not ${long ? 'buy' : 'sell'} yet. Wait for price to ${long ? 'rise to' : 'fall to'} ${inr(s.entry)}.`;
    case 'IN_TRADE': return `Hold. Stop-loss ${inr(s.stopLoss)}, Target 1 ${inr(s.target1)}, Target 2 ${inr(s.target2)}.`;
    case 'T1': return `Book about half the position and move your stop-loss to the entry price ${inr(s.entry)}. Target 2 is ${inr(s.target2)}.`;
    case 'T2': return `Both targets reached - close the remaining position and take the profit.`;
    case 'STOPPED': return `Price touched ${inr(s.stopLoss)}. Exit; the loss is limited to what you planned. Do not average down.`;
    case 'BREAKEVEN': return `After Target 1, price came back to ${inr(s.entry)}. Exit at breakeven as per the trailing stop.`;
    default: return '';
  }
}

export default function TradeTracker({ state, onClear, mins }) {
  if (!state) {
    return (
      <section className="glass panel tracker idle">
        <h2 className="panel-title"><i className="bi bi-bullseye" /> My trade tracker</h2>
        <p className="muted">When a <b>BUY NOW</b> or <b>SELL NOW</b> call appears, press <b>Track this trade</b>. This box then tells you live: hold, book profit at Target 1, exit at Target 2, or exit if the stop-loss is hit.</p>
        <p className="fine">Stored only in this browser, for today's session.</p>
      </section>
    );
  }
  const st = STATUS[state.status];
  const squareOff = !state.done && state.entered && mins >= 15 * 60 + 15;
  return (
    <section className={`glass panel tracker ${st.tone}`}>
      <div className="panel-head"><h2 className="panel-title"><i className="bi bi-bullseye" /> My trade tracker</h2><button type="button" className="btn-soft" onClick={onClear}>Stop tracking</button></div>
      <div className="trk-status"><i className={`bi ${st.icon}`} /> {st.title}</div>
      <p className="trk-msg">{message(state)}</p>
      {squareOff && <div className="note warn strong"><i className="bi bi-alarm-fill" /> <span><b>SQUARE OFF NOW</b> - it is past 3:15 PM, close the intraday position.</span></div>}
      <dl className="bt-grid">
        <div><dt>{state.direction === 'LONG' ? 'Bought' : 'Sold'} at</dt><dd>{inr(state.entry)}</dd></div>
        <div><dt>Stop-loss{state.t1 ? ' (now at entry)' : ''}</dt><dd className="down">{inr(state.t1 ? state.entry : state.stopLoss)}</dd></div>
        <div><dt>Targets</dt><dd className="up">{inr(state.target1)} / {inr(state.target2)}</dd></div>
        <div><dt>{state.done ? 'Result per share' : 'Live P&L per share'}</dt><dd className={state.pnl == null ? '' : state.pnl >= 0 ? 'up' : 'down'}>{state.pnl == null ? '—' : `${state.pnl >= 0 ? '+' : ''}${state.pnl.toFixed(2)} (${state.pnlPct >= 0 ? '+' : ''}${state.pnlPct.toFixed(2)}%)`}</dd></div>
      </dl>
      <ul className="trk-steps">
        {state.enteredAt && state.entered && <li><i className="bi bi-check-circle-fill" /> Entry {state.enteredAt === state.startedAt ? 'taken at tracking time' : `reached ${clock(state.enteredAt, false)}`}</li>}
        {state.t1At && <li><i className="bi bi-check-circle-fill up" /> Target 1 hit {clock(state.t1At, false)}</li>}
        {state.exit && <li><i className="bi bi-flag-fill" /> Closed at {inr(state.exit.price)} {state.exit.time !== Infinity ? clock(state.exit.time, false) : 'now'}</li>}
      </ul>
      <p className="fine">Levels are fixed from the moment you tracked. Checked against every candle since, stop-loss first when a candle touches both. Tracking only watches - it never places orders.</p>
    </section>
  );
}
