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
  // Session identity (`address::userId`) captured at enqueue. A straggler
  // closeSession from account A can fail and queue in the switch window AFTER
  // login()'s clearAllPending but BEFORE the new config lands (A's token is
  // still present, so the presence guard passes) — the flush then skips any
  // entry whose sid doesn't match the CURRENT session rather than PATCHing A's
  // position under B's token on a shared server.
  sid?: string;
}

// `address::userId` for the currently-stored session, or null when logged out
// OR when the config carries no userId — without a userId two accounts on one
// server are indistinguishable, so we can't scope by identity and fall back to
// the old behavior (entries with no sid flush as before), exactly like
// applyRefreshedConfig's guard.
function currentSid(): string | null {
  try {
    const { storageHelper } = require("./storage");
    const cfg = storageHelper.getServerConfig();
    if (!cfg?.token || !cfg?.userId) return null;
    // Trim ALL trailing slashes (not just one) so the sid matches regardless of
    // how the address was normalized — updateServerAddress/ConnectScreen strip
    // /\/+$/; a config saved with several trailing slashes would otherwise stamp
    // a different sid at enqueue vs flush and skip pending entries forever.
    return `${(cfg.address || "").replace(/\/+$/, "")}::${cfg.userId}`;
  } catch {
    return null;
  }
}

