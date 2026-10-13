# Live Intraday Analyzer

A personal, single-page **technical-analysis dashboard for NSE/BSE stocks**: live candlestick chart, indicators, support/resistance, a technically-justified stop-loss tool, a 100-point signal score, scenario probabilities and a basic backtest.

* **Analysis only.** It never places trades, has no broker/order API, and needs **no login, no personal information, no trading account**.
* **Nothing is guaranteed.** Every output is a technical-analysis *estimate*. This is **not financial advice**.
* **Never invents data.** If live data cannot be loaded you see `LIVE DATA UNAVAILABLE` with the time of the last successful update - not made-up prices.

Stack: React + Vite + Bootstrap 5 + Bootstrap Icons + TradingView Lightweight Charts (frontend) · Node.js + Express (backend).

---

## Two views (tabs)

* **Intraday today** (default) - one trading session only. A big, plain call at the top:
  **YES - BUY NOW**, **SELL NOW**, or **WAIT** (with the reason), plus where to enter, the stop-loss, Target 1 and Target 2.
  Press **Track this trade** and the *My trade tracker* box tells you live: *hold*, *Target 1 hit - book half and move the stop to entry*, *Target 2 hit - book full profit*, or *Stop loss hit - exit now*. A browser notification (bell icon) can announce a new BUY NOW / SELL NOW call.
* **Full analysis** - all timeframes, indicators, scenarios, backtest and the stop-loss analyzer.

How the intraday call is decided (`backend/services/intradayService.js`): a BUY/SELL **NOW** needs a stable BUY/SELL signal (not WEAK), setup conditions met (not waiting for a breakout close, not stretched far from EMA 20), no false-breakout warning, and reward at least 1.2x risk. Time rules: no calls before 9:30 AM (opening volatility), no new entries after 2:45 PM, "square off now" after 3:15 PM, and nothing at all when the market is closed or the feed is stale. These are technical signals, not guarantees.

## Requirements

* Node.js **20+** and npm

## Installation

```bash
cd backend
npm install

cd ../frontend
npm install
```

## Configuration

Create `backend/.env` (copy `backend/.env.example`), then add your Upstox Analytics Token:

```
PORT=5000
FRONTEND_URL=http://localhost:5173
MARKET_DATA_PROVIDER=upstox
UPSTOX_ACCESS_TOKEN=your_upstox_analytics_token
```

| Variable | Meaning |
|---|---|
| `PORT` | Backend port (default 5000) |
| `FRONTEND_URL` | Allowed browser origin (localhost on any port is always allowed) |
| `MARKET_DATA_PROVIDER` | `upstox`, `yahoo`, or `twelvedata`. Choose `upstox` to use Upstox data. |
| `UPSTOX_ACCESS_TOKEN` | Your Upstox Analytics Token. Keep it secret; it is read-only and expires after one year. |
| `MARKET_DATA_API_KEY` | Existing Twelve Data key variable. Upstox also accepts this as a fallback, but `UPSTOX_ACCESS_TOKEN` is preferred. |

If the provider is unknown (for example the placeholder `YOUR_PROVIDER`) or a required key is missing, the backend still starts and the dashboard shows a clear *"Market-data provider needs configuration"* message instead of crashing.

## Running

### Option 1 - `start.bat` (Windows)

Double-click `start.bat`. It creates `backend/.env` if missing, installs dependencies the first time, starts the backend on **http://localhost:5000** and the frontend on **http://localhost:5173**, and opens the browser.

### Option 2 - two terminals

```bash
# Terminal 1
cd backend
npm install
npm run dev

# Terminal 2
cd frontend
npm install
npm run dev
```

Then open **http://localhost:5173**. HEROMOTORS (NSE: HEROMOTOCO) loads by default; use the search box to switch stocks (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `SBIN`, ...). The Vite dev server proxies `/api` to the backend, so no CORS setup is needed.

Optional: `npm run build` in `frontend/` produces a static build; `npm test` in `backend/` runs the smoke tests.

---

## Market-data provider (where to configure it)

Everything that talks to a data vendor lives in **`backend/services/marketDataService.js`**. Each provider is a small object with `fetchCandles()` returning `{ candles: [{time, open, high, low, close, volume}], meta }`; the rest of the app only sees that normalised shape.

