import { clock, inr } from '../services/format.js';

export default function CallCard({ call, asOf, price, onTrack, canTrack, tracking }) {
  if (!call) return <section className="glass call-card wait"><div className="call-headline">Loading today's call…</div></section>;
  const p = call.plan;
  const long = p.direction === 'LONG';
  const live = call.action != null;
  return (
    <section className={`glass call-card ${call.tone}`} aria-live="polite">
      <div className="call-meta">
        <span><i className="bi bi-clock" /> {call.timeframe} chart{asOf ? ` · as of ${clock(asOf)}` : ''}</span>
        {price != null && <span>Price <b>{inr(price)}</b></span>}
        <span className="call-signal">Signal: {call.signal}</span>
      </div>
      <div className="call-headline">{live && <i className={`bi ${long ? 'bi-arrow-up-circle-fill' : 'bi-arrow-down-circle-fill'}`} />} {call.headline}</div>
      <p className="call-message">{call.message}</p>

      {(
        <>
          <div className="call-plan-title">{live ? 'Trade plan' : 'Reference plan - not a live call'}{!live && p.direction ? ` (${long ? 'long' : 'short'})` : ''}</div>
          <div className={`call-levels ${live ? '' : 'dim'}`}>
            <div className="lv entry"><span>{live ? (long ? 'Buy at' : 'Sell at') : 'Entry'}</span><b>{inr(call.trigger ?? p.entry)}</b></div>
            <div className="lv stop"><span>Stop loss</span><b>{inr(p.stopLoss)}</b></div>
            <div className="lv tgt"><span>Target 1</span><b>{inr(p.target1)}</b></div>
            <div className="lv tgt"><span>Target 2</span><b>{inr(p.target2)}</b></div>
            <div className="lv"><span>Risk : reward</span><b>1 : {p.rr1.toFixed(2)}</b></div>
            <div className="lv"><span>Confidence</span><b>{p.confidence}%</b></div>
          </div>
        </>
      )}

      {call.blockers.length > 0 && <ul className="warnings">{call.blockers.map((b) => <li key={b}><i className="bi bi-exclamation-triangle-fill" /> {b}</li>)}</ul>}
      {live && call.reasonsFor.length > 0 && (
        <div className="call-why"><b>Why:</b> {call.reasonsFor.join(' · ')}</div>
      )}
      {p.historyContext && <div className="call-why">One-month trend: {p.historyContext.trend.toLowerCase()} · {p.historyContext.candleCount} daily candles</div>}
      {p.candlePattern && <div className="call-why">Pattern-based plan: {p.candlePattern.name}</div>}

      <div className="call-actions">
        {canTrack && !tracking && <button type="button" className="btn-primary-x" onClick={onTrack}><i className="bi bi-bullseye" /> {live ? 'Track this trade' : 'Track this plan'}</button>}
        {tracking && <span className="chip warn"><i className="bi bi-check2-circle" /> Tracking - see the box on the right</span>}
      </div>
      <p className="fine">A technical signal, not a guarantee or advice. Always honour the stop-loss; intraday positions must be squared off before about 3:15 PM.</p>
    </section>
  );
}
