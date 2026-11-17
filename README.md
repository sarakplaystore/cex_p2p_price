# CEX P2P Price Radar

A Vercel-ready dashboard for comparing **USDT P2P buy and sell ads** on Binance, OKX, Bybit, and Bitget. It includes offers across payment methods and merchant names, with no USD price-range restriction. Each side starts with the top two distinct merchants and lets you expand the list to see more, up to 20 merchants when the exchange has enough listings.

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

- Fiat markets are currently USD and KHR, with USD selected by default. Offers are not filtered by payment method, the former $0.90–$1.015 USD maker-sell range, or merchant name.
- Results are ranked by price for the selected side, with one ad per merchant. The initial view shows two offers per side; show-more reveals up to 20 offers per side as provided by the exchange.
- Payment-method names are displayed when the exchange returns them; offers are not excluded when a method is non-ABA or unavailable in the response.
- The exchange endpoints are public marketplace interfaces, not guaranteed/stable APIs. If an exchange changes its response or blocks serverless requests, that exchange/side is shown as unavailable rather than substituting another bank or fabricated prices.
- P2P prices, limits, merchant status, and availability can change at any time. Confirm all details on the exchange before transferring money; this dashboard is informational only.
