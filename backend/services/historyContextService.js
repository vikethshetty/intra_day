import { IST_OFFSET } from '../utils/indicators.js';
import { buildContext } from './technicalAnalysisService.js';

const MIN_HISTORY_DAYS = 25;
const MIN_DAILY_CANDLES = 20;
const DAY_SECONDS = 86400;

export function aggregateDailyCandles(candles = []) {
  const byDay = new Map();
  for (const candle of candles) {
    const day = Math.floor((candle.time + IST_OFFSET) / DAY_SECONDS);
    const row = byDay.get(day);
    if (!row) byDay.set(day, { ...candle });
    else {
      row.high = Math.max(row.high, candle.high);
      row.low = Math.min(row.low, candle.low);
      row.close = candle.close;
      row.volume += candle.volume;
    }
  }
  return [...byDay.values()].sort((a, b) => a.time - b.time);
}

/** Derive month-scale direction from at least 25 calendar days of daily candles. */
export function getHistoryContext(dailyCandles = []) {
  const daily = dailyCandles.slice().sort((a, b) => a.time - b.time);
  if (daily.length < MIN_DAILY_CANDLES) return { available: false, trend: 'UNKNOWN', candleCount: daily.length, spanDays: 0 };
  const last = daily[daily.length - 1];
  const recent = daily.filter((c) => c.time >= last.time - 35 * DAY_SECONDS);
  const spanDays = Math.floor((last.time - recent[0].time) / DAY_SECONDS);
  if (recent.length < MIN_DAILY_CANDLES || spanDays < MIN_HISTORY_DAYS) {
    return { available: false, trend: 'UNKNOWN', candleCount: recent.length, spanDays };
  }

  const ctx = buildContext(daily, '1D');
  const i = ctx.candles.length - 1;
  const close = ctx.candles[i].close;
  const ema20 = ctx.series.ema20[i];
  const previousEma20 = ctx.series.ema20[Math.max(0, i - 5)];
  let trend = 'SIDEWAYS';
  if (ema20 != null && close > ema20 && (previousEma20 == null || ema20 > previousEma20)) trend = 'BULLISH';
  else if (ema20 != null && close < ema20 && (previousEma20 == null || ema20 < previousEma20)) trend = 'BEARISH';
  return { available: true, trend, candleCount: recent.length, spanDays };
}
