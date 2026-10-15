/**
 * Market-data service  -  the ONLY file that talks to an external data provider.
 *
 * To plug in another provider: add an entry to PROVIDERS exposing
 *   { id, label, requiresKey, fetchCandles(ctx), search?(q) }
 * where fetchCandles returns { candles: [{time,open,high,low,close,volume}], meta }
 * with `time` in unix seconds (UTC) sorted ascending. Everything downstream
 * (indicators, signals, UI) only sees that normalised shape.
 *
 * Rules enforced here:
 *  - never fabricate data: if a provider fails we throw a typed MarketDataError
 *  - rows with missing OHLC values are dropped, never interpolated
 *  - timeframes the provider lacks (3m) are aggregated from real 1m candles
 */
import axios from 'axios';
import { gunzipSync } from 'node:zlib';
import { IST_OFFSET, istDayKey, istMinutes } from '../utils/indicators.js';
import { normalizeSymbol, localSearch } from '../utils/symbols.js';

export class MarketDataError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ */
/* Intervals                                                           */
/* ------------------------------------------------------------------ */
export const INTERVALS = {
  '1m': { yahoo: '1m', range: '5d', agg: 1, seconds: 60, ttl: 3000, twelve: '1min' },
  '3m': { yahoo: '1m', range: '5d', agg: 3, seconds: 180, ttl: 3000, twelve: '1min' },
  '5m': { yahoo: '5m', range: '1mo', agg: 1, seconds: 300, ttl: 5000, twelve: '5min' },
  '15m': { yahoo: '15m', range: '1mo', agg: 1, seconds: 900, ttl: 8000, twelve: '15min' },
  '30m': { yahoo: '30m', range: '1mo', agg: 1, seconds: 1800, ttl: 10000, twelve: '30min' },
  '1H': { yahoo: '60m', range: '3mo', agg: 1, seconds: 3600, ttl: 15000, twelve: '1h' },
  '1D': { yahoo: '1d', range: '2y', agg: 1, seconds: 86400, ttl: 60000, twelve: '1day' },
};

export function normalizeInterval(raw = '1m') {
  const s = String(raw).trim().toLowerCase();
  const map = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '60m': '1H', '1d': '1D', d: '1D' };
  const out = map[s];
  if (!out) throw new MarketDataError('INVALID_INTERVAL', `Unsupported interval "${raw}". Use 1m, 3m, 5m, 15m, 30m, 1H or 1D.`, 400);
  return out;
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */
const UA = 'Mozilla/5.0 (compatible; LiveIntradayAnalyzer/1.0; personal-use)';

function mapHttpError(err, providerLabel) {
  if (err instanceof MarketDataError) return err;
  const status = err.response?.status;
  if (status === 429) return new MarketDataError('RATE_LIMIT', `${providerLabel} is rate-limiting requests. Retrying shortly.`, 429, { retryAfter: 30 });
  if (status === 404) return new MarketDataError('INVALID_SYMBOL', 'Symbol not found on this exchange.', 404);
  if (status === 401 || status === 403) return new MarketDataError('API_FAILURE', `${providerLabel} rejected the request (HTTP ${status}). Check provider access / API key.`, 502);
  if (!err.response) return new MarketDataError('NETWORK', `Cannot reach ${providerLabel}. Check your internet connection.`, 503);
  return new MarketDataError('API_FAILURE', `${providerLabel} returned HTTP ${status}.`, 502);
}

