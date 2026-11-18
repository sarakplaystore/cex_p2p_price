export const EXCHANGES = [
  { id: "binance", name: "Binance", monogram: "B", color: "#f0b90b" },
  { id: "okx", name: "OKX", monogram: "OKX", color: "#17191f" },
  { id: "bybit", name: "Bybit", monogram: "By", color: "#f7a600" },
  { id: "bitget", name: "Bitget", monogram: "BG", color: "#12b6a0" },
] as const;

export type ExchangeId = (typeof EXCHANGES)[number]["id"];
export type FiatCurrency = "USD" | "KHR";
export const DEFAULT_FIAT: FiatCurrency = "USD";
export type P2PSide = "buy" | "sell";
export type QuoteStatus = "live" | "empty" | "error";

export const INITIAL_MERCHANT_LIMIT = 2;
export const MERCHANTS_PER_SHOW_MORE = 2;
export const MAX_MERCHANTS_PER_SIDE = 20;

export interface P2POffer {
  id: string;
  exchange: ExchangeId;
  side: P2PSide;
  merchantId: string | null;
  merchantName: string;
  price: number;
  fiat: FiatCurrency;
  paymentMethods: string[];
  minFiat: number | null;
  maxFiat: number | null;
  availableUsdt: number | null;
  tradeCount: number | null;
  completionRate: number | null;
  verified: boolean;
}

export interface SideQuote {
  status: QuoteStatus;
  offers: P2POffer[];
  message?: string;
}

export interface ExchangeQuote {
  id: ExchangeId;
  buy: SideQuote;
  sell: SideQuote;
  /** Same-exchange buy/sell spread summary at the best prices, when both sides are live. */
  arbitrage?: {
    spread: number;
    spreadPercent: number;
    opportunity: boolean;
  } | null;
}

export interface ArbitrageOpportunity {
  exchange: ExchangeId;
  fiat: FiatCurrency;
  buyMerchant: string;
  buyPrice: number;
  sellMerchant: string;
  sellPrice: number;
  /** sellPrice - buyPrice, in fiat per USDT. */
  spread: number;
  /** Spread as a percentage of the buy price, e.g. 0.1 for $1.000 -> $1.001. */
  spreadPercent: number;
}

/**
 * Per-exchange arbitrage: the best ad to sell USDT into pays more than the
 * best ad to buy USDT from, on the same exchange and fiat market. Only live
 * ABA-verified offers returned to the dashboard are considered.
 */
export function findArbitrageOpportunities(
  exchanges: readonly ExchangeQuote[],
  fiat: FiatCurrency,
  minSpreadPercent: number,
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];

  for (const { id, buy, sell } of exchanges) {
    if (buy.status !== "live" || sell.status !== "live") continue;
    const bestBuy = buy.offers.reduce<P2POffer | null>(
      (best, offer) => (best === null || offer.price < best.price ? offer : best),
      null,
    );
    const bestSell = sell.offers.reduce<P2POffer | null>(
      (best, offer) => (best === null || offer.price > best.price ? offer : best),
      null,
    );
    if (!bestBuy || !bestSell || bestBuy.price <= 0) continue;

    const spread = bestSell.price - bestBuy.price;
    const spreadPercent = (spread / bestBuy.price) * 100;
    // Compare with a small epsilon so an exact-threshold spread (e.g. the
    // $1.000 -> $1.001 example) is not lost to floating-point rounding.
    if (spreadPercent + 1e-9 < minSpreadPercent) continue;

    opportunities.push({
      exchange: id,
      fiat,
      buyMerchant: bestBuy.merchantName,
      buyPrice: bestBuy.price,
      sellMerchant: bestSell.merchantName,
      sellPrice: bestSell.price,
      spread,
      spreadPercent,
    });
  }

  return opportunities.sort((left, right) => right.spreadPercent - left.spreadPercent);
}

