#!/usr/bin/env bash
# CI entrypoint for the Maestro suite — invoked as a SINGLE line from
# reactivecircus/android-emulator-runner (which runs each script line in its
# own shell, so exports/cd don't survive across lines).
set -euo pipefail

export PATH="$PATH:$HOME/.maestro/bin"
cd "$(dirname "$0")/.." # native/

adb install android/app/build/outputs/apk/release/app-release.apk

# Fresh-install login against the job's throwaway ABS (host = 10.0.2.2 from
# the emulator), then the whole logged-in suite.
maestro test .maestro/flows/10-login.yaml \
  -e SERVER_URL=http://10.0.2.2:13378 -e ABS_USER=root -e ABS_PASS=testpass
maestro test .maestro/flows/00-launch.yaml
maestro test .maestro/flows/20-playback.yaml
maestro test .maestro/flows/22-chapters-sleep.yaml
maestro test .maestro/flows/30-search.yaml -e SEARCH_QUERY=test
maestro test .maestro/flows/40-library-series.yaml
maestro test .maestro/flows/50-downloads-settings.yaml
maestro test .maestro/flows/60-resume.yaml

# Offline: download the book, kill networking, verify the downloaded copy
# still plays, then restore connectivity (trap keeps later failures from
# leaving the emulator offline for debug-artifact collection).
maestro test .maestro/flows/70-download.yaml
restore_network() {
  adb shell svc wifi enable || true
  adb shell svc data enable || true
}
trap restore_network EXIT
adb shell svc wifi disable
adb shell svc data disable
maestro test .maestro/flows/71-offline.yaml
restore_network
trap - EXIT