const yahoo = {
  id: 'yahoo',
  label: 'Yahoo Finance (public chart endpoint)',
  requiresKey: false,
  baseUrl: () => process.env.YAHOO_BASE_URL || 'https://query1.finance.yahoo.com',

  async fetchCandles({ base, suffix, interval }) {
    const cfg = INTERVALS[interval];
    const attempts = suffix ? [suffix] : ['NS', 'BO'];
    let lastErr;
    for (const sfx of attempts) {
      const ysym = `${base}.${sfx}`;
      try {
        const { data } = await axios.get(`${this.baseUrl()}/v8/finance/chart/${encodeURIComponent(ysym)}`, {
          params: { interval: cfg.yahoo, range: cfg.range, includePrePost: false },
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          timeout: 9000,
        });
        const res = data?.chart?.result?.[0];
        if (!res) {
          const e = data?.chart?.error;
          throw new MarketDataError(e?.code === 'Not Found' ? 'INVALID_SYMBOL' : 'API_FAILURE', e?.description || 'Provider returned no result.', e?.code === 'Not Found' ? 404 : 502);
        }
        const ts = res.timestamp || [];
        const q = res.indicators?.quote?.[0] || {};
        const candles = [];
        for (let i = 0; i < ts.length; i++) {
          const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
          if ([o, h, l, c].some((v) => v == null || !Number.isFinite(v))) continue; // drop, never interpolate
          candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] || 0 });
        }
        const m = res.meta || {};
        return {
          candles,
          providerSymbol: ysym,
          meta: {
            name: m.longName || m.shortName || base,
            currency: m.currency || 'INR',
            exchange: m.exchangeName === 'NSI' ? 'NSE' : m.exchangeName === 'BSE' ? 'BSE' : (m.fullExchangeName || m.exchangeName || sfx),
            previousClose: m.previousClose ?? m.chartPreviousClose ?? null,
            regularMarketPrice: m.regularMarketPrice ?? null,
            regularMarketTime: m.regularMarketTime ?? null,
            fiftyTwoWeekHigh: m.fiftyTwoWeekHigh ?? null,
            fiftyTwoWeekLow: m.fiftyTwoWeekLow ?? null,
            instrumentType: m.instrumentType || null,
          },
        };
      } catch (err) {
        lastErr = mapHttpError(err, 'Yahoo Finance');
        if (lastErr.code !== 'INVALID_SYMBOL') throw lastErr; // only try the BSE fallback for unknown symbols
      }
    }
    throw lastErr;
  },

  async search(q) {
    try {
      const { data } = await axios.get(`${this.baseUrl().replace('query1', 'query2')}/v1/finance/search`, {
        params: { q, quotesCount: 10, newsCount: 0, listsCount: 0 },
        headers: { 'User-Agent': UA },
        timeout: 5000,
      });
      return (data?.quotes || [])
        .filter((x) => x.quoteType === 'EQUITY' && /\.(NS|BO)$/.test(x.symbol || ''))
        .map((x) => ({ symbol: x.symbol.replace(/\.(NS|BO)$/, ''), name: x.longname || x.shortname || x.symbol, exchange: x.symbol.endsWith('.NS') ? 'NSE' : 'BSE' }));
    } catch {
      return null; // caller falls back to the local list
    }
  },
};

const twelvedata = {
  id: 'twelvedata',
  label: 'Twelve Data',
  requiresKey: true,

  async fetchCandles({ base, interval }) {
    const key = process.env.MARKET_DATA_API_KEY;
    if (!key) throw new MarketDataError('MISSING_API_KEY', 'Twelve Data needs your own API key. Set MARKET_DATA_API_KEY in backend/.env.', 503);
    const cfg = INTERVALS[interval];
    try {
      const { data } = await axios.get('https://api.twelvedata.com/time_series', {
        params: { symbol: base, exchange: 'NSE', interval: cfg.twelve, outputsize: 2500, order: 'ASC', timezone: 'UTC', apikey: key },
        timeout: 10000,
      });
      if (data?.status === 'error') {
        const c = Number(data.code);
        if (c === 429) throw new MarketDataError('RATE_LIMIT', 'Twelve Data rate limit reached.', 429, { retryAfter: 60 });
        if (c === 401) throw new MarketDataError('MISSING_API_KEY', 'Twelve Data rejected the API key.', 503);
        if (c === 404 || c === 400) throw new MarketDataError('INVALID_SYMBOL', data.message || 'Symbol not found.', 404);
        throw new MarketDataError('API_FAILURE', data.message || 'Twelve Data error.', 502);
      }
      const candles = (data.values || [])
        .map((v) => ({
          time: Math.floor(Date.parse(v.datetime.includes(' ') ? v.datetime.replace(' ', 'T') + 'Z' : v.datetime + 'T00:00:00Z') / 1000),
          open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +v.volume || 0,
        }))
        .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
      return {
        candles,
        providerSymbol: `${base}:NSE`,
        meta: { name: data.meta?.symbol || base, currency: data.meta?.currency || 'INR', exchange: 'NSE', previousClose: null, regularMarketPrice: null, regularMarketTime: null },
      };
    } catch (err) {
      throw mapHttpError(err, 'Twelve Data');
    }
  },
};

