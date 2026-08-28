#!/usr/bin/env bash
# Everything that happens INSIDE the booted Android Automotive OS emulator, for
# .github/workflows/automotive-screenshots.yml.
#
# A file rather than an inline `script:` block for the reason
# .github/workflows/e2e-smoke.yml and the wear rig already record:
# android-emulator-runner runs each LINE of an inline script in its own shell,
# so variables, functions and `cd` do not survive between them. One
# `bash <this file>` is one shell.
#
# NOT `set -e`, same as the wear rig: a screen that fails to render must still
# let the rest of the run finish and, above all, still produce the logcat — the
# log is the whole reason a red run is diagnosable at all. Failures are RECORDED
# (see `fail`) and reported in one block at the end, and the script exits 1 if
# any of them fired, naming the assumption that broke. Two things are hard stops
# because nothing after them can mean anything: no APK, and a failed install.
#
# THE NO-LAUNCHER WRINKLE (ARCHITECTURE.md §11): this artifact has no launcher
# activity, so unlike wear's rig there is no `am start -n <pkg>/<MainActivity>`
# to photograph. The car's Media Center is driven instead, with the intent named
# below, and the app is signed in through a debug-only broadcast receiver
# (src/debug/.../DebugSeed.kt) rather than by typing into the sign-in form.
#
# Every string this script cannot verify without a booted emulator is marked
# VERIFIED (against a documented API surface) or TO-CONFIRM (first dispatch run)
# here and in README.md. When a TO-CONFIRM one breaks, the `fail` message says
# which assumption it was.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RIG="$ROOT/native/automotive/screenshots"
OUT="$RIG/out"
mkdir -p "$OUT"

# The workflow sets this per matrix leg; a local run gets "local". Screenshots
# are named "<profile>-<screen>.png" so the two emulator profiles (Play's two
# floors, README.md § Play sizes) never overwrite each other.
PROFILE="${SCREENSHOT_PROFILE:-local}"

PKG=com.tomesonic.app
NS=com.tomesonic.app.automotive
# Fully qualified, like the manifest: the applicationId differs from the
# namespace, so a leading dot would be the one thing that reads wrong here.
MEDIA_SERVICE="$PKG/$NS.media.AbsLibraryService"
SIGN_IN_ACTIVITY="$PKG/$NS.ui.SignInActivity"
SETTINGS_ACTIVITY="$PKG/$NS.ui.SettingsActivity"
SEED_RECEIVER="$PKG/$NS.DebugSeed"

# --- the Media Center intent -------------------------------------------------
# VERIFIED against androidx `car/app/app/api/current.txt` (the checked-in API
# surface of androidx.car.app.mediaextensions.MediaIntentExtras) and against
# AOSP's `android.car.Car`:
#
#   Car.CAR_INTENT_ACTION_MEDIA_TEMPLATE   = "android.car.intent.action.MEDIA_TEMPLATE"
#   Car.CAR_EXTRA_MEDIA_COMPONENT          = "android.car.intent.extra.MEDIA_COMPONENT"
#   MediaIntentExtras.EXTRA_KEY_MEDIA_COMPONENT
#                                          = "android.car.intent.extra.MEDIA_COMPONENT"
#   MediaIntentExtras.ACTION_MEDIA_TEMPLATE_V2
#                                          = "androidx.car.app.mediaextensions.action.MEDIA_TEMPLATE_V2"
#
# Note what that means, because it contradicts the shape people write from
# memory: there is NO `androidx.car.app.action.MEDIA_TEMPLATE`, and the media
# component extra is NOT namespaced under androidx — androidx's constant
# resolves to the AOSP string. developer.android.com ("Add Android Automotive OS
# support to your media app") says every media host supports the V1 action while
# only newer hosts support V2, so V1 is tried first and V2 is the fallback.
#
# The extra's value is the FLATTENED component name of the browse service — for
# us the media3 MediaLibraryService, which also answers the legacy
# `android.media.browse.MediaBrowserService` action (see src/main manifest).
MEDIA_TEMPLATE_ACTION="android.car.intent.action.MEDIA_TEMPLATE"
MEDIA_TEMPLATE_V2_ACTION="androidx.car.app.mediaextensions.action.MEDIA_TEMPLATE_V2"
EXTRA_MEDIA_COMPONENT="android.car.intent.extra.MEDIA_COMPONENT"
# Last resort if neither action resolves on this image (TO-CONFIRM): the AOSP
# Media Center's own component.
MEDIA_CENTER_FALLBACK="com.android.car.media/.MediaActivity"

