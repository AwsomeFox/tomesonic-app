# TomeSonic Wear — module architecture (binding contract)

This file is the contract the wear module is built against. If code and this file
disagree, fix one of them — deliberately. Read `native/WEAR_OS.md` for the why;
this file is the how.

## Ground rules

- Pure native **Kotlin + Compose for Wear OS** app. No React Native, no JS.
- Lives at `native/wear/` (SIBLING of `native/android/`, which `expo prebuild
  --clean` deletes and regenerates). Wired into the build by
  `plugins/withWearApp.js` (config plugin) AND a committed line in
  `native/android/settings.gradle` — either survives a prebuild.
- `applicationId com.tomesonic.app` (MUST equal the phone app — same Play
  listing, and the Wearable Data Layer only pairs same-package, same-signature
  apps). `namespace com.tomesonic.app.wear`.
- `minSdk 30` (Wear OS 3+), `targetSdk 35`, `compileSdk rootProject.ext.compileSdkVersion`.
- Manifest: `<uses-feature android:name="android.hardware.type.watch"/>`,
  `com.google.android.wearable.standalone` meta-data = `false` (v1 gets
  credentials from the phone app), `usesCleartextTraffic true` (self-hosted ABS
  over plain http, same as the phone app).
- JSON via `org.json` (no serialization plugin). DI via plain singletons/object
  graph (a `Graph.kt` service locator) — no Hilt/Koin.
- Every network call carries `Authorization: Bearer <token>`. No token in query
  strings (keeps URLs log-safe); one shared OkHttp client.

## Version pins (verified to exist; do not drift without checking)

