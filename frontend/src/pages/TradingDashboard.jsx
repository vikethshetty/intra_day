import { useCallback, useEffect, useMemo, useState } from 'react';
import StockSearch from '../components/StockSearch.jsx';
import LiveChart from '../components/LiveChart.jsx';
import IndicatorPanel from '../components/IndicatorPanel.jsx';
import SupportResistance from '../components/SupportResistance.jsx';
import VolumePanel from '../components/VolumePanel.jsx';
import TradeSetup from '../components/TradeSetup.jsx';
import SignalPanel from '../components/SignalPanel.jsx';
import StopLossPanel from '../components/StopLossPanel.jsx';
import ScenarioPanel from '../components/ScenarioPanel.jsx';
import CandleStructurePanel from '../components/CandleStructurePanel.jsx';
import BacktestPanel from '../components/BacktestPanel.jsx';
import TradeHistory from '../components/TradeHistory.jsx';
import AlertToasts from '../components/AlertToasts.jsx';
import MarketStatus, { DataBanner } from '../components/MarketStatus.jsx';
import { useMarketData } from '../hooks/useMarketData.js';
import { useAlerts } from '../hooks/useAlerts.js';
import { runStopLoss, normalizeError } from '../services/api.js';
import { clock, inr, pct } from '../services/format.js';

const DEFAULT_SYMBOL = 'HEROMOTORS'; // resolves to NSE: HEROMOTOCO

