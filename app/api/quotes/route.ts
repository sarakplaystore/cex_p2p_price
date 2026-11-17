import { NextResponse } from "next/server";
import { loadSideQuote } from "@/lib/exchanges";
import {
  DEFAULT_BLOCKED_MERCHANTS,
  DEFAULT_FIAT,
  EXCHANGES,
  normalizeBlockedMerchantNames,
  type FiatCurrency,
  type QuotesPayload,
} from "@/lib/p2p";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createQuotesResponse(
  requestedFiatValue: unknown,
  blockedMerchantNamesValue: unknown,
) {
  const requestedFiat =
    typeof requestedFiatValue === "string" ? requestedFiatValue.toUpperCase() : DEFAULT_FIAT;
  if (requestedFiat !== "USD" && requestedFiat !== "KHR") {
    return NextResponse.json(
      { error: "Unsupported fiat market. Choose USD or KHR." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const fiat = requestedFiat as FiatCurrency;
  const blockedMerchantNames = normalizeBlockedMerchantNames(blockedMerchantNamesValue);
  const exchangeQuotes = await Promise.all(
    EXCHANGES.map(async ({ id }) => {
      const [buy, sell] = await Promise.all([
        loadSideQuote(id, "buy", fiat, blockedMerchantNames),
        loadSideQuote(id, "sell", fiat, blockedMerchantNames),
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

  return NextResponse.json(payload, { headers: NO_STORE_HEADERS });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const blockedParam = searchParams.get("blocked");
  let blockedMerchantNames: unknown = DEFAULT_BLOCKED_MERCHANTS;

  if (blockedParam !== null) {
    try {
      blockedMerchantNames = JSON.parse(blockedParam) as unknown;
    } catch {
      return NextResponse.json(
        { error: "The blocked merchant list must be valid JSON." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    if (!Array.isArray(blockedMerchantNames)) {
      return NextResponse.json(
        { error: "The blocked merchant list must be an array." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
  }

  return createQuotesResponse(searchParams.get("fiat"), blockedMerchantNames);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (!isRecord(body)) {
    return NextResponse.json(
      { error: "Request body must be an object." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const blockedMerchantNames = body.blockedMerchants ?? DEFAULT_BLOCKED_MERCHANTS;
  if (!Array.isArray(blockedMerchantNames)) {
    return NextResponse.json(
      { error: "blockedMerchants must be an array." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  return createQuotesResponse(body.fiat, blockedMerchantNames);
}
