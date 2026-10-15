import { Router } from 'express';
import * as c from '../controllers/marketController.js';

const router = Router();

router.get('/health', c.health);
router.get('/search', c.search);
router.get('/scanner/top10', c.dailyTop10);
router.get('/scanner/nifty50/top10', c.nifty50Top10);
router.get('/scanner/nifty50/backtest', c.nifty50Backtest);
router.get('/scanner/top10/backtest', c.dailyTop10Backtest);

// Market data
router.get('/market/:symbol', c.marketOverview);
router.get('/market/:symbol/candles', c.marketCandles);
router.get('/market/:symbol/quote', c.marketQuote);
router.get('/tracking/:symbol', c.trackingMarket);

// Analysis
router.get('/analysis/:symbol', c.analysisFull);
router.get('/analysis/:symbol/indicators', c.analysisIndicators);
router.get('/analysis/:symbol/signals', c.analysisSignals);
router.post('/analysis/:symbol/stoploss', c.analysisStopLoss);
router.post('/analysis/:symbol/prediction', c.analysisPrediction);

export default router;
