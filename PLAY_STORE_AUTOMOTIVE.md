# Play Store — Android Automotive OS App

Sibling of [`PLAY_STORE_DEPLOYMENT.md`](PLAY_STORE_DEPLOYMENT.md), which still applies in
full: same Play listing, same service account, same upload keystore, same
"Deploy to Play Store" workflow. Sibling too of
[`PLAY_STORE_WEAR.md`](PLAY_STORE_WEAR.md), which this file mirrors section for
section on purpose — the watch went through all of this first, and where the car
differs, the difference is called out rather than re-derived. This file is only
what the **car** artifact adds: the Play Console work that has to happen before
and around a release that includes it.

Two kinds of statement below, kept apart on purpose:

- **Repo fact** — verifiable in the files named. If the code and this file
  disagree, the code wins; fix the file.
- **Play policy** — moves without notice. Every policy claim links the official
  page. Open the link at release time; do not trust a number copied into a repo
  doc.

Scope check before you start: the car app is **browse + stream + download +
offline progress sync + voice search**, with **on-car sign-in and a settings
screen as its only app-drawn UI**. Everything the driver actually looks at —
browse lists, now playing, transport controls — is drawn by the car's own Media
Center around this app's `MediaLibraryService`. There is no launcher icon, and
nothing in the app is reachable while driving except media browse and playback
(see [`native/automotive/ARCHITECTURE.md`](native/automotive/ARCHITECTURE.md)
§5 and §10, the binding contract). Nothing in the listing, screenshots, or
release notes may promise more than that.

## What ships

| | Phone | Watch | Car |
|---|---|---|---|
| Gradle module | `:app` (`native/android/app`) | `:wear` (`native/wear`) | `:automotive` (`native/automotive`) |
| `applicationId` | `com.tomesonic.app` | `com.tomesonic.app` | `com.tomesonic.app` — the **same**, deliberately |
| AAB | `native/android/app/build/outputs/bundle/release/app-release.aab` | `native/wear/build/outputs/bundle/release/wear-release.aab` | `native/automotive/build/outputs/bundle/release/automotive-release.aab` |
| versionCode | stamped by `native/scripts/set-version.mjs` | derived: phone + `1_000_000` | derived: phone + `2_000_000` |
| minSdk / targetSdk | Expo defaults (`rootProject.ext`) | 30 / **35**, pinned literally | 28 (every AAOS head unit is Android 9+) / **35**, pinned literally |
| Play device filter | — | `<uses-feature android:name="android.hardware.type.watch" />` | `<uses-feature android:name="android.hardware.type.automotive" android:required="true" />` |
| Launcher icon | yes | yes | **none, ever** — AAOS opens media apps from the Media Center by explicit intent |
| Sign-in | the app's own screens | phone mirror, or on-watch RemoteInput | on-car full-screen form, **parked only** (the car decides that, not the app) |

## One listing, three artifacts

Repo fact. The car app is not a second Play listing and not a second package.
`native/automotive/build.gradle` sets `applicationId 'com.tomesonic.app'` — it
must equal the phone's, both because all three apps share one listing and
because that is Google's strong recommendation for a car build of an existing
app (it is also what `:wear` already does).

What is *not* optional is the separate artifact. Contract §12, first bullet:

> **Dedicated AAOS track, mandatory**: media apps → Android Automotive OS track
> only; one artifact cannot serve mobile + AAOS.

