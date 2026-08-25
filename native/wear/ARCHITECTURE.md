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

Known gap (v1), CLOSED in v2: media3's default BitmapLoader fetched
notification artwork without the Authorization header, so streamed books showed
none. PlaybackService now installs `CacheBitmapLoader(DataSourceBitmapLoader)`
over the module's one authorized DataSource stack (which also serves `file://`
covers for downloads); in-app covers were always fine (Coil on the authorized
client).

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
  −30s/+30s, prev/next chapter, speed chip (as built: 0.75–2.0, the phone's
  actual quick-pick steps from PlaybackSpeedModal — mirror the phone, not this
  doc), volume via rotary crown + always-present −/+ buttons.
  Ongoing Activity is DEFERRED (polish): it must attach to the media
  notification PlaybackService posts, i.e. a custom MediaNotification.Provider
  in playback/, not a UI change.
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

## v1 non-goals (historical)

v1 shipped without: search, tiles/complications, sleep timer, podcast episode
downloads, Cast, watch-owned auth (`standalone=true`), bookmark editing, ebook
anything. v2 (below) delivers the first four of those plus watch-owned auth;
sleep timer, Cast, bookmarks and ebooks remain out.

---

# v2 contract

Everything above still binds unless a v2 section explicitly amends it. Lane
ownership per feature is listed with each section; `Routes.kt`, `WearApp.kt`,
`Graph.kt` and the MANIFEST are integration-owned — agents document what they
need wired and do not edit those files (exceptions named per lane).

## v2 version pins (verified against developer.android.com, Aug 2026)

| Dep | Version |
|---|---|
| androidx.wear.tiles:tiles | 1.6.2 |
| androidx.wear.protolayout:protolayout / -expression / -material | 1.4.2 (material3 has NO stable — use -material + palette colors) |
| androidx.wear.watchface:watchface-complications-data-source-ktx | 1.3.0 (complication APIs are NOT part of the watchface deprecation) |
| androidx.wear:wear-input | 1.1.0 |
| androidx.concurrent:concurrent-futures-ktx | 1.2.0 |

## Search (lane A2)

- `GET /api/libraries/{id}/search?q=<urlencoded>&limit=12` → object with `book`
  and `podcast` arrays; each element wraps the real item as `{libraryItem}`
  (this exact shape is already consumed in `native/utils/formatSwitch.ts`).
  Parse `libraryItem` through the existing `ItemSummary.fromJson`; podcast rows
  have no `recentEpisode` here (episodeId stays null). Merge book+podcast in
  server order, cap 12 total. Null return = request failed (same convention as
  `libraryItems`).
- `AbsApi.search(libraryId, query, limit=12): List<ItemSummary>?`.
- Input: `androidx.wear.input.RemoteInputIntentHelper` — ONE launcher intent
  carrying ONE `RemoteInput` (key `search_query`, label "Search"); the platform
  offers voice + keyboard on its own. Results land in the activity result's
  `RemoteInput.getResultsFromIntent`.
- UI: `SearchScreen(libraryId)` (non-null — home resolves the id before
  navigating) — the input opens on arrival, then a results list
  reusing the library row composable + `Cover`; empty-result and failed states
  get one line each. Entry points: a Search chip on HOME (searches the first
  book library, or the only library) and on each LIBRARY screen (scoped to it).
- Route (integration wires): `search/{libraryId}` template + `Routes.search()`.

## Continue Listening tile + complication (lane A3)

- Package `tile/`: `ContinueListeningTileService` extends
  `androidx.wear.tiles.TileService`; coroutine work bridges via
  `SuspendToFutureAdapter.launchFuture` (concurrent-futures-ktx).
- Tile content from `CredsRepository.lastItem` (now carrying best-effort
  `title`/`author` — written by SessionManager on every successful play; rows
  from v1 builds have neither, so the tile must render with id-only data:
  generic "Continue listening" text). No network on the render path; cover art
  is NOT fetched (tile shows app mark + text + one action). States: no
  last-item → "Open TomeSonic" action only; last-item → title/author lines +
  "Resume" action.
- Colors: literal ARGB from `ui/theme/Color.kt`'s dark scheme (tile renderers
  don't see Compose themes); protolayout-material `Text`/`Chip`/`CompactChip`.
