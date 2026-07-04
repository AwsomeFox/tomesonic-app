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
    return Array.isArray(parsed) ? parsed : [];
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
      const shelves = response.data?.shelves || response.data || [];
      set({ personalizedShelves: shelves });
      writeShelvesCache(libraryId, shelves);
    } catch (err) {
      console.error("[LibraryStore] Failed to load personalized shelves:", err);
      // Keep existing shelves on transient load error to avoid flickering
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
    set({ currentLibraryId: id, personalizedShelves: readShelvesCache(id) });
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
      const libraries = response.data?.libraries || response.data || [];
      
      let currentLibraryId = get().currentLibraryId;
      
      // If last saved library exists and is in the loaded list, reuse it, otherwise default to first
      const savedLibraryId = storageHelper.getLastLibraryId();
      const hasSavedLibrary = libraries.some((l: any) => l.id === savedLibraryId);
      
      if (hasSavedLibrary) {
        currentLibraryId = savedLibraryId;
      } else if (libraries.length > 0) {
        currentLibraryId = libraries[0].id;
      } else {
        currentLibraryId = null;
      }

      const libraryChanged = currentLibraryId !== get().currentLibraryId;
      set({
        libraries,
        currentLibraryId,
        lastLoad: Date.now(),
        // If the effective library changed (e.g. saved one was deleted), swap
        // the shelves to the new library's cache instead of showing stale ones.
        ...(libraryChanged ? { personalizedShelves: readShelvesCache(currentLibraryId) } : {}),
      });
      return true;
    } catch (err) {
      console.error("[LibraryStore] Failed to load libraries:", err);
      set({ libraries: [], currentLibraryId: null });
      return false;
    }
  },

  fetchLibraryDetails: async (libraryId: string) => {
    try {
      console.log(`[LibraryStore] Fetching library details for ${libraryId}...`);
      const response = await api.get(`/api/libraries/${libraryId}?include=filterdata`);
      const data = response.data || {};

      const library = data.library || {};
      const filterData = data.filterdata || null;
      const issues = data.issues || 0;
      const numUserPlaylists = data.numUserPlaylists || 0;

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
    });
  },
}));
