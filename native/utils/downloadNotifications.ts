import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

// A single, upd-in-place notification per book download showing text progress
// (expo-notifications has no native progress-bar API, so we update the body).
const CHANNEL_ID = "downloads";
let _ready = false;
let _granted = false;
// libraryItemId -> notification identifier (so we can update/dismiss it).
const _ids: Record<string, string> = {};
// libraryItemId -> last percent we notified (avoid spamming on every callback).
const _lastPct: Record<string, number> = {};

async function ensureReady() {
  if (_ready) return;
  _ready = true;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: "Downloads",
        importance: Notifications.AndroidImportance.LOW, // quiet, no sound
      });
    }
    const perm = await Notifications.getPermissionsAsync();
    _granted = perm.granted;
    if (!_granted && perm.canAskAgain) {
      const req = await Notifications.requestPermissionsAsync();
      _granted = req.granted;
    }
  } catch {}
}

async function present(itemId: string, title: string, body: string, ongoing: boolean) {
  await ensureReady();
  if (!_granted) return;
  try {
    const identifier = await Notifications.scheduleNotificationAsync({
      identifier: _ids[itemId], // reuse to update in place
      content: {
        title,
        body,
        // Keep progress notifications sticky/silent while downloading.
        sticky: ongoing,
        autoDismiss: !ongoing,
        ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
      } as any,
      trigger: null, // show immediately
    });
    _ids[itemId] = identifier;
  } catch {}
}

export const downloadNotifications = {
  // Called on download start.
  start(itemId: string, title: string) {
    _lastPct[itemId] = -1;
    present(itemId, "Downloading", `${title} — 0%`, true);
  },

  // Called on progress (0..1). Throttled to whole-percent changes.
  progress(itemId: string, title: string, progress: number) {
    const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    if (pct === _lastPct[itemId]) return;
    _lastPct[itemId] = pct;
    present(itemId, "Downloading", `${title} — ${pct}%`, true);
  },

  // Called on completion — replaces the progress notification with a done one.
  async complete(itemId: string, title: string) {
    await ensureReady();
    delete _lastPct[itemId];
    if (_ids[itemId]) {
      try { await Notifications.dismissNotificationAsync(_ids[itemId]); } catch {}
      delete _ids[itemId];
    }
    if (!_granted) return;
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Download complete",
          body: title,
          ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
        } as any,
        trigger: null,
      });
    } catch {}
  },

  // Called on failure/cancel — clears the progress notification.
  async clear(itemId: string) {
    delete _lastPct[itemId];
    if (_ids[itemId]) {
      try { await Notifications.dismissNotificationAsync(_ids[itemId]); } catch {}
      delete _ids[itemId];
    }
  },
};
