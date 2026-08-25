#!/usr/bin/env bash
# Everything that happens INSIDE the booted Wear OS emulator, for
# .github/workflows/wear-screenshots.yml.
#
# A file rather than an inline `script:` block for the reason
# .github/workflows/e2e-smoke.yml already records: android-emulator-runner runs
# each LINE of an inline script in its own shell, so variables, functions and
# `cd` do not survive between them. One `bash <this file>` is one shell.
#
# NOT `set -e`: a screen that fails to render must still let the rest of the run
# finish and, above all, still produce shots/logcat.txt — the log is the whole
# reason a red run is diagnosable at all. Install failure is the one hard stop.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SHOTS="$ROOT/shots"
mkdir -p "$SHOTS"

PKG=com.tomesonic.app
ACTIVITY="$PKG/com.tomesonic.app.wear.MainActivity"

# 10.0.2.2 is the host loopback as seen from the emulator; the mock server the
# workflow started binds 0.0.0.0:3333 on that host.
SERVER="http://10.0.2.2:3333"
TOKEN="demo"

# Ids come from native/wear/screenshots/mock_abs.py — keep the two in step.
BOOK_LIBRARY_ID="lib_books"
BOOK_ID="li_book_1"

# Seconds to wait after a launch before the shutter. The long one covers a cold
# start plus the ABS round trip plus Coil fetching and decoding a cover; the
# player also has to bind the media service and open a play session.
SETTLE=10
PLAYER_SETTLE=12
CONNECT_SETTLE=8

echo "== devices =="
adb devices
adb wait-for-device

APK="$(ls -1 "$ROOT"/native/wear/build/outputs/apk/debug/*.apk 2>/dev/null | head -n 1)"
if [ -z "$APK" ]; then
  echo "::error::no wear debug APK under native/wear/build/outputs/apk/debug/"
  exit 1
fi
echo "== installing $APK =="
adb install -r "$APK" || exit 1

# A watch dims and dozes faster than any of these sleeps: without this the
# shutter catches an ambient screen instead of the app.
adb shell svc power stayon true || true
adb shell settings put system screen_off_timeout 1800000 || true
adb shell wm dismiss-keyguard || true

# media3 promotes PlaybackService to the foreground with a media notification.
# Ungranted, the notification is simply dropped on API 33+; granting it keeps
# the player capture on the intended path rather than a degraded one.
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true

shoot() {
  local name="$1"
  adb shell input keyevent KEYCODE_WAKEUP || true
  adb exec-out screencap -p > "$SHOTS/$name.png"
  if [ -s "$SHOTS/$name.png" ]; then
    echo "captured $name.png ($(wc -c < "$SHOTS/$name.png") bytes)"
  else
    echo "::warning::$name.png is empty"
  fi
}

# Launch MainActivity with the debug rig's extras (see DebugLaunch.kt). Values
# are single-quoted for the DEVICE's shell — `adb shell` concatenates its
# arguments and hands the string to sh, so a route like `item/li_book_1` would
# otherwise be at the mercy of whatever the guest shell makes of it.
launch() {
  local route="$1"
  local play_item="${2:-}"
  adb shell am force-stop "$PKG"
  if [ -n "$play_item" ]; then
    adb shell am start -n "$ACTIVITY" \
      -e debug_abs_server "'$SERVER'" \
      -e debug_abs_token "'$TOKEN'" \
      -e debug_route "'$route'" \
      -e debug_play_item "'$play_item'"
  else
    adb shell am start -n "$ACTIVITY" \
      -e debug_abs_server "'$SERVER'" \
      -e debug_abs_token "'$TOKEN'" \
      -e debug_route "'$route'"
  fi
}

# ---------------------------------------------------------------------------
# connect FIRST, and with no extras at all: the launches below write
# credentials into DataStore, and DataStore outlives a force-stop. Once any of
# them has run, the connect screen no longer exists to photograph.
# ---------------------------------------------------------------------------
echo "== connect (no credentials) =="
adb shell am force-stop "$PKG"
adb shell am start -n "$ACTIVITY"
sleep "$CONNECT_SETTLE"
shoot connect

# Routes are Routes.kt's own strings (home / library/{id} / item/{id} /
# downloads / settings) with ids from the mock server.
for pair in \
  "home:home" \
  "library:library/$BOOK_LIBRARY_ID" \
  "item:item/$BOOK_ID" \
  "downloads:downloads" \
  "settings:settings"
do
  name="${pair%%:*}"
  route="${pair#*:}"
  echo "== $name ($route) =="
  launch "$route"
  sleep "$SETTLE"
  shoot "$name"
done

# The player, with a book actually playing: debug_play_item goes through the
# same PlayerConnection.playItem the home screen's rows call.
echo "== player (playing $BOOK_ID) =="
launch player "$BOOK_ID"
sleep "$PLAYER_SETTLE"
shoot player

echo "== logcat =="
adb logcat -d -t 500 > "$SHOTS/logcat.txt" 2>&1 || true

echo "== captured =="
ls -l "$SHOTS"
