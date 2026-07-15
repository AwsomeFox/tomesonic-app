/**
 * Server maintenance: backups, logs, caches, settings, tags/genres, API keys.
 * Endpoints verified against the ABS v2.35.1 ApiRouter + controllers (all
 * admin-and-up unless noted):
 *   GET    /api/backups                → { backups, backupLocation, backupPathEnvSet }
 *   POST   /api/backups                → { backups } (synchronous create)
 *   DELETE /api/backups/:id            → { backups }
 *   GET    /api/backups/:id/apply      SIDE-EFFECTING: restores the backup
 *   GET    /api/backups/:id/download?token=   (URL builder below)
 *   GET    /api/logger-data            → { currentDailyLogs }   ← see getServerLogs note
 *   POST   /api/cache/purge
 *   POST   /api/cache/items/purge
 *   PATCH  /api/settings               → { serverSettings }
 *   GET    /api/tags                   → { tags }
 *   POST   /api/tags/rename            { tag, newTag }
 *   DELETE /api/tags/:tag              (URI-encoded)
 *   GET    /api/genres                 → { genres }
 *   POST   /api/genres/rename          { genre, newGenre }
 *   DELETE /api/genres/:genre          (URI-encoded)
 *   GET    /api/api-keys               → { apiKeys }
 *   POST   /api/api-keys               { name, userId, expiresIn?, isActive? } → { apiKey }
 *   PATCH  /api/api-keys/:id           (only isActive/userId are updatable)
 *   DELETE /api/api-keys/:id
 *
 * All functions THROW AbsError (see utils/abs/errors.ts).
 */
import { api } from "../api";
import { storageHelper } from "../storage";
import { useUserStore } from "../../store/useUserStore";
import { absRequest } from "./errors";
import { bumpSettingsWriteSeq } from "./capabilities";
import type { AbsApiKey, AbsBackup } from "./types";

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export async function getBackups(): Promise<{
  backups: AbsBackup[];
  backupLocation: string;
  backupPathEnvSet?: boolean;
}> {
  return absRequest(() => api.get("/api/backups"));
}

/** Create a backup NOW (synchronous server-side — can take a while on big libraries). */
export async function createBackup(): Promise<{ backups: AbsBackup[] }> {
  // Zipping a big library synchronously can easily exceed the 20s global
  // timeout; when it did, axios aborted with ECONNABORTED (mapped to "offline"),
  // so the admin saw "Couldn't create backup — you're offline" even though the
  // server finished, and a retry produced a duplicate. Disable the timeout here,
  // mirroring uploadMedia.
  return absRequest(() => api.post("/api/backups", undefined, { timeout: 0 }));
}

export async function deleteBackup(backupId: string): Promise<{ backups: AbsBackup[] }> {
  return absRequest(() => api.delete(`/api/backups/${backupId}`));
}

/**
 * Apply (RESTORE) a backup — GET /api/backups/:id/apply.
 *
 * DANGER: despite the GET verb, this is a heavily SIDE-EFFECTING call
 * (verified against the ABS v2.35.1 BackupController.apply): the server
 * unzips the backup over its live database, REPLACING ALL SERVER DATA —
 * users, listening progress, libraries — and re-initializes itself. Every
 * session (including the caller's) may be invalidated, and the HTTP response
 * often never arrives because the connection drops mid-swap. Callers MUST
 * treat a network-level failure as "probably restoring anyway" and MUST
 * NEVER auto-retry this request.
 */
export async function applyBackup(backupId: string): Promise<void> {
  // 404 here is a REAL miss (the backup row we just listed was deleted from
  // under us — e.g. rotation or another admin), not a too-old server; the
  // default "unsupported / needs an update" copy would mislead.
  await absRequest(() => api.get(`/api/backups/${backupId}/apply`), {
    404: { kind: "unknown", message: "That backup no longer exists on the server." },
  });
}

/**
 * Tokened URL for GET /api/backups/:id/download — for the OS download
 * manager, which can't send our auth header. Null when the session is
 * missing pieces.
 *
 * SECURITY: the ADMIN session JWT rides in the query string, so it lands in
 * browser / download-manager history (and potentially server access logs).
 * An in-app streaming download that keeps the token in headers is tracked
 * in issue #68.
 */
