import { inr, signalTone } from '../services/format.js';

export default function TradeSetup({ setup }) {
  if (!setup) return <section className="glass panel h-100"><h2 className="panel-title"><i className="bi bi-bullseye" /> TRADE SETUP</h2><p className="muted">Waiting for data…</p></section>;
  const long = setup.direction === 'LONG';
  const tone = setup.active ? (long ? 'bull' : 'bear') : 'wait';
  return (
    <section className="glass panel h-100 setup">
      <h2 className="panel-title"><i className="bi bi-bullseye" /> TRADE SETUP {!setup.active && <span className="chip warn">conditional</span>}</h2>
      <div className="setup-top">
        <div><span className="k">Direction</span><b className={long ? 'up' : 'down'}>{setup.direction}</b></div>
        <div><span className="k">Setup</span><b className={`status ${tone}`}>{setup.status}</b></div>
      </div>
      <div className="setup-grid">
        <div className="cell entry"><span className="k">Entry</span><b>{inr(setup.entry)}</b></div>
        <div className="cell stop"><span className="k">Stop loss</span><b>{inr(setup.stopLoss)}</b></div>
        <div className="cell tgt"><span className="k">Target 1</span><b>{inr(setup.target1)}</b></div>
        <div className="cell tgt"><span className="k">Target 2</span><b>{inr(setup.target2)}</b></div>
        <div className="cell"><span className="k">Risk</span><b>{inr(setup.risk)}</b><small>{setup.riskPct.toFixed(2)}% of entry</small></div>
        <div className="cell"><span className="k">Reward (T1 / T2)</span><b>{inr(setup.reward1)}</b><small>{inr(setup.reward2)}</small></div>
        <div className="cell"><span className="k">Risk / reward</span><b>1 : {setup.rr1.toFixed(2)}</b><small>to T2 1 : {setup.rr2.toFixed(2)}</small></div>
        <div className="cell"><span className="k">Signal strength</span><b>{setup.signalStrength}/100</b><small>confidence {setup.confidence}%</small></div>
      </div>
      {setup.confirmation && <div className="note info"><i className="bi bi-hourglass-split" /> <span><b>Confirmation required:</b> {setup.confirmation}</span></div>}
      <div className="note neutral"><i className="bi bi-x-octagon" /> <span><b>Invalidation:</b> {setup.invalidation}</span></div>
      <p className="fine">Targets: {setup.target1Note}; {setup.target2Note}. Confidence is capped at 90% - no setup is ever treated as certain.</p>
    </section>
  );
}
