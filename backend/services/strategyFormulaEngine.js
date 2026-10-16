/**
 * Deterministic, causal candidates for the five separately selectable 15m strategies.
 * Candles are completed OHLC bars with Unix-second start timestamps.
 */
import * as ind from '../utils/indicators.js';

export const STRATEGIES = [
  { id: 'opening-range-retest', label: 'A · Opening Range Breakout + Retest' },
  { id: 'trend-pullback', label: 'B · Trend Pullback Continuation' },
  { id: 'vwap-reclaim', label: 'C · VWAP Reclaim + Momentum' },
  { id: 'volatility-expansion', label: 'D · Volatility Expansion Breakout' },
  { id: 'structure-break-retest', label: 'E · Market Structure Break + Retest' },
];

const at = (series, i) => i >= 0 && series[i] != null && Number.isFinite(series[i]) ? series[i] : null;
const nearPct = (price, level, pct) => Number.isFinite(level) && level > 0 && Math.abs(price - level) / level <= pct;

function smaAt(values, i, period) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    if (values[j] == null || !Number.isFinite(values[j])) return null;
    sum += values[j];
  }
  return sum / period;
}

function buildStrategyContext(candles, hourlyCandles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const atr = ind.calculateATR(candles, 14);
  const macd = ind.calculateMACD(closes);
  const hourlyCloses = hourlyCandles.map((c) => c.close);
  const hourlyEma50 = ind.calculateEMA(hourlyCloses, 50);
  const hourlyEma200 = ind.calculateEMA(hourlyCloses, 200);
  const hourlyTrend = hourlyCandles.map((c, i) => {
    const e50 = at(hourlyEma50, i), e200 = at(hourlyEma200, i), prev50 = at(hourlyEma50, i - 1);
    if (e50 == null || e200 == null || prev50 == null) return null;
    if (c.close > e50 && e50 > e200 && e50 > prev50) return 'LONG';
    if (c.close < e50 && e50 < e200 && e50 < prev50) return 'SHORT';
    return null;
  });
  const swings = ind.findSwings(candles, 2, 2);
  const openingRanges = new Map();
  const dayOpens = new Map();
  candles.forEach((c, i) => {
    if (!dayOpens.has(ind.istDayKey(c.time))) dayOpens.set(ind.istDayKey(c.time), c.open);
    if (ind.istMinutes(c.time) === 9 * 60 + 15) openingRanges.set(ind.istDayKey(c.time), { high: c.high, low: c.low, index: i });
  });
  return {
    candles,
    hourlyCandles,
    closes,
    volumes,
    ema20: ind.calculateEMA(closes, 20),
    rsi: ind.calculateRSI(closes, 14),
    macd,
    vwap: ind.calculateVWAP(candles, '15m'),
    atr,
    atrSma20: smaAt(atr, candles.length - 1, 20),
    volSma20: ind.calculateSMA(volumes, 20),
    swings,
    openingRanges,
    dayOpens,
    hourlyEma50,
    hourlyEma200,
    hourlyTrend,
  };
}

function latestCompletedHourlyIndex(hourly, startTime, signalCloseTime, fromIndex) {
  let i = fromIndex;
  while (i + 1 < hourly.length && hourly[i + 1].time + 3600 <= signalCloseTime) i++;
  while (i >= 0 && hourly[i].time + 3600 > signalCloseTime) i--;
  return i;
}

function confidenceMatches(confidence, filter = {}) {
  const mode = filter.mode || 'gt';
  const low = Number(filter.low ?? 70);
  const high = Number(filter.high ?? 100);
  if (mode === 'lt') return confidence < low;
  if (mode === 'between') return confidence >= low && confidence <= high;
  if (mode === 'exact') return confidence === low;
  // Spec requires strictly greater than the selected threshold.
  return confidence > low;
}

