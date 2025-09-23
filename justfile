# Top-level justfile for repo convenience - delegates Android tasks to android/justfile
import 'android/justfile'
# Usage examples:
#   just android-info
#   just android-build
#   just android-install-debug
#   just android-dhu
#   just android-run
#   just android-logcat
#   just build-nuxt        # build Nuxt.js and sync Capacitor
#   just run-debug         # build Nuxt, sync, build and install debug APK
#   just run               # full workflow: build Nuxt, sync, build/install APK, start Android Auto
#   just build             # build the android app (assembleDebug)
#   just install-debug     # build and install debug APK onto connected device
#   just version           # show current version
#   just bump-beta         # bump to next beta version (e.g., 0.12.1-beta -> 0.12.2-beta)
#   just bump-patch        # bump patch version (note: removes -beta suffix)
#   just bump-minor        # bump minor version (note: removes -beta suffix)
#   just bump-major        # bump major version (note: removes -beta suffix)
#   just release           # remove -beta suffix for release
#   just sync-version      # sync version from package.json to Android
#   just bump-version "1.0.0-beta"  # set specific version

ANDROID_DIR := "android"

android-info:
	@sh -lc 'cd "${ANDROID_DIR}" && just info'

android-build:
	@sh -lc 'cd "${ANDROID_DIR}" && just build'

android-assemble-debug:
	@sh -lc 'cd "${ANDROID_DIR}" && just assemble-debug'

android-install-debug:
	@sh -lc 'cd "${ANDROID_DIR}" && just install-debug'

android-uninstall-debug:
	@sh -lc 'cd "${ANDROID_DIR}" && just uninstall-debug'

android-adb-forward:
	@sh -lc 'cd "${ANDROID_DIR}" && just adb-forward'

android-stop-forward:
	@sh -lc 'cd "${ANDROID_DIR}" && just stop-forward'

android-dhu:
	@sh -lc 'cd "${ANDROID_DIR}" && just dhu'

android-run:
	@sh -lc 'cd "${ANDROID_DIR}" && just run'

android-run-with-check:
	@sh -lc 'cd "${ANDROID_DIR}" && just run-with-check'

android-adb-reverse:
	@sh -lc 'cd "${ANDROID_DIR}" && just adb-reverse'

android-adb-reverse-remove:
	@sh -lc 'cd "${ANDROID_DIR}" && just adb-reverse-remove'

android-logcat:
	@sh -lc 'cd "${ANDROID_DIR}" && just logcat'

android-logcat-full:
	@sh -lc 'cd "${ANDROID_DIR}" && just logcat-full'

android-start-web:
	@sh -lc 'cd "${ANDROID_DIR}" && just start-web'

# Convenience aggregate
android-all:
	@sh -lc 'cd "${ANDROID_DIR}" && just info && just build'

# Version management
bump-version VERSION:
	@echo "Bumping version to {{VERSION}}"
	@npm version {{VERSION}} --no-git-tag-version
	@just sync-version
	@echo "Version bumped to {{VERSION}} in package.json and android/app/build.gradle"

sync-version:
	@echo "Syncing version from package.json to android/app/build.gradle"
	@node -e "const pkg = require('./package.json'); const fs = require('fs'); const gradlePath = './android/app/build.gradle'; let gradle = fs.readFileSync(gradlePath, 'utf8'); gradle = gradle.replace(/versionName \"[^\"]*\"/, 'versionName \"' + pkg.version + '\"'); fs.writeFileSync(gradlePath, gradle); console.log('✓ Synced version', pkg.version, 'to android/app/build.gradle');"

# Show current version
version:
	@node -e "console.log(require('./package.json').version)"

# Bump patch version (e.g., 0.12.1-beta -> 0.12.2-beta)
# Note: npm version patch on prerelease removes suffix, use bump-version for custom versions
bump-patch:
	@just bump-version patch

# Bump minor version (e.g., 0.12.1-beta -> 0.13.0-beta)
bump-minor:
	@just bump-version minor

# Bump major version (e.g., 0.12.1-beta -> 1.0.0-beta)
bump-major:
	@just bump-version major

# Bump prerelease version (e.g., 0.12.1-beta -> 0.12.1-beta.0 or 0.12.1-beta.0 -> 0.12.1-beta.1)
bump-prerelease:
	@just bump-version prerelease

# Bump to next beta version (e.g., 0.12.1-beta -> 0.12.2-beta)
bump-beta:
	@node -e "const pkg = require('./package.json'); const v = pkg.version; const parts = v.split('.'); if (v.includes('-beta')) { parts[2] = parts[2].split('-')[0]; parts[2] = String(parseInt(parts[2]) + 1); } else { parts[2] = String(parseInt(parts[2]) + 1); } console.log(parts.join('.') + '-beta');" | xargs -I {} just bump-version {}

# Remove beta suffix (e.g., 0.12.1-beta -> 0.12.1)
release:
	@node -e "const pkg = require('./package.json'); console.log(pkg.version.replace('-beta', ''));" | xargs -I {} just bump-version {}

