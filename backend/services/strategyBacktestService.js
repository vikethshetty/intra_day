import { getNifty50Universe } from './dailyScannerService.js';
import { getYahooHistoricalRange, getProviderStatus, MarketDataError } from './marketDataService.js';
import { generateStrategySignals, STRATEGIES } from './strategyFormulaEngine.js';
import { IST_OFFSET, istDayKey, istMinutes } from '../utils/indicators.js';

const BATCH_SIZE = 2;
const CONCURRENCY = 2;
const BATCH_CACHE_TTL = 5 * 60 * 1000;
const YAHOO_15M_MAX_DAYS = 60;
const YAHOO_15M_WARMUP_DAYS = 5;
const batchCache = new Map();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

function parseIstDate(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new MarketDataError('BAD_REQUEST', `Choose a valid ${label} date.`, 400);
  const [, y, m, d] = match;
  const utc = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const check = new Date(utc);
  if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() + 1 !== Number(m) || check.getUTCDate() !== Number(d)) {
    throw new MarketDataError('BAD_REQUEST', `Choose a valid ${label} date.`, 400);
  }
  return Math.floor(utc / 1000) - IST_OFFSET;
}

function validateConfidence({ mode, low, high }) {
  const filter = { mode: String(mode || 'gt'), low: Number(low ?? 70), high: Number(high ?? 100) };
  if (!['gt', 'lt', 'between', 'exact'].includes(filter.mode)
    || !Number.isInteger(filter.low) || !Number.isInteger(filter.high)
    || filter.low < 0 || filter.low > 100 || filter.high < 0 || filter.high > 100
    || (filter.mode === 'between' && filter.low > filter.high)) {
    throw new MarketDataError('BAD_REQUEST', 'Choose valid whole-number confidence values from 0 to 100.', 400);
  }
  return filter;
}

function validateRequest(options) {
  const strategyId = String(options.strategyId || '');
  if (!STRATEGIES.some((strategy) => strategy.id === strategyId)) throw new MarketDataError('BAD_REQUEST', 'Choose one of the five supported strategies.', 400);
  const startDate = String(options.startDate || '');
  const endDate = String(options.endDate || '');
  const startTime = parseIstDate(startDate, 'start');
  const endTime = parseIstDate(endDate, 'end') + 86400 - 1;
  if (startTime > endTime) throw new MarketDataError('BAD_REQUEST', 'The start date must be on or before the end date.', 400);
  const todayIst = Math.floor((Date.now() / 1000 + IST_OFFSET) / 86400) * 86400 - IST_OFFSET;
  if (endTime >= todayIst + 86400) throw new MarketDataError('BAD_REQUEST', 'The end date cannot be in the future.', 400);
  if (startTime < todayIst - (YAHOO_15M_MAX_DAYS - YAHOO_15M_WARMUP_DAYS) * 86400) {
    throw new MarketDataError('BAD_REQUEST', 'Yahoo Finance 15-minute history is limited to roughly the latest 60 days. Choose a start date within the latest 55 days.', 400);
  }
  const confidence = validateConfidence({ mode: options.confidenceMode, low: options.confidenceLow, high: options.confidenceHigh });
  const costBpsPerSide = Number(options.costBpsPerSide ?? 0);
  if (!Number.isFinite(costBpsPerSide) || costBpsPerSide < 0 || costBpsPerSide > 1000) {
    throw new MarketDataError('BAD_REQUEST', 'Estimated cost must be between 0 and 1000 basis points per side.', 400);
  }
  return { strategyId, startDate, endDate, startTime, endTime, confidence, costBpsPerSide };
}

function executeCandidates(candles, signals, costBpsPerSide) {
  const indexByTime = new Map(candles.map((candle, index) => [candle.time, index]));
  const trades = [];
  let nextFreeIndex = 0;

  for (const signal of signals) {
    const entryIndex = indexByTime.get(signal.entryTime);
    if (entryIndex == null || entryIndex < nextFreeIndex) continue;
    const day = istDayKey(signal.entryTime);
    let lastInSession = null;
    let exit = null;
    let exitIndex = entryIndex;

    for (let i = entryIndex; i < candles.length; i++) {
      const candle = candles[i];
      if (istDayKey(candle.time) !== day) {
        if (lastInSession) {
          exit = { price: lastInSession.close, time: lastInSession.time + 900, reason: 'square-off (last available bar)' };
          exitIndex = i - 1;
        }
        break;
      }
      lastInSession = candle;
      const long = signal.direction === 'LONG';
      // Conservative same-candle handling: if both levels were touched, stop loss wins.
      if (long ? candle.low <= signal.stop : candle.high >= signal.stop) {
        exit = { price: signal.stop, time: candle.time + 900, reason: 'stop' };
        exitIndex = i;
        break;
      }
      if (long ? candle.high >= signal.target : candle.low <= signal.target) {
        exit = { price: signal.target, time: candle.time + 900, reason: 'target' };
        exitIndex = i;
        break;
      }
      if (istMinutes(candle.time) >= 15 * 60) {
        exit = { price: candle.close, time: candle.time + 900, reason: '15:15 square-off' };
        exitIndex = i;
        break;
      }
    }

    if (!exit) {
      const last = candles[candles.length - 1];
      if (last && istDayKey(last.time) === day && istMinutes(last.time) >= 15 * 60) {
        exit = { price: last.close, time: last.time + 900, reason: '15:15 square-off' };
        exitIndex = candles.length - 1;
      }
    }

    const closed = Boolean(exit);
    const sign = signal.direction === 'LONG' ? 1 : -1;
    const grossPnlPerShare = closed ? sign * (exit.price - signal.entry) : null;
    const costPerShare = closed ? (signal.entry + exit.price) * (costBpsPerSide / 10000) : null;
    const netPnlPerShare = closed ? grossPnlPerShare - costPerShare : null;
    const grossR = closed ? grossPnlPerShare / signal.risk : null;
    const netR = closed ? netPnlPerShare / signal.risk : null;
    trades.push({
      ...signal,
      exit: exit?.price ?? null,
      exitTime: exit?.time ?? null,
      why: exit?.reason ?? 'open at end of selected data',
      closed,
      grossPnlPerShare,
      costPerShare,
      netPnlPerShare,
      grossR,
      netR,
      R: netR,
      costBpsPerSide,
    });
    if (closed) nextFreeIndex = exitIndex + 1;
    else break;
  }
  return trades;
}

