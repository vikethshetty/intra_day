# Live Intraday Analyzer

A personal, single-page **technical-analysis dashboard for NSE/BSE stocks**: live candlestick chart, indicators, support/resistance, a technically-justified stop-loss tool, a 100-point signal score, scenario probabilities and a basic backtest.

* **Analysis only.** It never places trades, has no broker/order API, and needs **no login, no personal information, no trading account**.
* **Nothing is guaranteed.** Every output is a technical-analysis *estimate*. This is **not financial advice**.
* **Never invents data.** If live data cannot be loaded you see `LIVE DATA UNAVAILABLE` with the time of the last successful update - not made-up prices.

Stack: React + Vite + Bootstrap 5 + Bootstrap Icons + TradingView Lightweight Charts (frontend) · Node.js + Express (backend).

---

## Views (tabs)

* **Intraday today** (default) - one trading session only. A big, plain call at the top:
  **YES - BUY NOW**, **SELL NOW**, or **WAIT** (with the reason), plus where to enter, the stop-loss, Target 1 and Target 2.
  Press **Track this trade** and the *My trade tracker* box tells you live: *hold*, *Target 1 hit - book half and move the stop to entry*, *Target 2 hit - book full profit*, or *Stop loss hit - exit now*. A browser notification (bell icon) can announce a new BUY NOW / SELL NOW call.
* **Daily Top 10** - ranks the highest-confidence setups from NSE mainboard and SME equities.
* **Nifty 50 Analysis** - separately scans the current 50 Nifty constituents, ranks their Top 10 setups, and includes a confidence-based historical backtest for 1 week, 2 weeks, 3 weeks, 1 month or 2 months.
* **Daily Top 10 backtesting** - backtests the ten shares in the current full-market Daily Top 10 ranking over the same date ranges.
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

Edit the existing ignored `backend/.env` for local settings. Keep it out of Git. Use Yahoo for technical analysis/backtesting and set your Upstox token for live quotes/charts and tracked-trade monitoring:

```
PORT=5000
FRONTEND_URL=http://localhost:5173
MARKET_DATA_PROVIDER=yahoo
UPSTOX_ACCESS_TOKEN=your_upstox_access_token
```

| Variable | Meaning |
|---|---|
| `PORT` | Backend port (default 5000) |
| `FRONTEND_URL` | Allowed browser origin (localhost on any port is always allowed) |
| `MARKET_DATA_PROVIDER` | Defaults provider-backed routes to `yahoo`; the app explicitly uses Yahoo for analysis/scanning and Upstox for live quotes/charts and tracked-trade monitoring. |
| `UPSTOX_ACCESS_TOKEN` | Your Upstox access token. Keep it secret; Upstox tokens expire at 3:30 AM the following day, so refresh it when required. |
| `MARKET_DATA_API_KEY` | Optional Twelve Data key. It is not used as an Upstox token. |

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

* **`upstox`** - Used for the searched stock's live quote and chart, and active trade tracking. It requires `UPSTOX_ACCESS_TOKEN`. The app polls REST candles and LTP while NSE is open; it does not yet connect to the Upstox WebSocket feed.
* **`yahoo`** - Used for technical analysis, one-month history, broad-market Top 10 scanning, and backtesting. It reads Yahoo Finance's public chart endpoint, which may be delayed, rate-limited, or change without notice.
* **`twelvedata`** - adapter included; requires your own API key and a plan that covers NSE. It was written to the vendor's documented format but has not been run against a live key here.
* **Google Finance** - **not used.** It has no public real-time API and its terms/anti-bot protections do not permit scraping, and this project deliberately does not try to bypass them.
* **Provider selection:** provider choice is made by task in the app. The selected stock's live quote and chart use Upstox; technical analysis, one-month history, scanners and backtesting use Yahoo. Tracked-trade monitoring also uses Upstox. In Vercel, add `UPSTOX_ACCESS_TOKEN` to the backend service's Environment Variables and redeploy. Local `.env` files are ignored by Git, so changing one does not update Vercel.

## How live candles work