# --- the mock server ---------------------------------------------------------
# 10.0.2.2 is the host loopback as seen from the emulator; the workflow starts
# mock_abs.py on 0.0.0.0:3333 on that host. Ids come from mock_abs.py — keep the
# two in step.
SERVER="http://10.0.2.2:3333"
TOKEN="demo"
USERNAME="demo"
USER_ID="usr_demo"
LAST_ITEM="li_book_1"
LAST_TITLE="The Salt Road"
LAST_AUTHOR="Mariam Okonkwo"
BOOK_LIBRARY_NAME="Audiobooks"

# --- VHAL --------------------------------------------------------------------
# VERIFIED against AOSP `android.car.VehiclePropertyIds` and `android.car.VehicleGear`:
#   PERF_VEHICLE_SPEED = 291504647 (0x11600207)
#   GEAR_SELECTION     = 289408000 (0x11400400)
#   VehicleGear.GEAR_PARK = 4, GEAR_DRIVE = 8
# and against `CarShellCommand`, whose usage string is
#   inject-vhal-event <property name in SCREAMING_SNAKE_CASE or ID in Hex or
#                      Decimal> [area ID] data(can be comma separated list)
#                      [-t delay_time_seconds]
# (`-t` shifts the event TIMESTAMP; it is not a ramp, whatever the blog posts
# say). Decimal ids are used below because the hex spelling of a VHAL id is
# where transcription errors live.
# developer.android.com ("Test using the Android Automotive OS emulator"): "To
# simulate driving, you should set the Car speed to a non-zero value and Gear to
# something other than P (Park). To simulate a parked state, all that is
# necessary is to set the Gear to P (Park)."
# TO-CONFIRM on the first run: that `cmd car_service inject-vhal-event` is
# permitted on the CI image (it is a shell command on a userdebug build) and
# that CarUxRestrictions actually blocks a non-distraction-optimized activity
# there. A generic system image that does not enforce it is LOGGED, not failed —
# the platform, not this app, owns that behaviour (PE-1).
PROP_VEHICLE_SPEED=291504647
PROP_GEAR_SELECTION=289408000
GEAR_PARK=4
GEAR_DRIVE=8
DRIVING_SPEED=30

# Seconds to wait before a shutter. The car's Media Center has to bind our
# service, which cold-starts the process, builds the browse tree and fetches
# covers over the (mock) network; ARCHITECTURE.md §10 budgets 10 s for launch
# and 10 s for content, so these sit just past both.
SETTLE=12
BROWSE_SETTLE=14
NAV_SETTLE=6

FAILURES=()
fail() {
  echo "::error::$1"
  FAILURES+=("$1")
}
note() { echo; echo "== $* =="; }

# ---------------------------------------------------------------------------
# device plumbing
# ---------------------------------------------------------------------------

note "devices"
adb devices
adb wait-for-device

# The action waits for boot before running this script, but an AAOS image keeps
# starting services well past that point — car_service in particular, which the
# VHAL step and the Media Center both need.
for _ in $(seq 1 60); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
for _ in $(seq 1 60); do
  # ": found", not "found" — the negative answer is "Service car_service: not
  # found", which contains it.
  adb shell service check car_service 2>/dev/null | grep -q ": found" && break
  sleep 2