- Tap actions: `ActionBuilders.LaunchAction` (a LoadAction only re-requests the
  tile — it cannot start an Activity) launching `MainActivity` with extras
  `extra_open_player=true` + `extra_play_item`/`extra_play_episode` (resume) or
  no extras (open). MainActivity (A3 MAY edit it — sole wave-A owner) parses
  the extras into a NEW one-shot holder `LaunchRequests` (production-safe
  sibling of DebugLaunch, same consume-once discipline, no FLAG_DEBUGGABLE
  gate); WearApp consumption is integration-wired.
- Freshness: `TileService.getUpdater(context).requestUpdate(...)` from
  SessionManager after `setLastItem` — via a `TileRefresh` hook object owned by
  A3 (SessionManager call added at integration; A3 exposes
  `TileRefresh.requestUpdate(context)` swallowing every failure).
- Package `complication/`: `ResumeComplicationService` extends
  `SuspendingComplicationDataSourceService` (ktx), types SHORT_TEXT +
  SMALL_IMAGE ("Resume" / app mark, monochrome-safe), tap = same MainActivity
  resume intent via PendingIntent. UPDATE_PERIOD 0 (static content; the text
  never changes).
- Manifest (integration adds): tile service with
  `androidx.wear.tiles.action.BIND_TILE_PROVIDER` intent-filter +
  `BIND_TILE_PROVIDER` permission + `androidx.wear.tiles.PREVIEW` meta-data
  (as built: `res/drawable-nodpi/tile_preview.png`, 400×400 — nodpi so the
  fixed-size asset never upscales; plus `res/values/strings.xml` additions
  `tile_label`, `complication_label`);
  complication service with
  `android.support.wearable.complications.ACTION_COMPLICATION_UPDATE_REQUEST`
  filter, `BIND_COMPLICATION_PROVIDER` permission, SUPPORTED_TYPES
  `SHORT_TEXT,SMALL_IMAGE`, UPDATE_PERIOD_SECONDS 0.

## Media notification artwork + Ongoing Activity (lane A1)

- Artwork 401 fix: give the media session a
  `CacheBitmapLoader(DataSourceBitmapLoader(...))` whose DataSource.Factory is
  `OkHttpDataSource.Factory(Graph.absClient.client)` — the shared client's
  interceptor attaches the Bearer + origin check, closing the known v1 gap.