export function buildBackupDownloadUrl(backupId: string): string | null {
  const cfg = storageHelper.getServerConfig();
  if (!cfg?.address || !cfg?.token || !backupId) return null;
  const host = cfg.address.replace(/\/$/, "");
  return `${host}/api/backups/${backupId}/download?token=${cfg.token}`;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/**
 * Fetch the server's recent log lines.
 *
 * LIMITATION (verified against the v2.35.1 server source): the ABS web
 * client's live log view is SOCKET-ONLY (a `log` socket event after a
 * `set_log_listener` emit) — there is no REST endpoint that streams or pages
 * historical logs. The only REST surface is GET /api/logger-data, which
 * returns a snapshot of the most recent CURRENT-DAY log lines as
 * { currentDailyLogs: [...] }. This function wraps that snapshot; callers
 * wanting "live" logs must re-poll it.
 */
export async function getServerLogs(): Promise<any[]> {
  const data = await absRequest<any>(() => api.get("/api/logger-data"));
  return Array.isArray(data?.currentDailyLogs) ? data.currentDailyLogs : [];
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

export async function purgeCache(): Promise<void> {
  await absRequest(() => api.post("/api/cache/purge"));
}

export async function purgeItemsCache(): Promise<void> {
  await absRequest(() => api.post("/api/cache/items/purge"));
}

// ---------------------------------------------------------------------------
// Server settings
// ---------------------------------------------------------------------------

/**
 * PATCH /api/settings with a partial update. The server responds with the
 * FULL updated serverSettings blob, which we write into useUserStore so
 * getCapabilities()/useServerCapabilities() (and any settings screen) see
 * the fresh values immediately.
 *
 * The write bumps capabilities' settingsWriteSeq so an /api/authorize
 * response that was already in flight (refreshCapabilities) can detect it
 * and skip overwriting this fresh echo with its stale pre-PATCH blob.
 */
export async function updateServerSettings(update: Record<string, any>): Promise<any> {
  const data = await absRequest<any>(() => api.patch("/api/settings", update));
  const serverSettings = data?.serverSettings;
  if (serverSettings && typeof serverSettings === "object") {
    bumpSettingsWriteSeq();
    useUserStore.setState({ serverSettings });
  }
  return serverSettings ?? null;
}

// ---------------------------------------------------------------------------
// Tags & genres
// ---------------------------------------------------------------------------

export async function getTags(): Promise<string[]> {
  const data = await absRequest<any>(() => api.get("/api/tags"));
  return Array.isArray(data?.tags) ? data.tags : [];
}

export async function renameTag(tag: string, newTag: string): Promise<any> {
  return absRequest(() => api.post("/api/tags/rename", { tag, newTag }));
}

export async function deleteTag(tag: string): Promise<any> {
  return absRequest(() => api.delete(`/api/tags/${encodeURIComponent(tag)}`));
}

export async function getGenres(): Promise<string[]> {
  const data = await absRequest<any>(() => api.get("/api/genres"));
  return Array.isArray(data?.genres) ? data.genres : [];
}

export async function renameGenre(genre: string, newGenre: string): Promise<any> {
  return absRequest(() => api.post("/api/genres/rename", { genre, newGenre }));
}

export async function deleteGenre(genre: string): Promise<any> {
  return absRequest(() => api.delete(`/api/genres/${encodeURIComponent(genre)}`));
}

// ---------------------------------------------------------------------------
// API keys (server >= MIN_VERSION_API_KEYS; older servers 404 → "unsupported")
// ---------------------------------------------------------------------------

export async function getApiKeys(): Promise<AbsApiKey[]> {
  const data = await absRequest<any>(() => api.get("/api/api-keys"));
  return Array.isArray(data?.apiKeys) ? data.apiKeys : [];
}

/**
 * Create an API key. `expiresIn` is in SECONDS (omit for no expiry). The
 * returned object's `apiKey` field (the actual token) is shown ONLY here —
 * it can never be fetched again.
 */
export async function createApiKey(params: {
  name: string;
  userId: string;
  expiresIn?: number;
  isActive?: boolean;
}): Promise<AbsApiKey> {
  const data = await absRequest<any>(() => api.post("/api/api-keys", params));
  return data?.apiKey ?? data;
}

/** Only isActive and userId are updatable (name/expiry live inside the JWT). */
export async function updateApiKey(
  apiKeyId: string,
  params: { isActive?: boolean; userId?: string }
): Promise<AbsApiKey> {
  const data = await absRequest<any>(() => api.patch(`/api/api-keys/${apiKeyId}`, params));
  return data?.apiKey ?? data;
}

export async function deleteApiKey(apiKeyId: string): Promise<void> {
  await absRequest(() => api.delete(`/api/api-keys/${apiKeyId}`));
}
