# Android Auto (+ Wear) — implementation plan & status

Goal: browse the ABS library **and** control playback from Android Auto (and later
Wear OS), matching the original TomeSonic app.

## Libraries? (answering "is there no RN lib for Auto/CarPlay?")
- **`react-native-carplay` (2.4.x)** — good for **iOS CarPlay** *media* (CPListTemplate +
  now-playing, JS-driven). Use it for CarPlay later.
- Its **Android Auto** side is built on the **Car App Library (androidx.car.app)**, which
  Google restricts to **navigation / parking / charging / IOT** apps. **Media apps are not
  permitted to use it** and must use a **MediaBrowserService**. So it does NOT solve Auto
  browse for an audiobook app. → Android Auto = native, based on `BrowseTree.kt`.

## The architectural wrinkle (important)
Android Auto expects **one media app = one MediaSession that is also browsable**. The
original app satisfied this with a single native `PlayerNotificationService` that was BOTH
the player and the `MediaLibraryService` (+ `BrowseTree`). Our RN app splits these:
**RNTP owns playback + its own MediaSession** (in a headless JS service) and has **no
browse**. A separate browse service would create a *second* session → Auto gets confused
about which session to control.

Two viable paths:
1. **Fork/patch RNTP's `MusicService`** to also be a `MediaLibraryService` and expose
   `onGetChildren`/`onGetLibraryRoot` (feed the tree from JS or from the ABS client). One
   session, correct behavior. Cleanest but touches a node_module (patch-package) or a
   vendored RNTP.
2. **Separate browse `MediaLibraryService`** that, on play, **launches the app / signals JS
   to `startPlayback(itemId)`** so RNTP's session becomes the now-playing session. Browse
   works; "play from Auto" hands to the phone. Simpler to add via config plugin, slightly
   degraded (a beat of app-launch on first play).
Recommend **path 2** first (config-plugin, non-invasive), migrate to **path 1** if the
hand-off feels clunky. Test on the **DHU** either way.

## Browse tree (ported from the original `BrowseTree.kt`)
Root (`/`) children, in order: **Continue** (`__CONTINUE__`, shown when items-in-progress
exist) · **Recent** (`__RECENTLY__`, when recents loaded) · **Libraries** (`__LIBRARIES__`)
· **Downloads** (`__DOWNLOADS__`). `Libraries` → one browsable node per library
(`GET /api/libraries`); a library node → its items (`GET /api/libraries/{id}/items`).
`Continue` → `GET /api/me/items-in-progress`. Each item is a *playable* MediaItem
(title, author subtitle, cover artwork URI). Credentials: JS writes
`${documentDirectory}auto_creds.json` = `{server, token}` on login; the service reads
`filesDir/auto_creds.json` (no native module needed).

## Why it needs native code
`react-native-track-player@4.1.2`'s `MusicService` extends `HeadlessJsTaskService`
(it is **not** a Media3 `MediaLibraryService`/`MediaBrowserServiceCompat`), so it
exposes **no browse tree** to Android Auto. RNTP's media session does give us the
**now-playing** screen in Auto for free once the app is playing — but *browsing* the
library requires a separate native browsable service.

`native/android` is **CNG (prebuild-generated, gitignored)** — all native additions
must go through a **config plugin** (`plugins/*.js` referenced in `app.json`) or a
local Expo module, or they get wiped on the next `expo prebuild`.

## Two levels
1. **Now-playing in Auto (Level 1 — foundation, DONE via `plugins/withAndroidAuto.js`)**
   - Adds `<meta-data android:name="com.google.android.gms.car.application"
     android:resource="@xml/automotive_app_desc"/>` + `res/xml/automotive_app_desc.xml`
     (`<uses name="media"/>`). Safe/non-breaking; makes Auto recognize the app as a
     media app so the existing RNTP media session renders in the car when playing.
2. **Library browse (Level 2 — the big native piece, TODO)** — a browsable service.

## Level 2 design (the native browse service)
Create a **`MediaLibraryService`** (Media3) — call it `AbsAutoService` — added via a
config-plugin `withDangerousMod` that writes the Kotlin file into
`android/app/src/main/java/.../auto/` on prebuild, plus manifest registration:
```xml
<service android:name=".auto.AbsAutoService" android:exported="true">
  <intent-filter>
    <action android:name="androidx.media3.session.MediaLibraryService"/>
    <action android:name="android.media.browse.MediaBrowserService"/>
  </intent-filter>
</service>
```
Responsibilities:
- **onGetLibraryRoot** → a browsable root.
- **onGetChildren(parentId)** → fetch from ABS with an OkHttp client:
  - root → the user's libraries (`GET /api/libraries`) + a "Continue Listening" node.
  - `library:{id}` → items (`GET /api/libraries/{id}/items?limit=100`), mapped to
    browsable/playable `MediaItem`s (title, author subtitle, cover artwork URI).
  - `continue` → `GET /api/me/items-in-progress`.
- **Server address + token**: read from the same MMKV store the JS side uses
  (`react-native-mmkv` persists to a known file) OR mirror them into
  `SharedPreferences` from JS on login (simplest — add a tiny bridge that writes
  `abs_server` / `abs_token` on login). Recommended: SharedPreferences mirror.
- **Playback from the car (onPlaybackResumption / play a mediaId)**: the hard part —
  the browse service is native while playback lives in RNTP's headless JS service.
  Options:
  a. **Bridge to JS**: the service sends an intent/event that wakes the JS service and
     calls `usePlaybackStore.startPlayback(itemId)` (reuse existing logic). Cleanest
     reuse; needs an event path (e.g. a foreground broadcast the RNTP JS listens to).
  b. **Native playback in the service**: give `AbsAutoService` its own Media3 player.
     Avoids the bridge but duplicates playback/progress-sync logic — not recommended.
  Go with (a): mirror credentials to SharedPreferences, and on car-play send
  `libraryItemId` to JS to run the normal `startPlayback` path so cast/progress/etc.
  all keep working.

## Testing
Cannot be tested on a plain emulator. Use the **Android Auto Desktop Head Unit (DHU)**:
`adb forward tcp:5277 tcp:5277` + enable "Head unit server" in Android Auto dev
settings + run the DHU. Or a real car / the Auto phone screen.

## Wear OS (later)
Similar: a `MediaBrowserService` surfaced to Wear's media controls; the now-playing
media session already works. Full browse mirrors the Auto service.

## Status
- [x] Level 1 foundation (config plugin: automotive descriptor + meta-data)
- [ ] `AbsAutoService` MediaLibraryService (browse tree from ABS)
- [ ] Credentials mirror to SharedPreferences on login
- [ ] Car-play → JS `startPlayback` bridge
- [ ] DHU verification
- [ ] Wear browse