| Dep | Version |
|---|---|
| Kotlin / compose-compiler-gradle-plugin | 2.1.20 (MUST match RN's pin in `node_modules/react-native/gradle/libs.versions.toml`) |
| AGP | root project's (8.12.0 via RN) |
| androidx.compose:compose-bom | 2025.05.00 |
| androidx.wear.compose:compose-material3 / -foundation / -navigation | 1.5.0 |
| androidx.activity:activity-compose | 1.10.1 |
| androidx.lifecycle:lifecycle-viewmodel-compose, lifecycle-service | 2.8.7 |
| androidx.media3: exoplayer, session, common, datasource-okhttp, exoplayer-hls | 1.8.0 (same as RNTP on the phone) |
| com.squareup.okhttp3:okhttp | 4.12.0 |
| io.coil-kt:coil-compose | 2.7.0 |
| com.google.android.gms:play-services-wearable | 19.0.0 |
| org.jetbrains.kotlinx:kotlinx-coroutines-play-services | 1.10.1 |
| androidx.datastore:datastore-preferences | 1.1.7 |
| androidx.work:work-runtime-ktx | 2.10.1 |
| androidx.wear:wear | 1.3.0 |
| androidx.wear:wear-ongoing | 1.0.0 |
| junit / robolectric (tests) | 4.13.2 / 4.15.1 (same as `:app`) |

Root `native/android/build.gradle` gains ONE buildscript classpath line
(`org.jetbrains.kotlin:compose-compiler-gradle-plugin:2.1.20`), injected by the
config plugin and committed. The wear module applies `com.android.application`,
`org.jetbrains.kotlin.android`, `org.jetbrains.kotlin.plugin.compose`.

**versionCode**: derived at configure time by parsing `versionCode (\d+)` out of
`../android/app/build.gradle` and adding `1_000_000` (phone 20148 → wear
1020148). `versionName` parsed the same way. Single source of truth; nothing to
add to release scripts.

**Signing**: mirror `:app` exactly — debug keystore `../android/app/debug.keystore`
for debug; release uses `MYAPP_UPLOAD_*` props when present (resolve a relative
`MYAPP_UPLOAD_STORE_FILE` against `rootProject.file("app/")`, where the deploy
workflow drops `upload-keystore.jks`), else falls back to debug signing.

## Wearable Data Layer protocol (phone → watch)

- DataItem path **`/tomesonic/creds`**, `PutDataMapRequest`, `setUrgent()`. Keys:
  `server` (string, origin only, no trailing slash), `token` (string, ABS
  ACCESS token — never the refresh token), `userId` (string, may be ""),
  `username` (string, may be ""), `ts` (long, phone wall-clock millis — makes
  each put distinct so updates always sync).
- Logout = put the same path with `server`/`token` = "" (empty strings), NOT
  deleteDataItems (deletion events are less reliable across reconnects).
- Watch side: `DataLayerListenerService` (WearableListenerService,
  `com.google.android.gms.wearable.DATA_CHANGED` intent filter, scheme `wear`,
  host `*`, pathPrefix `/tomesonic`) writes the values into CredsRepository.
  On app open the watch ALSO queries existing DataItems (`DataClient.dataItems`)
  so creds arrive even if the listener never fired (app installed after login).
- Phone side: `WearBridgeModule` (ReactContextBaseJavaModule, name
  `"WearBridge"`) with methods `putCreds(server, token, userId, username,
  promise)` and `clearCreds(promise)`; all failures caught → resolve(false)
  (Data Layer is best-effort; never crash or reject into JS). JS choke point:
  `utils/autoCreds.ts` — `writeAutoCreds()` also calls
  `NativeModules.WearBridge?.putCreds(...)`, `clearAutoCreds()` calls
  `clearCreds()`; guarded so jest/iOS/missing-module are silent no-ops.

## Watch-side storage

DataStore("tomesonic_wear") preference keys:
- `abs_server`, `abs_token`, `abs_user_id`, `abs_username` — creds mirror.
- `device_id` — random UUID minted once on first read.
- `playback_speed` (float, default 1.0), `last_item_id`, `last_episode_id`.
- `offline_sessions` — JSON array of queued local sessions (see Progress).

Files:
- `filesDir/downloads/{libraryItemId}/{filename}` — downloaded audio tracks.
- `filesDir/downloads/{libraryItemId}/cover.jpg` — downloaded cover.
- `filesDir/downloads_index.json` — array of DownloadEntry (below), written
  atomically (tmp file + rename).

## ABS API surface (all relative to `server`)

- `GET /api/libraries` → `{libraries:[{id,name,mediaType}]}`; keep `book` and
  `podcast` libraries.
- `GET /api/libraries/{id}/items?limit=50&page={n}&minified=1&sort=media.metadata.title`
  → `{results:[...], total, page, limit}`.
- `GET /api/me/items-in-progress?limit=15` → `{libraryItems:[...]}` (may carry
  `recentEpisode` for podcast episodes → its `id` is the episodeId).
- `GET /api/items/{id}?expanded=1` → full item: `media.metadata.title/authorName`,
  `media.duration`, `media.chapters[{id,start,end,title}]`,
  `media.audioFiles`/`media.tracks`, `media.episodes` (podcasts),
  `size`, `userMediaProgress.currentTime` when present.
- `POST /api/items/{id}/play` (or `/play/{episodeId}`) body:
  `{deviceInfo:{deviceId,clientName:"TomeSonic Wear",clientVersion,manufacturer,
  model,sdkVersion}, supportedMimeTypes:[same list as
  store/usePlaybackStore.ts], mediaPlayer:"exo-player", forceDirectPlay:false,
  forceTranscode:false}` → PlaySession: `{id, libraryItemId, episodeId?,
  displayTitle, displayAuthor, duration, currentTime, audioTracks:[{index,
  startOffset, duration, title, contentUrl, mimeType}], chapters[], libraryItem?}`.
  `contentUrl` is server-relative; join with `server` and stream with the
  Authorization header (OkHttp datasource). HLS transcode sessions play the
  same way (media3 HLS module included).
- `POST /api/session/{id}/sync` body `{currentTime, timeListened, duration}` —
  every 15s while playing online, on pause, and on stop.
- **Offline progress mirrors the phone's proven two-queue scheme**
  (`utils/progressSync.ts` — read it before implementing):
  1. POSITION → queue a media-progress patch per item (latest wins), flushed on
     reconnect via `PATCH /api/me/progress/batch/update` with an ARRAY of
     `{libraryItemId, episodeId?, currentTime, duration, progress}` (see
     `utils/abs/me.ts`).
  2. LISTENING TIME (stats) → one cumulative record per item+day with id
     `wear-local_<itemId>[-<episodeId>]_<YYYY-MM-DD>`, flushed via
     `POST /api/session/local` (`{id, libraryItemId, episodeId?, mediaType,
     displayTitle, displayAuthor, duration, playMethod:3,
     mediaPlayer:"exo-player", deviceInfo, date, dayOfWeek, timeListening,
     currentTime, startedAt, updatedAt}`). ABS upserts by id and REPLACES
     timeListening, so re-sending a grown day total is idempotent. The
     `wear-local_` prefix is deliberate: the phone uses `local_…` ids for the
     same item+day — a shared id would let one device's total REPLACE the
     other's.
- `GET /api/items/{id}/cover?width=240&format=webp` — Coil with the shared
  authorized OkHttp client.
- Downloads: for each track in the expanded item, GET its file:
  `track.contentUrl` when present, else `/api/items/{id}/file/{ino}` (see
  `utils/downloader.ts`); plus the cover. Bearer header, stream to a `.part`
  file, rename when complete, verify size when the server sends Content-Length.
- Any 401 → surface "reconnect from phone" state (v1 never refreshes tokens).

## Module layout & ownership (parallel agents stay in their lane)

```
native/wear/src/main/java/com/tomesonic/app/wear/
  Graph.kt              // service locator: creds, api, downloads, player conns
  MainApplication.kt    // Application: Graph init, notification channel
  MainActivity.kt       // ComponentActivity → WearApp()
  data/                 // Wave 2
    CredsRepository.kt  DataLayerListenerService.kt  DeviceIds.kt
    AbsClient.kt        AbsApi.kt   Models.kt   ChapterMath.kt
  playback/             // Wave 3A
    PlaybackService.kt  // MediaSessionService + ExoPlayer (audio offload ENABLED)
    SessionManager.kt   // start/stop ABS session, build MediaItems local-or-stream
    ProgressSyncer.kt   // 15s tick, pause/stop flush, offline queue append
    OfflineProgressQueue.kt // both offline queues + local resume markers
    PlayerConnection.kt // UI-facing MediaController wrapper + state flows
    DownloadsLocalSource.kt // the ONE file bridging playback -> downloads
  downloads/            // Wave 3B
    DownloadEntry.kt    // {id,title,author,duration,coverPath?,tracks:[{filename,startOffset,duration,contentUrl?}],bytes}
    DownloadIndex.kt    // atomic json file persistence + Flow<List<DownloadEntry>>
    DownloadRepository.kt // enqueue/cancel/delete/totalBytes/entryFor/localFile
    DownloadWorker.kt   // CoroutineWorker, foreground dataSync notification
  ui/                   // Wave 4A
    WearApp.kt theme/   screens/  components/
```

Cross-wave interfaces (FROZEN — talk through these, not into each other's files):
- `DownloadRepository.entryFor(itemId): DownloadEntry?`,
  `localFile(itemId, filename): File?`, `entries: Flow<List<DownloadEntry>>`,
  `suspend enqueue(itemId)`, `suspend delete(itemId)`, `totalBytes(): Long`.
- `SessionManager.play(itemId, episodeId?)` — checks DownloadRepository first;
  local entries play offline with a `wear_` local session; otherwise streams.
- `PlayerConnection.state: StateFlow<PlayerUiState>` where PlayerUiState =
  `{isPlaying, itemId?, episodeId?, title, author, chapterTitle?, positionMs,
  durationMs, chapterIndex, chapterCount, speed, coverUri?}`.
- `CredsRepository.creds: Flow<Creds?>` (null when not configured).

As built, two additions to that surface: `DownloadRepository.warm()` +
`entryForNow(itemId)` (non-suspending index read — playback's `localBook`
resolution cannot suspend, so MainApplication warms the index at startup and
installs `PlaybackWiring.localSource = DownloadsLocalSource(...)`), and
`DownloadRepository.status(itemId): Flow<DownloadStatus>` for the UI.

Known gap (v1): media3's default BitmapLoader fetches notification artwork
without the Authorization header, so STREAMED books may show no artwork in the
media notification (downloaded books use file:// covers and are fine). Fix is a
custom BitmapLoader over the shared OkHttp client; in-app covers go through
Coil with the authorized client and are unaffected.

## UI (Wave 4A)

Wear Compose **Material 3**, `SwipeDismissableNavHost`. Routes: `home`,
`library/{id}`, `item/{id}`, `player`, `downloads`, `settings`, `connect`.
- `connect` (no creds): app icon + "Open TomeSonic on your phone to connect".
- `home`: resume card for `last_item_id` (falls back to first in-progress item),
  Continue Listening entries, then chips: Downloads, one per library, Settings.
- `item`: cover, title, author, progress %, Play (streams or plays local),
  Download/Delete with size, podcast → recent episodes list (play-only,
  downloads are book-only in v1).
- `player`: cover backdrop, chapter title + book title, play/pause,
  −30s/+30s, prev/next chapter, speed chip (0.75–2.5 in the same steps the
  phone offers), volume via rotary + a volume screen (output switching hint).
  Ongoing Activity while playing.
- Theme: port `native/theme/palette.ts` dark roles into a wear M3 ColorScheme
  (brand seed `#1E5F50`); typography defaults; screens must render on round.

## Testing (every wave ships tests)

- JVM-pure where possible (ChapterMath, models parsing from JSON fixtures, URL
  building, sync payload shapes, DownloadIndex round-trip via temp dir).
- Robolectric (sdk 35, same as `:app` tests) where a Context is unavoidable.
- `testOptions.unitTests.includeAndroidResources = true`; junit/robolectric
  versions identical to `:app`.
- CI: `.github/workflows/android-unit-tests.yml` runs
  `:wear:testDebugUnitTest` alongside `:app:testDebugUnitTest`; `build-apk.yml`
  and `deploy-playstore.yml` build the wear artifacts.

## v1 non-goals (documented, deliberate)

Search, tiles/complications, sleep timer, podcast episode downloads, Cast,
watch-owned auth (`standalone=true`), bookmark editing, ebook anything.
