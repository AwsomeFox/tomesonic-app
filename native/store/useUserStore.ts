import { create } from "zustand";
import { storageHelper } from "../utils/storage";
import { api } from "../utils/api";
import { writeAutoCreds, readAutoCreds } from "../utils/autoCreds";
import { useLibraryStore } from "./useLibraryStore";

type HapticLevel = "off" | "light" | "medium" | "heavy";

interface UserSettings {
  // Library sort/filter — persisted so the user's choices survive restarts.
  // (Global playback rate lives in storageHelper.getPlaybackRate, and the
  // dynamic-colors toggle lives in useThemeStore — not duplicated here.)
  mobileOrderBy: string;
  mobileOrderDesc: boolean;
  mobileFilterBy: string;
  // Authors page sort (same OrderModal pattern as the library page).
  mobileAuthorsOrderBy: string;
  mobileAuthorsOrderDesc: boolean;
  hideNonAudiobooksGlobal: boolean;
  // Device settings (wired into the Settings screen).
  lockOrientation: boolean;
  hapticFeedback: HapticLevel;
  disableAutoRewind: boolean;
  jumpForwardTime: number; // seconds
  jumpBackwardTime: number; // seconds
  // When on, finishing a downloaded book auto-queues a download of the next
  // book in the same series.
  autoDownloadNextInSeries: boolean;
}

interface UserState {
  user: any | null;
  serverConnectionConfig: any | null;
  settings: UserSettings;
  isInitialized: boolean;
  // Server-configured e-reader devices (from /api/authorize) — powers the
  // "Send to device" (Kindle etc.) action on ebook items.
  ereaderDevices: any[];
  // Map of libraryItemId (or `${libraryItemId}-${episodeId}`) -> media progress.
  // Mirrors the original app's global user progress store so any card/screen
  // can look up progress by id (the shelf/list payloads don't include it).
  mediaProgress: Record<string, any>;

  // Actions
  initialize: () => Promise<void>;
  setUser: (user: any) => void;
  setServerConnectionConfig: (config: any) => void;
  updateUserSettings: (updates: Partial<UserSettings>) => Promise<void>;
  loadMediaProgress: () => Promise<void>;
  loadEReaderDevices: () => Promise<void>;
  getMediaProgress: (libraryItemId: string, episodeId?: string) => any | null;
  login: (config: any, user: any) => Promise<void>;
  logout: () => Promise<void>;
}

function indexMediaProgress(list: any[]): Record<string, any> {
  const map: Record<string, any> = {};
  (list || []).forEach((p) => {
    // Entries must be objects WITH a library item id — an episode row missing
    // libraryItemId minted a bogus "undefined-ep1" key.
    if (!p || typeof p !== "object" || !p.libraryItemId) return;
    const key = p.episodeId ? `${p.libraryItemId}-${p.episodeId}` : p.libraryItemId;
    map[key] = p;
  });
  return map;
}

const DEFAULT_SETTINGS: UserSettings = {
  mobileOrderBy: "addedAt",
  mobileOrderDesc: true,
  mobileFilterBy: "all",
  mobileAuthorsOrderBy: "name",
  mobileAuthorsOrderDesc: false,
  hideNonAudiobooksGlobal: false,
  lockOrientation: true,
  hapticFeedback: "medium",
  disableAutoRewind: false,
  jumpForwardTime: 10,
  jumpBackwardTime: 10,
  autoDownloadNextInSeries: false,
};

