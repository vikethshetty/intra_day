function Scenario({ s, tone, letter }) {
  return (
    <article className={`glass panel scen ${tone}`}>
      <header>
        <h3>Scenario {letter} — {tone === 'bull' ? 'Bullish' : 'Bearish'}</h3>
        <div className="prob"><b>{s.probability}%</b><span>probability</span></div>
      </header>
      <div className="prob-track"><i style={{ width: `${s.probability}%` }} /></div>
      <dl className="scen-kv">
        <div><dt>Trigger</dt><dd>{s.trigger}</dd></div>
        <div><dt>Expected zone</dt><dd><b>{s.expectedZone.text}</b></dd></div>
        <div><dt>Invalidation</dt><dd>{s.invalidation}</dd></div>
      </dl>
      <h4>Confirmation</h4>
      <ul className="checks">
        {s.confirmations.map((c) => <li key={c.label} className={c.met ? 'ok' : 'no'}><i className={`bi ${c.met ? 'bi-check-circle-fill' : 'bi-circle'}`} />{c.label}</li>)}
      </ul>
    </article>
  );
}

export default function ScenarioPanel({ prediction }) {
  if (!prediction) return null;
  const { bullish, bearish, sideways } = prediction.scenarios;
  return (
    <>
      <section className="glass panel next">
        <h2 className="panel-title"><i className="bi bi-signpost-split" /> WHAT IS MOST LIKELY TO HAPPEN NEXT?</h2>
        <p className="next-lead">
          Evidence currently favours a <b>{prediction.dominant}</b> outcome over the next ~{prediction.horizonBars} candles, but this is a probability estimate, not a prediction of a price or a time.
        </p>
        <div className="stack" role="img" aria-label={`Bullish ${bullish.probability}%, sideways ${sideways.probability}%, bearish ${bearish.probability}%`}>
          <i className="bull" style={{ width: `${bullish.probability}%` }}>{bullish.probability}%</i>
          <i className="side" style={{ width: `${sideways.probability}%` }}>{sideways.probability}%</i>
          <i className="bear" style={{ width: `${bearish.probability}%` }}>{bearish.probability}%</i>
        </div>
        <div className="stack-legend"><span className="bull">Bullish</span><span className="side">Sideways</span><span className="bear">Bearish</span></div>
        <div className="side-card">
          <b>Sideways scenario · {sideways.probability}%</b>
          <span>{sideways.trigger}. Expected zone {sideways.expectedZone.text}. Invalidated by: {sideways.invalidation}.</span>
        </div>
        <details className="how">
          <summary>How these probabilities are calculated</summary>
          <ul>{prediction.method.map((m) => <li key={m}>{m}</li>)}</ul>
        </details>
        <p className="fine"><i className="bi bi-info-circle" /> {prediction.disclaimer}</p>
      </section>
      <div className="row g-3 mt-0">
        <div className="col-12 col-lg-6"><Scenario s={bullish} tone="bull" letter="A" /></div>
        <div className="col-12 col-lg-6"><Scenario s={bearish} tone="bear" letter="B" /></div>
      </div>
    </>
  );
}
