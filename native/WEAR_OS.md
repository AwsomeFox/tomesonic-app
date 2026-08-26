# Wear OS app — exploration & implementation plan

Goal: a watch app for **basic browsing, playback, and downloads** — pick a book on the
watch, stream it or play a downloaded copy phone-free (runs, commutes, chores), with
progress syncing through the ABS server like every other client.

This file is the plan and the why. The **implementation contract** is
`native/wear/ARCHITECTURE.md` — where it and this plan disagree, the contract wins.
The **release runbook** (Play Console form factor, wear screenshots, review, how the
two AABs ship together) is `PLAY_STORE_WEAR.md` at the repo root.

## What already works today (no code)

Wear OS bridges the phone's media notification: while the phone app is playing, a
paired watch already shows play/pause/seek for the RNTP Media3 session. What does
NOT exist without a watch app: browsing the library from the wrist, playback with
the phone left at home, and on-watch downloads. Unlike Android Auto, Wear has **no
system browser UI** for a phone `MediaLibraryService` — the browse tree that
`patches/react-native-track-player+5.0.0-alpha0.patch` exposes to Auto is invisible
to the watch. A watch app is a separate native app.

## The non-negotiable: it's a native Kotlin app, not RN

React Native does not run on Wear OS (no RN Wear target; JS runtime + RN overhead is
a non-starter on watch hardware). The watch app is **Kotlin + Compose for Wear OS**,
sharing *zero UI code* with `native/` — what it shares is the **ABS REST surface and
the media-id/session conventions** that are already implemented twice (JS in
`utils/abs/*`, Kotlin inside the RNTP patch).

Stack: Compose for Wear OS (`androidx.wear.compose:compose-material3` — dynamic
theming from the watch face, the wrist-native sibling of our Material You identity) +
**Horologist** (`media-ui`, `media3-backend`, `media-data`, `audio-ui`) + Media3
ExoPlayer. Horologist's media toolkit is purpose-built for exactly this app shape:
`PlayerScreen`, browse screens, rotary volume, audio-output switching (BT headset vs
speaker), audio-offload battery management, and a Media3 `DownloadService`
integration. `minSdk 30` (Wear OS 3+; Galaxy Watch4+, all Pixel Watches).

## Where the code lives (the prebuild wrinkle)

`native/android` is committed and CI builds it directly (`deploy-playstore.yml` /
`build-apk.yml` run gradle straight, no prebuild), but `just prebuild` runs
`expo prebuild --clean`, which **deletes and regenerates `native/android`**. So:

- The wear module lives **outside** the regenerated tree: **`native/wear/`**
  (sibling of `android/`), a plain Android application module.
- A tiny config plugin (`plugins/withWearApp.js`) appends to `settings.gradle` via
  `withSettingsGradle`:
  ```gradle
  include ':wear'
  project(':wear').projectDir = new File(rootDir, '../wear')
  ```
  and (belt-and-braces) the same line is committed in `android/settings.gradle`.
  Either path survives a `--clean` prebuild.
- The wear module manages its own AGP/Kotlin/Compose config; it does not touch the
  RN/Expo gradle plumbing beyond being included in the same build.

## Auth: getting credentials onto the watch

The exact problem the Auto service solved (JS mirrors `{server, token, refreshToken}`
to `filesDir/auto_creds.json`, native reads it and even self-refreshes against
`/auth/refresh` — see the patch) — but across devices, so a file can't carry it.

**v1 — phone mirrors creds over the Wearable Data Layer.**
- Phone side: a small `WearBridgeModule` (Kotlin, `com.tomesonic.app.wear/`, same
  committed-source pattern as `widget/`) + `play-services-wearable`. It
  `DataClient.putDataItem`s the same payload `utils/autoCreds.ts` writes, called from
  the same two places that write `auto_creds.json`: login and
  `applyRefreshedTokens` (`utils/api.ts`). DataItems sync opportunistically, so the
  watch gets the newest token whenever it next sees the phone.
- **Do NOT ship the refresh token to the watch.** ABS rotates refresh tokens
  (`utils/api.ts` documents the stranding hazard); phone and watch racing
  `/auth/refresh` on one session would log each other out. v1 mirrors the **access
  token only**: streaming/browse work while it's valid, downloaded books play
  regardless, and offline progress queues (below) until the next sync. That was
  v1 (`standalone` = false).
- v2 (SHIPPED) — **watch-owned session**: on-watch login (three-step RemoteInput:
  server, username, password) gives the watch its own token pair and a
  single-flight `/auth/refresh` port (see `data/RefreshPolicy.kt`); phone
  mirroring stays the primary path and its credentials take precedence.
  `standalone` = **true**. OIDC/remote-auth remains future work.

## Browse

Same tree, same endpoints, third client. The RNTP patch already contains a complete,
battle-tested native Kotlin ABS read path (`absGet` + creds handling + tree assembly,
~1.5k lines): `/api/libraries`, `/api/libraries/{id}/items?minified=1`,
`/api/libraries/{id}/personalized`, `/api/me/items-in-progress`,
`/api/libraries/{id}/search`. **Port/copy that code into the wear module** (it lives
in a node_modules patch, so it can't be depended on directly; extraction into a
shared `:abs-core` gradle module both apps consume is a later refactor, not a v1
prerequisite).

Watch IA (screens, `ScalingLazyColumn`/Horologist `EntityScreen`):
1. **Continue Listening** (launch screen — the 90% case is "resume my book")
2. **Downloads** (on-watch copies)
3. **Libraries → items** (covers via `/api/items/{id}/cover`, downsampled hard)
4. Search later, if ever — voice input on watch, low value for v1.

