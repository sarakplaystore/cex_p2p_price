import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bybitAbaPaymentIds, loadSideQuote, normalizeOffer } from "../lib/exchanges";

// Real anonymous Bybit ads are flat, anonymize userId/accountId to "0", carry
// the stable merchant id in userMaskId, and list numeric payment ids only.
function bybitAd(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bybit-ad-1",
    userId: "0",
    accountId: "0",
    userMaskId: "smask-merchant-1",
    nickName: "Bybit Trader",
    price: "1.01",
    minAmount: "10",
    maxAmount: "5000",
    lastQuantity: "250",
    payments: ["194"],
    recentOrderNum: 120,
    recentExecuteRate: 98,
    ...overrides,
  };
}

function mockFetch(
  t: TestContext,
  handler: (url: URL, body: Record<string, unknown>) => Response | Promise<Response>,
  requests: Array<{ path: string; body: Record<string, unknown> }>,
) {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ path: url.pathname, body });
    return handler(url, body);
  });
}

// This test must run before any test that lets the payment-config lookup
// succeed: the module caches a successful lookup for hours.
test("Bybit finds ABA ads even when the payment-config endpoint is blocked", async (t) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  mockFetch(t, (url) => {
    if (url.pathname.endsWith("/queryAllPaymentList")) {
      // Bot-protected from server IPs in production.
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json({
      ret_code: 0,
      result: {
        items: [
          bybitAd(),
          bybitAd({ id: "bybit-ad-2", userMaskId: "smask-merchant-2", nickName: "Second Trader", price: "1.02", payments: ["194", "578"] }),
        ],
      },
    });
  }, requests);

  const quote = await loadSideQuote("bybit", "buy", "USD");
  assert.equal(quote.status, "live");
  assert.deepEqual(quote.offers.map(({ id }) => id), ["bybit-ad-1", "bybit-ad-2"]);
  // The blocked name lookup falls back to the known ABA payment id, and Bybit
  // is asked to filter on it server-side instead of paging the global book.
  const adRequests = requests.filter(({ path }) => path.endsWith("/item/online"));
  assert.ok(adRequests.length >= 1);
  assert.deepEqual(adRequests[0]?.body.payment, ["194"]);
  assert.deepEqual(adRequests[0]?.body.side, "1");
  assert.deepEqual(quote.offers[0]?.paymentMethods, ["ABA"]);
  assert.deepEqual(quote.offers[1]?.paymentMethods, ["ABA", "ACLEDA"]);
  // Distinct merchants survive despite every ad anonymizing userId to "0".
  assert.deepEqual(quote.offers.map(({ merchantId }) => merchantId), ["smask-merchant-1", "smask-merchant-2"]);
});

test("Bybit prefers the ABA payment id from a reachable payment-config list", async (t) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  mockFetch(t, (url) => {
    if (url.pathname.endsWith("/queryAllPaymentList")) {
      return Response.json({ ret_code: 0, result: { paymentConfigVo: [
        { paymentType: "42", paymentName: "ABA Bank" },
        { paymentType: "19", paymentName: "Wing Money" },
      ] } });
    }
    return Response.json({ ret_code: 0, result: { items: [bybitAd({ payments: ["42"] })] } });
  }, requests);

  assert.deepEqual(bybitAbaPaymentIds(new Map([["42", "ABA Bank"], ["19", "Wing Money"]])), ["42"]);
  assert.deepEqual(bybitAbaPaymentIds(new Map()), ["194"]);

  const quote = await loadSideQuote("bybit", "buy", "KHR");
  assert.equal(quote.status, "live");
  const adRequests = requests.filter(({ path }) => path.endsWith("/item/online"));
  assert.deepEqual(adRequests[0]?.body.payment, ["42"]);
  assert.deepEqual(quote.offers[0]?.paymentMethods, ["ABA Bank"]);
});

test("Bybit flat ads normalize merchant identity from userMaskId, not the anonymized 0", () => {
  const result = normalizeOffer(bybitAd(), "bybit", "buy", "USD");

  assert.ok(result);
  assert.equal(result.merchantId, "smask-merchant-1");
  assert.equal(result.merchantName, "Bybit Trader");
  assert.equal(result.price, 1.01);
  assert.equal(result.tradeCount, 120);
  assert.equal(result.completionRate, 98);
});
