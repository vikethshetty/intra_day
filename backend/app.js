import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import marketRoutes from './routes/marketRoutes.js';

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5174';

// Allow the configured frontend plus localhost/127.0.0.1 on any port (local-only tool).
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(cors({ origin: (origin, cb) => cb(null, !origin || origin === FRONTEND_URL || localOrigin.test(origin)) }));
app.use(express.json({ limit: '50kb' }));
app.disable('x-powered-by');

// No auth, no sessions, no cookies, no user data stored: this is a stateless analysis API.
app.use('/api', marketRoutes);

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `No such endpoint: ${req.method} ${req.originalUrl}` } }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const bad = err.type === 'entity.parse.failed';
  res.status(bad ? 400 : 500).json({ ok: false, error: { code: bad ? 'BAD_REQUEST' : 'INTERNAL', message: bad ? 'Invalid JSON body.' : 'Unexpected server error.' } });
});

export default app;
