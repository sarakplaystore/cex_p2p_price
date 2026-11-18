"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  arbitrageProfitPerThousand,
  DEFAULT_BLOCKED_MERCHANTS,
  DEFAULT_FIAT,
  EXCHANGES,
  INITIAL_MERCHANT_LIMIT,
  isMerchantBlocked,
  MAX_BLOCKED_MERCHANTS,
  MERCHANTS_PER_SHOW_MORE,
  normalizeBlockedMerchantNames,
  type ExchangeId,
  type ExchangeQuote,
  type FiatCurrency,
  type P2POffer,
  type P2PSide,
  type QuotesPayload,
  type SideQuote,
} from "@/lib/p2p";

const REFRESH_MS = 30_000;
const BLOCKLIST_STORAGE_KEY = "p2p-radar-merchant-blocklist-v1";
const NO_BLOCKED_MERCHANTS: readonly string[] = [];

type MerchantBlocklistSettings = {
  enabled: boolean;
  names: string[];
};

function defaultBlocklistSettings(): MerchantBlocklistSettings {
  return { enabled: true, names: [...DEFAULT_BLOCKED_MERCHANTS] };
}

function readBlocklistSettings(): MerchantBlocklistSettings {
  try {
    const raw = window.localStorage.getItem(BLOCKLIST_STORAGE_KEY);
    if (raw === null) return defaultBlocklistSettings();

    const stored: unknown = JSON.parse(raw);
    if (Array.isArray(stored)) {
      return { enabled: true, names: normalizeBlockedMerchantNames(stored) };
    }
    if (typeof stored !== "object" || stored === null) return defaultBlocklistSettings();

    const settings = stored as { enabled?: unknown; names?: unknown };
    return {
      enabled: typeof settings.enabled === "boolean" ? settings.enabled : true,
      names: normalizeBlockedMerchantNames(settings.names),
    };
  } catch {
    return defaultBlocklistSettings();
  }
}

function hideBlockedOffers(quote: SideQuote, blockedNames: readonly string[]): SideQuote {
  if (quote.status !== "live" || blockedNames.length === 0) return quote;
  const offers = quote.offers.filter((offer) => !isMerchantBlocked(offer, blockedNames));
  return offers.length > 0
    ? { ...quote, offers }
    : { status: "empty", offers: [], message: "All returned offers are in your merchant blocklist." };
}

function formatPrice(value: number, fiat: FiatCurrency): string {
  const digits = fiat === "USD" ? 4 : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: fiat,
    minimumFractionDigits: fiat === "USD" ? 3 : 0,
    maximumFractionDigits: fiat === "USD" ? digits : 2,
  }).format(value);
}

/** Signed fiat amount for the per-1,000 figure, e.g. "+$2.99" (USD) or "+KHR 5". */
function formatPerThousand(value: number, fiat: FiatCurrency): string {
  const sign = value < 0 ? "-" : "+";
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: fiat,
    minimumFractionDigits: fiat === "USD" ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return `${sign}${amount}`;
}

/** "1,000 fiat traded" base label matching the selected market. */
function thousandTradedLabel(fiat: FiatCurrency): string {
  return fiat === "USD" ? "$1,000 traded" : "1,000 KHR traded";
}

function formatLimit(value: number, fiat: FiatCurrency): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: fiat,
    maximumFractionDigits: fiat === "USD" ? 2 : 0,
  }).format(value);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function getExchangeName(id: ExchangeId): string {
  return EXCHANGES.find((exchange) => exchange.id === id)?.name ?? id;
}

