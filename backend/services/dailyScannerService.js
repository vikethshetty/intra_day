import axios from 'axios';
import { buildContext, buildSnapshot } from './technicalAnalysisService.js';
import { buildTradeSetup, calculateEntryScore, computeSignalTimeline, runBacktest } from './signalEngine.js';
import { getCandles, getProviderStatus, MarketDataError } from './marketDataService.js';
import { aggregateDailyCandles, getHistoryContext } from './historyContextService.js';

const NSE_EQUITY_LIST_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
const NSE_SME_LIST_URL = 'https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv';
const NIFTY50_CONSTITUENTS_URL = 'https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv';
const NIFTY50_REFERER = 'https://www.niftyindices.com/indices/equity/broad-based-indices';
const INTERVAL = '5m';
const UNIVERSE_TTL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 12;
const CONCURRENCY = 4;
const BACKTEST_BATCH_SIZE = 5;
const BACKTEST_CONCURRENCY = 2;
const BACKTEST_MIN_CONFIDENCE = 70;
let universeCache = null;
let nifty50UniverseCache = null;
const batchCache = new Map();
const backtestBatchCache = new Map();

function istDateKey(now = Date.now()) {
  return new Date(now + 19800 * 1000).toISOString().slice(0, 10);
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else field += char;
  }
  fields.push(field.trim());
  return fields;
}

async function downloadCsv(url, referer = 'https://www.nseindia.com/') {
  const { data } = await axios.get(url, {
    responseType: 'text',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LiveIntradayAnalyzer/1.0)',
      Accept: 'text/csv,*/*',
      Referer: referer,
    },
    timeout: 12000,
  });
  return String(data).replace(/^\uFEFF/, '');
}

function parseNifty50Csv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.toUpperCase().replace(/\s+/g, ' '));
  const symbolIndex = headers.findIndex((header) => header === 'SYMBOL');
  const nameIndex = headers.findIndex((header) => header === 'COMPANY NAME' || header === 'NAME OF COMPANY');
  if (symbolIndex < 0) throw new Error('The NIFTY 50 constituent list format was not recognized.');
  return lines.slice(1).map(parseCsvLine).map((row) => ({
    symbol: (row[symbolIndex] || '').trim().toUpperCase(),
    name: (row[nameIndex] || row[symbolIndex] || '').trim(),
    series: 'EQ',
  })).filter((item) => /^[A-Z0-9&.-]+$/.test(item.symbol));
}

function parseNseCsv(text, allowedSeries) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.toUpperCase().replace(/\s+/g, ' '));
  const symbolIndex = headers.findIndex((h) => h === 'SYMBOL');
  const nameIndex = headers.findIndex((h) => h.includes('NAME OF COMPANY'));
  const seriesIndex = headers.findIndex((h) => h === 'SERIES');
  if (symbolIndex < 0 || seriesIndex < 0) throw new Error('An NSE equity list format was not recognized.');
  return lines.slice(1).map(parseCsvLine).map((row) => ({
    symbol: (row[symbolIndex] || '').trim().toUpperCase(),
    name: (row[nameIndex] || row[symbolIndex] || '').trim(),
    series: (row[seriesIndex] || '').trim().toUpperCase(),
  })).filter((item) => /^[A-Z0-9&.-]+$/.test(item.symbol) && allowedSeries.has(item.series));
}

async function getNseUniverse() {
  if (universeCache && Date.now() - universeCache.loadedAt < UNIVERSE_TTL_MS) return universeCache.stocks;
  try {
    const [mainboardCsv, smeCsv] = await Promise.all([downloadCsv(NSE_EQUITY_LIST_URL), downloadCsv(NSE_SME_LIST_URL)]);
    const stocks = [
      ...parseNseCsv(mainboardCsv, new Set(['EQ', 'BE', 'BZ'])),
      ...parseNseCsv(smeCsv, new Set(['SM', 'ST'])),
    ];
    const unique = [...new Map(stocks.map((stock) => [stock.symbol, stock])).values()]
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (!unique.length) throw new Error('No active NSE equity symbols were found in the downloaded list.');
    universeCache = { loadedAt: Date.now(), stocks: unique };
    return unique;
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    throw new MarketDataError('UNIVERSE_UNAVAILABLE', `Could not load the current NSE equity list. ${error.message || 'Try again shortly.'}`, 503);
  }
}

