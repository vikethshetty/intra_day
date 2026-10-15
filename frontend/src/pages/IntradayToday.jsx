import { useEffect, useMemo, useState } from 'react';
import StockSearch from '../components/StockSearch.jsx';
import LiveChart from '../components/LiveChart.jsx';
import SupportResistance from '../components/SupportResistance.jsx';
import CallCard from '../components/CallCard.jsx';
import TradeTracker from '../components/TradeTracker.jsx';
import CallLog from '../components/CallLog.jsx';
import AlertToasts from '../components/AlertToasts.jsx';
import LiveDataNotice from '../components/LiveDataNotice.jsx';
import MarketStatus, { DataBanner } from '../components/MarketStatus.jsx';
import { useMarketData } from '../hooks/useMarketData.js';
import { useAlerts } from '../hooks/useAlerts.js';
import { evaluateTrade, useTrackedTrade } from '../hooks/useTrackedTrade.js';
import { useTrackingMarketData } from '../hooks/useTrackingMarketData.js';
import { clock, inr, pct } from '../services/format.js';

const TFS = ['1m', '3m', '5m', '15m'];
const istMinutesNow = () => Math.floor(((Date.now() / 1000 + 19800) % 86400) / 60);

export default function IntradayToday() {
  const [symbol, setSymbol] = useState(() => localStorage.getItem('lia.symbol') || 'HEROMOTORS');
  const [interval, setIntervalTf] = useState(() => { const v = localStorage.getItem('lia.today.tf'); return TFS.includes(v) ? v : '5m'; });
  const { status, data, error, lastSuccess, nextRetryAt, feed, reload } = useMarketData(symbol, interval);
  const [mins, setMins] = useState(istMinutesNow());
  useEffect(() => { const t = setInterval(() => setMins(istMinutesNow()), 20000); return () => clearInterval(t); }, []);
  useEffect(() => { try { localStorage.setItem('lia.symbol', symbol); localStorage.setItem('lia.today.tf', interval); } catch { /* storage unavailable */ } }, [symbol, interval]);

  const analysis = data?.analysis;
  const call = analysis?.intraday;

  /* ---- only today's session goes to the chart ---- */
  const dayStart = useMemo(() => (feed ? Math.floor((feed.candles[feed.candles.length - 1].time + 19800) / 86400) * 86400 - 19800 : 0), [feed]);
  const todayFeed = useMemo(() => {
    if (!feed) return null;
    let i = feed.candles.length - 1;
    while (i > 0 && feed.candles[i - 1].time >= dayStart) i--;
    const candles = feed.candles.slice(i);
    const t0 = candles[0].time;
    const series = {};
    Object.keys(feed.series).forEach((k) => { series[k] = feed.series[k].filter((p) => p.time >= t0); });
    return { ...feed, key: `${feed.key}|today|${t0}`, candles, series };
  }, [feed, dayStart]);

  /* ---- tracked trade + alerts ---- */
  const { tracked, track, clear } = useTrackedTrade(symbol, null, null);
  const trackingFeed = useTrackingMarketData(symbol, '1m', Boolean(tracked));
  const trk = useMemo(() => evaluateTrade(tracked, trackingFeed.data?.candles || [], trackingFeed.data?.quote?.price ?? null), [tracked, trackingFeed.data]);
  const quote = tracked ? (trackingFeed.data?.quote || data?.quote) : data?.quote;
  const stale = status === 'error' && !!data;
  const price = stale ? null : quote?.price;
  const callEvent = useMemo(() => {
    if (!call || !['BUY_NOW', 'SELL_NOW', 'SQUARE_OFF'].includes(call.verdict)) return null;
    const date = new Date(Date.now() + 19800 * 1000).toISOString().slice(0, 10);
    return { id: `CALL_${call.verdict}_${analysis.signal.since ?? date}`, type: 'CALL', severity: call.tone === 'bull' ? 'bull' : call.tone === 'bear' ? 'bear' : 'warn', title: call.headline, message: call.message, time: analysis.asOf };
  }, [call, analysis]);
  const events = useMemo(() => (analysis ? [...analysis.events, ...(callEvent ? [callEvent] : [])] : null), [analysis, callEvent]);
  const { toasts, notifyState, enableNotifications, dismissToast } = useAlerts({
    symbol, interval, events, price, priceTime: quote?.time, trade: tracked && !trk?.done ? tracked : null, displayName: data?.name || symbol,
  });
  useEffect(() => { document.title = call ? `${call.headline} · ${data.symbol} ${quote.price.toFixed(2)}` : 'Intraday Today'; }, [call, data?.symbol, quote]);

  const chartTrade = tracked || (call?.action ? call.plan : null);
  const markers = useMemo(() => (analysis?.markers || []).filter((m) => m.time >= dayStart), [analysis?.markers, dayStart]);
  const up = (quote?.changePct ?? 0) >= 0;
  const canTrack = !!call && !stale && ['BUY_NOW', 'SELL_NOW', 'BUY_WAIT', 'SELL_WAIT', 'PULLBACK'].includes(call.verdict);
  const dayRangePos = quote && quote.high > quote.low ? ((quote.price - quote.low) / (quote.high - quote.low)) * 100 : null;

  return (
    <div className="app-shell no-top">
      <header className="topbar glass">
        <div className="brand">
          <span className="brand-mark"><i className="bi bi-lightning-charge-fill" /></span>
          <div><h1>INTRADAY TODAY</h1><p>One session · clear buy / sell / wait calls</p></div>
        </div>
        <div className="tb-fields">
          <div className="tb-field grow"><span className="k">Stock</span><StockSearch symbol={symbol} onSelect={setSymbol} /></div>
          <div className="tb-field"><span className="k">{data ? data.symbol : 'Symbol'}</span><b className="tb-name" title={data?.name}>{data?.name || symbol}</b></div>
        </div>
        <div className="tb-quote">
          <div className={`price ${stale ? 'stale' : ''}`}><span className="k">Current price</span><b>{quote ? inr(quote.price) : '—'}</b></div>
          <div className="chg"><span className="k">Today</span><b className={up ? 'up' : 'down'}>{quote?.changePct != null ? pct(quote.changePct) : '—'}</b></div>
          <MarketStatus status={data?.marketStatus} lastCandleTime={quote?.lastCandleTime} />
          <div className="updated"><span className="k">Last updated</span><b>{lastSuccess ? clock(lastSuccess) : '—'}</b></div>
          <button type="button" className={`icon-btn bell ${notifyState === 'granted' ? 'on' : ''}`} title={notifyState === 'granted' ? 'Browser notifications enabled' : 'Get a browser notification when a BUY NOW / SELL NOW call appears'} onClick={enableNotifications} disabled={notifyState === 'unsupported' || notifyState === 'denied'}>
            <i className={`bi ${notifyState === 'granted' ? 'bi-bell-fill' : 'bi-bell'}`} />
          </button>
        </div>
      </header>

      <main className="content">
        <DataBanner error={error} lastSuccess={lastSuccess} nextRetryAt={nextRetryAt} onRetry={reload} hasData={!!data} />
        {data?.candleLagSec > 90 && <div className="banner err"><i className="bi bi-hourglass-split" /><div className="banner-body"><strong>Candle feed is {Math.round(data.candleLagSec / 60)} min behind the live price</strong><div>The provider's candles are delayed, so the call below may be late. Confirm on your broker before acting.</div></div></div>}
        {!data && status === 'loading' && !error && <div className="loading-card glass"><div className="spinner-border text-primary" role="status" /> Loading today's session for <b>{symbol}</b>…</div>}

        <div className="row g-3">
          <div className="col-12 col-xl-7"><CallCard call={call} asOf={analysis?.asOf} price={price} canTrack={canTrack} tracking={!!tracked} onTrack={() => track(call.plan.direction ? { ...call.plan, entry: call.trigger ?? call.plan.entry } : call.plan, quote.price)} /></div>
          <div className="col-12 col-xl-5">
            <TradeTracker state={trk} onClear={clear} mins={mins} />
            {tracked && trackingFeed.error && <div className="banner err mt-2"><strong>Upstox tracking data unavailable:</strong> {trackingFeed.error.message}</div>}
            {tracked && trackingFeed.data && <p className="fine text-end">Trade tracking price: Upstox · updated {clock(Math.floor(trackingFeed.data.fetchedAt / 1000))}</p>}
          </div>
        </div>

        <LiveChart
          feed={todayFeed} levels={analysis?.levels} trade={chartTrade} markers={markers} tradeHits={[]}
          interval={interval} onIntervalChange={setIntervalTf} stale={stale} loading={status === 'loading' && !feed}
          symbol={data?.symbol || symbol} timeframes={TFS} fitAll initialToggles={{ rsi: false, macd: false, ema50: false, ema200: false }}
        />

        {data && (
          <div className="row g-3">
            <div className="col-12 col-xl-4">
              <section className="glass panel h-100">
                <h2 className="panel-title"><i className="bi bi-calendar-day" /> Today at a glance</h2>
                <dl className="kv">
                  <div><dt>Open</dt><dd>{inr(quote.open)}</dd></div>
                  <div><dt>Day high</dt><dd className="up">{inr(quote.high)}</dd></div>
                  <div><dt>Day low</dt><dd className="down">{inr(quote.low)}</dd></div>
                  <div><dt>Previous close</dt><dd>{inr(quote.previousClose)}</dd></div>
                  <div><dt>VWAP</dt><dd>{analysis.vwap.available ? inr(analysis.vwap.value) : '—'}{analysis.vwap.available ? <small className="muted"> · price {analysis.vwap.relation.toLowerCase()}</small> : null}</dd></div>
                  <div><dt>Trend ({interval})</dt><dd>{analysis.structure.trend.toLowerCase()} · {analysis.structure.strength}%</dd></div>
                  {quote.volume > 0 && <div><dt>Volume</dt><dd>{quote.volume.toLocaleString('en-IN')}</dd></div>}
                </dl>
                {dayRangePos != null && (
                  <div className="range-bar" title="Where the price sits in today's range"><span>Low</span><div><i style={{ left: `${dayRangePos}%` }} /></div><span>High</span></div>
                )}
              </section>
            </div>
            <div className="col-12 col-md-6 col-xl-4"><SupportResistance levels={analysis.levels} price={analysis.price} /></div>
            <div className="col-12 col-md-6 col-xl-4"><CallLog history={analysis.signalHistory} dayStart={dayStart} interval={interval} /></div>
          </div>
        )}

        <footer className="disclaimer">
          <i className="bi bi-shield-exclamation" />
          <p><b>Not financial advice.</b> The live quote and chart use Upstox; BUY NOW / SELL NOW analysis and historical context use Yahoo Finance. When you track a trade, Upstox monitors price against the fixed entry, stop, and target levels. Data feeds can differ; confirm orders with your broker. This app never places trades.</p>
        </footer>
      </main>
      <AlertToasts toasts={toasts} onDismiss={dismissToast} />
      <LiveDataNotice source={data?.chartSource} />
    </div>
  );
}
