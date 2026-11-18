import assert from "node:assert/strict";
import test from "node:test";
import { GET as checkAlerts } from "../app/api/alerts/check/route";
import {
  formatArbitrageAlert,
  getArbitrageAlertConfig,
  notifyArbitrageOpportunities,
  resetArbitrageAlertState,
  type ArbitrageAlertConfig,
} from "../lib/alerts";
import {
  arbitrageProfitPerThousand,
  exchangeSpread,
  findArbitrageOpportunities,
  type ExchangeQuote,
  type P2POffer,
} from "../lib/p2p";

function offer(overrides: Partial<P2POffer> = {}): P2POffer {
  return {
    id: "ad-1",
    exchange: "okx",
    side: "buy",
    merchantId: "merchant-1",
    merchantName: "Merchant One",
    price: 1,
    fiat: "USD",
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

function quote(buyPrice: number | null, sellPrice: number | null, id: ExchangeQuote["id"] = "okx"): ExchangeQuote {
  return {
    id,
    buy: buyPrice === null
      ? { status: "empty", offers: [] }
      : { status: "live", offers: [offer({ price: buyPrice, merchantName: "Buyer", side: "buy" })] },
    sell: sellPrice === null
      ? { status: "empty", offers: [] }
      : { status: "live", offers: [offer({ price: sellPrice, merchantName: "Seller", side: "sell" })] },
  };
}

test("arbitrage: the $1.000 buy / $1.001 sell example meets the 0.1% threshold", () => {
  const opportunities = findArbitrageOpportunities([quote(1, 1.001)], "USD", 0.1);
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0]?.exchange, "okx");
  assert.equal(opportunities[0]?.buyMerchant, "Buyer");
  assert.equal(opportunities[0]?.sellMerchant, "Seller");
  assert.ok(Math.abs((opportunities[0]?.spreadPercent ?? 0) - 0.1) < 1e-9);
  // $1.000 -> $1.001 earns exactly $1.00 per $1,000 traded.
  assert.ok(Math.abs((opportunities[0]?.profitPerThousand ?? 0) - 1) < 1e-9);
});

test("arbitrage: profit per $1,000 scales with the spread and buy price", () => {
  // Buy $1.002, sell $1.005: $0.003 spread on a $1.002 base.
  assert.ok(Math.abs(arbitrageProfitPerThousand(1.002, 1.005) - 2.9940119760479043) < 1e-9);
  const summary = exchangeSpread(quote(1.002, 1.005));
  assert.ok(summary);
  assert.ok(Math.abs(summary.spreadPercent - 0.2994011976047904) < 1e-9);
  assert.ok(Math.abs(summary.profitPerThousand - 2.9940119760479043) < 1e-9);

  // A crossed market (sell below buy) is a per-$1,000 loss, and KHR prices
  // report the profit in KHR per 1,000 KHR traded.
  assert.ok(Math.abs(arbitrageProfitPerThousand(1.005, 1.002) + 2.9850746268656714) < 1e-9);
  assert.equal(arbitrageProfitPerThousand(4000, 4020), 5);
  assert.equal(exchangeSpread(quote(1, null)), null);
});

test("arbitrage: below-threshold and one-sided markets do not alert", () => {
  assert.deepEqual(findArbitrageOpportunities([quote(1, 1.0009)], "USD", 0.1), []);
  assert.deepEqual(findArbitrageOpportunities([quote(1, 0.999)], "USD", 0.1), []);
  assert.deepEqual(findArbitrageOpportunities([quote(1, null)], "USD", 0.1), []);
  assert.deepEqual(findArbitrageOpportunities([quote(null, 1.01)], "USD", 0.1), []);
  // A lower threshold catches the same market.
  assert.equal(findArbitrageOpportunities([quote(1, 1.0009)], "USD", 0.05).length, 1);
});

test("arbitrage: best prices are used even when offers are unordered", () => {
  const exchange = quote(1, 1.002);
  exchange.buy.offers.push(offer({ id: "worse-buy", price: 1.005, merchantName: "Worse Buyer" }));
  exchange.sell.offers.push(offer({ id: "worse-sell", price: 1.001, merchantName: "Worse Seller", side: "sell" }));

  const [opportunity] = findArbitrageOpportunities([exchange], "USD", 0.1);
  assert.equal(opportunity?.buyPrice, 1);
  assert.equal(opportunity?.sellPrice, 1.002);
});

test("alert config defaults to the 0.1% example and reads Telegram env vars", () => {
  const config = getArbitrageAlertConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.minSpreadPercent, 0.1);
  assert.equal(config.cooldownSeconds, 900);
  assert.equal(config.botToken, null);
  assert.equal(config.chatId, null);

  const custom = getArbitrageAlertConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "123",
    ARBITRAGE_MIN_SPREAD_PERCENT: "0.25",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(custom.minSpreadPercent, 0.25);
  assert.equal(custom.botToken, "token");
  assert.equal(custom.chatId, "123");
});

const TEST_CONFIG: ArbitrageAlertConfig = {
  minSpreadPercent: 0.1,
  cooldownSeconds: 900,
  botToken: "test-token",
  chatId: "42",
};

