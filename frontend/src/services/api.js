import axios from 'axios';

// Dev: Vite proxies /api -> http://localhost:5000. Override with VITE_API_URL if needed.
const http = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api', timeout: 20000 });

/** Turn any axios failure into { code, message, retryAfter }. Never returns fake data. */
export function normalizeError(err) {
  const e = err?.response?.data?.error;
  if (e) return { code: e.code, message: e.message, retryAfter: e.retryAfter ?? null, provider: err.response.data.provider };
  if (err?.code === 'ECONNABORTED') return { code: 'TIMEOUT', message: 'The analysis server took too long to respond.' };
  return { code: 'BACKEND_DOWN', message: 'Cannot reach the analysis server. Make sure the backend is running (cd backend && npm run dev).' };
}

const enc = encodeURIComponent;
export const fetchAnalysis = (symbol, interval, series = 'full') =>
  http.get(`/analysis/${enc(symbol)}`, { params: { interval, series } }).then((r) => r.data);
export const runStopLoss = (symbol, interval, direction = 'AUTO') =>
  http.post(`/analysis/${enc(symbol)}/stoploss`, { interval, direction }).then((r) => r.data);
export const runPrediction = (symbol, interval) =>
  http.post(`/analysis/${enc(symbol)}/prediction`, { interval }).then((r) => r.data);
export const searchSymbols = (q) => http.get('/search', { params: { q } }).then((r) => r.data);
export const fetchHealth = () => http.get('/health').then((r) => r.data);
export const fetchDailyTop10Batch = (offset = 0) =>
  http.get('/scanner/top10', { params: { offset }, timeout: 45000 }).then((r) => r.data);