// Monotonic freshness stamp: Date.now() can jump BACKWARD (NTP sync, manual
// clock change), which inverted the queue's freshest-wins comparison and kept
// a stale position over a newer close. Never yields a smaller stamp than the
// previous one within this JS lifetime — and on first use, seeds from the
// freshest stamp already persisted in the queue, so a backward clock
// adjustment across a RESTART can't let an old on-disk entry outrank every
// new stamp either.
let _lastAtStamp = 0;
let _atStampSeeded = false;
function monotonicNow(): number {
  if (!_atStampSeeded) {
    _atStampSeeded = true;
    try {
      for (const k of storage.getAllKeys()) {
        if (!k.startsWith(PENDING_PREFIX)) continue;
        try {
          const at = Number(JSON.parse(storage.getString(k) || "null")?.at) || 0;
          if (at > _lastAtStamp) _lastAtStamp = at;
        } catch {}
      }
    } catch {}
  }
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
    // No stored session = logged out (or mid account-switch). An offline
    // queue entry is meaningless with no credentials — and a late
    // closeSession failure landing here AFTER logout's clearAllPending would
    // survive the wipe and flush the previous account's position under the
    // NEXT account's token.
    try {
      const { storageHelper } = require("./storage");
      if (!storageHelper.getServerConfig()?.token) return;
    } catch {}
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
      // Stamp the session identity so the flush can refuse it under a different
      // account. The payload's sid was captured at SESSION-OPEN time
      // (syncProgress/closeSession stamp it before any await), so it survives
      // an account switch that lands before a fire-and-forget close fails —
      // resolving currentSid() lazily here would mis-stamp A's final position
      // with B's identity. Fall back to the existing entry's sid, then none.
      sid: payload.sid ?? existing?.sid ?? undefined,
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
    let prevSid: string | undefined;
    try {
      const prevRaw = storage.getString(key);
      if (prevRaw) {
        const prev = JSON.parse(prevRaw);
        prevSid = prev?.sid;
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
        // Session identity — the flush refuses it under a different account
        // (see currentSid). Existing sid wins.
        sid: prevSid ?? currentSid() ?? undefined,
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
  // Same logged-out guard as queuePending: a patch queued after logout's
  // wipe would flush under the next account's token.
  try {
    const { storageHelper } = require("./storage");
    if (!storageHelper.getServerConfig()?.token) return;
  } catch {}
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
    // Key floored (dedupe per second, matching creation keying) but store the
    // RAW time: the server keys bookmarks by exact time, so replaying a
    // fractional-time bookmark's deletion with a floored value would miss it
    // and the bookmark would reappear.
    storage.set(
      `${BOOKMARK_DELETE_PREFIX}${libraryItemId}_${Math.floor(time)}`,
      JSON.stringify({ libraryItemId, time: Number(time) })
    );
  } catch (e) {
    appLogger.warn(`Failed to queue bookmark deletion: ${e}`, "ProgressSync");
  }
}

/** Times (floored seconds) with a queued offline deletion for this item —
 *  the bookmark list filters these out so a deleted bookmark can't reappear
 *  from the server copy before the deletion flushes. Floored so callers can
 *  compare against Math.floor(serverBookmark.time) regardless of how the
 *  deletion was stored. */
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
      .filter((t) => Number.isFinite(t))
      .map((t) => Math.floor(t));
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

// Offline RENAME of a bookmark. The server matches the bookmark by its exact
// `time` and updates the `title` (PATCH /api/me/item/{id}/bookmark {time,title}).
// A rename that failed offline was swallowed — the new title silently reverted
// to the server copy on the next load. Mirrors the create/delete queues.
const BOOKMARK_RENAME_PREFIX = "pendingBookmarkRename_";
// A rename that keeps failing with a real server response (non-404) is dropped
// after this many attempts so a permanent 4xx/5xx can't retry forever.
const BOOKMARK_RENAME_MAX_ATTEMPTS = 8;

export function queueBookmarkRename(libraryItemId: string, time: number, title: string) {
  try {
    if (!libraryItemId || !Number.isFinite(time) || time < 0) return;
    // Key floored (dedupe per second, matching create/delete keying) but store
    // the RAW time: the PATCH matches the server bookmark by its exact time, so
    // replaying a fractional-time rename with a floored value would miss it.
    storage.set(
      `${BOOKMARK_RENAME_PREFIX}${libraryItemId}_${Math.floor(time)}`,
      JSON.stringify({ libraryItemId, time: Number(time), title })
    );
  } catch (e) {
    appLogger.warn(`Failed to queue bookmark rename: ${e}`, "ProgressSync");
  }
}

/** Drop any queued rename for a bookmark that's being deleted — otherwise a
 *  rename for a since-deleted bookmark lingers (harmless on ABS, where the PATCH
 *  404s and is dropped, but on an upsert-style server it could resurrect the
 *  deleted bookmark). Keyed the same way as queueBookmarkRename. */
export function removePendingBookmarkRename(libraryItemId: string, time: number) {
  try {
    if (!libraryItemId || !Number.isFinite(time)) return;
    storage.remove(`${BOOKMARK_RENAME_PREFIX}${libraryItemId}_${Math.floor(time)}`);
  } catch {}
}

/** Pending (queued-offline) renames for an item — the bookmark list applies
 *  these over the server/queued titles so an offline rename shows immediately
 *  and survives a reload before it flushes. */
export function pendingBookmarkRenamesFor(libraryItemId: string): { time: number; title: string }[] {
  try {
    return storage
      .getAllKeys()
      .filter((k) => k.startsWith(`${BOOKMARK_RENAME_PREFIX}${libraryItemId}_`))
      .map((k) => {
        try {
          return JSON.parse(storage.getString(k) || "");
        } catch {
          return null;
        }
      })
      // Only well-formed entries: a finite numeric `time` and a string `title`.
      // A corrupt blob (missing/invalid fields) would otherwise reach the UI
      // merge and produce an undefined title or a NaN time comparison.
      .filter(
        (b: any): b is { time: number; title: string } =>
          !!b && Number.isFinite(b.time) && typeof b.title === "string"
      );
  } catch {
    return [];
  }
}

async function flushPendingBookmarkRenames(): Promise<void> {
  const keys = storage.getAllKeys().filter((k) => k.startsWith(BOOKMARK_RENAME_PREFIX));
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
      await api.patch(`/api/me/item/${b.libraryItemId}/bookmark`, {
        time: b.time,
        title: b.title,
      });
      storage.remove(key);
    } catch (e: any) {
      // Item/bookmark gone server-side — the rename can never land.
      if (e?.response?.status === 404) {
        storage.remove(key);
      } else if (e?.response?.status) {
        // A server response other than 404 (e.g. a persistent 4xx/5xx) will
        // never succeed on retry — age the entry out after a few attempts so it
        // can't be retried forever. A network error (no `.response`) leaves
        // `attempts` untouched so genuine offline retries aren't burned.
        const attempts = (Number(b.attempts) || 0) + 1;
        if (attempts >= BOOKMARK_RENAME_MAX_ATTEMPTS) {
          storage.remove(key);
        } else {
          try {
            storage.set(key, JSON.stringify({ ...b, attempts }));
          } catch {}
        }
      }
      // No `.response` at all → offline/transient — keep it queued unchanged.
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

// ----- Offline listening time (local sessions) -------------------------------
// Sessions started while offline (id "local_*") have no server session, so
// their queued progress PATCH carries only the POSITION — the server computes
// Minutes Listening / Days Listened / streaks from playback sessions, meaning
// every minute listened in an offline-started session used to vanish from
// stats forever. Bank those seconds durably (one record per item+day) and
// flush them to POST /api/session/local, which ABS upserts by session id,
// REPLACING timeListening with the value sent — so re-sending a grown
// cumulative day total is safe and idempotent.
const LOCAL_SESSION_PREFIX = "pendingLocalSession_";

function dayParts(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()],
  };
}

