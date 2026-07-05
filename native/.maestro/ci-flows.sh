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
maestro test .maestro/flows/30-search.yaml -e SEARCH_QUERY=test
maestro test .maestro/flows/40-library-series.yaml
maestro test .maestro/flows/50-downloads-settings.yaml
