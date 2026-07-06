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
  // Lets a sync against a session the server no longer knows (404 — e.g. the
  // server restarted and dropped its in-memory open sessions) fall back to a
  // direct media-progress PATCH instead of retrying forever.
  libraryItemId?: string;
  episodeId?: string;
  // When the position was READ (request build time). The queue merge keys on
  // this — failures are observed out of order (a slow older sync can reject
  // AFTER a fast-failing close), and last-caller-wins let the older position
  // overwrite the close's newer one.
  at?: number;
}

// Monotonic freshness stamp: Date.now() can jump BACKWARD (NTP sync, manual
// clock change), which inverted the queue's freshest-wins comparison and kept
// a stale position over a newer close. Never yields a smaller stamp than the
// previous one within this JS lifetime.
let _lastAtStamp = 0;
function monotonicNow(): number {
  _lastAtStamp = Math.max(Date.now(), _lastAtStamp + 1);
  return _lastAtStamp;
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

// The FRESHEST position wins (request-build `at` stamp, not caller order —
// an older in-flight sync can fail AFTER a newer close and used to overwrite
// its final position); timeListened accumulates so no listened seconds are
// dropped across repeated offline ticks.
function queuePending(payload: SyncPayload) {
  try {
    const existing = readPending(payload.sessionId);
    // Entries without a stamp (legacy) are treated as oldest.
    const takeExisting =
      existing && (Number(existing.at) || 0) > (Number(payload.at) || 0);
    const fresh = takeExisting ? (existing as SyncPayload) : payload;
    const merged: SyncPayload = {
      sessionId: payload.sessionId,
      currentTime: fresh.currentTime,
      duration: fresh.duration,
      at: Number(fresh.at) || 0,
      timeListened: (existing?.timeListened || 0) + (payload.timeListened || 0),
      // MUST survive the merge: the flush's 404 fallback (server restarted and
      // dropped the session) converts to a direct progress PATCH keyed by
      // these — dropping them here made that recovery path dead code.
      libraryItemId: payload.libraryItemId ?? existing?.libraryItemId,
      episodeId: payload.episodeId ?? existing?.episodeId,
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
// alongside pending syncs when connectivity returns. Latest wins per item
// (episodes queue independently under a composite key). `extra` carries
// additional PATCH fields — notably a one-way isFinished:true when a book is
// finished offline, which would otherwise never reach the server.
// Merges `fields` into the item's queued PATCH body (latest value per field
// wins; fields queued by other writers — e.g. audio position vs ebook cfi —
// are preserved and flushed together in one PATCH).
function mergePendingPatch(
  libraryItemId: string,
  episodeId: string | null | undefined,
  fields: Record<string, any>,
  // weak: only fill fields the queued body doesn't already have — used when
  // converting a STALE dead-session sync, whose position must not clobber a
  // newer position already queued for the same item.
  weak = false
) {
  try {
    if (!libraryItemId) return;
    const key = `${PATCH_PREFIX}${libraryItemId}${episodeId ? `-${episodeId}` : ""}`;
    let prevBody: Record<string, any> = {};
    try {
      const prevRaw = storage.getString(key);
      if (prevRaw) {
        const prev = JSON.parse(prevRaw);
        // Legacy entries stored audio fields at the top level.
        prevBody = prev?.body || {
          ...(typeof prev?.currentTime === "number"
            ? { currentTime: prev.currentTime, duration: prev.duration, progress: prev.progress }
            : {}),
          ...(prev?.extra || {}),
        };
      }
    } catch {}
    storage.set(
      key,
      JSON.stringify({
        libraryItemId,
        episodeId: episodeId || undefined,
        body: weak ? { ...fields, ...prevBody } : { ...prevBody, ...fields },
      })
    );
  } catch (e) {
    appLogger.warn(`Failed to queue progress patch: ${e}`, "ProgressSync");
  }
}

export function queueProgressPatch(
  libraryItemId: string,
  currentTime: number,
  duration: number,
  episodeId?: string | null,
  extra?: Record<string, any>,
  weak = false
) {
  // TrackPlayer positions can transiently be NaN/negative during track
  // teardown — never persist those into a future server PATCH (a null
  // currentTime would clobber real server progress). Non-finite position
  // drops the audio fields but still delivers extras like isFinished.
  const ct = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : null;
  const dur = Number.isFinite(duration) && duration > 0 ? duration : null;
  const audioFields: Record<string, any> =
    ct == null
      ? {}
      : {
          currentTime: ct,
          ...(dur != null ? { duration: dur, progress: Math.min(1, ct / dur) } : {}),
        };
  const fields = { ...audioFields, ...(extra || {}) };
  if (Object.keys(fields).length === 0) return;
  mergePendingPatch(libraryItemId, episodeId, fields, weak);
}

// Queue a bare finished/unfinished toggle (explicit user action, so unlike the
// reader's one-way finish this may legitimately send isFinished:false).
export function queueFinishedPatch(libraryItemId: string, finished: boolean) {
  mergePendingPatch(libraryItemId, null, { isFinished: finished });
}

// True when an un-flushed offline write exists for this item/episode — the
// signal that a local-only mediaProgress entry is "written here, not yet
// synced up" rather than "deleted server-side" (see useUserStore merge).
export function hasPendingWritesFor(
  libraryItemId: string,
  episodeId?: string | null
): boolean {
  try {
    const composite = `${libraryItemId}${episodeId ? `-${episodeId}` : ""}`;
    if (storage.getString(`${PATCH_PREFIX}${composite}`)) return true;
    for (const k of storage.getAllKeys()) {
      if (!k.startsWith(PENDING_PREFIX)) continue;
      try {
        const p = JSON.parse(storage.getString(k) || "null");
        if (
          p?.libraryItemId === libraryItemId &&
          (p?.episodeId || null) === (episodeId || null)
        ) {
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

// --- Offline bookmarks ------------------------------------------------------
// Bookmarks added while offline used to live only in the modal's component
// state — gone on unmount. Queue them here and flush with everything else.
const BOOKMARK_PREFIX = "pendingBookmark_";

export function queueBookmark(libraryItemId: string, time: number, title: string) {
  try {
    if (!libraryItemId || !Number.isFinite(time) || time < 0) return;
    storage.set(
      `${BOOKMARK_PREFIX}${libraryItemId}_${Math.floor(time)}`,
      JSON.stringify({ libraryItemId, time: Math.floor(time), title })
    );
  } catch (e) {
    appLogger.warn(`Failed to queue bookmark: ${e}`, "ProgressSync");
  }
}

export function removePendingBookmark(libraryItemId: string, time: number) {
  try {
    storage.remove(`${BOOKMARK_PREFIX}${libraryItemId}_${Math.floor(time)}`);
  } catch {}
}

/** Pending (queued-offline) bookmarks for an item — merged into the list UI. */
export function pendingBookmarksFor(libraryItemId: string): { time: number; title: string }[] {
  try {
    return storage
      .getAllKeys()
      .filter((k) => k.startsWith(`${BOOKMARK_PREFIX}${libraryItemId}_`))
      .map((k) => {
        try {
          return JSON.parse(storage.getString(k) || "");
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Offline DELETION of a server-synced bookmark. Creations already queue; a
// delete that failed offline was swallowed, and the bookmark silently
// reappeared from the server on the next load.
const BOOKMARK_DELETE_PREFIX = "pendingBookmarkDelete_";

export function queueBookmarkDeletion(libraryItemId: string, time: number) {
  try {
    if (!libraryItemId || !Number.isFinite(time) || time < 0) return;
    storage.set(
      `${BOOKMARK_DELETE_PREFIX}${libraryItemId}_${Math.floor(time)}`,
      JSON.stringify({ libraryItemId, time: Math.floor(time) })
    );
  } catch (e) {
    appLogger.warn(`Failed to queue bookmark deletion: ${e}`, "ProgressSync");
  }
}

/** Times (floored seconds) with a queued offline deletion for this item —
 *  the bookmark list filters these out so a deleted bookmark can't reappear
 *  from the server copy before the deletion flushes. */
export function pendingBookmarkDeletionsFor(libraryItemId: string): number[] {
  try {
    return storage
      .getAllKeys()
      .filter((k) => k.startsWith(`${BOOKMARK_DELETE_PREFIX}${libraryItemId}_`))
      .map((k) => {
        try {
          return Number(JSON.parse(storage.getString(k) || "")?.time);
        } catch {
          return NaN;
        }
      })
      .filter((t) => Number.isFinite(t));
  } catch {
    return [];
  }
}

async function flushPendingBookmarkDeletions(): Promise<void> {
  const keys = storage.getAllKeys().filter((k) => k.startsWith(BOOKMARK_DELETE_PREFIX));
  for (const key of keys) {
    let b: any = null;
    try {
      const raw = storage.getString(key);
      b = raw ? JSON.parse(raw) : null;
    } catch {}
    if (!b?.libraryItemId || !Number.isFinite(b?.time)) {
      try {
        storage.remove(key);
      } catch {}
      continue;
    }
    try {
      await api.delete(`/api/me/item/${b.libraryItemId}/bookmark/${b.time}`);
      storage.remove(key);
    } catch (e: any) {
      // Already gone server-side (or item deleted) — done either way.
      if (e?.response?.status === 404) storage.remove(key);
      // Otherwise still offline — keep it queued.
    }
  }
}

async function flushPendingBookmarks(): Promise<void> {
  const keys = storage.getAllKeys().filter((k) => k.startsWith(BOOKMARK_PREFIX));
  for (const key of keys) {
    // Corrupt entries can never send — drop instead of retrying forever.
    let b: any = null;
    try {
      const raw = storage.getString(key);
      b = raw ? JSON.parse(raw) : null;
    } catch {}
    if (!b?.libraryItemId || !Number.isFinite(b?.time)) {
      try {
        storage.remove(key);
      } catch {}
      continue;
    }
    try {
      await api.post(`/api/me/item/${b.libraryItemId}/bookmark`, {
        title: b.title,
        time: b.time,
      });
      storage.remove(key);
    } catch (e: any) {
      // Item deleted server-side — the bookmark can never land.
      if (e?.response?.status === 404) storage.remove(key);
      // Otherwise still offline — keep it queued.
    }
  }
}

// EBOOK progress queue — ebook fields ONLY (plus the one-way finish). Never
// includes `progress`/`currentTime`: those are the AUDIO fields, and flushing
// them from a reader save would clobber audio progress on both-format books.
export function queueEbookProgressPatch(
  libraryItemId: string,
  ebookLocation: string,
  ebookProgress: number,
  finished?: boolean
) {
  mergePendingPatch(libraryItemId, null, {
    ebookLocation,
    ebookProgress,
    ...(finished ? { isFinished: true } : {}),
  });
}

async function flushPendingPatches(): Promise<void> {
  const keys = storage.getAllKeys().filter((k) => k.startsWith(PATCH_PREFIX));
  for (const key of keys) {
    // Corrupt entries (bad JSON, no item id) can never send — drop them
    // instead of retrying for the lifetime of the install.
    let p: any = null;
    let sentRaw: string | undefined;
    try {
      sentRaw = storage.getString(key);
      p = sentRaw ? JSON.parse(sentRaw) : null;
    } catch {}
    if (!p || typeof p !== "object" || !p.libraryItemId) {
      try {
        storage.remove(key);
      } catch {}
      continue;
    }
    try {
      const path = p.episodeId
        ? `/api/me/progress/${encodeURIComponent(p.libraryItemId)}/${encodeURIComponent(p.episodeId)}`
        : `/api/me/progress/${encodeURIComponent(p.libraryItemId)}`;
      // New entries carry a ready-to-send body; legacy ones the old top-level
      // audio fields.
      const body =
        p.body ||
        {
          currentTime: p.currentTime,
          duration: p.duration,
          progress: p.progress,
          ...(p.extra || {}),
        };
      await api.patch(path, body);
      // TOCTOU guard (mirrors the pending-sync loop): a write merged into
      // this SAME key during the await — the finish toggle at the end of a
      // book is a one-shot that never re-queues — must not be deleted with
      // the entry. Remove only if the entry is byte-identical to what we
      // sent; otherwise leave the merged entry for the next flush pass
      // (re-sending already-delivered fields is harmless — the PATCH is
      // per-field latest-wins).
      if (storage.getString(key) === sentRaw) storage.remove(key);
    } catch (e: any) {
      // 404 = the item no longer exists server-side — a retry can never
      // succeed (mirrors the pending-sync loop's give-up rule).
      if (e?.response?.status === 404) storage.remove(key);
      // Otherwise still offline — keep it queued.
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
      await flushPendingBookmarks();
      await flushPendingBookmarkDeletions();
      const keys = storage.getAllKeys().filter((k) => k.startsWith(PENDING_PREFIX));
      for (const key of keys) {
        const sessionId = key.slice(PENDING_PREFIX.length);
        const pending = readPending(sessionId);
        // Truthy garbage (a stored `42`) passed the null check and POSTed a
        // body of undefineds — require a real object with numbers.
        if (!pending || typeof pending !== "object" || !Number.isFinite(Number(pending.currentTime))) {
          clearPending(sessionId);
          continue;
        }
        try {
          await api.post(`/api/session/${sessionId}/sync`, {
            currentTime: pending.currentTime,
            timeListened: pending.timeListened,
            duration: pending.duration,
          });
          // TOCTOU guard: while our POST was in flight, a concurrent failed
          // sync may have merged NEW seconds into this entry. Blind-clearing
          // would eat them (verified listening-time loss under flaky
          // networks) — clear only what we actually delivered, keep the rest.
          const now = readPending(sessionId);
          if (now && (now.timeListened || 0) > (pending.timeListened || 0)) {
            storage.set(
              pendingKey(sessionId),
              JSON.stringify({
                ...now,
                timeListened: (now.timeListened || 0) - (pending.timeListened || 0),
              })
            );
          } else {
            clearPending(sessionId);
          }
        } catch (e: any) {
          // 404 = the server no longer knows this session (restart drops open
          // sessions) — it will NEVER succeed. Convert to a direct progress
          // PATCH when we know the item; either way stop retrying forever.
          if (e?.response?.status === 404) {
            if (pending.libraryItemId) {
              // WEAK merge: this pending entry is by definition stale (it
              // queued before the session died) — it must not clobber a newer
              // position already queued for the same item.
              queueProgressPatch(
                pending.libraryItemId,
                pending.currentTime,
                pending.duration,
                pending.episodeId,
                undefined,
                true
              );
            }
            clearPending(sessionId);
          }
          // Otherwise still offline / server error — leave it queued.
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

// True when any offline listening/progress is still queued locally — i.e.
// the server's stats/streak don't yet reflect everything on this device.
export function hasAnyPendingSyncs(): boolean {
  try {
    return storage
      .getAllKeys()
      .some((k) => k.startsWith(PENDING_PREFIX) || k.startsWith(PATCH_PREFIX));
  } catch {
    return false;
  }
}

// Wipes all queued syncs/patches. Called on logout so a previous account's
// listening time can never be flushed under the next account's credentials.
export function clearAllPending() {
  try {
    storage
      .getAllKeys()
      .filter(
        (k) =>
          k.startsWith(PENDING_PREFIX) ||
          k.startsWith(PATCH_PREFIX) ||
          k.startsWith(BOOKMARK_PREFIX) ||
          k.startsWith(BOOKMARK_DELETE_PREFIX)
      )
      .forEach((k) => storage.remove(k));
  } catch {}
}

// Fire-and-forget progress sync. Never throws. On failure, queues the
// progress (merged with any existing pending entry) so it isn't lost.
// Local/offline sessions (id "local_*") queue a direct progress PATCH instead —
// their session id doesn't exist server-side.
export async function syncProgress(payload: SyncPayload): Promise<void> {
  // Stamp when this position was read — the queue merge (queuePending) keys
  // freshness on it, since failures are observed out of request order.
  if (!payload.at) payload = { ...payload, at: monotonicNow() };
  const { sessionId, currentTime, timeListened, duration } = payload;
  if (!sessionId) return;
  if (sessionId.startsWith("local_")) {
    queueProgressPatch(sessionId.replace(/^local_/, ""), currentTime, duration, payload.episodeId);
    // Opportunistically flush — if we regained connectivity, this lands now.
    flushPendingSyncs().catch(() => {});
    return;
  }
  try {
    // Best-effort: clear out anything already queued before sending the
    // latest tick, so we don't double count on the next failure.
    await flushPendingSyncs();
    await api.post(`/api/session/${sessionId}/sync`, { currentTime, timeListened, duration });
  } catch (e: any) {
    // Session gone server-side (404, e.g. server restart) — a retry can never
    // succeed; land the position via a direct progress PATCH instead.
    if (e?.response?.status === 404 && payload.libraryItemId) {
      queueProgressPatch(payload.libraryItemId, currentTime, duration, payload.episodeId);
      flushPendingSyncs().catch(() => {});
      return;
    }
    queuePending(payload);
  }
}

// Closes the ABS session. On failure, falls back to queuing a pending sync
// so the final progress still lands once connectivity returns.
export async function closeSession(payload: SyncPayload): Promise<void> {
  // Same freshness stamp as syncProgress — a close always carries the newest
  // position and must win the queue merge even if an older sync fails later.
  if (!payload.at) payload = { ...payload, at: monotonicNow() };
  const { sessionId, currentTime, timeListened, duration } = payload;
  if (!sessionId) return;
  if (sessionId.startsWith("local_")) {
    queueProgressPatch(sessionId.replace(/^local_/, ""), currentTime, duration, payload.episodeId);
    flushPendingSyncs().catch(() => {});
    return;
  }
  try {
    await api.post(`/api/session/${sessionId}/close`, { currentTime, timeListened, duration });
  } catch (e: any) {
    if (e?.response?.status === 404 && payload.libraryItemId) {
      queueProgressPatch(payload.libraryItemId, currentTime, duration, payload.episodeId);
      flushPendingSyncs().catch(() => {});
      return;
    }
    queuePending(payload);
  }
}
