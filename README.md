# CEX P2P Price Radar

A Vercel-ready dashboard for comparing **USDT P2P buy and sell ads that accept ABA Bank** on Binance, OKX, Bybit, and Bitget. Each side starts with the top two distinct merchants and lets you expand the list to see more, up to 20 merchants when the exchange has enough listings.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The dashboard starts with USD selected and refreshes every 30 seconds; use the USD/KHR selector to change the fiat market. No API keys or environment variables are required.

```bash
npm test
npm run build
```

## Arbitrage Telegram alerts

When the best **sell** price on an exchange beats the best **buy** price on the *same* exchange by at least **0.1%** (for example OKX buy $1.000 → sell $1.001), the dashboard sends a Telegram alert naming the exchange, both merchants, and the spread. The exchange card also shows an `ARB` badge. Alerts are checked on every dashboard refresh (every 30 seconds) and via the standalone check endpoint below. A continuing opportunity re-alerts at most once per cooldown (default 15 minutes); if it closes and reappears, it alerts again immediately.

Setup (no alert is sent until these are set):

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat.id` value.
3. In Vercel → your project → Settings → Environment Variables (Production), add:
   - `TELEGRAM_BOT_TOKEN` — the BotFather token
   - `TELEGRAM_CHAT_ID` — your chat id
   - Optional: `ARBITRAGE_MIN_SPREAD_PERCENT` (default `0.1`), `ARBITRAGE_ALERT_COOLDOWN_SECONDS` (default `900`), `ALERTS_CHECK_SECRET` (protects the check endpoint).

To get alerts even when the dashboard is closed, ping the check endpoint every minute with a free scheduler such as [cron-job.org](https://cron-job.org):

```text
GET https://<your-domain>/api/alerts/check?secret=<ALERTS_CHECK_SECRET>
```

It checks both USD and KHR markets on all four exchanges and returns a JSON summary (which opportunities were found, whether Telegram is configured, and whether an alert was sent). Add `?force=1` to bypass the cooldown for a manual test.

## Deploy to Vercel

Import this repository into Vercel and keep the detected **Next.js** framework and default build settings. The `/api/quotes` route calls each exchange's public P2P marketplace endpoint server-side, so the browser does not make cross-origin exchange requests. There are no secrets to configure.

## Notes

- The ABA filter applies to both sides in USD and KHR. There is no USD price band.
- The dashboard has an editable merchant blocklist with an on/off mode. It applies globally across exchanges, sides, and fiat markets, matches names case-insensitively, and is saved in the current browser. It starts with `KingXchanger001` and `Localcambodiapayeer` blocked. Blocked merchants are removed before ranking (the loader keeps paging for eligible replacements), before arbitrage calculation, and the standalone alert check uses the same default blocklist.
- Results are ranked by price for the selected side, with one ad per merchant. The initial view shows two offers per side; show-more reveals up to 20 offers per side as provided by the exchange.
- Sell USDT lists merchants who buy USDT from you. If the first page doesn't contain two distinct ABA buyers, the dashboard checks subsequent pages of the same market (up to five pages of 20 ads). It stops when it finds enough buyers, runs out of listings, or sees a repeated page.
- An ad qualifies if at least one exchange-listed payment method identifies ABA Bank, even if the ad also accepts other methods. Ads with missing or unrecognized methods are excluded before ranking; if none qualify, no ads are shown for that side.
- Bybit ads list numeric payment-method ids only, and the endpoint that translates them is bot-protected and slow from server IPs. Bybit is therefore asked to filter ads by the ABA payment id server-side, with a built-in id/name fallback for the Cambodian methods; if that filter ever stops returning ABA ads, the dashboard restarts on the unfiltered book and verifies methods locally rather than showing nothing.
- The exchange endpoints are public marketplace interfaces, not guaranteed/stable APIs. If an exchange changes its response or blocks serverless requests, that exchange/side is shown as unavailable rather than substituting another bank or fabricated prices.
- P2P prices, limits, merchant status, and availability can change at any time. Confirm all details on the exchange before transferring money; this dashboard is informational only.
