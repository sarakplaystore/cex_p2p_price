import { NextResponse } from "next/server";
import { getArbitrageAlertConfig, notifyArbitrageOpportunities } from "@/lib/alerts";
import { loadSideQuote } from "@/lib/exchanges";
import { EXCHANGES, type ExchangeQuote, type FiatCurrency } from "@/lib/p2p";

export const dynamic = "force-dynamic";
// Two fiat markets, each needing both sides of every exchange.
export const maxDuration = 60;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };
const FIATS: FiatCurrency[] = ["USD", "KHR"];

/**
 * Standalone arbitrage check for external schedulers (e.g. a free
 * cron-job.org job every minute), so alerts fire even when the dashboard is
 * closed. When ALERTS_CHECK_SECRET is set, callers must pass it as
 * ?secret=... or the x-alerts-secret header. ?force=1 bypasses the
 * re-alert cooldown (for manual tests).
 */
async function handle(request: Request) {
  const { searchParams } = new URL(request.url);
  const secret = process.env.ALERTS_CHECK_SECRET?.trim();
  if (secret) {
    const provided = searchParams.get("secret") ?? request.headers.get("x-alerts-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
    }
  }

  const requestedFiat = searchParams.get("fiat")?.toUpperCase();
  if (requestedFiat && requestedFiat !== "USD" && requestedFiat !== "KHR") {
    return NextResponse.json(
      { error: "Unsupported fiat market. Choose USD or KHR." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const fiats = requestedFiat ? [requestedFiat as FiatCurrency] : FIATS;
  const force = searchParams.get("force") === "1";
  const config = getArbitrageAlertConfig();

  const results = [];
  for (const fiat of fiats) {
    const exchanges: ExchangeQuote[] = await Promise.all(
      EXCHANGES.map(async ({ id }) => {
        const [buy, sell] = await Promise.all([
          loadSideQuote(id, "buy", fiat),
          loadSideQuote(id, "sell", fiat),
        ]);
        return { id, buy, sell };
      }),
    );
    const result = await notifyArbitrageOpportunities(exchanges, fiat, { config, force });
    results.push({
      fiat,
      opportunities: result.opportunities,
      alerted: result.due.length,
      sent: result.sent,
    });
  }

  return NextResponse.json(
    {
      checkedAt: new Date().toISOString(),
      minSpreadPercent: config.minSpreadPercent,
      cooldownSeconds: config.cooldownSeconds,
      telegramConfigured: config.botToken !== null && config.chatId !== null,
      results,
    },
    { headers: NO_STORE_HEADERS },
  );
}

export const GET = handle;
export const POST = handle;
