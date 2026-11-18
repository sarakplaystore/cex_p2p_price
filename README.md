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

## Deploy to Vercel

Import this repository into Vercel and keep the detected **Next.js** framework and default build settings. The `/api/quotes` route calls each exchange's public P2P marketplace endpoint server-side, so the browser does not make cross-origin exchange requests. There are no secrets to configure.

## Notes

- The ABA filter applies to both sides in USD and KHR. There is no USD price band or merchant-name blocklist.
- Results are ranked by price for the selected side, with one ad per merchant. The initial view shows two offers per side; show-more reveals up to 20 offers per side as provided by the exchange.
- Sell USDT lists merchants who buy USDT from you. If the first page doesn't contain two distinct ABA buyers, the dashboard checks subsequent pages of the same market (up to five pages of 20 ads). It stops when it finds enough buyers, runs out of listings, or sees a repeated page.
- An ad qualifies if at least one exchange-listed payment method identifies ABA Bank, even if the ad also accepts other methods. Ads with missing or unrecognized methods are excluded before ranking; if none qualify, no ads are shown for that side.
- Bybit ads list numeric payment-method ids only, and the endpoint that translates them is bot-protected and slow from server IPs. Bybit is therefore asked to filter ads by the ABA payment id server-side, with a built-in id/name fallback for the Cambodian methods; if that filter ever stops returning ABA ads, the dashboard restarts on the unfiltered book and verifies methods locally rather than showing nothing.
- The exchange endpoints are public marketplace interfaces, not guaranteed/stable APIs. If an exchange changes its response or blocks serverless requests, that exchange/side is shown as unavailable rather than substituting another bank or fabricated prices.
- P2P prices, limits, merchant status, and availability can change at any time. Confirm all details on the exchange before transferring money; this dashboard is informational only.
