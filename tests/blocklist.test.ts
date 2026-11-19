import assert from "node:assert/strict";
import test from "node:test";
import { GET as quotesGET, POST as quotesPOST } from "../app/api/quotes/route";
import { GET as checkAlertsGET } from "../app/api/alerts/check/route";
import { resetArbitrageAlertState } from "../lib/alerts";
import {
  BLOCKLIST_COOKIE_NAME,
  blocklistEquals,
  decodeBlocklistCookieValue,
  deserializeMerchantBlocklist,
  encodeBlocklistCookieValue,
  readMerchantBlocklistCookie,
  serializeMerchantBlocklist,
} from "../lib/blocklist";
import { loadSideQuote } from "../lib/exchanges";
import {
  blockedMerchantFromOffer,
  blockedMerchantIdKey,
  blockedMerchantKey,
  blockedMerchantLabel,
  compileMerchantBlocklist,
  DEFAULT_BLOCKED_MERCHANTS,
  EXCHANGES,
  findBlockedMerchant,
  findBlockingMerchant,
  isBlockableMerchantName,
  isMerchantBlocked,
  isOfferBlocked,
  MAX_BLOCKED_MERCHANTS,
  MAX_MERCHANT_IDS_PER_BLOCK,
  merchantBlocklistIsEmpty,
  merchantMatchKey,
  mergeBlockedMerchant,
  normalizeBlockedMerchants,
  removeBlockedMerchant,
  type P2POffer,
  type QuotesPayload,
} from "../lib/p2p";

