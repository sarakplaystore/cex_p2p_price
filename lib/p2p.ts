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
  /** Ads dropped because their merchant is blocked, so the UI can say so. */
  hiddenByBlocklist?: number;
}

export interface ExchangeQuote {
  id: ExchangeId;
  buy: SideQuote;
  sell: SideQuote;
  /** Same-exchange buy/sell spread summary at the best prices, when both sides are live. */
  arbitrage?: {
    spread: number;
    spreadPercent: number;
    /** Fiat profit per 1,000 fiat traded at the best prices, e.g. 1 for $1.000 -> $1.001. */
    profitPerThousand: number;
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
  /** Fiat profit per 1,000 fiat traded at these prices, e.g. 1 for $1.000 -> $1.001. */
  profitPerThousand: number;
}

/**
 * Fiat profit from spending 1,000 fiat to buy USDT at `buyPrice` and immediately
 * reselling it all at `sellPrice` (before exchange fees), e.g. buying at $1.000
 * and selling at $1.001 earns $1.00 per $1,000 traded.
 */
export function arbitrageProfitPerThousand(buyPrice: number, sellPrice: number): number {
  return ((sellPrice - buyPrice) / buyPrice) * 1000;
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
      profitPerThousand: arbitrageProfitPerThousand(bestBuy.price, bestSell.price),
    });
  }

  return opportunities.sort((left, right) => right.spreadPercent - left.spreadPercent);
}

/** Best-price buy/sell spread for one exchange, or null when either side is not live. */
export function exchangeSpread(
  quote: ExchangeQuote,
): { spread: number; spreadPercent: number; profitPerThousand: number } | null {
  if (quote.buy.status !== "live" || quote.sell.status !== "live") return null;
  const buyPrice = Math.min(...quote.buy.offers.map((offer) => offer.price));
  const sellPrice = Math.max(...quote.sell.offers.map((offer) => offer.price));
  if (!Number.isFinite(buyPrice) || !Number.isFinite(sellPrice) || buyPrice <= 0) return null;
  const spread = sellPrice - buyPrice;
  return {
    spread,
    spreadPercent: (spread / buyPrice) * 100,
    profitPerThousand: arbitrageProfitPerThousand(buyPrice, sellPrice),
  };
}

export interface QuotesPayload {
  asset: "USDT";
  fiat: FiatCurrency;
  paymentMethod: "ABA Bank";
  updatedAt: string;
  refreshAfterSeconds: number;
  exchanges: ExchangeQuote[];
  /** Merchant blocklist the server actually applied, for debugging/verification. */
  blocklist?: { enabled: boolean; merchants: BlockedMerchant[] };
}

export const DEFAULT_BLOCKED_MERCHANTS = [
  "KingXchanger001",
  "Localcambodiapayeer",
] as const;
/** How many advertisers one browser can block. */
export const MAX_BLOCKED_MERCHANTS = 50;
/** Exchange anchors kept with one block, so a rename on one exchange cannot undo it. */
export const MAX_MERCHANT_IDS_PER_BLOCK = 8;
const MAX_BLOCKED_MERCHANT_NAME_LENGTH = 80;
const MAX_MERCHANT_ID_LENGTH = 80;

/**
 * Rows with no advertiser name fall back to this placeholder. It is shared by
 * unrelated advertisers, so blocking it would hide the whole market: such ads
 * can only be blocked by their exchange advertiser ID.
 */
const ANONYMOUS_MERCHANT_NAME_KEYS = new Set(["p2pmerchant", "p2pmerchants"]);

/**
 * Decoration advertisers wrap the same name with on different exchanges
 * (spaces, dashes, dots, the middot CJK listings use). Only separators are
 * removed, so letters and digits in any script keep telling names apart.
 */