done
echo "boot_completed=$(adb shell getprop sys.boot_completed | tr -d '\r')"
echo "car_service: $(adb shell service check car_service | tr -d '\r')"
echo "fingerprint: $(adb shell getprop ro.build.fingerprint | tr -d '\r')"
echo "screen: $(adb shell wm size | tr -d '\r') / $(adb shell wm density | tr -d '\r')"

# AAOS images run in headless-system-user mode: the human's user is 10, not 0,
# and an `am` command aimed at the wrong one silently does nothing to the UI
# being photographed.
CUR_USER="$(adb shell am get-current-user 2>/dev/null | tr -d '\r\n')"
case "$CUR_USER" in
  ''|*[!0-9]*) echo "am get-current-user did not answer a number; omitting --user"; USER_ARG="" ;;
  *) echo "current user: $CUR_USER"; USER_ARG="--user $CUR_USER" ;;
esac

APK="$(ls -1 "$ROOT"/native/automotive/build/outputs/apk/debug/*.apk 2>/dev/null | head -n 1)"
if [ -z "$APK" ]; then
  echo "::error::no automotive debug APK under native/automotive/build/outputs/apk/debug/ — did :automotive:assembleDebug run?"
  exit 1
fi
note "installing $APK"
adb install -r "$APK" || {
  echo "::error::adb install failed. With the shared applicationId ($PKG) this also fails when a differently-signed build of the phone app is already on the device."
  exit 1
}

# Installed for the SYSTEM user is not installed for the driver. `install-existing`
# is a no-op when it is already there.
if [ -n "$USER_ARG" ] && [ -z "$(adb shell pm path $USER_ARG "$PKG" 2>/dev/null | tr -d '\r')" ]; then
  echo "not installed for user $CUR_USER — installing existing package for that user"
  adb shell cmd package install-existing $USER_ARG "$PKG" || true
fi
echo "pm path: $(adb shell pm path $USER_ARG "$PKG" | tr -d '\r')"

# A head unit does not doze the way a watch does, but the shutter must never
# catch a blanked screen.
adb shell svc power stayon true || true
adb shell settings put system screen_off_timeout 1800000 || true
adb shell wm dismiss-keyguard || true
# media3 promotes the library service to the foreground with a media
# notification; ungranted, the notification is dropped on API 33+ and the
# capture runs a degraded path.
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

shoot() {
  local name="$1"
  local path="$OUT/${PROFILE}-${name}.png"
  adb exec-out screencap -p > "$path"
  if [ -s "$path" ]; then
    echo "captured ${PROFILE}-${name}.png ($(wc -c < "$path") bytes)"
  else
    fail "${PROFILE}-${name}.png is empty — screencap produced nothing"
  fi
}

# The view hierarchy of whatever is on screen, saved next to the screenshots: a
# tap that missed is unreadable without it, and it is the only evidence of what
# the Media Center actually drew.
dump_ui() {
  local name="$1"
  local local_xml="$OUT/${PROFILE}-${name}-ui.xml"
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
  adb exec-out cat /sdcard/ui.xml > "$local_xml" 2>/dev/null || return 1
  [ -s "$local_xml" ] || return 1
  echo "$local_xml"
}

# Tap the on-screen node whose text or content-desc contains $2, using the dump
# named $1. The car draws browse itself, so its rows are ordinary Views with
# real text — this is how the rig reads the tree it is photographing instead of
# guessing at coordinates. Returns non-zero when the label is not on screen.
tap_text() {
  local name="$1" label="$2"
  local xml
  xml="$(dump_ui "$name")" || { echo "uiautomator dump failed for '$label'"; return 1; }
  local coords
  coords="$(python3 - "$xml" "$label" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

path, label = sys.argv[1], sys.argv[2].lower()
try:
    root = ET.parse(path).getroot()
except Exception as exc:  # a truncated dump is a miss, not a crash
    print("parse failed: %s" % exc, file=sys.stderr)
    raise SystemExit(1)

best = None
for node in root.iter("node"):
    haystack = "%s %s" % (node.get("text") or "", node.get("content-desc") or "")
    if label not in haystack.lower():
        continue
    bounds = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds") or "")
    if not bounds:
        continue
    x1, y1, x2, y2 = (int(v) for v in bounds.groups())
    area = (x2 - x1) * (y2 - y1)
    if area <= 0:
        continue
    # Smallest match wins: the label's own row, not the scroll container that
    # happens to contain it.
    if best is None or area < best[2]:
        best = ((x1 + x2) // 2, (y1 + y2) // 2, area)

if best is None:
    raise SystemExit(2)
print(best[0], best[1])
PY
  )" || { echo "no on-screen node matching '$label' (see $xml)"; return 1; }
  echo "tapping '$label' at $coords"
  adb shell input tap $coords
}

