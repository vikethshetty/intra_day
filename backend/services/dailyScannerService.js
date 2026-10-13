import { POPULAR } from '../utils/symbols.js';
import { buildContext, buildSnapshot } from './technicalAnalysisService.js';
import { buildTradeSetup, calculateEntryScore } from './signalEngine.js';
import { getCandles, getProviderStatus, MarketDataError } from './marketDataService.js';

// Keep the scan bounded for free market-data plans and serverless deployments.
// This is a curated NSE watchlist drawn from the symbols already supported by the app.
const SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'ITC',
  'LT', 'KOTAKBANK', 'AXISBANK', 'HINDUNILVR', 'BAJFINANCE', 'MARUTI', 'M&M',
  'TATAMOTORS', 'TATASTEEL', 'SUNPHARMA', 'WIPRO', 'HCLTECH', 'ASIANPAINT',
  'TITAN', 'NTPC', 'POWERGRID', 'ADANIENT', 'ONGC', 'COALINDIA', 'BEL',
];
const UNIVERSE = new Map(POPULAR.map((item) => [item.symbol, item]));
const INTERVAL = '5m';
const CACHE_MS = 10 * 60 * 1000;
const CONCURRENCY = 6;
const scanCache = new Map();

function istDateKey(now = Date.now()) {
  return new Date(now + 19800 * 1000).toISOString().slice(0, 10);
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

async function rankOne(symbol) {
  const stock = UNIVERSE.get(symbol) || { symbol, name: symbol, exchange: 'NSE' };
  try {
    const data = await getCandles(symbol, INTERVAL);
    if (data.candles.length < 60) return { symbol, skipped: true, reason: 'Not enough candles to calculate indicators.' };
    const ctx = buildContext(data.candles, INTERVAL);
    const i = ctx.candles.length - 1;
    const snap = buildSnapshot(ctx, i);
    const scoring = calculateEntryScore(snap);
    const setup = buildTradeSetup(ctx, i, snap, scoring, scoring.signal);
    return {
      symbol,
      name: data.meta.name || stock.name,
      exchange: data.meta.exchange || stock.exchange,
      price: snap.price,
      asOf: snap.time,
      interval: INTERVAL,
      direction: scoring.direction,
      signal: scoring.signal,
      confidence: setup.confidence,
      signalStrength: setup.signalStrength,
      confirmations: setup.met,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      target1: setup.target1,
      target2: setup.target2,
      status: setup.status,
      warnings: scoring.warnings.slice(0, 2),
      source: data.source,
    };
  } catch (error) {
    return { symbol, skipped: true, reason: error.message || 'Market data is unavailable for this symbol.' };
  }
}

async function runScan(date) {
  const provider = getProviderStatus();
  if (!provider.configured) {
    throw new MarketDataError('PROVIDER_NOT_CONFIGURED', provider.message, 503);
  }
  const scanned = await mapLimit(SYMBOLS, CONCURRENCY, rankOne);
  const candidates = scanned.filter((item) => !item.skipped)
    .sort((a, b) => b.confidence - a.confidence || b.signalStrength - a.signalStrength || b.confirmations - a.confirmations);
  return {
    ok: true,
    date,
    interval: INTERVAL,
    generatedAt: Date.now(),
    provider: provider.label,
    universeCount: SYMBOLS.length,
    scannedCount: scanned.filter((item) => !item.skipped).length,
    skipped: scanned.filter((item) => item.skipped).map(({ symbol, reason }) => ({ symbol, reason })),
    results: candidates.slice(0, 10),
    disclaimer: 'Ranked by the app’s rule-based technical setup confidence, not a probability of profit or a recommendation. A displayed WAIT means there is no entry signal.',
  };
}

export async function getDailyTop10() {
  const date = istDateKey();
  const key = `${date}:${getProviderStatus().id}:${INTERVAL}`;
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.createdAt < CACHE_MS) return { ...await hit.promise, cached: true };
  const promise = runScan(date);
  scanCache.set(key, { createdAt: Date.now(), promise });
  try {
    const result = await promise;
    if (scanCache.size > 4) scanCache.delete(scanCache.keys().next().value);
    return { ...result, cached: false };
  } catch (error) {
    scanCache.delete(key);
    throw error;
  }
}
