import { create } from "zustand";
import { api } from "../utils/api";
import { storageHelper, storage } from "../utils/storage";

// --- Personalized-shelves cache (stale-while-revalidate) -------------------
// The home screen renders instantly from the last known shelves for the
// current library while a fresh fetch runs in the background. Without this,
// every cold open shows a skeleton for the full network round-trip.
function shelvesCacheKey(libraryId: string) {
  return `shelvesCache_${libraryId}`;
}
function readShelvesCache(libraryId: string | null): any[] {
  if (!libraryId) return [];
  try {
    const raw = storage.getString(shelvesCacheKey(libraryId));
    const parsed = raw ? JSON.parse(raw) : null;
    // A truncated/corrupt cache blob must not crash Home — null shelves threw
    // in the shelf assembly and the continue-series builder.
    return Array.isArray(parsed) ? parsed.filter((sh) => sh && typeof sh === "object") : [];
  } catch {
    return [];
  }
}
function writeShelvesCache(libraryId: string, shelves: any[]) {
  try {
    storage.set(shelvesCacheKey(libraryId), JSON.stringify(shelves));
  } catch {}
}

// The library id is restored synchronously so the first render can already
// show cached shelves and start fetching without waiting for /api/libraries.
const initialLibraryId = storageHelper.getLastLibraryId();

interface Library {
  id: string;
  name: string;
  mediaType: "book" | "podcast";
  // Server-assigned library icon name (abs-icons set, e.g. "books-1",
  // "microphone-1") — rendered via components/LibraryIcon.
  icon?: string;
  settings: {
    coverAspectRatio: number;
    audiobooksOnly: boolean;
  };
}

interface LibraryState {
  libraries: Library[];
  currentLibraryId: string | null;
  lastLoad: number;
  issues: number;
  filterData: any | null;
  numUserPlaylists: number;
  
  // Actions
  personalizedShelves: any[];
  // Last shelves fetch failed (network/proxy). Lets the home screen show a
  // real error+retry instead of masquerading as an empty library.
  shelvesLoadError: boolean;
  loadPersonalizedShelves: (force?: boolean) => Promise<void>;
  setCurrentLibraryId: (id: string | null) => void;
  loadLibraries: (force?: boolean) => Promise<boolean>;
  fetchLibraryDetails: (libraryId: string) => Promise<any>;
  reset: () => void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  libraries: [],
  currentLibraryId: initialLibraryId,
  lastLoad: 0,
  issues: 0,
  filterData: null,
  numUserPlaylists: 0,
  // Hydrate synchronously from the cache so the very first frame shows books
  // (revalidated in the background by loadPersonalizedShelves).
  personalizedShelves: readShelvesCache(initialLibraryId),
  shelvesLoadError: false,

  loadPersonalizedShelves: async (force = false) => {
    const libraryId = get().currentLibraryId;
    if (!libraryId) return;

    // Stale-while-revalidate: if the store is empty but a cache exists (e.g.
    // after a library switch), surface it immediately before the fetch.
    if (get().personalizedShelves.length === 0) {
      const cached = readShelvesCache(libraryId);
      if (cached.length > 0) set({ personalizedShelves: cached });
    }

    try {
      console.log(`[LibraryStore] Loading personalized shelves for ${libraryId}...`);
      // include=series only — the continue-series build needs series ids on
      // entities. rssfeed/numEpisodesIncomplete were requested but never read
      // (each costs the server extra lookups per item).
      const response = await api.get(`/api/libraries/${libraryId}/personalized?minified=1&include=series`);
      // Bail if the user switched libraries while this fetch was in flight —
      // otherwise we'd overwrite the new library's shelves with the old one's.
      if (get().currentLibraryId !== libraryId) return;
      const raw = response.data?.shelves || response.data || [];
      // Reverse proxies / captive portals return HTML error pages with HTTP
      // 200 — axios hands those over as a STRING, and installing a non-array
      // crashed the home screen (`.find` on a string). Keep previous shelves.
      if (!Array.isArray(raw)) {
        console.warn("[LibraryStore] personalized response is not an array — keeping previous shelves");
        set({ shelvesLoadError: true });
        return;
      }
      const shelves = raw.filter((sh: any) => sh && typeof sh === "object");
      // A 200 with an EMPTY shelf set is NOT authoritative: the server returns
      // one while it's still indexing, during a permissions race right after a
      // token refresh, or when the minified query path returns early. Treating
      // it as truth wiped a populated home screen AND poisoned the per-library
      // cache (which then hydrates empty on the next cold open, so shelves are
      // missing before any fetch runs). When we already have shelves, keep them
      // and flag a soft error instead of blanking. Never cache an empty set.
      if (shelves.length === 0 && get().personalizedShelves.length > 0) {
        console.warn("[LibraryStore] personalized returned empty but shelves exist — keeping them");
        set({ shelvesLoadError: true });
        return;
      }
      set({ personalizedShelves: shelves, shelvesLoadError: false });
      if (shelves.length > 0) writeShelvesCache(libraryId, shelves);
    } catch (err) {
      console.error("[LibraryStore] Failed to load personalized shelves:", err);
      // Keep existing shelves on transient load error to avoid flickering —
      // but flag it so an EMPTY home screen can say "couldn't load" + Retry
      // instead of masquerading as an empty library.
      set({ shelvesLoadError: true });
    }
  },

