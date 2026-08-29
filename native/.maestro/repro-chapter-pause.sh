#!/usr/bin/env bash
# CI entrypoint for the chapter-pause REPRO (see repro/chapter-pause.yaml) —
# a single line from reactivecircus/android-emulator-runner, same constraint
# as ci-flows.sh (the action runs each inline line in its own shell).
#
# Deliberately NOT part of ci-flows.sh: this is a diagnostic rig dispatched
# by hand while the bug is being pinned down, not a gate.
#
# EVIDENCE GOES TO STDOUT, not artifacts: the action kills the emulator the
# moment this script exits non-zero (so a post-step logcat reads an empty
# device), and artifact downloads are blocked from the diagnosing session's
# network. Everything needed to act on a failure — filtered logcat, the
# Maestro debug dir, view-hierarchy tails — is printed here, INSIDE the step,
# while the emulator is still alive.
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

maestro test .maestro/repro/chapter-pause.yaml
rc=$?

echo "==================== repro evidence (exit $rc) ===================="
echo "-------------------- player logcat (filtered) ---------------------"
adb logcat -d 2>/dev/null \
  | grep -iE "ExoPlayer|TrackPlayer|CONSOLE|ReactNativeJS|AndroidRuntime|FATAL|PlaybackStore" \
  | tail -300
echo "-------------------- maestro debug files --------------------------"
find "$HOME/.maestro/tests" -type f 2>/dev/null | sort
# The newest test dir holds the failure's command trace and (when Maestro
# saved one) the view hierarchy — the caption region's ACTUAL text lives
# there. Tail-bounded so a giant hierarchy can't drown the log.
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
