# TomeSonic App — Assistant Instructions

TomeSonic is a **React Native (Expo) Android app** — an AudiobookShelf client. All app code lives in `native/`; the repo root only holds Play Store assets, docs, and CI.

## Layout

- `native/screens/`, `native/components/` — UI (style objects, no className/NativeWind styling)
- `native/store/` — zustand stores; `usePlaybackStore` owns the playback session, progress sync, sleep timer, and cast routing
- `native/utils/` — api client (axios + token refresh), progress sync queues, downloader, MMKV storage
- `native/plugins/` — Expo config plugins that generate/patch the `native/android/` project
- `native/patches/` — patch-package patches (react-native-track-player Media3/Android Auto)
- `native/__tests__/` — jest + @testing-library/react-native suites; `native/.maestro/` — E2E flows

## Commands

```bash
cd native
npm install                # postinstall applies patches
npx expo run:android       # dev build
npm test                   # jest (see native/TESTING.md — RNTL v14 API is async)
npm run typecheck
```

Release build: `cd native/android && SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew app:assembleRelease -x lint -x test`

## Rules of thumb

- Expo SDK 57 / RN 0.86 / New Architecture — check https://docs.expo.dev/versions/v57.0.0/ before using Expo APIs.
- Progress correctness is the top product priority: audio progress syncs via play sessions; the ebook reader PATCHes ONLY `ebookLocation`/`ebookProgress` (never `progress`/`isFinished:false`); offline writes queue through `native/utils/progressSync.ts`.
- ABS library filter values are base64-encoded (`encodeFilterValue` in `components/FilterModal`).
- After `npx expo prebuild`, newly generated files under `native/android/` must be `git add -f`'d (gitignore blocks new files there).
- Give interactive elements stable `accessibilityLabel`s — Maestro E2E selectors depend on them.
