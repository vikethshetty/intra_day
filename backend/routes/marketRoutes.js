import { Router } from 'express';
import * as c from '../controllers/marketController.js';

const router = Router();

router.get('/health', c.health);
router.get('/search', c.search);
router.get('/scanner/top10', c.dailyTop10);

// Market data
router.get('/market/:symbol', c.marketOverview);
router.get('/market/:symbol/candles', c.marketCandles);
router.get('/market/:symbol/quote', c.marketQuote);

// Analysis
router.get('/analysis/:symbol', c.analysisFull);
router.get('/analysis/:symbol/indicators', c.analysisIndicators);
router.get('/analysis/:symbol/signals', c.analysisSignals);
router.post('/analysis/:symbol/stoploss', c.analysisStopLoss);
router.post('/analysis/:symbol/prediction', c.analysisPrediction);

export default router;