async function backtestOne(stock, request) {
  try {
    // Yahoo intraday bars cover roughly 60 days. Reserve up to five days to warm
    // 15m indicators; hourly history gets a longer seed for EMA200.
    const todayIst = Math.floor((Date.now() / 1000 + IST_OFFSET) / 86400) * 86400 - IST_OFFSET;
    const historyStart15m = Math.max(request.startTime - YAHOO_15M_WARMUP_DAYS * 86400, todayIst - (YAHOO_15M_MAX_DAYS - 1) * 86400);
    const historyStart1h = request.startTime - 60 * 86400;
    const historyEnd = request.endTime + 1;
    const [data15m, data1h] = await Promise.all([
      getYahooHistoricalRange(stock.symbol, '15m', historyStart15m, historyEnd),
      getYahooHistoricalRange(stock.symbol, '1H', historyStart1h, historyEnd),
    ]);
    const signals = generateStrategySignals({
      strategyId: request.strategyId,
      candles15m: data15m.candles,
      candles1h: data1h.candles,
      startTime: request.startTime,
      endTime: request.endTime,
      confidenceFilter: request.confidence,
    });
    const trades = executeCandidates(data15m.candles, signals, request.costBpsPerSide);
    return {
      symbol: stock.symbol,
      name: data15m.meta?.name || stock.name || stock.symbol,
      sufficient: data15m.candles.length >= 40 && data1h.candles.length >= 200,
      message: data15m.candles.length < 40 || data1h.candles.length < 200 ? 'Not enough 15-minute/hourly history to initialize strategy indicators.' : null,
      candleCount15m: data15m.candles.length,
      candleCount1h: data1h.candles.length,
      signalsCount: signals.length,
      trades,
    };
  } catch (error) {
    if (['INVALID_SYMBOL', 'NO_DATA'].includes(error.code)) {
      return { symbol: stock.symbol, name: stock.name || stock.symbol, sufficient: false, message: error.message, candleCount15m: 0, candleCount1h: 0, signalsCount: 0, trades: [] };
    }
    throw error;
  }
}

export async function getStrategyBacktestBatch(options = {}) {
  const provider = getProviderStatus('yahoo');
  const request = validateRequest(options);
  let stocks;
  if (options.universe === 'nifty50') stocks = await getNifty50Universe();
  else if (options.universe === 'dailyTop10') {
    const symbols = [...new Set((options.symbols || []).map((symbol) => String(symbol).trim().toUpperCase()))];
    if (!symbols.length || symbols.length > 10 || symbols.some((symbol) => !/^[A-Z0-9&.-]{1,30}$/.test(symbol))) {
      throw new MarketDataError('BAD_REQUEST', 'Run the Daily Top 10 scan first, then use its one to ten symbols for this backtest.', 400);
    }
    stocks = symbols.map((symbol) => ({ symbol, name: symbol }));
  } else throw new MarketDataError('BAD_REQUEST', 'Choose Nifty 50 or Daily Top 10 as the backtest universe.', 400);

  const offset = Math.max(0, Math.min(Number.parseInt(options.offset, 10) || 0, stocks.length));
  const batchKey = `${request.strategyId}|${options.universe}|${stocks.map((stock) => stock.symbol).join(',')}|${request.startDate}|${request.endDate}|${request.confidence.mode}|${request.confidence.low}|${request.confidence.high}|${request.costBpsPerSide}|${offset}`;
  const cached = batchCache.get(batchKey);
  if (cached && Date.now() - cached.createdAt < BATCH_CACHE_TTL) return { ...cached.data, cached: true };

  const batch = stocks.slice(offset, offset + BATCH_SIZE);
  const results = await mapLimit(batch, CONCURRENCY, (stock) => backtestOne(stock, request));
  const nextOffset = offset + batch.length;
  const data = {
    ok: true,
    provider: provider.label,
    strategyId: request.strategyId,
    strategy: STRATEGIES.find((strategy) => strategy.id === request.strategyId).label,
    universe: options.universe,
    universeLabel: options.universe === 'nifty50' ? 'Nifty 50' : 'Current Daily Top 10',
    universeCount: stocks.length,
    interval: '15m entry / completed 1h trend',
    startDate: request.startDate,
    endDate: request.endDate,
    startTime: request.startTime,
    endTime: request.endTime,
    confidence: request.confidence,
    costBpsPerSide: request.costBpsPerSide,
    offset,
    nextOffset,
    processedCount: batch.length,
    skippedCount: results.filter((result) => !result.sufficient).length,
    results,
    done: nextOffset >= stocks.length,
    generatedAt: Date.now(),
  };
  batchCache.set(batchKey, { createdAt: Date.now(), data });
  if (batchCache.size > 100) batchCache.delete(batchCache.keys().next().value);
  return { ...data, cached: false };
}
