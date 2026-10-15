import { useEffect, useState } from 'react';

const NOTICE_KEY = 'lia.upstox-live-notice-shown';

/** Briefly confirms the live provider once per browser tab session after real data arrives. */
export default function LiveDataNotice({ source }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (source?.toLowerCase() !== 'upstox') return;

    try {
      if (sessionStorage.getItem(NOTICE_KEY)) return;
      sessionStorage.setItem(NOTICE_KEY, '1');
    } catch { /* Show the notice even when browser storage is unavailable. */ }

    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timer);
  }, [source]);

  if (!visible) return null;

  return (
    <div className="live-data-notice" role="status" aria-live="polite">
      <i className="bi bi-check-circle-fill" />
      <span><b>Live data loaded from Upstox</b><small>Current price and chart are using the Upstox feed.</small></span>
      <button type="button" aria-label="Dismiss" onClick={() => setVisible(false)}><i className="bi bi-x-lg" /></button>
    </div>
  );
}
