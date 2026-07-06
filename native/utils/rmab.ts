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
  data?: any
): Promise<T> {
  let cfg = readRmabConfig();
  if (!cfg) throw new Error("ReadMeABook is not configured");
  const doCall = (c: RmabConfig) =>
    axios.request<T>({
      method,
      url: `${c.url}${path}`,
      data,
      timeout: 20000,
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

// --- API surface --------------------------------------------------------

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
  const data = await rmabRequest<any>(
    "get",
    `/api/series/search?q=${encodeURIComponent(query)}`
  );
  return data?.results || data?.series || [];
}

export async function getSeries(asin: string, page = 1): Promise<{ books: RmabBook[]; [key: string]: any }> {
  const data = await rmabRequest<any>("get", `/api/series/${asin}?page=${page}`);
  return { ...data, books: data?.books || [] };
}

export async function searchAuthors(query: string): Promise<any[]> {
  const data = await rmabRequest<any>(
    "get",
    `/api/authors/search?q=${encodeURIComponent(query)}`
  );
  return data?.results || data?.authors || [];
}

export async function getAuthorBooks(asin: string): Promise<RmabBook[]> {
  const data = await rmabRequest<any>("get", `/api/authors/${asin}/books`);
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

export async function listMyRequests(): Promise<any[]> {
  const data = await rmabRequest<any>("get", "/api/requests");
  return data?.results || data?.requests || [];
}

/** Admin-only: EVERYONE's requests (paginated server-side; page 1 covers
 *  the management view). */
export async function listAllRequests(): Promise<any[]> {
  const data = await rmabRequest<any>("get", "/api/admin/requests?pageSize=100");
  return data?.requests || data?.results || [];
}

/** Admin-only (server-enforced): remove a request entirely. */
export async function deleteRequest(id: string): Promise<void> {
  await rmabRequest("delete", `/api/requests/${id}`);
}

/** Admin-only: act on an awaiting-approval request. */
export async function approveRequest(id: string, action: "approve" | "deny"): Promise<void> {
  await rmabRequest("post", `/api/admin/requests/${id}/approve`, { action });
}