function offer(overrides: Partial<P2POffer> = {}): P2POffer {
  return {
    id: "ad-1",
    exchange: "binance",
    side: "buy",
    merchantId: "merchant-1",
    merchantName: "KingXchanger001",
    price: 1.001,
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

test("one name block hides the merchant on every exchange, side, and fiat", () => {
  const blocklist = compileMerchantBlocklist(["KingXchanger001"]);

  for (const { id: exchange } of EXCHANGES) {
    for (const side of ["buy", "sell"] as const) {
      for (const fiat of ["USD", "KHR"] as const) {
        assert.equal(
          isOfferBlocked(offer({ exchange, side, fiat, merchantName: "kingxchanger001" }), blocklist),
          true,
          `${exchange} ${side} ${fiat}`,
        );
      }
    }
  }

  assert.equal(isOfferBlocked(offer({ merchantName: "Someone else" }), blocklist), false);
});

test("name matching ignores case, spaces, and the punctuation exchanges decorate with", () => {
  assert.equal(merchantMatchKey(" King-Xchanger.001 "), "kingxchanger001");
  assert.equal(merchantMatchKey("KING·XCHANGER_(001)"), "kingxchanger001");

  const blocklist = compileMerchantBlocklist(["King-Xchanger.001"]);
  for (const name of ["kingxchanger001", "King Xchanger 001", "KING_XCHANGER-001", "King\u3000Xchanger001"]) {
    assert.equal(isMerchantBlocked(offer({ merchantName: name }), blocklist), true, name);
  }
  // Neighbouring advertisers must not collapse into the same key.
  assert.equal(isMerchantBlocked(offer({ merchantName: "KingXchanger002" }), blocklist), false);
  assert.equal(isMerchantBlocked(offer({ merchantName: "KingXchanger" }), blocklist), false);
});

test("an advertiser ID anchor blocks that merchant even after a rename, only on its own exchange", () => {
  const renamed = { name: "", ids: [{ exchange: "binance" as const, merchantId: "BN-77" }] };
  const blocklist = compileMerchantBlocklist([renamed]);

  assert.equal(isOfferBlocked(offer({ merchantId: "bn-77", merchantName: "Now trading alone" }), blocklist), true);
  assert.equal(
    isOfferBlocked(offer({ exchange: "okx", merchantId: "BN-77", merchantName: "Now trading alone" }), blocklist),
    false,
  );
  assert.equal(isOfferBlocked(offer({ merchantId: "other-id", merchantName: "Now trading alone" }), blocklist), false);
});

test("the anonymous placeholder name is never a name block, so it cannot hide every ad", () => {
  assert.equal(isBlockableMerchantName("P2P merchant"), false);
  assert.equal(isBlockableMerchantName("Real Trader"), true);
  assert.equal(isBlockableMerchantName("..."), false);

  assert.equal(merchantBlocklistIsEmpty(compileMerchantBlocklist(["P2P merchant"])), true);
  assert.equal(isOfferBlocked(offer({ merchantName: "P2P merchant" }), compileMerchantBlocklist(["P2P merchant"])), false);

  // Blocking an anonymous ad from its card falls back to the advertiser ID.
  const anonymous = offer({ id: "ad-anon", merchantName: "P2P merchant", merchantId: "  ax9 " });
  const entry = blockedMerchantFromOffer(anonymous);
  assert.deepEqual(entry, { name: "", ids: [{ exchange: "binance", merchantId: "ax9" }] });
  assert.equal(blockedMerchantLabel(entry!, { binance: "Binance" }), "Binance advertiser ax9");
  assert.equal(isOfferBlocked(anonymous, compileMerchantBlocklist([entry!])), true);
  assert.equal(blockedMerchantFromOffer(offer({ merchantName: "P2P merchant", merchantId: null })), null);
});

test("blocking the same merchant on a second exchange extends the entry instead of duplicating it", () => {
  let merchants = normalizeBlockedMerchants(["KingXchanger001"]);
  merchants = mergeBlockedMerchant(
    merchants,
    blockedMerchantFromOffer(offer({ exchange: "okx", merchantId: "OKX-5", merchantName: "king xchanger 001" }))!,
  );
  merchants = mergeBlockedMerchant(
    merchants,
    blockedMerchantFromOffer(offer({ exchange: "bitget", merchantId: "BG-9", merchantName: "KingXchanger001" }))!,
  );
  // Same advertiser, third exchange, matched only by ID after a rename.
  merchants = mergeBlockedMerchant(
    merchants,
    normalizeBlockedMerchants([{ name: "", ids: ["bybit:BY-2"] }])[0]!,
  );

  assert.deepEqual(merchants, [
    {
      name: "KingXchanger001",
      ids: [
        { exchange: "okx", merchantId: "OKX-5" },
        { exchange: "bitget", merchantId: "BG-9" },
      ],
    },
    { name: "", ids: [{ exchange: "bybit", merchantId: "BY-2" }] },
  ]);
  assert.equal(blockedMerchantIdKey("okx", "OKX-5"), "okx:okx-5");
  assert.equal(merchants.length, 2);

  // Blocking the same advertiser from a Binance card now adds that anchor too.
  const withBinance = mergeBlockedMerchant(
    merchants,
    blockedMerchantFromOffer(offer({ exchange: "binance", merchantId: "BN-1" }))!,
  );
  assert.equal(withBinance.length, 2);
  assert.deepEqual(
    withBinance[0]!.ids.map((id) => blockedMerchantIdKey(id.exchange, id.merchantId)).sort(),
    ["binance:bn-1", "bitget:bg-9", "okx:okx-5"],
  );
  assert.equal(withBinance[1], merchants[1]);
});

test("blocklist input is trimmed, merged, and bounded", () => {
  const merchants = normalizeBlockedMerchants([
    " KingXchanger001 ",
    "king-xchanger-001",
    { name: "Fast_sonic", ids: ["bitget:bg-1", "not-an-exchange:9", "binance:"] },
    { merchantName: "Silent Whale", exchange: "bybit", merchantId: 42 },
    "",
    123,
    { name: "x".repeat(81) },
    null,
  ]);

  assert.deepEqual(merchants.map((merchant) => merchant.name), ["KingXchanger001", "Fast_sonic", "Silent Whale"]);
  assert.deepEqual(merchants[1]!.ids, [{ exchange: "bitget", merchantId: "bg-1" }]);
  assert.deepEqual(merchants[2]!.ids, [{ exchange: "bybit", merchantId: "42" }]);

  const capped = normalizeBlockedMerchants(
    Array.from({ length: MAX_BLOCKED_MERCHANTS + 7 }, (_, index) => `Merchant${index}`),
  );
  assert.equal(capped.length, MAX_BLOCKED_MERCHANTS);

  const manyIds = normalizeBlockedMerchants([
    { name: "Many", ids: Array.from({ length: 30 }, (_, index) => `binance:id${index}`) },
  ]);
  assert.equal(manyIds[0]!.ids.length, MAX_MERCHANT_IDS_PER_BLOCK);

  assert.deepEqual(normalizeBlockedMerchants(null), []);
  assert.deepEqual(normalizeBlockedMerchants("KingXchanger001"), []);
  assert.deepEqual(normalizeBlockedMerchants({ merchants: "nope" }), []);
});

test("chip keys and the card toggle find the entry that hides an offer", () => {
  const merchants = normalizeBlockedMerchants([
    "KingXchanger001",
    { name: "", ids: [{ exchange: "okx", merchantId: "OKX-5" }] },
  ]);

  assert.equal(findBlockedMerchant(merchants, "king xchanger 001")?.name, "KingXchanger001");
  assert.equal(findBlockedMerchant(merchants, "nobody"), null);

  const byName = findBlockingMerchant(offer({ merchantName: "KING XCHANGER 001" }), merchants);
  assert.equal(byName?.name, "KingXchanger001");
  const byId = findBlockingMerchant(offer({ exchange: "okx", merchantId: "okx-5", merchantName: "Renamed" }), merchants);
  assert.equal(byId, merchants[1]);

  assert.deepEqual(removeBlockedMerchant(merchants, blockedMerchantKey(byName!)).map((merchant) => merchant.name), [""]);
  // An entry nothing can address is left alone rather than wiping the list.
  assert.equal(removeBlockedMerchant(merchants, "").length, merchants.length);
});

test("cookie storage round-trips the blocklist and reads older shapes", () => {
  const settings = {
    enabled: true,
    merchants: normalizeBlockedMerchants([
      "KingXchanger001",
      { name: "Localcambodiapayeer", ids: ["binance:BN-1", "okx:OKX-2"] },
    ]),
  };
  const value = encodeBlocklistCookieValue(settings);
  assert.ok(value);

  const header = `other=1; ${BLOCKLIST_COOKIE_NAME}=${value!}; theme=dark`;
  assert.deepEqual(readMerchantBlocklistCookie(header), settings);
  assert.deepEqual(deserializeMerchantBlocklist(serializeMerchantBlocklist(settings)), settings);
  assert.equal(blocklistEquals(settings, readMerchantBlocklistCookie(header)), true);
  assert.equal(blocklistEquals(settings, { ...settings, enabled: false }), false);

  // Legacy localStorage payloads.
  assert.deepEqual(deserializeMerchantBlocklist('["KingXchanger001","kingxchanger001"]'), {
    enabled: true,
    merchants: normalizeBlockedMerchants(["KingXchanger001"]),
  });
  assert.deepEqual(deserializeMerchantBlocklist(JSON.stringify({ enabled: false, names: ["A"] })), {
    enabled: false,
    merchants: normalizeBlockedMerchants(["A"]),
  });
  // An explicitly empty list stays empty instead of falling back to defaults.
  assert.deepEqual(deserializeMerchantBlocklist("[]"), { enabled: true, merchants: [] });
  assert.deepEqual(deserializeMerchantBlocklist(JSON.stringify({ e: 0, m: [] })), { enabled: false, merchants: [] });

  assert.equal(deserializeMerchantBlocklist("{not json"), null);
  assert.equal(deserializeMerchantBlocklist('"a string"'), null);
  assert.equal(deserializeMerchantBlocklist(""), null);
  // A payload whose list cannot be read is unreadable, not "nothing blocked".
  assert.equal(deserializeMerchantBlocklist(JSON.stringify({ e: 1, m: "nope" })), null);
  assert.equal(deserializeMerchantBlocklist(JSON.stringify({ enabled: true })), null);
  assert.equal(readMerchantBlocklistCookie(null), null);
  assert.equal(readMerchantBlocklistCookie("unrelated=1"), null);
  assert.equal(decodeBlocklistCookieValue("not-encoded-%"), null);
});

test("an oversized blocklist keeps the names and drops what will not fit", () => {
  const settings = {
    enabled: true,
    merchants: Array.from({ length: MAX_BLOCKED_MERCHANTS }, (_, index) => ({
      name: `Merchant ${index} ${"y".repeat(60)}`,
      ids: Array.from({ length: MAX_MERCHANT_IDS_PER_BLOCK }, (_, id) => ({
        exchange: "binance" as const,
        merchantId: `id-${index}-${id}-${"z".repeat(60)}`,
      })),
    })),
  };

  const value = encodeBlocklistCookieValue(settings);
  assert.ok(value);
  assert.ok(value!.length < 3_600, "the cookie value stays inside the browser budget");

  const decoded = decodeBlocklistCookieValue(value!);
  assert.ok(decoded);
  assert.equal(decoded!.enabled, true);
  assert.ok(decoded!.merchants.length > 0);
  assert.ok(decoded!.merchants.length < MAX_BLOCKED_MERCHANTS);
  // Names survive first, because they are what hides a merchant on every exchange.
  assert.equal(decoded!.merchants[0]!.name, settings.merchants[0]!.name);
  assert.equal(decoded!.merchants[0]!.ids.length, 0);
});

test("blocked ads are counted before ranking so a side can say why it is empty", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      code: "000000",
      data: [
        { adv: { advNo: "a1", price: "1.001", nickName: "King-Xchanger 001", userMaskId: "BN-77", tradeMethods: [{ tradeMethodName: "ABA Bank" }] } },
        { adv: { advNo: "a2", price: "1.002", nickName: "Honest Trader", userMaskId: "BN-8", tradeMethods: [{ tradeMethodName: "ABA Bank" }] } },
      ],
    }),
  );

  const blocked = await loadSideQuote("binance", "buy", "USD", ["KingXchanger001"]);
  assert.deepEqual(blocked.offers.map((item) => item.merchantName), ["Honest Trader"]);
  assert.equal(blocked.hiddenByBlocklist, 1);

  const emptied = await loadSideQuote("binance", "buy", "USD", [
    { name: "", ids: [{ exchange: "binance", merchantId: "BN-8" }] },
    "KingXchanger001",
  ]);
  assert.equal(emptied.status, "empty");
  assert.equal(emptied.hiddenByBlocklist, 2);
  assert.match(emptied.message ?? "", /hidden by your merchant blocklist/);

  const unfiltered = await loadSideQuote("binance", "buy", "USD", []);
  assert.equal(unfiltered.hiddenByBlocklist, 0);
  assert.equal(unfiltered.offers.length, 2);
});

