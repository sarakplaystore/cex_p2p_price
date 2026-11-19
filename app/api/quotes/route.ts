import { NextResponse, after } from "next/server";
import { getArbitrageAlertConfig, notifyArbitrageOpportunities } from "@/lib/alerts";
import { readBlocklistSettings, readMerchantBlocklistCookie, type MerchantBlocklistSettings } from "@/lib/blocklist";
import { loadSideQuote } from "@/lib/exchanges";
import {
  DEFAULT_BLOCKED_MERCHANTS,
  DEFAULT_FIAT,
  EXCHANGES,
  exchangeSpread,
  normalizeBlockedMerchants,
  type ExchangeQuote,
  type FiatCurrency,
  type QuotesPayload,
} from "@/lib/p2p";

export const dynamic = "force-dynamic";
// Allow for a sparse sell market requiring multiple time-limited page requests.
export const maxDuration = 30;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocklistError(message: string) {
  return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE_HEADERS });
}

/** The built-in list applies when neither the request nor the browser cookie carries one. */
function defaultBlocklist(): MerchantBlocklistSettings {
  return { enabled: true, merchants: normalizeBlockedMerchants(DEFAULT_BLOCKED_MERCHANTS) };
}

/**
 * A caller may send a plain list of merchant names (the shape the dashboard has
 * always posted) or a full `{ enabled, merchants }` blocklist.
 */
function toBlocklistSettings(value: unknown): MerchantBlocklistSettings {
  if (isRecord(value) && (value.enabled !== undefined || value.merchants !== undefined || value.names !== undefined)) {
    const settings = readBlocklistSettings(value);
    if (settings) return settings;
  }
  return { enabled: true, merchants: normalizeBlockedMerchants(value) };
}

/**
 * Precedence: the blocklist in this request, then the one saved in the browser
 * cookie, then the built-in defaults. The list is applied server-side before
 * ranking so the paging loop can pull an eligible merchant to replace a
 * blocked one, on every exchange, both sides, and both fiat markets.
 */
function resolveBlocklist(request: Request, explicit: unknown): MerchantBlocklistSettings {
  if (explicit !== undefined) return toBlocklistSettings(explicit);
  return readMerchantBlocklistCookie(request.headers.get("cookie")) ?? defaultBlocklist();
}

async function createQuotesResponse(requestedFiatValue: unknown, blocklist: MerchantBlocklistSettings) {
  const requestedFiat =
    typeof requestedFiatValue === "string" ? requestedFiatValue.toUpperCase() : DEFAULT_FIAT;

  if (requestedFiat !== "USD" && requestedFiat !== "KHR") {
    return NextResponse.json(
      { error: "Unsupported fiat market. Choose USD or KHR." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const fiat = requestedFiat as FiatCurrency;
  const blockedMerchants = blocklist.enabled ? blocklist.merchants : [];
  const alertConfig = getArbitrageAlertConfig();
  const exchangeQuotes: ExchangeQuote[] = await Promise.all(
    EXCHANGES.map(async ({ id }) => {
      const [buy, sell] = await Promise.all([
        loadSideQuote(id, "buy", fiat, blockedMerchants),
        loadSideQuote(id, "sell", fiat, blockedMerchants),
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
    blocklist: { enabled: blocklist.enabled, merchants: blockedMerchants },
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const blockedParam = searchParams.get("blocked");

  if (blockedParam !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blockedParam) as unknown;
    } catch {
      return blocklistError("The blocked merchant list must be valid JSON.");
    }
    if (!Array.isArray(parsed) && !isRecord(parsed)) {
      return blocklistError("The blocked merchant list must be an array.");
    }
    return createQuotesResponse(searchParams.get("fiat"), toBlocklistSettings(parsed));
  }

  return createQuotesResponse(searchParams.get("fiat"), resolveBlocklist(request, undefined));
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return blocklistError("Request body must be valid JSON.");
  }

  if (!isRecord(body)) {
    return blocklistError("Request body must be an object.");
  }

  // `blocklist` carries the enabled flag; `blockedMerchants` is the older
  // name-only list, which always means "blocking is on".
  const explicit = body.blocklist ?? body.blockedMerchants;
  if (body.blockedMerchants !== undefined && !Array.isArray(body.blockedMerchants)) {
    return blocklistError("blockedMerchants must be an array.");
  }

  return createQuotesResponse(
    body.fiat,
    explicit === undefined ? resolveBlocklist(request, undefined) : toBlocklistSettings(explicit),
  );
}
