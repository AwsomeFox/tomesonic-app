import notifee, { AndroidImportance, AuthorizationStatus } from "@notifee/react-native";
import { Platform } from "react-native";

// One notification per book download with a REAL Android progress bar
// (notifee's android.progress — expo-notifications has no progress API and
// re-posts the whole notification per update, which Android rate-limits into
// a stuck percentage on fast connections).
const CHANNEL_ID = "downloads";
let _channelReady = false;
let _granted = false;
let _permChecked = false;
// libraryItemId -> last percent shown (skip no-op updates).
const _lastPct: Record<string, number> = {};
// libraryItemId -> last update timestamp. Android drops notification updates
// posted faster than ~1/sec per app, which is exactly what made the old
// notification freeze mid-download on fast connections — self-throttle below
// that.
const _lastShownAt: Record<string, number> = {};
const MIN_UPDATE_INTERVAL_MS = 500;
// Items with a live progress notification: presents re-check this after every
// await so a display racing clear()/complete() can't resurrect a dismissed one.
const _active = new Set<string>();

// Proactively request POST_NOTIFICATIONS (Android 13+). Without this the media
// notification and lock-screen transport controls silently never appear for a
// listen-only user, because on targetSdk 33+ a foreground-service notification
// whose permission is denied is suppressed — and the ONLY other request site
// is the download path, which a streaming user may never hit. Asked at most
// once (a denial is remembered so we don't nag on every launch).
let _playbackPermRequested = false;
export async function ensurePlaybackNotificationPermission(): Promise<void> {
  if (_playbackPermRequested) return;
  // Only Android 13+ (API 33) has a runtime POST_NOTIFICATIONS permission that
  // can suppress the media/lock-screen controls. Older Android grants it
  // implicitly; iOS would show an unwanted push prompt on first playback,
  // which is unrelated to this Android-only media-visibility goal.
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return;
  _playbackPermRequested = true;
  try {
    const { storage } = require("./storage");
    if (storage.getBoolean("notifPermRequested")) return;
    // Persist ONLY after the prompt actually completes — flagging first meant a
    // transient requestPermission() throw permanently suppressed the prompt (and
    // thus the media/lock-screen controls) for a streaming-only user.
    const settings = await notifee.requestPermission();
    _granted = settings.authorizationStatus >= AuthorizationStatus.AUTHORIZED;
    _permChecked = true;
    storage.set("notifPermRequested", true);
  } catch {
    // Prompt failed to run — allow a retry on the next launch (don't persist
    // the flag, and clear the in-memory guard).
    _playbackPermRequested = false;
  }
}

async function ensureReady(): Promise<boolean> {
  try {
    if (!_permChecked) {
      // Honor the shared "asked once" flag both request paths persist — if the
      // prompt already ran (this launch's playback path or a previous launch),
      // read the current status WITHOUT re-prompting.
      let asked = false;
      try {
        const { storage } = require("./storage");
        asked = !!storage.getBoolean("notifPermRequested");
      } catch {
        // Storage unavailable — treat as not-yet-asked (a single request is
        // the correct fallback below).
      }
      // Deliberately NOT wrapped in a try that falls back to requestPermission:
      // once asked, a getNotificationSettings() failure must not re-prompt
      // (that breaks "asked at most once"). A throw here propagates to the
      // outer catch, leaving _permChecked false so the next update retries.
      let settings;
      if (asked) {
        settings = await notifee.getNotificationSettings();
      } else {
        settings = await notifee.requestPermission();
        try {
          require("./storage").storage.set("notifPermRequested", true);
        } catch {}
      }
      _granted = settings.authorizationStatus >= AuthorizationStatus.AUTHORIZED;
      // Set only AFTER a successful settings call — a throw above leaves this
      // false so the next download update retries instead of staying disabled
      // for the whole session.
      _permChecked = true;
    }
    if (!_channelReady && Platform.OS === "android") {
      await notifee.createChannel({
        id: CHANNEL_ID,
        name: "Downloads",
        importance: AndroidImportance.LOW, // silent, no heads-up
      });
      _channelReady = true;
    }
  } catch {
    return false;
  }
  return _granted;
}