# `am` returns 0 even when nothing started; the output is the only signal.
am_start() {
  local out
  out="$(adb shell am start $USER_ARG "$@" 2>&1 | tr -d '\r')"
  echo "$out"
  case "$out" in
    *Error*|*"does not exist"*|*"Activity not started"*|*Exception*) return 1 ;;
  esac
  return 0
}

vhal() {
  local prop="$1" value="$2"
  echo "inject-vhal-event $prop $value"
  adb shell cmd car_service inject-vhal-event "$prop" "$value" 2>&1 | tr -d '\r'
}

resumed_activities() {
  adb shell dumpsys activity activities 2>/dev/null \
    | grep -iE "topResumedActivity|mResumedActivity|ResumedActivity" \
    | tr -d '\r'
}

# ---------------------------------------------------------------------------
# 1. sign the car in, without touching the sign-in form
# ---------------------------------------------------------------------------
# `am broadcast` blocks until the receiver finishes and prints its result code,
# and DebugSeed sets 1 only after the DataStore write has landed (it uses
# goAsync for exactly this). So "result=1" means the creds are on disk BEFORE
# the Media Center opens — no sleep-and-hope.
#
# --include-stopped-packages is not optional: a freshly installed app is in the
# STOPPED state, and broadcasts do not reach a stopped package without it. This
# is the single most likely thing to be wrong on a first run, which is why the
# result code is asserted rather than assumed.
#
# Values carry LITERAL single quotes for the DEVICE's shell — the wear rig
# documents the same trap: `adb shell` concatenates its arguments and hands the
# string to sh on the other side, so "The Salt Road" would arrive as three
# arguments and the extras after it would be swallowed.
note "seeding credentials via the debug receiver"
SEED_OUT="$(adb shell am broadcast $USER_ARG \
  --include-stopped-packages \
  -n "$SEED_RECEIVER" \
  --es debug_abs_server "'$SERVER'" \
  --es debug_abs_token "'$TOKEN'" \
  --es debug_abs_user_id "'$USER_ID'" \
  --es debug_abs_username "'$USERNAME'" \
  --es debug_last_item "'$LAST_ITEM'" \
  --es debug_last_title "'$LAST_TITLE'" \
  --es debug_last_author "'$LAST_AUTHOR'" 2>&1 | tr -d '\r')"
echo "$SEED_OUT"
case "$SEED_OUT" in
  *"result=1"*)
    echo "credentials seeded"
    ;;
  *)
    fail "DebugSeed did not report result=1. Assumptions: the debug APK carries src/debug's receiver (\`$SEED_RECEIVER\`), the build is debuggable (FLAG_DEBUGGABLE gates the write), and the broadcast reached a stopped package. Everything below will photograph a signed-out car."
    ;;
esac

# ---------------------------------------------------------------------------
# 2. browse root, through the car's Media Center
# ---------------------------------------------------------------------------
# The component value is single-quoted for the device shell for the reason the
# seed block above gives — it has no spaces today, but it is the one string a
# reader is most likely to copy into an experiment that does.
note "opening the Media Center at $MEDIA_SERVICE"
if am_start -a "$MEDIA_TEMPLATE_ACTION" --es "$EXTRA_MEDIA_COMPONENT" "'$MEDIA_SERVICE'"; then
  echo "opened with $MEDIA_TEMPLATE_ACTION"
