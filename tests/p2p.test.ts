import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BLOCKED_MERCHANTS, DEFAULT_FIAT, hasAbaBankPayment, isMerchantBlocked, isWithinMakerSellPriceRange, MAX_BLOCKED_MERCHANTS, MAX_MERCHANTS_PER_SIDE, normalizeBlockedMerchantNames, normalizeCompletionRate, selectTopMerchants, USD_OFFER_PRICE_RANGE, type P2POffer } from "../lib/p2p";
import { addBybitPaymentNames, bitgetMarketSide, bybitAdvertiserSide, extractBitgetRows, extractBybitRows, extractOkxRows, loadSideQuote, normalizeOffer } from "../lib/exchanges";

function offer(overrides: Partial<P2POffer> = {}): P2POffer {
  return {
    id: "ad-1",
    exchange: "binance",
    side: "buy",
    merchantId: "merchant-1",
    merchantName: "Merchant One",
    price: 4_100,
    fiat: "KHR",
    paymentMethods: ["ABA Bank"],
    minFiat: null,
    maxFiat: null,
    availableUsdt: null,
    tradeCount: null,
    completionRate: null,
    verified: false,
    ...overrides,
  };
}

test("USD is the default fiat market on first load", () => {
  assert.equal(DEFAULT_FIAT, "USD");
});

test("ABA matching accepts ABA labels and rejects other banks", () => {
  assert.equal(hasAbaBankPayment(["ABA Bank"]), true);
  assert.equal(hasAbaBankPayment(["ABA Mobile Transfer"]), true);
  assert.equal(hasAbaBankPayment(["ACLEDA Bank"]), false);
  assert.equal(hasAbaBankPayment(["ABACUS Exchange"]), false);
});

test("USD offers inside the range remain eligible; only maker-sell ads are range-limited", () => {
  const makerSell = (price: number) => offer({ fiat: "USD", side: "buy", price });
  const makerBuy = (price: number) => offer({ fiat: "USD", side: "sell", price });

  for (const boundary of [USD_OFFER_PRICE_RANGE.min, USD_OFFER_PRICE_RANGE.max]) {
    assert.equal(isWithinMakerSellPriceRange(makerSell(boundary)), true);
    assert.equal(isWithinMakerSellPriceRange(makerBuy(boundary)), true);
  }
  assert.equal(isWithinMakerSellPriceRange(makerSell(USD_OFFER_PRICE_RANGE.min - 0.001)), false);
  assert.equal(isWithinMakerSellPriceRange(makerSell(USD_OFFER_PRICE_RANGE.max + 0.001)), false);
  assert.equal(isWithinMakerSellPriceRange(makerBuy(0.5)), true);
  assert.equal(isWithinMakerSellPriceRange(offer({ fiat: "KHR", side: "buy", price: 4_100 })), true);
});

test("merchant blocklist matches names globally and normalizes user input", () => {
  assert.deepEqual(DEFAULT_BLOCKED_MERCHANTS, ["KingXchanger001", "Localcambodiapayeer"]);
  const normalized = normalizeBlockedMerchantNames([
    " KingXchanger001 ",
    "kingxchanger001",
    "Localcambodiapayeer",
    "",
    "x".repeat(81),
    123,
  ]);
  assert.deepEqual(normalized, ["KingXchanger001", "Localcambodiapayeer"]);

  assert.equal(isMerchantBlocked(offer({ merchantName: " kingxchanger001 " }), normalized), true);
  assert.equal(isMerchantBlocked(offer({ exchange: "okx", side: "sell", fiat: "USD", merchantName: "LOCALCAMBODIAPAYEER" }), normalized), true);
  assert.equal(isMerchantBlocked(offer({ exchange: "bitget", side: "sell", fiat: "USD", merchantName: "Fast_sonic" }), normalized), false);
  assert.deepEqual(normalizeBlockedMerchantNames(null), []);
  assert.equal(normalizeBlockedMerchantNames(Array.from({ length: MAX_BLOCKED_MERCHANTS + 5 }, (_, index) => `M${index}`)).length, MAX_BLOCKED_MERCHANTS);
});

test("buy ranking uses the lowest price and returns two unique merchants", () => {
  const result = selectTopMerchants(
    [
      offer({ id: "high", merchantId: "m1", merchantName: "One", price: 4_300 }),
      offer({ id: "best", merchantId: "m2", merchantName: "Two", price: 4_000 }),
      offer({ id: "same-merchant", merchantId: "m2", merchantName: "Two", price: 4_050 }),
      offer({ id: "next", merchantId: "m3", merchantName: "Three", price: 4_100 }),
      offer({ id: "wrong-bank", merchantId: "m4", merchantName: "Four", price: 3_800, paymentMethods: ["ACLEDA Bank"] }),
    ],
    "buy",
  );

  assert.deepEqual(result.map((item) => item.id), ["best", "next"]);
});

