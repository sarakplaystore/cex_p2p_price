# CEX P2P Price Radar

A Vercel-ready dashboard for comparing the best **USDT P2P buy and sell ads** on Binance, OKX, Bybit, and Bitget. Results are restricted to offers whose payment method is identified by the exchange as **ABA Bank**. Each side starts with the top two distinct merchants and lets you expand the list to see more, up to 20 merchants when the exchange has enough listings.

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

- Fiat markets are currently USD and KHR. ABA Bank's available listings vary by exchange and fiat.
- The exchange endpoints are public marketplace interfaces, not a guaranteed/stable API. If an exchange changes its response or blocks serverless requests, that exchange/side is shown as unavailable rather than substituting another bank or fabricated prices.
- Ads are filtered by the payment-method name returned by the exchange. Offers that do not expose a verifiable ABA label are intentionally excluded.
- Extreme prices more than 15% from the cross-exchange median are filtered when at least three exchanges provide usable listings. With fewer sources, prices are left unchanged rather than applying an unreliable reference.
- P2P prices, limits, merchant status, and availability can change at any time. Confirm all details on the exchange before transferring money; this dashboard is informational only.
