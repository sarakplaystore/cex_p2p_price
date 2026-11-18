import {
  EXCHANGES,
  findArbitrageOpportunities,
  type ArbitrageOpportunity,
  type ExchangeQuote,
  type FiatCurrency,
} from "./p2p";

export interface ArbitrageAlertConfig {
  /** Minimum same-exchange spread, in percent of the buy price. Default 0.1 ($1.000 -> $1.001). */
  minSpreadPercent: number;
  /** How long a continuing opportunity stays quiet before it is re-alerted. Default 15 minutes. */
  cooldownSeconds: number;
  botToken: string | null;
  chatId: string | null;
}

function parsePositiveEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getArbitrageAlertConfig(env: NodeJS.ProcessEnv = process.env): ArbitrageAlertConfig {
  return {
    minSpreadPercent: parsePositiveEnv(env.ARBITRAGE_MIN_SPREAD_PERCENT, 0.1),
    cooldownSeconds: parsePositiveEnv(env.ARBITRAGE_ALERT_COOLDOWN_SECONDS, 15 * 60),
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    chatId: env.TELEGRAM_CHAT_ID?.trim() || null,
  };
}

export function exchangeName(id: ArbitrageOpportunity["exchange"]): string {
  return EXCHANGES.find((exchange) => exchange.id === id)?.name ?? id;
}

function formatPrice(value: number, fiat: FiatCurrency): string {
  return fiat === "USD" ? value.toFixed(4) : Math.round(value).toLocaleString("en-US");
}

/** e.g. "$2.99 per $1,000 traded" (USD) or "1,234 KHR per 1,000 KHR traded" (KHR). */
function formatProfitPerThousand(opportunity: ArbitrageOpportunity): string {
  const { profitPerThousand, fiat } = opportunity;
  return fiat === "USD"
    ? `$${profitPerThousand.toFixed(2)} per $1,000 traded`
    : `${Math.round(profitPerThousand).toLocaleString("en-US")} KHR per 1,000 KHR traded`;
}

/** Plain-text Telegram message (no parse mode, so merchant names need no escaping). */
export function formatArbitrageAlert(
  opportunities: readonly ArbitrageOpportunity[],
  minSpreadPercent: number,
  checkedAt: Date,
): string {
  const lines = [
    "🚨 P2P arbitrage opportunity",
    "",
  ];
  for (const opportunity of opportunities) {
    const fiat = opportunity.fiat;
    lines.push(
      `${exchangeName(opportunity.exchange)} — USDT/${fiat}`,
      `Buy:  ${formatPrice(opportunity.buyPrice, fiat)} ${fiat}/USDT from ${opportunity.buyMerchant}`,
      `Sell: ${formatPrice(opportunity.sellPrice, fiat)} ${fiat}/USDT to ${opportunity.sellMerchant}`,
      `Spread: +${formatPrice(opportunity.spread, fiat)} ${fiat} (+${opportunity.spreadPercent.toFixed(3)}%)`,
      `Profit: ≈ ${formatProfitPerThousand(opportunity)}`,
      "",
    );
  }
  lines.push(
    `Threshold: ≥ ${minSpreadPercent}% on the same exchange (ABA Bank ads only).`,
    `Checked: ${checkedAt.toISOString()}`,
    "Prices move fast — confirm both ads on the exchange before trading.",
  );
  return lines.join("\n");
}

const TELEGRAM_TIMEOUT_MS = 5_000;

export async function sendTelegramMessage(
  config: ArbitrageAlertConfig,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.botToken || !config.chatId) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await fetchFn(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[P2P Radar] Telegram alert failed: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[P2P Radar] Telegram alert failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Best-effort in-memory de-duplication: an opportunity alerts as soon as it
 * appears, then stays quiet for the cooldown while it persists, and alerts
 * immediately again if it disappears and comes back. State lives per server
 * instance, so a cold start can re-alert once — acceptable for a price alert.
 */
const lastAlertedAt = new Map<string, number>();

export function resetArbitrageAlertState(): void {
  lastAlertedAt.clear();
}

function opportunityKey(opportunity: ArbitrageOpportunity): string {
  return `${opportunity.exchange}:${opportunity.fiat}`;
}

export interface ArbitrageNotificationResult {
  opportunities: ArbitrageOpportunity[];
  due: ArbitrageOpportunity[];
  telegramConfigured: boolean;
  sent: boolean;
}

export async function notifyArbitrageOpportunities(
  exchanges: readonly ExchangeQuote[],
  fiat: FiatCurrency,
  options: {
    config?: ArbitrageAlertConfig;
    now?: Date;
    force?: boolean;
    fetchFn?: typeof fetch;
  } = {},
): Promise<ArbitrageNotificationResult> {
  const config = options.config ?? getArbitrageAlertConfig();
  const now = options.now ?? new Date();
  const opportunities = findArbitrageOpportunities(exchanges, fiat, config.minSpreadPercent);
  const telegramConfigured = Boolean(config.botToken && config.chatId);

  // Forget opportunities that have closed so a reappearance alerts at once.
  const activeKeys = new Set(opportunities.map(opportunityKey));
  for (const key of [...lastAlertedAt.keys()]) {
    if (key.endsWith(`:${fiat}`) && !activeKeys.has(key)) lastAlertedAt.delete(key);
  }

  const cooldownMs = config.cooldownSeconds * 1000;
  const due = opportunities.filter((opportunity) => {
    if (options.force) return true;
    const last = lastAlertedAt.get(opportunityKey(opportunity));
    return last === undefined || now.getTime() - last >= cooldownMs;
  });

  let sent = false;
  if (due.length && telegramConfigured) {
    sent = await sendTelegramMessage(
      config,
      formatArbitrageAlert(due, config.minSpreadPercent, now),
      options.fetchFn,
    );
    if (sent) {
      for (const opportunity of due) lastAlertedAt.set(opportunityKey(opportunity), now.getTime());
    }
  }

  return { opportunities, due, telegramConfigured, sent };
}
