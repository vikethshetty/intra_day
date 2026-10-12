export const inr = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `₹${x.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
export const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
export const compact = (x) => {
  if (x == null || !Number.isFinite(x)) return '—';
  if (x >= 1e7) return `${(x / 1e7).toFixed(2)} Cr`;
  if (x >= 1e5) return `${(x / 1e5).toFixed(2)} L`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)} K`;
  return String(Math.round(x));
};
const IST = { timeZone: 'Asia/Kolkata', hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' };
/** unix seconds or ms -> "10:24:31 AM" in IST */
export const clock = (t, withSeconds = true) => {
  if (!t) return '—';
  const ms = t < 1e12 ? t * 1000 : t;
  return new Date(ms).toLocaleTimeString('en-IN', withSeconds ? IST : { ...IST, second: undefined });
};
export const dayTime = (t) => {
  if (!t) return '—';
  const ms = t < 1e12 ? t * 1000 : t;
  const d = new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
  return `${d}, ${clock(ms, false)}`;
};
export const signalTone = (label = 'WAIT') => (/BUY/.test(label) ? 'bull' : /SELL/.test(label) ? 'bear' : 'wait');
export const toneOf = (t) => (t === 'bull' ? 'bull' : t === 'bear' ? 'bear' : t === 'warn' ? 'warn' : 'neutral');