test("merchant selection can expand beyond the initial two up to its configured cap", () => {
  const offers = Array.from({ length: MAX_MERCHANTS_PER_SIDE + 2 }, (_, index) =>
    offer({
      id: `ad-${index}`,
      merchantId: `merchant-${index}`,
      merchantName: `Merchant ${index}`,
      price: 4_000 + index,
    }),
  );

  assert.equal(selectTopMerchants(offers, "buy").length, 2);
  const expanded = selectTopMerchants(offers, "buy", MAX_MERCHANTS_PER_SIDE);
  assert.equal(expanded.length, MAX_MERCHANTS_PER_SIDE);
  assert.deepEqual(expanded.slice(0, 2).map((item) => item.id), ["ad-0", "ad-1"]);
});

test("sell ranking uses the highest price and caps the result at two", () => {
  const result = selectTopMerchants(
    [
      offer({ id: "low", side: "sell", merchantId: "m1", merchantName: "One", price: 4_100 }),
      offer({ id: "best", side: "sell", merchantId: "m2", merchantName: "Two", price: 4_300 }),
      offer({ id: "next", side: "sell", merchantId: "m3", merchantName: "Three", price: 4_200 }),
    ],
    "sell",
  );

  assert.deepEqual(result.map((item) => item.id), ["best", "next"]);
});

test("completion rates normalize fractions, percentages, and invalid values", () => {
  assert.equal(normalizeCompletionRate(0.985), 98.5);
  assert.equal(normalizeCompletionRate("98.5%"), 98.5);
  assert.equal(normalizeCompletionRate("98.5"), 98.5);
  assert.equal(normalizeCompletionRate("unknown"), null);
});

test("OKX user buy/sell selects the matching advertiser-side list", () => {
  const payload = {
    data: {
      buy: [{ id: "advertiser-buys", price: "4100" }],
      sell: [{ id: "advertiser-sells", price: "4200" }],
    },
  };

  assert.equal(extractOkxRows(payload, "buy")[0]?.id, "advertiser-sells");
  assert.equal(extractOkxRows(payload, "sell")[0]?.id, "advertiser-buys");
});