1. On load (and when you change stock/timeframe) the frontend requests Yahoo history/analysis and Upstox quote/chart data in parallel.
2. While NSE is open, it polls Upstox's LTP and candle endpoints every 15 seconds and Yahoo's analysis tail on the same cadence. It polls every 45 seconds when the market is closed and every 30 seconds while the browser tab is hidden. This REST polling is not tick-by-tick streaming.
3. Upstox candles and indicator points are merged into the chart in memory; the latest candle is updated without a page reload. If a gap is detected (e.g. the laptop slept), the hook reloads the full candle set.
4. Analysis, signals, entry/target levels, one-month history, scanners and backtests remain Yahoo-based. When a trade is tracked, a separate Upstox endpoint monitors current-session candles more frequently.
5. When a provider lacks a requested interval, the app aggregates real 1-minute candles (anchored to 09:15 IST). Times are shown in IST. Session VWAP resets each IST trading day.
6. Market hours (IST): pre-open 09:00-09:15, open 09:15-15:30, after-market afterwards; weekends are closed. The exchange holiday calendar is not available offline, so if no fresh candle arrives for 5 minutes during "open" hours the UI says the feed looks stale (possible holiday/delay) rather than pretending it is live. When closed, the last available candle is shown.

## How the **ANALYZE STOP LOSS** button works

It calls `POST /api/analysis/:symbol/stoploss` (direction `AUTO`, `LONG` or `SHORT`) and does **not** draw an arbitrary line. For a long trade it:

1. gathers protective anchors below entry: recent confirmed swing lows, static support levels, VWAP, EMA 20/50 and the signal-candle low (mirrored above entry for shorts);
2. discards anchors that are inside normal noise (< 0.5 ATR) or too far (> 3.5 ATR), and prefers the nearest *structural* anchor (swing/support);
3. adds a **volatility buffer** (0.30 ATR, more when ATR% is high or volume is thin);
4. keeps total risk between 0.8 and 3 ATR and rounds to the NSE 0.05 tick;
5. sets **Target 1** at the nearest level between 1R and 2.2R (otherwise 1.5R) and **Target 2** at the next level (otherwise 2.5R), placed just before the level;
6. reports entry, stop, risk, targets, risk/reward, and a capped (<= 90%) confidence. Confidence includes the one-month daily trend; intraday candlestick patterns can set a breakout confirmation and measured-move targets.

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
| GET | `/api/scanner/top10?offset=0` | one batch from the NSE equity scan; the browser advances `offset` until `done: true` |
| GET | `/api/scanner/nifty50/top10?offset=0` | one batch from the current official Nifty 50 constituents; the browser advances `offset` until `done: true` |
| GET | `/api/scanner/nifty50/backtest?offset=0&periodDays=7&endTime=...` | one batch of Nifty 50 confidence-based historical simulations |
| GET | `/api/scanner/top10/backtest?symbols=...&offset=0&periodDays=7&endTime=...` | one batch of historical simulations for the current Daily Top 10 shares |
| GET | `/api/market/:symbol` | overview + quote + market status |
| GET | `/api/market/:symbol/candles?interval=1m` | `1m 3m 5m 15m 30m 1H 1D` |
| GET | `/api/market/:symbol/quote` | price, change, day high/low, volume |
| GET | `/api/live/:symbol?interval=1m&series=full` | Upstox live quote and chart candles; analysis remains on Yahoo |
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
* Daily Top 10 processes the current NSE mainboard and SME equity lists in small batches using Yahoo's 5-minute candles. It requires at least 25 calendar days of history, includes the one-month daily trend in confidence, and skips symbols without that history. Recent intraday candle patterns can shape entry confirmation and measured-move targets. The browser saves progress locally and resumes an interrupted scan.
* Nifty 50 Analysis is a separate scan using the current constituent CSV published by NSE Indices. It has its own ranking and saved scan progress, independent of the full-market Daily Top 10.
* The Nifty 50 and Daily Top 10 backtests use hourly Yahoo candles for the selected 1-week to 2-month period. They replay stable BUY/SELL calls that pass a 70% confidence floor and report trade counts, win rate, planned risk/reward, and realized R multiples. They do not assume account capital, position sizes, or rupee profit. Trades across symbols are combined for analysis, not modelled as one account. Results exclude brokerage, taxes and slippage; current list membership is applied retrospectively.
* Technical indicators describe the past; patterns fail often. Backtests ignore costs, slippage and gaps, and a high historical win rate does not predict future results.
* Probabilities are tendencies over roughly the next 10 candles, never a price target and never a time.
* Exchange holidays, circuit limits, corporate actions, news and fundamentals are not modelled.
* The tool cannot know your risk tolerance, position size or tax situation.

## Disclaimer

For personal education and analysis only. **This is not financial advice**, not a recommendation to buy or sell any security, and carries no guarantee of accuracy or profit. Trading involves a substantial risk of loss. You are solely responsible for your own decisions.

Charts powered by [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache-2.0, attribution logo shown on the chart).
