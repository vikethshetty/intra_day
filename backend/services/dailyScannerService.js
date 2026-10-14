import axios from 'axios';
import { buildContext, buildSnapshot } from './technicalAnalysisService.js';
import { buildTradeSetup, calculateEntryScore } from './signalEngine.js';
import { getCandles, getProviderStatus, MarketDataError } from './marketDataService.js';

const NSE_EQUITY_LIST_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
const NSE_SME_LIST_URL = 'https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv';
const INTERVAL = '5m';
const UNIVERSE_TTL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 12;
const CONCURRENCY = 4;
let universeCache = null;
const batchCache = new Map();

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

async function downloadCsv(url) {
  const { data } = await axios.get(url, {
    responseType: 'text',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LiveIntradayAnalyzer/1.0)',
      Accept: 'text/csv,*/*',
      Referer: 'https://www.nseindia.com/',
    },
    timeout: 12000,
  });
  return String(data).replace(/^\uFEFF/, '');
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
    const data = await getCandles(`${stock.symbol}.NS`, INTERVAL);
    if (data.meta.instrumentType && !['EQUITY', 'STOCK'].includes(String(data.meta.instrumentType).toUpperCase())) {
      return { symbol: stock.symbol, skipped: true, reason: 'Yahoo identifies this NSE listing as a non-stock instrument.' };
    }
    if (data.candles.length < 60) return { symbol: stock.symbol, skipped: true, reason: 'Not enough 5-minute candles to calculate indicators.' };
    const ctx = buildContext(data.candles, INTERVAL);
    const i = ctx.candles.length - 1;
    const snap = buildSnapshot(ctx, i);
    const scoring = calculateEntryScore(snap);
    const setup = buildTradeSetup(ctx, i, snap, scoring, scoring.signal);
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
export async function getDailyTop10Batch(rawOffset = 0) {
  const provider = getProviderStatus();
  if (!provider.configured) throw new MarketDataError('PROVIDER_NOT_CONFIGURED', provider.message, 503);
  const stocks = await getNseUniverse();
  const offset = Math.max(0, Math.min(Number.parseInt(rawOffset, 10) || 0, stocks.length));
  const date = istDateKey();
  const cacheKey = `${provider.id}:${date}:${offset}`;
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
    universeLabel: 'NSE mainboard and SME equity shares',
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
