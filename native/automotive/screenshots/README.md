# Automotive screenshot rig

`.github/workflows/automotive-screenshots.yml` boots an Android Automotive OS
emulator on CI (once per head-unit profile), serves demo data from `mock_abs.py`
(stdlib Python, endpoints and field names matched to `media/BrowseTree.kt` and
the browse half of `data/AbsApi.kt`), installs the `:automotive` DEBUG apk,
signs the car in through the debug-only `DebugSeed` broadcast receiver
(`src/debug/` — debuggable builds only, and the class is not in the release
source set at all), and drives `capture.sh`.

Captures land in `native/automotive/screenshots/out/` during the run and are
committed to `native/automotive/screenshots/shots/` by a bot commit whose
message carries the skip-ci marker; the run's artifact carries the same PNGs
plus the uiautomator dumps, the logcat and the mock-server log.

(ARCHITECTURE.md §11 sketches the committed directory as `screenshots/automotive/`
at the repo root, mirroring where the wear rig puts its PNGs. This rig keeps them
next to the rig instead — `native/automotive/screenshots/shots/` — so the whole
car surface lives under one directory. The consequence is that the bot commit
lands inside this workflow's own push-path filter, which is why the workflow
carries both `[skip ci]` and an excluding `!…/shots/**` glob.)

Triggers: any push touching this directory, `src/debug/`, or the workflow file,
plus manual dispatch. Two emulator legs are ~50 emulator minutes, so it is
deliberately not a PR check.

## The no-launcher wrinkle

This artifact has **no launcher activity** (ARCHITECTURE.md §5) — AAOS shows no
icon for a media app and opens it by explicit intent from the Media Center. So,
unlike the wear rig, `capture.sh` cannot `am start` a main activity. It opens
the car's Media Center *at our browse service* instead:

```sh
adb shell am start -a android.car.intent.action.MEDIA_TEMPLATE \
  --es android.car.intent.extra.MEDIA_COMPONENT \
     com.tomesonic.app/com.tomesonic.app.automotive.media.AbsLibraryService
```

`AbsLibraryService` is a media3 `MediaLibraryService` that also answers the
legacy `android.media.browse.MediaBrowserService` action, which is what makes it
resolvable as the "MediaBrowserService" the extra names.

The two parked-only activities *are* startable by component, because both are
exported and both are started from outside the app in production too:

```sh
adb shell am start -n com.tomesonic.app/com.tomesonic.app.automotive.ui.SignInActivity
adb shell am start -n com.tomesonic.app/com.tomesonic.app.automotive.ui.SettingsActivity
```

## Verified vs to-confirm

Everything the rig depends on, and what each claim rests on. "Verified" means
checked against a published API surface or Google's own documentation while this
rig was written; "to-confirm" means only a booted emulator can settle it, and
`capture.sh` prints a message naming the assumption when it breaks.

| Thing | Value | Status |
|---|---|---|
| Media Center action (all hosts) | `android.car.intent.action.MEDIA_TEMPLATE` | **Verified** — AOSP `android.car.Car.CAR_INTENT_ACTION_MEDIA_TEMPLATE`; `developer.android.com/training/cars/media/automotive-os`: "All media host apps support `MEDIA_TEMPLATE` intents" |
| Media Center action (newer hosts) | `androidx.car.app.mediaextensions.action.MEDIA_TEMPLATE_V2` | **Verified** — androidx `car/app/app/api/current.txt`, `MediaIntentExtras.ACTION_MEDIA_TEMPLATE_V2`. Used only as a fallback |
| Media component extra | `android.car.intent.extra.MEDIA_COMPONENT` | **Verified** — `MediaIntentExtras.EXTRA_KEY_MEDIA_COMPONENT` resolves to this AOSP string (it is **not** namespaced under `androidx.…`, and there is no `androidx.car.app.action.MEDIA_TEMPLATE` at all). Value is the flattened `ComponentName` of the browse service |
| Other media extras (unused here) | `android.car.media.extra.SEARCH_QUERY`, `androidx.car.app.mediaextensions.extra.KEY_MEDIA_ID`, `…extra.KEY_SEARCH_ACTION` | **Verified** — same api.txt. `KEY_MEDIA_ID` is V2-only; a future run could open a specific folder with it |
| VHAL inject command | `adb shell cmd car_service inject-vhal-event <PROP_NAME\|0xHEX\|DECIMAL> [areaId] <data> [-t delay_seconds]` | **Verified** — AOSP `CarShellCommand`'s own usage string. `-t` shifts the event *timestamp*; it is not a speed ramp |
| `PERF_VEHICLE_SPEED` | `291504647` (`0x11600207`) | **Verified** — AOSP `android.car.VehiclePropertyIds` |
| `GEAR_SELECTION` | `289408000` (`0x11400400`) | **Verified** — same |
| `PARKING_BRAKE_ON` (not used) | `287310850` (`0x11200402`) | **Verified** — same. Note the hex: it is `0x112…`, not the `0x122…` several blog posts print |
| `VehicleGear.GEAR_PARK` / `GEAR_DRIVE` | `4` / `8` | **Verified** — AOSP `android.car.VehicleGear` |
| Driving vs parked semantics | driving = speed ≠ 0 **and** gear ≠ P; parked = gear P | **Verified** — `developer.android.com/training/cars/testing/emulator` |
| Emulator image | `target: android-automotive`, `arch: x86_64`, `api-level: 34-ext10` + `system-image-api-level: 34-ext9` | **Verified** that the action accepts these inputs (its README) and that this exact pair is what the action's **own** CI matrix runs for AAOS. See the workflow comment for the 35-ext15 upgrade path |
| Hardware profiles | `automotive_1024p_landscape`, `automotive_portrait` | **Verified** as real device ids (they are `avdmanager`/`devices.xml` ids; androidx Compose ships `Devices.AUTOMOTIVE_1024p = "id:automotive_1024p_landscape"`). Whether the runner's `avdmanager` knows both is **to-confirm** — if not, drop `profile:` and the AVD takes the image's default skin |
| Media Center lands on browse (not now-playing) when handed a component | — | **To-confirm.** `capture.sh` presses a "Browse" affordance once and re-shoots the root if `Libraries` is not on screen |
| Browse rows expose text to `uiautomator` | — | **To-confirm.** The taps are text-driven (`tap_text`); a miss saves the dump next to the screenshots and fails with the label it looked for |
| `inject-vhal-event` permitted on the CI image | — | **To-confirm.** Refusal is a recorded failure — the driving half of the smoke test would be proving nothing |
| The image enforces parked-only (CarUxRestrictions) | — | **To-confirm, and deliberately NOT a failure.** If `SignInActivity` is resumed while driving, the run logs a `::warning::` saying the shot is not PE-1 evidence. The platform owns that behaviour: neither activity declares `distractionOptimized` (declaring it is a documented review rejection) |
| `--include-stopped-packages` on the seed broadcast | — | **Verified** as an `am` intent argument (`Intent.parseCommandArgs` → `FLAG_INCLUDE_STOPPED_PACKAGES`). Needed because a freshly installed app is in the stopped state |
| The seed actually landed | `Broadcast completed: result=1` | **Verified by construction**: `DebugSeed` uses `goAsync()` and sets that result code only after the DataStore write, so `am broadcast` blocks until the car is signed in |

