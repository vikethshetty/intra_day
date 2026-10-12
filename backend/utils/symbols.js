/**
 * Symbol helpers. This is reference data only (ticker names), not market data.
 * It lets the search box suggest names even when the live provider is down.
 */

// Common colloquial names -> official NSE ticker.
export const ALIASES = {
  HEROMOTORS: 'HEROMOTOCO',
  HEROMOTO: 'HEROMOTOCO',
  HERO: 'HEROMOTOCO',
  HEROMOTOCORP: 'HEROMOTOCO',
  BAJAJAUTO: 'BAJAJ-AUTO',
  MM: 'M&M',
  MAHINDRA: 'M&M',
  LNT: 'LT',
  LARSEN: 'LT',
  TATAMOTORS: 'TATAMOTORS',
  HDFC: 'HDFCBANK',
  ICICI: 'ICICIBANK',
  AXIS: 'AXISBANK',
  KOTAK: 'KOTAKBANK',
  INFOSYS: 'INFY',
  MARUTI: 'MARUTI',
  ASIANPAINT: 'ASIANPAINT',
  SUNPHARMA: 'SUNPHARMA',
  ULTRATECH: 'ULTRACEMCO',
  NESTLE: 'NESTLEIND',
  BAJAJFINANCE: 'BAJFINANCE',
  BAJAJFINSERV: 'BAJAJFINSV',
  TATASTEEL: 'TATASTEEL',
  HUL: 'HINDUNILVR',
  ITC: 'ITC',
  SBI: 'SBIN',
};

export const POPULAR = [
  ['HEROMOTOCO', 'Hero MotoCorp'], ['RELIANCE', 'Reliance Industries'], ['TCS', 'Tata Consultancy Services'],
  ['INFY', 'Infosys'], ['HDFCBANK', 'HDFC Bank'], ['ICICIBANK', 'ICICI Bank'], ['SBIN', 'State Bank of India'],
  ['BHARTIARTL', 'Bharti Airtel'], ['ITC', 'ITC'], ['LT', 'Larsen & Toubro'], ['KOTAKBANK', 'Kotak Mahindra Bank'],
  ['AXISBANK', 'Axis Bank'], ['HINDUNILVR', 'Hindustan Unilever'], ['BAJFINANCE', 'Bajaj Finance'],
  ['BAJAJFINSV', 'Bajaj Finserv'], ['MARUTI', 'Maruti Suzuki'], ['M&M', 'Mahindra & Mahindra'],
  ['TATAMOTORS', 'Tata Motors'], ['TATASTEEL', 'Tata Steel'], ['SUNPHARMA', 'Sun Pharma'], ['WIPRO', 'Wipro'],
  ['HCLTECH', 'HCL Technologies'], ['TECHM', 'Tech Mahindra'], ['ASIANPAINT', 'Asian Paints'],
  ['ULTRACEMCO', 'UltraTech Cement'], ['TITAN', 'Titan Company'], ['NTPC', 'NTPC'], ['POWERGRID', 'Power Grid'],
  ['ONGC', 'ONGC'], ['COALINDIA', 'Coal India'], ['ADANIENT', 'Adani Enterprises'], ['ADANIPORTS', 'Adani Ports'],
  ['JSWSTEEL', 'JSW Steel'], ['HINDALCO', 'Hindalco'], ['GRASIM', 'Grasim'], ['NESTLEIND', 'Nestle India'],
  ['BRITANNIA', 'Britannia'], ['CIPLA', 'Cipla'], ['DRREDDY', "Dr. Reddy's"], ['DIVISLAB', "Divi's Labs"],
  ['EICHERMOT', 'Eicher Motors'], ['BAJAJ-AUTO', 'Bajaj Auto'], ['TVSMOTOR', 'TVS Motor'], ['APOLLOHOSP', 'Apollo Hospitals'],
  ['INDUSINDBK', 'IndusInd Bank'], ['SBILIFE', 'SBI Life'], ['HDFCLIFE', 'HDFC Life'], ['BPCL', 'BPCL'],
  ['TATACONSUM', 'Tata Consumer'], ['ZOMATO', 'Zomato'], ['IRCTC', 'IRCTC'], ['PNB', 'Punjab National Bank'],
  ['BANKBARODA', 'Bank of Baroda'], ['VEDL', 'Vedanta'], ['YESBANK', 'Yes Bank'], ['IDEA', 'Vodafone Idea'],
  ['SAIL', 'SAIL'], ['DLF', 'DLF'], ['HAL', 'Hindustan Aeronautics'], ['BEL', 'Bharat Electronics'],
].map(([symbol, name]) => ({ symbol, name, exchange: 'NSE' }));

const VALID = /^[A-Z0-9&\-.^ ]{1,30}$/;

/** Normalise user input to { base, suffix } or null when invalid. */
export function normalizeSymbol(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().toUpperCase().replace(/^NSE:|^BSE:/, '');
  if (!VALID.test(s)) return null;
  let suffix = null;
  if (s.endsWith('.NS')) { suffix = 'NS'; s = s.slice(0, -3); }
  else if (s.endsWith('.BO')) { suffix = 'BO'; s = s.slice(0, -3); }
  s = s.replace(/\s+/g, '');
  if (!s) return null;
  return { base: ALIASES[s] || s, suffix };
}

export function localSearch(q, limit = 8) {
  const needle = (q || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!needle) return POPULAR.slice(0, limit);
  const aliasHit = ALIASES[needle];
  const scored = POPULAR.map((p) => {
    const sym = p.symbol.replace(/[^A-Z0-9]/g, '');
    const name = p.name.toUpperCase().replace(/\s+/g, '');
    let score = 0;
    if (p.symbol === needle || p.symbol === aliasHit) score = 100;
    else if (sym.startsWith(needle)) score = 80;
    else if (name.startsWith(needle)) score = 70;
    else if (name.includes(needle)) score = 50;
    else if (sym.includes(needle)) score = 40;
    return { p, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.p);
}
