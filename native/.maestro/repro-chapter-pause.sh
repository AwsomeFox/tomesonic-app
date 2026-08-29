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

# POSITION TIMELINE: 2s samples of the media session's playback state while
# the flows run. Run 6 showed the chapter-clipped queue advancing ~10-15s
# into a 25s first chapter on EVERY run and stalling at a later boundary
# once, with zero ExoPlayer log output — whether the AUDIO POSITION jumps at
# the early flip (a structural queue disturbance skipping content) or runs
# continuously under a wrong caption (an index mapping bug) is exactly what
# this sampler decides. dumpsys media_session prints state=..., position=...
# for the active session.
(
  while true; do
    ts=$(date +%H:%M:%S)
    line=$(adb shell dumpsys media_session 2>/dev/null \
      | grep -E "state=PlaybackState" | head -1 | tr -s ' ')
    echo "POS $ts $line"
    sleep 2
  done
) &
SAMPLER_PID=$!

echo "########## dimension 1: foreground boundary crossings ##########"
maestro test .maestro/repro/chapter-pause.yaml || rc=$?

if [ "$rc" -eq 0 ]; then
  echo "########## dimension 2: boundary crossed under doze ##########"
  maestro test .maestro/repro/doze-boundary-start.yaml || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "== entering doze across the 25s chapter boundary =="
    adb shell dumpsys battery unplug || true      # deviceidle refuses while "charging"
    adb shell input keyevent KEYCODE_SLEEP || true # screen off, like a pocketed phone
    # deviceidle ships DISABLED on this emulator image: run 5's force-idle
    # answered "Unable to go deep idle; not enabled" — and because dumpsys
    # exits 0 even when it refuses, the leg green-passed without ever idling
    # (the uncaptured-failure hole Copilot flagged). Enable first, force, and
    # gate on the STATE READBACK — the only signal dumpsys can't fake.
    adb shell dumpsys deviceidle enable all || true
    adb shell dumpsys deviceidle force-idle || true
    deep=$(adb shell dumpsys deviceidle get deep | tr -d '[:space:]')
    echo "deviceidle deep state after force-idle: $deep"
    if [ "$deep" != "IDLE" ]; then
      echo "::error::doze sandwich never reached deep idle (state: $deep) — refusing to let the doze leg no-op-pass"
      rc=1
    else
      sleep 30
      adb shell dumpsys deviceidle unforce || true
      echo "deviceidle deep state after unforce: $(adb shell dumpsys deviceidle get deep | tr -d '[:space:]')"
      adb shell dumpsys battery reset || true
      adb shell input keyevent KEYCODE_WAKEUP
      echo "== exited doze =="
      maestro test .maestro/repro/doze-boundary-assert.yaml || rc=$?
    fi
  fi
fi

kill "$SAMPLER_PID" 2>/dev/null || true

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
  # The failure-step view hierarchies live one level down — the caption slot's
  # ACTUAL text at the moment an assert died is the answer to most "what did
  # the player show" questions, so extract just the caption-adjacent strings
  # instead of dumping whole trees.
  find "$latest" -path '*screen-hierarchy/*.json' -print | while read -r h; do
    echo "---------- caption region of: $h ----------"
    grep -oE '"(text|accessibilityText)":"[^"]{0,120}"' "$h" \
      | grep -iE "chapter|pause|play|of [0-9]" | sort -u | head -30
  done
fi
echo "==================== end repro evidence ============================"
exit $rc