const MERCHANT_NAME_DECORATION = /[\s\-_.,·•°|/\\()[\]{}<>~`!@#$%^&*+=?:;"'’“”]/g;

/** Separates the exchange from the advertiser ID inside a block anchor. */
export const MERCHANT_ID_SEPARATOR = ":";

const EXCHANGE_IDS = new Set<string>(EXCHANGES.map((exchange) => exchange.id));

export interface BlockedMerchantId {
  exchange: ExchangeId;
  merchantId: string;
}

export interface BlockedMerchant {
  /** Advertiser name as blocked; "" when only the exchange ID identifies it. */
  name: string;
  /** Exchange-scoped advertiser IDs that belong to this same advertiser. */
  ids: BlockedMerchantId[];
}

/** What a caller may hand the filter: plain names (legacy shape), full entries, or both. */
export type MerchantBlocklistInput = readonly (string | BlockedMerchant)[];

/** Compiled once per refresh; `loadSideQuote` filters thousands of rows with it. */
export interface MerchantBlocklist {
  merchants: readonly BlockedMerchant[];
  /** Loose name keys that hide an advertiser on every exchange and both sides. */
  nameKeys: readonly string[];
  /** `exchange:id` anchors that hide an advertiser even under a renamed display name. */
  idKeys: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asExchangeId(value: unknown): ExchangeId | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return EXCHANGE_IDS.has(id) ? (id as ExchangeId) : null;
}

function cleanMerchantName(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value.trim();
  // Oversized names are input errors rather than advertisers; drop them whole.
  return name.length === 0 || name.length > MAX_BLOCKED_MERCHANT_NAME_LENGTH ? "" : name;
}

/**
 * Key that survives casing plus spaces and punctuation, so "King-Xchanger.001"
 * on Binance and "king xchanger 001" on OKX collapse to the same advertiser.
 */
export function merchantMatchKey(name: string): string {
  return name.toLowerCase().replace(MERCHANT_NAME_DECORATION, "");
}

/** Guard against a blocklist that hides every ad because every key is empty. */
export function isBlockableMerchantName(name: string): boolean {
  const key = merchantMatchKey(name);
  return key.length > 0 && !ANONYMOUS_MERCHANT_NAME_KEYS.has(key);
}

export function blockedMerchantIdKey(exchange: ExchangeId, merchantId: string): string {
  return `${exchange}${MERCHANT_ID_SEPARATOR}${merchantId.trim().toLowerCase()}`;
}

/** `"bybit:123"` or `{ exchange, merchantId }` — both are accepted from clients. */
function toBlockedMerchantId(value: unknown): BlockedMerchantId | null {
  if (typeof value === "string") {
    const separator = value.indexOf(MERCHANT_ID_SEPARATOR);
    if (separator <= 0) return null;
    const exchange = asExchangeId(value.slice(0, separator));
    const merchantId = value.slice(separator + 1).trim().slice(0, MAX_MERCHANT_ID_LENGTH);
    return exchange && merchantId ? { exchange, merchantId } : null;
  }
  if (!isRecord(value)) return null;
  const exchange = asExchangeId(value.exchange);
  const rawId = value.merchantId ?? value.id;
  const merchantId =
    typeof rawId === "number" && Number.isFinite(rawId)
      ? String(rawId)
      : typeof rawId === "string"
        ? rawId.trim().slice(0, MAX_MERCHANT_ID_LENGTH)
        : "";
  return exchange && merchantId ? { exchange, merchantId } : null;
}

function sameBlockedMerchantId(left: BlockedMerchantId, right: BlockedMerchantId): boolean {
  return left.exchange === right.exchange && left.merchantId === right.merchantId;
}

function mergeBlockedMerchantIds(
  current: readonly BlockedMerchantId[],
  addition: readonly BlockedMerchantId[],
): BlockedMerchantId[] {
  const merged = current.slice();
  for (const id of addition) {
    if (merged.length === MAX_MERCHANT_IDS_PER_BLOCK) break;
    if (!merged.some((existing) => sameBlockedMerchantId(existing, id))) merged.push(id);
  }
  return merged;
}

function toBlockedMerchant(value: unknown): BlockedMerchant | null {
  if (typeof value === "string") {
    const name = cleanMerchantName(value);
    return isBlockableMerchantName(name) ? { name, ids: [] } : null;
  }
  if (!isRecord(value)) return null;

  const name = cleanMerchantName(value.name ?? value.merchantName);
  const ids: BlockedMerchantId[] = [];
  // Copied, so the caller's own array is never written to.
  const candidates = [
    ...(Array.isArray(value.ids) ? value.ids : Array.isArray(value.merchantIds) ? value.merchantIds : []),
    // A flat { name, exchange, merchantId } is exactly what an offer card has.
    toBlockedMerchantId({ exchange: value.exchange, merchantId: value.merchantId }),
  ];

  for (const candidate of candidates) {
    if (ids.length === MAX_MERCHANT_IDS_PER_BLOCK) break;
    const id = toBlockedMerchantId(candidate);
    if (id && !ids.some((existing) => sameBlockedMerchantId(existing, id))) ids.push(id);
  }
  if (!ids.length && !isBlockableMerchantName(name)) return null;
  return { name, ids };
}

/**
 * Insert one block, extending the entry that already covers it — matched by
 * loose name key or by a shared exchange advertiser ID — so blocking the same
 * merchant on a second exchange never leaves two chips behind.
 */
function appendBlockedMerchant(
  merchants: readonly BlockedMerchant[],
  addition: BlockedMerchant,
): BlockedMerchant[] {
  const nameKey = merchantMatchKey(addition.name);
  const additionIds = addition.ids.map((id) => blockedMerchantIdKey(id.exchange, id.merchantId));
  const merged: BlockedMerchant[] = [];
  let absorbed = false;

  for (const merchant of merchants) {
    const overlaps =
      (nameKey !== "" && merchantMatchKey(merchant.name) === nameKey) ||
      merchant.ids.some((id) => additionIds.includes(blockedMerchantIdKey(id.exchange, id.merchantId)));
    if (!overlaps) {
      merged.push(merchant);
      continue;
    }
    // Collapse further duplicates of that entry instead of adding more copies.
    if (absorbed) continue;
    merged.push({
      name: merchant.name || addition.name,
      ids: mergeBlockedMerchantIds(merchant.ids, addition.ids),
    });
    absorbed = true;
  }

  if (!absorbed) merged.push({ name: addition.name, ids: addition.ids.slice(0, MAX_MERCHANT_IDS_PER_BLOCK) });
  return merged.slice(0, MAX_BLOCKED_MERCHANTS);
}

/** Trim, merge, and bound a browser/API blocklist of names and `{ name, ids }` entries. */
export function normalizeBlockedMerchants(value: unknown): BlockedMerchant[] {
  const source = isRecord(value) ? (Array.isArray(value.merchants) ? value.merchants : value.names) : value;
  if (!Array.isArray(source)) return [];

  let merchants: BlockedMerchant[] = [];
  for (const candidate of source) {
    const entry = toBlockedMerchant(candidate);
    if (!entry) continue;
    merchants = appendBlockedMerchant(merchants, entry);
    if (merchants.length === MAX_BLOCKED_MERCHANTS) break;
  }
  return merchants;
}

/** Names only, for legacy callers and storage that predates ID anchors. */
export function normalizeBlockedMerchantNames(value: unknown): string[] {
  return normalizeBlockedMerchants(value)
    .map((merchant) => merchant.name)
    .filter((name) => name.length > 0);
}

export function compileMerchantBlocklist(blocked: MerchantBlocklistInput | null | undefined): MerchantBlocklist {
  const merchants = normalizeBlockedMerchants(blocked);
  const nameKeys: string[] = [];
  const idKeys: string[] = [];

  for (const merchant of merchants) {
    if (isBlockableMerchantName(merchant.name)) {
      const key = merchantMatchKey(merchant.name);
      if (!nameKeys.includes(key)) nameKeys.push(key);
    }
    for (const id of merchant.ids) {
      const idKey = blockedMerchantIdKey(id.exchange, id.merchantId);
      if (!idKeys.includes(idKey)) idKeys.push(idKey);
    }
  }

  return { merchants, nameKeys, idKeys };
}

/** Accepts an already compiled list, or the raw name/entry arrays to compile. */
function toCompiledBlocklist(
  blocked: MerchantBlocklist | MerchantBlocklistInput | null | undefined,
): MerchantBlocklist {
  if (blocked && !Array.isArray(blocked) && Array.isArray((blocked as MerchantBlocklist).nameKeys)) {
    return blocked as MerchantBlocklist;
  }
  return compileMerchantBlocklist(blocked as MerchantBlocklistInput | null | undefined);
}

/** True when nothing is blocked, so callers can skip filtering entirely. */
export function merchantBlocklistIsEmpty(blocked: MerchantBlocklist | MerchantBlocklistInput): boolean {
  const blocklist = toCompiledBlocklist(blocked);
  return blocklist.nameKeys.length === 0 && blocklist.idKeys.length === 0;
}

/**
 * A block applies on every exchange, side, and fiat market: names match loosely
 * across exchanges, and an exchange advertiser ID always wins on its own exchange.
 */
export function isOfferBlocked(offer: P2POffer, blocklist: MerchantBlocklist): boolean {
  if (blocklist.nameKeys.length === 0 && blocklist.idKeys.length === 0) return false;

  const nameKey = merchantMatchKey(offer.merchantName.trim());
  if (nameKey !== "" && blocklist.nameKeys.includes(nameKey)) return true;

  const merchantId = offer.merchantId?.trim();
  if (merchantId && blocklist.idKeys.includes(blockedMerchantIdKey(offer.exchange, merchantId))) return true;

  return false;
}

/** Convenience wrapper that compiles per call; loops should use `compileMerchantBlocklist`. */
export function isMerchantBlocked(
  offer: P2POffer,
  blocked: MerchantBlocklistInput | MerchantBlocklist | null | undefined,
): boolean {
  return isOfferBlocked(offer, toCompiledBlocklist(blocked));
}

/** Stable key for one blocked entry, used to remove a chip. */
export function blockedMerchantKey(merchant: BlockedMerchant): string {
  if (isBlockableMerchantName(merchant.name)) return `name:${merchantMatchKey(merchant.name)}`;
  const ids = merchant.ids.map((id) => blockedMerchantIdKey(id.exchange, id.merchantId)).sort().join(",");
  return ids ? `ids:${ids}` : "";
}

export function findBlockedMerchant(
  merchants: readonly BlockedMerchant[],
  name: string,
): BlockedMerchant | null {
  if (!isBlockableMerchantName(name)) return null;
  const key = merchantMatchKey(name);
  return merchants.find((merchant) => merchantMatchKey(merchant.name) === key) ?? null;
}

/** The entry that hides this offer, so a card's button can undo exactly that block. */
export function findBlockingMerchant(
  offer: P2POffer,
  merchants: readonly BlockedMerchant[],
): BlockedMerchant | null {
  const nameKey = merchantMatchKey(offer.merchantName.trim());
  const idKey = offer.merchantId ? blockedMerchantIdKey(offer.exchange, offer.merchantId) : "";

  return (
    merchants.find((merchant) => {
      if (idKey && merchant.ids.some((id) => blockedMerchantIdKey(id.exchange, id.merchantId) === idKey)) {
        return true;
      }
      return nameKey !== "" && isBlockableMerchantName(merchant.name) && merchantMatchKey(merchant.name) === nameKey;
    }) ?? null
  );
}

export function removeBlockedMerchant(
  merchants: readonly BlockedMerchant[],
  key: string,
): BlockedMerchant[] {
  // An entry with no name and no IDs cannot be addressed, so nothing to remove.
  if (!key) return merchants.slice();
  return merchants.filter((merchant) => blockedMerchantKey(merchant) !== key);
}

/** Merge a fresh block into a saved list (what the per-card Block button does). */
export function mergeBlockedMerchant(
  merchants: readonly BlockedMerchant[],
  addition: BlockedMerchant,
): BlockedMerchant[] {
  return appendBlockedMerchant(merchants, addition);
}

/**
 * The block to offer on one ad: its advertiser ID plus its display name when
 * that name identifies an advertiser rather than the anonymous fallback.
 */
export function blockedMerchantFromOffer(offer: P2POffer): BlockedMerchant | null {
  const name = cleanMerchantName(offer.merchantName);
  const blockableName = isBlockableMerchantName(name) ? name : "";
  const id = toBlockedMerchantId({ exchange: offer.exchange, merchantId: offer.merchantId });
  const ids = id ? [id] : [];
  if (!blockableName && !ids.length) return null;
  return { name: blockableName, ids };
}

/** Chip label: the blocked name, or the exchange advertiser ID behind it. */
export function blockedMerchantLabel(
  merchant: BlockedMerchant,
  exchangeNames: Partial<Record<ExchangeId, string>> = {},
): string {
  if (merchant.name) return merchant.name;
  return merchant.ids
    .map((id) => `${exchangeNames[id.exchange] ?? id.exchange} advertiser ${id.merchantId}`)
    .join(", ");
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
