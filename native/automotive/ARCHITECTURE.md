# TomeSonic Automotive — implementation contract

The binding contract for the Android Automotive OS (AAOS) module. Where
`native/AUTOMOTIVE_OS.md` (the plan) and this file disagree, **this file wins**.
Structure and conventions deliberately mirror `native/wear/ARCHITECTURE.md` — the
wear module is the proven template for "a second native app in this repo", and
every deviation from its pattern is called out as such.

Provenance: seeded from the AAOS feasibility survey (2026-08), whose load-bearing
claims were re-verified against the repo (`MusicService.kt` line-level checks, the
`withAutoBrowseIcons.js` gap) and against developer.android.com
(`training/cars/media/automotive-os`, car-app quality guidelines).

---

## 1. Identity & pins

| Thing | Value | Why |
|---|---|---|
| Module | `native/automotive/` | Sibling of `android/` + `wear/` — `expo prebuild --clean` regenerates `native/android`, so the module must live outside it |
| Kotlin package | `com.tomesonic.app.automotive` | Mirrors `com.tomesonic.app.wear` |
| `applicationId` | `com.tomesonic.app` | Same app, same Play listing (Google's strong recommendation; matches wear) |
| `versionCode` | phone + `2_000_000` | Derived at configure time from `../android/app/build.gradle` — see §9. Phone 20154 → wear 1020154 → automotive 2020154; three monotonic, non-colliding ranges from one stamp |
| `versionName` | phone's, verbatim | Same derivation |
| `minSdk` | **28** | Documented: all AAOS cars run Android 9+ |
| `targetSdk` | **35, pinned literally** | Play's target-API policy carves AAOS out at 35 (mobile needs 36 from 2026-08-31); pin the literal exactly as `native/wear/build.gradle` pins its 35, so a phone-driven bump can't silently change car behavior |
| `compileSdk` | `safeExtGet('compileSdkVersion', 36)` | Expo SDK 57 sets root ext 36; same helper as wear |
| Signing | wear's block, copied | debug → `rootProject.file("app/debug.keystore")`; release → `MYAPP_UPLOAD_*` props with bare filenames resolved against `rootProject.file("app/")`, else debug fallback |
| UI toolkit | None beyond two activities | The car's Media Center renders browse + now-playing. The module ships a sign-in activity, a settings activity, and **no other UI**. No Compose dependency unless the sign-in form wants it (plain views are fine and lighter) |
| Media | media3 (same version line the patch uses — currently 1.8.x via RNTP's constraint; pin the exact version at Wave 1 from the resolved dependency, not from this doc) | `MediaLibraryService` is the entire app surface |

**Client identity (frozen):**

- `clientName`: `"TomeSonic Automotive"` (deviceInfo in `POST /api/items/{id}/play`)
- Local/offline session id prefix: **`automotive-local_`** (wear uses `wear-local_`,
  phone `local_`). A shared prefix would let one device's flush replace another's
  day totals server-side — three clients, three prefixes, no exceptions.

---

## 2. Module layout

```
native/automotive/
  build.gradle                    # from native/wear/build.gradle; offset 2_000_000; minSdk 28; targetSdk 35
  ARCHITECTURE.md                 # this file
  src/main/AndroidManifest.xml    # §5 — NO launcher activity, ever
  src/main/res/xml/automotive_app_desc.xml
  src/main/res/xml/authenticator.xml
  src/main/res/drawable/aa_*.xml  # all 20, same set the phone app commits (plugin now regenerates all 20 — the Wave-0 fix)
  src/main/java/com/tomesonic/app/automotive/
    Graph.kt                      # service locator, from wear/Graph.kt
    data/                         # ported from wear/data/ (DROP DataLayerListenerService — no phone here)
      AbsClient.kt  AbsApi.kt  Models.kt  ChapterMath.kt  CredsRepository.kt  RefreshPolicy.kt
    media/
      AbsLibraryService.kt        # MediaLibraryService (entry point)
      BrowseTree.kt               # tree assembly — port of patch L539–1439, RN branches deleted
      BrowseStyles.kt             # content-style hints + badge extras — port of patch L505–616
      PlayMediaId.kt              # media-id grammar — port of patch L353–369, byte-identical semantics
    playback/                     # ported from wear/playback/
      SessionManager.kt  ProgressSyncer.kt  OfflineProgressQueue.kt  DownloadsLocalSource.kt
    downloads/                    # ported from wear/downloads/ (worker, index, repository, entries)
    account/
      AbsAuthenticator.kt  AbsAuthenticatorService.kt   # NEW — AccountManager (mandatory, §6)
    ui/
      SignInActivity.kt  SignInViewModel.kt             # full-screen form (NOT wear's RemoteInput flow)
      SettingsActivity.kt                               # ACTION_APPLICATION_PREFERENCES
  src/test/java/...               # ported wear data/playback tests + patch-behavior tests rewritten
                                  # against real classes (the 12 reflection-based files under
                                  # native/android/app/src/test/.../trackplayer/ are the spec)
  screenshots/
    mock_abs.py  capture.sh  README.md                  # from native/wear/screenshots/
```

Line references are into the **patched**
`native/node_modules/react-native-track-player/android/src/main/java/com/doublesymmetry/trackplayer/service/MusicService.kt`
(3,462 lines; requires `npm ci` to exist). They are anchors for the porter, not
load-bearing at build time — the automotive module never depends on the patch.

---

## 3. Donor map — where every piece ports from

| AAOS piece | Donor | Rule |
|---|---|---|
| HTTP client, auth, single-flight refresh | `wear/data/AbsClient.kt` (+ `RefreshPolicy.kt`) | Port verbatim; OkHttp + interceptor beats the patch's `HttpURLConnection`. Wear's JVM tests come along |
| Login | `wear/data/AbsApi.kt` (`login`) + `wear/ui/ConnectViewModel.kt` error copy | The patch has NO login — it only refreshes a pair JS handed it. Wear is the only donor |
| Models / parsing | `wear/data/Models.kt` | Typed models with tests; the patch parses inline into MediaItems |
| Creds store | `wear/data/CredsRepository.kt` | DataStore keys `abs_server/abs_token/abs_refresh_token/abs_source`; `CredsSource` collapses to CAR only (no PHONE mirroring — there is no phone) |
| **Browse tree shape** | **the patch**, L539–1439 | The one place the patch is the only donor — wear has screens, not a tree. RN branches (`reactContext != null`, `emit(...)`) are deleted, never ported |
| Content-style hints + badge extras | the patch, L505–616 + L3045–3060 | Copy the key strings **verbatim** (§4.3 — they are not guessable) |
| Pagination window | the patch, `absPageWindow` L343–349 | Verbatim, with its overflow-safe clamping; `BrowsePaginationSpecTest` is the spec |
| Search | the patch, L1209–1242, L3126–3175 | FIFO cache cap 30 (deliberately NOT LRU); required for voice (VC-1) |
| Media-id grammar | the patch L353–369 == `native/utils/playMediaId.ts` | Frozen, §4.1 |
| Playback + sessions | `wear/playback/SessionManager.kt` | Superset of the patch's cold-start resolver: full deviceInfo, supportedMimeTypes, session kept for sync. Keep the same-target short-circuit + command-mutex discipline it now carries |
| Progress sync | `wear/playback/ProgressSyncer.kt` + `OfflineProgressQueue.kt` | Wall-clock `timeListened` (never position deltas — seeks must not inflate stats); two-queue offline flush (`PATCH /api/me/progress/batch/update` + `POST /api/session/local`) |
| Downloads | `wear/downloads/*` | The patch only READS a JS-written mirror; the car owns its downloads like the watch does. Default constraint on a car: **unmetered Wi-Fi** (cars are parked near Wi-Fi; drop wear's charger requirement — cars are always powered) |
| Playback resumption | patch `onPlaybackResumption` concept + `CredsRepository.lastItem` | The Media Center's resume affordance; state source is the creds store, NOT `widget_state.json` (phone-only) |
| Never ported | `absWriteWidgetProgress`, `absWriteDownloadProgress`, `absRefreshResumeWidget`, `purgeStaleSessionRegistrations` (media3 private-API reflection), every `HeadlessJs*`/`reactContext`/`emit` path | Phone-widget and RN-lifecycle artifacts |

---

## 4. Frozen cross-client contracts

Three clients already agree on these (JS phone app, patched Auto service, wear).
The automotive module is the fourth. **No divergence, byte-level.**

### 4.1 Media-id grammar

```
play:<itemId>[::<episodeId>][@@<seconds>]
```

Defined in the patch (L353–369) and mirrored in `native/utils/playMediaId.ts`;
the two-sided contract test `native/__tests__/contracts/nativeBridgeShapes.test.ts`
pins the JS side. The automotive `PlayMediaId.kt` gets a JVM test table matching
that file's cases, and (Wave 3) the contract test grows a third column asserting
the automotive constants file carries the same grammar examples.

### 4.2 Browse parent-id grammar

```
__ROOT__   __CONTINUE__   __CONTINUE_SERIES__   __DOWNLOADS__   __LIBRARIES__
lib:{libraryId}:{mediaType}
latest:{libraryId}      allbooks:{libraryId}    listenagain:{libraryId}
authors:{libraryId}   → author:{libraryId}:{authorId}
serieslist:{libraryId}→ series:{libraryId}:{seriesId}
collections:{libraryId}→ collection:{collectionId}
podcast:{itemId}
```

A JVM test asserts the constants table in `BrowseTree.kt` matches this list
verbatim (and this doc carries the same list so drift is visible in review).

### 4.3 Badge extras & content-style keys (verbatim strings)

On items (patch `absItemExtras`, L591–616 — key strings verified against media3
1.8; the "obvious" `android.media.description.extra.*` names are wrong and render
nothing):

```kotlin
"android.media.extra.DOWNLOAD_STATUS"                      // Long 2 = STATUS_DOWNLOADED
"android.media.extra.PLAYBACK_STATUS"                      // Int 2 = finished (checkmark), 1 = partially played
"androidx.media.MediaItem.Extras.COMPLETION_PERCENTAGE"    // Double 0.0..1.0, only with PLAYBACK_STATUS = 1
```

On the root (patch `onGetLibraryRoot`, L3045–3060):

```kotlin
"android.media.browse.CONTENT_STYLE_SUPPORTED"       // true
"android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"   // 2 (grid)
"android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"  // 3 (category list)
```

Folder-level overrides keep the patch's per-level choices. Progress also rides the
**title prefix** (`"42% • Title"`, `"✓ Title"`) because car screens truncate
subtitles — port `absProgressPct` / `absProgressSubtitle` behavior with their
tests (`MusicServiceProgressLabelTest` is the spec).

### 4.4 ABS endpoint surface

Everything in `native/wear/ARCHITECTURE.md` § "ABS API surface", plus the
browse-tree-only endpoints:

```
GET  /api/libraries/{id}/personalized     (continue-series shelf)
GET  /api/libraries/{id}/authors
GET  /api/libraries/{id}/series
GET  /api/libraries/{id}/collections
GET  /api/collections/{id}
GET  /search?q=                            (cross-library, via absSearch)
```

Auth endpoints are identical to wear's (frozen there): `POST {server}/login`
(15 s; token = `user.accessToken ?? user.token`, refresh = `user.refreshToken`) and
`POST {server}/auth/refresh` (20 s; empty JSON body; `x-refresh-token` header;
rotation-optional). **Only 401/403 from `/auth/refresh` is terminal** —
`RefreshPolicy.kt` ports unchanged with its test table.

Cover art: `{server}{coverPath}?token={token}` — query-string token is deliberate
(the car process fetches covers itself and cannot attach a header). Local covers
are decoded and re-compressed to **bytes** (patch `absLocalArtBytes`, L827–850):
the car process can't read this app's private `file://` paths.

---

## 5. Manifest contract

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

  <uses-feature android:name="android.hardware.type.automotive" android:required="true" />

  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.WAKE_LOCK" />

  <application
      android:label="@string/app_name"
      android:icon="@mipmap/ic_launcher"
      android:appCategory="audio">

    <!-- AAOS descriptor. This name — NOT com.google.android.gms.car.application,
         which is Android Auto's and must not appear in this artifact. -->
    <meta-data android:name="com.android.automotive"
               android:resource="@xml/automotive_app_desc" />

    <service android:name=".media.AbsLibraryService"
             android:exported="true"
             android:foregroundServiceType="mediaPlayback">
      <intent-filter>
        <action android:name="androidx.media3.session.MediaLibraryService" />
        <action android:name="android.media.browse.MediaBrowserService" />
      </intent-filter>
    </service>

    <!-- Parked-only by policy. NEVER add distractionOptimized meta-data to
         either activity: "Your app will be rejected during review if such an
         element is present." A unit test asserts its absence (§10). -->
    <activity android:name=".ui.SignInActivity" android:exported="true" />

    <activity android:name=".ui.SettingsActivity"
              android:exported="true"
              android:label="@string/app_settings_activity_title">
      <intent-filter>
        <action android:name="android.intent.action.APPLICATION_PREFERENCES" />
      </intent-filter>
    </activity>

    <service android:name=".account.AbsAuthenticatorService" android:exported="true">
      <intent-filter>
        <action android:name="android.accounts.AccountAuthenticator" />
      </intent-filter>
      <meta-data android:name="android.accounts.AccountAuthenticator"
                 android:resource="@xml/authenticator" />
    </service>
  </application>
</manifest>
```

`res/xml/automotive_app_desc.xml` is byte-identical to the phone app's:

```xml
<automotiveApp>
  <uses name="media" />
</automotiveApp>
```

Hard rules (each is a documented review-rejection or platform rule):

- **No activity with `ACTION_MAIN` / `CATEGORY_LAUNCHER`. There is no launcher
  icon on AAOS** — the system opens media apps by explicit intent. Direct CI
  consequence in §11.
- No `com.google.android.gms.car.application` meta-data in this artifact.
- No `distractionOptimized` meta-data on any activity.
- Declare a manifest component **only in the wave that lands its class** —
  `bundleRelease` runs `lintVitalRelease` in every module, and a `<service>`
  naming a class that doesn't exist fails the release job specifically
  (`github-releases.yml` passes `-x lint`, so PR CI won't catch it; this is the
  classic first-release trap `PLAY_STORE_WEAR.md` records).

---

## 6. Auth & account contract

- **State machine**: `CredsRepository` with `CredsSource.CAR` only. Signed-out ↔
  signed-in ↔ auth-failed (refresh got 401/403 from `/auth/refresh`).
- **Surfacing sign-in from the Media Center**: on signed-out/auth-failed, the
  session enters an error state carrying the legacy resolution extras
  (`MediaConstants.PLAYBACK_STATE_EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL` = "Sign in",
  `..._ACTION_INTENT` = PendingIntent → `SignInActivity`), and browse returns the
  auth error result. **Wave-1 spike obligation**: confirm the exact media3 1.8
  spelling (`LibraryResult.ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, params)`
  vs setting legacy extras on the platform session) against a booted emulator
  BEFORE Wave 3 freezes `AbsLibraryService`'s error paths. The contract intent —
  "car shows a Sign in affordance that opens the activity while parked" — is
  frozen; the API spelling is the spike's to pin.
- After successful sign-in: persist creds, clear the error state,
  `notifyChildrenChanged("__ROOT__")`, `finish()`. On sign-out (settings):
  clear creds, stop playback, `notifyChildrenChanged("__ROOT__")` (same
  mechanism the patch's `absNotifyBrowseChanged` uses on token refresh).
- **AccountManager is mandatory** (car settings account UI, guest-mode
  `DISALLOW_MODIFY_ACCOUNTS`): `AbsAuthenticator : AbstractAccountAuthenticator`
  registering account type `com.tomesonic.app` whose `addAccount` routes to
  `SignInActivity`. The account mirrors the creds store (one account max); tokens
  stay in the DataStore, not in `AccountManager` userData.
- **Sign-in form**: server URL, username, password, full-screen, normal keyboard
  input. Error copy verbatim from wear's `ConnectViewModel` (which took it from
  the phone's ConnectScreen). Optional "demo server" prefill field (§12 risk 1).
  Do NOT port wear's three-step RemoteInput flow.

---

## 7. Browse behavior contract (ported discipline, not just shape)

All of these shipped hardening — port them, do not rediscover them:

- **Cache**: children fresh 45 s; stale-on-failure serves up to 10 min;
  `ConcurrentHashMap`; `__DOWNLOADS__` never cached (patch L1284–1308).
- **Threading**: dedicated 3-thread browse pool + submission guard with rejection
  fallback (patch L322, L329) — never the main thread, never unbounded.
- **Binder budget**: `absDownloadsArtBudget = 8` inlined covers max in the
  Downloads folder (`TransactionTooLargeException` guard — same Binder on AAOS).
- **Offline**: network callback requires `INTERNET` **and** `VALIDATED` (captive
  portal ⇒ offline); offline root = `__DOWNLOADS__` only; flips call
  `notifyChildrenChanged` on the main looper.
- **DR-2/DR-3 additions** (new for the car, §10): pre-warm the root tree +
  progress map on service create; persist the last-good root tree to disk so the
  first `onGetChildren` after cold start answers instantly; keep the patch's 5 s
  connect / 10 s read timeouts; `__CONTINUE_SERIES__` (an N+1 per-series fetch,
  patch L1112–1197) loads lazily and must never block the root answer.
- Ebook-only items are filtered (`absHasAudio`); org.json `"null"` string guard
  (`absStr`) and base64+urlencoded filter ids (`absB64`) port verbatim.

## 8. Playback & progress contract

- Media3 player in `AbsLibraryService` (a `MediaLibraryService`), speech audio
  attributes, `WAKE_MODE_NETWORK`, audio focus + becoming-noisy handled by the
  session. Audio offload where the platform allows it (port wear's setup).
- Play resolution: `POST /api/items/{id}/play[/{episodeId}]` with
  `{"mediaPlayer": "exo-player", deviceInfo: {clientName: "TomeSonic Automotive", deviceId: <stable id>}, supportedMimeTypes: [...]}`;
  pick the track containing the saved `currentTime`; token in query string.
  Offline play resolves from the download index. Same-target short-circuit and
  command-mutex serialization exactly as wear's `SessionManager` (the re-tap bug
  class stays fixed in every client).
- Progress: `POST /api/session/{id}/sync` on a ~15–20 s tick while online, with
  **wall-clock** `timeListened` (baseline reset on seek and identity change —
  never position deltas). Offline: wear's two-queue scheme verbatim, flushing
  `PATCH /api/me/progress/batch/update` + `POST /api/session/local` with
  `automotive-local_` ids on reconnect.
- `onPlaybackResumption`: resume target from `CredsRepository.lastItem` +
  download index / expanded fetch — the Media Center resume affordance is the
  ONLY autoplay path (MA-1: no autoplay without user action).

---

## 9. Build & CI contract

**settings.gradle** — committed in `native/android/settings.gradle` AND
re-injected by `plugins/withAutomotiveApp.js` (`withSettingsGradle`,
marker-guarded, idempotent, with the same `assertGroovy` template-shape check
`withWearApp.js` carries):

```gradle
// Native Android Automotive OS app — lives outside this regenerated directory;
// committed AND re-injected by plugins/withAutomotiveApp.js.
include ':automotive'
project(':automotive').projectDir = new File(rootDir, '../automotive')
```

**versionCode derivation** (`native/automotive/build.gradle`, copied from wear
with the constant + error strings changed):

```groovy
def phoneBuildGradle = file("../android/app/build.gradle")
if (!phoneBuildGradle.exists()) {
    throw new GradleException(":automotive cannot derive its version — ../android/app/build.gradle is missing (run expo prebuild?)")
}
def text = phoneBuildGradle.getText("UTF-8")
def codeMatch = text =~ /versionCode\s+(\d+)/
if (!codeMatch.find()) throw new GradleException(":automotive could not find 'versionCode N' in ../android/app/build.gradle")
def nameMatch = text =~ /versionName\s+"([^"]+)"/
if (!nameMatch.find()) throw new GradleException(":automotive could not find 'versionName \"x.y.z\"' in ../android/app/build.gradle")
def automotiveVersionCode = codeMatch.group(1).toInteger() + 2_000_000
def automotiveVersionName = nameMatch.group(1)
```

**Workflows:**

| Workflow | Change |
|---|---|
| `android-unit-tests.yml` | `:automotive:testDebugUnitTest` added to the gradle line **and** to the zero-`<testcase>` guard loop — both places, or the guard silently doesn't cover the module |
| `build-apk.yml` / `github-releases.yml` | `:automotive:assembleRelease` artifact alongside phone + wear |
| `deploy-playstore.yml` | Third upload step: `r0adkll/upload-google-play` with `track: automotive:${{ github.event.inputs.track \|\| 'alpha' }}`. Order **phone → wear → automotive** so a missing car track can never block shipped artifacts. The "Verify AABs exist" guard extends to three files, its failure message naming `plugins/withAutomotiveApp.js` and the `include ':automotive'` line |

Play form-factor track strings are `automotive:internal` / `automotive:alpha` /
`automotive:beta` / `automotive:production` (the Play Developer API's
`TrackConfig.formFactor` enum: `default`, `WEAR`, `AUTOMOTIVE`) — the same
mechanism the shipped `wear:` steps use.

---

## 10. Car quality bar — what review enforces and how we hold it

Tier-2 ("Car Optimized") items that bite this app, each with its owner:

| ID | Requirement | How this module satisfies it |
|---|---|---|
| PE-1 | No functionality outside setup/sign-in/settings while parked | By construction — those are the only activities |
| EP-2 | Restore previous state on relaunch | `lastItem` + resume position from `CredsRepository` |
| EP-4 | AAOS screenshots in the listing | §11 rig produces Play's two floor sizes |
| VC-1 | Assistant/Gemini voice | `onSearch`/`onGetSearchResult` ported; Wave-6 emulator check that voice play reaches `onSetMediaItems` |
| DR-1/2/3 | Buttons ≤2 s; launch ≤10 s; content ≤10 s | §7's cache + pre-warm + persisted root + tight timeouts + lazy continue-series |
| MA-1 | No autoplay without user action | Resumption only via the Media Center affordance |
| AR-1 | UI clear of bars/cutouts | Applies to the two activities; edge-to-edge insets handled |
| VD-1/2/3 | Contrast; white icon sets for system colorization | The `aa_*` drawables are `#FFFFFFFF` fill already |
| SA-1/ST-1/IU-1/AD-1/NA-1/IN-1 | No animations/auto-scroll/ads | The car draws the UI; the app has no ads |

