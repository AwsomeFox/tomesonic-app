import { create } from "zustand";
import { storage } from "../utils/storage";
import { appLogger } from "../utils/logger";

/**
 * Local "Want to Read" / favorites list. ABS has NO server favorites flag, so
 * this is a device-local overlay: a set of libraryItemIds the user has marked.
 * Self-contained — persisted under its OWN MMKV key (`favorites`) so it never
 * collides with the sync/bookmark queues, and it survives app restarts.
 *
 * A single local list (not per-account) is intentional and acceptable per the
 * feature spec; `clear()` is exposed so a logout hook can wipe it (see the note
 * in the store README — wiring that in belongs in useUserStore.logout).
 */
const FAVORITES_KEY = "favorites";

// Corrupt/hostile persisted values (bad backup restore, manual edit) must never
// crash the store — parse defensively and keep only own string ids, deduped.
function loadFavorites(): string[] {
  try {
    const parsed = JSON.parse(storage.getString(FAVORITES_KEY) || "null");
    if (Array.isArray(parsed)) {
      return Array.from(new Set(parsed.filter((v) => typeof v === "string" && v)));
    }
  } catch {}
  return [];
}

function persist(ids: string[]) {
  try {
    storage.set(FAVORITES_KEY, JSON.stringify(ids));
  } catch (e) {
    appLogger.warn(`Failed to persist favorites: ${e}`, "Favorites");
  }
}

interface FavoritesState {
  /** Marked libraryItemIds. Subscribe to this for reactive `isFavorite` UI. */
  favorites: string[];
  /** Add the id if absent, remove it if present. Persists the new list. */
  toggleFavorite: (id: string) => void;
  /** True when the id is in the favorites list (non-reactive point read). */
  isFavorite: (id: string) => boolean;
  /** Current favorites list (non-reactive snapshot). */
  list: () => string[];
  /** Wipe all favorites (e.g. on logout). Persists the empty list. */
  clear: () => void;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: loadFavorites(),

  toggleFavorite: (id) => {
    if (!id || typeof id !== "string") return;
    // Functional set + persist the exact computed list (not a post-set re-read),
    // mirroring useRmabStore.noteRequestStatus so concurrent toggles don't race.
    set((state) => {
      const has = state.favorites.includes(id);
      const next = has ? state.favorites.filter((x) => x !== id) : [...state.favorites, id];
      persist(next);
      return { favorites: next };
    });
  },

  isFavorite: (id) => get().favorites.includes(id),

  list: () => get().favorites,

  clear: () => {
    persist([]);
    set({ favorites: [] });
  },
}));
