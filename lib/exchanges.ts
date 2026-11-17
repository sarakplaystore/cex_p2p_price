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
    "paymethodName",
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

export function normalizeOffer(
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
  const merchantId =
    firstString(traderRecords, ["userNo", "userId", "accountId", "uid", "traderId", "advertiserId", "encryptUserId", "merchantId", "publicUserId"]) ??
    firstString(records, ["userNo", "userId", "accountId", "uid", "traderId", "advertiserId", "encryptUserId", "merchantId", "publicUserId"]);
  const id =
    firstString(records, ["advNo", "advertisementId", "id", "itemId", "offerId"]) ??
    `${exchange}-${side}-${merchantId ?? merchantName}-${price}`;
  const completionKeys = ["monthFinishRate", "completionRate", "recentExecuteRate", "finishRate", "successRate", "thirtyCompletionRate", "completedRate"];
  const completionRate = normalizeCompletionRate(
    firstNumber(traderRecords, completionKeys) ??
      firstString(traderRecords, completionKeys) ??
      firstNumber(records, completionKeys) ??
      firstString(records, completionKeys),
  );
  const verifiedValue = traderRecords
    .flatMap((record) => [record.verified, record.isVerified, record.proMerchant, record.isPro, record.certifiedMerchant, record.isMerchant, record.isAuthenticatedMerchant, record.isInstitution])
    .concat(records.flatMap((record) => [record.verified, record.isVerified, record.proMerchant, record.isPro, record.certifiedMerchant, record.isMerchant, record.isAuthenticatedMerchant, record.isInstitution]))
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
    minFiat: firstNumber(records, ["minSingleTransAmount", "minAmount", "minQuote", "quoteMinAmountPerOrder", "minTradeLimit", "lowerLimit", "minLimit"]),
    maxFiat: firstNumber(records, ["maxSingleTransAmount", "maxAmount", "maxQuote", "quoteMaxAmountPerOrder", "maxTradeLimit", "upperLimit", "maxLimit"]),
    availableUsdt: firstNumber(records, ["surplusAmount", "availableAmount", "availableQuantity", "quantity", "lastAmount", "editAmount", "amount"]),
    tradeCount:
      firstNumber(traderRecords, ["monthOrderCount", "totalOrderCount", "orderCount", "completedOrders", "recentOrderNum", "completedTradeCount", "completedOrderQuantity", "thirtyTunoverNum", "thirtyTurnoverNum"]) ??
      firstNumber(records, ["monthOrderCount", "totalOrderCount", "orderCount", "completedOrders", "recentOrderNum", "completedTradeCount", "completedOrderQuantity", "thirtyTunoverNum", "thirtyTurnoverNum"]),
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

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Exchange returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  return requestJson(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
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
    if (rowsContainAba(firstRows, "binance", side, fiat)) return firstRows;
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

export function extractOkxRows(payload: unknown, side: P2PSide): JsonRecord[] {
  const apiSide = side === "buy" ? "sell" : "buy";
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  const rows = data?.[apiSide];
  if (!Array.isArray(rows)) throw new Error(`OKX response did not include data.${apiSide}`);
  return rows.filter(isRecord);
}

async function requestOkx(side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  const apiSide = side === "buy" ? "sell" : "buy";
  const params = new URLSearchParams({
    side: apiSide,
    paymentMethod: "all",
    userType: "all",
    showTrade: "false",
    showFollow: "false",
    showAlreadyTraded: "false",
    isAbleFilter: "false",
    sortType: side === "buy" ? "price_asc" : "price_desc",
    urlId: "0",
    limit: "100",
    cryptoCurrency: "USDT",
    fiatCurrency: fiat,
    currentPage: "1",
    numberPerPage: "20",
    t: String(Date.now()),
  });
  const payload = await requestJson(
    `https://www.okx.com/v3/c2c/tradingOrders/getMarketplaceAdsPrelogin?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: "https://www.okx.com",
        Referer: "https://www.okx.com/p2p-markets/",
        "User-Agent": "Mozilla/5.0",
      },
    },
  );
  assertSuccessfulResponse("okx", payload);

  return extractOkxRows(payload, side);
}

async function okxRows(side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  return requestOkx(side, fiat);
}

const BYBIT_OFFER_URL = "https://api2.bybit.com/fiat/otc/item/online";
const BYBIT_PAYMENT_LIST_URL = "https://api2.bybit.com/fiat/otc/configuration/queryAllPaymentList";
let bybitPaymentNameCache: { names: Map<string, string>; expiresAt: number } | null = null;
let bybitPaymentNameRequest: Promise<Map<string, string>> | null = null;

async function getBybitPaymentNameMap(): Promise<Map<string, string>> {
  if (bybitPaymentNameCache && bybitPaymentNameCache.expiresAt > Date.now()) {
    return bybitPaymentNameCache.names;
  }
  if (bybitPaymentNameRequest) return bybitPaymentNameRequest;

  const request = (async () => {
    const payload = await postJson(
      BYBIT_PAYMENT_LIST_URL,
      {},
      {
        Origin: "https://www.bybit.com",
        Referer: "https://www.bybit.com/",
        "User-Agent": "Mozilla/5.0",
      },
    );
    assertSuccessfulResponse("bybit", payload);
    const result = isRecord(payload) && isRecord(payload.result) ? payload.result : {};
    const paymentConfig = Array.isArray(result.paymentConfigVo) ? result.paymentConfigVo : [];
    const names = new Map<string, string>();

    for (const item of paymentConfig) {
      if (!isRecord(item) || item.paymentType == null || typeof item.paymentName !== "string") continue;
      names.set(String(item.paymentType), item.paymentName);
    }
    if (!names.size) throw new Error("Bybit payment-method list was empty or changed schema");

    bybitPaymentNameCache = { names, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
    return names;
  })();

  bybitPaymentNameRequest = request.finally(() => {
    bybitPaymentNameRequest = null;
  });
  return bybitPaymentNameRequest;
}

export function bybitAdvertiserSide(side: P2PSide): "0" | "1" {
  return side === "buy" ? "0" : "1";
}

async function requestBybit(side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  const payload = await postJson(
    BYBIT_OFFER_URL,
    {
      userId: "",
      tokenId: "USDT",
      currencyId: fiat,
      payment: [],
      // Bybit's `side` describes the advertiser: 0 sells crypto, 1 buys it.
      side: bybitAdvertiserSide(side),
      size: "50",
      page: "1",
      amount: "",
      authMaker: false,
      vaMaker: false,
      bulkMaker: false,
      canTrade: false,
      verificationFilter: 0,
      sortType: "TRADE_PRICE",
      paymentPeriod: [],
      itemRegion: 1,
    },
    {
      Origin: "https://www.bybit.com",
      Referer: `https://www.bybit.com/fiat/trade/otc/buy/USDT/${fiat}`,
      "User-Agent": "Mozilla/5.0",
    },
  );
  assertSuccessfulResponse("bybit", payload);
  const result = findOfferRows(payload, side);
  if (!result.found) throw new Error("Bybit response did not include a P2P offer list");
  return result.rows;
}

export function addBybitPaymentNames(rows: JsonRecord[], paymentNames: Map<string, string>): JsonRecord[] {
  return rows.map((row) => {
    const paymentIds = Array.isArray(row.payments)
      ? row.payments
      : Array.isArray(row.payment)
        ? row.payment
        : [];
    const resolvedNames = paymentIds
      .map((paymentId) => paymentNames.get(String(paymentId)))
      .filter((name): name is string => Boolean(name));
    return resolvedNames.length ? { ...row, paymentMethodNames: resolvedNames } : row;
  });
}

async function bybitRows(side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  const [rows, paymentNames] = await Promise.all([
    requestBybit(side, fiat),
    getBybitPaymentNameMap().catch(() => new Map<string, string>()),
  ]);
  return addBybitPaymentNames(rows, paymentNames);
}

export function bitgetMarketSide(side: P2PSide): 1 | 2 {
  return side === "buy" ? 1 : 2;
}

export function extractBitgetRows(payload: unknown): JsonRecord[] {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data || !("dataList" in data)) throw new Error("Bitget response did not include data.dataList");
  if (data.dataList == null) return [];
  if (!Array.isArray(data.dataList)) throw new Error("Bitget data.dataList was not an array");
  return data.dataList.filter(isRecord);
}