test("Telegram alert fires once, respects cooldown, and re-fires after the opportunity closes", async (t) => {
  resetArbitrageAlertState();
  const sentBodies: Array<Record<string, unknown>> = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /^https:\/\/api\.telegram\.org\/bottest-token\/sendMessage$/);
    sentBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const t0 = new Date("2026-11-18T00:00:00Z");
  const exchanges = [quote(1, 1.001)];

  const first = await notifyArbitrageOpportunities(exchanges, "USD", { config: TEST_CONFIG, now: t0, fetchFn });
  assert.equal(first.sent, true);
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0]?.chat_id, "42");
  assert.match(String(sentBodies[0]?.text), /OKX — USDT\/USD/);
  assert.match(String(sentBodies[0]?.text), /Sell: 1\.0010/);

  // Still present a minute later: inside the cooldown, no second message.
  const second = await notifyArbitrageOpportunities(exchanges, "USD", {
    config: TEST_CONFIG,
    now: new Date(t0.getTime() + 60_000),
    fetchFn,
  });
  assert.equal(second.due.length, 0);
  assert.equal(sentBodies.length, 1);

  // Opportunity closes, then returns: alert again immediately.
  await notifyArbitrageOpportunities([quote(1, 1)], "USD", { config: TEST_CONFIG, now: new Date(t0.getTime() + 120_000), fetchFn });
  const third = await notifyArbitrageOpportunities(exchanges, "USD", {
    config: TEST_CONFIG,
    now: new Date(t0.getTime() + 180_000),
    fetchFn,
  });
  assert.equal(third.sent, true);
  assert.equal(sentBodies.length, 2);

  // Forced checks (manual tests) bypass the cooldown.
  const forced = await notifyArbitrageOpportunities(exchanges, "USD", {
    config: TEST_CONFIG,
    now: new Date(t0.getTime() + 190_000),
    force: true,
    fetchFn,
  });
  assert.equal(forced.sent, true);
  assert.equal(sentBodies.length, 3);
  t.after(() => resetArbitrageAlertState());
});

test("no Telegram credentials means opportunities are reported but nothing is sent", async () => {
  resetArbitrageAlertState();
  let calls = 0;
  const result = await notifyArbitrageOpportunities([quote(1, 1.01, "binance")], "USD", {
    config: { ...TEST_CONFIG, botToken: null, chatId: null },
    fetchFn: async () => {
      calls++;
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.telegramConfigured, false);
  assert.equal(result.sent, false);
  assert.equal(calls, 0);
});

test("alerts/check endpoint requires the secret and sends Telegram alerts", async (t) => {
  resetArbitrageAlertState();
  const telegramBodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.telegram.org") {
      telegramBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    const aba = (price: string) => ({ price, paymentMethods: ["ABA Bank"] });
    if (url.hostname === "p2p.binance.com") {
      const { tradeType } = JSON.parse(String(init?.body));
      const price = tradeType === "BUY" ? "1.0" : "1.0";
      return Response.json({ code: "000000", data: [{ adv: { id: "b", price, tradeMethods: [{ identifier: "ABA", tradeMethodName: "ABA" }] } }] });
    }
    if (url.hostname === "www.okx.com") {
      // OKX: user buys at 1.000, user sells at 1.002 -> 0.2% opportunity.
      const price = url.searchParams.get("side") === "sell" ? "1.0" : "1.002";
      return Response.json({ code: "0", data: { buy: [aba(price)], sell: [aba(price)] } });
    }
    if (url.pathname.endsWith("/queryAllPaymentList")) {
      return Response.json({ ret_code: 0, result: { paymentConfigVo: [{ paymentType: "194", paymentName: "ABA" }] } });
    }
    if (url.pathname.endsWith("/item/online")) {
      return Response.json({ ret_code: 0, result: { items: [{ id: "by", price: "1.0", payments: ["194"] }] } });
    }
    if (url.hostname === "www.bitget.com") {
      return Response.json({ code: "00000", data: { dataList: [{ id: "bg", price: "1.0", paymethodInfo: [{ paymethodName: "ABA Bank" }] }] } });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });

  const previousEnv = { ...process.env };
  process.env.ALERTS_CHECK_SECRET = "test-secret";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "42";
  t.after(() => {
    process.env = previousEnv;
    resetArbitrageAlertState();
  });

  const unauthorized = await checkAlerts(new Request("https://example.test/api/alerts/check?fiat=USD"));
  assert.equal(unauthorized.status, 401);
  assert.equal(telegramBodies.length, 0);

  const response = await checkAlerts(new Request("https://example.test/api/alerts/check?fiat=USD&secret=test-secret"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.telegramConfigured, true);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].sent, true);
  assert.deepEqual(payload.results[0].opportunities.map((item: { exchange: string }) => item.exchange), ["okx"]);
  assert.equal(telegramBodies.length, 1);
  assert.match(String(telegramBodies[0]?.text), /OKX — USDT\/USD/);
});

test("alert message names the exchange, both merchants, and the spread", () => {
  const [opportunity] = findArbitrageOpportunities([quote(1, 1.001)], "USD", 0.1);
  assert.ok(opportunity);
  const message = formatArbitrageAlert([opportunity], 0.1, new Date("2026-11-18T00:00:00Z"));
  assert.match(message, /P2P arbitrage opportunity/);
  assert.match(message, /Buy: {2}1\.0000 USD\/USDT from Buyer/);
  assert.match(message, /Sell: 1\.0010 USD\/USDT to Seller/);
  assert.match(message, /Spread: \+0\.0010 USD \(\+0\.100%\)/);
  assert.match(message, /Profit: ≈ \$1\.00 per \$1,000 traded/);
});
