import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, CrosshairMode, LineStyle, createChart } from 'lightweight-charts';

/** Chart times are shifted by +5:30 so the axis reads in Indian Standard Time. */
const OFFSET = 19800;
export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1H', '1D'];

const C = {
  up: '#0E9F6E', down: '#E0393E', blue: '#2B59E3', violet: '#7C5CF0', orange: '#E58A0B', ink: '#0E1A2B',
  muted: '#5B6B82', grid: 'rgba(30,60,120,0.07)', border: 'rgba(30,60,120,0.14)',
};

const OVERLAYS = {
  ema9: { color: '#F59E0B', width: 1, label: 'EMA 9' },
  ema20: { color: C.blue, width: 1, label: 'EMA 20' },
  ema50: { color: C.violet, width: 1, label: 'EMA 50' },
  ema200: { color: '#0E1A2B', width: 2, label: 'EMA 200' },
  sma20: { color: '#06B6D4', width: 1, style: LineStyle.Dotted, label: 'SMA 20' },
  sma50: { color: '#EC4899', width: 1, style: LineStyle.Dotted, label: 'SMA 50' },
  vwap: { color: '#0891B2', width: 2, label: 'VWAP' },
  bbUpper: { color: '#94A3B8', width: 1, style: LineStyle.Dashed, label: 'BB upper' },
  bbMiddle: { color: 'rgba(148,163,184,0.7)', width: 1, label: 'BB mid' },
  bbLower: { color: '#94A3B8', width: 1, style: LineStyle.Dashed, label: 'BB lower' },
};
const VISIBLE_BY = (t) => ({
  ema9: t.ema9, ema20: t.ema20, ema50: t.ema50, ema200: t.ema200, sma20: t.sma, sma50: t.sma, vwap: t.vwap,
  bbUpper: t.bb, bbMiddle: t.bb, bbLower: t.bb,
});

/** Build a point for every candle time (whitespace where the indicator has no value) so sub-chart indices stay aligned. */
function align(candles, pts) {
  const m = new Map();
  for (const p of pts || []) m.set(p.time, p.value);
  return candles.map((c) => (m.get(c.time) != null ? { time: c.time + OFFSET, value: m.get(c.time) } : { time: c.time + OFFSET }));
}
const volColor = (c) => (c.close >= c.open ? 'rgba(14,159,110,0.38)' : 'rgba(224,57,62,0.38)');
const histColor = (v) => (v >= 0 ? 'rgba(14,159,110,0.65)' : 'rgba(224,57,62,0.65)');
const fmtTime = (shifted, daily) => {
  const d = new Date(shifted * 1000);
  const dd = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  if (daily) return dd;
  return `${dd} ${d.toISOString().slice(11, 16)}`;
};
const fmtVol = (v) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));