  setCurrentLibraryId: (id) => {
    if (id) {
      storageHelper.setLastLibraryId(id);
    } else {
      storageHelper.removeLastLibraryId();
    }
    // Swap shelves to the new library's cache (never show the old library's
    // shelves under the new library's name while the fresh fetch runs).
    // filterData/issues/playlist-count are PER-LIBRARY and must not survive
    // the switch — FilterModal only fetches when filterData is null, so a
    // stale object served the previous library's genres/authors/series and
    // selecting one filtered the new library by ids that don't exist there.
    const changed = get().currentLibraryId !== id;
    set({
      currentLibraryId: id,
      personalizedShelves: readShelvesCache(id),
      // shelvesLoadError is per-library too: library A's failed fetch must
      // not paint library B's (not-yet-fetched) home screen as an error.
      ...(changed ? { filterData: null, issues: 0, numUserPlaylists: 0, shelvesLoadError: false } : {}),
    });
    // Mirror the selection into auto_creds.json so the Android Auto browse
    // service switches libraries too (it otherwise keeps browsing the library
    // mirrored at login until the next app initialize).
    try {
      const { storageHelper: sh } = require("../utils/storage");
      const { writeAutoCreds } = require("../utils/autoCreds");
      const cfg = sh.getServerConfig();
      if (id && cfg?.address && cfg?.token) {
        writeAutoCreds(cfg.address, cfg.token, id, cfg.refreshToken).catch(() => {});
      }
    } catch {}
  },

