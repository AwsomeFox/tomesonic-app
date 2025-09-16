Android development notes — Audiobookshelf App

This README documents helpful steps for Android development in this workspace, including useful `just` recipes (see ./justfile) and integration hints for a Nuxt.js frontend served inside Capacitor.

Quickstart (prereqs)

- Install Android SDK and platform-tools.
  - macOS default SDK path used here: $HOME/Library/Android/sdk
- Java JDK (as required by Gradle)
- Node.js and npm/yarn for the Nuxt web frontend
- just (task runner) — optional but recommended: https://github.com/casey/just

Helpful just tasks

All recommended tasks are in android/justfile. Examples:

- just info
  - Shows environment variables and DHU binary detection

- just build
  - Runs Gradle assembleDebug

- just install-debug
  - Builds (if needed) and installs the debug APK to a connected device

- just uninstall-debug
  - Uninstalls the app package (configured via APP_ID)

- just adb-forward / just stop-forward
  - Forward the DHU TCP port (5277) to the ADB localabstract socket used by the Desktop Head Unit

- just dhu
  - Locate and execute the Android Auto Desktop Head Unit binary in your SDK extras dir

- just run
  - Shorthand for setting the adb forward and launching DHU

- just adb-reverse / just adb-reverse-remove
  - Reverse host TCP port to device (useful to connect device WebView to a local dev server)

- just start-web
  - Will cd to repo root and run the configured web dev command (default: npm run dev). Run via dev-with-reverse to enable device <-> host connection.

- just logcat / just logcat-full
  - Tail filtered logcat for this app

Why these tasks?

- DHU (Desktop Head Unit) requires an ADB forward so the DHU on the desktop can reach the app's car-protocol endpoint on the device. `adb forward tcp:5277 localabstract:adb-hub` is the standard setup.
- During web development with Nuxt, you usually run a local dev server on port 3000. To let an Android device access that server inside its WebView, use `adb reverse tcp:3000 tcp:3000` or use emulator special addresses (10.0.2.2) depending on environment.

Nuxt.js + Capacitor integration notes

This project uses a Nuxt.js web frontend that is embedded in the Capacitor Android app. Use these steps to develop and integrate:

1. Configure dev server URL

- Option A — Local device/emulator (recommended for fast dev):
  - Start your Nuxt dev server on the host (e.g. port 3000):
    - npm run dev (from project root)
  - Reverse the host port to the device so the WebView can reach it:
    - just adb-reverse
  - Launch the app on your device/emulator (install-debug)
  - Capacitor's WebView will load http://localhost:3000 (depending on your capacitor configuration)

- Option B — Emulator using 10.0.2.2:
  - Start Nuxt dev server on host (port 3000)
  - In the app (or capacitor config), point dev server to http://10.0.2.2:3000
  - Launch app on emulator

2. Use capacitor commands to sync native project after web changes

- When you change native config or update plugins:
  - npx cap sync android
  - npx cap open android (to open Android Studio)

3. Building for production

- npm run build (nuxt) then npx cap copy android
- In android/: ./gradlew assembleRelease (or use Android Studio)

Capacitor dev-server convenience

- You can set capacitor.config.ts (or capacitor.config.json) devServer.url to the host URL used in development. When set, the native WebView will load that URL when the app runs, eliminating the need to re-bundle web assets on every change.

Example snippet (capacitor.config.ts):

  export default {
    appId: 'com.audiobookshelf.app',
    appName: 'Audiobookshelf',
    webDir: 'dist',
    server: {
      // dev-time only — point to your dev server
      url: 'http://10.0.2.2:3000',
      cleartext: true
    }
  }

Notes:
- When using server.url, remember to revert/remove it before production builds.
- Use adb reverse when testing on a physical device: `adb reverse tcp:3000 tcp:3000` so http://localhost:3000 resolves from device.

Android Auto / DHU dev tips

- Install the Android Auto DHU (Desktop Head Unit) from the SDK extras: ${HOME}/Library/Android/sdk/extras/google/auto/desktop-head-unit
- Use `just adb-forward` to forward the DHU port then `just dhu` (or `just run`) to open DHU.
- If DHU complains, ensure you have a compatible DHU binary (Linux/macOS binary may be inside `bin/` or called `desktop-head-unit`).

Common troubleshooting

- Gradle / JDK issues: open Android Studio and allow it to install required SDK platform packages.
- adb not found: set ANDROID_SDK_ROOT or ADB_CMD env vars in your shell or export before running just.
- WebView caching: clear app storage or uninstall-before-install when testing changes to the embedded web app.

Examples of typical dev flows

- Rapid web dev + physical device:
  1. just adb-reverse
  2. cd ../ (repo root) && npm run dev
  3. just install-debug
  4. Interact with the app on device; web reloads automatically

- Testing Android Auto integration locally:
  1. just adb-forward
  2. just run
  3. In the DHU UI, pair/launch the app simulation as directed

If you want, I can also:
- Add a sample capacitor.config.ts dev snippet into the repo
- Add a script to package.json to run `just dev-with-reverse` from repo root
- Detect your OS and automatically pick emulator 10.0.2.2 vs adb-reverse recommendations

---
File locations changed:
- android/justfile (updated)
- android/README.md (new)

If you'd like, I can run any of the just tasks here (adb forward, dhu, build, etc.) — tell me which one and I'll run it and report the output. Or I can add the additional automation items mentioned above.
