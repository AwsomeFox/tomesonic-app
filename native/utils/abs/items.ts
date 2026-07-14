/**
 * Item-level admin actions (metadata, covers, chapters, tools, sharing).
 * Endpoints verified against the ABS v2.35.1 ApiRouter + controllers:
 *   PATCH  /api/items/:id/media                  { ...mediaPayload } → { updated, libraryItem }  (`update` perm)
 *   GET    /api/search/books?title&author&provider&id
 *   GET    /api/search/covers?title&author&provider&podcast=1 → { results }
 *   POST   /api/items/:id/match                  { provider?, title?, author?, isbn?, asin?, overrideCover?, overrideDetails? }
 *   POST   /api/items/:id/cover                  { url } OR multipart `cover` file (`upload` perm)
 *   PATCH  /api/items/:id/cover                  { cover: <server path> } (existing local file only)
 *   DELETE /api/items/:id/cover
 *   POST   /api/items/:id/chapters               { chapters: [{id,start,end,title}] } (`update` perm)
 *   GET    /api/search/chapters?asin&region      (NOTE: can return 200 with { error } body)
 *   POST   /api/tools/item/:id/encode-m4b?bitrate=&codec=&channels=   (admin)
 *   DELETE /api/tools/item/:id/encode-m4b        (admin)
 *   POST   /api/tools/item/:id/embed-metadata?forceEmbedChapters=1&backup=1 (admin)
 *   GET    /api/items/:id/download               (zip; `download` perm — auth-target builder below)
 *   DELETE /api/items/:id?hard=1                 (`delete` perm; hard=1 also deletes files)
 *   POST   /api/share/mediaitem                  (admin; mediaItemId is the MEDIA id, not libraryItemId)
 *   DELETE /api/share/mediaitem/:id
 *
 * All functions THROW AbsError (see utils/abs/errors.ts — deliberate contrast
 * with utils/upNext.ts's swallow-everything best-effort mirror).
 */
import { api } from "../api";
import { storageHelper } from "../storage";
import { absRequest } from "./errors";
import type { AbsChapter, AbsShareLink } from "./types";

/** PATCH the item's media payload (metadata, tags, ...). Creates authors/series as needed. */
export async function updateItemMedia(
  itemId: string,
  mediaPayload: any
): Promise<{ updated: boolean; libraryItem: any }> {
  return absRequest(() => api.patch(`/api/items/${itemId}/media`, mediaPayload));
}

/** Provider metadata search (Match tab). Pass `id` to seed from an existing item. */
export async function searchBookMetadata(params: {
  title?: string;
  author?: string;
  provider?: string;
  id?: string;
}): Promise<any[]> {
  const data = await absRequest<any>(() => api.get("/api/search/books", { params }));
  return Array.isArray(data) ? data : [];
}

/** Provider cover search → list of cover URLs. Set podcast for podcast items. */
export async function searchCovers(params: {
  title: string;
  author?: string;
  provider?: string;
  podcast?: boolean;
}): Promise<string[]> {
  const { podcast, ...rest } = params;
  const data = await absRequest<any>(() =>
    api.get("/api/search/covers", { params: { ...rest, ...(podcast ? { podcast: 1 } : {}) } })
  );
  return Array.isArray(data?.results) ? data.results : [];
}

/** Quick-match one item against a provider (server applies the best hit). */
export async function quickMatchItem(
  itemId: string,
  options?: {
    provider?: string;
    title?: string;
    author?: string;
    isbn?: string;
    asin?: string;
    overrideCover?: boolean;
    overrideDetails?: boolean;
  }
): Promise<any> {
  return absRequest(() => api.post(`/api/items/${itemId}/match`, options || {}));
}

/** Have the SERVER download a cover image from a URL. */
export async function setCoverFromUrl(
  itemId: string,
  url: string
): Promise<{ success: boolean; cover: string }> {
  return absRequest(() => api.post(`/api/items/${itemId}/cover`, { url }));
}

/**
 * Upload a local image file as the cover (multipart field name `cover` —
 * verified: the controller reads req.files.cover).
 */
