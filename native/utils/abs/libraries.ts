/**
 * Library admin actions. Endpoints verified against the ABS v2.35.1
 * ApiRouter/LibraryController:
 *   POST   /api/libraries                      (create; admin)
 *   PATCH  /api/libraries/:id                  (update; admin)
 *   DELETE /api/libraries/:id                  (delete; admin)
 *   POST   /api/libraries/:id/scan?force=1     (admin; fire-and-forget 200)
 *   GET    /api/libraries/:id/matchall         (admin; NOTE: GET, not POST)
 *   GET    /api/libraries/:id/stats
 *   GET    /api/libraries/:id/narrators        → { narrators }
 *   PATCH  /api/libraries/:id/narrators/:narratorId  { name }  (needs `update` permission)
 *   GET    /api/libraries/:id/filterdata
 *
 * Narrator ids are NOT database ids: the server derives them as
 * encodeURIComponent(base64(name)) — see narratorNameToId below.
 *
 * All functions THROW AbsError on failure (see utils/abs/errors.ts for why
 * this contrasts with utils/upNext.ts's swallow-everything approach).
 */
import { api } from "../api";
import { absRequest } from "./errors";
import { encodeFilterValue } from "../filters";
import type { AbsLibraryStats, AbsNarrator } from "./types";

/**
 * Base64-encode a (UTF-8) narrator name the way the server does
 * (Buffer.from(name).toString("base64")), then URI-encode — Hermes has no
 * Buffer and btoa is not guaranteed, so this is a dependency-free encoder.
 */
export function narratorNameToId(name: string): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // UTF-8 encode
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    let code = name.codePointAt(i)!;
    if (code > 0xffff) i++; // surrogate pair consumed
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
  }
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    b64 += ALPHABET[b0 >> 2];
    b64 += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    b64 += b1 === undefined ? "=" : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    b64 += b2 === undefined ? "=" : ALPHABET[b2 & 0x3f];
  }
  return encodeURIComponent(b64);
}

/** Kick off a library scan (fire-and-forget server-side; watch /api/tasks for progress). */
export async function scanLibrary(libraryId: string, opts?: { force?: boolean }): Promise<void> {
  await absRequest(() =>
    api.post(`/api/libraries/${libraryId}/scan`, undefined, {
      params: opts?.force ? { force: 1 } : undefined,
    })
  );
}

/** Quick-match every item in a book library. VERIFIED: the server route is a GET. */
export async function matchAllLibrary(libraryId: string): Promise<void> {
  await absRequest(() => api.get(`/api/libraries/${libraryId}/matchall`));
}

export async function createLibrary(payload: any): Promise<any> {
  return absRequest(() => api.post("/api/libraries", payload));
}

export async function updateLibrary(libraryId: string, payload: any): Promise<any> {
  return absRequest(() => api.patch(`/api/libraries/${libraryId}`, payload));
}

export async function deleteLibrary(libraryId: string): Promise<void> {
  await absRequest(() => api.delete(`/api/libraries/${libraryId}`));
}

export async function getLibraryStats(libraryId: string): Promise<AbsLibraryStats> {
  return absRequest<AbsLibraryStats>(() => api.get(`/api/libraries/${libraryId}/stats`));
}

export async function getLibraryNarrators(libraryId: string): Promise<AbsNarrator[]> {
  const data = await absRequest<any>(() => api.get(`/api/libraries/${libraryId}/narrators`));
  return Array.isArray(data?.narrators) ? data.narrators : [];
}

/**
 * Rename a narrator across the library. `narratorId` is the server's derived
 * id (encodeURIComponent(base64(name)) — pass AbsNarrator.id straight
 * through, or narratorNameToId(name) when starting from a bare name).
 * Returns { updated: <count> }.
 */
export async function updateNarrator(
  libraryId: string,
  narratorId: string,
  name: string
): Promise<{ updated: number }> {
  return absRequest(() => api.patch(`/api/libraries/${libraryId}/narrators/${narratorId}`, { name }));
}

export async function getLibraryFilterData(libraryId: string): Promise<any> {
  return absRequest(() => api.get(`/api/libraries/${libraryId}/filterdata`));
}

/**
 * How many items in a library carry a given tag/genre. Uses the items endpoint
 * with the same base64 filter encoding the UI filter modal uses
 * (`tags.<b64>` / `genres.<b64>`) and limit:0 so the server returns only the
 * `total` count, no item payloads. Tags/genres are server-wide but item counts
 * are per-library — callers SUM this across every library for a global count.
 *
 * encodeFilterValue() returns base64 that is ALREADY URI-encoded (it's built
 * for direct interpolation into a URL string, as the shelf/series screens do).
 * Here we pass the value through Axios `params`, which URI-encodes it AGAIN —
 * so strip the URI layer first and let Axios apply the single required
 * encoding. Otherwise "=" → "%3D" → "%253D" and the server can't decode the
 * filter (counts would silently be 0).
 */
export async function getLibraryItemFilterCount(
  libraryId: string,
  type: "tags" | "genres",
  value: string
): Promise<number> {
  const filterValue = decodeURIComponent(encodeFilterValue(value));
  const data = await absRequest<any>(() =>
    api.get(`/api/libraries/${libraryId}/items`, {
      params: { filter: `${type}.${filterValue}`, limit: 0, minified: 1 },
    })
  );
  return data?.total ?? 0;
}
