import { create } from "zustand";
import { api } from "../utils/api";
import { storageHelper } from "../utils/storage";

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
  currentLibraryId: null,
  lastLoad: 0,
  issues: 0,
  filterData: null,
  numUserPlaylists: 0,
  personalizedShelves: [],

  loadPersonalizedShelves: async (force = false) => {
    const libraryId = get().currentLibraryId;
    if (!libraryId) return;

    try {
      console.log(`[LibraryStore] Loading personalized shelves for ${libraryId}...`);
      const response = await api.get(`/api/libraries/${libraryId}/personalized?minified=1&include=rssfeed,numEpisodesIncomplete,series`);
      const shelves = response.data?.shelves || response.data || [];
      set({ personalizedShelves: shelves });
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
    set({ currentLibraryId: id });
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

      set({
        libraries,
        currentLibraryId,
        lastLoad: Date.now(),
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
