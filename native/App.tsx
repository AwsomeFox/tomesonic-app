import "./global.css";
import React, { useEffect } from "react";
import { View, AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as ScreenOrientation from "expo-screen-orientation";
import AppNavigator from "./navigation/AppNavigator";
import PlayerBottomSheet from "./components/PlayerBottomSheet";
import CastController from "./components/CastController";
import LibrarySelector from "./components/LibrarySelector";
import ErrorBoundary from "./components/ErrorBoundary";
import OfflineBanner from "./components/OfflineBanner";
import RotationCurtain from "./components/RotationCurtain";
import { useUserStore } from "./store/useUserStore";
import { useThemeStore } from "./store/useThemeStore";
import { useThemeColors } from "./theme/useThemeColors";
import { DynamicThemeProvider } from "./theme/DynamicThemeContext";
import { useDownloadStore } from "./store/useDownloadStore";
import { usePlaybackStore, recoverPlaybackIfNeeded } from "./store/usePlaybackStore";
import { flushPendingSyncs } from "./utils/progressSync";
import { useNetworkStatus } from "./hooks/useNetworkStatus";

function AppShell() {
  const colors = useThemeColors();
  const user = useUserStore((state) => state.user);
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Follow the app's resolved theme, not the OS scheme — the in-app
          Theme setting can force light/dark independently of the system. */}
      <StatusBar style={colors.isDark ? "light" : "dark"} />
      <OfflineBanner />
      <AppNavigator />
      <PlayerBottomSheet />
      {user ? <CastController /> : null}
      {user ? <LibrarySelector /> : null}
      {/* Last child = topmost: masks layout reflow during rotation. */}
      <RotationCurtain />
    </View>
  );
}

export default function App() {
  const initializeUser = useUserStore((state) => state.initialize);
  const initializeTheme = useThemeStore((state) => state.initialize);
  const lockOrientation = useUserStore((state) => state.settings.lockOrientation);
  const { isConnected } = useNetworkStatus();

  // Regaining connectivity: push any progress that queued while offline, and
  // give an error-stalled player its stream back (the auto-retry timers are
  // throttled in the background — connectivity return is the reliable signal).
  useEffect(() => {
    if (isConnected) {
      flushPendingSyncs().catch(() => {});
      recoverPlaybackIfNeeded().catch(() => {});
    }
  }, [isConnected]);

  useEffect(() => {
    initializeTheme();
    const init = async () => {
      await initializeUser();
      // RMAB (ReadMeABook) config is local-only — sync read from MMKV.
      require("./store/useRmabStore").useRmabStore.getState().initialize();
      useDownloadStore.getState().loadDownloadsFromDb();
      const user = useUserStore.getState().user;
      if (user) {
        await usePlaybackStore.getState().loadLastSession();
      }
    };
    init();
  }, [initializeUser, initializeTheme]);

  // When the app returns to the foreground, flush any playback-progress syncs
  // that were queued while offline, and recover a player that errored while
  // the device slept (background retry timers may never have fired).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        flushPendingSyncs().catch(() => {});
        recoverPlaybackIfNeeded().catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // Lock/unlock screen orientation per the "Lock orientation" setting. Use an
  // explicit ALL lock when unlocked so it overrides the manifest's portrait
  // default (unlockAsync would fall back to that portrait default).
  useEffect(() => {
    ScreenOrientation.lockAsync(
      lockOrientation
        ? ScreenOrientation.OrientationLock.PORTRAIT_UP
        : ScreenOrientation.OrientationLock.ALL
    ).catch(() => {});
  }, [lockOrientation]);

  return (
    <SafeAreaProvider>
      <DynamicThemeProvider>
        <ErrorBoundary>
          <AppShell />
        </ErrorBoundary>
      </DynamicThemeProvider>
    </SafeAreaProvider>
  );
}
