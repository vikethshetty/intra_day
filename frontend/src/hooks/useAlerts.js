import { useCallback, useEffect, useRef, useState } from 'react';

const ICON = { bull: 'bi-arrow-up-circle-fill', bear: 'bi-arrow-down-circle-fill', warn: 'bi-exclamation-triangle-fill', info: 'bi-bell-fill' };

/**
 * Visual alerts + optional browser notifications.
 *  - Backend events (breakout, VWAP cross, volume spike, RSI extremes, ...) are de-duplicated by id.
 *  - Entry / stop-loss / target alerts are generated here by watching the live price against the levels
 *    from the last "Analyze stop loss" run.
 * Events already present when a symbol loads are recorded silently so opening the page never floods alerts.
 */
export function useAlerts({ symbol, interval, events, price, priceTime, trade, displayName }) {
  const [alerts, setAlerts] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [hits, setHits] = useState([]);
  const [notifyState, setNotifyState] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const seen = useRef(new Set());
  const seeded = useRef(null);
  const prevPrice = useRef(null);
  const tradeHit = useRef(new Set());

  const fire = useCallback((a) => {
    const alert = { ...a, at: Date.now(), icon: ICON[a.severity] || ICON.info };
    setAlerts((list) => [alert, ...list].slice(0, 60));
    setToasts((list) => [alert, ...list].slice(0, 4));
    setTimeout(() => setToasts((list) => list.filter((t) => t.uid !== alert.uid)), 9000);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      try { new Notification(`🔔 ${displayName || symbol}: ${a.title}`, { body: a.message }); } catch { /* notifications blocked */ }
    }
  }, [displayName, symbol]);

  // reset when the instrument or timeframe changes
  useEffect(() => {
    seen.current = new Set();
    seeded.current = null;
    prevPrice.current = null;
    tradeHit.current = new Set();
    setAlerts([]);
    setToasts([]);
    setHits([]);
  }, [symbol, interval]);

  // backend events
  useEffect(() => {
    if (!events) return;
    const key = `${symbol}|${interval}`;
    if (seeded.current !== key) {
      events.forEach((e) => seen.current.add(e.id));
      seeded.current = key;
      return;
    }
    events.forEach((e) => {
      if (seen.current.has(e.id)) return;
      seen.current.add(e.id);
      fire({ uid: e.id, severity: e.severity, title: e.title, message: e.message, type: e.type, time: e.time });
    });
  }, [events, symbol, interval, fire]);

  // trade-level alerts
  useEffect(() => {
    tradeHit.current = new Set();
    setHits([]);
    prevPrice.current = null;
  }, [trade]);

  useEffect(() => {
    if (price == null) return;
    const prev = prevPrice.current;
    prevPrice.current = price;
    if (!trade || prev == null) return;
    const long = trade.direction === 'LONG';
    const crossed = (level) => (prev < level && price >= level) || (prev > level && price <= level) || Math.abs(price - level) <= level * 0.0003;
    const check = (id, level, test, title, severity, kind) => {
      if (tradeHit.current.has(id) || !test) return;
      tradeHit.current.add(id);
      setHits((h) => [...h, { id, kind, price: level, time: priceTime }]);
      fire({ uid: `${id}_${Date.now()}`, severity, title, message: `${displayName || symbol} traded at ₹${price.toFixed(2)} (level ₹${level.toFixed(2)})`, type: id });
    };
    check('ENTRY', trade.entry, crossed(trade.entry), 'Entry level reached', 'info', 'ENTRY');
    check('STOP', trade.stopLoss, long ? price <= trade.stopLoss : price >= trade.stopLoss, 'Stop-loss level reached', 'bear', 'STOP');
    check('T1', trade.target1, long ? price >= trade.target1 : price <= trade.target1, 'Target 1 reached', 'bull', 'T1');
    check('T2', trade.target2, long ? price >= trade.target2 : price <= trade.target2, 'Target 2 reached', 'bull', 'T2');
  }, [price, priceTime, trade, fire, displayName, symbol]);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setNotifyState(p);
  }, []);
  const dismissToast = useCallback((uid) => setToasts((l) => l.filter((t) => t.uid !== uid)), []);

  return { alerts, toasts, hits, notifyState, enableNotifications, dismissToast };
}