export async function uploadCoverFile(
  itemId: string,
  file: { uri: string; name?: string; type?: string }
): Promise<{ success: boolean; cover: string }> {
  const form = new FormData();
  form.append("cover", {
    uri: file.uri,
    name: file.name || "cover.jpg",
    type: file.type || "image/jpeg",
  } as any);
  return absRequest(() =>
    api.post(`/api/items/${itemId}/cover`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    })
  );
}

export async function removeCover(itemId: string): Promise<void> {
  await absRequest(() => api.delete(`/api/items/${itemId}/cover`));
}

/** Replace the item's chapter list wholesale. */
export async function updateChapters(
  itemId: string,
  chapters: AbsChapter[]
): Promise<{ success: boolean; chapters: AbsChapter[] }> {
  return absRequest(() => api.post(`/api/items/${itemId}/chapters`, { chapters }));
}

/**
 * Audnexus chapter lookup by ASIN. NOTE: the server signals a miss with a
 * 200 + `{ error, stringKey }` body (not a 4xx) — callers must check
 * `result.error` before using `result.chapters`.
 */
export async function searchChaptersByAsin(asin: string, region: string = "us"): Promise<any> {
  return absRequest(() => api.get("/api/search/chapters", { params: { asin, region } }));
}

/** Start an m4b encode task (watch /api/tasks for progress). Options ride the query string. */
export async function encodeM4b(
  itemId: string,
  options?: { bitrate?: string; codec?: string; channels?: string }
): Promise<void> {
  await absRequest(() =>
    api.post(`/api/tools/item/${itemId}/encode-m4b`, undefined, { params: options })
  );
}

export async function cancelEncodeM4b(itemId: string): Promise<void> {
  await absRequest(() => api.delete(`/api/tools/item/${itemId}/encode-m4b`));
}

/** Start an embed-metadata task (watch /api/tasks for progress). */
export async function embedMetadata(
  itemId: string,
  opts?: { forceEmbedChapters?: boolean; backup?: boolean }
): Promise<void> {
  await absRequest(() =>
    api.post(`/api/tools/item/${itemId}/embed-metadata`, undefined, {
      params: {
        ...(opts?.forceEmbedChapters ? { forceEmbedChapters: 1 } : {}),
        ...(opts?.backup ? { backup: 1 } : {}),
      },
    })
  );
}

/**
 * DESTRUCTIVE: delete a library item. A soft delete (no opts) removes the
 * library record only; `hard: true` adds ?hard=1, which ALSO deletes the
 * item's files from disk. There is no undo for either — callers must confirm
 * with the user before invoking.
 */
export async function deleteLibraryItem(
  itemId: string,
  opts?: { hard?: boolean }
): Promise<void> {
  const url = `/api/items/${encodeURIComponent(itemId)}`;
  await absRequest(() => (opts?.hard ? api.delete(url, { params: { hard: 1 } }) : api.delete(url)));
}

/**
 * Auth target for the item zip download (GET /api/items/:id/download):
 * the plain URL plus the session token for the caller to send as an
 * Authorization: Bearer header on an in-app streaming download
 * (utils/downloader.downloadFileByUrl). Null when the session is missing
 * pieces (mirrors utils/urls.coverUrl).
 *
 * SECURITY (#68 — resolved for items): the token now travels in the
 * Authorization header, never the query string, so it can't land in
 * browser / download-manager history (or server access logs).
 */
export function getItemZipDownloadTarget(itemId: string): { url: string; token: string } | null {
  const cfg = storageHelper.getServerConfig();
  if (!cfg?.address || !cfg?.token || !itemId) return null;
  const host = cfg.address.replace(/\/$/, "");
  return { url: `${host}/api/items/${itemId}/download`, token: cfg.token };
}

/**
 * Create a public share link. `mediaItemId` is the MEDIA id (book.id /
 * podcastEpisode.id), NOT the libraryItemId — verified against
 * ShareController. `expiresAt` is a unix-ms timestamp, or 0 for never
 * (null is rejected by the server).
 */
export async function createShareLink(params: {
  slug: string;
  mediaItemId: string;
  mediaItemType: "book" | "podcastEpisode";
  expiresAt: number;
  isDownloadable?: boolean;
}): Promise<AbsShareLink> {
  return absRequest(() => api.post("/api/share/mediaitem", params));
}

export async function deleteShareLink(shareId: string): Promise<void> {
  await absRequest(() => api.delete(`/api/share/mediaitem/${shareId}`));
}
