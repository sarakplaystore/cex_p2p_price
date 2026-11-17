import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FIAT, MAX_MERCHANTS_PER_SIDE, normalizeCompletionRate, selectTopMerchants, type P2POffer } from "../lib/p2p";
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

test("buy ranking includes non-ABA payment methods and uses the lowest price", () => {
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

  assert.deepEqual(result.map((item) => item.id), ["wrong-bank", "best"]);
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

test("OKX USD buy quote includes all payment methods and prices outside the former range", async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    code: "0",
    data: {
      sell: [
        { id: "below-range", price: "0.89", merchantId: "below-merchant", nickName: "Below", paymentMethods: ["ACLEDA Bank"] },
        { id: "range-min", price: "0.9", merchantId: "min-merchant", nickName: "Min", paymentMethods: ["ABA Bank"] },
        { id: "range-max", price: "1.015", merchantId: "max-merchant", nickName: "Max", paymentMethods: ["ABA Bank"] },
        { id: "above-range", price: "1.016", merchantId: "above-merchant", nickName: "Above", paymentMethods: ["Wing Money"] },
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
    assert.deepEqual(quote.offers.map((item) => item.id), [
      "below-range",
      "range-min",
      "range-max",
      "above-range",
    ]);
    assert.equal(quote.offers[0]?.paymentMethods[0], "ACLEDA Bank");
    assert.equal(quote.offers[3]?.paymentMethods[0], "Wing Money");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OKX USD Sell quote keeps merchants that were previously blocklisted", async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    code: "0",
    data: {
      buy: [
        { id: "king", price: "1.350", merchantId: "okx-king", nickName: "KingXchanger001", paymentMethods: ["ABA Bank"] },
        { id: "local", price: "1.340", merchantId: "okx-local", nickName: "Localcambodiapayeer", paymentMethods: ["ACLEDA Bank"] },
        { id: "fast", price: "1.003", merchantId: "okx-fast", nickName: "Fast_sonic", paymentMethods: ["Wing Money"] },
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
    assert.deepEqual(quote.offers.map((item) => item.merchantName), [
      "KingXchanger001",
      "Localcambodiapayeer",
      "Fast_sonic",
    ]);
    assert.deepEqual(quote.offers[1]?.paymentMethods, ["ACLEDA Bank"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all exchange adapters request offers without payment-method restrictions", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const response = (payload: unknown) => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    requests.push({ url, body });

    if (url.includes("p2p.binance.com")) {
      return response({
        code: "000000",
        data: [{ id: "binance-ad", price: "1.1", merchantName: "Binance trader", paymentMethods: ["ACLEDA Bank"] }],
      });
    }
    if (url.includes("www.okx.com")) {
      return response({
        code: "0",
        data: { sell: [{ id: "okx-ad", price: "1.1", nickName: "OKX trader", paymentMethods: ["ACLEDA Bank"] }], buy: [] },
      });
    }
    if (url.includes("/fiat/otc/item/online")) {
      return response({
        ret_code: 0,
        result: { items: [{ id: "bybit-ad", price: "1.1", payments: ["19"], userInfo: { userId: "bybit-user", nickName: "Bybit trader" } }] },
      });
    }
    if (url.includes("/fiat/otc/configuration/queryAllPaymentList")) {
      return response({ ret_code: 0, result: { paymentConfigVo: [{ paymentType: "19", paymentName: "ACLEDA Bank" }] } });
    }
    if (url.includes("www.bitget.com")) {
      return response({
        code: "00000",
        data: { dataList: [{ adNo: "bitget-ad", price: "1.1", nickName: "Bitget trader", paymethodInfo: [{ paymethodName: "ACLEDA Bank" }] }] },
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };

  try {
    for (const exchange of ["binance", "okx", "bybit", "bitget"] as const) {
      const quote = await loadSideQuote(exchange, "buy", "USD");
      assert.equal(quote.status, "live", `${exchange} should include an offer with a non-ABA method`);
      assert.equal(quote.offers.length, 1);
    }

    const binanceBody = requests.find(({ url }) => url.includes("p2p.binance.com"))?.body;
    assert.deepEqual(binanceBody?.payTypes, []);

    const okxUrl = requests.find(({ url }) => url.includes("www.okx.com"))?.url;
    assert.ok(okxUrl);
    assert.equal(new URL(okxUrl).searchParams.get("paymentMethod"), "all");

    const bybitBody = requests.find(({ url }) => url.includes("/fiat/otc/item/online"))?.body;
    assert.deepEqual(bybitBody?.payment, []);

    const bitgetBody = requests.find(({ url }) => url.includes("www.bitget.com"))?.body;
    assert.ok(bitgetBody);
    assert.deepEqual(Object.keys(bitgetBody).filter((key) => /^(pay|payment)/i.test(key)), []);
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
  assert.deepEqual(result.paymentMethods, ["ABA Bank"]);
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
  assert.deepEqual(result.paymentMethods, ["ABA Bank"]);
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
  assert.deepEqual(result.paymentMethods, ["ABA Bank"]);
});
