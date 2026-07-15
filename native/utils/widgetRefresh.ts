import { NativeModules } from "react-native";

// Asks the native WidgetRefresh module to redraw home-screen widgets NOW,
// instead of waiting for Android's ~30-minute tick. Best-effort: if the native
// module (or the method) isn't present, it silently no-ops and the widgets still
// refresh on the periodic tick.
function call(method: "refreshPlayers" | "refreshHomeRows"): void {
  try {
    const mod = (NativeModules as any)?.WidgetRefresh;
    if (mod && typeof mod[method] === "function") mod[method]();
  } catch {
    // Never let a widget refresh throw into the caller.
  }
}

// Player widgets (mini / full / resume) read the local widget_state.json — safe
// to call on the ~2s live cadence while playing. This is what makes the progress
// bar and play/pause glyph update in near-real-time.
export function refreshPlayerWidgets(): void {
  call("refreshPlayers");
}

// Home-row widget only. Its list factory fetches covers over the NETWORK, so
// only call this when home_rows_state.json actually changes (shelf/library/token
// change) — never on the playback cadence.
export function refreshHomeRowWidget(): void {
  call("refreshHomeRows");
}