export const useUserStore = create<UserState>((set, get) => ({
  user: null,
  serverConnectionConfig: null,
  settings: DEFAULT_SETTINGS,
  isInitialized: false,
  ereaderDevices: [],
  mediaProgress: {},

  initialize: async () => {
    if (get().isInitialized) return;

    const savedConfig = storageHelper.getServerConfig();
    const savedSettings = storageHelper.getUserSettings();

    // Only restore an authenticated session when we have a saved server + token.
    const hasSession = !!(savedConfig?.address && savedConfig?.token);

    // The native Android Auto service refreshes tokens itself while the JS app
    // is dead, and ABS ROTATES refresh tokens (the previous one dies ~60s
    // after a refresh) — so after a drive, auto_creds.json can hold the ONLY
    // valid pair. Both sides write that file, so when its token differs from
    // the saved config it is the newer pair: adopt it here instead of
    // clobbering the file with stale tokens below (which would force a logout
    // on the first 401).
    let config = savedConfig;
    if (hasSession) {
      try {
        const fileCreds = await readAutoCreds();
        const host = savedConfig.address.replace(/\/$/, "");
        if (fileCreds && fileCreds.server === host && fileCreds.token && fileCreds.token !== savedConfig.token) {
          config = {
            ...savedConfig,
            token: fileCreds.token,
            refreshToken: fileCreds.refreshToken || savedConfig.refreshToken,
          };
          storageHelper.setServerConfig(config);
        }
      } catch {}
      // Track the session identity so login() can tell same-account re-login
      // apart from an account/server switch even across forced logouts.
      storageHelper.setLastSessionKey(
        `${savedConfig.address.replace(/\/$/, "")}::${savedConfig.userId || ""}`
      );
    }

    set({
      user: hasSession
        ? { id: config.userId, username: config.username }
        : null,
      serverConnectionConfig: config || null,
      settings: savedSettings ? { ...DEFAULT_SETTINGS, ...savedSettings } : DEFAULT_SETTINGS,
      // Seed progress from the DISK cache so an offline cold start still
      // resumes every book at its real position (and keeps offline-finished
      // flags) instead of starting from an empty map until /api/me answers.
      ...(hasSession ? { mediaProgress: storageHelper.getMediaProgressCache() } : {}),
      isInitialized: true,
    });
    // Mirror creds for the native Android Auto browse service.
    // trustTokens: the adoption above already made `config` at least as fresh
    // as the file.
    if (hasSession) {
      writeAutoCreds(config.address, config.token, useLibraryStore.getState().currentLibraryId, config.refreshToken, true);
      // Fire-and-forget: e-reader devices only gate a secondary action.
      get().loadEReaderDevices();
    }
  },

  setUser: (user) => set({ user }),

  setServerConnectionConfig: (config) => {
    storageHelper.setServerConfig(config);
    set({ serverConnectionConfig: config });
  },

  updateUserSettings: async (updates) => {
    const currentSettings = get().settings;
    const newSettings = { ...currentSettings, ...updates };
    
    storageHelper.setUserSettings(newSettings);
    set({ settings: newSettings });
  },

  loadMediaProgress: async () => {
    try {
      const res = await api.get("/api/me");
      const list = res.data?.mediaProgress;
      // A degenerate 200 (proxy error page / null field) must not wipe the
      // in-memory progress map — bail and keep what we have.
      if (!Array.isArray(list)) return;
      const next = indexMediaProgress(list);
      const prev = get().mediaProgress;
      // FRESHEST-WINS per entry: local writers (player tick, reader, finish
      // toggles) stamp `updatedAt`; the server stamps `lastUpdate`. When a
      // local write is meaningfully newer than the server's own update (its
      // sync is still queued/in-flight — e.g. offline reading), a wholesale
      // replace would visually regress progress until the queue flushes. Keep
      // the fresher local entry instead; once the queued write lands, the
      // server's lastUpdate moves past it and the server copy wins again.
      const merged: Record<string, any> = { ...next };
      // Resolve the pending-writes helper ONCE per merge and memoize per
      // key — it scans MMKV keys and JSON-parses queued syncs, and this
      // merge runs on every Bookshelf focus.
      let hasPendingFn: ((i: string, e?: string | null) => boolean) | null = null;
      try {
        const ps = require("../utils/progressSync");
        if (typeof ps.hasPendingWritesFor === "function") hasPendingFn = ps.hasPendingWritesFor;
      } catch {}
      const pendingMemo = new Map<string, boolean>();
      for (const [key, p] of Object.entries(prev)) {
        const localAt = Number((p as any)?.updatedAt) || 0;
        const srv = merged[key];
        const srvAt = srv ? Number(srv.lastUpdate) || 0 : 0;
        if (localAt > srvAt + 10000) {
          // Server knows the entry (our fresher local write is racing its own
          // sync) → keep local. A LOCAL-ONLY entry is kept only while an
          // offline write is still queued for it — with nothing queued, the
          // server DELETED the progress (web UI / another device), and now
          // that the map is disk-cached, resurrecting it here would re-upload
          // the deletion away.
          const itemId = (p as any)?.libraryItemId;
          let pendingWrite = true; // helper unavailable → keep (old behavior)
          if (!srv && itemId && hasPendingFn) {
            const memoKey = `${itemId}|${(p as any)?.episodeId || ""}`;
            if (!pendingMemo.has(memoKey)) {
              pendingMemo.set(memoKey, hasPendingFn(itemId, (p as any)?.episodeId));
            }
            pendingWrite = pendingMemo.get(memoKey)!;
          }
          if (srv || pendingWrite) {
            merged[key] = { ...(srv || {}), ...(p as any) };
          }
        }
      }
      // Skip the setState when nothing changed: this runs on every Home focus,
      // and installing a fresh map object re-renders every card subscribed to
      // mediaProgress even when the data is identical. The map is small
      // (one entry per started book), so the compare is cheap.
      if (JSON.stringify(prev) === JSON.stringify(merged)) return;
      set({ mediaProgress: merged });
    } catch (err) {
      console.error("[UserStore] Failed to load media progress:", err);
    }
  },

  loadEReaderDevices: async () => {
    // Fired-and-forgotten from initialize()/login() — snapshot the session so
    // a slow response can't repopulate devices into a logged-out (or
    // switched-account) store.
    const sessionToken = get().serverConnectionConfig?.token;
    try {
      // Same source as the original app: /api/authorize returns the server's
      // configured e-reader devices for this user.
      const res = await api.post("/api/authorize");
      const devices = res.data?.ereaderDevices;
      if (!Array.isArray(devices)) return;
      if (get().serverConnectionConfig?.token !== sessionToken) return;
      set({ ereaderDevices: devices });
    } catch {
      // No devices is the common case; failures just leave the action hidden.
    }
  },

  getMediaProgress: (libraryItemId, episodeId) => {
    const map = get().mediaProgress;
    const key = episodeId ? `${libraryItemId}-${episodeId}` : libraryItemId;
    return map[key] || null;
  },

  login: async (config, user) => {
    // A login targeting a DIFFERENT server or account than the previous
    // session must wipe that session's leftovers — queued offline progress
    // syncs, cached shelves, library selection, last playback session — so
    // none of it can ever flush/render under the new account's credentials.
    // The session key lives in plain storage, so this also catches re-login
    // after a forced 401 logout or an app restart (where in-memory state is
    // gone). The SAME account re-logging in keeps its queued offline progress,
    // which flushes normally once the new token is in place.
    const newKey = `${(config?.address || "").replace(/\/$/, "")}::${config?.userId || user?.id || ""}`;
    const prevKey = storageHelper.getLastSessionKey();
    if (prevKey && prevKey !== newKey) {
      try {
        const { clearAllPending } = require("../utils/progressSync");
        clearAllPending();
      } catch {}
      storageHelper.removeLastLibraryId();
      storageHelper.removeLastPlaybackSession();
      // A forced 401 logout leaves the disk progress cache in place (same
      // account re-login must keep it) — but a DIFFERENT account/server must
      // not inherit it, nor the previous user's downloads or reader keys.
      storageHelper.removeMediaProgressCache();
      try {
        const { useDownloadStore } = require("./useDownloadStore");
        await useDownloadStore.getState().removeAllDownloads();
      } catch (e) {
        console.warn("[UserStore] downloads wipe on account switch failed", e);
      }
      try {
        const { storage } = require("../utils/storage");
        storage
          .getAllKeys()
          .filter(
            (k: string) =>
              k.startsWith("shelvesCache_") ||
              k.startsWith("seriesListCache_") ||
              k.startsWith("continueReadingCache_") ||
              k.startsWith("ebookCfi_") ||
              k.startsWith("pdfPage_") ||
              k.startsWith("last_interaction_")
          )
          .forEach((k: string) => storage.remove(k));
      } catch {}
      // Reset BEFORE writeAutoCreds below so the old server's libraryId can't
      // be mirrored into the new server's Android Auto creds file.
      try {
        useLibraryStore.getState().reset();
      } catch {}
    }
    storageHelper.setLastSessionKey(newKey);

    storageHelper.setServerConfig(config);
    // trustTokens: a fresh login — this pair came straight from the server.
    writeAutoCreds(config?.address, config?.token, useLibraryStore.getState().currentLibraryId, config?.refreshToken, true);
    set({
      serverConnectionConfig: config,
      user: user,
      // Seed progress from the login payload; refreshed later via loadMediaProgress.
      mediaProgress: indexMediaProgress(user?.mediaProgress || []),
    });
    // Fresh login = fresh session: fetch the e-reader devices now — the
    // initialize() path only covers restored sessions, so without this a
    // first login never showed "Send to device" until an app restart.
    get().loadEReaderDevices();
  },

  logout: async () => {
    // Stop playback + close the ABS session BEFORE tearing down credentials,
    // and wipe queued offline syncs so a previous account's listening time can
    // never be flushed under the next account. (Lazy requires: circular imports.)
    try {
      const { usePlaybackStore } = require("./usePlaybackStore");
      await usePlaybackStore.getState().closePlayback();
    } catch (e) {
      console.warn("[UserStore] closePlayback on logout failed", e);
    }
    try {
      const { clearAllPending } = require("../utils/progressSync");
      clearAllPending();
    } catch {}
    // Downloads are keyed by bare libraryItemId with no account scoping —
    // without this wipe the next account inherits (and can play) the previous
    // user's downloaded books, and in-flight downloads keep running into 401s
    // after the credentials below are gone.
    try {
      const { useDownloadStore } = require("./useDownloadStore");
      await useDownloadStore.getState().removeAllDownloads();
    } catch (e) {
      console.warn("[UserStore] downloads wipe on logout failed", e);
    }
    try {
      const { writeWidgetState } = require("../utils/autoCreds");
      writeWidgetState(null);
    } catch {}

    // Call server to invalidate session if config exists
    const config = get().serverConnectionConfig;
    if (config) {
      try {
        await api.post("/logout");
      } catch (err) {
        console.error("[UserStore] Logout API call failed:", err);
      }
    }

    storageHelper.clearServerConfig();
    writeAutoCreds(null, null, null);
    storageHelper.removeLastLibraryId();
    storageHelper.removeLastPlaybackSession();
    // The next account must not inherit this one's progress positions.
    storageHelper.removeMediaProgressCache();
    // Explicit logout fully ends the session — clear its identity key too so
    // the next login starts from a clean slate (everything is wiped here).
    storageHelper.removeLastSessionKey();

    // Wipe cached shelves/series lists so the next account never sees the
    // previous account's home content (stale-while-revalidate caches), plus
    // the per-item reader/interaction keys — on a shared server, item ids
    // collide across accounts, so account B used to resume an ebook at
    // account A's page (and the keys grew unbounded regardless).
    try {
      const { storage } = require("../utils/storage");
      storage
        .getAllKeys()
        .filter(
          (k: string) =>
            k.startsWith("shelvesCache_") ||
            k.startsWith("seriesListCache_") ||
            k.startsWith("continueReadingCache_") ||
            k.startsWith("ebookCfi_") ||
            k.startsWith("pdfPage_") ||
            k.startsWith("last_interaction_")
        )
        .forEach((k: string) => storage.remove(k));
    } catch {}
    try {
      const { useLibraryStore } = require("./useLibraryStore");
      useLibraryStore.getState().reset();
    } catch {}

    set({
      user: null,
      serverConnectionConfig: null,
      mediaProgress: {},
      ereaderDevices: [],
      settings: DEFAULT_SETTINGS,
    });
  },
}));