function signalFor(strategyId, i, ctx, hourlyIndex, priorSwing) {
  const { candles, hourlyCandles, hourlyTrend, ema20, rsi, macd, vwap, atr, volSma20, openingRanges } = ctx;
  const c = candles[i], p = candles[i - 1], pp = candles[i - 2];
  if (!c || !p || !pp || hourlyIndex < 1) return null;
  const day = ind.istDayKey(c.time);
  const trend = hourlyTrend[hourlyIndex];
  const volumeAverage = at(volSma20, i);
  const relativeVolume = volumeAverage > 0 && c.volume > volumeAverage;
  const vwapNow = at(vwap, i), vwapPrev = at(vwap, i - 1);
  const emaNow = at(ema20, i), emaPrev = at(ema20, i - 1);
  const rsiNow = at(rsi, i);
  const macdNow = at(macd.macd, i), macdSignal = at(macd.signal, i), histNow = at(macd.histogram, i);
  const bullish = c.close > c.open;
  const bearish = c.close < c.open;
  const longMacd = macdNow != null && macdSignal != null && histNow != null && macdNow > macdSignal && histNow > 0;
  const shortMacd = macdNow != null && macdSignal != null && histNow != null && macdNow < macdSignal && histNow < 0;
  const longRsi = rsiNow != null && rsiNow >= 50 && rsiNow <= 70;
  const shortRsi = rsiNow != null && rsiNow >= 30 && rsiNow <= 50;
  const longVwap = vwapNow != null && c.close > vwapNow;
  const shortVwap = vwapNow != null && c.close < vwapNow;
  let direction = null, checks = [], stopAnchor = null;

  const setup = (dir, rows, anchor) => {
    direction = dir;
    checks = rows;
    stopAnchor = anchor;
  };

  if (strategyId === 'opening-range-retest') {
    const range = openingRanges.get(day);
    if (!range || range.index >= i || ind.istMinutes(c.time) < 9 * 60 + 30) return null;
    const longBreak = p.close > range.high;
    const longRetest = nearPct(c.low, range.high, 0.002) && c.close > range.high;
    const shortBreak = p.close < range.low;
    const shortRetest = nearPct(c.high, range.low, 0.002) && c.close < range.low;
    if (trend === 'LONG' && longBreak && longRetest && bullish) {
      setup('LONG', [
        ['Completed hourly trend bullish', true], ['Prior close broke opening range high', longBreak],
        ['Retest held within 0.2% of range high', longRetest], ['Bullish confirmation candle', bullish],
        ['Relative volume above 20-bar average', relativeVolume], ['Price above VWAP', longVwap],
        ['MACD bullish with positive histogram', longMacd], ['RSI in 50–70 band', longRsi],
      ], Math.min(c.low, range.high));
    } else if (trend === 'SHORT' && shortBreak && shortRetest && bearish) {
      setup('SHORT', [
        ['Completed hourly trend bearish', true], ['Prior close broke opening range low', shortBreak],
        ['Retest held within 0.2% of range low', shortRetest], ['Bearish confirmation candle', bearish],
        ['Relative volume above 20-bar average', relativeVolume], ['Price below VWAP', shortVwap],
        ['MACD bearish with negative histogram', shortMacd], ['RSI in 30–50 band', shortRsi],
      ], Math.max(c.high, range.low));
    }
  } else if (strategyId === 'trend-pullback') {
    const longTouch = [emaNow, vwapNow].some((level) => level != null && nearPct(c.low, level, 0.003));
    const shortTouch = [emaNow, vwapNow].some((level) => level != null && nearPct(c.high, level, 0.003));
    const emaRising = emaNow != null && emaPrev != null && emaNow > emaPrev;
    const emaFalling = emaNow != null && emaPrev != null && emaNow < emaPrev;
    const longContinue = c.close > p.high && bullish;
    const shortContinue = c.close < p.low && bearish;
    if (trend === 'LONG' && longTouch && emaRising && longContinue) {
      setup('LONG', [
        ['Completed hourly EMA50/EMA200 trend bullish', true], ['Pullback touched 15m EMA20 or VWAP', longTouch],
        ['15m EMA20 rising', emaRising], ['Bullish close above prior 15m high', longContinue],
        ['Relative volume above 20-bar average', relativeVolume], ['Price above VWAP', longVwap],
        ['MACD bullish with positive histogram', longMacd], ['RSI in 50–70 band', longRsi],
      ], Math.min(c.low, p.low));
    } else if (trend === 'SHORT' && shortTouch && emaFalling && shortContinue) {
      setup('SHORT', [
        ['Completed hourly EMA50/EMA200 trend bearish', true], ['Pullback touched 15m EMA20 or VWAP', shortTouch],
        ['15m EMA20 falling', emaFalling], ['Bearish close below prior 15m low', shortContinue],
        ['Relative volume above 20-bar average', relativeVolume], ['Price below VWAP', shortVwap],
        ['MACD bearish with negative histogram', shortMacd], ['RSI in 30–50 band', shortRsi],
      ], Math.max(c.high, p.high));
    }
  } else if (strategyId === 'vwap-reclaim') {
    const priorIsSameSession = ind.istDayKey(p.time) === day;
    const longReclaim = priorIsSameSession && vwapPrev != null && vwapNow != null && p.close <= vwapPrev && c.close > vwapNow;
    const shortReclaim = priorIsSameSession && vwapPrev != null && vwapNow != null && p.close >= vwapPrev && c.close < vwapNow;
    const dayOpen = ctx.dayOpens.get(day);
    const longOpenContext = dayOpen != null && c.close > dayOpen;
    const shortOpenContext = dayOpen != null && c.close < dayOpen;
    if (trend === 'LONG' && longReclaim) {
      setup('LONG', [
        ['Completed hourly trend bullish', true], ['VWAP reclaimed from below', longReclaim],
        ['Relative volume above 20-bar average', relativeVolume], ['MACD bullish with positive histogram', longMacd],
        ['RSI in 50–70 band', longRsi], ['Bullish directional candle', bullish], ['Close above day open', longOpenContext],
      ], Math.min(c.low, p.low));
    } else if (trend === 'SHORT' && shortReclaim) {
      setup('SHORT', [
        ['Completed hourly trend bearish', true], ['VWAP lost from above', shortReclaim],
        ['Relative volume above 20-bar average', relativeVolume], ['MACD bearish with negative histogram', shortMacd],
        ['RSI in 30–50 band', shortRsi], ['Bearish directional candle', bearish], ['Close below day open', shortOpenContext],
      ], Math.max(c.high, p.high));
    }
  } else if (strategyId === 'volatility-expansion') {
    if (i < 12) return null;
    const window = candles.slice(i - 12, i);
    const windowHigh = Math.max(...window.map((bar) => bar.high));
    const windowLow = Math.min(...window.map((bar) => bar.low));
    const atrAverage = smaAt(atr, i, 20);
    const atrNow = at(atr, i);
    const volumeExpansion = volumeAverage != null && c.volume > volumeAverage;
    const rangeExpansion = atrNow != null && atrAverage != null && atrNow > atrAverage;
    if (trend === 'LONG' && c.close > windowHigh && volumeExpansion && rangeExpansion) {
      setup('LONG', [
        ['Completed hourly trend bullish', true], ['Close broke prior 12-bar high', c.close > windowHigh],
        ['Volume above 20-bar average', volumeExpansion], ['ATR above its 20-bar average', rangeExpansion],
        ['Price above VWAP', longVwap], ['MACD bullish with positive histogram', longMacd], ['Bullish directional candle', bullish],
      ], windowHigh);
    } else if (trend === 'SHORT' && c.close < windowLow && volumeExpansion && rangeExpansion) {
      setup('SHORT', [
        ['Completed hourly trend bearish', true], ['Close broke prior 12-bar low', c.close < windowLow],
        ['Volume above 20-bar average', volumeExpansion], ['ATR above its 20-bar average', rangeExpansion],
        ['Price below VWAP', shortVwap], ['MACD bearish with negative histogram', shortMacd], ['Bearish directional candle', bearish],
      ], windowLow);
    }
  } else if (strategyId === 'structure-break-retest') {
    if (!priorSwing) return null;
    const longBreak = pp.close <= priorSwing.price && p.close > priorSwing.price;
    const longRetest = nearPct(c.low, priorSwing.price, 0.002) && c.close > priorSwing.price;
    const shortBreak = pp.close >= priorSwing.price && p.close < priorSwing.price;
    const shortRetest = nearPct(c.high, priorSwing.price, 0.002) && c.close < priorSwing.price;
    if (trend === 'LONG' && longBreak && longRetest) {
      setup('LONG', [
        ['Completed hourly trend bullish', true], ['Prior close broke confirmed swing high', longBreak],
        ['Retest held within 0.2% of broken level', longRetest], ['Relative volume above 20-bar average', relativeVolume],
        ['Price above VWAP', longVwap], ['MACD bullish with positive histogram', longMacd], ['Bullish directional candle', bullish],
      ], Math.min(c.low, priorSwing.price));
    } else if (trend === 'SHORT' && shortBreak && shortRetest) {
      setup('SHORT', [
        ['Completed hourly trend bearish', true], ['Prior close broke confirmed swing low', shortBreak],
        ['Retest held within 0.2% of broken level', shortRetest], ['Relative volume above 20-bar average', relativeVolume],
        ['Price below VWAP', shortVwap], ['MACD bearish with negative histogram', shortMacd], ['Bearish directional candle', bearish],
      ], Math.max(c.high, priorSwing.price));
    }
  } else {
    throw new Error(`Unknown strategy: ${strategyId}`);
  }

  if (!direction || !stopAnchor) return null;
  const next = candles[i + 1];
  if (!next || ind.istDayKey(next.time) !== day || next.time < c.time + 900) return null;
  const signalMinute = ind.istMinutes(c.time);
  if (signalMinute < 9 * 60 + 30 || signalMinute >= 15 * 60) return null;
  const currentAtr = at(atr, i);
  if (!(currentAtr > 0)) return null;
  const buffer = 0.1 * currentAtr;
  const stop = direction === 'LONG' ? stopAnchor - buffer : stopAnchor + buffer;
  const risk = Math.abs(next.open - stop);
  const riskAtr = risk / currentAtr;
  if (!(risk > 0) || riskAtr < 0.25 || riskAtr > 3) return null;
  const target = next.open + (direction === 'LONG' ? 2 : -2) * risk;
  const confidence = Math.round((checks.filter(([, passed]) => passed).length / checks.length) * 100);
  const hourly = hourlyCandles[hourlyIndex];
  return {
    strategyId, direction, signalTime: c.time, entryTime: next.time, entry: next.open,
    stop, target, risk, atr: currentAtr, riskAtr, confidence,
    passedChecks: checks.filter(([, passed]) => passed).length,
    totalChecks: checks.length,
    checks: checks.map(([label, passed]) => ({ label, passed })),
    hourlyTrendTime: hourly.time,
  };
}

