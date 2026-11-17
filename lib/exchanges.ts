import {
  hasAbaBankPayment,
  normalizeCompletionRate,
  selectTopMerchants,
  type ExchangeId,
  type FiatCurrency,
  type P2POffer,
  type P2PSide,
  type SideQuote,
} from "./p2p";

type JsonRecord = Record<string, unknown>;

const API_TIMEOUT_MS = 4_000;
const LIST_KEYS = [
  "items",
  "list",
  "adlist",
  "advertisementlist",
  "advertisements",
  "ads",
  "records",
  "results",
  "buylist",
  "selllist",
  "buy",
  "sell",
  "data",
  "result",
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(record: JsonRecord, key: string): unknown {
  return record[key];
}

function firstString(records: JsonRecord[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = valueAt(record, key);
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(records: JsonRecord[], keys: string[]): number | null {
  for (const record of records) {
    for (const key of keys) {
      const parsed = toNumber(record[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function nestedRecords(row: JsonRecord): JsonRecord[] {
  const likelyAdKeys = ["adv", "advertisement", "advert", "ad", "item"];
  const likelyTraderKeys = ["advertiser", "merchant", "merchantInfo", "user", "userInfo", "trader"];
  const result: JsonRecord[] = [];

  for (const key of likelyAdKeys) {
    const value = row[key];
    if (isRecord(value)) result.push(value);
  }
  result.push(row);
  for (const key of likelyTraderKeys) {
    const value = row[key];
    if (isRecord(value)) result.push(value);
  }
  return result;
}

function collectPaymentNames(value: unknown, output: Set<string>, depth = 0): void {
  if (depth > 5 || value == null) return;

  if (typeof value === "string") {
    const text = value.trim();
    if (text && !/^\d+$/.test(text)) output.add(text);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPaymentNames(item, output, depth + 1);
    return;
  }

  if (!isRecord(value)) return;

  const labelKeys = [
    "tradeMethodName",
    "paymentName",
    "paymentMethodName",
    "methodName",
    "displayName",
    "bankName",
    "shortName",
    "label",
    "title",
    "name",
  ];
  let foundLabel = false;
  for (const key of labelKeys) {
    const label = value[key];
    if (typeof label === "string" && label.trim()) {
      output.add(label.trim());
      foundLabel = true;
    }
  }

  // Some responses wrap a method name one more level down; avoid collecting ids/numbers.
  if (!foundLabel) {
    for (const [key, child] of Object.entries(value)) {
      if (/payment|pay|method|bank|trade/i.test(key)) {
        collectPaymentNames(child, output, depth + 1);
      }
    }
  }
}

function paymentNamesFor(row: JsonRecord, ad: JsonRecord): string[] {
  const output = new Set<string>();
  const sources = [row, ad];
  const paymentKeys = /payment|paytype|paymethod|trademethod/i;

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (paymentKeys.test(key)) collectPaymentNames(value, output);
    }
  }

  return [...output];
}

function normalizeOffer(
  row: JsonRecord,
  exchange: ExchangeId,
  side: P2PSide,
  fiat: FiatCurrency,
): P2POffer | null {
  const records = nestedRecords(row);
  const ad = records[0] ?? row;
  const traderRecords = records.slice(1);
  const price = firstNumber(records, ["price", "unitPrice", "quotePrice", "rate", "priceValue"]);
  if (price === null || price <= 0) return null;

  const merchantName =
    firstString(
      traderRecords,
      ["nickName", "nickname", "merchantName", "userName", "username", "displayName", "name"],
    ) ??
    firstString(records, ["nickName", "nickname", "merchantName", "userName", "username"]) ??
    "P2P merchant";
  const merchantId = firstString(traderRecords, ["userNo", "userId", "accountId", "uid", "traderId", "advertiserId"]);
  const id =
    firstString(records, ["advNo", "advertisementId", "id", "itemId", "offerId"]) ??
    `${exchange}-${side}-${merchantId ?? merchantName}-${price}`;
  const completionRate = normalizeCompletionRate(
    firstNumber(traderRecords, ["monthFinishRate", "completionRate", "recentExecuteRate", "finishRate", "successRate"]) ??
      firstString(traderRecords, ["monthFinishRate", "completionRate", "recentExecuteRate", "finishRate", "successRate"]),
  );
  const verifiedValue = traderRecords
    .flatMap((record) => [record.verified, record.isVerified, record.proMerchant, record.isPro])
    .concat(records.flatMap((record) => [record.verified, record.isVerified, record.proMerchant, record.isPro]))
    .find((value) => value !== undefined && value !== null);
  const verified =
    verifiedValue === true ||
    (typeof verifiedValue === "number" && verifiedValue > 0) ||
    (typeof verifiedValue === "string" && /^(true|yes|1|pro|verified|professional)$/i.test(verifiedValue));

  return {
    id,
    exchange,
    side,
    merchantId,
    merchantName,
    price,
    fiat,
    paymentMethods: paymentNamesFor(row, ad),
    minFiat: firstNumber(records, ["minSingleTransAmount", "minAmount", "minQuote", "minTradeLimit", "lowerLimit", "minLimit"]),
    maxFiat: firstNumber(records, ["maxSingleTransAmount", "maxAmount", "maxQuote", "maxTradeLimit", "upperLimit", "maxLimit"]),
    availableUsdt: firstNumber(records, ["surplusAmount", "availableAmount", "availableQuantity", "quantity", "amount"]),
    tradeCount: firstNumber(traderRecords, ["monthOrderCount", "totalOrderCount", "orderCount", "completedOrders", "recentOrderNum", "completedTradeCount"]),
    completionRate,
    verified,
  };
}

function rowsContainAba(rows: JsonRecord[], exchange: ExchangeId, side: P2PSide, fiat: FiatCurrency): boolean {
  return rows.some((row) => {
    const offer = normalizeOffer(row, exchange, side, fiat);
    return offer !== null && hasAbaBankPayment(offer.paymentMethods);
  });
}

function hasPrice(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  const records = nestedRecords(value);
  return firstNumber(records, ["price", "unitPrice", "quotePrice", "rate", "priceValue"]) !== null;
}

function findOfferRows(payload: unknown, side: P2PSide): { rows: JsonRecord[]; found: boolean } {
  const sideKeys = side === "buy" ? ["buylist", "buy"] : ["selllist", "sell"];
  const orderedKeys = [...sideKeys, ...LIST_KEYS.filter((key) => !sideKeys.includes(key))];
  const queue: unknown[] = [payload];
  const visited = new Set<object>();
  let sawEmptyList = false;

  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      const rows = current.filter(isRecord);
      if (rows.some(hasPrice)) return { rows, found: true };
      // A known empty result list is a valid no-offers response, but keep looking
      // in case another provider wrapper contains the actual list deeper down.
      continue;
    }
    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);

    const entries = Object.entries(current);
    const priority = new Map(orderedKeys.map((key, index) => [key, index]));
    entries.sort(([left], [right]) => {
      const leftRank = priority.get(left.toLowerCase()) ?? LIST_KEYS.length;
      const rightRank = priority.get(right.toLowerCase()) ?? LIST_KEYS.length;
      return leftRank - rightRank;
    });

    for (const [key, child] of entries) {
      if (Array.isArray(child)) {
        const rows = child.filter(isRecord);
        if (rows.some(hasPrice)) return { rows, found: true };
        if (rows.length === 0 && orderedKeys.includes(key.toLowerCase())) sawEmptyList = true;
      }
    }
    for (const [, child] of entries) {
      if (isRecord(child)) queue.push(child);
    }
  }

  return { rows: [], found: sawEmptyList };
}

function assertSuccessfulResponse(exchange: ExchangeId, payload: unknown): void {
  if (!isRecord(payload)) throw new Error(`${exchange} returned an unexpected response`);
  if (payload.success === false || payload.success === "false") {
    throw new Error(typeof payload.message === "string" ? payload.message : `${exchange} request failed`);
  }

  const possibleCodes = [payload.code, payload.ret_code, payload.retCode];
  for (const code of possibleCodes) {
    if (code === undefined || code === null || code === "") continue;
    if (!["0", "000000", "00000", "200"].includes(String(code))) {
      const message =
        (typeof payload.message === "string" && payload.message) ||
        (typeof payload.ret_msg === "string" && payload.ret_msg) ||
        (typeof payload.msg === "string" && payload.msg) ||
        `${exchange} returned error ${String(code)}`;
      throw new Error(message);
    }
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Exchange returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

const binanceUrl = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";

async function requestBinance(
  side: P2PSide,
  fiat: FiatCurrency,
  payTypes: string[],
): Promise<JsonRecord[]> {
  const payload = await postJson(
    binanceUrl,
    {
      page: 1,
      rows: 20,
      payTypes,
      asset: "USDT",
      tradeType: side === "buy" ? "BUY" : "SELL",
      fiat,
      publisherType: null,
      merchantCheck: false,
    },
    {
      clienttype: "web",
      Origin: "https://p2p.binance.com",
      Referer: "https://p2p.binance.com/",
    },
  );
  assertSuccessfulResponse("binance", payload);
  const result = findOfferRows(payload, side);
  if (!result.found) throw new Error("Binance response did not include a P2P offer list");
  return result.rows;
}

async function binanceRows(side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  let firstRows: JsonRecord[] | null = null;
  let firstError: unknown;

  try {
    firstRows = await requestBinance(side, fiat, ["ABA Bank"]);
    const firstOffers = firstRows
      .map((row) => normalizeOffer(row, "binance", side, fiat))
      .filter((offer): offer is P2POffer => offer !== null);
    if (firstOffers.some((offer) => hasAbaBankPayment(offer.paymentMethods))) return firstRows;
  } catch (error) {
    firstError = error;
  }

  // Binance's public API has used different values for its payment filter over
  // time. Retry without that hint, then apply our own strict ABA-name filter.
  try {
    return await requestBinance(side, fiat, []);
  } catch (fallbackError) {
    if (firstRows) return firstRows;
    throw fallbackError ?? firstError;
  }
}

async function requestOkx(
  side: P2PSide,
  fiat: FiatCurrency,
  paymentMethod: string,
): Promise<JsonRecord[]> {
  const payload = await postJson(
    "https://www.okx.com/v3/c2c/tradingOrders/getMarketplaceAdsPrelogin",
    {
      quoteCurrency: fiat,
      baseCurrency: "USDT",
      side,
      paymentMethod,
      userType: "all",
      showTrade: false,
      showFollow: false,
      showAlreadyTraded: false,
      isExpress: false,
      isFollowing: false,
      isAbleFilter: false,
      filter: ["onlyTraditional"],
      sortType: side === "buy" ? "price_asc" : "price_desc",
      numberPerPage: "20",
      currentPage: "1",
    },
    {
      Origin: "https://www.okx.com",
      Referer: "https://www.okx.com/p2p-markets",
    },
  );
  assertSuccessfulResponse("okx", payload);
  const result = findOfferRows(payload, side);
  if (!result.found) throw new Error("OKX response did not include a P2P offer list");
  return result.rows;
}

async function okxRows(side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  let filteredRows: JsonRecord[] | null = null;

  try {
    filteredRows = await requestOkx(side, fiat, "ABA Bank");
    if (rowsContainAba(filteredRows, "okx", side, fiat)) return filteredRows;
  } catch {
    // Continue with the unfiltered public marketplace request below.
  }

  try {
    return await requestOkx(side, fiat, "all");
  } catch (fallbackError) {
    if (filteredRows) return filteredRows;
    throw fallbackError;
  }
}

async function requestBybit(
  side: P2PSide,
  fiat: FiatCurrency,
  payment: string[],
): Promise<JsonRecord[]> {
  const payload = await postJson(
    "https://api2.bybit.com/fiat/otc/item/online",
    {
      userId: "",
      tokenId: "USDT",
      currencyId: fiat,
      payment,
      side: side === "buy" ? "1" : "0",
      size: "50",
      page: "1",
    },
    {
      Origin: "https://www.bybit.com",
      Referer: `https://www.bybit.com/fiat/trade/otc/buy/USDT/${fiat}`,
    },
  );
  assertSuccessfulResponse("bybit", payload);
  const result = findOfferRows(payload, side);
  if (!result.found) throw new Error("Bybit response did not include a P2P offer list");
  return result.rows;
}

async function bybitRows(side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  let filteredRows: JsonRecord[] | null = null;

  try {
    filteredRows = await requestBybit(side, fiat, ["ABA Bank"]);
    if (rowsContainAba(filteredRows, "bybit", side, fiat)) return filteredRows;
  } catch {
    // Bybit commonly expects payment method ids; the empty list is our fallback.
  }

  try {
    return await requestBybit(side, fiat, []);
  } catch (fallbackError) {
    if (filteredRows) return filteredRows;
    throw fallbackError;
  }
}

async function fetchRows(exchange: ExchangeId, side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  if (exchange === "binance") return binanceRows(side, fiat);
  if (exchange === "okx") return okxRows(side, fiat);
  return bybitRows(side, fiat);
}

export async function loadSideQuote(
  exchange: ExchangeId,
  side: P2PSide,
  fiat: FiatCurrency,
): Promise<SideQuote> {
  try {
    const rows = await fetchRows(exchange, side, fiat);
    const offers = rows
      .map((row) => normalizeOffer(row, exchange, side, fiat))
      .filter((offer): offer is P2POffer => offer !== null);
    const topOffers = selectTopMerchants(offers, side, 2);

    return topOffers.length
      ? { status: "live", offers: topOffers }
      : { status: "empty", offers: [], message: "No verifiable ABA Bank ads found." };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown exchange error";
    console.warn(`[P2P Radar] ${exchange} ${side} feed failed: ${reason}`);
    return {
      status: "error",
      offers: [],
      message: "The exchange P2P feed is temporarily unavailable.",
    };
  }
}