  loadLibraries: async (force = false) => {
    // Prevent reloading libraries within 5 minutes unless forced
    const lastLoadDiff = Date.now() - get().lastLoad;
    if (!force && lastLoadDiff < 5 * 60 * 1000 && get().libraries.length > 0) {
      return false;
    }

    try {
      console.log("[LibraryStore] Loading libraries...");
      const response = await api.get("/api/libraries");
      const rawLibraries = response.data?.libraries || response.data || [];
      // A non-array body (proxy error page served as 200) is a FAILED load,
      // not "the server has zero libraries" — keep current state.
      if (!Array.isArray(rawLibraries)) {
        console.warn("[LibraryStore] libraries response is not an array — keeping current state");
        return false;
      }
      // One null/id-less entry in the list used to throw mid-`.some` and
      // silently discard the WHOLE payload — keep the valid libraries.
      const libraries = rawLibraries.filter((l: any) => l && typeof l === "object" && l.id);
      // An EMPTY list is treated as a FAILED load, not "the server has zero
      // libraries": a transient blip (server restart, auth race, proxy hiccup)
      // that returned [] would otherwise drive currentLibraryId to null, and a
      // null library makes loadPersonalizedShelves early-return — so the home
      // screen blanks and pull-to-refresh (which bails the same way) can't
      // recover it. Keeping current state leaves the existing library intact.
      if (libraries.length === 0) {
        console.warn("[LibraryStore] libraries response empty — keeping current state");
        return false;
      }

      let currentLibraryId = get().currentLibraryId;

      // If last saved library exists and is in the loaded list, reuse it, otherwise default to first
      const savedLibraryId = storageHelper.getLastLibraryId();
      const hasSavedLibrary = libraries.some((l: any) => l.id === savedLibraryId);

      if (hasSavedLibrary) {
        currentLibraryId = savedLibraryId;
      } else if (get().currentLibraryId && libraries.some((l: any) => l.id === get().currentLibraryId)) {
        // Keep the already-selected library if it's still present, even when it
        // was never persisted (auto-picked on a prior launch).
        currentLibraryId = get().currentLibraryId;
      } else {
        currentLibraryId = libraries[0].id;
      }

      // Persist the effective pick so it survives the next cold start. Without
      // this, users who never opened the LibrarySelector had no saved id, so the
      // library was re-derived from /api/libraries on EVERY launch — one flaky
      // response then reshuffled the selection and blanked their shelves.
      if (currentLibraryId) storageHelper.setLastLibraryId(currentLibraryId);

      // With the spurious-change guards above (empty-list bail + keep-current-
      // if-still-present), a true `libraryChanged` now means a GENUINE switch
      // (saved library deleted, or the very first pick) — so swapping shelves to
      // the new library's cache is correct, not a transient blip wiping them.
      const libraryChanged = currentLibraryId !== get().currentLibraryId;
      set({
        libraries,
        currentLibraryId,
        lastLoad: Date.now(),
        // If the effective library changed (e.g. saved one was deleted), swap
        // the shelves to the new library's cache instead of showing stale ones,
        // AND clear the per-library state the same way setCurrentLibraryId does
        // — otherwise FilterModal serves the old library's genres/authors and
        // the issues/playlist counts show the wrong library's numbers.
        ...(libraryChanged
          ? {
              personalizedShelves: readShelvesCache(currentLibraryId),
              filterData: null,
              issues: 0,
              numUserPlaylists: 0,
              shelvesLoadError: false,
            }
          : {}),
      });
      return true;
    } catch (err) {
      // Transient failure (offline start, server blip): KEEP the current
      // library + list — clobbering them to null broke refresh/series/library
      // switching until a later fetch happened to succeed, even though the
      // saved library id was still perfectly valid.
      console.error("[LibraryStore] Failed to load libraries:", err);
      return false;
    }
  },

  fetchLibraryDetails: async (libraryId: string) => {
    try {
      console.log(`[LibraryStore] Fetching library details for ${libraryId}...`);
      const response = await api.get(`/api/libraries/${libraryId}?include=filterdata`);
      const data = response.data || {};

      // Newer ABS wraps the library in {library}; older servers return it at
      // the top level. Either way it must be a real object with an id —
      // installing `[{}]` as the libraries list broke the selector.
      const library = data.library || (data.id ? data : null);
      const filterData = data.filterdata || null;
      const issues = data.issues || 0;
      const numUserPlaylists = data.numUserPlaylists || 0;

      // The user may have switched libraries while this request was in
      // flight (same guard loadPersonalizedShelves has) — installing the
      // stale payload would force-revert currentLibraryId and hand the new
      // library the old one's filterData.
      if (get().currentLibraryId !== libraryId) return data;

      if (!library || !library.id) {
        set({ filterData, issues, numUserPlaylists });
        return data;
      }

      // Update libraries list with fresh detail
      const updatedLibraries = get().libraries.map((lib) =>
        lib.id === library.id ? { ...lib, ...library } : lib
      );

      set({
        libraries: updatedLibraries.length > 0 ? updatedLibraries : [library],
        currentLibraryId: libraryId,
        filterData,
        issues,
        numUserPlaylists,
      });

      return data;
    } catch (err) {
      console.error(`[LibraryStore] Failed to fetch library detail for ${libraryId}:`, err);
      return null;
    }
  },

  reset: () => {
    set({
      libraries: [],
      currentLibraryId: null,
      lastLoad: 0,
      issues: 0,
      filterData: null,
      numUserPlaylists: 0,
      personalizedShelves: [],
      shelvesLoadError: false,
    });
  },
}));

// Mirror the personalized shelves into home_rows_state.json for the configurable
// home-row home-screen widget whenever the shelves or the active library change.
// Deduped by content signature inside mirrorHomeRows (shelves reload often with
// identical data). Kept out of the render path — a plain store subscription.
useLibraryStore.subscribe((state, prev) => {
  if (
    state.personalizedShelves !== prev.personalizedShelves ||
    state.currentLibraryId !== prev.currentLibraryId
  ) {
    try {
      require("../utils/homeRowsMirror").mirrorHomeRows();
    } catch {
      // Best-effort mirror; never let it break a store update.
    }
  }
});
