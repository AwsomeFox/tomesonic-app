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
    if (!cfg?.url || (!cfg?.accessToken && !cfg?.apiToken)) return null;
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

async function refreshAccessToken(cfg: RmabConfig): Promise<RmabConfig> {
  if (!cfg.refreshToken) throw new Error("No refresh token");
  const res = await axios.post(
    `${cfg.url}/api/auth/refresh`,
    { refreshToken: cfg.refreshToken },
    { timeout: 15000 }
  );
  const accessToken = res.data?.accessToken;
  if (!accessToken) throw new Error("Refresh failed");
  const next = { ...cfg, accessToken };
  writeRmabConfig(next);
  return next;
}

/** Authenticated request with a single 401 → refresh → retry. */
async function rmabRequest<T = any>(
  method: "get" | "post" | "delete",
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
    // Static API tokens don't refresh — a 401 there is terminal.
    if (e?.response?.status !== 401 || cfg.apiToken) throw e;
    cfg = await refreshAccessToken(cfg);
    return (await doCall(cfg)).data;
  }
}

// Discovery endpoints (series/author) scrape Audible/Audnexus live — slow
// (tens of seconds cold) but stable. Give them a generous timeout and a
// session-lifetime cache so revisits render instantly.
const DISCOVERY_TIMEOUT = 45000;
const DISCOVERY_TTL = 15 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; data: any }>();

async function discoveryGet<T = any>(path: string): Promise<T> {
  const hit = discoveryCache.get(path);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL) return hit.data as T;
  const data = await rmabRequest<T>("get", path, undefined, DISCOVERY_TIMEOUT);
  discoveryCache.set(path, { at: Date.now(), data });
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
      author: book.author,
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

/** Reverts the most recent swipe and returns its recommendation. */
export async function undoBookdateSwipe(): Promise<any> {
  return rmabRequest("post", "/api/bookdate/undo");
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