A JVM test parses the merged manifest and asserts: no `ACTION_MAIN` launcher, no
`distractionOptimized` meta-data, `com.android.automotive` meta-data present,
`com.google.android.gms.car.application` absent.

---

## 11. Emulator, screenshots, and the no-launcher wrinkle

`.github/workflows/automotive-screenshots.yml`, ported from `wear-screenshots.yml`
(path-scoped triggers + `workflow_dispatch`; KVM enable; disk reclaim; `npm ci`
because configuring `native/android` evaluates the expo plugins; stdlib
`mock_abs.py` on :3333 with `10.0.2.2` loopback; single-`bash` `capture.sh`;
bot-commit PNGs `[skip ci]` into `screenshots/automotive/`):

```yaml
- uses: reactivecircus/android-emulator-runner@v2
  with:
    api-level: 35-ext15            # fallback 34-ext9 — both stable AAOS images
    target: android-automotive     # NON-Play image: on -playstore images,
                                   # distraction-optimized activities render only
                                   # for Play-installed apps — useless in CI
    arch: x86_64
    profile: automotive_1024p_landscape   # matrix with automotive_portrait
    disable-animations: true
    emulator-boot-timeout: 900
    emulator-options: -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -camera-back none
    script: bash native/automotive/screenshots/capture.sh
```

