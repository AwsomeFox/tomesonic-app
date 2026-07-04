import { api } from "./api";
import { storage } from "./storage";
import { appLogger } from "./logger";

// Routes all server progress syncs through here so we can queue them when
// offline instead of silently losing listening time. Pending syncs are
// stored in MMKV keyed by session id (latest wins, timeListened accumulates)
// and flushed opportunistically whenever a sync/close succeeds.

interface SyncPayload {
  sessionId: string;
  currentTime: number;
  timeListened: number;
  duration: number;
}

const PENDING_PREFIX = "pendingSync_";

function pendingKey(sessionId: string) {
  return `${PENDING_PREFIX}${sessionId}`;
}

function readPending(sessionId: string): SyncPayload | null {
  try {
    const data = storage.getString(pendingKey(sessionId));
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

// Latest currentTime/duration win; timeListened accumulates so no listened
// seconds are dropped across repeated offline ticks.
function queuePending(payload: SyncPayload) {
  try {
    const existing = readPending(payload.sessionId);
    const merged: SyncPayload = {
      sessionId: payload.sessionId,
      currentTime: payload.currentTime,
      duration: payload.duration,
      timeListened: (existing?.timeListened || 0) + (payload.timeListened || 0),
    };
    storage.set(pendingKey(payload.sessionId), JSON.stringify(merged));
  } catch (e) {
    appLogger.warn(`Failed to queue pending sync: ${e}`, "ProgressSync");
  }
}

function clearPending(sessionId: string) {
  try {
    storage.remove(pendingKey(sessionId));
  } catch {}
}

const PATCH_PREFIX = "pendingPatch_";

// Offline/local sessions can't POST to /api/session/:id/sync (the session only
// exists on-device). Instead we queue a direct media-progress PATCH, flushed
// alongside pending syncs when connectivity returns. Latest wins per item.
export function queueProgressPatch(libraryItemId: string, currentTime: number, duration: number) {
  try {
    if (!libraryItemId) return;
    const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    storage.set(
      `${PATCH_PREFIX}${libraryItemId}`,
      JSON.stringify({ libraryItemId, currentTime, duration, progress })
    );
  } catch (e) {
    appLogger.warn(`Failed to queue progress patch: ${e}`, "ProgressSync");
  }
}

async function flushPendingPatches(): Promise<void> {
  const keys = storage.getAllKeys().filter((k) => k.startsWith(PATCH_PREFIX));
  for (const key of keys) {
    try {
      const raw = storage.getString(key);
      if (!raw) {
        storage.remove(key);
        continue;
      }
      const p = JSON.parse(raw);
      await api.patch(`/api/me/progress/${p.libraryItemId}`, {
        currentTime: p.currentTime,
        duration: p.duration,
        progress: p.progress,
      });
      storage.remove(key);
    } catch (e) {
      // Still offline — keep it queued.
    }
  }
}

// Reads all pendingSync_* keys from MMKV and re-POSTs each. Removes on
// success, keeps on failure. Safe to call opportunistically (e.g. on app
// foreground) or after every successful sync.
//
// MUTEX: invoked from several triggers (app foreground, connectivity regained,
// every syncProgress). Two concurrent flushes could both read the same pending
// entry before either clears it and double-POST the same timeListened —
// concurrent callers share one in-flight run instead.
let _flushInFlight: Promise<void> | null = null;

export function flushPendingSyncs(): Promise<void> {
  if (_flushInFlight) return _flushInFlight;
  _flushInFlight = (async () => {
    try {
      await flushPendingPatches();
      const keys = storage.getAllKeys().filter((k) => k.startsWith(PENDING_PREFIX));
      for (const key of keys) {
        const sessionId = key.slice(PENDING_PREFIX.length);
        const pending = readPending(sessionId);
        if (!pending) {
          clearPending(sessionId);
          continue;
        }
        try {
          await api.post(`/api/session/${sessionId}/sync`, {
            currentTime: pending.currentTime,
            timeListened: pending.timeListened,
            duration: pending.duration,
          });
          clearPending(sessionId);
        } catch (e) {
          // Still offline / server error — leave it queued for next attempt.
        }
      }
    } catch (e) {
      appLogger.warn(`flushPendingSyncs failed: ${e}`, "ProgressSync");
    } finally {
      _flushInFlight = null;
    }
  })();
  return _flushInFlight;
}

// Wipes all queued syncs/patches. Called on logout so a previous account's
// listening time can never be flushed under the next account's credentials.
export function clearAllPending() {
  try {
    storage
      .getAllKeys()
      .filter((k) => k.startsWith(PENDING_PREFIX) || k.startsWith(PATCH_PREFIX))
      .forEach((k) => storage.remove(k));
  } catch {}
}

// Fire-and-forget progress sync. Never throws. On failure, queues the
// progress (merged with any existing pending entry) so it isn't lost.
// Local/offline sessions (id "local_*") queue a direct progress PATCH instead —
// their session id doesn't exist server-side.
export async function syncProgress(payload: SyncPayload): Promise<void> {
  const { sessionId, currentTime, timeListened, duration } = payload;
  if (!sessionId) return;
  if (sessionId.startsWith("local_")) {
    queueProgressPatch(sessionId.replace(/^local_/, ""), currentTime, duration);
    // Opportunistically flush — if we regained connectivity, this lands now.
    flushPendingSyncs().catch(() => {});
    return;
  }
  try {
    // Best-effort: clear out anything already queued before sending the
    // latest tick, so we don't double count on the next failure.
    await flushPendingSyncs();
    await api.post(`/api/session/${sessionId}/sync`, { currentTime, timeListened, duration });
  } catch (e) {
    queuePending(payload);
  }
}

// Closes the ABS session. On failure, falls back to queuing a pending sync
// so the final progress still lands once connectivity returns.
export async function closeSession(payload: SyncPayload): Promise<void> {
  const { sessionId, currentTime, timeListened, duration } = payload;
  if (!sessionId) return;
  if (sessionId.startsWith("local_")) {
    queueProgressPatch(sessionId.replace(/^local_/, ""), currentTime, duration);
    flushPendingSyncs().catch(() => {});
    return;
  }
  try {
    await api.post(`/api/session/${sessionId}/close`, { currentTime, timeListened, duration });
  } catch (e) {
    queuePending(payload);
  }
}
