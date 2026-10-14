import { useState } from 'react';
import TradingDashboard from './pages/TradingDashboard.jsx';
import IntradayToday from './pages/IntradayToday.jsx';
import DailyTop10 from './pages/DailyTop10.jsx';

const TABS = [
  { id: 'intraday', label: 'Intraday today', icon: 'bi-lightning-charge-fill', hint: 'One session: BUY NOW / SELL NOW / WAIT' },
  { id: 'daily', label: 'Daily Top 10', icon: 'bi-trophy-fill', hint: 'Highest setup confidence across NSE-listed shares' },
  { id: 'full', label: 'Full analysis', icon: 'bi-graph-up-arrow', hint: 'All timeframes, indicators, scenarios, backtest' },
];

export default function App() {
  const [tab, setTab] = useState(() => ['daily', 'full'].includes(localStorage.getItem('lia.tab')) ? localStorage.getItem('lia.tab') : 'intraday');
  const pick = (id) => { setTab(id); try { localStorage.setItem('lia.tab', id); } catch { /* ignore */ } window.scrollTo({ top: 0 }); };
  const analyze = (symbol) => {
    try { localStorage.setItem('lia.symbol', symbol); } catch { /* storage unavailable */ }
    pick('intraday');
  };
  return (
    <>
      <nav className="tabbar" aria-label="Views">
        <div className="tabbar-in" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} title={t.hint} onClick={() => pick(t.id)}>
              <i className={`bi ${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>
      </nav>
      {/* Only the active tab is mounted, so only one view polls the data provider. */}
      {tab === 'intraday' ? <IntradayToday /> : tab === 'daily' ? <DailyTop10 onAnalyze={analyze} /> : <TradingDashboard />}
    </>
  );
}