/** Return causal candidates filtered by the requested confidence rule. */
export function generateStrategySignals({ strategyId, candles15m, candles1h, startTime, endTime, confidenceFilter }) {
  if (!STRATEGIES.some((strategy) => strategy.id === strategyId)) throw new Error(`Unknown strategy: ${strategyId}`);
  const candles = candles15m.slice().sort((a, b) => a.time - b.time);
  const hourlyCandles = candles1h.slice().sort((a, b) => a.time - b.time);
  const ctx = buildStrategyContext(candles, hourlyCandles);
  const signals = [];
  let hourCursor = -1;
  let highSwingCursor = 0, lowSwingCursor = 0;
  let latestHigh = null, latestLow = null;
  for (let i = 2; i < candles.length - 1; i++) {
    const candle = candles[i];
    if (candle.time < startTime || candle.time > endTime) continue;
    const minute = ind.istMinutes(candle.time);
    if (minute < 9 * 60 + 30 || minute >= 15 * 60 || candle.time + 900 > Date.now() / 1000) continue;
    const hourIndex = latestCompletedHourlyIndex(hourlyCandles, candle.time, candle.time + 900, hourCursor);
    if (hourIndex < 0) continue;
    hourCursor = hourIndex;
    while (highSwingCursor < ctx.swings.highs.length && ctx.swings.highs[highSwingCursor].confirmedAt <= i - 1) latestHigh = ctx.swings.highs[highSwingCursor++];
    while (lowSwingCursor < ctx.swings.lows.length && ctx.swings.lows[lowSwingCursor].confirmedAt <= i - 1) latestLow = ctx.swings.lows[lowSwingCursor++];
    const priorSwing = strategyId === 'structure-break-retest' ? (ctx.hourlyTrend[hourIndex] === 'SHORT' ? latestLow : latestHigh) : null;
    const candidate = signalFor(strategyId, i, ctx, hourIndex, priorSwing);
    if (!candidate || !confidenceMatches(candidate.confidence, confidenceFilter)) continue;
    if (candidate.signalTime < startTime || candidate.signalTime > endTime) continue;
    signals.push(candidate);
  }
  return signals;
}