async function bitgetRows(side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  const payload = await postJson(
    "https://www.bitget.com/v1/p2p/pub/adv/queryAdvList",
    {
      // Bitget side: 1 = user buys crypto; 2 = user sells crypto.
      side: bitgetMarketSide(side),
      pageNo: 1,
      pageSize: 20,
      coinCode: "USDT",
      fiatCode: fiat,
      orderBy: 1,
      adAreaId: 0,
      orderModeFlag: "close",
      attentionMerchantFlag: false,
      rookieFriendlyFlag: false,
      allowPlaceOrderFlag: "1",
      languageType: 0,
    },
    {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.6",
      Origin: "https://www.bitget.com",
      Referer: "https://www.bitget.com/p2p-trade",
      "User-Agent": "Mozilla/5.0",
      apptheme: "standard",
      locale: "en_US",
      language: "en_US",
      terminaltype: "1",
      usenewpwdversion: "true",
    },
  );
  assertSuccessfulResponse("bitget", payload);
  return extractBitgetRows(payload);
}

async function fetchRows(exchange: ExchangeId, side: P2PSide, fiat: FiatCurrency): Promise<JsonRecord[]> {
  if (exchange === "binance") return binanceRows(side, fiat);
  if (exchange === "okx") return okxRows(side, fiat);
  if (exchange === "bybit") return bybitRows(side, fiat);
  return bitgetRows(side, fiat);
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
