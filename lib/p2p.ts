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
export const USD_OFFER_PRICE_RANGE = { min: 0.9, max: 1.015 } as const;

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
}

export interface QuotesPayload {
  asset: "USDT";
  fiat: FiatCurrency;
  paymentMethod: "ABA Bank";
  updatedAt: string;
  refreshAfterSeconds: number;
  exchanges: ExchangeQuote[];
}

/** Match a clearly named ABA payment method; do not treat other banks as ABA. */
export function hasAbaBankPayment(paymentMethods: string[]): boolean {
  return paymentMethods.some((method) => /(^|[^a-z])aba([^a-z]|$)/i.test(method));
}

/**
 * Maker sells USDT on the dashboard's Buy side. Apply the USD guard only to
 * those offers; KHR prices and maker-buy offers use different price scales.
 */
export function isWithinMakerSellPriceRange(offer: P2POffer): boolean {
  const makerSide = offer.side === "buy" ? "sell" : "buy";
  if (offer.fiat !== "USD" || makerSide !== "sell") return true;
  return offer.price >= USD_OFFER_PRICE_RANGE.min && offer.price <= USD_OFFER_PRICE_RANGE.max;
}

const EXCLUDED_OKX_USD_SELL_MERCHANTS = new Set([
  "kingxchanger001",
  "localcambodiapayeer",
]);

/** Hide the two requested OKX USD Sell merchants, matching names case-insensitively. */
export function isExcludedMerchant(offer: P2POffer): boolean {
  if (offer.exchange !== "okx" || offer.fiat !== "USD" || offer.side !== "sell") return false;
  return EXCLUDED_OKX_USD_SELL_MERCHANTS.has(offer.merchantName.trim().toLowerCase());
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