/**
 * Upstox's Analytics Token is a read-only bearer token. Candle REST endpoints
 * provide frequently refreshed candles; tick-by-tick updates need the separate
 * Upstox WebSocket feed, which this polling-based app does not currently use.
 */
const UPSTOX_INTERVALS = {
  '1m': ['minutes', 1, 5],
  '3m': ['minutes', 3, 5],
  '5m': ['minutes', 5, 30],
  '15m': ['minutes', 15, 30],
  '30m': ['minutes', 30, 90],
  '1H': ['hours', 1, 90],
  '1D': ['days', 1, 730],
};
const upstoxInstrumentCache = new Map();
const upstoxInstrumentMasters = new Map();
const UPSTOX_INSTRUMENT_TTL_MS = 6 * 60 * 60 * 1000;

function upstoxToken() {
  return process.env.UPSTOX_ACCESS_TOKEN?.trim() || '';
}

function istDate(daysAgo = 0) {
  const date = new Date(Date.now() + IST_OFFSET * 1000);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function asUpstoxCandle(row) {
  const candle = {
    time: Math.floor(Date.parse(row[0]) / 1000),
    open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]) || 0,
  };
  return Number.isFinite(candle.time) && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    ? candle : null;
}

async function getUpstoxInstrumentMaster(exchange) {
  const cached = upstoxInstrumentMasters.get(exchange);
  if (cached && Date.now() - cached.loadedAt < UPSTOX_INSTRUMENT_TTL_MS) return cached.items;
  try {
    const { data } = await axios.get(`https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`, {
      responseType: 'arraybuffer', decompress: false, headers: { 'Accept-Encoding': 'gzip' }, timeout: 20000,
    });
    const items = JSON.parse(gunzipSync(Buffer.from(data)).toString('utf8'));
    if (!Array.isArray(items) || !items.length) throw new Error('Instrument list is empty.');
    upstoxInstrumentMasters.set(exchange, { loadedAt: Date.now(), items });
    return items;
  } catch (err) {
    throw new MarketDataError('INSTRUMENTS_UNAVAILABLE', `Could not load Upstox's ${exchange} instrument list. ${err.message || 'Try again shortly.'}`, 503);
  }
}

