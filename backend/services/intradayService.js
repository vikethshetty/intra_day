/**
 * Plain-language intraday call ("YES - BUY NOW", "SELL NOW", "WAIT ...").
 *
 * It does not invent anything: it translates the existing signal engine output (stable signal,
 * trade setup, false-breakout check) into an action, and adds intraday time-of-day rules:
 *   before 09:30  opening volatility  -> wait
 *   09:30-14:45   new entries allowed
 *   14:45-15:15   no new entries
 *   after 15:15   square off open positions
 * A BUY/SELL NOW call needs: a stable BUY/SELL (not WEAK) signal, setup conditions met (not waiting
 * for a breakout close, not extended from EMA 20), no false-breakout warning and reward >= 1.2x risk.
 * It is a technical-analysis signal, never a guarantee.
 */
import { istMinutes } from '../utils/indicators.js';
import { sideOf } from './signalEngine.js';

const OPEN_ENTRY = 9 * 60 + 30;
const LAST_ENTRY = 14 * 60 + 45;
const SQUARE_OFF = 15 * 60 + 15;
const MIN_RR = 1.2;

const fmt = (x) => `₹${x.toFixed(2)}`;

export function buildIntradayCall({ snap, scoring, setup, stable, marketStatus, interval, nowMs = Date.now() }) {
  const mins = istMinutes(Math.floor(nowMs / 1000));
  const stableSide = sideOf(stable);
  const actionable = ['BUY', 'STRONG BUY', 'SELL', 'STRONG SELL'].includes(stable);
  const long = (stableSide || setup.direction) === 'LONG';
  const verb = long ? 'BUY' : 'SELL';

  const plan = {
    direction: setup.direction, entry: setup.entry, stopLoss: setup.stopLoss, target1: setup.target1, target2: setup.target2,
    risk: setup.risk, rr1: setup.rr1, rr2: setup.rr2, confidence: setup.confidence, strength: setup.signalStrength,
    historyContext: setup.historyContext, candlePattern: setup.candlePattern,
  };
  const reasons = (setup.checks || []).filter((c) => c.ok).map((c) => c.label).slice(0, 5);
  const blockers = [];
  const make = (verdict, tone, headline, message, extra = {}) => ({
    verdict, tone, headline, message, action: null, timeframe: interval, signal: stable,
    plan, reasonsFor: reasons, blockers, score: scoring.total, planIsReference: true, ...extra,
  });

  /* ---- market / data state ---- */
  if (marketStatus.state === 'PRE_OPEN') return make('PRE_OPEN', 'closed', 'MARKET OPENS SOON', 'Pre-open session. Wait for 9:15 AM IST - the first buy/sell call is allowed after 9:30 AM, once opening volatility settles.');
  if (!marketStatus.isOpen) return make('CLOSED', 'closed', 'MARKET CLOSED', 'No live buy/sell call outside 9:15 AM - 3:30 PM IST (Mon-Fri). Below is the last session for reference only - do not treat it as a live call.');
  if (marketStatus.dataStale) return make('STALE', 'closed', 'DATA DELAYED - DO NOT ACT', 'No fresh candles for several minutes (feed delay or exchange holiday). Calls are paused until live candles resume.');

  /* ---- time-of-day rules ---- */
  if (mins >= SQUARE_OFF) return make('SQUARE_OFF', 'wait', 'SQUARE OFF NOW', 'Close any open intraday position now. Brokers usually auto square-off around 3:15-3:25 PM. No new entries.');
  if (mins >= LAST_ENTRY) return make('NO_NEW_ENTRY', 'wait', 'NO NEW ENTRIES NOW', 'Too late in the session for a fresh intraday entry (after 2:45 PM). Manage or exit existing positions; square off by 3:15 PM.');
  if (mins < OPEN_ENTRY) return make('OPENING', 'wait', 'WAIT - OPENING VOLATILITY', 'The first 15 minutes are erratic. Wait until 9:30 AM for a cleaner call.');

  /* ---- signal-based call ---- */
  const b = snap.breakout;
  if (/FALSE/.test(b.status)) blockers.push(b.message);
  const rrOk = setup.rr1 >= MIN_RR;

  if (actionable && setup.direction === stableSide) {
    if (setup.status.includes('NOW (CONDITIONS MET)')) {
      if (blockers.length) return make('WAIT', 'wait', `NOT YET - ${verb} SIGNAL HAS A WARNING`, `${blockers[0]} Do not enter now.`);
      if (!rrOk) {
        blockers.push(`Reward to the first target is only ${setup.rr1.toFixed(2)}x the risk (minimum ${MIN_RR}x).`);
        return make('WAIT', 'wait', `NOT YET - POOR ${verb} REWARD`, `Signal agrees but the trade does not pay enough for its risk. Wait for a better entry.`);
      }
      return make(`${verb}_NOW`, long ? 'bull' : 'bear', long ? 'YES - BUY NOW' : 'SELL NOW',
        `${long ? 'Buy' : 'Sell (short)'} near ${fmt(setup.entry)}. Stop-loss ${fmt(setup.stopLoss)}. Target 1 ${fmt(setup.target1)}, Target 2 ${fmt(setup.target2)}. Conditions are confirmed on the ${interval} chart.${long ? '' : ' Intraday short - square off before 3:15 PM.'}`,
        { action: verb, planIsReference: false });
    }
    if (setup.status.includes('ON CONFIRMATION')) {
      return make(`${verb}_WAIT`, 'wait', `NOT YET - WAIT TO ${verb}`, `Setup is forming but not confirmed. ${setup.confirmation}. Do not ${verb.toLowerCase()} before that.`, { trigger: setup.entry });
    }
    if (setup.status.includes('PULLBACK')) {
      return make('PULLBACK', 'wait', "WAIT - DON'T CHASE", `Price has run too far from its average. ${setup.confirmation}.`, { trigger: setup.entry });
    }
  }
  if (stable === 'WEAK BUY' || stable === 'WEAK SELL') {
    return make('WAIT', 'wait', 'WAIT - SIGNAL TOO WEAK', `${stable.toLowerCase()} is not strong enough to act on. Wait for a BUY/SELL.`);
  }
  const lean = scoring.direction === 'LONG' ? 'bullish' : 'bearish';
  return make('WAIT', 'wait', 'NO TRADE - WAIT', `No setup has enough confirmed evidence. Leaning ${lean} (${scoring.total}/100) but not actionable. Stay out until a clear BUY NOW or SELL NOW.`);
}
