// File-local mock: nativewind's colorScheme is a native-backed singleton — we
// only need to observe .set() calls.
jest.mock("nativewind", () => ({
  colorScheme: { set: jest.fn() },
}));

import { colorScheme } from "nativewind";
import { useThemeStore } from "../../store/useThemeStore";
import { storage } from "../../utils/storage";

const initial = useThemeStore.getState();

describe("useThemeStore", () => {
  beforeEach(() => {
    useThemeStore.setState(initial, true);
    storage.remove("themeMode");
    storage.remove("useDynamicColors");
  });

  it("defaults to system mode with dynamic colors on", () => {
    expect(useThemeStore.getState().mode).toBe("system");
    expect(useThemeStore.getState().useDynamicColors).toBe(true);
  });

  it("initialize falls back to system when nothing is persisted", () => {
    useThemeStore.getState().initialize();
    expect(useThemeStore.getState().mode).toBe("system");
    expect(useThemeStore.getState().useDynamicColors).toBe(true);
    expect(colorScheme.set).toHaveBeenCalledWith("system");
  });

  it("initialize restores the persisted mode and dynamic-colors flag", () => {
    storage.set("themeMode", "dark");
    storage.set("useDynamicColors", false);
    useThemeStore.getState().initialize();
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().useDynamicColors).toBe(false);
    expect(colorScheme.set).toHaveBeenCalledWith("dark");
  });

  it("setMode persists, applies to NativeWind, and updates state", () => {
    useThemeStore.getState().setMode("light");
    expect(useThemeStore.getState().mode).toBe("light");
    expect(storage.getString("themeMode")).toBe("light");
    expect(colorScheme.set).toHaveBeenCalledWith("light");
  });

  it("setUseDynamicColors persists and updates state", () => {
    useThemeStore.getState().setUseDynamicColors(false);
    expect(useThemeStore.getState().useDynamicColors).toBe(false);
    expect(storage.getBoolean("useDynamicColors")).toBe(false);

    useThemeStore.getState().setUseDynamicColors(true);
    expect(useThemeStore.getState().useDynamicColors).toBe(true);
    expect(storage.getBoolean("useDynamicColors")).toBe(true);
  });
});