const upstox = {
  id: 'upstox',
  label: 'Upstox',
  requiresKey: true,
  tokenEnv: 'UPSTOX_ACCESS_TOKEN',
  nativeIntervals: new Set(Object.keys(UPSTOX_INTERVALS)),

  async request(path, params = {}) {
    const token = upstoxToken();
    if (!token) throw new MarketDataError('MISSING_API_KEY', 'Upstox needs an Analytics Token. Set UPSTOX_ACCESS_TOKEN in backend/.env.', 503);
    try {
      const { data } = await axios.get(`https://api.upstox.com${path}`, {
        params,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: 10000,
      });
      if (data?.status && data.status !== 'success') {
        throw new MarketDataError('API_FAILURE', data.errors?.[0]?.message || 'Upstox returned an unsuccessful response.', 502);
      }
      return data;
    } catch (err) {
      throw mapHttpError(err, 'Upstox');
    }
  },

  async resolveInstrument(base, suffix) {
    const exchange = suffix === 'BO' ? 'BSE' : 'NSE';
    const cacheKey = `${exchange}:${base}`;
    if (upstoxInstrumentCache.has(cacheKey)) return upstoxInstrumentCache.get(cacheKey);
    const items = await getUpstoxInstrumentMaster(exchange);
    const wanted = base.replace(/[^A-Z0-9]/g, '');
    const match = items.find((item) => item.exchange === exchange
      && item.segment === `${exchange}_EQ`
      && ['EQ', 'BE', 'BZ'].includes(item.instrument_type)
      && (item.trading_symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === wanted);
    if (!match?.instrument_key) throw new MarketDataError('INVALID_SYMBOL', `${base} was not found as an ${exchange} equity on Upstox.`, 404);
    const instrument = { key: match.instrument_key, name: match.name || match.trading_symbol, exchange };
    upstoxInstrumentCache.set(cacheKey, instrument);
    return instrument;
  },

  async fetchLtp({ base, suffix }) {
    const instrument = await this.resolveInstrument(base, suffix);
    const response = await this.request('/v3/market-quote/ltp', { instrument_key: instrument.key });
    const quotes = Object.values(response?.data || {});
    const quote = quotes.find((item) => item.instrument_token === instrument.key) || quotes[0];
    if (!(Number(quote?.last_price) > 0)) {
      throw new MarketDataError('NO_DATA', 'Upstox did not return a last traded price for this instrument.', 404);
    }
    const previousClose = quote.cp == null ? null : Number(quote.cp);
    return {
      price: Number(quote.last_price),
      previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
      volume: Number(quote.volume) || 0,
    };
  },

  async fetchCandles({ base, suffix, interval }) {
    const instrument = await this.resolveInstrument(base, suffix);
    const [unit, size, lookbackDays] = UPSTOX_INTERVALS[interval];
    const key = encodeURIComponent(instrument.key);
    const toDate = istDate();
    const fromDate = istDate(lookbackDays);
    const history = await this.request(
      `/v3/historical-candle/${key}/${unit}/${size}/${toDate}/${fromDate}`,
    );
    let rows = history?.data?.candles || [];

    // The intraday endpoint contains the current session's forming/latest bars.
    // Merge it over history so duplicate timestamps use the most recent version.
    if (interval !== '1D') {
      try {
        const live = await this.request(`/v3/historical-candle/intraday/${key}/${unit}/${size}`);
        const byTime = new Map(rows.map((row) => [row[0], row]));
        for (const row of live?.data?.candles || []) byTime.set(row[0], row);
        rows = [...byTime.values()];
      } catch (err) {
        // Historical candles remain useful outside the live session or if this
        // optional current-session request is temporarily unavailable.
        if (!rows.length) throw err;
      }
    }

    const candles = rows.map(asUpstoxCandle).filter(Boolean);
    return {
      candles,
      providerSymbol: instrument.key,
      meta: {
        name: instrument.name || base,
        currency: 'INR',
        exchange: instrument.exchange,
        previousClose: null,
        regularMarketPrice: null,
        regularMarketTime: null,
      },
    };
  },

  async search(q) {
    try {
      const query = q.trim().toUpperCase();
      const [nse, bse] = await Promise.all([getUpstoxInstrumentMaster('NSE'), getUpstoxInstrumentMaster('BSE')]);
      return [...nse, ...bse].filter((item) => ['EQ', 'BE', 'BZ'].includes(item.instrument_type)
        && item.trading_symbol
        && (`${item.trading_symbol} ${item.name || ''}`).toUpperCase().includes(query))
        .slice(0, 10)
        .map((item) => ({
          symbol: item.trading_symbol,
          name: item.name || item.trading_symbol,
          exchange: item.exchange,
        }));
    } catch {
      return null;
    }
  },
};

const PROVIDERS = { yahoo, twelvedata, upstox };

export function getProviderStatus(providerId = null) {
  const id = (providerId || process.env.MARKET_DATA_PROVIDER || 'yahoo').trim().toLowerCase();
  const p = PROVIDERS[id];
  if (!p) {
    return { configured: false, id, label: 'Not configured', message: `MARKET_DATA_PROVIDER="${process.env.MARKET_DATA_PROVIDER}" is not a supported provider. Use one of: ${Object.keys(PROVIDERS).join(', ')} in backend/.env.` };
  }
  const credentialName = p.tokenEnv || 'MARKET_DATA_API_KEY';
  if (p.requiresKey && !(p.tokenEnv ? upstoxToken() : process.env.MARKET_DATA_API_KEY)) {
    return { configured: false, id, label: p.label, message: `${p.label} needs your own API key/token. Add ${credentialName} to backend/.env and restart the backend.` };
  }
  return { configured: true, id, label: p.label, message: null };
}

function activeProvider(providerId = null) {
  const st = getProviderStatus(providerId);
  if (!st.configured) throw new MarketDataError('PROVIDER_NOT_CONFIGURED', st.message, 503);
  return PROVIDERS[st.id];
}

/* ------------------------------------------------------------------ */
/* Aggregation (e.g. 3m from real 1m candles, anchored to 09:15 IST)    */
/* ------------------------------------------------------------------ */
export function aggregateCandles(candles, minutes) {
  if (minutes <= 1) return candles;
  const size = minutes * 60;
  const out = [];
  let cur = null;
  for (const c of candles) {
    const dayStart = Math.floor((c.time + IST_OFFSET) / 86400) * 86400 - IST_OFFSET;
    const anchor = dayStart + (9 * 60 + 15) * 60;
    const bucket = anchor + Math.floor((c.time - anchor) / size) * size;
    if (!cur || cur.time !== bucket) {
      cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cache with in-flight de-duplication                                  */
/* ------------------------------------------------------------------ */
const cache = new Map(); // key -> { at, data }
const inflight = new Map();

export async function getCandles(symbolInput, intervalInput = '1m', providerId = null) {
  const interval = normalizeInterval(intervalInput);
  const sym = normalizeSymbol(symbolInput);
  if (!sym) throw new MarketDataError('INVALID_SYMBOL', 'Invalid symbol. Use letters/numbers, e.g. HEROMOTOCO, RELIANCE, TCS.', 400);
  const provider = activeProvider(providerId);
  const cfg = INTERVALS[interval];
  const key = `${provider.id}|${sym.base}${sym.suffix || ''}|${interval}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cfg.ttl) return hit.data;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const raw = await provider.fetchCandles({ base: sym.base, suffix: sym.suffix, interval });
    let candles = raw.candles.sort((a, b) => a.time - b.time).filter((c, i, arr) => i === arr.length - 1 || arr[i + 1].time !== c.time);
    if (cfg.agg > 1 && !provider.nativeIntervals?.has(interval)) candles = aggregateCandles(candles, cfg.agg);
    if (!candles.length) throw new MarketDataError('NO_DATA', 'The provider returned no candles for this symbol/timeframe.', 404);
    // The provider's live quote can be fresher than its candle series. If the quote time falls inside the
    // forming candle, fold that real price into it (close/high/low). If the quote is already past the candle
    // we do NOT invent a new bar - we report the lag so the UI can say so.
    const m = raw.meta || {};
    const last = candles[candles.length - 1];
    let liveMerged = false;
    let candleLagSec = 0;
    if (interval !== '1D' && m.regularMarketPrice != null && m.regularMarketTime != null && m.regularMarketTime >= last.time) {
      if (m.regularMarketTime < last.time + cfg.seconds) {
        last.close = m.regularMarketPrice;
        last.high = Math.max(last.high, m.regularMarketPrice);
        last.low = Math.min(last.low, m.regularMarketPrice);
        liveMerged = true;
      } else {
        candleLagSec = m.regularMarketTime - (last.time + cfg.seconds);
      }
    }
    const data = {
      symbol: sym.base,
      requestedSymbol: String(symbolInput),
      providerSymbol: raw.providerSymbol,
      interval,
      source: provider.label,
      providerId: provider.id,
      fetchedAt: Date.now(),
      candles,
      meta: raw.meta,
      liveMerged,
      candleLagSec,
    };
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 80) cache.delete(cache.keys().next().value);
    return data;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/* ------------------------------------------------------------------ */
/* Quote + market status                                                */
/* ------------------------------------------------------------------ */
export function getMarketStatus(nowMs = Date.now(), lastCandleTime = null) {
  const t = Math.floor(nowMs / 1000);
  const dayIdx = Math.floor((t + IST_OFFSET) / 86400);
  const dow = (dayIdx + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  const mins = istMinutes(t);
  let state;
  let label;
  if (dow === 0 || dow === 6) { state = 'CLOSED'; label = 'MARKET CLOSED (weekend)'; }
  else if (mins < 9 * 60) { state = 'CLOSED'; label = 'MARKET CLOSED'; }
  else if (mins < 9 * 60 + 15) { state = 'PRE_OPEN'; label = 'PRE-OPEN SESSION'; }
  else if (mins < 15 * 60 + 30) { state = 'OPEN'; label = 'MARKET OPEN'; }
  else { state = 'AFTER_MARKET'; label = 'MARKET CLOSED (after market)'; }
  // The exchange calendar (holidays) is not available offline, so a quiet feed during
  // "open" hours is reported as stale instead of being assumed live.
  const dataStale = state === 'OPEN' && lastCandleTime != null && t - lastCandleTime > 300;
  return { state, label, isOpen: state === 'OPEN', dataStale, serverTime: nowMs, note: dataStale ? 'No fresh candles in the last 5 minutes - possible exchange holiday or delayed feed.' : null };
}

export function buildQuote(candles, meta = {}) {
  const last = candles[candles.length - 1];
  const dayKey = istDayKey(last.time);
  let i = candles.length - 1;
  while (i > 0 && istDayKey(candles[i - 1].time) === dayKey) i--;
  const today = candles.slice(i);
  const prevDayLastClose = i > 0 ? candles[i - 1].close : null;
  const previousClose = prevDayLastClose ?? meta.previousClose ?? null;
  const useMeta = meta.regularMarketPrice != null && meta.regularMarketTime != null && meta.regularMarketTime >= last.time;
  const price = useMeta ? meta.regularMarketPrice : last.close;
  const change = previousClose != null ? price - previousClose : null;
  return {
    price,
    previousClose,
    change,
    changePct: change != null && previousClose ? (change / previousClose) * 100 : null,
    open: today[0].open,
    high: Math.max(...today.map((c) => c.high)),
    low: Math.min(...today.map((c) => c.low)),
    volume: today.reduce((s, c) => s + c.volume, 0),
    time: useMeta ? meta.regularMarketTime : last.time,
    lastCandleTime: last.time,
    currency: meta.currency || 'INR',
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
  };
}

/** Quote is always derived from 1m candles so the header is consistent across chart timeframes. */
export async function getQuote(symbolInput, providerId = null) {
  const d = await getCandles(symbolInput, '1m', providerId);
  return { quote: buildQuote(d.candles, d.meta), data: d };
}

export async function getLiveQuote(symbolInput) {
  const sym = normalizeSymbol(symbolInput);
  if (!sym) throw new MarketDataError('INVALID_SYMBOL', 'Invalid symbol. Use letters/numbers, e.g. HEROMOTOCO, RELIANCE, TCS.', 400);
  const provider = activeProvider('upstox');
  if (!provider.fetchLtp) throw new MarketDataError('API_FAILURE', 'The selected provider does not support live last-traded prices.', 502);
  return provider.fetchLtp({ base: sym.base, suffix: sym.suffix });
}

export async function searchSymbols(q, providerId = null) {
  const local = localSearch(q, 8);
  if (!q || q.trim().length < 2) return { results: local, source: 'local' };
  try {
    const st = getProviderStatus(providerId);
    if (st.configured && PROVIDERS[st.id].search) {
      const remote = await PROVIDERS[st.id].search(q);
      if (remote && remote.length) {
        const seen = new Set();
        const merged = [...local, ...remote].filter((r) => (seen.has(r.symbol) ? false : seen.add(r.symbol)));
        return { results: merged.slice(0, 10), source: st.id };
      }
    }
  } catch { /* fall through */ }
  return { results: local, source: 'local' };
}
