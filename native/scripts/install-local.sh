#!/usr/bin/env bash
# Build + install a side-by-side TEST build on a connected device:
#
#   - applicationId com.tomesonic.app.debug (via -PlocalTestBuild) so it
#     coexists with the Play-installed app — a local build can never UPDATE
#     the Play build anyway (Google's app-signing key vs our debug key).
#   - Launcher label "TomeSonic Debug".
#   - Launcher icon rotated 180° so the two apps are unmistakable side by side.
#
# The label/icon edits happen in the working tree for the duration of the
# build and are restored afterwards (trap) — nothing gets committed.
#
# Usage: scripts/install-local.sh [adb-device-serial]
set -euo pipefail

# macOS-only: the label edit relies on BSD `sed -i ''` and the icon rotation
# on `sips` — on Linux both fail with confusing errors, so bail out up front.
if [ "$(uname)" != "Darwin" ]; then
  echo "install-local.sh uses macOS-only tooling (BSD sed -i '', sips); run it on macOS or port those steps." >&2
  exit 1
fi
if ! command -v sips >/dev/null 2>&1; then
  echo "sips not found — it's the macOS built-in used to rotate the launcher icons." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

DEVICE="${1:-}"
RES=android/app/src/main/res
STRINGS="$RES/values/strings.xml"

restore() {
  git checkout -- "$RES" 2>/dev/null || true
  git clean -fdq "$RES" 2>/dev/null || true
}
trap restore EXIT

# 1. Distinct launcher label.
sed -i '' 's|<string name="app_name">TomeSonic</string>|<string name="app_name">TomeSonic Debug</string>|' "$STRINGS"

# 2. Rotate every launcher icon 180°. sips writes PNG data regardless of the
#    source format, so emit real .png files and drop the .webp originals —
#    same resource name, and AAPT is happy with either extension.
find "$RES" -name "ic_launcher*.webp" | while read -r f; do
  sips -r 180 -s format png "$f" --out "${f%.webp}.png" >/dev/null
  rm "$f"
done

# 3. Release build (real JS bundle) with the .debug applicationId suffix.
(
  cd android
  SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:assembleRelease -PlocalTestBuild=true
)

# 4. Install.
ADB=(adb)
[ -n "$DEVICE" ] && ADB=(adb -s "$DEVICE")
"${ADB[@]}" install -r android/app/build/outputs/apk/release/app-release.apk

echo
echo "Installed com.tomesonic.app.debug — look for the upside-down 'TomeSonic Debug' icon."