export default function LiveChart({ feed, levels, trade, markers, tradeHits, interval, onIntervalChange, stale, loading, symbol, timeframes = TIMEFRAMES, fitAll = false, initialToggles = {} }) {
  const mainEl = useRef(null);
  const rsiEl = useRef(null);
  const macdEl = useRef(null);
  const api = useRef({});
  const tradeRef = useRef(null); // read by the chart's autoscale so ENTRY/STOP/TARGET lines are always inside the visible price range
  const [tog, setTog] = useState({ volume: true, vwap: true, ema9: true, ema20: true, ema50: true, ema200: false, sma: false, bb: false, sr: true, markers: true, rsi: true, macd: true, ...initialToggles });
  const [legend, setLegend] = useState(null);
  const daily = interval === '1D';
  const flip = (k) => setTog((t) => ({ ...t, [k]: !t[k] }));

  /* ---------- create charts once ---------- */
  useEffect(() => {
    const make = (el, height, extra = {}) => createChart(el, {
      width: el.clientWidth, height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: C.muted, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 12 },
      localization: { locale: 'en-IN' }, // explicit locale: never depend on the browser's language tag
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: 'rgba(43,89,227,0.45)', labelBackgroundColor: C.blue }, horzLine: { color: 'rgba(43,89,227,0.45)', labelBackgroundColor: C.blue } },
      ...extra,
    });
    const isNarrow = window.innerWidth < 768;
    const main = make(mainEl.current, isNarrow ? 360 : 520);
    const rsiChart = make(rsiEl.current, 120);
    const macdChart = make(macdEl.current, 130);

    const candle = main.addCandlestickSeries({
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
      autoscaleInfoProvider: (orig) => {
        const r = orig();
        const t = tradeRef.current;
        if (!r || !t) return r;
        const v = [t.entry, t.stopLoss, t.target1, t.target2];
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...v), maxValue: Math.max(r.priceRange.maxValue, ...v) } };
      },
    });
    main.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
    const volume = main.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const lines = {};
    Object.entries(OVERLAYS).forEach(([k, o]) => {
      lines[k] = main.addLineSeries({ color: o.color, lineWidth: o.width, lineStyle: o.style ?? LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    });

    const rsi = rsiChart.addLineSeries({ color: C.violet, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    [[70, C.down], [50, 'rgba(91,107,130,0.5)'], [30, C.up]].forEach(([price, color]) => rsi.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false }));
    const macdHist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'price', precision: 3, minMove: 0.001 } });
    const macdLine = macdChart.addLineSeries({ color: C.blue, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const macdSig = macdChart.addLineSeries({ color: C.orange, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    // keep the three time axes in lock-step
    const charts = [main, rsiChart, macdChart];
    let busy = false;
    charts.forEach((src) => src.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (busy || !r) return;
      busy = true;
      charts.forEach((dst) => { if (dst !== src) dst.timeScale().setVisibleLogicalRange(r); });
      busy = false;
    }));

    main.subscribeCrosshairMove((p) => {
      if (!p.time || !p.point) { setLegend(null); return; }
      const c = p.seriesData.get(candle);
      if (!c) { setLegend(null); return; }
      const v = p.seriesData.get(volume);
      setLegend({ time: p.time, ...c, volume: v?.value ?? null });
    });

    const ro = new ResizeObserver(() => {
      charts.forEach((ch, i) => ch.applyOptions({ width: [mainEl, rsiEl, macdEl][i].current.clientWidth }));
    });
    ro.observe(mainEl.current);

    api.current = { main, rsiChart, macdChart, candle, volume, lines, rsi, macdHist, macdLine, macdSig, key: null, lastT: 0, sr: [], tl: [] };
    return () => { ro.disconnect(); charts.forEach((c) => c.remove()); api.current = {}; };
  }, []);

  /* ---------- data: full load or incremental last-candle update ---------- */
  useEffect(() => {
    const a = api.current;
    if (!feed || !a.candle) return;
    const { candles, series } = feed;
    const full = feed.key !== a.key || feed.full;
    const subs = (cs) => ({
      rsi: align(cs, series.rsi),
      hist: align(cs, series.macdHist).map((p) => (p.value != null ? { ...p, color: histColor(p.value) } : p)),
      macd: align(cs, series.macd),
      sig: align(cs, series.macdSignal),
    });
    if (full) {
      a.candle.setData(candles.map((c) => ({ time: c.time + OFFSET, open: c.open, high: c.high, low: c.low, close: c.close })));
      a.volume.setData(candles.map((c) => ({ time: c.time + OFFSET, value: c.volume, color: volColor(c) })));
      Object.keys(OVERLAYS).forEach((k) => a.lines[k].setData(align(candles, series[k])));
      const s = subs(candles);
      a.rsi.setData(s.rsi); a.macdHist.setData(s.hist); a.macdLine.setData(s.macd); a.macdSig.setData(s.sig);
      a.key = feed.key;
      a.lastT = candles[candles.length - 1].time + OFFSET;
      const n = candles.length;
      a.main.timeScale().setVisibleLogicalRange({ from: fitAll ? 0 : Math.max(0, n - 130), to: n + 6 });
      a.main.timeScale().applyOptions({ timeVisible: interval !== '1D' });
      a.rsiChart.timeScale().applyOptions({ timeVisible: interval !== '1D' });
      a.macdChart.timeScale().applyOptions({ timeVisible: interval !== '1D' });
      return;
    }
    // incremental: only the last few candles are touched
    const tail = candles.slice(-8);
    const tailPts = (key) => align(tail, series[key].slice(-12));
    const lastPts = {};
    const keys = [...Object.keys(OVERLAYS), 'rsi', 'macd', 'macdSignal', 'macdHist'];
    keys.forEach((k) => { lastPts[k] = tailPts(k); });
    tail.forEach((c, idx) => {
      const t = c.time + OFFSET;
      if (t < a.lastT) return;
      a.candle.update({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
      a.volume.update({ time: t, value: c.volume, color: volColor(c) });
      Object.keys(OVERLAYS).forEach((k) => a.lines[k].update(lastPts[k][idx]));
      a.rsi.update(lastPts.rsi[idx]);
      a.macdLine.update(lastPts.macd[idx]);
      a.macdSig.update(lastPts.macdSignal[idx]);
      const h = lastPts.macdHist[idx];
      a.macdHist.update(h.value != null ? { ...h, color: histColor(h.value) } : h);
      a.lastT = t;
    });
  }, [feed, interval]);

  /* ---------- toggles ---------- */
  useEffect(() => {
    const a = api.current;
    if (!a.candle) return;
    const forced = !!trade; // trade analysis always shows VWAP and S/R
    const vis = VISIBLE_BY(tog);
    Object.keys(OVERLAYS).forEach((k) => a.lines[k].applyOptions({ visible: k === 'vwap' ? tog.vwap || forced : !!vis[k] }));
    a.volume.applyOptions({ visible: tog.volume });
    rsiEl.current.parentElement.style.display = tog.rsi ? '' : 'none';
    macdEl.current.parentElement.style.display = tog.macd ? '' : 'none';
    if (tog.rsi) a.rsiChart.resize(rsiEl.current.clientWidth, 120);
    if (tog.macd) a.macdChart.resize(macdEl.current.clientWidth, 130);
  }, [tog, trade]);

  /* ---------- support / resistance lines ---------- */
  useEffect(() => {
    const a = api.current;
    if (!a.candle) return;
    a.sr.forEach((l) => a.candle.removePriceLine(l));
    a.sr = [];
    if (!levels || !(tog.sr || trade)) return;
    levels.resistance.forEach((l) => a.sr.push(a.candle.createPriceLine({ price: l.price, color: 'rgba(224,57,62,0.75)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.name })));
    levels.support.forEach((l) => a.sr.push(a.candle.createPriceLine({ price: l.price, color: 'rgba(14,159,110,0.8)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.name })));
  }, [levels, tog.sr, trade]);

  /* ---------- trade levels: ENTRY / STOP LOSS / TARGETS ---------- */
  useEffect(() => {
    const a = api.current;
    if (!a.candle) return;
    a.tl.forEach((l) => a.candle.removePriceLine(l));
    a.tl = [];
    tradeRef.current = trade || null;
    a.main.priceScale('right').applyOptions({ autoScale: true }); // re-fit so every trade level is visible
    if (!trade) return;
    const add = (price, color, title, style, width) => a.tl.push(a.candle.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
    add(trade.entry, C.blue, 'ENTRY', LineStyle.Solid, 2);
    add(trade.target1, C.up, 'TARGET 1', LineStyle.LargeDashed, 2);
    add(trade.target2, C.up, 'TARGET 2', LineStyle.LargeDashed, 2);
    add(trade.stopLoss, C.down, 'STOP LOSS', LineStyle.Solid, 2);
  }, [trade]);

  /* ---------- markers (signals, divergence, planned entry, hits) ---------- */
  const markerList = useMemo(() => {
    if (!tog.markers) return [];
    const out = [];
    (markers || []).forEach((m) => {
      if (m.kind === 'BUY') out.push({ time: m.time + OFFSET, position: 'belowBar', color: C.up, shape: 'arrowUp', text: m.text });
      else if (m.kind === 'SELL') out.push({ time: m.time + OFFSET, position: 'aboveBar', color: C.down, shape: 'arrowDown', text: m.text });
      else if (m.kind === 'DIV_BULL') out.push({ time: m.time + OFFSET, position: 'belowBar', color: C.violet, shape: 'circle', text: m.text });
      else if (m.kind === 'DIV_BEAR') out.push({ time: m.time + OFFSET, position: 'aboveBar', color: C.violet, shape: 'circle', text: m.text });
      else if (m.kind === 'ENTRY') out.push({ time: m.time + OFFSET, position: 'inBar', color: C.blue, shape: 'circle', text: m.text });
      else if (m.kind === 'STOP') out.push({ time: m.time + OFFSET, position: m.below ? 'belowBar' : 'aboveBar', color: C.down, shape: 'square', text: m.text });
      else if (m.kind === 'T1' || m.kind === 'T2') out.push({ time: m.time + OFFSET, position: m.below ? 'belowBar' : 'aboveBar', color: C.up, shape: 'square', text: m.text });
    });
    return out.sort((x, y) => x.time - y.time);
  }, [markers, tog.markers, tradeHits]);
  useEffect(() => { api.current.candle?.setMarkers(markerList); }, [markerList, feed?.key]);

  const last = feed?.candles?.[feed.candles.length - 1];
  const shown = legend || (last ? { time: last.time + OFFSET, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume } : null);
  const chg = shown ? ((shown.close - shown.open) / shown.open) * 100 : 0;

  const Toggle = ({ k, label, dot }) => (
    <button type="button" className={`tg ${tog[k] ? 'on' : ''}`} onClick={() => flip(k)} aria-pressed={tog[k]}>
      {dot && <span className="tg-dot" style={{ background: dot }} />}{label}
    </button>
  );

  return (
    <section className="glass chart-card" aria-label={`${symbol} candlestick chart`}>
      <div className="chart-controls">
        <div className="seg" role="group" aria-label="Timeframe">
          {timeframes.map((tf) => (
            <button key={tf} type="button" className={interval === tf ? 'on' : ''} onClick={() => onIntervalChange(tf)}>{tf}</button>
          ))}
        </div>
        <div className="tg-row" role="group" aria-label="Chart layers">
          <Toggle k="volume" label="Volume" />
          <Toggle k="vwap" label="VWAP" dot="#0891B2" />
          <Toggle k="ema9" label="EMA 9" dot="#F59E0B" />
          <Toggle k="ema20" label="20" dot={C.blue} />
          <Toggle k="ema50" label="50" dot={C.violet} />
          <Toggle k="ema200" label="200" dot="#0E1A2B" />
          <Toggle k="sma" label="SMA" dot="#06B6D4" />
          <Toggle k="bb" label="Bollinger" dot="#94A3B8" />
          <Toggle k="sr" label="S/R" />
          <Toggle k="markers" label="Signals" />
          <Toggle k="rsi" label="RSI" />
          <Toggle k="macd" label="MACD" />
        </div>
        <div className="chart-tools">
          {stale && <span className="chip warn"><i className="bi bi-wifi-off" /> stale</span>}
          <button type="button" className="icon-btn" title="Reset zoom to latest candles" onClick={() => {
            const a = api.current; const n = feed?.candles?.length || 0;
            if (a.main && n) a.main.timeScale().setVisibleLogicalRange({ from: fitAll ? 0 : Math.max(0, n - 130), to: n + 6 });
          }}><i className="bi bi-arrows-angle-contract" /></button>
        </div>
      </div>

      <div className="chart-wrap">
        {shown && (
          <div className="legend" aria-live="off">
            <span className="lg-time">{fmtTime(shown.time, daily)}</span>
            <span>O <b>{shown.open.toFixed(2)}</b></span>
            <span>H <b>{shown.high.toFixed(2)}</b></span>
            <span>L <b>{shown.low.toFixed(2)}</b></span>
            <span>C <b className={chg >= 0 ? 'up' : 'down'}>{shown.close.toFixed(2)}</b></span>
            <span className={chg >= 0 ? 'up' : 'down'}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
            {shown.volume != null && <span>Vol <b>{fmtVol(shown.volume)}</b></span>}
          </div>
        )}
        {loading && <div className="chart-overlay"><div className="spinner-border spinner-border-sm text-primary" role="status" /> Loading candles…</div>}
        <div ref={mainEl} className="chart-main" />
      </div>
      <div className="sub-chart"><span className="sub-label">RSI 14</span><div ref={rsiEl} /></div>
      <div className="sub-chart"><span className="sub-label">MACD 12·26·9</span><div ref={macdEl} /></div>
    </section>
  );
}