Keep the `play:<itemId>[::<episodeId>][@@<bookmarkSeconds>]` media-id grammar from
the patch (`utils/playMediaId.ts` mirrors it in JS) so IDs mean the same thing in
every client and tests can be shared conceptually.

## Playback

Media3 ExoPlayer inside a Horologist `media3-backend` playback service (its own
MediaSession → watch media controls, Ongoing Activity chip):
- Start: `POST /api/items/{id}/play[/{episodeId}]` with its **own deviceInfo**
  (`clientName: "TomeSonic Wear"`, own deviceId) so ABS tracks watch sessions/stats
  distinctly. Direct-play the returned track URLs (token in query/header as
  `usePlaybackStore.ts` does); HLS transcode fallback comes free from the same
  session response.
- Progress: `POST /api/session/{id}/sync` on a tick while online. Offline (downloaded
  playback mid-run): accumulate a **local session** and flush to
  `POST /api/session/local` on reconnect — identical semantics to
  `utils/progressSync.ts`'s offline queue, so server-side merge behavior is already
  proven.
- Chapters: session response carries chapters; port the small `chapterMath.ts`
  offset math for chapter skip/display. Speed control ±; sleep timer is polish.
- Battery: enable Media3 **audio offload** (Horologist manages it) — the difference
  between a 1-hour and a multi-hour listening session on watch. Output switching
  (BT headphones first, speaker allowed — spoken word) via Horologist `audio-ui`.

## Downloads

- Per-track downloads, same files the phone downloader grabs
  (`track.contentUrl` / `/api/items/{id}/file/{ino}` — `utils/downloader.ts`), via
  Media3 `DownloadService`/WorkManager with **charger + Wi-Fi as the default
  constraint** (BT-proxied network is too slow and hot for bulk transfer; make the
  constraint overridable).
- Keep a local index equivalent to `auto_downloads.json` (`{tracks:[{filename,
  startOffset, duration}], currentTime, ...}` — `utils/autoCreds.ts` types) so
  offline browse/resume works with the same shape the Auto offline path uses.
- Reality check on space: watches have 8–32 GB shared; a single-file m4b rip can be
  0.5–1 GB+ and per-track books arrive at original quality (ABS has no
  transcode-for-download endpoint). UI must show per-book size before download and
  total usage, with easy eviction. "Download next N hours only" is not possible for
  single-file books — say so in the UI rather than faking it.
- Optional phone-assist later (phone downloads + Data Layer `ChannelClient` transfer)
  — skip for v1; direct-from-server is simpler and works on Wi-Fi.

## Release plumbing

- Same `applicationId` (`com.tomesonic.app`), separate AAB. `deploy-playstore.yml`
  adds `./gradlew :wear:bundleRelease` (same upload keystore via the existing
  `-PMYAPP_UPLOAD_*` props) and hands both AABs to `r0adkll/upload-google-play`
  (`releaseFiles` takes multiple paths).
- **Distinct versionCode range** so the two AABs never collide: wear =
  `1_000_000 + phone versionCode` (e.g. 1020148), extend the root `sync-version`
  script.
- Play Console: enroll the app in the **Wear OS form factor**, wear screenshots
  (round), pass Wear media-app review. Watch manifest declares
  `<uses-feature android.hardware.type.watch/>` + the standalone flag (true
  since v2 — Play then also serves the app to untethered/iOS-paired watches,
  and Wear review checks it works without the phone; see Auth).
- CI tests: wear unit tests are plain Robolectric — add `:wear:testDebugUnitTest` to
  `android-unit-tests.yml`.

## Dev & testing

Wear emulator covers UI/browse/playback (it has audio out); pairing-dependent bits
(Data Layer creds) can be tested phone-emu↔wear-emu paired, but build a debug-only
"inject creds" path (adb intent extra writing the same store) exactly like
`auto_creds.json` made Auto debuggable. Physical watch needed for battery, BT audio,
and offload validation.

## Phasing (rough, focused effort)

| Phase | Scope | Effort |
|---|---|---|
| 1 | Module scaffold, settings.gradle plugin, CI builds a wear AAB | 1–2 days |
| 2 | Data Layer creds mirror (phone module + watch receipt) | 2–4 days |
| 3 | Browse (Continue/Libraries) + streaming player + session sync | 1.5–2 wks |
| 4 | Downloads + offline playback + offline progress queue | ~1 wk |
| 5 | Polish: Ongoing Activity, tile ("Resume"), complication, rotary, speed, Play listing/review | ~1 wk |

v1 (phases 1–4) ≈ **4–5 focused weeks**; a stream-only demo (1–3) in ~2.5.

## Status

- [x] Exploration / this plan
- [x] Phase 1 — `native/wear/` scaffold + `withWearApp.js` + CI (wear AAB in
      `deploy-playstore.yml`, wear APK in `build-apk.yml` / `github-releases.yml`,
      `:wear:testDebugUnitTest` in `android-unit-tests.yml`)
- [x] Phase 2 — creds over Data Layer (access token only; no refresh-token sharing):
      phone `WearBridgeModule` + watch `DataLayerListenerService`/`CredsRepository`
- [x] Core data — `AbsClient` / `AbsApi` / `Models` / `ChapterMath` + JVM tests
- [ ] Phase 3 — browse + streaming playback + progress sync — **this PR**
- [ ] Phase 4 — downloads + offline — **this PR**
- [ ] Phase 4A — Wear Compose UI (home / item / player / downloads / settings /
      connect) — **this PR**
- [ ] Phase 5 — polish + Play form-factor enrollment — not started. Console steps
      are written up in `PLAY_STORE_WEAR.md`; nothing has been submitted to Play yet.

Reality check on the phasing table above: the version stamping worked out simpler
than planned — `native/wear/build.gradle` derives its versionCode/versionName from
`android/app/build.gradle` at configure time, so `sync-version` needed no change.