export function recordLocalListening(
  libraryItemId: string,
  episodeId: string | undefined,
  currentTime: number,
  duration: number,
  timeListened: number
) {
  try {
    if (!libraryItemId) return;
    const seconds = Number(timeListened) || 0;
    if (seconds <= 0) return;
    const now = Date.now();
    const { date, dayOfWeek } = dayParts(now);
    const id = `local_${libraryItemId}${episodeId ? `-${episodeId}` : ""}_${date}`;
    const key = `${LOCAL_SESSION_PREFIX}${id}`;
    let rec: any = null;
    try {
      rec = JSON.parse(storage.getString(key) || "null");
    } catch {}
    if (!rec || typeof rec !== "object" || rec.id !== id) {
      // Local sessions only exist for downloaded books — grab display fields
      // so the server's "recent sessions" list isn't blank for them.
      let displayTitle: string | undefined;
      let displayAuthor: string | undefined;
      try {
        const { useDownloadStore, episodeDownloadKey } = require("../store/useDownloadStore");
        // Podcast episodes are keyed by the composite `${itemId}::${episodeId}`,
        // NOT the bare libraryItemId — looking up the bare id for an episode
        // missed the download and POSTed a blank displayTitle. Resolve via the
        // composite key when an episodeId is present.
        const dlKey = episodeId ? episodeDownloadKey(libraryItemId, episodeId) : libraryItemId;
        const dl = useDownloadStore.getState().completedDownloads[dlKey];
        displayTitle = dl?.title;
        displayAuthor = dl?.author;
      } catch {}
      rec = {
        id,
        libraryItemId,
        episodeId,
        date,
        dayOfWeek,
        displayTitle,
        displayAuthor,
        startedAt: now,
        timeListening: 0,
        syncedTimeListening: 0,
        // Session identity captured at record creation — the flush refuses it
        // under a different account (see currentSid), mirroring every other
        // offline queue. A per-item+day record collides across accounts on a
        // shared server, so without this a straggler could POST A's minutes
        // under B's token.
        sid: currentSid() ?? undefined,
      };
    }
    rec.timeListening = (Number(rec.timeListening) || 0) + seconds;
    if (Number.isFinite(Number(currentTime))) rec.currentTime = Number(currentTime);
    if (Number(duration) > 0) rec.duration = Number(duration);
    rec.updatedAt = now;
    storage.set(key, JSON.stringify(rec));
  } catch {}
}