/** Best-price buy/sell spread for one exchange, or null when either side is not live. */
export function exchangeSpread(
  quote: ExchangeQuote,
): { spread: number; spreadPercent: number } | null {
  if (quote.buy.status !== "live" || quote.sell.status !== "live") return null;
  const buyPrice = Math.min(...quote.buy.offers.map((offer) => offer.price));
  const sellPrice = Math.max(...quote.sell.offers.map((offer) => offer.price));
  if (!Number.isFinite(buyPrice) || !Number.isFinite(sellPrice) || buyPrice <= 0) return null;
  const spread = sellPrice - buyPrice;
  return { spread, spreadPercent: (spread / buyPrice) * 100 };
}

export interface QuotesPayload {
  asset: "USDT";
  fiat: FiatCurrency;
  paymentMethod: "ABA Bank";
  updatedAt: string;
  refreshAfterSeconds: number;
  exchanges: ExchangeQuote[];
}

export const DEFAULT_BLOCKED_MERCHANTS = [
  "KingXchanger001",
  "Localcambodiapayeer",
] as const;
export const MAX_BLOCKED_MERCHANTS = 50;
const MAX_BLOCKED_MERCHANT_NAME_LENGTH = 80;

/** Trim, deduplicate case-insensitively, and bound browser/API blocklist input. */
export function normalizeBlockedMerchantNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const name = candidate.trim();
    if (!name || name.length > MAX_BLOCKED_MERCHANT_NAME_LENGTH) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === MAX_BLOCKED_MERCHANTS) break;
  }
  return names;
}

/** Match merchant names exactly, ignoring surrounding spaces and letter case. */
export function isMerchantBlocked(offer: P2POffer, blockedNames: readonly string[]): boolean {
  const merchantName = offer.merchantName.trim().toLowerCase();
  return blockedNames.some((name) => name.trim().toLowerCase() === merchantName);
}

/** ABA must be a named method, not a substring of a different bank's name. */
export function hasAbaBankPayment(paymentMethods: readonly string[]): boolean {
  return paymentMethods.some((method) =>
    /(?:^|[^a-z0-9])(?:aba(?:bank)?|advanced bank of asia)(?:$|[^a-z0-9])/i.test(method),
  );
}

/**
 * Filter to ABA-only offers, rank best price first, and keep one ad per trader.
 * For a user buying USDT, lower is better; for a user selling USDT, higher is better.
 */
export function selectTopMerchants(
  offers: P2POffer[],
  side: P2PSide,
  limit = INITIAL_MERCHANT_LIMIT,
): P2POffer[] {
  const ranked = offers
    .filter(
      (offer) =>
        Number.isFinite(offer.price) &&
        offer.price > 0 &&
        hasAbaBankPayment(offer.paymentMethods),
    )
    .slice()
    .sort((left, right) => {
      const priceOrder =
        side === "buy" ? left.price - right.price : right.price - left.price;
      return priceOrder || left.merchantName.localeCompare(right.merchantName);
    });

  const seenMerchants = new Set<string>();
  const selected: P2POffer[] = [];

  for (const offer of ranked) {
    const name = offer.merchantName.trim().toLocaleLowerCase();
    const merchantKey = offer.merchantId?.trim() || (name && name !== "p2p merchant" ? name : offer.id);
    if (seenMerchants.has(merchantKey)) continue;

    seenMerchants.add(merchantKey);
    selected.push(offer);
    if (selected.length === limit) break;
  }

  return selected;
}

export function normalizeCompletionRate(value: unknown): number | null {
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/,/g, "");
    const parsed = Number.parseFloat(cleaned.replace(/%$/, ""));
    if (!Number.isFinite(parsed)) return null;
    const percent = cleaned.endsWith("%") ? parsed : parsed <= 1 ? parsed * 100 : parsed;
    return Math.max(0, Math.min(100, percent));
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const percent = value <= 1 ? value * 100 : value;
    return Math.max(0, Math.min(100, percent));
  }

  return null;
}
