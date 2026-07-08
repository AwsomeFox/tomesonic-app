import axios from "axios";
import { secureStorage } from "./storage";

/**
 * ReadMeABook (RMAB) client — a self-hosted request/automation server for
 * audiobooks (github.com/kikootwo/readmeabook). The app talks to it for
 * DISCOVERY (what exists on Audible that's NOT in the library) and REQUESTS.
 *
 * Auth: the user pastes their RMAB login token (profile → login token);
 * POST /api/auth/token/login exchanges it for a JWT pair. Access tokens are
 * short-lived; /api/auth/refresh mints a new one from the (non-rotating)
 * refresh token, so a single 401→refresh→retry covers expiry.
 *
 * Every search/series/author response is enriched server-side with
 * `isAvailable` (already in the linked library) and `requestStatus` — the
 * "missing books" features are just `!isAvailable` filters over these.
 */

const CONFIG_KEY = "rmab_config";

export interface RmabConfig {
  url: string;
  /** JWT mode (login token exchanged) — full API access. */
  accessToken?: string;
  refreshToken?: string;
  /** Static rmab_ API token mode — allowlisted endpoints only
   *  (auth/me, audiobooks/search, requests). */
  apiToken?: string;
  /** How the session was established — drives re-login routing when it
   *  expires ('oidc' → SSO WebView, else → the token connect sheet). */
  authProvider?: "oidc" | "loginToken" | "apiToken";
  user?: { id: string; username?: string; role?: string } | null;
}

/** Static API tokens can only hit search + requests; series/author lookups
 *  need the JWT (login-token) mode. */
export function rmabAuthMode(cfg: RmabConfig | null): "jwt" | "apiToken" | null {
  if (!cfg) return null;
  return cfg.apiToken ? "apiToken" : "jwt";
}

export interface RmabBook {
  asin: string;
  title: string;
  author?: string;
  narrator?: string;
  description?: string;
  coverArtUrl?: string;
  releaseDate?: string;
  isAvailable?: boolean;
  requestStatus?: string | null;
  [key: string]: any;
}

export function readRmabConfig(): RmabConfig | null {
  try {
    const raw = secureStorage.getString(CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg?.url) return null;
    // JWT mode needs BOTH tokens: access tokens are short-lived and the only
    // recovery from a 401 is the refresh flow, which throws without a
    // refreshToken. Static apiTokens never refresh, so they stand alone.
    if (!cfg?.apiToken && !(cfg?.accessToken && cfg?.refreshToken)) return null;
    return cfg as RmabConfig;
  } catch {
    return null;
  }
}

export function writeRmabConfig(cfg: RmabConfig | null) {
  try {
    if (cfg) secureStorage.set(CONFIG_KEY, JSON.stringify(cfg));
    else secureStorage.remove(CONFIG_KEY);
  } catch {}
}

const normalize = (url: string) => url.trim().replace(/\/+$/, "");

/**
 * Turn a pasted token into a working config. BOTH RMAB token kinds share the
 * rmab_ prefix (login tokens come from the same generator as API tokens), so
 * the prefix can't disambiguate — instead try the login-token exchange (full
 * JWT access) and fall back to static API-token validation, or the reverse
 * when the caller knows it came from the API-token field.
 */
