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
  accessToken: string;
  refreshToken: string;
  user?: { id: string; username?: string; role?: string } | null;
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
    if (!cfg?.url || !cfg?.accessToken) return null;
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

/** Exchange a pasted login token for a JWT pair. Throws on bad URL/token. */
export async function exchangeLoginToken(url: string, loginToken: string): Promise<RmabConfig> {
  const base = normalize(url);
  const res = await axios.post(
    `${base}/api/auth/token/login`,
    { token: loginToken.trim() },
    { timeout: 15000 }
  );
  const { accessToken, refreshToken, user } = res.data || {};
  if (!accessToken || !refreshToken) throw new Error("Unexpected response from server");
  return { url: base, accessToken, refreshToken, user: user || null };
}

async function refreshAccessToken(cfg: RmabConfig): Promise<RmabConfig> {
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
  method: "get" | "post",
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
      headers: { Authorization: `Bearer ${c.accessToken}` },
    });
  try {
    return (await doCall(cfg)).data;
  } catch (e: any) {
    if (e?.response?.status !== 401) throw e;
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
