import { create } from "zustand";
import { colorScheme } from "nativewind";
import { storageHelper } from "../utils/storage";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeState {
  mode: ThemeMode;
  /**
   * When true, the app is tinted from the system wallpaper (Material You).
   * When false, it uses the static brand teal palette. ON by default to match
   * the original TomeSonic app.
   */
  useDynamicColors: boolean;
  initialize: () => void;
  setMode: (mode: ThemeMode) => void;
  setUseDynamicColors: (value: boolean) => void;
}

// Apply the chosen mode to NativeWind. "system" lets NativeWind follow the OS.
function applyMode(mode: ThemeMode) {
  colorScheme.set(mode);
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: "system",
  useDynamicColors: true,

  initialize: () => {
    const saved = (storageHelper.getThemeMode() as ThemeMode) || "system";
    applyMode(saved);
    set({ mode: saved, useDynamicColors: storageHelper.getUseDynamicColors() });
  },

  setMode: (mode) => {
    storageHelper.setThemeMode(mode);
    applyMode(mode);
    set({ mode });
  },

  setUseDynamicColors: (value) => {
    storageHelper.setUseDynamicColors(value);
    set({ useDynamicColors: value });
  },
}));
