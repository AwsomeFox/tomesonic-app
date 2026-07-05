#!/usr/bin/env bash
# CI entrypoint for the Maestro suite (rev 2) — invoked as a SINGLE line from
# reactivecircus/android-emulator-runner (which runs each script line in its
# own shell, so exports/cd don't survive across lines).
set -euo pipefail

export PATH="$PATH:$HOME/.maestro/bin"
cd "$(dirname "$0")/.." # native/

adb install android/app/build/outputs/apk/release/app-release.apk

# Fresh-install login against the job's throwaway ABS (host = 10.0.2.2 from
# the emulator), then the whole logged-in suite.
# The seeded library has an audiobook AND an ebook whose cards share the
# "<title> by <author>" label shape — pin the audio flows to the audiobook.
AUDIOBOOK='The Test Book by .*'

maestro test .maestro/flows/10-login.yaml \
  -e SERVER_URL=http://10.0.2.2:13378 -e ABS_USER=root -e ABS_PASS=testpass
maestro test .maestro/flows/00-launch.yaml
maestro test .maestro/flows/20-playback.yaml -e BOOK="$AUDIOBOOK"
maestro test .maestro/flows/22-chapters-sleep.yaml -e BOOK="$AUDIOBOOK"
maestro test .maestro/flows/30-search.yaml -e SEARCH_QUERY=test
maestro test .maestro/flows/40-library-series.yaml
maestro test .maestro/flows/50-downloads-settings.yaml
maestro test .maestro/flows/60-resume.yaml -e BOOK="$AUDIOBOOK"

# Reader flow is NON-FATAL in CI (loud, not silent): the reader loads
# foliate-js from the jsdelivr CDN at read time (vendoring it offline is the
# open H2 task), so it depends on external network the sandboxed emulator
# can't guarantee. The 10 core flows above are the green gate; run this
# locally/on-demand where the CDN is reachable.
if maestro test .maestro/flows/80-reader.yaml -e EBOOK_ROW="Read The Test Ebook"; then
  echo "::notice::reader flow passed"
else
  echo "::warning::reader flow FAILED — likely the foliate-js CDN dependency (H2: vendor foliate-js offline). Not blocking the suite."
fi

# Offline: download the book, kill networking, verify the downloaded copy
# still plays, then restore connectivity (trap keeps later failures from
# leaving the emulator offline for debug-artifact collection).
maestro test .maestro/flows/70-download.yaml -e BOOK="$AUDIOBOOK"
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