* **`upstox`** - Upstox's documented V3 historical and current-session candle APIs, plus its instrument search endpoint. Set `MARKET_DATA_PROVIDER=upstox` and `UPSTOX_ACCESS_TOKEN`. Upstox's Analytics Token is free and read-only. The app polls candle endpoints; it does not yet connect to Upstox's WebSocket feed, so this is not tick-by-tick streaming.
* **`yahoo` (default if no provider is configured)** - Yahoo Finance's public chart endpoint: OHLCV, timestamps, 1-minute candles for NSE (`.NS`) with a BSE (`.BO`) fallback. No key. It is an *unofficial* endpoint intended for personal use: it may be delayed, rate-limited, or change without notice. Respect Yahoo's terms; do not use it commercially.
* **`twelvedata`** - adapter included; requires your own API key and a plan that covers NSE. It was written to the vendor's documented format but has not been run against a live key here.
* **Google Finance** - **not used.** It has no public real-time API and its terms/anti-bot protections do not permit scraping, and this project deliberately does not try to bypass them.
* **Provider selection:** add the chosen provider id and its required secret in `backend/.env`. In Vercel, configure the same variables under the backend service's Environment Variables and redeploy. Local `.env` files are ignored by Git, so changing one does not update Vercel.

## How live candles work

1. On load (and when you change stock/timeframe) the frontend requests the full history once: `GET /api/analysis/:symbol?interval=1m`.
2. After that it **polls** a small "tail" (the last ~6 candles and indicator points): every ~4 s for 1m-5m, 10-15 s for higher timeframes, ~45 s when the market is closed or the tab is hidden. The backend caches provider responses for a few seconds so many polls never hammer the vendor.
3. The tail is merged into the in-memory series and only the **latest candle is updated** on the chart (`series.update`) - no page reload, no full redraw. If a gap is detected (e.g. the laptop slept) it reloads the history.
4. This app uses controlled polling of candle endpoints. With Upstox, the current-session candle endpoint supplies refreshed candles, but the app does not yet use the Upstox WebSocket feed; updates are near-live and not tick-by-tick.
5. 3-minute candles are aggregated from real 1-minute candles (anchored to 09:15 IST). Times are shown in IST. Session VWAP resets each IST trading day.
6. Market hours (IST): pre-open 09:00-09:15, open 09:15-15:30, after-market afterwards; weekends are closed. The exchange holiday calendar is not available offline, so if no fresh candle arrives for 5 minutes during "open" hours the UI says the feed looks stale (possible holiday/delay) rather than pretending it is live. When closed, the last available candle is shown.

## How the **ANALYZE STOP LOSS** button works

It calls `POST /api/analysis/:symbol/stoploss` (direction `AUTO`, `LONG` or `SHORT`) and does **not** draw an arbitrary line. For a long trade it:

1. gathers protective anchors below entry: recent confirmed swing lows, static support levels, VWAP, EMA 20/50 and the signal-candle low (mirrored above entry for shorts);
2. discards anchors that are inside normal noise (< 0.5 ATR) or too far (> 3.5 ATR), and prefers the nearest *structural* anchor (swing/support);
3. adds a **volatility buffer** (0.30 ATR, more when ATR% is high or volume is thin);
4. keeps total risk between 0.8 and 3 ATR and rounds to the NSE 0.05 tick;
5. sets **Target 1** at the nearest level between 1R and 2.2R (otherwise 1.5R) and **Target 2** at the next level (otherwise 2.5R), placed just before the level;
6. reports entry, stop, risk, targets, risk/reward, a capped (<= 90%) confidence, and a plain-language "why this stop" list.

The levels are then drawn on the chart as ENTRY, STOP LOSS, TARGET 1/2 (plus support, resistance and VWAP) and watched live: reaching entry / stop / target raises an alert. If there is no active signal the result is labelled **conditional** and tells you what confirmation to wait for.

## How the signal and prediction engines work