- The two bundled profiles — `Automotive (1024p landscape)` (1024×768) and
  `Automotive Portrait` (800×1280) — are exactly Play's two screenshot floors
  (≥2 landscape 1024×768 + ≥2 portrait 800×1280, generic system image, no frames).
- **There is no launcher activity**, so `capture.sh` cannot `am start` a main
  activity like wear's rig does. It drives the car's **Media Center** instead:
  `ACTION_MEDIA_TEMPLATE` with `EXTRA_KEY_MEDIA_COMPONENT` = the flattened
  `AbsLibraryService` component. **Wave-1 spike obligation**: nail the exact
  action/extra strings + `am` incantation on a booted AAOS emulator and record
  them in `screenshots/README.md`.
- VHAL smoke step: Extended-controls car properties (`PERF_VEHICLE_SPEED` ≠ 0 +
  gear ≠ P ⇒ driving; gear P ⇒ parked) proving sign-in/settings are unavailable
  while driving — PE-1 evidence, not just screenshots.
- A debug-only `DebugLaunch` equivalent (intent extras seeding creds against the
  mock server, `FLAG_DEBUGGABLE`-gated) ports from wear so the rig never needs a
  real account.

Local: `./gradlew :automotive:assembleDebug` + `adb install` onto an AAOS AVD —
with the shared `applicationId`, `adb install` on a phone-connected machine
overwrites the phone build unless `-s <serial>` is passed (same trap
`PLAY_STORE_WEAR.md` documents).