test("OKX USD ABA maker-sell ads inside the inclusive range survive quote loading", async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    code: "0",
    data: {
      sell: [
        { id: "okx-min", price: "0.9", merchantId: "okx-min-merchant", nickName: "Min", paymentMethods: ["ABA Bank"] },
        { id: "okx-max", price: "1.015", merchantId: "okx-max-merchant", nickName: "Max", paymentMethods: ["ABA Bank"] },
        { id: "okx-outside", price: "1.016", merchantId: "okx-outside-merchant", nickName: "Outside", paymentMethods: ["ABA Bank"] },
      ],
      buy: [],
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const quote = await loadSideQuote("okx", "buy", "USD");
    assert.equal(quote.status, "live");
    assert.deepEqual(quote.offers.map((item) => item.id), ["okx-min", "okx-max"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OKX USD Sell quote skips the two named merchants and starts with the next offers", async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    code: "0",
    data: {
      buy: [
        { id: "king", price: "1.350", merchantId: "okx-king", nickName: "KingXchanger001", paymentMethods: ["ABA Bank"] },
        { id: "local", price: "1.350", merchantId: "okx-local", nickName: "Localcambodiapayeer", paymentMethods: ["ABA Bank"] },
        { id: "fast", price: "1.003", merchantId: "okx-fast", nickName: "Fast_sonic", paymentMethods: ["ABA Bank"] },
        { id: "komori", price: "1.003", merchantId: "okx-komori", nickName: "Komori", paymentMethods: ["ABA Bank"] },
        { id: "mengly", price: "1.002", merchantId: "okx-mengly", nickName: "MENGYLFONG", paymentMethods: ["ABA Bank"] },
      ],
      sell: [],
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const quote = await loadSideQuote("okx", "sell", "USD");
    assert.equal(quote.status, "live");
    assert.deepEqual(quote.offers.slice(0, 3).map((item) => item.merchantName), [
      "Fast_sonic",
      "Komori",
      "MENGYLFONG",
    ]);
    assert.equal(quote.offers.some((item) => item.id === "king" || item.id === "local"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an empty merchant blocklist allows the default OKX merchants again", async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    code: "0",
    data: {
      buy: [
        { id: "king", price: "1.350", merchantId: "okx-king", nickName: "KingXchanger001", paymentMethods: ["ABA Bank"] },
        { id: "local", price: "1.350", merchantId: "okx-local", nickName: "Localcambodiapayeer", paymentMethods: ["ABA Bank"] },
      ],
      sell: [],
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const quote = await loadSideQuote("okx", "sell", "USD", []);
    assert.equal(quote.status, "live");
    assert.deepEqual(quote.offers.map((item) => item.merchantName), [
      "KingXchanger001",
      "Localcambodiapayeer",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OKX USD Sell quote paginates until replacement ABA merchants are found", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages: string[] = [];
  const rowsByPage: Record<string, unknown[]> = {
    "1": [
      { id: "king", price: "1.350", merchantId: "okx-king", nickName: "KingXchanger001", paymentMethods: ["ABA Bank"] },
      { id: "local", price: "1.350", merchantId: "okx-local", nickName: "Localcambodiapayeer", paymentMethods: ["ABA Bank"] },
    ],
    "2": [
      { id: "fast", price: "1.003", merchantId: "okx-fast", nickName: "Fast_sonic", paymentMethods: ["ABA Bank"] },
    ],
    "3": [
      { id: "komori", price: "1.002", merchantId: "okx-komori", nickName: "Komori", paymentMethods: ["ABA Bank"] },
    ],
  };

  globalThis.fetch = async (input) => {
    const page = new URL(String(input)).searchParams.get("currentPage") ?? "1";
    requestedPages.push(page);
    return new Response(
      JSON.stringify({ code: "0", data: { buy: rowsByPage[page] ?? [], sell: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const quote = await loadSideQuote("okx", "sell", "USD");
    assert.equal(quote.status, "live");
    assert.deepEqual(requestedPages, ["1", "2", "3"]);
    assert.deepEqual(quote.offers.slice(0, 2).map((item) => item.merchantName), [
      "Fast_sonic",
      "Komori",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bybit and Bitget request the correct advertiser sides", () => {
  assert.equal(bybitAdvertiserSide("buy"), "0");
  assert.equal(bybitAdvertiserSide("sell"), "1");
  assert.equal(bitgetMarketSide("buy"), 1);
  assert.equal(bitgetMarketSide("sell"), 2);
});

test("Bitget empty ad list is valid, malformed response is rejected", () => {
  assert.deepEqual(extractBitgetRows({ data: { dataList: null } }), []);
  assert.deepEqual(extractBitgetRows({ data: { dataList: [] } }), []);
  assert.throws(() => extractBitgetRows({ data: {} }), /data.dataList/);
  assert.throws(() => extractBitgetRows({ data: { dataList: {} } }), /not an array/);
});

test("OKX offer details normalize payment, price, and merchant", () => {
  const result = normalizeOffer(
    {
      id: "okx-ad-1",
      price: "4075.5",
      availableAmount: "1200",
      quoteMinAmountPerOrder: "10000",
      quoteMaxAmountPerOrder: "800000",
      completedOrderQuantity: 15,
      completedRate: "0.99",
      merchantId: "okx-merchant-1",
      nickName: "OKX Trader",
      paymentMethods: ["ABA Bank"],
    },
    "okx",
    "buy",
    "KHR",
  );

  assert.ok(result);
  assert.equal(result.merchantId, "okx-merchant-1");
  assert.equal(result.merchantName, "OKX Trader");
  assert.equal(result.minFiat, 10000);
  assert.equal(result.maxFiat, 800000);
  assert.equal(result.tradeCount, 15);
  assert.equal(result.completionRate, 99);
  assert.equal(hasAbaBankPayment(result.paymentMethods), true);
});

test("Bitget ad shape normalizes ABA method and merchant details", () => {
  const result = normalizeOffer(
    {
      adNo: "bg-ad-1",
      price: "4100.25",
      minAmount: "10000",
      maxAmount: "500000",
      lastAmount: "20",
      paymethodInfo: [{ paymethodId: "123", paymethodName: "ABA Bank" }],
      nickName: "ABA Trader",
      encryptUserId: "bitget-user-1",
      thirtyTunoverNum: 42,
      thirtyCompletionRate: "0.98",
      certifiedMerchant: 1,
    },
    "bitget",
    "buy",
    "KHR",
  );

  assert.ok(result);
  assert.equal(result.merchantId, "bitget-user-1");
  assert.equal(result.merchantName, "ABA Trader");
  assert.equal(result.price, 4100.25);
  assert.equal(result.tradeCount, 42);
  assert.equal(result.completionRate, 98);
  assert.equal(result.verified, true);
  assert.equal(hasAbaBankPayment(result.paymentMethods), true);
});

test("Bybit result.items ads normalize with ABA payment names", () => {
  const rows = extractBybitRows({
    ret_code: 0,
    result: {
      items: [
        {
          id: "bybit-ad-1",
          price: "4101",
          minAmount: "10000",
          maxAmount: "500000",
          quantity: "250",
          payments: ["19"],
          userInfo: {
            userId: "bybit-user-1",
            nickName: "Bybit Trader",
            recentOrderNum: 120,
            recentExecuteRate: "0.98",
          },
        },
      ],
    },
  });
  const [row] = addBybitPaymentNames(rows, new Map([["19", "ABA Bank"]]));
  const result = row && normalizeOffer(row, "bybit", "buy", "KHR");

  assert.throws(() => extractBybitRows({ result: { items: {} } }), /not an array/);
  assert.ok(result);
  assert.equal(result.merchantId, "bybit-user-1");
  assert.equal(result.merchantName, "Bybit Trader");
  assert.equal(result.price, 4101);
  assert.equal(result.minFiat, 10000);
  assert.equal(result.maxFiat, 500000);
  assert.equal(result.availableUsdt, 250);
  assert.equal(result.tradeCount, 120);
  assert.equal(result.completionRate, 98);
  assert.equal(hasAbaBankPayment(result.paymentMethods), true);
});