export async function exchangeLoginToken(
  url: string,
  loginToken: string,
  opts?: { preferApiToken?: boolean }
): Promise<RmabConfig> {
  const base = normalize(url);
  const token = loginToken.trim();

  const asLoginToken = async (): Promise<RmabConfig> => {
    const res = await axios.post(`${base}/api/auth/token/login`, { token }, { timeout: 15000 });
    const { accessToken, refreshToken, user } = res.data || {};
    if (!accessToken || !refreshToken) throw new Error("Unexpected response from server");
    return { url: base, accessToken, refreshToken, user: user || null };
  };

  const asApiToken = async (): Promise<RmabConfig> => {
    const me = await axios.get(`${base}/api/auth/me`, {
      timeout: 15000,
      headers: { Authorization: `Bearer ${token}` },
    });
    const user = me.data?.user || me.data || null;
    return { url: base, apiToken: token, user };
  };

  const order = opts?.preferApiToken ? [asApiToken, asLoginToken] : [asLoginToken, asApiToken];
  let lastAuthError: any = null;
  for (const attempt of order) {
    try {
      return await attempt();
    } catch (e: any) {
      const status = e?.response?.status;
      // Auth-shaped rejections mean "wrong token KIND, maybe" — try the other
      // interpretation. Anything else (network, 404, 5xx) is terminal.
      if (status === 400 || status === 401 || status === 403) {
        lastAuthError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastAuthError || new Error("Authentication failed");
}

// --- OIDC / SSO sign-in (no admin-issued login token needed) -------------
// RMAB's OIDC flow is browser-oriented: /api/auth/oidc/login redirects to the
// IdP (e.g. Authentik), and after auth the callback leaves the JWT pair in the
// final URL hash — `#authData=<uri-encoded JSON {accessToken,refreshToken,user}>`
// — plus a JS-readable accessToken cookie. A WebView drives the flow and reads
// that hash; these helpers build the URL, probe providers, and parse the result.

/** Derive the server origin from whatever the user typed — a plain address, or
 *  a one-time login URL that carries `?token=`. Assumes https for a bare host. */
export function rmabOrigin(input: string): string | null {
  const v = (input || "").trim();
  if (!v) return null;
  try { return new URL(v).origin; } catch {}
  try { return new URL(`https://${v}`).origin; } catch {}
  return null;
}

/** URL that kicks off RMAB's server-side OIDC redirect to the IdP. */
export function rmabOidcLoginUrl(input: string): string | null {
  const o = rmabOrigin(input);
  return o ? `${o}/api/auth/oidc/login` : null;
}

export interface RmabAuthProviders {
  oidcEnabled: boolean;
  oidcProviderName?: string | null;
  localLoginDisabled?: boolean;
}

/** Best-effort probe of a server's enabled auth providers, so the connect UI
 *  can label the SSO button with the real provider name (e.g. Authentik) and
 *  hide it when OIDC is off. Never throws — oidcEnabled:false on any error. */
export async function getRmabAuthProviders(input: string): Promise<RmabAuthProviders> {
  const o = rmabOrigin(input);
  if (!o) return { oidcEnabled: false };
  try {
    const res = await axios.get(`${o}/api/auth/providers`, { timeout: 12000 });
    const d = res.data || {};
    const list: any[] = Array.isArray(d.providers) ? d.providers : [];
    const oidcEnabled =
      !!d.oidcProviderName ||
      list.some((p) => (typeof p === "string" ? p === "oidc" : p?.type === "oidc" || p?.id === "oidc"));
    return {
      oidcEnabled,
      oidcProviderName: d.oidcProviderName ?? null,
      localLoginDisabled: !!d.localLoginDisabled,
    };
  } catch {
    return { oidcEnabled: false };
  }
}

/** Turn the `#authData=` payload RMAB leaves after OIDC into a JWT-mode config.
 *  The value is URI-encoded JSON: { accessToken, refreshToken, user }. Throws if
 *  it can't be parsed or is missing the token pair. */
export function parseRmabAuthData(input: string, rawAuthData: string): RmabConfig {
  const base = rmabOrigin(input) || normalize(input);
  let decoded = rawAuthData;
  // location.hash gives the value still percent-encoded; one decode yields JSON.
  try { decoded = decodeURIComponent(rawAuthData); } catch {}
  const data = JSON.parse(decoded);
  const accessToken = data?.accessToken;
  const refreshToken = data?.refreshToken;
  if (!accessToken || !refreshToken) throw new Error("Sign-in response missing tokens");
  return { url: base, accessToken, refreshToken, authProvider: "oidc", user: data?.user || null };
}

// --- Session-expiry signal ----------------------------------------------
// When the (non-rotating, ~7-day) refresh token is finally rejected there's no
// silent recovery — the user must sign in again. rmab.ts stays store-free, so
// it fires a registered callback (the store flips a `sessionExpired` flag that
// drives the re-login banner) rather than importing the store directly.
let _onSessionExpired: (() => void) | null = null;
export function setRmabSessionExpiredHandler(fn: (() => void) | null) {
  _onSessionExpired = fn;
}
function notifyRmabSessionExpired() {
  try { _onSessionExpired?.(); } catch {}
}

// Single-flight: Discover fires several RMAB calls in parallel, and after
// access-token expiry every one 401s at once — without coordination each
// POSTed its own /api/auth/refresh (redundant storm; harmless only because
// the refresh token doesn't rotate). Concurrent 401s share one refresh —
// keyed by (url, refreshToken) so a disconnect/reconnect mid-flight never
// shares a stale refresh with a different connection.
let _refreshInFlight: { key: string; promise: Promise<RmabConfig> } | null = null;
function refreshAccessToken(cfg: RmabConfig): Promise<RmabConfig> {
  const key = `${cfg.url}::${cfg.refreshToken || ""}`;
  if (_refreshInFlight && _refreshInFlight.key === key) return _refreshInFlight.promise;
  const promise = (async () => {
    try {
      if (!cfg.refreshToken) throw new Error("No refresh token");
      const res = await axios.post(
        `${cfg.url}/api/auth/refresh`,
        { refreshToken: cfg.refreshToken },
        { timeout: 15000 }
      );
      const accessToken = res.data?.accessToken;
      if (!accessToken) throw new Error("Refresh failed");
      const next = { ...cfg, accessToken };
      // Persist ONLY if this refresh still describes the stored connection —
      // a refresh landing after disconnect() used to write the token back
      // and resurrect the disconnected session (writeRmabConfig(null) undone).
      const current = readRmabConfig();
      if (current && current.url === cfg.url && current.refreshToken === cfg.refreshToken) {
        writeRmabConfig(next);
      }
      return next;
    } finally {
      if (_refreshInFlight && _refreshInFlight.key === key) _refreshInFlight = null;
    }
  })();
  _refreshInFlight = { key, promise };
  return promise;
}

/** Authenticated request with a single 401 → refresh → retry. */
async function rmabRequest<T = any>(
  method: "get" | "post" | "put" | "delete",
  path: string,
  data?: any,
  timeout = 20000
): Promise<T> {
  let cfg = readRmabConfig();
  if (!cfg) throw new Error("ReadMeABook is not configured");
  const doCall = (c: RmabConfig) =>
    axios.request<T>({
      method,
      url: `${c.url}${path}`,
      data,
      timeout,
      headers: { Authorization: `Bearer ${c.apiToken || c.accessToken}` },
    });
  try {
    return (await doCall(cfg)).data;
  } catch (e: any) {
    if (e?.response?.status !== 401) throw e;
    // Static API tokens don't refresh — a 401 means the token was revoked or
    // is otherwise dead, so the saved credential needs re-entering.
    if (cfg.apiToken) {
      notifyRmabSessionExpired();
      throw e;
    }
    try {
      cfg = await refreshAccessToken(cfg);
    } catch (refreshErr: any) {
      // Only a REJECTED refresh token (401/403) means the session is truly
      // over — a network blip must not nuke a still-valid session.
      const rs = refreshErr?.response?.status;
      if (rs === 401 || rs === 403) notifyRmabSessionExpired();
      throw refreshErr;
    }
    return (await doCall(cfg)).data;
  }
}

// Discovery endpoints (series/author) scrape Audible/Audnexus live — slow
// (tens of seconds cold) but stable. Give them a generous timeout and a
// session-lifetime cache so revisits render instantly.
const DISCOVERY_TIMEOUT = 45000;
const DISCOVERY_TTL = 15 * 60 * 1000;
// Cache keys embed full query strings, so left unbounded the map grows for
// the whole session — cap it, evicting oldest-first (Maps iterate in
// insertion order, so the first key is the oldest entry).
const DISCOVERY_CACHE_MAX = 100;
const discoveryCache = new Map<string, { at: number; data: any }>();

/** Wipe cached discovery responses — must run on connect/disconnect or a
 *  server switch keeps serving the previous account's shelves. */
export function clearRmabCaches() {
  discoveryCache.clear();
}

async function discoveryGet<T = any>(path: string): Promise<T> {
  const hit = discoveryCache.get(path);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL) return hit.data as T;
  const data = await rmabRequest<T>("get", path, undefined, DISCOVERY_TIMEOUT);
  // Expired entries can never serve again — drop them so they don't count
  // toward the cap, then make room for the insert.
  const now = Date.now();
  for (const [key, entry] of discoveryCache) {
    if (now - entry.at >= DISCOVERY_TTL) discoveryCache.delete(key);
  }
  while (discoveryCache.size >= DISCOVERY_CACHE_MAX) {
    const oldest = discoveryCache.keys().next().value;
    if (oldest === undefined) break;
    discoveryCache.delete(oldest);
  }
  discoveryCache.set(path, { at: now, data });
  return data;
}

// --- API surface --------------------------------------------------------

/** RMAB rewrites cover URLs to server-relative /api/cache/... paths once it
 *  caches them (the cache routes are public). Make them absolute. */
export function resolveRmabUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  const cfg = readRmabConfig();
  if (!cfg) return undefined;
  return `${cfg.url}${path.startsWith("/") ? "" : "/"}${path}`;
}

export async function getMe(): Promise<any> {
  return rmabRequest("get", "/api/auth/me");
}

export async function searchBooks(query: string, page = 1): Promise<RmabBook[]> {
  const data = await rmabRequest<any>(
    "get",
    `/api/audiobooks/search?q=${encodeURIComponent(query)}&page=${page}`
  );
  return data?.results || data?.books || [];
}

export async function searchSeries(query: string): Promise<any[]> {
  const data = await discoveryGet<any>(`/api/series/search?q=${encodeURIComponent(query)}`);
  return data?.results || data?.series || [];
}

export async function getSeries(asin: string, page = 1): Promise<{ books: RmabBook[]; [key: string]: any }> {
  const data = await discoveryGet<any>(`/api/series/${asin}?page=${page}`);
  // Books live under series.books in the response envelope.
  return { ...data, books: data?.series?.books || data?.books || [] };
}

export async function searchAuthors(query: string): Promise<any[]> {
  // NOTE: this endpoint's param is `name`, not `q`.
  const data = await discoveryGet<any>(`/api/authors/search?name=${encodeURIComponent(query)}`);
  return data?.results || data?.authors || [];
}

export async function getAuthorBooks(asin: string): Promise<RmabBook[]> {
  const data = await discoveryGet<any>(`/api/authors/${asin}/books`);
  return data?.results || data?.books || [];
}

/** Create a request for a book. RMAB expects the metadata it handed us back. */
export async function createRequest(book: RmabBook): Promise<any> {
  return rmabRequest("post", "/api/requests", {
    audiobook: {
      asin: book.asin,
      title: book.title,
      // RMAB's schema requires author; Audible catalog rows legitimately omit
      // it (anthologies, older titles) and an undefined here was a guaranteed
      // 400 rendered as a bare "Request failed" — the book showed in the
      // missing list AND could never be requested.
      author: book.author || "Unknown",
      narrator: book.narrator,
      description: book.description,
      coverArtUrl: book.coverArtUrl,
    },
  });
}

/** /api/requests returns the caller's requests — and for ADMINS, everyone's
 *  (server-side ownership filter) — always with the rich audiobook include
 *  (cover, narrator, description) and requester. One endpoint fits all. */
export async function listMyRequests(): Promise<any[]> {
  const data = await rmabRequest<any>("get", "/api/requests?take=100");
  return data?.results || data?.requests || [];
}

/** Request the EBOOK edition for a book (by Audible ASIN). Server-enforced:
 *  needs an ebook source configured (400 otherwise) and a JWT session (the
 *  endpoint isn't on the API-token allowlist). */
export async function requestEbookForAsin(asin: string): Promise<any> {
  return rmabRequest("post", `/api/audiobooks/${asin}/fetch-ebook`);
}

// --- RMAB home-page shelves (popular / new releases / categories) --------
// All db-backed on the server (fast) and enriched with isAvailable +
// requestStatus; cached like the other discovery calls.

export interface RmabHomeSection {
  sectionType: "popular" | "new_releases" | "category";
  categoryId?: string | null;
  categoryName?: string | null;
  sortOrder: number;
}

/** The user's configured home shelves (ordered). Not cached — edits on the
 *  web UI should show up on next focus. */
export async function getHomeSections(): Promise<RmabHomeSection[]> {
  const data = await rmabRequest<any>("get", "/api/user/home-sections");
  return data?.sections || [];
}

export async function getPopularBooks(limit = 12): Promise<RmabBook[]> {
  const data = await discoveryGet<any>(`/api/audiobooks/popular?limit=${limit}`);
  return data?.audiobooks || data?.results || [];
}

export async function getNewReleases(limit = 12): Promise<RmabBook[]> {
  const data = await discoveryGet<any>(`/api/audiobooks/new-releases?limit=${limit}`);
  return data?.audiobooks || data?.results || [];
}

export async function getAudibleCategories(): Promise<{ id: string; name: string }[]> {
  const data = await discoveryGet<any>("/api/audible/categories");
  return data?.categories || [];
}

export async function getCategoryBooks(categoryId: string, limit = 12): Promise<RmabBook[]> {
  const data = await discoveryGet<any>(
    `/api/audiobooks/category/${encodeURIComponent(categoryId)}?limit=${limit}`
  );
  return data?.audiobooks || data?.results || [];
}

// --- BookDate (AI recommendations) ---------------------------------------

export interface BookdateRec {
  id: string;
  title: string;
  author?: string;
  narrator?: string;
  description?: string;
  coverUrl?: string;
  audnexusAsin?: string;
  [key: string]: any;
}

/** Cached unswiped recs, or a fresh AI generation (SLOW — up to a minute).
 *  503 = BookDate disabled server-side. */
export async function getBookdateRecommendations(): Promise<BookdateRec[]> {
  const data = await rmabRequest<any>("get", "/api/bookdate/recommendations", undefined, 90000);
  return data?.recommendations || [];
}

/** action "right" = like (the server creates a request), "left" = pass. */
export async function swipeBookdate(
  recommendationId: string,
  action: "right" | "left",
  markedAsKnown = false
): Promise<any> {
  return rmabRequest("post", "/api/bookdate/swipe", { recommendationId, action, markedAsKnown });
}

/** Force a FRESH AI generation (slow — up to a minute); returns the new
 *  deck including any cached unswiped recs. */
export async function generateBookdateRecommendations(): Promise<BookdateRec[]> {
  const data = await rmabRequest<any>("post", "/api/bookdate/generate", undefined, 120000);
  return data?.recommendations || [];
}

/** Reverts the most recent swipe and returns its recommendation. */
export async function undoBookdateSwipe(): Promise<any> {
  return rmabRequest("post", "/api/bookdate/undo");
}

export interface BookdatePreferences {
  libraryScope: "full" | "rated" | "favorites";
  favoriteBookIds: string[];
  customPrompt: string;
  onboardingComplete?: boolean;
  backendCapabilities?: { supportsRatings?: boolean };
}

export async function getBookdatePreferences(): Promise<BookdatePreferences> {
  return rmabRequest("get", "/api/bookdate/preferences");
}

export async function updateBookdatePreferences(
  prefs: Partial<Pick<BookdatePreferences, "libraryScope" | "favoriteBookIds" | "customPrompt">>
): Promise<any> {
  return rmabRequest("put", "/api/bookdate/preferences", prefs);
}

/** The user's whole library (id/title/author/coverUrl) for the favorites
 *  picker — the server returns everything; filtering is client-side. */
export async function getBookdateLibrary(): Promise<{ id: string; title: string; author?: string; coverUrl?: string | null }[]> {
  const data = await rmabRequest<any>("get", "/api/bookdate/library", undefined, 45000);
  return data?.books || [];
}

/** Admin-only: number of requests awaiting approval. */
export async function getPendingApprovalCount(): Promise<number> {
  const data = await rmabRequest<any>("get", "/api/admin/requests/pending-approval");
  return Number(data?.count ?? data?.requests?.length ?? 0) || 0;
}

/** Admin-only (server-enforced): remove a request entirely. */
export async function deleteRequest(id: string): Promise<void> {
  await rmabRequest("delete", `/api/requests/${id}`);
}

/** Admin-only: act on an awaiting-approval request. */
export async function approveRequest(id: string, action: "approve" | "deny"): Promise<void> {
  await rmabRequest("post", `/api/admin/requests/${id}/approve`, { action });
}
