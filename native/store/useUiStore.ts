import { create } from "zustand";

interface UiState {
  drawerOpen: boolean;
  librarySelectorOpen: boolean;
  isSearchActive: boolean;
  searchQuery: string;
  openDrawer: () => void;
  closeDrawer: () => void;
  openLibrarySelector: () => void;
  closeLibrarySelector: () => void;
  setSearchActive: (active: boolean) => void;
  setSearchQuery: (query: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  drawerOpen: false,
  librarySelectorOpen: false,
  isSearchActive: false,
  searchQuery: "",
  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  openLibrarySelector: () => set({ librarySelectorOpen: true }),
  closeLibrarySelector: () => set({ librarySelectorOpen: false }),
  setSearchActive: (active) => set({ isSearchActive: active }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}));
