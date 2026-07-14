/**
 * Device → server media upload (issue #57).
 *
 * ENDPOINT CONFIDENCE — READ THIS. Unlike utils/abs/items.ts (verified against
 * the ABS v2.35.1 server source), the `POST /api/upload` multipart shape here is
 * pinned from the ABS WEB CLIENT's upload behavior, NOT line-by-line against the
 * server — MEDIUM confidence:
 *   POST /api/upload   multipart/form-data  (`upload` perm)
 *     body fields: library, folder, title?, author?, series?
 *     files:       appended under numeric string keys "0","1",... (the server
 *                  reads Object.values(req.files); the web client keys them by
 *                  index). This file-key strategy is the single riskiest guess.
 * A wrong field name simply makes the server reject the request; absRequest maps
 * that to an AbsError (server/unknown kind) which callers surface as a failure
 * dialog — never a crash. Callers MUST handle AbsError.
 *
 * The heavy lifting (streaming a large file with progress/cancel/retry) lives in
 * utils/mediaUploader.ts, which drives a bare XMLHttpRequest against the URL from
 * getUploadTarget() so upload progress events fire and the shared axios instance's
 * 20s timeout / 401-refresh interceptor never sees a multi-hundred-MB body. The
 * uploadMedia() axios variant below is the contract-pinned entry and a
 * small-file fallback.
 */
import { api } from "../api";
import { storageHelper } from "../storage";
import { absRequest } from "./errors";

export interface UploadMediaParams {
  libraryId: string;
  folderId: string;
  title?: string;
  author?: string;
  series?: string;
  /** RN file parts — streamed from disk by the native layer, not buffered. */
  files: { uri: string; name: string; type?: string }[];
}

/**
 * Multipart upload of one or more media files into a server library folder.
 * THIN by design: it carries the endpoint contract row and serves as the
 * small-file fallback. Large uploads go through utils/mediaUploader for
 * progress/cancel. THROWS AbsError.
 */
export async function uploadMedia(params: UploadMediaParams): Promise<any> {
  const form = new FormData();
  form.append("library", params.libraryId);
  form.append("folder", params.folderId);
  if (params.title) form.append("title", params.title);
  if (params.author) form.append("author", params.author);
  if (params.series) form.append("series", params.series);
  // Files keyed by index ("0","1",...) — the web client's scheme; the server
  // reads Object.values(req.files).
  params.files.forEach((f, i) => {
    form.append(String(i), {
      uri: f.uri,
      name: f.name,
      type: f.type || "application/octet-stream",
    } as any);
  });
  return absRequest(() =>
    api.post("/api/upload", form, {
      headers: { "Content-Type": "multipart/form-data" },
      // A large body would blow the 20s global timeout — disable it here.
      timeout: 0,
    })
  );
}

/**
 * Host + bearer token for the streaming XHR uploader (utils/mediaUploader).
 * PURE — no network — so it's exempt from the endpoint contract table, exactly
 * like items.getItemZipDownloadTarget. Returns null when the session is
 * incomplete (logged out / no server address).
 */
export function getUploadTarget(): { url: string; token: string } | null {
  const cfg = storageHelper.getServerConfig();
  if (!cfg?.address || !cfg?.token) return null;
  const host = cfg.address.replace(/\/$/, "");
  return { url: `${host}/api/upload`, token: cfg.token };
}