[`.github/workflows/deploy-playstore.yml`](.github/workflows/deploy-playstore.yml)
builds unscoped `bundleRelease` from `native/android`, so **one** Gradle
invocation produces all three AABs and signs all three with the upload key from
the `-PMYAPP_UPLOAD_*` props. A "Verify all AABs exist" step then fails the run
with a message naming the cause if any of the three is missing (the usual cause
being a prebuild that dropped `include ':wear'` or `include ':automotive'` from
`native/android/settings.gradle`; `plugins/withWearApp.js` and
`plugins/withAutomotiveApp.js` re-inject them). The workflow uploads in **three
steps**: the phone AAB to the chosen track, the wear AAB to `wear:` + that track
name, the automotive AAB to `automotive:` + that track name — Play manages
form-factor releases on their own tracks, which come into existence with the
form-factor opt-in
([form-factor tracks](https://support.google.com/googleplay/android-developer/answer/13295490)).
The prefixes are the Play Developer API's `TrackConfig.formFactor` enum
(`default`, `WEAR`, `AUTOMOTIVE`), so `automotive:internal` …
`automotive:production` are the four car tracks.

The upload order is **phone → wear → automotive**, and it is load-bearing: the
car step runs last so a missing or unreviewed car track can never block
artifacts that are already shipping. On a head unit, Play offers the car
artifact by its `android.hardware.type.automotive` `uses-feature` declaration
([AAOS media apps](https://developer.android.com/training/cars/media/automotive-os)).

Play App Signing re-signs all three artifacts with the one app signing key, so
nothing about the shared package changes when the car artifact joins.

### versionCodes

Play requires every artifact in a listing to carry its own `versionCode`, and a
code may never decrease
([rules for multiple APKs](https://developer.android.com/google/play/publishing/multiple-apks#Rules)).
Repo fact: the car code is derived at Gradle configure time in
`native/automotive/build.gradle` — it parses `versionCode (\d+)` out of
`../android/app/build.gradle` and adds `2_000_000`; `versionName` is copied
verbatim. Nothing to bump by hand. The release workflow stamps the phone file
once and both form-factor modules follow.

Worked example, at the versions in the tree today (`native/android/app/build.gradle`
is at `versionCode 20153`, `versionName "2.10.0"`):

| Release | Phone versionCode | Watch versionCode | Car versionCode | versionName |
|---|---|---|---|---|
| current | 20153 | 1020153 | 2020153 | 2.10.0 |
| next | 20154 | 1020154 | 2020154 | 2.10.1 |

The 2 000 000 offset is arbitrary but load-bearing, exactly as the watch's
1 000 000 is: it sits above the watch band, which sits above any phone code this
app will ever reach, so one stamp yields three monotonic, non-colliding series.
Do not "fix" a car code by hand in the console — change the phone code and
rebuild.

## First release: Play Console setup (one time)

Console menus get reshuffled; the path below is the contract's, and the labels
("Form factors", "Advanced settings") survive the reshuffles even when the
parent menu moves. If a path is missing, search the console for the label.

### 1. Opt in to the Android Automotive OS form factor

Contract §12, verbatim:

> **Opt-in**: Play Console → Test and release → Advanced settings → Form factors
> → Add → Android Automotive OS (needs AAOS screenshots + a bundle on a testing
> track + review-policy agreement + dedicated-track selection).

Read that list as a checklist of *preconditions*, not steps to improvise around:

- **AAOS screenshots** — the two floors in [§4](#4-store-assets-for-the-car).
  Have the PNGs in hand before you start the opt-in.
- **A bundle on a testing track** — run the deploy workflow at `internal` first.
  Uploading a release that contains the automotive AAB *before* opting in is
  harmless in itself, but the `automotive:internal` track does not exist yet, so
  the third upload step fails at "Validating track" (the phone and wear releases
  above it have already gone out — that is the ordering working as designed).
  Practically: opt in first, then run the deploy that seeds the car track.
- **Review-policy agreement** — the car program's terms, accepted in the console.
- **Dedicated-track selection** — the AAOS track is where the car artifact lives,
  permanently; it is not a temporary staging choice.

### 2. Android Automotive OS review

Car review is stricter than the watch's, and the ladder is the whole reason the
first submission is planned rather than dispatched in a hurry. Contract §12,
verbatim:

> **Review ladder** (car review is stricter than wear's): `automotive:internal`
> (no form-factor review) → closed testing (**non-blocking** review with a
> written non-compliance email — the free dress rehearsal) → open testing /
> production (**blocking**; rejected artifacts must be removed before
> resubmitting). With the shared package, review is "Blocking (all APKs)" — so a
> first AAOS submission never rides an urgent phone release; car releases go out
> on their own `automotive:` dispatch.

Three consequences worth spelling out:

1. **Use the dress rehearsal.** `automotive:internal` gets you onto real head
   units with no form-factor review at all; closed testing then gets you a
   written non-compliance email *without* blocking the release. Anything the car
   reviewers would reject at production is cheapest to learn there.
2. **"Blocking (all APKs)" is the price of the shared package.** One listing,
   one package, so a car rejection can hold up the whole submission — the phone
   artifact included. That trade was taken deliberately (contract §12, "Decision
   taken"); the mitigation is procedural, not technical.
3. **The mitigation, concretely.** A first AAOS submission rides its **own**
   `automotive:` dispatch — never a bundled urgent phone release. Note the shape
   of the workflow when you plan that run: `deploy-playstore.yml` always uploads
   all three artifacts, so "its own dispatch" means picking a run whose phone and
   wear releases you are *content to have sitting in review* — never stapling the
   first car submission onto a hotfix you need out today.

**What the reviewers actually exercise.** The car quality bar is
[car app quality guidelines](https://developer.android.com/docs/quality-guidelines/car-app-quality)
territory; contract §10 maps the tier-2 ("Car Optimized") items that bite this
app to the code that satisfies them. The rows below are the ones a reviewer
touches by hand — read §10 for the full table and its owners, and re-read the
guidelines page itself, since criterion IDs move between revisions.

| ID | What the reviewer does | Where TomeSonic Car stands |
|---|---|---|
| PE-1 | Tries to reach app UI while the car reports driving | By construction: sign-in and settings are the only activities, and neither carries `distractionOptimized` — the platform blocks them while driving. `ManifestRulesTest` asserts that absence (`noComponentIsMarkedDistractionOptimized`) |
| — | Looks for a launcher icon (there must not be one) | No `ACTION_MAIN`/`CATEGORY_LAUNCHER` anywhere in the car manifest; `ManifestRulesTest.thereIsNoLauncherActivity` fails the build if one appears |
| VC-1 | Asks the Assistant to play something | `onSearch`/`onGetSearchResult` are implemented in `AbsLibraryService`; voice play lands on `onSetMediaItems`. Wave 6's emulator rig will check it end to end |
| DR-1/2/3 | Times the first browse screen and taps around it | Root tree pre-warmed on service create and persisted to disk for cold start, 45 s fresh / 10 min stale-on-failure cache, 5 s connect / 10 s read timeouts, lazy Continue-Series (contract §7) |
| MA-1 | Watches for autoplay with no user action | The only resumption path is the Media Center's own resume affordance |
| EP-2 | Kills and relaunches mid-book | Resume target and position come from the creds store's `lastItem` |

Review runs asynchronously against a submitted release. Opting in on Monday does
not mean cars see the app on Monday, and the car queue is slower than mobile —
see [First-time gotchas](#first-time-gotchas).

### 3. Review credentials — the demo ABS server

This is the car release's biggest non-code risk, and it is a **release-checklist
item, not a nice-to-have**. Contract §12, risk 1:

> **Risk 1 — review credentials**: TomeSonic is self-hosted; a reviewer with no
> server sees an empty app.

A reviewer who cannot sign in cannot exercise browse, playback, voice search, or
any of the quality-bar rows above — and on a blocking rung that is a rejection.
So, before the first submission:

- [ ] A **reachable demo ABS instance** — a real URL a reviewer's head unit can
      hit from the open internet, not a LAN address.
- [ ] Seeded with **public-domain audio**: books across **two libraries** plus
      **one podcast** (two libraries because the browse tree's `__LIBRARIES__`
      level and per-library categories are only visibly correct with more than
      one; the podcast because episode browse is a separate code path).
- [ ] **Some partial progress** already recorded, so Continue Listening, the
      `"42% • Title"` title prefixes and the progress badges are populated
      rather than empty.
- [ ] **Credentials in the Play Console review notes** (server URL, username,
      password), with a one-line pointer that the sign-in screen has a **"Use
      demo server"** link that fills the server field.
- [ ] **Kept live through the whole review window** — including re-review after
      any resubmission. A demo server taken down mid-review reads exactly like a
      broken app.

Repo fact, and the coupling to watch for: the prefill is
`SignInViewModel.DEMO_SERVER` in
`native/automotive/src/main/java/com/tomesonic/app/automotive/ui/SignInViewModel.kt`,
currently the placeholder `https://demo.tomesonic.example`, pinned by a test row
in `native/automotive/src/test/java/com/tomesonic/app/automotive/ui/SignInViewModelTest.kt`
(`the demo server prefill is a well-formed origin`). **When the real instance
exists, the constant and that test row change together** — deliberately, so the
value a reviewer types can never slip in unnoticed via a diff. The test also
requires the new value to survive `normalizeEntry` unchanged: a scheme, no
trailing slash.

Contract §12 leaves one open question for the owner — *who hosts that instance*.
Everything else here proceeds without the answer; the first submission does not.

### 4. Store assets for the car

The phone listing, description, feature graphic, and phone/tablet screenshots
are **unchanged**. The watch's screenshot set is unchanged too. The new asset is
the Android Automotive OS screenshot set, and the opt-in will not complete
without it.

Play policy — check the
[preview-asset help page](https://support.google.com/googleplay/android-developer/answer/9866151)
at release time; these are the two floors the contract (§11) pins the capture rig
to:

- At least **2 landscape** screenshots at **1024 × 768 px**.
- At least **2 portrait** screenshots at **800 × 1280 px**.
- Captured on a **generic system image** — a stock AAOS emulator or head unit, not
  a manufacturer skin.
- **No device frames, no added backgrounds, no marketing text.** App interface
  only. This is the rule form-factor submissions get bounced on most often.
- JPEG or 24-bit PNG, no alpha.

The two bundled AAOS emulator profiles — `Automotive (1024p landscape)` (1024 ×
768) and `Automotive Portrait` (800 × 1280) — produce **exactly** those two
sizes, which is why the capture rig matrixes over precisely those profiles and
why a raw `screencap` from either needs no scaling or cropping.

Screens worth shipping, in this order — the car story end to end:

1. **Media Center browse root** — Continue Listening, Continue Series, Downloads,
   Libraries.
2. **Now playing** — cover, chapter title, the car's transport controls.
3. **A library or series level** — the progress badges and `"42% • Title"`
   prefixes doing their job.
4. **Sign-in** (parked) — the screen a reviewer will see first.

Capturing by hand, off an AAOS AVD or head unit:

```bash
adb devices                                          # find the head unit / AVD serial
adb -s <car-serial> exec-out screencap -p > car-browse.png
```

Remember there is **no launcher activity**: you cannot `am start` your way into
this app the way the watch rig does. Open it from the car's own Media Center and
capture from there. (The Media Center's intent action and media-component extra —
what lets a script skip the tapping — are the emulator spike's to pin and land in
`native/automotive/screenshots/README.md` with the Wave 6 rig; contract §11.
Nothing in the repo records them yet.)

Or let CI take them — **Wave 6**: `.github/workflows/automotive-screenshots.yml`
and `native/automotive/screenshots/` (the mock ABS server, `capture.sh`, and the
VHAL parked/driving smoke step) are specified in contract §11 but are **not in
the tree yet**. Until they land, the set above is captured by hand. Store the
PNGs beside the phone and watch galleries in `screenshots/` (the rig will commit
into `screenshots/automotive/`); phone asset notes live in
[`PLAY_STORE_GRAPHICS_GUIDE.md`](PLAY_STORE_GRAPHICS_GUIDE.md).

### 5. Data safety and privacy

Expect **no changes**. Play's Data safety declaration is per *app*, not per
artifact, so adding the car app does not add a form — but the declaration now
describes the car too, so re-read it once with the car in mind rather than
assuming:

- Same practices, same server of the user's choosing: the car talks only to the
  AudiobookShelf server the user signs into on the head unit. No third-party
  backend is introduced.
- Repo fact: the automotive module ships **no analytics or crash SDK at all** —
  see its dependency list in `native/automotive/build.gradle` (media3, OkHttp,
  DataStore, WorkManager, appcompat/preference; nothing else).
- The car stores an ABS access token in DataStore, and its manifest sets
  `android:allowBackup="false"` precisely so that token can never ride an
  auto-backup onto hardware the server never authorized.
- Permissions requested on the car: internet/network state, wake lock, foreground
  service (media playback + data sync), post notifications. No location, no
  microphone, no contacts, no ads ID. (Voice search arrives through the
  Assistant's browse/search calls — the app never touches the mic itself.)
- An `AbstractAccountAuthenticator` is registered (mandatory for car media apps,
  contract §6) so the head unit's own Settings can manage the account. Tokens
  stay in the DataStore, not in `AccountManager` userData.

The privacy policy URL already on the listing covers the app as a whole and needs
no edit; see [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) and
[`PRIVACY_POLICY_GUIDE.md`](PRIVACY_POLICY_GUIDE.md).

### 6. Target API level

Repo fact: `:automotive` pins `targetSdkVersion 35` **literally** in
`native/automotive/build.gradle`, with a comment saying not to replace it with
`safeExtGet` — same treatment `:wear` gives its 35, and for the same reason: a
phone-driven target bump must not silently change car behavior.

Play tracks the Android Automotive OS target-API requirement **separately from
phones and tablets**, and the AAOS row is the more relaxed one — at the time of
writing mobile moves to 36 while AAOS stays at 35, so 35 satisfies the current
car requirement.

**Re-check the deadline table at every release**:
[Target API level requirements for Google Play](https://developer.android.com/google/play/requirements/target-sdk).
The dates in that table are the whole point of the page; a number pasted here
would be wrong within a year.

## Releasing

No new workflow, no new secrets, no extra step. Exactly the flow in
[`PLAY_STORE_DEPLOYMENT.md`](PLAY_STORE_DEPLOYMENT.md):

1. **GitHub → Actions → "Deploy to Play Store" → Run workflow.**
2. `version` — e.g. `2.10.1`. `versionCode` — leave blank (defaults to current+1);
   the car code follows automatically at +2 000 000. `track` — `internal` for the
   first car release. `releaseNotes` — optional, en-US, 500 chars max; blank keeps
   the previous release's notes.
3. The workflow stamps the version files, commits and tags, builds **three** AABs,
   and uploads them as **three Play releases**: the phone AAB to the chosen track,
   the wear AAB to `wear:<track>`, and the automotive AAB to
   `automotive:<track>`. The car tracks exist only after the one-time
   form-factor opt-in ([§1](#1-opt-in-to-the-android-automotive-os-form-factor)) —
   until then the automotive upload step fails at "Validating track", after the
   phone and wear releases have already gone out.
4. Alternatively `git tag v2.10.1 && git push origin v2.10.1` releases to the
   **alpha** track — that is the fallback in `deploy-playstore.yml`
   (`track: ${{ github.event.inputs.track || 'alpha' }}`), and the car step
   inherits it as `automotive:alpha`.

Then, in the console: **Test and release → Releases** → there are now **three
releases**: the main track's (phone bundle, e.g. 20153), the Wear OS track's
(1020153) and the Android Automotive OS track's (2020153 — the console groups
form-factor tracks under their own heading once the opt-in is done). If the car
release is missing, check the deploy run's "Upload automotive AAB to Play Store"
step and the `include ':automotive'` line in `native/android/settings.gradle`.

### First-time gotchas

- The automotive AAB gets its **own release on a dedicated form-factor track**
  (`automotive:` + the track name). It cannot ride inside the main track's
  release — the watch already paid for that lesson: the upload succeeds and the
  Play API then rejects the final commit with an opaque 500 `Internal error
  encountered` (deploy run 32809119310 is the receipt). `deploy-playstore.yml`
  therefore uploads in three steps, phone first, car last.
- **Car form-factor review takes longer than mobile**, and it runs
  **asynchronously after** you submit a release containing the automotive
  artifact. Budget for it: an AAOS submission is not a same-day promotion, and on
  open testing / production it is *blocking* — plan the first one onto its own
  dispatch with nothing urgent riding along
  ([§2](#2-android-automotive-os-review)).
- If Play rejects the commit telling you changes must be sent for review
  manually — which a **first release on a new form-factor track** sometimes does —
  re-run the workflow with the `changesNotSentForReview` input set to `true`.
  The input exists for exactly this; it is passed to all three upload steps.
- `adb install` of the car APK **needs `-s <serial>`**. All three artifacts carry
  the same `applicationId`, so a bare `adb install` on a machine with a phone
  attached cheerfully installs the car app over the phone build (or vice versa).
  Same trap [`PLAY_STORE_WEAR.md`](PLAY_STORE_WEAR.md) documents for the watch.
- The release build does **not** skip lint: `bundleRelease` drags
  `lintVitalRelease` in for `:automotive` too, so a lint-vital error in the car
  module fails the release job. The classic is a manifest `<service>`/`<activity>`
  naming a class that does not exist yet — `github-releases.yml` passes `-x lint`
  and PR CI never runs lint-vital, so **the deploy job is where you find out**.
  (Contract §5 makes "declare a component only in the wave that lands its class"
  a hard rule for this reason.)
- **There is no launcher icon on the head unit.** A tester reporting "it didn't
  install" has almost always looked at the app launcher. The car app appears
  inside the **Media Center's** source/app picker and nowhere else.
- Because phone, watch and car are **separate releases on separate tracks**, they
  can be halted independently in the console: a car-only bug means halting the
  AAOS track's release while the phone release stays live. What stays shared: the
  listing, the package name, the review verdict on a blocking rung, and the
  version-bump commit that produced all three.
- Repo sharp edge: `deploy-playstore.yml` uploads with `status: completed`, i.e.
  a full rollout, and does not pass a `userFraction`. Staged rollouts have to be
  set up in the console after the fact (or the workflow has to be changed).
  Consider that before pointing a first car release at `production` — and note
  that on the car you would be doing it against a *blocking* review.
- `inAppUpdatePriority: 2` is set on the **phone** release only — in-app updates
  are not a form-factor mechanism, so neither the wear nor the automotive upload
  step passes one.

## Testing before you promote

Do all three before promoting a car release past internal/alpha.

### 1. Internal track, on a head unit or an AAOS emulator

Push the release to `internal` (`automotive:internal` — the rung with **no**
form-factor review), make sure the Google account signed in on the car is a
tester on that track, then install from the Play Store on the head unit. On an
emulator, an `android-automotive` system image (API 34/35) covers everything but
real-car audio focus.

Verify, in this order — it is also the order a reviewer will hit them:

- The app appears in the **Media Center's** app picker (not a launcher).
- **Signed out**: the session surfaces a "Sign in" affordance that opens the
  sign-in activity while parked; signing in with the demo credentials populates
  browse.
- Browse the root: Continue Listening, Continue Series, Downloads, Libraries.
- Stream a book; check progress lands on the server.
- Download a book, put the car offline, play the downloaded copy, come back
  online and confirm the queued progress flushes.
- Ask the Assistant to play a title (VC-1).

If the app does not appear on the car at all, the usual causes are, in order: the
form-factor opt-in is not done, the AAOS review has not passed for that track, or
the account is not on the tester list.

### 2. Sideload the debug APK

Repo fact: `build-apk.yml` uploads an artifact containing the car APK from
`native/automotive/build/outputs/apk/debug/`, and `github-releases.yml` attaches
`tomesonic-automotive-<tag>.apk` to every GitHub Release (debug-signed — that
workflow never receives the upload-key props).

```bash
adb devices                                            # head unit often over `adb connect <ip>:5555`
adb -s <car-serial> install -r automotive-debug.apk
```

`-s <car-serial>` is not optional — see the gotcha above.

### 3. The parked/driving gate

The one behavior a phone or watch cannot rehearse. On the emulator, drive it from
the Extended-controls car properties (contract §11): gear **P** ⇒ parked, and a
non-zero `PERF_VEHICLE_SPEED` with a gear other than P ⇒ driving. Confirm that
sign-in and settings are reachable parked and **unavailable while driving**, and
that media browse and playback keep working in both states. That is PE-1
evidence, not just a screenshot — Wave 6 turns this pass into a CI smoke step
(contract §11).

Local builds of the same artifacts, from `native/android`:

```bash
./gradlew :automotive:assembleDebug        # automotive-debug.apk
./gradlew :automotive:bundleRelease        # automotive-release.aab (debug-signed without the -P props)
./gradlew :automotive:testDebugUnitTest    # what android-unit-tests.yml runs
```

### Then promote

**Test and release → Releases →** the internal release **→ Promote release →**
closed testing / open testing / production. Take the closed-testing rung on the
way up even if you are impatient: it is the **non-blocking** review with a
written non-compliance email, and it is the only place a car rejection costs
nothing ([§2](#2-android-automotive-os-review)).

## Pre-release checklist

Copy this into the release PR or issue.

```markdown
### Play Console (first car release only)
- [ ] Android Automotive OS form factor added (Test and release → Advanced settings → Form factors)
- [ ] Car review-policy / program terms accepted, dedicated AAOS track selected
- [ ] AAOS screenshots uploaded: ≥2 landscape 1024×768 + ≥2 portrait 800×1280,
      generic system image, no frames
- [ ] Demo ABS server live and reachable: two libraries + a podcast of
      public-domain audio, some partial progress seeded
- [ ] SignInViewModel.DEMO_SERVER (and its SignInViewModelTest row) point at that
      real server, not the placeholder
- [ ] Demo credentials + the "Use demo server" hint written into the Console review notes
- [ ] First submission planned on its OWN automotive: dispatch — nothing urgent
      riding along (car review is blocking, and "Blocking (all APKs)")
- [ ] Data safety declaration re-read with the car in mind — no changes needed
- [ ] Privacy policy URL still resolves

### Every release that includes the car
- [ ] `native/automotive` targetSdk still satisfies the current Android Automotive OS
      row of the target-API table (developer.android.com/google/play/requirements/target-sdk)
- [ ] `:automotive:testDebugUnitTest` green in CI
- [ ] Release notes claim nothing outside scope (browse, stream, download, offline
      progress sync, voice search, on-car sign-in — no app-drawn browse UI)
- [ ] "Deploy to Play Store" run with the intended version and track
- [ ] Play release shows THREE app bundles, car code = phone code + 2 000 000
- [ ] Installed from the internal track onto a head unit or AAOS emulator
- [ ] Signed in on the car from signed-out, via the Media Center's sign-in affordance
- [ ] Streamed a book; downloaded one, played it offline, progress flushed on reconnect
- [ ] Assistant voice play reached the app (VC-1)
- [ ] Parked/driving gate checked: sign-in + settings unavailable while driving
- [ ] Demo ABS server confirmed live for the review window
- [ ] AAOS review status checked before promoting to open testing / production
```
