// Shared URL builders for talking to the ABS server — consolidates the
// inline token/host concatenation that used to live in downloader.ts.

/** Appends a token= query param if the url doesn't already have one. */
export function withToken(url: string, token: string): string {
  if (!token || url.includes("token=")) return url;
  return url + (url.includes("?") ? "&" : "?") + `token=${token}`;
}

/** Prefixes serverAddress onto a relative url (if not already absolute), then appends the token. */
export function absoluteUrl(url: string, serverAddress: string, token: string): string {
  const host = (serverAddress || "").replace(/\/$/, "");
  const full = url.startsWith("http") ? url : `${host}${url}`;
  return withToken(full, token);
}

/** Builds a cover-art URL for a library item, or null if inputs are missing. */
export function coverUrl(itemId: string, serverAddress: string, token: string): string | null {
  if (!token) return null; // a literal "token=undefined" URL just 401s
  if (!itemId || !serverAddress) return null;
  const host = serverAddress.replace(/\/$/, "");
  return `${host}/api/items/${itemId}/cover?token=${token}`;
}
