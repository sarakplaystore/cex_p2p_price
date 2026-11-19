import { normalizeBlockedMerchants, type BlockedMerchant } from "./p2p";

/**
 * Merchant blocklist storage shared by the dashboard and the API routes.
 *
 * The list lives in a same-origin cookie as well as in localStorage, so
 * `/api/quotes` and `/api/alerts/check` filter the exact advertisers the
 * browser is hiding — blocked merchants are dropped before ranking, before
 * the arbitrage spread is computed, and before a Telegram alert is sent.
 * The cookie is written by the page (so it cannot be HttpOnly) and never
 * carries anything but merchant names and advertiser IDs.
 */
export const BLOCKLIST_COOKIE_NAME = "p2p_radar_blocklist";
export const BLOCKLIST_STORAGE_KEY = "p2p-radar-merchant-blocklist-v2";
/** Legacy localStorage key, still read once and migrated. */
export const LEGACY_BLOCKLIST_STORAGE_KEY = "p2p-radar-merchant-blocklist-v1";
export const BLOCKLIST_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

/** Browsers cap a cookie around 4 KB; leave headroom for the name and attributes. */
const MAX_COOKIE_VALUE_LENGTH = 3_200;

export interface MerchantBlocklistSettings {
  enabled: boolean;
  merchants: BlockedMerchant[];
}

type SerializedBlockedMerchant = { n: string; i: string[] };
type SerializedBlocklist = { e: 0 | 1; m: SerializedBlockedMerchant[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compact on purpose: the whole list has to fit inside one cookie. The
 * advertiser ID keeps its own casing here — matching lowercases on both sides,
 * and the chip shows the ID exactly as the exchange wrote it.
 */
export function serializeMerchantBlocklist(settings: MerchantBlocklistSettings): string {
  const payload: SerializedBlocklist = {
    e: settings.enabled ? 1 : 0,
    m: settings.merchants.map((merchant) => ({
      n: merchant.name,
      i: merchant.ids.map((id) => `${id.exchange}:${id.merchantId}`),
    })),
  };
  return JSON.stringify(payload);
}

/**
 * Reads the compact form, plus every older shape that may still be in a
 * browser: a bare array of names, or `{ enabled, names }`.
 */
export function deserializeMerchantBlocklist(raw: unknown): MerchantBlocklistSettings | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return readBlocklistSettings(parsed);
}

export function readBlocklistSettings(parsed: unknown): MerchantBlocklistSettings | null {
  if (parsed === null || parsed === undefined) return null;
  // An empty stored list must stay empty, or unblocking everything would
  // resurrect the built-in defaults on the next reload.
  if (Array.isArray(parsed)) return { enabled: true, merchants: normalizeBlockedMerchants(parsed) };
  if (!isRecord(parsed)) return null;

  const enabled =
    typeof parsed.enabled === "boolean"
      ? parsed.enabled
      : parsed.e === 1
        ? true
        : parsed.e === 0
          ? false
          : true;

  // Anything that is not a list is a payload we cannot read, so the caller
  // falls back to the defaults rather than treating the blocklist as empty.
  const stored = parsed.merchants ?? parsed.names ?? parsed.m;
  if (!Array.isArray(stored)) return null;

  const merchants = stored.map((entry) => {
    if (!isRecord(entry) || (!("n" in entry) && !("i" in entry))) return entry;
    return { name: entry.n, ids: entry.i };
  });
  return { enabled, merchants: normalizeBlockedMerchants(merchants) };
}

export function blocklistEquals(
  left: MerchantBlocklistSettings | null,
  right: MerchantBlocklistSettings | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.enabled === right.enabled &&
    serializeMerchantBlocklist(left) === serializeMerchantBlocklist(right)
  );
}

/**
 * Cookie value for a blocklist, trimmed to fit: advertiser ID anchors go
 * first, then the oldest entries, because the loose name match is what hides a
 * merchant on all four exchanges anyway.
 */
export function encodeBlocklistCookieValue(settings: MerchantBlocklistSettings): string | null {
  const withAllIds = settings.merchants;
  const withTwoIds = settings.merchants.map((merchant) => ({ ...merchant, ids: merchant.ids.slice(0, 2) }));
  const namesOnly = settings.merchants.map((merchant) => ({ ...merchant, ids: [] }));

  for (const merchants of [withAllIds, withTwoIds, namesOnly]) {
    const value = encodeURIComponent(serializeMerchantBlocklist({ enabled: settings.enabled, merchants }));
    if (value.length <= MAX_COOKIE_VALUE_LENGTH) return value;
  }

  // Even names alone do not fit: keep the leading blocks (the built-in defaults
  // first) and let the rest live in localStorage only — the dashboard always
  // posts its full list, so a truncated cookie only narrows a standalone check.
  let merchants = namesOnly;
  while (merchants.length > 0) {
    merchants = merchants.slice(0, merchants.length - 1);
    const value = encodeURIComponent(serializeMerchantBlocklist({ enabled: settings.enabled, merchants }));
    if (value.length <= MAX_COOKIE_VALUE_LENGTH) return value;
  }
  return null;
}

export function decodeBlocklistCookieValue(value: string): MerchantBlocklistSettings | null {
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A hand-written cookie may not be percent-encoded at all.
  }
  return deserializeMerchantBlocklist(decoded);
}

/** Parse a `Cookie:` request header (or `document.cookie`) for the blocklist. */
export function readMerchantBlocklistCookie(cookieHeader: string | null | undefined): MerchantBlocklistSettings | null {
  if (!cookieHeader) return null;
  const prefix = `${BLOCKLIST_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    if (!cookie.startsWith(prefix)) continue;
    return decodeBlocklistCookieValue(cookie.slice(prefix.length));
  }
  return null;
}

/** Browser side of the same read, used to hydrate the dashboard. */
export function readMerchantBlocklistCookieFromDocument(): MerchantBlocklistSettings | null {
  if (typeof document === "undefined") return null;
  return readMerchantBlocklistCookie(document.cookie);
}

/**
 * Keep the cookie in step with the panel. When even an empty cookie cannot
 * represent the list, the stale cookie is cleared so the API never filters by
 * an older snapshot than the one the dashboard is showing.
 */
export function writeMerchantBlocklistCookie(settings: MerchantBlocklistSettings): void {
  if (typeof document === "undefined") return;
  const value = encodeBlocklistCookieValue(settings);
  if (value === null) {
    clearMerchantBlocklistCookie();
    return;
  }
  document.cookie = `${BLOCKLIST_COOKIE_NAME}=${value}; Path=/; Max-Age=${BLOCKLIST_COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function clearMerchantBlocklistCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${BLOCKLIST_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
}