- Ongoing Activity: custom `MediaNotification.Provider` in `playback/`
  (`WearMediaNotificationProvider`) building the NotificationCompat.Builder
  itself (MediaStyleNotificationHelper.MediaStyle, play/pause + seek actions
  mirroring the default provider's channel + id constants), and applying
  `androidx.wear.ongoing.OngoingActivity.Builder(context, id, builder)` with a
  status text (chapter title when known, else item title) and a
  touch-intent back into MainActivity BEFORE `build()`. Installed via
  `setMediaNotificationProvider` in PlaybackService.onCreate. Channel id/name
  MUST match the existing notification channel MainApplication creates.
- Lane owns `playback/PlaybackService.kt` + new files; does NOT touch
  SessionManager/ProgressSyncer.

## Podcast episode downloads (lane B1, wave B)

- Index schema v2, back-compat REQUIRED: `DownloadEntry` gains
  `libraryItemId: String` and `episodeId: String?`; `id` stays the UNIQUE
  entry/folder key — books keep `id == libraryItemId` (v1 rows parse with
  `libraryItemId = id`, `episodeId = null`); episode entries use
  `id = "<itemId>-ep-<sanitized episodeId>"` and live in
  `filesDir/downloads/{id}/` like any entry. A row with an unparsable id is a
  ROW loss, never a file loss.
- `PodcastEpisode` (Models.kt — B1 touches ONLY this data class) gains what a
  download needs: `ino: String?`, `contentUrl: String?`, `size: Long?` parsed
  from the episode's `audioFile`/`audioTrack` JSON.
- Repository API (frozen v1 names keep exact behavior for books):
  `entryFor(itemId)`, `entryForNow(itemId)` return the BOOK entry only.
  New: `entryFor(itemId, episodeId)`, `entryForNow(itemId, episodeId)`,
  `status(itemId, episodeId?)`, `suspend enqueue(itemId, episodeId?, force)`
  (overload keeping the old signature), `suspend delete(itemId, episodeId?)`,
  `localFile(entryId, filename)` unchanged semantics via entry id.
- Worker: one episode = one entry download (episode audio via its
  `contentUrl`, else `/api/items/{itemId}/file/{ino}`; cover copied same as
  books). Same constraints/force semantics, same `.part` + rename + size
  verification.
- SessionManager: `resolve` order for an episode play becomes
  downloaded-episode → local `wear_` session (episodeId preserved in the
  session + progress ids) → else stream (v1 path). Books unchanged.
- UI: ItemScreen episode rows get a small download state affordance driven by
  `ItemActions.forStatus` (reused as-is) + `status(item, ep)`; precheck gains
  `episodeDownloaded: Boolean = false` — a downloaded episode is `Ok` with no
  creds (mirrors books). DownloadsScreen rows show episode entries with their
  podcast title + episode title. Extend ItemActionsTest's tables.

## Standalone watch login (lane B2, wave B)

- Endpoints (both already proven in the phone code):
  - Login: `POST {server}/login`, JSON `{username, password}`, 15s timeout →
    200 `{user}`; access = `user.accessToken ?: user.token`, refresh =
    `user.refreshToken` (may be absent), `user.id`, `user.username`. Error
    mapping copied from the phone's ConnectScreen: 401/403 "Invalid username
    or password.", no-response "Couldn't reach the server.", 429 "Too many
    attempts…", 5xx "The server had a problem…".
  - Refresh: `POST {server}/auth/refresh`, EMPTY JSON body, header
    `x-refresh-token: <refreshToken>`, 20s timeout → 200 with
    `user.accessToken` (+ optional rotated `user.refreshToken` — when absent,
    KEEP the token that just worked). ONLY a 401/403 from this endpoint kills
    the session; network errors/5xx leave it alive for a later retry.
    A watch-owned refresh token has NO cross-device rotation hazard — it is a
    separate ABS session from the phone's (the v1 hazard was SHARING one).
- `Creds` (Models.kt — B2 touches ONLY this data class) gains
  `source: CredsSource` (`PHONE`/`WATCH`) and `refreshToken: String?`.
  DataStore keys `abs_source` ("phone"/"watch", absent = phone) and
  `abs_refresh_token` (only ever written for watch logins).
- CredsRepository: `set(...)` keeps writing PHONE-source (existing callers
  unchanged); new `setWatchLogin(server, token, refreshToken?, userId,
  username)` (WATCH source, same identity-wipe rules); new
  `updateAccessToken(token, refreshToken?)` for refresh results (no wipe).
  PRECEDENCE in `applyFromDataLayer`: non-blank phone creds always apply
  (phone stays primary; overwrites a watch login). Blank/logout applies ONLY
  when the CURRENT source is PHONE — a watch login survives phone logout.
- AbsClient: single-flight blocking refresh (`synchronized`, double-check the
  token actually changed) callable from BOTH the interceptor and `execute` on
  a 401 when the current creds are WATCH-source with a refresh token: refresh,
  then retry the request ONCE with the new token. Refresh request is built
  directly on the bare client (no interceptor recursion — mark it with a
  private header or build via a separate OkHttpClient with no interceptor).
  PHONE-source 401 keeps v1 behavior (terminal authFailed). Refresh 401/403 →
  clear watch session? NO — set authFailed=true only; the connect screen's
  copy covers "sign in again".
- UI: ConnectScreen gains "Sign in on watch" launching ONE RemoteInput intent
  with THREE RemoteInputs (keys `server`, `username`, `password` — the
  platform chains the three input steps), then a progress state, then the
  error line on failure. SettingsScreen gains a "Sign out (watch)" chip
  visible only when source == WATCH (calls `clear()`).
- Manifest `standalone` flip to `true` is INTEGRATION-owned (done with docs).

## v2 testing

Same rules as v1. New tables that MUST be tests: search parsing (book+podcast
merge, cap, null-vs-empty), tile state selection (no-creds / no-last-item /
full), index v2 migration (v1 row → book entry, bad row loss), episode
entry id sanitization, precedence matrix for applyFromDataLayer
(phone-creds/phone-logout × phone-source/watch-source), refresh decision
(source × refresh-token × response code), login error mapping.
