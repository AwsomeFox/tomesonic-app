/**
 * Cheap "at a glance" summaries for the ServerAdminHub rows (issue #64). Each
 * function fans out to an already-audited utils/abs endpoint and reduces the
 * response to the single number/timestamp the hub row wants to annotate — so
 * the hub can fire them all in parallel (Promise.allSettled) on focus and let
 * any individual failure fall back to the row's static subtitle.
 *
 * All functions THROW AbsError (see utils/abs/errors.ts), so the hub can tell
 * an "offline" failure (→ show the offline hint) apart from a mere per-endpoint
 * miss. New file, owned by nobody else — added purely to keep the hub screen
 * from reaching around the utils/abs boundary for the libraries count.
 */
import { api } from "../api";
import { normalizeAbsError } from "./errors";
import { getUsers, getOnlineUsers } from "./users";
import { getBackups } from "./server";

export interface UsersSummary {
  total: number;
  /** null when the online count couldn't be fetched (users still shows). */
  online: number | null;
}

/**
 * Users count + connected count. The user list is the primary signal; the
 * online count is best-effort (a failed /users/online leaves online=null so the
 * row can still show "N users" rather than nothing). A failed /users rejects.
 */
export async function getUsersSummary(): Promise<UsersSummary> {
  const users = await getUsers();
  let online: number | null = null;
  try {
    online = (await getOnlineUsers()).usersOnline.length;
  } catch {
    // best-effort only — keep the users count.
  }
  return { total: users.length, online };
}

export interface BackupsSummary {
  /** Newest backup's createdAt (epoch ms), or null when there are none. */
  lastCreatedAt: number | null;
}

export async function getBackupsSummary(): Promise<BackupsSummary> {
  const { backups } = await getBackups();
  const last = backups.reduce<number | null>((max, b) => {
    // Ignore anything that isn't a real timestamp — coercing a missing/invalid
    // createdAt to 0 would surface as a bogus "1970" backup time downstream.
    if (typeof b?.createdAt !== "number" || !Number.isFinite(b.createdAt)) return max;
    return max === null || b.createdAt > max ? b.createdAt : max;
  }, null);
  return { lastCreatedAt: last };
}

export interface LibrariesSummary {
  count: number;
}

/**
 * Library count. There's no getLibraries() in utils/abs/libraries (screens hit
 * GET /api/libraries directly), so normalize the raw axios error here to keep
 * the AbsError contract the hub relies on for offline detection.
 */
export async function getLibrariesSummary(): Promise<LibrariesSummary> {
  try {
    const res = await api.get("/api/libraries");
    const raw = res.data?.libraries ?? res.data ?? [];
    return { count: Array.isArray(raw) ? raw.length : 0 };
  } catch (e) {
    throw normalizeAbsError(e);
  }
}
