import assert from "node:assert/strict";
import test from "node:test";
import { loadSideQuote } from "../lib/exchanges";
import { EXCHANGES } from "../lib/p2p";

// The highest bids can fill an entire page without a single ABA payment method.
const rowsByPage = [
  Array.from({ length: 20 }, (_, i) => ({ id: `other-${i}`, nickName: `Bank ${i}`, price: "1.3", aba: false })),
  [
    { id: "first", nickName: "Trader A", price: "1.2", aba: true },
    { id: "duplicate", nickName: "Trader A", price: "1.1", aba: true },
  ],
  [{ id: "next", nickName: "Trader B", price: "1.0", aba: true }],
];

for (const { id: exchange } of EXCHANGES) {
  test(`${exchange}: Sell USDT finds ABA buyers on later pages`, async (t) => {
    const pages: number[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/queryAllPaymentList")) {
        return Response.json({ ret_code: 0, result: { paymentConfigVo: [
          { paymentType: "42", paymentName: "ABA Bank" },
          { paymentType: "19", paymentName: "Wing Money" },
        ] } });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (exchange === "binance" && body.payTypes.length) {
        // This market does not recognize the payment hint. Page the unfiltered book.
        return Response.json({ code: "000000", data: [] });
      }
      const page = Number(body.page ?? body.pageNo ?? url.searchParams.get("currentPage"));
      pages.push(page);
      const rows = rowsByPage[page - 1] ?? [];

      if (exchange === "binance") {
        assert.equal(body.tradeType, "SELL");
        return Response.json({ data: rows.map(({ aba, ...adv }) => ({
          adv: { ...adv, tradeMethods: [{ identifier: aba ? "ABABank" : "ABACUS", tradeMethodName: null }] },
        })) });
      }
      if (exchange === "okx") {
        assert.equal(url.searchParams.get("side"), "buy");
        return Response.json({ data: {
          buy: rows.map(({ aba, ...row }) => ({ ...row, paymentMethods: [aba ? "ABA Bank" : "Wing Money"] })),
          sell: [{ id: "wrong-side", price: "2", paymentMethods: ["ABA Bank"] }],
        } });
      }
      if (exchange === "bybit") {
        assert.equal(body.side, "0"); // advertiser buys USDT
        return Response.json({ result: { items: rows.map(({ aba, ...row }) => ({ ...row, payments: [aba ? "42" : "19"] })) } });
      }
      assert.equal(body.side, 2);
      return Response.json({ data: { dataList: rows.map(({ aba, ...row }) => ({
        ...row, paymethodInfo: [{ paymethodName: aba ? "ABA Bank" : "Wing Money" }],
      })) } });
    });

    const quote = await loadSideQuote(exchange, "sell", "USD");
    assert.equal(quote.status, "live");
    assert.deepEqual(quote.offers.map(({ id }) => id), ["first", "next"]);
    // Bybit first probes with its server-side ABA payment filter; this mock
    // does not honour the filter (page 1 has no ABA ad), so it restarts on the
    // unfiltered book and pages from page 1 again.
    assert.deepEqual(pages, exchange === "bybit" ? [1, 1, 2, 3] : [1, 2, 3]);
  });
}

test("a later page failing does not discard an already found sell ad", async (t) => {
  const pages: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const page = new URL(String(input)).searchParams.get("currentPage");
    assert.ok(page);
    pages.push(page);
    return page === "1"
      ? Response.json({ data: { buy: [{ id: "real-bid", price: "4100", paymentMethods: ["ABA Bank"] }] } })
      : new Response(null, { status: 503 });
  });

  const quote = await loadSideQuote("okx", "sell", "KHR");
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(quote.status, "live");
  assert.deepEqual(quote.offers.map(({ id }) => id), ["real-bid"]);
});

for (const [side, maxPages] of [["sell", 5], ["buy", 1]] as const) {
  test(`${side} lookup stops after ${maxPages} page(s) when no ads qualify`, async (t) => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      requests++;
      const params = new URL(String(input)).searchParams;
      const rows = [{ id: `other-${params.get("currentPage")}`, price: "4100", paymentMethods: ["Wing Money"] }];
      return Response.json({ data: { [side === "sell" ? "buy" : "sell"]: rows } });
    });

    const quote = await loadSideQuote("okx", side, "KHR");
    assert.equal(quote.status, "empty");
    assert.deepEqual(quote.offers, []);
    assert.equal(requests, maxPages);
  });
}
