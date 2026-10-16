import { useState } from 'react';
import DailyTop10 from './DailyTop10.jsx';
import Nifty50Backtest from './Nifty50Backtest.jsx';
import NewStrategyBacktest from './NewStrategyBacktest.jsx';

export default function Nifty50Top10({ onAnalyze }) {
  const [view, setView] = useState('top10');
  return <>
    <nav className="nifty-subnav" aria-label="Nifty 50 analysis views">
      <button type="button" className={view === 'top10' ? 'on' : ''} onClick={() => setView('top10')}><i className="bi bi-trophy-fill" /> Top 10 analysis</button>
      <button type="button" className={view === 'backtest' ? 'on' : ''} onClick={() => setView('backtest')}><i className="bi bi-clock-history" /> Backtesting</button>
      <button type="button" className={view === 'newStrategy' ? 'on' : ''} onClick={() => setView('newStrategy')}><i className="bi bi-bezier2" /> New Strategy</button>
    </nav>
    {view === 'top10' ? <DailyTop10 onAnalyze={onAnalyze} universe="nifty50" /> : view === 'newStrategy' ? <NewStrategyBacktest universe="nifty50" /> : <Nifty50Backtest />}
  </>;
}