async function showProgress(itemId: string, title: string, pct: number) {
  if (!(await ensureReady())) return;
  // Cancelled while we awaited permission/channel setup.
  if (!_active.has(itemId)) return;
  try {
    await notifee.displayNotification({
      id: `dl_${itemId}`, // same id = in-place update (no flicker, no re-alert)
      title: "Downloading",
      subtitle: `${pct}%`,
      body: title,
      android: {
        channelId: CHANNEL_ID,
        smallIcon: "notification_icon", // generated by the expo-notifications plugin
        onlyAlertOnce: true,
        ongoing: true, // not swipe-dismissable while downloading
        autoCancel: false,
        progress: { max: 100, current: pct },
      },
    });
    if (!_active.has(itemId)) {
      // clear()/complete() ran while displaying — take it right back down.
      try { await notifee.cancelNotification(`dl_${itemId}`); } catch {}
    }
  } catch {}
}

// notifee ids the transient zip export produces: downloadFileByUrl is handed
// notification id `zip_<itemId>`, which the helpers below prefix as
// `dl_zip_<itemId>` (progress) / `dl_done_zip_<itemId>` (legacy complete).
const STALE_ZIP_NOTIFICATION_PREFIXES = ["dl_zip_", "dl_done_zip_"];

/**
 * Cancel zip-download notifications orphaned by a killed/crashed app. The zip
 * export is fully transient (in-memory handle, staging file deleted right
 * after the share sheet), so any dl_zip_* notification still displayed at
 * startup is stale by definition — tapping it does nothing. Best-effort:
 * never throws.
 */
export async function sweepStaleZipNotifications(): Promise<void> {
  try {
    const displayed = await notifee.getDisplayedNotifications();
    for (const entry of displayed || []) {
      const id = entry?.notification?.id ?? entry?.id;
      if (typeof id !== "string") continue;
      if (!STALE_ZIP_NOTIFICATION_PREFIXES.some((p) => id.startsWith(p))) continue;
      try {
        await notifee.cancelNotification(id);
      } catch {}
    }
  } catch {}
}

export const downloadNotifications = {
  // Called on download start.
  start(itemId: string, title: string) {
    _lastPct[itemId] = -1;
    _lastShownAt[itemId] = 0;
    _active.add(itemId);
    showProgress(itemId, title, 0);
  },

  // Called on progress (0..1). Throttled to whole-percent changes AND a
  // minimum interval so Android's notification rate limiter never silently
  // drops updates (the cause of the old "stuck at 37%" notification).
  progress(itemId: string, title: string, progress: number) {
    if (!_active.has(itemId)) return; // already cleared/completed
    const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    const now = Date.now();
    if (pct === _lastPct[itemId]) return;
    if (now - (_lastShownAt[itemId] || 0) < MIN_UPDATE_INTERVAL_MS) return;
    _lastPct[itemId] = pct;
    _lastShownAt[itemId] = now;
    showProgress(itemId, title, pct);
  },

  // Called on completion — replaces the progress notification with a done one.
  async complete(itemId: string, title: string) {
    _active.delete(itemId);
    delete _lastPct[itemId];
    delete _lastShownAt[itemId];
    try { await notifee.cancelNotification(`dl_${itemId}`); } catch {}
    if (!(await ensureReady())) return;
    try {
      await notifee.displayNotification({
        id: `dl_done_${itemId}`,
        title: "Download complete",
        body: title,
        android: {
          channelId: CHANNEL_ID,
          smallIcon: "notification_icon",
          onlyAlertOnce: true,
        },
      });
    } catch {}
  },

  // Called on failure/cancel — clears the progress notification.
  async clear(itemId: string) {
    _active.delete(itemId);
    delete _lastPct[itemId];
    delete _lastShownAt[itemId];
    try { await notifee.cancelNotification(`dl_${itemId}`); } catch {}
  },
};