## What gets captured

| File | Screen |
|---|---|
| `<profile>-browse-root.png` | The Media Center showing our browse root — Continue Listening, Continue Series, Downloads, Libraries |
| `<profile>-browse-libraries.png` | The library list (`Audiobooks`, `Podcasts`) with server-assigned icons |
| `<profile>-browse-library.png` | One book library's categories |
| `<profile>-browse-books.png` | Recently Added — the cover grid, and the best store-listing candidate |
| `<profile>-sign-in.png` | `SignInActivity`, parked |
| `<profile>-settings.png` | `SettingsActivity`, parked |
| `<profile>-driving-blocked.png` | The screen after `am start` of the sign-in activity **while driving** |
| `<profile>-*-ui.xml`, `<profile>-logcat.txt` | Evidence, artifacts only — never committed |

## Play screenshot sizes

Play's Android Automotive OS listing wants **at least two landscape screenshots
at 1024×768** and **at least two portrait at 800×1280**, from a generic system
image, without device frames. The two bundled emulator profiles are exactly
those two floors:

| Matrix leg | Profile | Pixels | Play slot |
|---|---|---|---|
| 1 | `automotive_1024p_landscape` | 1024×768 | landscape |
| 2 | `automotive_portrait` | 800×1280 | portrait |

So a green run produces store-listing candidates directly — no cropping, no
scaling. The workflow's "report capture sizes" step prints the real pixel size
of every PNG; if it disagrees with this table, the profile changed and the
listing assets need re-checking before upload (PLAY_STORE_AUTOMOTIVE.md).

## Running it locally

The mock server alone, no Android needed:

```sh
cd native/automotive/screenshots
python3 mock_abs.py &
curl -sS localhost:3333/api/libraries
curl -sS localhost:3333/api/me
```

The whole rig against a local AAOS AVD:

```sh
# 1. an Automotive AVD (Studio: Automotive (1024p landscape) / Automotive Portrait)
emulator -avd <your-aaos-avd> -no-boot-anim &

# 2. the mock server on the HOST (the emulator reaches it at 10.0.2.2:3333)
python3 native/automotive/screenshots/mock_abs.py &

# 3. the app
cd native/android && ./gradlew :automotive:assembleDebug

# 4. the capture
SCREENSHOT_PROFILE=local bash native/automotive/screenshots/capture.sh
ls native/automotive/screenshots/out/
```

**The `adb install` trap** (the same one `PLAY_STORE_WEAR.md` documents): the car
build shares `applicationId com.tomesonic.app` with the phone build, so on a
machine with a phone also connected, `adb install` can overwrite the phone app —
pass `adb -s <emulator-serial>` (or set `ANDROID_SERIAL`) when more than one
device is attached.

Seeding credentials by hand, without the rest of the script:

```sh
adb shell am broadcast --include-stopped-packages \
  -n com.tomesonic.app/com.tomesonic.app.automotive.DebugSeed \
  --es debug_abs_server http://10.0.2.2:3333 \
  --es debug_abs_token demo
# -> Broadcast completed: result=1
```

Driving and parked by hand:

```sh
# driving: non-zero speed AND a gear other than P
adb shell cmd car_service inject-vhal-event 291504647 30   # PERF_VEHICLE_SPEED m/s
adb shell cmd car_service inject-vhal-event 289408000 8    # GEAR_SELECTION = GEAR_DRIVE
# parked again
adb shell cmd car_service inject-vhal-event 289408000 4    # GEAR_SELECTION = GEAR_PARK
adb shell cmd car_service inject-vhal-event 291504647 0
```

(The emulator's **Extended controls → Car data / Car sensor data** panel drives
the same properties from the UI, which is the documented manual equivalent.)

## No audio fixture

The wear rig generates `silence.mp3` with ffmpeg because it photographs a
player. This rig photographs **browse**, and the Media Center never requests a
byte of audio while browsing — so there is no ffmpeg step and `/audio/*.mp3`
404s with a log line saying so. If a future capture plays a book, generate the
fixture the way `wear-screenshots.yml` does and point `MOCK_ABS_AUDIO` at it.
