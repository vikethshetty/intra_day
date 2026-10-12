/** Unit tests for the plain-language intraday call (pure function, no network). */
import assert from 'node:assert/strict';
import { buildIntradayCall } from '../services/intradayService.js';

const ist = (h, m) => Date.UTC(2026, 9, 6) + ((h * 60 + m) * 60 - 19800) * 1000;
const open = { state: 'OPEN', isOpen: true, dataStale: false };
const mkSetup = (o = {}) => ({ direction: 'LONG', status: 'BUY NOW (CONDITIONS MET)', entry: 100, stopLoss: 98, target1: 103, target2: 106, risk: 2, rr1: 1.5, rr2: 3, confidence: 70, signalStrength: 78, confirmation: null, checks: [{ ok: true, label: 'Price above VWAP' }, { ok: false, label: 'x' }], ...o });
const run = (o = {}) => buildIntradayCall({
  snap: { breakout: { status: 'NONE' } }, scoring: { direction: 'LONG', total: 78 }, setup: mkSetup(o.setup), stable: o.stable ?? 'BUY',
  marketStatus: o.ms ?? open, interval: '5m', nowMs: ist(...(o.time ?? [11, 0])),
});

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };
console.log('Intraday call tests');

t('BUY NOW when everything lines up', () => { const r = run(); assert.equal(r.verdict, 'BUY_NOW'); assert.equal(r.headline, 'YES - BUY NOW'); assert.equal(r.action, 'BUY'); assert.equal(r.planIsReference, false); });
t('SELL NOW for a confirmed short', () => { const r = run({ stable: 'STRONG SELL', setup: { direction: 'SHORT', status: 'SELL NOW (CONDITIONS MET)', stopLoss: 102, target1: 97, target2: 94 } }); assert.equal(r.verdict, 'SELL_NOW'); assert.equal(r.headline, 'SELL NOW'); assert.equal(r.tone, 'bear'); });
t('WEAK BUY is not actionable', () => { const r = run({ stable: 'WEAK BUY', setup: { active: false, status: 'WAIT' } }); assert.equal(r.action, null); assert.match(r.headline, /WEAK/); });
t('waits for breakout confirmation', () => { const r = run({ setup: { status: 'BUY ON CONFIRMATION', confirmation: 'Wait for a 5-minute candle close above ₹101.00' } }); assert.equal(r.verdict, 'BUY_WAIT'); assert.equal(r.action, null); assert.match(r.message, /101\.00/); });
t('extended price -> do not chase', () => { assert.equal(run({ setup: { status: 'WAIT FOR PULLBACK', confirmation: 'wait' } }).verdict, 'PULLBACK'); });
t('poor reward blocks a NOW call', () => { const r = run({ setup: { rr1: 0.9 } }); assert.equal(r.action, null); assert.ok(r.blockers.length); });
t('no entries during opening 15 minutes', () => { assert.equal(run({ time: [9, 20] }).verdict, 'OPENING'); });
t('no new entries after 2:45 PM', () => { assert.equal(run({ time: [14, 50] }).verdict, 'NO_NEW_ENTRY'); });
t('square off after 3:15 PM', () => { assert.equal(run({ time: [15, 20] }).verdict, 'SQUARE_OFF'); });
t('market closed / pre-open / stale never produce a call', () => {
  assert.equal(run({ ms: { state: 'AFTER_MARKET', isOpen: false } }).verdict, 'CLOSED');
  assert.equal(run({ ms: { state: 'PRE_OPEN', isOpen: false } }).verdict, 'PRE_OPEN');
  const s = run({ ms: { state: 'OPEN', isOpen: true, dataStale: true } }); assert.equal(s.verdict, 'STALE'); assert.equal(s.action, null);
});
t('false-breakout warning blocks the call', () => {
  const r = buildIntradayCall({ snap: { breakout: { status: 'POSSIBLE_FALSE_BREAKOUT', message: 'possible false breakout' } }, scoring: { direction: 'LONG', total: 80 }, setup: mkSetup(), stable: 'BUY', marketStatus: open, interval: '5m', nowMs: ist(11, 0) });
  assert.equal(r.action, null); assert.ok(r.blockers[0].includes('false'));
});
t('WAIT stays WAIT with no signal', () => { assert.equal(run({ stable: 'WAIT', setup: { direction: 'LONG', status: 'WAIT' } }).verdict, 'WAIT'); });
console.log(`\n${n} intraday checks passed`);