async function getNifty50Universe() {
  if (nifty50UniverseCache && Date.now() - nifty50UniverseCache.loadedAt < UNIVERSE_TTL_MS) return nifty50UniverseCache.stocks;
  try {
    const stocks = parseNifty50Csv(await downloadCsv(NIFTY50_CONSTITUENTS_URL, NIFTY50_REFERER));
    if (stocks.length !== 50) throw new Error(`Expected 50 constituents but received ${stocks.length}.`);
    nifty50UniverseCache = { loadedAt: Date.now(), stocks };
    return stocks;
  } catch (error) {
    throw new MarketDataError('UNIVERSE_UNAVAILABLE', `Could not load the official NIFTY 50 constituent list. ${error.message || 'Try again shortly.'}`, 503);
  }
}

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

async function rankOne(stock) {
  try {
    // NSE's current equity list is the universe; pin Yahoo lookup to NSE so an
    // unknown .NS symbol is not silently reinterpreted as a BSE listing.
    const data = await getCandles(`${stock.symbol}.NS`, INTERVAL, 'yahoo');
    if (data.meta.instrumentType && !['EQUITY', 'STOCK'].includes(String(data.meta.instrumentType).toUpperCase())) {
      return { symbol: stock.symbol, skipped: true, reason: 'Yahoo identifies this NSE listing as a non-stock instrument.' };
    }
    if (data.candles.length < 60) return { symbol: stock.symbol, skipped: true, reason: 'Not enough 5-minute candles to calculate indicators.' };
    const historyContext = getHistoryContext(aggregateDailyCandles(data.candles));
    if (!historyContext.available) return { symbol: stock.symbol, skipped: true, reason: 'Not enough 1-month candle history for a reliable confidence score.' };
    const ctx = buildContext(data.candles, INTERVAL);
    const i = ctx.candles.length - 1;
    const snap = buildSnapshot(ctx, i);
    const scoring = calculateEntryScore(snap);
    const setup = buildTradeSetup(ctx, i, snap, scoring, scoring.signal, null, null, historyContext);
    return {
      symbol: stock.symbol,
      name: data.meta.name || stock.name,
      exchange: 'NSE',
      price: snap.price,
      asOf: snap.time,
      interval: INTERVAL,
      direction: scoring.direction,
      signal: scoring.signal,
      confidence: setup.confidence,
      signalStrength: setup.signalStrength,
      confirmations: setup.met,
      historyContext,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      target1: setup.target1,
      target2: setup.target2,
      status: setup.status,
      warnings: scoring.warnings.slice(0, 2),
      source: data.source,
    };
  } catch (error) {
    if (error.code === 'INVALID_SYMBOL' || error.code === 'NO_DATA') {
      return { symbol: stock.symbol, skipped: true, reason: error.message || 'No provider data is available for this symbol.' };
    }
    // A timeout, provider outage, or rate limit must pause the scan instead of
    // silently turning a market-wide ranking into a partial one.
    throw error;
  }
}

function compareCandidates(a, b) {
  return b.confidence - a.confidence || b.signalStrength - a.signalStrength || b.confirmations - a.confirmations;
}

/** Process one small page of the full NSE universe so each Vercel invocation stays bounded. */
async function getTop10Batch(rawOffset = 0, scope = 'nse') {
  const provider = getProviderStatus('yahoo');
  if (!provider.configured) throw new MarketDataError('PROVIDER_NOT_CONFIGURED', provider.message, 503);
  const nifty50 = scope === 'nifty50';
  const stocks = nifty50 ? await getNifty50Universe() : await getNseUniverse();
  const offset = Math.max(0, Math.min(Number.parseInt(rawOffset, 10) || 0, stocks.length));
  const date = istDateKey();
  const cacheKey = `${provider.id}:${scope}:${date}:${offset}`;
  const hit = batchCache.get(cacheKey);
  if (hit && Date.now() - hit.createdAt < 5 * 60 * 1000) return { ...hit.data, cached: true };

  const batch = stocks.slice(offset, offset + BATCH_SIZE);
  const ranked = await mapLimit(batch, CONCURRENCY, rankOne);
  const valid = ranked.filter((item) => !item.skipped).sort(compareCandidates);
  const skipped = ranked.filter((item) => item.skipped);
  const nextOffset = offset + batch.length;
  const data = {
    ok: true,
    date,
    interval: INTERVAL,
    providerId: provider.id,
    provider: provider.label,
    exchange: 'NSE',
    universeLabel: nifty50 ? 'NIFTY 50 constituents' : 'NSE mainboard and SME equity shares',
    universeCount: stocks.length,
    offset,
    nextOffset,
    processedCount: batch.length,
    scannedCount: valid.length,
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 5).map(({ symbol, reason }) => ({ symbol, reason })),
    results: valid.slice(0, 10),
    done: nextOffset >= stocks.length,
    generatedAt: Date.now(),
  };
  batchCache.set(cacheKey, { createdAt: Date.now(), data });
  if (batchCache.size > 40) batchCache.delete(batchCache.keys().next().value);
  return { ...data, cached: false };
}

