import assert from "node:assert/strict";
import test from "node:test";
import { hasAbaBankPayment, normalizeCompletionRate, selectTopMerchants, type P2POffer } from "../lib/p2p";

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

test("ABA matching accepts ABA labels and rejects other banks", () => {
  assert.equal(hasAbaBankPayment(["ABA Bank"]), true);
  assert.equal(hasAbaBankPayment(["ABA Mobile Transfer"]), true);
  assert.equal(hasAbaBankPayment(["ACLEDA Bank"]), false);
  assert.equal(hasAbaBankPayment(["ABACUS Exchange"]), false);
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
