#!/usr/bin/env bash
# CI entrypoint for the Doze suite — invoked as a SINGLE line from
# reactivecircus/android-emulator-runner (which runs each script line in its own
# shell, so exports/cd don't survive across lines).
#
# NON-BLOCKING / nightly only. This interleaves adb + Maestro because Maestro
# can't run adb: each scenario starts a real playback session with a Maestro
# flow, the shell then drops the emulator into deep Doze (dumpsys deviceidle
# force-idle), sleeps past the point of interest, lifts Doze (unforce + wake),
# and a second Maestro flow asserts the outcome. The two Maestro invocations
# are the SAME flow file run with -e PHASE=<start|arm>|assert.
set -euo pipefail

export PATH="$PATH:$HOME/.maestro/bin"
cd "$(dirname "$0")/.." # native/

adb install android/app/build/outputs/apk/release/app-release.apk

# Fresh-install login against the job's throwaway ABS (host = 10.0.2.2 from the
# emulator). The seeded library has an audiobook AND an ebook whose cards share
# the "<title> by <author>" label shape — pin the audio flows to the audiobook.
AUDIOBOOK='The Test Book by .*'
SERVER_URL='http://10.0.2.2:13378'

# Doze windows (minutes). Generous by design — this is nightly, not a PR gate.
# Overridable from the workflow if the emulator proves slow.
PLAYBACK_DOZE_MIN="${PLAYBACK_DOZE_MIN:-3}"
# Must exceed the armed sleep-timer preset (5 min) so the enforcer expires
# WHILE the device is force-idled.
SLEEPTIMER_DOZE_MIN="${SLEEPTIMER_DOZE_MIN:-6}"

# Generous retries: flaky emulator taps shouldn't fail a non-blocking job.
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge 3 ]; then
      echo "!! giving up after $n attempts: $*"
      return 1
    fi
    echo "!! retry $n: $*"
    sleep 5
  done
}

# force-idle is the CORE of the sandwich. battery unplug/reset is best-effort
# (deviceidle refuses to idle while "charging"); appops/screen-off are optional
# nudges — none are required for force-idle to take on the emulator.
doze_sandwich() {
  local mins="$1"
  echo "== entering Doze for ${mins} min =="
  adb shell dumpsys battery unplug || true          # optional: pretend unplugged
  adb shell input keyevent KEYCODE_SLEEP || true    # optional: screen off
  adb shell dumpsys deviceidle force-idle           # CORE: force deep Doze
  sleep "$((mins * 60))"
  adb shell dumpsys deviceidle unforce              # CORE: lift Doze
  adb shell dumpsys battery reset || true           # optional: restore battery
  adb shell input keyevent KEYCODE_WAKEUP           # wake the screen for Maestro
  echo "== exited Doze =="
}

retry maestro test .maestro/flows/10-login.yaml \
  -e SERVER_URL="$SERVER_URL" -e ABS_USER=root -e ABS_PASS=testpass

# ---- Scenario 1: an active playback session survives deep Doze ----
retry maestro test .maestro/flows/90-doze-playback.yaml -e BOOK="$AUDIOBOOK" -e PHASE=start
doze_sandwich "$PLAYBACK_DOZE_MIN"
retry maestro test .maestro/flows/90-doze-playback.yaml -e BOOK="$AUDIOBOOK" -e PHASE=assert

# ---- Scenario 2: the native sleep-timer enforcer fires under Doze ----
retry maestro test .maestro/flows/91-doze-sleep-timer.yaml -e BOOK="$AUDIOBOOK" -e PHASE=arm
doze_sandwich "$SLEEPTIMER_DOZE_MIN"
retry maestro test .maestro/flows/91-doze-sleep-timer.yaml -e BOOK="$AUDIOBOOK" -e PHASE=assert
