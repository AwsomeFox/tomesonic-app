#!/usr/bin/env bash
# CI entrypoint for the chapter-pause REPRO — a single line from
# reactivecircus/android-emulator-runner, same constraint as ci-flows.sh
# (the action runs each inline script line in its own shell).
#
# Deliberately NOT part of ci-flows.sh: this is a diagnostic rig dispatched
# by hand while the bug is being pinned down, not a gate.
#
# Two dimensions, in order:
#   1. chapter-pause.yaml   — FOREGROUND boundary crossings, both queue
#                             shapes, downloaded. Green since run 4; kept as
#                             the regression floor for the rig itself.
#   2. doze-boundary.yaml   — a boundary crossed while force-idled (the real
#                             listening condition), downloaded m4b. Maestro
#                             can't adb, so the doze sandwich lives here
#                             between the flow's start/assert phases
#                             (ci-doze.sh's pattern).
#
# EVIDENCE GOES TO STDOUT, not artifacts: the action kills the emulator the
# moment this script exits non-zero (a post-step logcat reads an empty
# device), and artifact downloads are blocked from the diagnosing session's
# network. Everything needed to act on a failure prints here, INSIDE the
# step, while the emulator is still alive.
set -uo pipefail

export PATH="$PATH:$HOME/.maestro/bin"
cd "$(dirname "$0")/.." # native/

set -e
adb install android/app/build/outputs/apk/release/app-release.apk

maestro test .maestro/flows/10-login.yaml \
  -e SERVER_URL=http://10.0.2.2:13378 -e ABS_USER=root -e ABS_PASS=testpass

# Clean slate so the dump below holds ONLY the repro window.
adb logcat -c || true
set +e

rc=0

echo "########## dimension 1: foreground boundary crossings ##########"
maestro test .maestro/repro/chapter-pause.yaml || rc=$?

if [ "$rc" -eq 0 ]; then
  echo "########## dimension 2: boundary crossed under doze ##########"
  maestro test .maestro/repro/doze-boundary.yaml -e PHASE=start || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "== entering doze across the 25s chapter boundary =="
    adb shell dumpsys battery unplug || true      # deviceidle refuses while "charging"
    adb shell input keyevent KEYCODE_SLEEP || true # screen off, like a pocketed phone
    adb shell dumpsys deviceidle force-idle
    sleep 30
    adb shell dumpsys deviceidle unforce
    adb shell dumpsys battery reset || true
    adb shell input keyevent KEYCODE_WAKEUP
    echo "== exited doze =="
    maestro test .maestro/repro/doze-boundary.yaml -e PHASE=assert || rc=$?
  fi
fi

echo "==================== repro evidence (exit $rc) ===================="
echo "-------------------- player logcat (filtered) ---------------------"
adb logcat -d 2>/dev/null \
  | grep -iE "ExoPlayer|TrackPlayer|CONSOLE|ReactNativeJS|AndroidRuntime|FATAL|PlaybackStore|deviceidle" \
  | tail -300
echo "-------------------- maestro debug files --------------------------"
find "$HOME/.maestro/tests" -type f 2>/dev/null | sort
latest=$(ls -td "$HOME"/.maestro/tests/*/ 2>/dev/null | head -1)
if [ -n "$latest" ]; then
  for f in "$latest"*.json "$latest"*.log; do
    [ -f "$f" ] || continue
    echo "---------- tail: $f ----------"
    tail -c 6000 "$f"
    echo
  done
fi
echo "==================== end repro evidence ============================"
exit $rc