function getUpdatedTime(value: string | null | undefined): string {
  if (!value) return "Waiting for first refresh";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated just now";
  return `Updated ${new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)}`;
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg className={spinning ? "refresh-icon spinning" : "refresh-icon"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16.1 7.2A6.5 6.5 0 0 0 4.7 5.1L3.1 6.7M3.1 6.7V3.8M3.1 6.7H6M3.9 12.8A6.5 6.5 0 0 0 15.3 15l1.6-1.6m0 0v2.9m0-2.9H14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrendIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg className={`trend-icon ${direction}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {direction === "up" ? (
        <path d="M4 13.5 8 9.5l3 3L16 7.5M11.5 7.5H16v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="m4 6.5 4 4 3-3 5 5M11.5 12.5H16V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function BankMark() {
  return (
    <span className="bank-mark" aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="none">
        <path d="m2.5 7 7.5-4 7.5 4M4.5 8.5v6m3.65-6v6m3.7-6v6m3.65-6v6M3 16h14M2 18h16" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function OfferCard({ offer, index, side, fiat }: { offer: P2POffer; index: number; side: P2PSide; fiat: FiatCurrency }) {
  const limit = offer.minFiat !== null || offer.maxFiat !== null
    ? `${offer.minFiat !== null ? formatLimit(offer.minFiat, fiat) : "—"} – ${offer.maxFiat !== null ? formatLimit(offer.maxFiat, fiat) : "—"}`
    : "Limits not provided";
  const activity = [
    offer.tradeCount !== null ? `${formatCount(offer.tradeCount)} trades` : null,
    offer.completionRate !== null ? `${Math.round(offer.completionRate)}% completion` : null,
  ].filter(Boolean).join(" · ");

  return (
    <article className={`offer-card ${index === 0 ? "is-best" : ""}`}>
      <div className="offer-card-top">
        <div className="merchant-title" title={offer.merchantName}>
          <span className="merchant-avatar">{offer.merchantName.slice(0, 1).toUpperCase()}</span>
          <span className="merchant-name">{offer.merchantName}</span>
        </div>
        {index === 0 ? <span className="best-pill">BEST</span> : <span className="rank-pill">{String(index + 1).padStart(2, "0")}</span>}
      </div>
      <div className="offer-price-line">
        <strong>{formatPrice(offer.price, fiat)}</strong>
        <span>/ USDT</span>
      </div>
      <div className="offer-meta-line">
        <span className="aba-tag" title={offer.paymentMethods.join(", ")}><BankMark /> ABA Bank</span>
        {offer.verified ? <span className="pro-tag">Verified</span> : null}
      </div>
      <div className="offer-divider" />
      <div className="offer-foot">
        <span className="limit-label">Limit</span>
        <span className="limit-value">{limit}</span>
      </div>
      <div className="merchant-stats">{activity || "Merchant activity not listed"}</div>
      <span className="sr-only">{side === "buy" ? "Buy from" : "Sell to"} this merchant on {getExchangeName(offer.exchange)}</span>
    </article>
  );
}

function OfferSide({
  side,
  quote,
  fiat,
  loading,
}: {
  side: P2PSide;
  quote: SideQuote | undefined;
  fiat: FiatCurrency;
  loading: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_MERCHANT_LIMIT);
  const title = side === "buy" ? "Buy USDT" : "Sell USDT";
  const description = side === "buy" ? "Lowest advertiser rate first" : "Highest advertiser rate first";
  const sideClass = side === "buy" ? "buy" : "sell";
  const offers = quote?.status === "live" ? quote.offers : [];
  const visibleOffers = offers.slice(0, visibleCount);
  const hasMore = visibleCount < offers.length;
  const nextCount = Math.min(MERCHANTS_PER_SHOW_MORE, offers.length - visibleCount);

  return (
    <section className={`side-panel ${sideClass}`} aria-label={`${title} offers`}>
      <div className="side-heading">
        <div className="side-icon"><TrendIcon direction={side === "buy" ? "down" : "up"} /></div>
        <div className="side-heading-copy">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <span className="merchant-count">{quote?.status === "live" ? `${visibleOffers.length}/${offers.length}` : "0"}</span>
      </div>

      {loading && !quote ? (
        <div className="offer-list" aria-label="Loading offers">
          <div className="offer-skeleton"><span /><span /><span /></div>
          <div className="offer-skeleton second"><span /><span /><span /></div>
        </div>
      ) : quote?.status === "live" ? (
        <>
          <div className="offer-list">
            {visibleOffers.map((offer, index) => (
              <OfferCard key={`${offer.id}-${offer.merchantId ?? offer.merchantName}`} offer={offer} index={index} side={side} fiat={fiat} />
            ))}
          </div>
          {offers.length > INITIAL_MERCHANT_LIMIT ? (
            <button
              className="show-more-button"
              type="button"
              aria-expanded={visibleCount > INITIAL_MERCHANT_LIMIT}
              onClick={() => setVisibleCount((current) => (
                current >= offers.length
                  ? INITIAL_MERCHANT_LIMIT
                  : Math.min(current + MERCHANTS_PER_SHOW_MORE, offers.length)
              ))}
            >
              {hasMore ? `Show ${nextCount} more merchant${nextCount === 1 ? "" : "s"}` : "Show fewer"}
              <span aria-hidden="true">{hasMore ? "↓" : "↑"}</span>
            </button>
          ) : null}
        </>
      ) : (
        <div className={`empty-state ${quote?.status === "error" ? "is-error" : ""}`}>
          <span className="empty-state-icon">{quote?.status === "error" ? "!" : "—"}</span>
          <p>{quote?.status === "error" ? "Feed unavailable" : quote?.status === "empty" ? quote.message ?? "No ABA Bank ads found" : "Waiting for market data"}</p>
          <span>{quote?.status === "error" ? "Try refreshing in a moment." : "Only ads that list ABA Bank are shown."}</span>
        </div>
      )}
    </section>
  );
}

function MerchantBlocklistPanel({
  settings,
  onChange,
}: {
  settings: MerchantBlocklistSettings;
  onChange: (settings: MerchantBlocklistSettings) => void;
}) {
  const [draft, setDraft] = useState("");
  const trimmedDraft = draft.trim();
  const duplicate = settings.names.some((name) => name.toLowerCase() === trimmedDraft.toLowerCase());
  const canAdd = trimmedDraft.length > 0 && !duplicate && settings.names.length < MAX_BLOCKED_MERCHANTS;

  function addMerchant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdd) return;
    onChange({
      ...settings,
      names: normalizeBlockedMerchantNames([...settings.names, trimmedDraft]),
    });
    setDraft("");
  }

  function removeMerchant(name: string) {
    onChange({
      ...settings,
      names: settings.names.filter((item) => item.toLowerCase() !== name.toLowerCase()),
    });
  }

  return (
    <section className="merchant-blocklist-panel" aria-label="Merchant blocklist">
      <div className="merchant-blocklist-header">
        <div>
          <span className="section-kicker">MERCHANT FILTER</span>
          <h2>Blocklist <span className="blocklist-count">{settings.names.length}/{MAX_BLOCKED_MERCHANTS}</span></h2>
          <p>Hide exact merchant names across all exchanges and both sides.</p>
        </div>
        <button
          className={`blocklist-mode-toggle ${settings.enabled ? "is-active" : ""}`}
          type="button"
          aria-pressed={settings.enabled}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
        >
          <span className="blocklist-mode-dot" />
          Block mode {settings.enabled ? "on" : "off"}
        </button>
      </div>
      <form className="blocklist-add-form" onSubmit={addMerchant}>
        <label className="sr-only" htmlFor="merchant-blocklist-input">Merchant name to block</label>
        <input
          id="merchant-blocklist-input"
          type="text"
          maxLength={80}
          value={draft}
          placeholder="Type a merchant name"
          onChange={(event) => setDraft(event.target.value)}
          disabled={settings.names.length >= MAX_BLOCKED_MERCHANTS}
        />
        <button type="submit" disabled={!canAdd}>Add merchant</button>
      </form>
      <div className="merchant-blocklist-list" aria-label="Blocked merchants">
        {settings.names.length > 0 ? settings.names.map((name) => (
          <span className="merchant-blocklist-chip" key={name.toLowerCase()}>
            {name}
            <button type="button" aria-label={`Remove ${name} from blocklist`} onClick={() => removeMerchant(name)}>×</button>
          </span>
        )) : <span className="merchant-blocklist-empty">No merchant names blocked.</span>}
      </div>
      <p className="merchant-blocklist-note">Names are matched case-insensitively. Changes are saved in this browser.</p>
    </section>
  );
}

function ExchangeCard({ exchange, quote, fiat, loading }: { exchange: (typeof EXCHANGES)[number]; quote: ExchangeQuote | undefined; fiat: FiatCurrency; loading: boolean }) {
  const isLive = quote?.buy.status === "live" || quote?.sell.status === "live";
  const isError = quote?.buy.status === "error" || quote?.sell.status === "error";
  const allError = quote?.buy.status === "error" && quote?.sell.status === "error";
  const stateLabel = loading && !quote ? "CONNECTING" : isLive ? "LIVE" : allError ? "OFFLINE" : isError ? "PARTIAL" : quote ? "NO MATCH" : "READY";

  return (
    <article className="exchange-card">
      <header className="exchange-card-header">
        <div className="exchange-identity">
          <span className={`exchange-mark mark-${exchange.id}`} style={{ "--exchange-color": exchange.color } as React.CSSProperties}>
            {exchange.monogram}
          </span>
          <div>
            <h2>{exchange.name}</h2>
            <p>USDT / {fiat}</p>
          </div>
        </div>
        {quote?.arbitrage?.opportunity ? (
          <span className="arb-pill" title={`Best sell price beats best buy price on this exchange — arbitrage alert threshold reached (≈ ${formatPerThousand(quote.arbitrage.profitPerThousand, fiat)} profit per ${thousandTradedLabel(fiat)}, before fees)`}>
            ARB +{quote.arbitrage.spreadPercent.toFixed(2)}% · {formatPerThousand(quote.arbitrage.profitPerThousand, fiat)}/1K
          </span>
        ) : null}
        <span className={`exchange-state ${isLive ? "state-live" : isError ? "state-error" : ""}`}>
          <span className="state-dot" />{stateLabel}
        </span>
      </header>
      <div className="exchange-card-body">
        <OfferSide key={`${exchange.id}-${fiat}-buy`} side="buy" quote={quote?.buy} fiat={fiat} loading={loading} />
        <OfferSide key={`${exchange.id}-${fiat}-sell`} side="sell" quote={quote?.sell} fiat={fiat} loading={loading} />
      </div>
    </article>
  );
}

function SummaryCard({
  kind,
  title,
  offer,
  fiat,
  detail,
  subDetail,
}: {
  kind: "buy" | "sell" | "spread";
  title: string;
  offer?: P2POffer;
  fiat: FiatCurrency;
  detail?: string | null;
  subDetail?: string | null;
}) {
  const icon = kind === "buy" ? "↓" : kind === "sell" ? "↑" : "↔";
  return (
    <article className={`summary-card summary-${kind}`}>
      <div className="summary-label"><span className="summary-icon">{icon}</span>{title}</div>
      <strong className="summary-value">{offer ? formatPrice(offer.price, fiat) : detail || "—"}</strong>
      <span className="summary-detail">
        {offer ? <><b>{getExchangeName(offer.exchange)}</b><span className="detail-separator">·</span>{offer.merchantName}</> : kind === "spread" ? (subDetail ?? "Waiting for both sides") : "No live offers yet"}
      </span>
    </article>
  );
}

export default function HomePage() {
  const [fiat, setFiat] = useState<FiatCurrency>(DEFAULT_FIAT);
  const [quotes, setQuotes] = useState<QuotesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [blocklistSettings, setBlocklistSettings] = useState<MerchantBlocklistSettings | null>(null);
  const lastSuccessfulFiat = useRef<FiatCurrency | null>(null);

  useEffect(() => {
    setBlocklistSettings(readBlocklistSettings());
  }, []);

  useEffect(() => {
    if (!blocklistSettings) return;
    try {
      window.localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(blocklistSettings));
    } catch {
      // Filtering still works for the current session if storage is unavailable.
    }
  }, [blocklistSettings]);

  useEffect(() => {
    if (!blocklistSettings) return;
    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      if (lastSuccessfulFiat.current !== fiat) setLoading(true);
      setRefreshing(true);
      setFetchError(null);

      try {
        const response = await fetch("/api/quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fiat,
            blockedMerchants: blocklistSettings.enabled ? blocklistSettings.names : [],
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await response.json()) as QuotesPayload | { error?: string };
        if (!response.ok) {
          throw new Error("error" in result && result.error ? result.error : "Could not load P2P data.");
        }
        if (active) {
          setQuotes(result as QuotesPayload);
          lastSuccessfulFiat.current = fiat;
        }
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          setFetchError(error instanceof Error ? error.message : "Could not load P2P data.");
        }
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
      controller?.abort();
    };
  }, [fiat, refreshKey, blocklistSettings]);

  const activeBlockedMerchants = blocklistSettings?.enabled
    ? blocklistSettings.names
    : NO_BLOCKED_MERCHANTS;
  const visibleQuotes = useMemo(() => {
    if (quotes?.fiat !== fiat) return null;
    if (activeBlockedMerchants.length === 0) return quotes;
    return {
      ...quotes,
      exchanges: quotes.exchanges.map((exchange) => ({
        ...exchange,
        buy: hideBlockedOffers(exchange.buy, activeBlockedMerchants),
        sell: hideBlockedOffers(exchange.sell, activeBlockedMerchants),
      })),
    };
  }, [quotes, fiat, activeBlockedMerchants]);
  const quoteByExchange = useMemo(() => {
    const map = new Map<ExchangeId, ExchangeQuote>();
    for (const quote of visibleQuotes?.exchanges ?? []) map.set(quote.id, quote);
    return map;
  }, [visibleQuotes]);

  const { bestBuy, bestSell, spreadValue, spreadPercent, profitPerThousandValue, liveSides } = useMemo(() => {
    const allBuy = (visibleQuotes?.exchanges ?? []).flatMap((exchange) => exchange.buy.offers);
    const allSell = (visibleQuotes?.exchanges ?? []).flatMap((exchange) => exchange.sell.offers);
    const buy = allBuy.slice().sort((left, right) => left.price - right.price)[0];
    const sell = allSell.slice().sort((left, right) => right.price - left.price)[0];
    const spread = buy && sell ? sell.price - buy.price : null;
    return {
      bestBuy: buy,
      bestSell: sell,
      spreadValue: spread,
      spreadPercent: spread !== null && buy && buy.price !== 0 ? (spread / buy.price) * 100 : null,
      profitPerThousandValue: buy && sell && buy.price > 0 ? arbitrageProfitPerThousand(buy.price, sell.price) : null,
      liveSides: (visibleQuotes?.exchanges ?? []).reduce(
        (total, exchange) => total + Number(exchange.buy.status === "live") + Number(exchange.sell.status === "live"),
        0,
      ),
    };
  }, [visibleQuotes]);

  const spreadDetail = spreadValue !== null && spreadPercent !== null
    ? `${spreadValue >= 0 ? "+" : ""}${formatPrice(spreadValue, fiat)} · ${spreadPercent.toFixed(2)}%`
    : null;
  const spreadSubDetail = profitPerThousandValue !== null
    ? `≈ ${formatPerThousand(profitPerThousandValue, fiat)} per ${thousandTradedLabel(fiat)}`
    : null;
  const updatedAt = visibleQuotes?.updatedAt ?? null;

  return (
    <main id="top" className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="page-container">
        <header className="topbar">
          <a className="brand" href="#top" aria-label="P2P Price Radar home">
            <span className="brand-symbol"><span /></span>
            <span className="brand-copy"><strong>P2P<span>RADAR</span></strong><small>CAMBODIA MARKET DESK</small></span>
          </a>
          <div className="topbar-right">
            <div className={`feed-status ${liveSides > 0 ? "feed-on" : ""}`}>
              <span className="feed-indicator" />
              <span>{visibleQuotes ? `${liveSides} / ${EXCHANGES.length * 2} feeds live` : "Connecting to markets"}</span>
            </div>
            <button className="refresh-button" type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={refreshing}>
              <RefreshIcon spinning={refreshing} />
              <span>{refreshing ? "Refreshing" : "Refresh"}</span>
            </button>
          </div>
        </header>

        <section className="exchange-section" aria-label="Exchange P2P offers">
          <div className="section-heading exchange-section-heading">
            <div><span className="section-kicker">ABA BANK LISTINGS</span><h2>Exchange offers <span className="count-chip">{EXCHANGES.length}</span></h2></div>
            <div className="result-legend"><span className="legend-check">✓</span> Top 2 first · expand to see more merchants</div>
          </div>
          <div className="exchange-grid">
            {EXCHANGES.map((exchange) => (
              <ExchangeCard key={exchange.id} exchange={exchange} quote={quoteByExchange.get(exchange.id)} fiat={fiat} loading={loading} />
            ))}
          </div>
        </section>

        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> P2P MARKET OVERVIEW</div>
            <h1>Find your next<br /><span>best P2P rate.</span></h1>
            <p>Compare USDT buy and sell ads that accept ABA Bank across all four exchanges.</p>
          </div>
          <div className="hero-aside">
            <div className="hero-orbit orbit-large" />
            <div className="hero-orbit orbit-small" />
            <div className="hero-aside-card">
              <div className="hero-aside-head"><span className={`market-signal ${liveSides > 0 ? "is-live" : ""}`}><i /></span><span>{liveSides > 0 ? "LIVE MARKET SNAPSHOT" : visibleQuotes ? "MARKET FEED STATUS" : "CONNECTING TO EXCHANGES"}</span></div>
              <div className="hero-aside-rate"><span>USDT</span><span className="rate-arrow">↔</span><span>{fiat}</span></div>
              <div className="hero-aside-foot"><BankMark /> <span>ABA Bank only</span><span className="foot-dot" /> <span>Top 2 per side</span></div>
            </div>
          </div>
        </section>

        <section className="controls-card" aria-label="Market filters">
          <div className="filter-group">
            <span className="filter-label">ASSET</span>
            <div className="asset-select"><span className="usdt-coin">₮</span><strong>USDT</strong><span className="filter-chevron">⌄</span></div>
          </div>
          <div className="filter-divider" />
          <div className="filter-group">
            <span className="filter-label">FIAT MARKET</span>
            <div className="fiat-switch" role="group" aria-label="Select fiat currency">
              {(["USD", "KHR"] as const).map((currency) => (
                <button key={currency} type="button" className={fiat === currency ? "selected" : ""} aria-pressed={fiat === currency} onClick={() => setFiat(currency)}>{currency}</button>
              ))}
            </div>
          </div>
          <div className="filter-divider" />
          <div className="filter-group payment-filter">
            <span className="filter-label">PAYMENT METHOD</span>
            <div className="payment-value"><BankMark /><strong>ABA Bank</strong><span className="fixed-chip">FIXED</span></div>
          </div>
          <div className="filter-spacer" />
          <div className="refresh-info"><span className="refresh-clock"><RefreshIcon /></span><span>Auto refresh<br /><b>Every 30 seconds</b></span></div>
        </section>

        {blocklistSettings ? (
          <MerchantBlocklistPanel
            settings={blocklistSettings}
            onChange={(settings) => setBlocklistSettings(settings)}
          />
        ) : null}

        {fetchError ? (
          <div className="alert-banner" role="status">
            <span className="alert-symbol">!</span>
            <span>{fetchError} Individual exchange feeds may still be available below.</span>
            <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Retry</button>
          </div>
        ) : null}

        <section className="snapshot-section" aria-label="Best available prices">
          <div className="section-heading">
            <div><span className="section-kicker">CROSS-EXCHANGE SNAPSHOT</span><h2>Market leaders</h2></div>
            <span className="updated-time"><span className="updated-dot" />{getUpdatedTime(updatedAt)}</span>
          </div>
          <div className="summary-grid">
            <SummaryCard kind="buy" title="Best price to buy" offer={bestBuy} fiat={fiat} />
            <SummaryCard kind="sell" title="Best price to sell" offer={bestSell} fiat={fiat} />
            <SummaryCard kind="spread" title="Buy / sell spread" fiat={fiat} detail={spreadDetail} subDetail={spreadSubDetail} />
          </div>
        </section>

        <footer className="page-footer">
          <div className="footer-brand"><span className="brand-symbol small"><span /></span><strong>P2P RADAR</strong></div>
          <p>Prices and merchant availability can change quickly. Confirm the listing and ABA transfer details on the exchange before trading.</p>
          <span className="footer-time">{getUpdatedTime(updatedAt)}</span>
        </footer>
      </div>
    </main>
  );
}