// Write-through disk mirror for the progress map (see getMediaProgressCache).
// Every writer funnels through useUserStore.setState — the playback tick, the
// reader, finish toggles, /api/me merges — so a single subscriber catches
// them all. Leading-edge throttle (3s) so per-second playback ticks cost at
// most one MMKV write per window, PLUS a trailing flush so the FINAL state of
// a burst always lands: without it, a one-off write inside the window (a
// finish toggle right at the end of a book, a merge while paused) could stay
// unpersisted forever if nothing changed afterwards.
{
  const WRITE_WINDOW_MS = 3000;
  let lastPersisted: any = null;
  let lastWriteAt = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  const write = (map: any) => {
    lastWriteAt = Date.now();
    try {
      storageHelper.setMediaProgressCache(map);
    } catch {}
  };
  useUserStore.subscribe((state) => {
    if (state.mediaProgress === lastPersisted) return;
    lastPersisted = state.mediaProgress;
    const now = Date.now();
    if (now - lastWriteAt >= WRITE_WINDOW_MS) {
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      write(state.mediaProgress);
      return;
    }
    // Inside the window: (re)schedule the trailing flush. Always replace the
    // pending timer — a handle invalidated externally (test fake-timer
    // resets) self-heals on the next change instead of blocking forever.
    if (trailingTimer) clearTimeout(trailingTimer);
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      write(useUserStore.getState().mediaProgress);
    }, Math.max(0, WRITE_WINDOW_MS - (now - lastWriteAt)));
  });
}
