import app from './app.js';
import { getProviderStatus } from './services/marketDataService.js';

const PORT = Number(process.env.PORT) || 5001;

app.listen(PORT, () => {
  const p = getProviderStatus();
  console.log(`Live Intraday Analyzer API  ->  http://localhost:${PORT}/api/health`);
  console.log(p.configured ? `Market data provider: ${p.label}` : `Market data provider NOT configured: ${p.message}`);
  console.log('Analysis only - this server never places trades.');
});