elif am_start -a "$MEDIA_TEMPLATE_V2_ACTION" --es "$EXTRA_MEDIA_COMPONENT" "'$MEDIA_SERVICE'"; then
  echo "::warning::V1 MEDIA_TEMPLATE did not resolve; used $MEDIA_TEMPLATE_V2_ACTION"
elif am_start -n "$MEDIA_CENTER_FALLBACK"; then
  fail "neither MEDIA_TEMPLATE action resolved; fell back to $MEDIA_CENTER_FALLBACK, which opens whatever media app the car last selected — the browse shots may not be TomeSonic's. Assumption that broke: this image's Media Center answers the documented intent."
else
  fail "no Media Center could be opened (tried $MEDIA_TEMPLATE_ACTION, $MEDIA_TEMPLATE_V2_ACTION and $MEDIA_CENTER_FALLBACK). Nothing below this line is a browse screenshot."
fi
sleep "$BROWSE_SETTLE"
shoot browse-root

# ---------------------------------------------------------------------------
# 3. into a library, and into one of its categories
# ---------------------------------------------------------------------------
# Root -> "Libraries" -> "Audiobooks" -> "Recently Added". Every label here is
# drawn from BrowseTree.kt (the folder titles) or mock_abs.py (the library
# name), so a rename on either side shows up as a missed tap with a message
# naming the label.

# TO-CONFIRM: whether the Media Center lands on the browse root or on
# now-playing when it is handed a media component. If "Libraries" is not on
# screen, press a browse affordance once and re-shoot the root — that shot is
# the deliverable, so it must be the browse tree and not a player.
open_libraries() {
  tap_text browse-root "Libraries" && return 0
  echo "'Libraries' not on screen; trying a 'Browse' affordance first"
  tap_text browse-root "Browse" || return 1
  sleep "$NAV_SETTLE"
  shoot browse-root
  tap_text browse-root "Libraries"
}

note "browse: Libraries"
if open_libraries; then
  sleep "$NAV_SETTLE"
  shoot browse-libraries
else
  fail "could not tap 'Libraries' on the browse root — either the tree did not render (signed out? mock server unreachable from 10.0.2.2?) or the Media Center draws its rows without text nodes on this image."
fi

note "browse: $BOOK_LIBRARY_NAME"
if tap_text browse-libraries "$BOOK_LIBRARY_NAME"; then
  sleep "$NAV_SETTLE"
  shoot browse-library
else
  fail "could not tap the '$BOOK_LIBRARY_NAME' library — mock_abs.py serves it as lib_books; check the mock server log for /api/libraries."
fi

note "browse: Recently Added"
if tap_text browse-library "Recently Added"; then
  sleep "$BROWSE_SETTLE"
  shoot browse-books
else
  fail "could not tap 'Recently Added' inside the library — BrowseTree.libraryCategories draws it for a BOOK library; a podcast library would show a grid of shows instead."
fi

# ---------------------------------------------------------------------------
# 4. the parked-only screens
# ---------------------------------------------------------------------------
# Started directly by component, which is legitimate: both are exported, and
# both are reached from OUTSIDE the app in production too (the Media Center's
# sign-in affordance, the car's Settings). The car is PARKED here — nothing was
# injected yet, and a fresh emulator boots parked.
note "sign-in (parked)"
if am_start -n "$SIGN_IN_ACTIVITY"; then
  sleep "$SETTLE"
  shoot sign-in
else
  fail "SignInActivity would not start while parked — it is exported in src/main's manifest; check the manifest merge and the install."
fi

note "settings (parked)"
if am_start -n "$SETTINGS_ACTIVITY"; then
  sleep "$SETTLE"
  shoot settings
else
  echo "::warning::SettingsActivity would not start; continuing (not a required capture)"
fi