export default function TradingDashboard() {
  const [symbol, setSymbol] = useState(() => localStorage.getItem('lia.symbol') || DEFAULT_SYMBOL);
  const [interval, setIntervalTf] = useState(() => localStorage.getItem('lia.interval') || '1m');
  const { status, data, error, lastSuccess, nextRetryAt, feed, reload } = useMarketData(symbol, interval);

  const [direction, setDirection] = useState('AUTO');
  const [slResult, setSlResult] = useState(null);
  const [slLoading, setSlLoading] = useState(false);
  const [slError, setSlError] = useState(null);

  const analysis = data?.analysis;
  const quote = data?.quote;
  const stale = status === 'error' && !!data;
  const trade = slResult && slResult.symbol === data?.symbol && slResult.interval === interval ? slResult.setup : null;

  useEffect(() => { try { localStorage.setItem('lia.symbol', symbol); localStorage.setItem('lia.interval', interval); } catch { /* storage unavailable */ } }, [symbol, interval]);
  useEffect(() => { setSlResult(null); setSlError(null); }, [symbol, interval]);
  useEffect(() => { document.title = quote ? `${data.symbol} ${quote.price.toFixed(2)} · Live Intraday Analyzer` : 'Live Intraday Analyzer'; }, [quote, data?.symbol]);

  const { alerts, toasts, hits, notifyState, enableNotifications, dismissToast } = useAlerts({
    symbol, interval, events: analysis?.events, price: stale ? null : quote?.price, priceTime: quote?.time, trade, displayName: data?.name || symbol,
  });

  const analyzeStopLoss = useCallback(async () => {
    setSlLoading(true); setSlError(null);
    try {
      const r = await runStopLoss(symbol, interval, direction);
      setSlResult({ ...r, interval });
    } catch (err) { setSlError(normalizeError(err).message); }
    finally { setSlLoading(false); }
  }, [symbol, interval, direction]);

  const markers = useMemo(() => {
    const out = [...(analysis?.markers || [])];
    if (trade && slResult) out.push({ time: slResult.asOf, kind: 'ENTRY', text: `ENTRY ${trade.direction === 'LONG' ? '▲' : '▼'}` });
    const lastT = feed?.candles?.[feed.candles.length - 1]?.time;
    hits.forEach((h) => { if (lastT) out.push({ time: lastT, kind: h.kind, text: { ENTRY: 'ENTRY HIT', STOP: 'SL HIT', T1: 'T1 HIT', T2: 'T2 HIT' }[h.kind], below: trade?.direction === 'SHORT' }); });
    return out;
  }, [analysis?.markers, trade, slResult, hits, feed]);

  const up = (quote?.changePct ?? 0) >= 0;
  const noData = !data;

  return (
    <div className="app-shell">
      <header className="topbar glass">
        <div className="brand">
          <span className="brand-mark"><i className="bi bi-graph-up-arrow" /></span>
          <div>
            <h1>LIVE INTRADAY ANALYZER</h1>
            <p>Personal technical analysis · no login · never places trades</p>
          </div>
        </div>
        <div className="tb-fields">
          <div className="tb-field"><span className="k">Market</span><b>NSE</b></div>
          <div className="tb-field grow">
            <span className="k">Stock</span>
            <StockSearch symbol={symbol} onSelect={setSymbol} />
          </div>
          <div className="tb-field">
            <span className="k">{data ? data.symbol : 'Symbol'}</span>
            <b className="tb-name" title={data?.name}>{data?.name || symbol}</b>
          </div>
        </div>
        <div className="tb-quote">
          <div className={`price ${stale ? 'stale' : ''}`}>
            <span className="k">Current price</span>
            <b>{quote ? inr(quote.price) : '—'}</b>
          </div>
          <div className="chg">
            <span className="k">Change</span>
            <b className={up ? 'up' : 'down'}>{quote?.changePct != null ? pct(quote.changePct) : '—'}</b>
            {quote?.change != null && <small className={up ? 'up' : 'down'}>{quote.change >= 0 ? '+' : ''}{quote.change.toFixed(2)}</small>}
          </div>
          <MarketStatus status={data?.marketStatus} lastCandleTime={quote?.lastCandleTime} />
          <div className="updated">
            <span className="k">Last updated</span>
            <b>{lastSuccess ? clock(lastSuccess) : '—'}</b>
            <small>{data ? `Live quote/chart: ${data.chartSource} · Analysis: ${data.analysisSource}` : ''}</small>
          </div>
          <button type="button" className={`icon-btn bell ${notifyState === 'granted' ? 'on' : ''}`} title={notifyState === 'granted' ? 'Browser notifications enabled' : notifyState === 'denied' ? 'Notifications blocked in browser settings' : 'Enable browser notifications for alerts'} onClick={enableNotifications} disabled={notifyState === 'unsupported' || notifyState === 'denied'}>
            <i className={`bi ${notifyState === 'granted' ? 'bi-bell-fill' : 'bi-bell'}`} />
          </button>
        </div>
      </header>

      <main className="content">
        <DataBanner error={error} lastSuccess={lastSuccess} nextRetryAt={nextRetryAt} onRetry={reload} hasData={!!data} />

        {quote && (
          <div className="daystrip glass">
            <span>Open <b>{inr(quote.open)}</b></span>
            <span>Day high <b className="up">{inr(quote.high)}</b></span>
            <span>Day low <b className="down">{inr(quote.low)}</b></span>
            <span>Prev close <b>{inr(quote.previousClose)}</b></span>
            <span>Volume <b>{quote.volume.toLocaleString('en-IN')}</b></span>
            <span>Last candle <b>{clock(quote.lastCandleTime, false)}</b></span>
            <span className="grow" />
            {data.candleLagSec > 90 && <span className="chip warn" title="The provider's candle series is behind its live quote. The chart can only show candles the provider has published."><i className="bi bi-hourglass-split" /> Candle feed is {Math.round(data.candleLagSec / 60)} min behind the live price (provider delay)</span>}
            <span className="fine">Data as of {clock(quote.time)} IST · polling, not tick-by-tick</span>
          </div>
        )}

        {noData && status === 'loading' && !error && <div className="loading-card glass"><div className="spinner-border text-primary" role="status" /> Loading live candles for <b>{symbol}</b>…</div>}

        <LiveChart
          feed={feed} levels={analysis?.levels} trade={trade} markers={markers} tradeHits={hits}
          interval={interval} onIntervalChange={setIntervalTf} stale={stale} loading={status === 'loading' && !feed} symbol={data?.symbol || symbol}
        />

        {noData ? (
          <div className="glass panel empty"><i className="bi bi-cloud-slash" /><p>Analysis panels appear once live data loads. No prices are ever estimated or invented.</p></div>
        ) : (
          <>
            <div className="row g-3">
              <div className="col-12 col-xl-4"><IndicatorPanel rows={analysis.indicators.rows} /></div>
              <div className="col-12 col-md-6 col-xl-4"><SupportResistance levels={analysis.levels} price={analysis.price} /></div>
              <div className="col-12 col-md-6 col-xl-4"><VolumePanel volume={analysis.volume} /></div>
            </div>

            <div className="row g-3">
              <div className="col-12 col-xl-4"><TradeSetup setup={analysis.setup} /></div>
              <div className="col-12 col-md-6 col-xl-4"><SignalPanel signal={analysis.signal} /></div>
              <div className="col-12 col-md-6 col-xl-4">
                <StopLossPanel result={slResult && trade ? slResult : null} loading={slLoading} error={slError} direction={direction} onDirection={setDirection} onAnalyze={analyzeStopLoss} onClear={() => setSlResult(null)} disabled={stale} />
              </div>
            </div>

            <ScenarioPanel prediction={analysis.prediction} />
            <CandleStructurePanel analysis={analysis} />

            <div className="row g-3">
              <div className="col-12 col-xl-4"><BacktestPanel backtest={analysis.backtest} /></div>
              <div className="col-12 col-xl-8"><TradeHistory history={analysis.signalHistory} alerts={alerts} /></div>
            </div>
          </>
        )}

        <footer className="disclaimer">
          <i className="bi bi-shield-exclamation" />
          <p>
            <b>Not financial advice.</b> Probabilities and levels are technical-analysis estimates from past price action, for personal study only. Markets can move against any setup, and this app never places trades. Live quote/chart: {data?.chartSource || 'Upstox'}; analysis and historical context: {data?.analysisSource || 'Yahoo Finance'}
            {data ? `, ${data.interval} candles, fetched ${clock(data.fetchedAt)} IST` : ''}. Quotes may be delayed or incomplete.
          </p>
        </footer>
      </main>
      <AlertToasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
