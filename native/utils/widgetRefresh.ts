import { NativeModules } from "react-native";

// Asks the native WidgetRefresh module to redraw the home-screen widgets NOW
// (re-reading widget_state.json / home_rows_state.json), instead of waiting for
// Android's ~30-minute widget tick. This is what makes the mini/full player
// widgets' progress bar and play/pause glyph update in near-real-time while the
// app is running. Best-effort: if the native module isn't present (older build,
// or the module failed to register), it silently no-ops and the widgets still
// refresh on the periodic tick.
export function refreshWidgets(): void {
  try {
    const mod = (NativeModules as any)?.WidgetRefresh;
    if (mod && typeof mod.refresh === "function") mod.refresh();
  } catch {
    // Never let a widget refresh throw into the caller.
  }
}
