import { NextResponse, after } from "next/server";
import { getArbitrageAlertConfig, notifyArbitrageOpportunities } from "@/lib/alerts";
import { loadSideQuote } from "@/lib/exchanges";
import {
  DEFAULT_FIAT,
  EXCHANGES,
  exchangeSpread,
  type ExchangeQuote,
  type FiatCurrency,
  type QuotesPayload,
} from "@/lib/p2p";

export const dynamic = "force-dynamic";
// Allow for a sparse sell market requiring multiple time-limited page requests.
export const maxDuration = 30;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedFiat = searchParams.get("fiat")?.toUpperCase() ?? DEFAULT_FIAT;

  if (requestedFiat !== "USD" && requestedFiat !== "KHR") {
    return NextResponse.json(
      { error: "Unsupported fiat market. Choose USD or KHR." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const fiat = requestedFiat as FiatCurrency;
  const alertConfig = getArbitrageAlertConfig();
  const exchangeQuotes: ExchangeQuote[] = await Promise.all(
    EXCHANGES.map(async ({ id }) => {
      const [buy, sell] = await Promise.all([
        loadSideQuote(id, "buy", fiat),
        loadSideQuote(id, "sell", fiat),
      ]);
      return { id, buy, sell };
    }),
  );

  for (const quote of exchangeQuotes) {
    const summary = exchangeSpread(quote);
    quote.arbitrage = summary
      ? { ...summary, opportunity: summary.spreadPercent + 1e-9 >= alertConfig.minSpreadPercent }
      : null;
  }

  const payload: QuotesPayload = {
    asset: "USDT",
    fiat,
    paymentMethod: "ABA Bank",
    updatedAt: new Date().toISOString(),
    refreshAfterSeconds: 30,
    exchanges: exchangeQuotes,
  };

  // Alert as soon as an opportunity is seen on a refresh, without delaying
  // the dashboard response. notify* never throws.
  const notify = () =>
    notifyArbitrageOpportunities(exchangeQuotes, fiat, { config: alertConfig }).catch(() => undefined);
  try {
    after(notify);
  } catch {
    void notify();
  }

  return NextResponse.json(payload, { headers: NO_STORE_HEADERS });
}