---

## 12. Play distribution & review posture

- **Dedicated AAOS track, mandatory**: media apps → Android Automotive OS track
  only; one artifact cannot serve mobile + AAOS.
- **Opt-in**: Play Console → Test and release → Advanced settings → Form factors
  → Add → Android Automotive OS (needs AAOS screenshots + a bundle on a testing
  track + review-policy agreement + dedicated-track selection).
- **Review ladder** (car review is stricter than wear's): `automotive:internal`
  (no form-factor review) → closed testing (**non-blocking** review with a written
  non-compliance email — the free dress rehearsal) → open testing / production
  (**blocking**; rejected artifacts must be removed before resubmitting). With the
  shared package, review is "Blocking (all APKs)" — so a first AAOS submission
  never rides an urgent phone release; car releases go out on their own
  `automotive:` dispatch.
- **Risk 1 — review credentials**: TomeSonic is self-hosted; a reviewer with no
  server sees an empty app. Release checklist (Wave 5 runbook): a reachable demo
  ABS instance seeded with public-domain audio (books across two libraries + one
  podcast, some partial progress), credentials in the Console review notes, kept
  live through the review window; `SignInActivity` carries a demo-server prefill.
  **Open question for the owner**: who hosts that instance. Everything else in
  this contract proceeds without the answer.
- **Decision taken (default)**: same package `com.tomesonic.app`, one listing —
  Google's recommendation, matches wear, reuses listing assets. The cost
  (car rejection can block a bundled phone submission) is mitigated procedurally
  above. Overriding this later means a second listing with no install carryover.

---

## 13. Wave plan & verification rules

| Wave | Deliverable | Primary donors |
|---|---|---|
| 0 | This contract + `AUTOMOTIVE_OS.md` + `withAutoBrowseIcons.js` regenerates all 20 icons | — |
| 1 | `build.gradle`, manifest skeleton (service declared only with a stub class present — §5 lint trap), `withAutomotiveApp.js`, committed include, CI wiring; **emulator spike** (Media Center intent; media3 auth-error spelling) | wear scaffold files |
| 2 | `data/` + `Graph.kt` + tests | `wear/data/*` minus DataLayer |
| 3 | `media/` (tree, styles, ids) + `playback/` + `downloads/` + tests | patch (tree) + `wear/playback,downloads` |
| 4 | `ui/` sign-in + settings, `account/`, `authenticator.xml` + manifest-rule tests | wear connect flow (form, not RemoteInput) |
| 5 | `PLAY_STORE_AUTOMOTIVE.md` + deploy third upload + triple-AAB guard | `PLAY_STORE_WEAR.md`, wear upload step |
| 6 | Screenshot workflow + capture rig + VHAL smoke | `wear-screenshots.yml` + rig |

Standing rules, inherited from the wear playbook:

- Kotlin compile/test authority is CI (`android-unit-tests`, `build-apk`) — no
  local SDK in the dev environment. Every wave lands with its JVM tests and a
  green CI run before the next builds on it.
- Ported behavior keeps its donor's tests (rewritten off reflection where the
  donor tests reflected into the patch's private methods).
- The patch, `native/utils/autoCreds.ts`, `plugins/withAndroidAuto.js`, and
  everything under `native/android/app/**` stay untouched — this module is
  additive, and the shipped Android Auto surface must not regress.
