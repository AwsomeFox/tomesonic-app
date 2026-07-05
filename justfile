# Top-level justfile for React Native app versioning and Android Auto development

ADB_CMD := "adb"
DHU_SCRIPT := "~/Library/Android/sdk/extras/google/auto/desktop-head-unit"
DHU_PORT := "5277"
APP_ID := "com.tomesonic.app"

# ---------------------------
# Android Auto tasks
# ---------------------------
stop-forward:
	@sh -lc 'set -euo pipefail; ADB="{{ADB_CMD}}"; if ! command -v "$ADB" >/dev/null 2>&1; then echo "adb not found at $ADB" 1>&2; exit 1; fi; echo "Removing forward tcp:{{DHU_PORT}}"; "$ADB" forward --remove tcp:{{DHU_PORT}} || true; echo "Removed forward (if it existed)"'

adb-forward:
	adb forward tcp:{{DHU_PORT}} tcp:{{DHU_PORT}}

run-aa: adb-forward
	@echo "Launching Android Auto DHU..."
	@exec {{DHU_SCRIPT}}

# Show current version
version:
	@node -e "console.log(require('./native/package.json').version)"

# Sync version from native/package.json to Android build.gradle
sync-version:
	@echo "Syncing version from native/package.json to native/android/app/build.gradle"
	@node -e "const pkg = require('./native/package.json'); const fs = require('fs'); const gradlePath = './native/android/app/build.gradle'; let gradle = fs.readFileSync(gradlePath, 'utf8'); const version = pkg.version.replace(/-beta.*|-alpha.*|-rc.*/, ''); const parts = version.split('.').map(Number); const versionCode = parts[0] * 10000 + parts[1] * 100 + parts[2]; gradle = gradle.replace(/versionCode \\d+/, 'versionCode ' + versionCode); gradle = gradle.replace(/versionName \\\"[^\\\"]*\\\"/, 'versionName \\\"' + pkg.version + '\\\"'); fs.writeFileSync(gradlePath, gradle); console.log('✓ Synced version', pkg.version, 'and versionCode', versionCode, 'to native/android/app/build.gradle');"

# Set specific version
bump-version VERSION:
	@echo "Bumping version to {{VERSION}}"
	@cd native && npm version {{VERSION}} --no-git-tag-version
	@just sync-version
	@echo "Version bumped to {{VERSION}} in native/package.json and native/android/app/build.gradle"

# Bump patch version
bump-patch:
	@just bump-version patch

# Bump minor version
bump-minor:
	@just bump-version minor

# Bump major version
bump-major:
	@just bump-version major

# Bump prerelease version
bump-prerelease:
	@just bump-version prerelease

# Bump to next beta version (e.g., 1.0.0 -> 1.0.1-beta)
bump-beta:
	@node -e "const pkg = require('./native/package.json'); const v = pkg.version; const parts = v.split('.'); if (v.includes('-beta')) { parts[2] = parts[2].split('-')[0]; parts[2] = String(parseInt(parts[2]) + 1); } else { parts[2] = String(parseInt(parts[2]) + 1); } console.log(parts.join('.') + '-beta');" | xargs -I {} just bump-version {}

# Remove beta suffix
release:
	@node -e "const pkg = require('./native/package.json'); console.log(pkg.version.replace('-beta', ''));" | xargs -I {} just bump-version {}

# ---------------------------
# Android Development & Build tasks
# ---------------------------
EMULATOR_AVD := "Pixel_9a"
EMULATOR_BIN := "~/Library/Android/sdk/emulator/emulator"

# Start the Pixel 9a emulator in the background
emulator:
	@echo "Starting emulator {{EMULATOR_AVD}}..."
	@nohup {{EMULATOR_BIN}} -avd {{EMULATOR_AVD}} > /dev/null 2>&1 &
	@echo "Emulator launched in background. Waiting for device boot..."
	@adb wait-for-device
	@echo "✓ Emulator is ready!"

# Build the production release APK from scratch
build-release:
	@echo "Building production release APK..."
	@cd native/android && ./gradlew assembleRelease

# Install the production release APK onto the connected device/emulator
install-release:
	@echo "Installing production release APK ({{APP_ID}})..."
	@adb install -r native/android/app/build/outputs/apk/release/app-release.apk
	@echo "✓ APK installed successfully."

# Install and launch the production release APK directly
run-app: install-release
	@echo "Launching main screen of {{APP_ID}}..."
	@adb shell am start -n {{APP_ID}}/.MainActivity

# Build, install, and launch the release APK on phone or emulator
build-and-run: build-release run-app

# Clean the Android build directories (resolves C++ build out-of-sync caching)
clean-android:
	@echo "Deleting gradle and CMake native build caches..."
	@rm -rf native/android/app/build native/android/build native/android/app/.cxx
	@echo "✓ Caches cleared."

# Full native Android rebuild after dependency/config changes
full-rebuild: clean-android
	@echo "Running Expo Android prebuild (clean) and rebuilding app..."
	@cd native && npx expo prebuild --clean --platform android
	@cd native && npx expo run:android

# Start Metro bundler (Expo dev server)
start:
	@echo "Starting Metro bundler..."
	@cd native && npx expo start

# Build and run the app in debug/development mode using Expo CLI
run-dev:
	@echo "Running app in development mode on device/emulator..."
	@cd native && npx expo run:android