export const getDailyTop10Batch = (rawOffset = 0) => getTop10Batch(rawOffset, 'nse');
export const getNifty50Top10Batch = (rawOffset = 0) => getTop10Batch(rawOffset, 'nifty50');

async function backtestOne(stock, startTime, endTime) {
  try {
    const data = await getCandles(`${stock.symbol}.NS`, '1H', 'yahoo');
    const ctx = buildContext(data.candles, '1H');
    ctx.symbol = stock.symbol;
    const cacheKey = `scanner-backtest|${stock.symbol}|${data.providerId}|1H`;
    const timeline = computeSignalTimeline(ctx, cacheKey);
    const result = runBacktest(ctx, timeline, cacheKey, {
      startTime,
      endTime,
      minConfidence: BACKTEST_MIN_CONFIDENCE,
      includeTrades: true,
      useHistoryConfidence: true,
    });
    return {
      symbol: stock.symbol,
      name: data.meta.name || stock.name,
      sufficient: result.sufficient,
      message: result.message,
      trades: result.trades || [],
    };
  } catch (error) {
    if (error.code === 'INVALID_SYMBOL' || error.code === 'NO_DATA') {
      return { symbol: stock.symbol, name: stock.name, sufficient: false, message: error.message || 'No Yahoo historical data is available.', trades: [] };
    }
    throw error;
  }
}

/** Return a small page of historical simulations to keep each Vercel request bounded. */
async function getScannerBacktestBatch({ scope, symbols: requestedSymbols = [], offset: rawOffset = 0, periodDays: rawPeriodDays = 7, endTime: rawEndTime = null } = {}) {
  const provider = getProviderStatus('yahoo');
  if (!provider.configured) throw new MarketDataError('PROVIDER_NOT_CONFIGURED', provider.message, 503);
  const periodDays = Number(rawPeriodDays);
  if (![7, 14, 21, 30, 60].includes(periodDays)) throw new MarketDataError('BAD_REQUEST', 'periodDays must be 7, 14, 21, 30 or 60.', 400);
  const endTime = Number.isFinite(Number(rawEndTime)) && Number(rawEndTime) > 0 ? Math.floor(Number(rawEndTime)) : Math.floor(Date.now() / 1000);
  const startTime = endTime - periodDays * 86400;
  let stocks;
  if (scope === 'nifty50') stocks = await getNifty50Universe();
  else if (scope === 'dailyTop10') {
    const symbols = [...new Set(requestedSymbols.map((symbol) => String(symbol).trim().toUpperCase()))];
    if (!symbols.length || symbols.length > 10 || symbols.some((symbol) => !/^[A-Z0-9&.-]{1,30}$/.test(symbol))) {
      throw new MarketDataError('BAD_REQUEST', 'Provide between 1 and 10 valid NSE symbols from the Daily Top 10 list.', 400);
    }
    stocks = symbols.map((symbol) => ({ symbol, name: symbol }));
  } else throw new MarketDataError('BAD_REQUEST', 'Unknown backtest universe.', 400);
  const offset = Math.max(0, Math.min(Number.parseInt(rawOffset, 10) || 0, stocks.length));
  const cacheKey = `${provider.id}:${scope}:${stocks.map((stock) => stock.symbol).join(',')}:${periodDays}:${endTime}:${offset}`;
  const cached = backtestBatchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) return { ...cached.data, cached: true };

  const batch = stocks.slice(offset, offset + BACKTEST_BATCH_SIZE);
  const results = await mapLimit(batch, BACKTEST_CONCURRENCY, (stock) => backtestOne(stock, startTime, endTime));
  const nextOffset = offset + batch.length;
  const data = {
    ok: true,
    providerId: provider.id,
    provider: provider.label,
    universeLabel: scope === 'nifty50' ? 'NIFTY 50 constituents' : 'Current Daily Top 10 shares',
    universeCount: stocks.length,
    interval: '1H',
    periodDays,
    startTime,
    endTime,
    minConfidence: BACKTEST_MIN_CONFIDENCE,
    offset,
    nextOffset,
    processedCount: batch.length,
    skippedCount: results.filter((item) => !item.sufficient).length,
    results,
    done: nextOffset >= stocks.length,
    generatedAt: Date.now(),
  };
  backtestBatchCache.set(cacheKey, { createdAt: Date.now(), data });
  if (backtestBatchCache.size > 80) backtestBatchCache.delete(backtestBatchCache.keys().next().value);
  return { ...data, cached: false };
}

export const getNifty50BacktestBatch = (options = {}) => getScannerBacktestBatch({ ...options, scope: 'nifty50' });
export const getDailyTop10BacktestBatch = (options = {}) => getScannerBacktestBatch({ ...options, scope: 'dailyTop10' });