/**
 * Two ABA advertisers on every exchange, priced 0.1% apart so the same fixture
 * also drives an arbitrage alert. Names are decorated differently per exchange,
 * which is exactly what a global block has to see through.
 */
function withMarketplace(run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  // The same advertiser is spelled differently on each exchange; only a loose
  // name key makes one block cover all four.
  const nameByExchange: Record<string, Record<string, string>> = {
    "p2p.binance.com": { "88": "Coin Changer 88", "89": "CoinChanger 89" },
    "www.okx.com": { "88": "coin-changer.88", "89": "CoinChanger 89" },
    "api2.bybit.com": { "88": "COIN_CHANGER-88", "89": "CoinChanger 89" },
    "www.bitget.com": { "88": "Coin-Changer 88.", "89": "CoinChanger 89" },
  };
  const listings = [
    { ad: "ad-a", id: "88", price: "1.000" },
    { ad: "ad-b", id: "89", price: "1.001" },
  ];

  const rows = (hostname: string, shape: (listing: (typeof listings)[number] & { name: string }) => Record<string, unknown>) =>
    listings.map((listing) => shape({ ...listing, name: nameByExchange[hostname][listing.id] }));

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "p2p.binance.com") {
      return Response.json({
        code: "000000",
        data: rows(url.hostname, ({ ad, name, id, price }) => ({
          adv: { advNo: ad, price, nickName: name, userMaskId: `BN-${id}`, tradeMethods: [{ tradeMethodName: "ABA Bank" }] },
        })),
      });
    }
    if (url.hostname === "www.okx.com") {
      const okxRows = rows(url.hostname, ({ ad, name, id, price }) => ({
        id: ad, price, nickName: name, merchantId: `OKX-${id}`, paymentMethods: ["ABA Bank"],
      }));
      return Response.json({ code: "0", data: { buy: okxRows, sell: okxRows } });
    }
    if (url.pathname.endsWith("/queryAllPaymentList")) {
      return Response.json({ ret_code: 0, result: { paymentConfigVo: [{ paymentType: "42", paymentName: "ABA Bank" }] } });
    }
    if (url.pathname.endsWith("/item/online")) {
      return Response.json({
        ret_code: 0,
        result: {
          items: rows(url.hostname, ({ ad, name, id, price }) => ({
            id: ad, price, payments: ["42"], userInfo: { userId: `BY-${id}`, nickName: name },
          })),
        },
      });
    }
    if (url.hostname === "www.bitget.com") {
      return Response.json({
        code: "00000",
        data: {
          dataList: rows(url.hostname, ({ ad, name, id, price }) => ({
            adNo: ad, price, nickName: name, encryptUserId: `BG-${id}`, paymethodInfo: [{ paymethodName: "ABA Bank" }],
          })),
        },
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  }) as typeof fetch;

  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

async function payloadOf(response: Response): Promise<QuotesPayload> {
  assert.equal(response.status, 200);
  return (await response.json()) as QuotesPayload;
}

function quotesRequest(body: unknown, cookie?: string): Request {
  return new Request("https://example.test/api/quotes", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test("the API blocks one merchant on all four exchanges from a single name", () =>
  withMarketplace(async () => {
    const blocked = await payloadOf(
      await quotesPOST(quotesRequest({ fiat: "USD", blockedMerchants: ["CoinChanger88", "coin changer 89"] })),
    );
    assert.equal(blocked.exchanges.length, EXCHANGES.length);
    for (const exchange of blocked.exchanges) {
      assert.equal(exchange.buy.status, "empty", exchange.id);
      assert.equal(exchange.sell.status, "empty", exchange.id);
      assert.equal(exchange.buy.hiddenByBlocklist, 2, exchange.id);
      assert.equal(exchange.arbitrage, null, exchange.id);
    }
    assert.deepEqual(blocked.blocklist?.merchants.map((merchant) => merchant.name), [
      "CoinChanger88",
      "coin changer 89",
    ]);

    const allowed = await payloadOf(await quotesPOST(quotesRequest({ fiat: "USD", blockedMerchants: [] })));
    for (const exchange of allowed.exchanges) {
      assert.equal(exchange.buy.status, "live", exchange.id);
      assert.equal(exchange.buy.hiddenByBlocklist, 0, exchange.id);
      assert.equal(exchange.buy.offers.length, 2, exchange.id);
    }

    // Blocking one of the two leaves both sides live but flattens the spread,
    // so no arbitrage alert fires.
    const halved = await payloadOf(
      await quotesPOST(quotesRequest({ fiat: "USD", blocklist: { enabled: true, merchants: [{ name: "CoinChanger88", ids: [] }] } })),
    );
    for (const exchange of halved.exchanges) {
      assert.equal(exchange.buy.status, "live", exchange.id);
      assert.equal(exchange.buy.offers.length, 1, exchange.id);
      assert.equal(exchange.buy.offers[0]?.price, 1.001, exchange.id);
      assert.equal(exchange.buy.hiddenByBlocklist, 1, exchange.id);
      assert.equal(exchange.sell.status, "live", exchange.id);
      assert.equal(exchange.arbitrage?.opportunity, false, exchange.id);
    }
  }));

test("the API reads the browser cookie when the request carries no list, and block mode off wins", () =>
  withMarketplace(async () => {
    const cookieValue = encodeBlocklistCookieValue({
      enabled: true,
      merchants: normalizeBlockedMerchants([{ name: "CoinChanger88", ids: ["okx:OKX-89"] }]),
    })!;
    const cookie = `${BLOCKLIST_COOKIE_NAME}=${cookieValue}`;

    const fromCookie = await payloadOf(
      await quotesGET(new Request("https://example.test/api/quotes?fiat=USD", { headers: { cookie } })),
    );
    assert.equal(fromCookie.blocklist?.enabled, true);
    for (const exchange of fromCookie.exchanges) {
      const anchored = exchange.id === "okx";
      // The name hides the differently spelled advertiser on all four exchanges;
      // the OKX advertiser ID additionally hides the renamed twin on OKX only.
      assert.equal(exchange.buy.status, anchored ? "empty" : "live", exchange.id);
      assert.equal(exchange.sell.status, anchored ? "empty" : "live", exchange.id);
      assert.equal(exchange.buy.hiddenByBlocklist, anchored ? 2 : 1, exchange.id);
    }

    const off = await payloadOf(
      await quotesPOST(quotesRequest({ fiat: "USD", blocklist: { enabled: false, merchants: [{ name: "CoinChanger88", ids: [] }] } }, cookie)),
    );
    assert.equal(off.blocklist?.enabled, false);
    assert.deepEqual(off.blocklist?.merchants, []);
    for (const exchange of off.exchanges) {
      assert.equal(exchange.buy.status, "live", exchange.id);
      assert.equal(exchange.sell.status, "live", exchange.id);
    }

    // No cookie and no list: the built-in defaults still apply.
    const defaults = await payloadOf(await quotesGET(new Request("https://example.test/api/quotes?fiat=USD")));
    assert.deepEqual(defaults.blocklist?.merchants.map((merchant) => merchant.name), [...DEFAULT_BLOCKED_MERCHANTS]);

    // A malformed list is rejected rather than silently ignored.
    const malformed = await quotesGET(new Request("https://example.test/api/quotes?blocked=not-json"));
    assert.equal(malformed.status, 400);
    const notAnArray = await quotesPOST(quotesRequest({ fiat: "USD", blockedMerchants: "CoinChanger88" }));
    assert.equal(notAnArray.status, 400);
  }));

test("the alert check honours the dashboard cookie and falls back to defaults for a scheduler", () =>
  withMarketplace(async () => {
    resetArbitrageAlertState();
    const blockAll = encodeBlocklistCookieValue({
      enabled: true,
      merchants: normalizeBlockedMerchants(["CoinChanger88", "coin-changer 89"]),
    })!;

    const blocked = await (
      await checkAlertsGET(new Request("https://example.test/api/alerts/check?fiat=USD", {
        headers: { cookie: `${BLOCKLIST_COOKIE_NAME}=${blockAll}` },
      }))
    ).json();
    assert.equal(blocked.blocklist.source, "cookie");
    assert.deepEqual(blocked.blocklist.merchants, ["CoinChanger88", "coin-changer 89"]);
    assert.equal(blocked.results[0].opportunities.length, 0);
    assert.equal(blocked.results[0].alerted, 0);

    // A cron scheduler sends no cookie, so the default blocklist applies — and
    // these advertisers are not in it, so the 0.1% spread still alerts.
    const scheduler = await (await checkAlertsGET(new Request("https://example.test/api/alerts/check?fiat=USD"))).json();
    assert.equal(scheduler.blocklist.source, "default");
    assert.deepEqual(scheduler.blocklist.merchants, [...DEFAULT_BLOCKED_MERCHANTS]);
    assert.equal(scheduler.results[0].opportunities.length, EXCHANGES.length);
    assert.equal(scheduler.results[0].alerted, EXCHANGES.length);
    assert.equal(scheduler.results[0].sent, false);
    resetArbitrageAlertState();
  }));