# ---------------------------------------------------------------------------
# 5. VHAL smoke — PE-1 evidence, not decoration
# ---------------------------------------------------------------------------
# "No functionality outside setup/sign-in/settings while parked" is satisfied by
# construction (those are the only activities), and the OTHER half — that those
# two are unavailable while DRIVING — is the platform's job: neither activity
# declares `distractionOptimized` (declaring it is a documented review
# rejection), so the system withholds them. This step is the evidence.
note "VHAL: check-fake-vhal"
adb shell cmd car_service check-fake-vhal 2>&1 | tr -d '\r' || true

# HOME first: the settings screen from the previous step is ALSO parked-only, so
# leaving it in the foreground makes the "blocked" screenshot ambiguous — is the
# system showing its blocking screen, or just the last activity? Starting from
# the car's launcher, whatever appears next is the answer.
adb shell input keyevent KEYCODE_HOME || true
sleep 2

note "VHAL: simulate driving (speed $DRIVING_SPEED m/s, gear DRIVE)"
VHAL_OUT="$( { vhal "$PROP_VEHICLE_SPEED" "$DRIVING_SPEED"; vhal "$PROP_GEAR_SELECTION" "$GEAR_DRIVE"; } 2>&1 )"
echo "$VHAL_OUT"
case "$VHAL_OUT" in
  *"Unknown command"*|*"Exception"*|*"Permission"*|*"not supported"*)
    fail "inject-vhal-event was refused: $VHAL_OUT — the driving-state half of the smoke test proves nothing on this image. Assumption that broke: \`cmd car_service inject-vhal-event <decimal prop> <value>\` is available to the shell user here."
    ;;
esac
sleep 4

note "attempting SignInActivity while driving (it should NOT come to the front)"
adb shell am start $USER_ARG -n "$SIGN_IN_ACTIVITY" 2>&1 | tr -d '\r'
sleep "$SETTLE"
shoot driving-blocked
RESUMED="$(resumed_activities)"
echo "resumed: $RESUMED"
if [ -z "$RESUMED" ]; then
  # An empty read is NOT evidence of anything — say so rather than let silence
  # read as a pass.
  echo "::warning::dumpsys reported no resumed activity at all; ${PROFILE}-driving-blocked.png stands on its own and proves nothing by itself"
elif echo "$RESUMED" | grep -q "SignInActivity"; then
  # NOT a failure: a generic system image without the car UX-restriction
  # enforcement is a fact about the image, not about this app. It is loud
  # because a reviewer reading the artifact must not mistake it for evidence.
  echo "::warning::SignInActivity IS resumed while driving on this image — no parked-only enforcement here, so ${PROFILE}-driving-blocked.png is NOT PE-1 evidence. Re-check on an image whose CarUxRestrictions are active."
else
  echo "PE-1 evidence: SignInActivity is not the resumed activity while driving"
fi

note "VHAL: restore parked (gear PARK, speed 0)"
vhal "$PROP_GEAR_SELECTION" "$GEAR_PARK"
vhal "$PROP_VEHICLE_SPEED" 0
sleep 2
echo "resumed after restore: $(resumed_activities)"

# ---------------------------------------------------------------------------
# evidence
# ---------------------------------------------------------------------------
note "logcat"
adb logcat -d -t 2000 > "$OUT/${PROFILE}-logcat.txt" 2>&1 || true
# The tags that explain an empty browse tree: the tree itself, the HTTP client,
# the media session, and the seed that was supposed to sign the car in.
grep -E "BrowseTree|AbsClient|AbsLibraryService|DebugSeed" "$OUT/${PROFILE}-logcat.txt" \
  | tail -n 40 || true

note "captured"
ls -l "$OUT"

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo
  echo "== ${#FAILURES[@]} assumption(s) broke =="
  for f in "${FAILURES[@]}"; do echo " - $f"; done
  echo "Screenshots and logs above are still uploaded; fix the assumption, not the symptom."
  exit 1
fi

echo "all captures produced"