* **Signal (0-100):** Trend 20 + Momentum 20 + Volume 20 + Structure 20 + Candlestick 10 + Market context 10, calculated for both long and short. A BUY/SELL needs a high enough score, clear separation between sides, enough of the 7-point confirmation checklist (price vs VWAP, EMA 9/20, RSI 50-70, MACD, volume, breakout/retest, candle structure) and **no false-breakout warning**. Otherwise the answer is `WAIT`. The shown signal only changes after **two consecutive candles** agree, so it does not flicker.
* **False breakouts / breakdowns:** a break of a significant level is checked for volume, rejection wick, close location and RSI divergence; failures are labelled `POSSIBLE FALSE BREAKOUT` and the app says not to enter immediately.
* **Prediction ("What is most likely to happen next?"):** transparent and rule-based - no machine learning and no randomness. Probability = blend of (a) the live evidence scores (bullish / bearish / sideways) and (b) how often, in this symbol's loaded history, bars with a similar bias were followed by an up / down / flat move over the next 10 candles (weight grows with sample size, shown in the UI). Probabilities are clamped to 5-85%. Each scenario lists trigger, expected zone, confirmations and invalidation.
* **Backtest:** replays the same signal and stop/target logic over the loaded candles (entry at next open, stop checked first, intraday exits at session end, 1% risk per trade for the drawdown figure, no costs/slippage). It is labelled as historical and is only as good as the amount of data the free provider gives (about 5 days of 1-minute candles).

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | provider configuration status |
| GET | `/api/search?q=` | symbol suggestions |
| GET | `/api/scanner/top10` | daily ranking of the ten highest setup-confidence shares in the built-in NSE scan list |
| GET | `/api/market/:symbol` | overview + quote + market status |
| GET | `/api/market/:symbol/candles?interval=1m` | `1m 3m 5m 15m 30m 1H 1D` |
| GET | `/api/market/:symbol/quote` | price, change, day high/low, volume |
| GET | `/api/analysis/:symbol?interval=&series=full\|tail\|none` | candles, indicator series and the full analysis (including the `intraday` call) |
| GET | `/api/analysis/:symbol/indicators` | indicator panel data |
| GET | `/api/analysis/:symbol/signals` | signal, setup, history, backtest |
| POST | `/api/analysis/:symbol/stoploss` | body `{ "direction": "AUTO", "interval": "1m" }` |
| POST | `/api/analysis/:symbol/prediction` | body `{ "interval": "5m" }` |

Errors are friendly JSON: `{ ok:false, error:{ code, message } }` with codes such as `INVALID_SYMBOL`, `NO_DATA`, `RATE_LIMIT`, `NETWORK`, `PROVIDER_NOT_CONFIGURED`, `MISSING_API_KEY`.

## Project structure

```
live-trading-analyzer/
├── backend/
│   ├── app.js, server.js
│   ├── controllers/marketController.js
│   ├── routes/marketRoutes.js
│   ├── services/ marketDataService · dailyScannerService · technicalAnalysisService · candleAnalysisService · signalEngine · predictionEngine
│   ├── utils/ indicators.js (RSI, EMA, SMA, MACD, VWAP, ATR, ADX, Bollinger, swings) · symbols.js
│   └── test/smoke.test.js   (runs against a local mock feed; synthetic candles exist only in this test)
├── frontend/ (Vite + React: pages/, components/, hooks/, services/, styles/)
├── README.md · start.bat · .gitignore
```

## Limitations

* Data availability and update timing depend on the selected provider. Upstox's REST candles are polled rather than streamed here; the Upstox WebSocket feed is not integrated yet.
* The Daily Top 10 ranks a built-in list of 28 NSE symbols using the latest available 5-minute candles. It is not a scan of every listed stock and does not run as a background job; it refreshes when opened and periodically while the page is open.
* Technical indicators describe the past; patterns fail often. Backtests ignore costs, slippage and gaps, and a high historical win rate does not predict future results.
* Probabilities are tendencies over roughly the next 10 candles, never a price target and never a time.
* Exchange holidays, circuit limits, corporate actions, news and fundamentals are not modelled.
* The tool cannot know your risk tolerance, position size or tax situation.

## Disclaimer

For personal education and analysis only. **This is not financial advice**, not a recommendation to buy or sell any security, and carries no guarantee of accuracy or profit. Trading involves a substantial risk of loss. You are solely responsible for your own decisions.

Charts powered by [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache-2.0, attribution logo shown on the chart).