async function flushPendingLocalSessions(): Promise<void> {
  const keys = storage.getAllKeys().filter((k) => k.startsWith(LOCAL_SESSION_PREFIX));
  const { date: today } = dayParts(Date.now());
  for (const key of keys) {
    let rec: any = null;
    try {
      rec = JSON.parse(storage.getString(key) || "null");
    } catch {}
    if (!rec || typeof rec !== "object" || !rec.id || !rec.libraryItemId || !(Number(rec.timeListening) > 0)) {
      try {
        storage.remove(key);
      } catch {}
      continue;
    }
    // Belongs to a different (switched/logged-out) account — never POST it
    // under the current session's token (see currentSid + flushPendingPatches /
    // the pending-sync loop guards). Left in place; login()'s clearAllPending
    // sweeps it on account switch.
    if (rec.sid && rec.sid !== currentSid()) continue;
    const total = Number(rec.timeListening) || 0;
    if (total <= (Number(rec.syncedTimeListening) || 0)) {
      // Fully delivered. Keep TODAY's record so later offline listening keeps
      // accumulating into the same server session; older days are done.
      if (rec.date !== today) storage.remove(key);
      continue;
    }
    try {
      await api.post("/api/session/local", {
        id: rec.id,
        libraryItemId: rec.libraryItemId,
        episodeId: rec.episodeId || null,
        // An episode session is by definition a podcast's; everything else in
        // the offline-download path is a book.
        mediaType: rec.episodeId ? "podcast" : "book",
        displayTitle: rec.displayTitle || "",
        displayAuthor: rec.displayAuthor || "",
        duration: Number(rec.duration) || 0,
        playMethod: 3, // LOCAL
        mediaPlayer: "TomeSonic",
        deviceInfo: { clientName: "TomeSonic" },
        date: rec.date,
        dayOfWeek: rec.dayOfWeek,
        timeListening: total,
        startTime: 0,
        currentTime: Number(rec.currentTime) || 0,
        startedAt: Number(rec.startedAt) || Date.now(),
        updatedAt: Number(rec.updatedAt) || Date.now(),
      });
      // TOCTOU: seconds recorded while the POST was in flight must stay
      // pending — mark only what we actually sent as delivered.
      let now2: any = null;
      try {
        now2 = JSON.parse(storage.getString(key) || "null");
      } catch {}
      if (now2 && typeof now2 === "object" && now2.id === rec.id) {
        now2.syncedTimeListening = total;
        storage.set(key, JSON.stringify(now2));
      }
    } catch (e: any) {
      const status = e?.response?.status;
      // The server REJECTED it (validation, endpoint missing on an old ABS) —
      // a retry can never succeed; drop it rather than poison every flush.
      // ONLY genuinely permanent codes drop (400/404/422 — the other flushers
      // drop on 404 alone): 401/403 can be a token mid-rotation, and
      // 408/425/429 are transient proxy/rate-limit responses — re-sending is
      // idempotent, so keeping those queued costs nothing while a drop loses
      // the minutes forever.
      if (status === 400 || status === 404 || status === 422) {
        appLogger.warn(`local session ${rec.id} rejected (${status}) — dropping`, "ProgressSync");
        try {
          storage.remove(key);
        } catch {}
      }
      // Otherwise offline / transient server error — keep it queued.
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

// --- Cross-medium progress sync (listening ↔ reading) -----------------------
// A book with BOTH an audiobook and an ebook tracks its two progresses
// independently: the player writes currentTime/progress, the reader writes
// ebookLocation/ebookProgress. They drift apart. These helpers reconcile them.
//
// FRACTION-ONLY, by necessity. There is NO audio-timestamp ↔ ebook-CFI mapping
// (ABS itself only stores fractions), so:
//   • audio → fraction f is clean/exact-ish: currentTime = f * duration.
//   • ebook → fraction f writes ebookProgress = f, but the reader's exact PAGE
//     cannot be set — a CFI can't be derived from a fraction. The existing CFI
//     (ebookLocation) is PRESERVED, so only the PERCENTAGE moves, not the page.
// Both "Sync progress" (manual) and the "Link reading & listening" lock use
// this, and both are therefore percentage-level reconciliations.

function clamp01(n: any): number {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

// Difference below which the two media are treated as already aligned — avoids
// pointless writes (and a reconcile that fights an in-flight rounding jitter).
const LINK_EPSILON = 0.005;

// Fraction at/above which a medium counts as "at the end". A linked reconcile
// only propagates the FINISHED flag (and slams the audio timestamp to the very
// end) when BOTH media are this close to done — otherwise finishing ONE medium
// would silently destroy the OTHER's mid-way resume position (P3).
const NEAR_FINISH = 0.99;

/** True when the user has locked this item's two progresses together (per-item
 *  toggle persisted in useUserStore settings). Lazy require: circular import. */
export function isProgressLinked(libraryItemId: string): boolean {
  try {
    const { useUserStore } = require("../store/useUserStore");
    return !!useUserStore.getState().settings?.linkedProgress?.[libraryItemId];
  } catch {
    return false;
  }
}

/** Current in-memory media-progress entry for an item (lazy require). */
function getProgressEntry(libraryItemId: string): any {
  try {
    const { useUserStore } = require("../store/useUserStore");
    return useUserStore.getState().mediaProgress?.[libraryItemId] || null;
  } catch {
    return null;
  }
}

/**
 * Write BOTH media of `libraryItemId` to `targetFraction`. Queues a combined
 * media-progress PATCH (audio currentTime + ebookProgress land in one body) and
 * reflects the change in the in-memory map immediately so the Your Progress
 * rows update without waiting for a refetch. Offline-safe: the writes queue and
 * flush when connectivity returns (this reuses the same durable queue as every
 * other offline write). FRACTION-ONLY — see the header above; the ebook page is
 * NOT repositioned, only its percentage.
 */
export function syncBothProgressFraction(
  libraryItemId: string,
  targetFraction: number,
  opts?: { duration?: number; ebookLocation?: string; finish?: boolean }
): void {
  if (!libraryItemId) return;
  const f = clamp01(targetFraction);
  const duration = Number(opts?.duration) || 0;
  // Whether this write may actually FINISH the item. Defaults to true so the
  // explicit "Sync progress" action still finishes both media. The linked
  // reconcile passes finish:false when only ONE medium reached the end while the
  // OTHER is still genuinely mid-way (P3) — there, forcing isFinished / slamming
  // the audio timestamp to (≈)duration would silently obliterate the
  // mid-listened audiobook's resume position.
  const allowFinish = opts?.finish !== false;
  const finished = f >= NEAR_FINISH && allowFinish;
  // "Finish reached, but finishing suppressed": the percentage still advances
  // (furthest-wins display), but we must NOT move the audio timestamp to the end
  // — the real resume seconds are preserved instead.
  const suppressAudioTimestamp = f >= NEAR_FINISH && !allowFinish;

  // AUDIO → currentTime = f * duration (exact-ish). Skip when the duration is
  // unknown — a timestamp can't be placed without it, but the ebook side still
  // syncs. queueProgressPatch also writes `progress` = currentTime/duration.
  // Also skip when finishing is suppressed: a durable currentTime≈duration write
  // would destroy the listener's mid-way resume position on the server (P3).
  if (duration > 0 && !suppressAudioTimestamp) {
    queueProgressPatch(libraryItemId, f * duration, duration, null);
  }

  // EBOOK → fraction only. The CFI can't be derived from a fraction, so the
  // EXISTING page is preserved: include ebookLocation ONLY when we have one
  // (writing "" would clobber a real server CFI). Merges into the SAME pending
  // PATCH as the audio fields above → one combined body.
  const ebookFields: Record<string, any> = { ebookProgress: f };
  if (opts?.ebookLocation) ebookFields.ebookLocation = opts.ebookLocation;
  if (finished) ebookFields.isFinished = true;
  mergePendingPatch(libraryItemId, null, ebookFields);

  // Reflect in the in-memory map now (freshest-wins keeps it until the queued
  // PATCH lands and the server's lastUpdate moves past this write).
  try {
    const { useUserStore } = require("../store/useUserStore");
    const now = Date.now();
    useUserStore.setState((s: any) => {
      const prev = s.mediaProgress?.[libraryItemId] || {};
      const next: any = {
        ...prev,
        libraryItemId,
        ebookProgress: f,
        updatedAt: now,
      };
      if (duration > 0) {
        // Advance the audio PERCENTAGE for the Your-Progress display, but when
        // finishing is suppressed keep the real resume position (currentTime) so
        // a mid-listened audiobook is never jumped to the end (P3).
        next.progress = f;
        next.duration = duration;
        if (!suppressAudioTimestamp) next.currentTime = f * duration;
      }
      if (finished) next.isFinished = true;
      return { mediaProgress: { ...s.mediaProgress, [libraryItemId]: next } };
    });
  } catch {}

  // Opportunistically deliver — if we're online, the combined PATCH lands now.
  flushPendingSyncs().catch(() => {});
}

/**
 * When this item's progresses are LOCKED, reconcile them to their FURTHEST
 * position (furthest-wins, so reading/listening never moves BACKWARD). No-op
 * when unlocked, when the two are already aligned, or when the item id is
 * missing — so it's safe to call unconditionally at any transition boundary
 * (ItemDetail focus, audio session close, reader flush). `hint` supplies a
 * just-updated fraction for one medium that may not be in the map yet (the
 * closing audio position / the reader's final fraction). FRACTION-ONLY.
 * Returns true when a reconciling write was made.
 */
export function reconcileLinkedProgress(
  libraryItemId: string,
  hint?: {
    audioFraction?: number;
    ebookFraction?: number;
    duration?: number;
    ebookLocation?: string;
  }
): boolean {
  if (!libraryItemId || !isProgressLinked(libraryItemId)) return false;
  const prog = getProgressEntry(libraryItemId) || {};
  const duration = Number(hint?.duration) || Number(prog.duration) || 0;
  const audioFraction = clamp01(
    hint?.audioFraction != null ? hint.audioFraction : prog.progress
  );
  const ebookFraction = clamp01(
    hint?.ebookFraction != null ? hint.ebookFraction : prog.ebookProgress
  );
  if (Math.abs(audioFraction - ebookFraction) < LINK_EPSILON) return false;
  const target = Math.max(audioFraction, ebookFraction);
  // Never SILENTLY mark an UNSTARTED medium finished. Enabling the lock on a
  // read-but-unlistened both-format book (ebook ~100%, audio ~0%) would
  // otherwise reconcile to target 1.0 and PATCH the untouched audiobook as
  // finished with no confirmation — destroying its "unstarted" state. When the
  // lagging side hasn't been started (≈0) and the target is a finish
  // (>= NEAR_FINISH), skip: there is nothing to link yet. Partial↔partial
  // reconciles, and moving an unstarted side to a NON-finished percentage
  // (e.g. listen-only sync of the ebook %), still proceed — this guards ONLY
  // the destructive finish jump, so it fires on both the manual toggle-ON and
  // its ItemDetail focus-effect re-run.
  if (target >= NEAR_FINISH && Math.min(audioFraction, ebookFraction) < LINK_EPSILON) return false;
  // When the audio duration is unknown we can't place a timestamp, so the audio
  // fraction can NEVER advance. If the ebook is furthest (audio is the lagging
  // side that would need to move up), syncBothProgressFraction skips the audio
  // write and leaves the in-memory audio progress behind — the two never
  // converge, and every ItemDetail focus re-queues a redundant PATCH + flush.
  // Treat "audio can't move" as un-reconcilable and skip rather than looping.
  // (Audio-ahead still reconciles: the ebook side moves regardless of duration.)
  if (duration <= 0 && target > audioFraction) return false;
  // Decouple "advance position" from "force finished" (P3): only propagate the
  // finished flag (and let the audio timestamp reach the very end) when BOTH
  // media are already near the end. When the user finishes READING while the
  // audio is genuinely mid-way, the audio percentage still moves forward, but
  // its resume position is preserved and it is NOT silently marked finished.
  const bothNearEnd =
    Math.min(audioFraction, ebookFraction) >= NEAR_FINISH;
  syncBothProgressFraction(libraryItemId, target, {
    duration,
    // Preserve whatever CFI/page the reader last wrote.
    ebookLocation: hint?.ebookLocation ?? prog.ebookLocation ?? "",
    finish: bothNearEnd,
  });
  return true;
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
    // Belongs to a different (switched/logged-out) account — never PATCH it
    // under the current session's token. Leave it: switching back restores a
    // matching sid, and login()'s clearAllPending sweeps it otherwise.
    if (p.sid && p.sid !== currentSid()) continue;
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
      await flushPendingLocalSessions();
      // Deletions BEFORE creations: with a queued delete and a queued re-add
      // at the same floored time (delete a synced bookmark offline, then
      // bookmark the same spot again), creations-first would POST the new
      // bookmark and immediately DELETE it — the user's last action loses.
      // Deletions-first is correct for every coexisting pair.
      await flushPendingBookmarkDeletions();
      await flushPendingBookmarks();
      // Renames LAST: a create + rename queued for the same bookmark (bookmark
      // a spot offline, then rename it) must POST the create first so the
      // PATCH's time-match finds a server bookmark to rename.
      await flushPendingBookmarkRenames();
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
        // A straggler from a switched/logged-out account — never sync it under
        // the current token (see currentSid). Left in place, not cleared.
        if (pending.sid && pending.sid !== currentSid()) continue;
        try {
          await api.post(`/api/session/${sessionId}/sync`, {
            currentTime: pending.currentTime,
            timeListened: pending.timeListened,
            duration: pending.duration,
          });
          // TOCTOU guard: while our POST was in flight, a concurrent failed
          // sync may have merged NEW seconds — or a fresher position with no
          // new seconds (closeSession after a seek passes timeListened 0) —
          // into this entry. Blind-clearing would eat them (verified
          // listening-time loss under flaky networks) — clear only what we
          // actually delivered, keep the rest.
          const now = readPending(sessionId);
          if (
            now &&
            ((now.timeListened || 0) > (pending.timeListened || 0) ||
              (Number(now.at) || 0) > (Number(pending.at) || 0))
          ) {
            storage.set(
              pendingKey(sessionId),
              JSON.stringify({
                ...now,
                timeListened: Math.max(0, (now.timeListened || 0) - (pending.timeListened || 0)),
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

// True when queued LISTENING TIME hasn't reached the server yet — i.e. the
// server's stats/streak don't reflect everything on this device. Progress
// PATCHes (pendingPatch_*: position, isFinished, ebook fields) are excluded:
// they never carry session seconds, so they can't move
// /api/me/listening-stats, and counting them made the Stats caption claim
// listening was "still syncing" over a mere reader-position update.
export function hasAnyPendingSyncs(): boolean {
  try {
    return storage.getAllKeys().some((k) => {
      if (k.startsWith(PENDING_PREFIX)) {
        // A flush can legitimately leave a position-only remainder
        // (timeListened 0 after the TOCTOU subtraction) — no listening
        // seconds are missing from stats in that case.
        try {
          const rec = JSON.parse(storage.getString(k) || "null");
          return (Number(rec?.timeListened) || 0) > 0;
        } catch {
          return false;
        }
      }
      if (k.startsWith(LOCAL_SESSION_PREFIX)) {
        // Local-session day records persist after delivery (they accumulate);
        // only an undelivered remainder counts as pending.
        try {
          const rec = JSON.parse(storage.getString(k) || "null");
          return (Number(rec?.timeListening) || 0) > (Number(rec?.syncedTimeListening) || 0);
        } catch {
          return false;
        }
      }
      return false;
    });
  } catch {
    return false;
  }
}

// In-place server-address change (same account, moved DNS/IP/proxy/scheme).
// Queued offline entries stamped their session identity (`address::userId`) at
// enqueue time; when the address portion changes, that captured sid no longer
// matches currentSid(), so every flush loop (pending syncs, patches, local
// sessions) would SKIP these entries forever. Re-key each entry's sid from the
// old identity to the new one so they flush under the moved session. Only the
// `sid` stamp changes — positions/timeListened are untouched.
export function remapPendingSids(oldSid: string, newSid: string) {
  if (!oldSid || !newSid || oldSid === newSid) return;
  try {
    for (const k of storage.getAllKeys()) {
      if (
        !k.startsWith(PENDING_PREFIX) &&
        !k.startsWith(PATCH_PREFIX) &&
        !k.startsWith(LOCAL_SESSION_PREFIX)
      ) {
        continue;
      }
      try {
        const raw = storage.getString(k);
        if (!raw) continue;
        const rec = JSON.parse(raw);
        if (rec && typeof rec === "object" && rec.sid === oldSid) {
          rec.sid = newSid;
          storage.set(k, JSON.stringify(rec));
        }
      } catch {}
    }
  } catch {}
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
          k.startsWith(BOOKMARK_DELETE_PREFIX) ||
          k.startsWith(BOOKMARK_RENAME_PREFIX) ||
          k.startsWith(LOCAL_SESSION_PREFIX)
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
  // Capture the session identity NOW, while this session is still current. A
  // fire-and-forget POST can fail and reach queuePending AFTER an account
  // switch — resolving currentSid() there would stamp the entry with the NEW
  // account and let the flush guard pass, PATCHing this position under the
  // wrong token on a shared server.
  if (!payload.sid) payload = { ...payload, sid: currentSid() ?? undefined };
  const { sessionId, currentTime, timeListened, duration } = payload;
  if (!sessionId) return;
  if (sessionId.startsWith("local_")) {
    const itemId = payload.libraryItemId || sessionId.replace(/^local_/, "");
    // Bank the listened seconds too — the PATCH below carries only the
    // position, and stats/streaks are computed from sessions server-side.
    recordLocalListening(itemId, payload.episodeId, currentTime, duration, timeListened);
    queueProgressPatch(itemId, currentTime, duration, payload.episodeId);
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
  // Capture the session identity NOW (see syncProgress): a straggler close that
  // fails after an account switch must queue under the account that OPENED the
  // session, not whichever is current when the failure is finally observed.
  if (!payload.sid) payload = { ...payload, sid: currentSid() ?? undefined };
  const { sessionId, currentTime, timeListened, duration } = payload;
  if (!sessionId) return;
  if (sessionId.startsWith("local_")) {
    const itemId = payload.libraryItemId || sessionId.replace(/^local_/, "");
    recordLocalListening(itemId, payload.episodeId, currentTime, duration, timeListened);
    queueProgressPatch(itemId, currentTime, duration, payload.episodeId);
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
