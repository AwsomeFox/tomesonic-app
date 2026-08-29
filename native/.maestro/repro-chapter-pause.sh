#!/usr/bin/env bash
# CI entrypoint for the chapter-pause REPRO (see repro/chapter-pause.yaml) —
# a single line from reactivecircus/android-emulator-runner, same constraint
# as ci-flows.sh (the action runs each inline line in its own shell).
#
# Deliberately NOT part of ci-flows.sh: this is a diagnostic rig dispatched
# by hand while the bug is being pinned down, not a gate.
set -euo pipefail

export PATH="$PATH:$HOME/.maestro/bin"
cd "$(dirname "$0")/.." # native/

adb install android/app/build/outputs/apk/release/app-release.apk

maestro test .maestro/flows/10-login.yaml \
  -e SERVER_URL=http://10.0.2.2:13378 -e ABS_USER=root -e ABS_PASS=testpass

# Clean slate so the post-run dump holds ONLY the repro window — the
# ExoPlayer/RNTP lines around each boundary are the evidence this rig exists
# to capture (state transitions, discontinuities, errors).
adb logcat -c || true

maestro test .maestro/repro/chapter-pause.yaml
