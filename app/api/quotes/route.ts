import { NextResponse } from "next/server";
import { loadSideQuote } from "@/lib/exchanges";
import { DEFAULT_FIAT, EXCHANGES, type FiatCurrency, type QuotesPayload } from "@/lib/p2p";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedFiat = searchParams.get("fiat")?.toUpperCase() ?? DEFAULT_FIAT;

  if (requestedFiat !== "USD" && requestedFiat !== "KHR") {
    return NextResponse.json(
      { error: "Unsupported fiat market. Choose USD or KHR." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
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
    paymentMethod: "ABA Bank",
    updatedAt: new Date().toISOString(),
    refreshAfterSeconds: 30,
    exchanges: exchangeQuotes,
  };

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20",
    },
  });
}
