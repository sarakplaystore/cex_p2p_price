import { NextResponse } from "next/server";
import { loadSideQuote } from "@/lib/exchanges";
import { DEFAULT_FIAT, EXCHANGES, type FiatCurrency, type QuotesPayload } from "@/lib/p2p";

export const dynamic = "force-dynamic";

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
  const exchangeQuotes = await Promise.all(
    EXCHANGES.map(async ({ id }) => {
      const [buy, sell] = await Promise.all([
        loadSideQuote(id, "buy", fiat),
        loadSideQuote(id, "sell", fiat),
      ]);
      return { id, buy, sell };
    }),
  );
  const payload: QuotesPayload = {
    asset: "USDT",
    fiat,
    paymentMethod: "all",
    updatedAt: new Date().toISOString(),
    refreshAfterSeconds: 30,
    exchanges: exchangeQuotes,
  };

  return NextResponse.json(payload, { headers: NO_STORE_HEADERS });
}
