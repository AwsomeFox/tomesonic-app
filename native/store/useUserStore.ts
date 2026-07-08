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
  // Series page sort.
  mobileSeriesOrderBy: string;
  mobileSeriesOrderDesc: boolean;
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
  // Per-item "Link reading & listening" lock (itemId -> true). When set for a
  // both-format book, its listening and reading progress are kept reconciled to
  // the furthest position at transition boundaries (see progressSync's
  // reconcileLinkedProgress). Keyed by libraryItemId; absent = unlocked.
  linkedProgress: Record<string, boolean>;
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
  // Per-item progress-link toggle (see UserSettings.linkedProgress).
  isProgressLinked: (libraryItemId: string) => boolean;
  setProgressLinked: (libraryItemId: string, linked: boolean) => Promise<void>;
  loadMediaProgress: () => Promise<void>;
  loadEReaderDevices: () => Promise<void>;
  getMediaProgress: (libraryItemId: string, episodeId?: string) => any | null;
  login: (config: any, user: any) => Promise<void>;
  logout: () => Promise<void>;
  // In-place server-address change for the SAME account (DNS/IP/proxy/scheme
  // moved). Unlike logging out and back in, this keeps downloads/progress.
  updateServerAddress: (rawAddress: string) => Promise<{ ok: boolean; error?: string }>;
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
  mobileSeriesOrderBy: "name",
  mobileSeriesOrderDesc: false,
  hideNonAudiobooksGlobal: false,
  lockOrientation: true,
  hapticFeedback: "medium",
  disableAutoRewind: false,
  jumpForwardTime: 10,
  jumpBackwardTime: 10,
  autoDownloadNextInSeries: false,
  linkedProgress: {},
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

    // Seed the session SYNCHRONOUSLY (before any await) so the navigator never
    // sees a null `user` for a logged-in launch. The token-adoption below reads
    // a file (await), and if we deferred `user` past it, AppNavigator would
    // paint the Connect/login screen for a tick before flipping to Home on
    // every authenticated cold start. Everything needed to seed `user` —
    // userId/username — is already in the synchronously-read savedConfig; the
    // async adoption only ever swaps the token, never the identity.
    set({
      user: hasSession
        ? { id: savedConfig.userId, username: savedConfig.username }
        : null,
      serverConnectionConfig: savedConfig || null,
      settings: savedSettings ? { ...DEFAULT_SETTINGS, ...savedSettings } : DEFAULT_SETTINGS,
      // Seed progress from the DISK cache so an offline cold start still
      // resumes every book at its real position (and keeps offline-finished
      // flags) instead of starting from an empty map until /api/me answers.
      ...(hasSession ? { mediaProgress: storageHelper.getMediaProgressCache() } : {}),
      isInitialized: true,
    });

    if (!hasSession) return;

    // The native Android Auto service refreshes tokens itself while the JS app
    // is dead, and ABS ROTATES refresh tokens (the previous one dies ~60s
    // after a refresh) — so after a drive, auto_creds.json can hold the ONLY
    // valid pair. Both sides write that file, so when its token differs from
    // the saved config it is the newer pair: adopt it here instead of
    // clobbering the file with stale tokens below (which would force a logout
    // on the first 401).
    let config = savedConfig;
    try {
      const fileCreds = await readAutoCreds();
      const host = savedConfig.address.replace(/\/$/, "");
      if (fileCreds && fileCreds.server === host && fileCreds.token && fileCreds.token !== savedConfig.token) {
        config = {
          ...savedConfig,
          token: fileCreds.token,
          refreshToken: fileCreds.refreshToken || savedConfig.refreshToken,
        };
        // Persist + push the adopted token into the store (the sync seed above
        // used the saved token; this swaps in the fresher file token).
        storageHelper.setServerConfig(config);
        set({ serverConnectionConfig: config });
      }
    } catch {}
    // Track the session identity so login() can tell same-account re-login
    // apart from an account/server switch even across forced logouts.
    storageHelper.setLastSessionKey(
      `${savedConfig.address.replace(/\/$/, "")}::${savedConfig.userId || ""}`
    );
    // Mirror creds for the native Android Auto browse service.
    // trustTokens: the adoption above already made `config` at least as fresh
    // as the file.
    writeAutoCreds(config.address, config.token, useLibraryStore.getState().currentLibraryId, config.refreshToken, true);
    // Fire-and-forget: e-reader devices only gate a secondary action.
    get().loadEReaderDevices();
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

  isProgressLinked: (libraryItemId) => !!get().settings.linkedProgress?.[libraryItemId],

  setProgressLinked: async (libraryItemId, linked) => {
    if (!libraryItemId) return;
    const cur = get().settings.linkedProgress || {};
    // Store only "on" entries — deleting on unlink keeps the persisted map from
    // growing an entry per book the user ever toggled.
    const next = { ...cur };
    if (linked) next[libraryItemId] = true;
    else delete next[libraryItemId];
    await get().updateUserSettings({ linkedProgress: next });
  },

  loadMediaProgress: async () => {
    // Fires on every Bookshelf/Stats focus. Snapshot the session so a slow
    // /api/me (built with THIS account's token) can't write account A's
    // progress into account B's — or a logged-out — store after a switch/
    // logout lands mid-flight (mirrors loadEReaderDevices' guard).
    const cfg = get().serverConnectionConfig;
    const sessionToken = cfg?.token;
    const sessionUserId = cfg?.userId;
    try {
      const res = await api.get("/api/me");
      const list = res.data?.mediaProgress;
      // A degenerate 200 (proxy error page / null field) must not wipe the
      // in-memory progress map — bail and keep what we have.
      if (!Array.isArray(list)) return;
      const now = get().serverConnectionConfig;
      // Bail only on a LOGOUT (a token we HAD is now gone) or an ACCOUNT switch
      // (userId changed) — NOT on a plain token change. A token rotation via
      // /auth/refresh (which /api/me itself can trigger and replay) is the same
      // account, and comparing tokens strictly would drop that valid refresh.
      if ((sessionToken && !now?.token) || now?.userId !== sessionUserId) return;
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
      // mediaProgress even when the data is identical. `merged` is built in
      // server-key order while `prev` is in local-write order, so a
      // JSON.stringify compare reported identical maps as different whenever
      // the key order diverged — re-rendering every card on every focus.
      // Compare by key count + per-entry SHALLOW equality instead (order-
      // independent). The map is small (one entry per started book), so this
      // is cheap.
      const shallowEqualEntry = (a: any, b: any): boolean => {
        if (a === b) return true;
        if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
        const ak = Object.keys(a);
        const bk = Object.keys(b);
        if (ak.length !== bk.length) return false;
        for (const k of ak) if (a[k] !== b[k]) return false;
        return true;
      };
      const prevKeys = Object.keys(prev);
      const mergedKeys = Object.keys(merged);
      let identical = prevKeys.length === mergedKeys.length;
      if (identical) {
        for (const k of mergedKeys) {
          if (!shallowEqualEntry(prev[k], merged[k])) {
            identical = false;
            break;
          }
        }
      }
      if (identical) return;
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
      // Stop the PREVIOUS account's live playback FIRST (mirrors logout's
      // ordering). A forced-401 logout leaves the session loaded and playing;
      // without this, its 1s tick / native samples write the old account's
      // position into the new account's fresh progress map + server (the
      // streaming session 404s under the new token and converts to a direct
      // PATCH), re-saves lastPlaybackSession right after the removal below,
      // and removeAllDownloads deletes files under the still-playing session.
      try {
        const { usePlaybackStore } = require("./usePlaybackStore");
        await usePlaybackStore.getState().closePlayback();
      } catch (e) {
        console.warn("[UserStore] closePlayback on account switch failed", e);
      }
      try {
        const { clearAllPending } = require("../utils/progressSync");
        clearAllPending();
      } catch {}
      storageHelper.removeLastLibraryId();
      storageHelper.removeLastPlaybackSession();
      // A forced 401 logout leaves the disk progress cache in place (same
      // account re-login must keep it) — but a DIFFERENT account/server must
      // not inherit it, nor the previous user's reader keys.
      storageHelper.removeMediaProgressCache();
      // Downloads are NAMESPACED by session key now, so switching accounts must
      // NOT delete the departing account's offline library (a two-server user
      // would re-download everything on every toggle). Just stop surfacing +
      // stop any in-flight parts; the files stay on disk and are re-adopted by
      // loadDownloadsFromDb below when we return to this account.
      try {
        const { useDownloadStore } = require("./useDownloadStore");
        await useDownloadStore.getState().deactivateDownloadsForSwitch();
      } catch (e) {
        console.warn("[UserStore] downloads deactivate on account switch failed", e);
      }
      // The RMAB connection is per-person (it can carry ADMIN rights over the
      // request queue) — a different ABS account must not inherit it.
      try {
        const { useRmabStore } = require("./useRmabStore");
        useRmabStore.getState().disconnect();
      } catch (e) {
        // Security-relevant wipe — a silent skip must at least be diagnosable.
        console.warn("[UserStore] RMAB disconnect on account switch failed", e);
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
      // Per-item progress locks (linkedProgress) are keyed by BARE libraryItemId,
      // which collides across accounts on a shared server — a DIFFERENT account
      // must not inherit account A's link locks. Clear them from BOTH the
      // persisted settings blob (initialize() would otherwise merge the stale map
      // back) and the in-memory settings.
      try {
        const persisted = storageHelper.getUserSettings();
        if (persisted) storageHelper.setUserSettings({ ...persisted, linkedProgress: {} });
      } catch {}
      set((s) => ({ settings: { ...s.settings, linkedProgress: {} } }));
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
    // Re-surface THIS account's downloads from its namespace — re-adopting any
    // files that survived a previous stint on this account instead of
    // re-downloading them. A first-ever login for this account loads nothing
    // (and drives the one-time migration of any pre-namespacing legacy rows
    // into this account). The other account's downloads stay on disk untouched.
    try {
      const { useDownloadStore } = require("./useDownloadStore");
      useDownloadStore.getState().loadDownloadsFromDb();
    } catch (e) {
      console.warn("[UserStore] loadDownloadsFromDb on login failed", e);
    }
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
    // Downloads are NAMESPACED by session key. "Switch Server/User" routes
    // through logout, and a switch must RETAIN both accounts' downloads — so we
    // do NOT delete the departing account's files here. Just stop surfacing them
    // and abort any in-flight parts (they'd 401 once the credentials below are
    // gone); the files stay on disk, tagged with this account's sessionKey, and
    // are re-adopted when the user signs back in. (Explicit "clear downloads"
    // remains available via removeAllDownloads.)
    try {
      const { useDownloadStore } = require("./useDownloadStore");
      await useDownloadStore.getState().deactivateDownloadsForSwitch();
    } catch (e) {
      console.warn("[UserStore] downloads deactivate on logout failed", e);
    }
    // RMAB rides the ABS identity on this device: whoever logs in next must
    // not inherit the previous person's connection (which can carry ADMIN
    // rights over everyone's requests) or their requested-state.
    try {
      const { useRmabStore } = require("./useRmabStore");
      useRmabStore.getState().disconnect();
    } catch (e) {
      // Security-relevant wipe — a silent skip must at least be diagnosable.
      console.warn("[UserStore] RMAB disconnect on logout failed", e);
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
    // Clear the PERSISTED per-item progress locks too: settings goes to DEFAULT
    // in memory below, but the userSettings MMKV blob would otherwise keep this
    // account's linkedProgress (keyed by bare libraryItemId → collides across
    // accounts on a shared server), which initialize() merges back for the next
    // account. Preserve every other device-level setting.
    try {
      const persisted = storageHelper.getUserSettings();
      if (persisted) storageHelper.setUserSettings({ ...persisted, linkedProgress: {} });
    } catch {}
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

  updateServerAddress: async (rawAddress) => {
    const cur = get().serverConnectionConfig;
    if (!cur?.token) return { ok: false, error: "You're not logged in." };
    const trimmed = (rawAddress || "").trim().replace(/\/+$/, "");
    if (!trimmed) return { ok: false, error: "Enter a server address." };
    // Bare host -> try https first (most ABS installs sit behind TLS), matching
    // the Connect screen's probe order.
    const hasScheme = /^https?:\/\//i.test(trimmed);
    const candidates = hasScheme ? [trimmed] : [`https://${trimmed}`, `http://${trimmed}`];

    const axios = require("axios").default;
    let picked: string | null = null;
    for (const base of candidates) {
      try {
        const res = await axios.get(`${base}/api/me`, {
          headers: { Authorization: `Bearer ${cur.token}` },
          timeout: 15000,
        });
        const uid = res?.data?.id;
        // Must PROVE it's the SAME account before switching in place. When we
        // know our userId, the probe must return a matching one — a 200 without
        // an id (proxy error page / non-ABS response) must NOT be accepted, or
        // we'd move the address without confirming the account and associate
        // this account's downloads/progress with the wrong server.
        if (cur.userId) {
          if (!uid) {
            // Not a trustworthy /api/me — try the next candidate scheme.
            continue;
          }
          if (uid !== cur.userId) {
            return {
              ok: false,
              error: "That server has a different account. Use Switch Server to log in there instead.",
            };
          }
        }
        picked = base;
        break;
      } catch {
        // Try the next candidate scheme.
      }
    }
    if (!picked) {
      return { ok: false, error: "Couldn't reach that server with your current login. Check the address." };
    }
    if (picked === (cur.address || "").replace(/\/+$/, "")) return { ok: true };

    // In-place move: keep the SAME account identity, but the ADDRESS portion of
    // the `${address}::${userId}` session key changes. Downloads are namespaced
    // by that key and pending offline syncs stamp their sid with it, so we must
    // MIGRATE the identity in place — otherwise loadDownloadsFromDb filters every
    // download out (files remain, but they "vanish" from the UI) and the flush
    // loops skip the stranded pending entries forever (their sid no longer
    // matches currentSid()).
    const next = { ...cur, address: picked };
    const userId = cur.userId || get().user?.id || "";
    // Capture the OLD key (what rows/sids were stamped with) BEFORE re-stamping.
    const oldKey =
      storageHelper.getLastSessionKey() ||
      `${(cur.address || "").replace(/\/+$/, "")}::${userId}`;
    const newKey = `${picked}::${userId}`;
    storageHelper.setServerConfig(next);
    storageHelper.setLastSessionKey(newKey);
    if (oldKey !== newKey) {
      // Re-stamp every download row (DB + in-memory) from oldKey → newKey.
      try {
        const { useDownloadStore } = require("./useDownloadStore");
        useDownloadStore.getState().remapSessionKey(oldKey, newKey);
      } catch (e) {
        console.warn("[UserStore] remapSessionKey on address change failed", e);
      }
      // Re-key any queued offline syncs/patches/local-sessions sids old → new.
      try {
        const { remapPendingSids } = require("../utils/progressSync");
        remapPendingSids(oldKey, newKey);
      } catch (e) {
        console.warn("[UserStore] remapPendingSids on address change failed", e);
      }
    }
    // Re-mirror creds for Android Auto and refresh the notification artwork host
    // (its baked-in address is now stale). The downloads' local files stay valid
    // (only their identity stamp moved above); stream/cover URLs rebuild from the
    // new address on the next request.
    try {
      writeAutoCreds(picked, cur.token, useLibraryStore.getState().currentLibraryId, cur.refreshToken, true);
    } catch {}
    set({ serverConnectionConfig: next });
    try {
      require("./usePlaybackStore").refreshNowPlayingArtwork();
    } catch {}
    return { ok: true };
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
