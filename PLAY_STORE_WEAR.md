# Play Store — Wear OS App

Sibling of [`PLAY_STORE_DEPLOYMENT.md`](PLAY_STORE_DEPLOYMENT.md), which still applies in
full: same Play listing, same service account, same upload keystore, same
"Deploy to Play Store" workflow. This file is only what the **watch** artifact
adds — the Play Console work that has to happen before and around a release that
includes it.

Two kinds of statement below, kept apart on purpose:

- **Repo fact** — verifiable in the files named. If the code and this file
  disagree, the code wins; fix the file.
- **Play policy** — moves without notice. Every policy number links the official
  page. Open the link at release time; do not trust a number copied into a repo
  doc.

Scope check before you start: the watch app's v1 is **browse + stream + download
+ offline progress sync**. No search, no tiles, no complications, no Cast, no
on-watch login (see "v1 non-goals" in [`native/wear/ARCHITECTURE.md`](native/wear/ARCHITECTURE.md)).
Nothing in the listing, screenshots, or release notes may promise more than that.

## What ships

| | Phone | Watch |
|---|---|---|
| Gradle module | `:app` (`native/android/app`) | `:wear` (`native/wear`) |
| `applicationId` | `com.tomesonic.app` | `com.tomesonic.app` — the **same**, deliberately |
| AAB | `native/android/app/build/outputs/bundle/release/app-release.aab` | `native/wear/build/outputs/bundle/release/wear-release.aab` |
| versionCode | stamped by `native/scripts/set-version.mjs` | derived: phone + `1_000_000` |
| minSdk / targetSdk | Expo defaults (`rootProject.ext`) | 30 (Wear OS 3+) / **35**, pinned literally |
| Play device filter | — | `<uses-feature android:name="android.hardware.type.watch" />` |
| Standalone | — | `com.google.android.wearable.standalone` = **true** (since v2 — watch sign-in) |

## One listing, two artifacts

Repo fact. The watch app is not a second Play listing and not a second package.
`native/wear/build.gradle` sets `applicationId 'com.tomesonic.app'` — it must
equal the phone's, both because the two apps share one listing and because the
Wearable Data Layer only pairs apps with the same package **and** the same
signature (that's how credentials reach the watch at all).

`.github/workflows/deploy-playstore.yml` builds unscoped `bundleRelease` from
`native/android`, so one Gradle invocation produces both AABs and signs both with
the upload key from the `-PMYAPP_UPLOAD_*` props. The workflow then uploads them
in **two steps**: the phone AAB to the chosen track, the wear AAB to the
dedicated Wear OS form-factor track (`wear:` + the same track name) — Play
manages form-factor releases on their own tracks, which come into existence with
the form-factor opt-in
([form-factor tracks](https://support.google.com/googleplay/android-developer/answer/13295490)).
On a watch, Play offers the wear artifact by its `android.hardware.type.watch`
`uses-feature` declaration
([packaging & distribution](https://developer.android.com/training/wearables/packaging)).

Play App Signing re-signs both artifacts with the one app signing key, so a
Play-installed phone build and a Play-installed watch build always satisfy the
Data Layer's same-package/same-signature rule. Sideloading breaks that — see
[Testing before you promote](#testing-before-you-promote).

### versionCodes

Play requires every artifact in a listing to carry its own `versionCode`, and a
code may never decrease
([rules for multiple APKs](https://developer.android.com/google/play/publishing/multiple-apks#Rules)).
The watch code is derived at Gradle configure time in `native/wear/build.gradle`:
it parses `versionCode (\d+)` out of `../android/app/build.gradle` and adds
`1_000_000`. `versionName` is copied verbatim. Nothing to bump by hand — the
release workflow stamps the phone file and the watch follows.

Worked example, at the versions in the tree today:

| Release | Phone versionCode | Watch versionCode | versionName |
|---|---|---|---|
| current | 20148 | 1020148 | 2.8.16 |
| next | 20149 | 1020149 | 2.8.17 |

The 1 000 000 offset is arbitrary but load-bearing: it is larger than any phone
code this app will ever reach, so the two series can never collide, and both stay
monotonic release over release. Do not "fix" a wear code by hand in the console —
change the phone code and rebuild.

## First release: Play Console setup (one time)

Console menus get reshuffled; the paths below are current as of writing, and the
labels ("Form factors", "Advanced settings") survive the reshuffles even when the
parent menu moves. If a path is missing, search the console for the label.

### 1. Opt in to the Wear OS form factor

**Play Console → your app → Test and release → Advanced settings → Form factors
→ Add form factor → Wear OS** (older console builds file Advanced settings under
**Grow → Store presence**). Accept the Wear OS program terms / review policy when
prompted.

What this unlocks and requires
([packaging & distribution](https://developer.android.com/training/wearables/packaging)):

- Play begins serving the watch artifact to Wear OS devices from this listing.
- The listing gains a Wear OS screenshot slot, and at least one Wear OS
  screenshot becomes **required**.
- The app enters the **Wear OS quality review** queue (next section). The review
  runs asynchronously against a submitted release — opting in does not by itself
  publish anything.

Uploading a release that contains the wear AAB *before* opting in is harmless:
the artifact sits in the release, and watches simply aren't served it until the
opt-in and review land.

### 2. Wear OS review

Play reviews the watch app against the
[Wear OS app quality guidelines](https://developer.android.com/docs/quality-guidelines/wear-app-quality)
before serving it broadly to watches. Criterion IDs (`WO-…`) move between
revisions of that page — read it, don't trust this table. Honest status for
*this* app:

| What the review looks at | Where TomeSonic Wear stands |
|---|---|
| Installs, launches, plays without crashing | Covered by the internal-track pass on a real watch (below) |
| Round-screen rendering: nothing clipped or overlapped at the edges | Wear Compose Material 3 throughout; every screen must be eyeballed on a **round** watch/emulator, not just the square one |
| Ongoing Activity (or Live Update) while playing | Specified in `native/wear/ARCHITECTURE.md` and `androidx.wear:wear-ongoing` is a dependency — confirm the chip actually shows on the watch face while playing |
| Playback state preserved / restored when the app leaves the foreground | Playback lives in a `MediaSessionService`; position resumes from the watch's own store |
| Touch targets and font sizes usable on a watch | Wear M3 defaults; check the custom player controls specifically |
| Credential entry on the watch | Phone-first (Data Layer mirror, the recommended pattern); since v2 the watch ALSO offers its own sign-in via the platform RemoteInput flow — no custom text fields |
| Standalone apps must work phone-free | Watch sign-in + streaming + downloads + offline playback all run with no companion; the `connect` screen offers both paths |
| Listing describes what the watch app does (offline playback etc.), no "Android Wear" wording, no invented features | See [Store assets](#3-store-assets-for-the-watch) |

**What `standalone=true` actually means (since v2).** Repo fact: declared in
`native/wear/src/main/AndroidManifest.xml` because the watch can now sign in on
its own (ConnectScreen's three-step RemoteInput flow, watch-owned refresh
token). The phone mirror remains the primary, zero-typing path and its
credentials take precedence. Consequences worth knowing before you write
listing copy
([standalone apps](https://developer.android.com/training/wearables/apps/standalone-apps)):

- Play now **also serves the app to untethered watches** (no paired handheld,
  or an iOS-paired watch). That is honest: sign-in, browse, stream, download
  and offline playback all work with no phone.
- Wear review for a standalone app checks it genuinely works phone-free — the
  watch sign-in is the answer if a reviewer asks.
- Listing copy: lead with the easy path, keep the escape hatch a footnote —
  *"Sign in once on the TomeSonic phone app and the watch connects itself, or
  sign in directly on the watch."*
- The watch app can still be installed **before** the phone app; the `connect`
  screen offers both paths.

Offline playback: real, via downloads to the watch (`filesDir/downloads/…`), with
progress queued locally and flushed to the server on reconnect. That is worth
saying in the listing — it is the reason the app exists — but it is *downloads*,
not "works without a phone forever": once the mirrored access token expires the
watch needs the phone again for browsing and streaming.

### 3. Store assets for the watch

The phone listing, description, feature graphic, and phone/tablet screenshots are
**unchanged**. The only new asset is the Wear OS screenshot set.

Requirements, per the
[Wear OS quality guidelines](https://developer.android.com/docs/quality-guidelines/wear-app-quality)
and the Play Console
[preview-asset help page](https://support.google.com/googleplay/android-developer/answer/9866151)
(check both — the exact minimum count and pixel floor are the kind of number that
changes):

- At least **one** Wear OS screenshot; it must show the current version of the
  app actually running on Wear OS.
- **1:1 aspect ratio**, minimum **384 × 384 px** at the time of writing. Round
  watches render into a square framebuffer (a Pixel Watch is 450 × 450), so a raw
  `screencap` is already 1:1 and above the floor.
- **No device frames, no added backgrounds, no marketing text.** App interface
  only. This is the rule Wear submissions get bounced on most often.
- JPEG or 24-bit PNG, no alpha.

Capture straight off a watch or a round emulator:

```bash
adb devices                                        # find the watch serial
adb -s <watch-serial> exec-out screencap -p > wear-home.png
```

Screens worth shipping, in this order — they are the v1 story end to end:

1. **Home** — resume card + Continue Listening (what the app opens to).
2. **Player** — cover, chapter title, transport controls (the review specifically
   wants a playback screen).
3. **Downloads** — on-watch copies with sizes (the phone-free selling point).

Store them beside the phone galleries in `screenshots/` so the next release can
retake them from the same list; the phone assets and generation notes live in
[`PLAY_STORE_GRAPHICS_GUIDE.md`](PLAY_STORE_GRAPHICS_GUIDE.md).

Or let CI take them: running
[`.github/workflows/wear-screenshots.yml`](.github/workflows/wear-screenshots.yml)
(workflow_dispatch) boots a round Wear OS emulator against a mock server and
commits the whole set — connect, home, library, item, downloads, player — into
`screenshots/wear/`.

### 4. Data safety and privacy

Expect **no changes**. Play's Data safety declaration is per *app*, not per
artifact, so adding the watch does not add a form — but the declaration now
describes the watch too, so re-read it once with the watch in mind rather than
assuming:

- Same practices, same server of the user's choosing: the watch talks only to the
  AudiobookShelf server the user configured on the phone. No third-party backend
  is introduced.
- The watch module ships **no analytics or crash SDK at all** — see its dependency
  list in `native/wear/build.gradle`.
- The watch stores an ABS access token in DataStore, and the manifest sets
  `android:allowBackup="false"` precisely so that token can never ride an
  auto-backup to another device.
- Permissions requested on the watch: internet/network state, wake lock,
  foreground service (media playback + data sync), post notifications. No
  location, no microphone, no contacts, no ads ID.

The privacy policy URL already on the listing covers the app as a whole and needs
no edit; see [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) and
[`PRIVACY_POLICY_GUIDE.md`](PRIVACY_POLICY_GUIDE.md) for where it is hosted.

### 5. Target API level

Repo fact: `:wear` pins `targetSdkVersion 35` literally in
`native/wear/build.gradle` (the phone app instead inherits Expo's
`rootProject.ext.targetSdkVersion`).

Play tracks the Wear OS target-API requirement **separately from phones and
tablets**, and the Wear row is the more relaxed one — at the time of writing, new
Wear OS apps and updates need API 35, while phones/tablets are a level ahead. So
35 satisfies the current Wear requirement.

**Re-check the deadline table at every release**:
[Target API level requirements for Google Play](https://developer.android.com/google/play/requirements/target-sdk).
The dates in that table are the whole point of the page; a number pasted here
would be wrong within a year. Note also that the Wear quality-guidelines page
carries its own target-API line item which can lag the policy page — where they
disagree, the policy page is the one Play enforces.

## Releasing

No new workflow, no new secrets, no extra step. Exactly the flow in
[`PLAY_STORE_DEPLOYMENT.md`](PLAY_STORE_DEPLOYMENT.md):

1. **GitHub → Actions → "Deploy to Play Store" → Run workflow.**
2. `version` — e.g. `2.8.17`. `versionCode` — leave blank (defaults to current+1);
   the watch code follows automatically at +1 000 000. `track` — `internal` for
   the first watch release. `releaseNotes` — optional, en-US, 500 chars max;
   blank keeps the previous release's notes.
3. The workflow stamps the version files, commits and tags, builds **both** AABs,
   and uploads them as **two Play releases**: the phone AAB to the chosen track,
   and the wear AAB to that track's dedicated Wear OS form-factor track
   (`wear:internal`, `wear:production`, …). The wear tracks exist only after the
   one-time form-factor opt-in (§1 above) — until then the wear upload step
   fails at "Validating track", after the phone release has already gone out.
4. Alternatively `git tag v2.8.17 && git push origin v2.8.17` releases to the
   **alpha** track — that is the fallback in `deploy-playstore.yml`
   (`track: ${{ github.event.inputs.track || 'alpha' }}`).
   `PLAY_STORE_DEPLOYMENT.md` still says tags go to `internal`; the workflow is
   the truth.

Then, in the console: **Test and release → Releases** → there are **two
releases**: the main track's (phone bundle, e.g. 20148) and the Wear OS track's
(wear bundle, e.g. 1020148 — the console groups form-factor tracks under their
own heading once the opt-in is done). If the wear release is missing, check the
deploy run's "Upload wear AAB" step and the `:wear` include in
`native/android/settings.gradle`.

### First-time gotchas

- The wear AAB gets its **own release on a dedicated form-factor track**
  (`wear:` + the track name). It cannot ride inside the main track's release:
  the upload itself succeeds, but the Play API then rejects the final commit
  with an opaque 500 `Internal error encountered` (deploy run 32809119310 is
  the receipt — "Successfully uploaded 2 artifacts", then the commit died).
  `deploy-playstore.yml` therefore uploads in two steps, phone first.
- Form-factor review runs **asynchronously after** you submit a release
  containing the wear artifact. Opting in on Monday does not mean watches see the
  app on Monday. Review status shows in the console under the Wear OS section of
  Advanced settings / the app-content area.
- Because phone and watch are **separate releases on separate tracks**, they can
  be halted independently in the console: a watch-only bug means halting the
  Wear OS track's release while the phone release stays live. What stays shared:
  the listing, the package name, and the version-bump commit that produced both.
- Repo sharp edge: `deploy-playstore.yml` uploads with `status: completed`, i.e.
  a full rollout, and does not pass a `userFraction`. Staged rollouts have to be
  set up in the console after the fact (or the workflow has to be changed).
  Consider that before pointing a first watch release at `production`.
- `inAppUpdatePriority: 2` is set on the **phone** release only — in-app updates
  aren't a wear mechanism, so the wear upload step doesn't pass one.
- The release build does **not** skip lint: `bundleRelease` drags
  `lintVitalRelease` in for `:wear` too, so a lint-vital error in the watch module
  fails the release job (a manifest `<service>` pointing at a class that doesn't
  exist yet is the classic one). `github-releases.yml` passes `-x lint`, so the
  release job is where you find out.

## Testing before you promote

Do all three before promoting a watch release past internal/alpha.

### 1. Internal track, on a real watch

Push the release to `internal`, make sure the Google account signed in on the
watch is a tester on that track, then open the **Play Store on the watch** and
install from there (the paired phone's Play Store can also push an install to the
watch). Verify: launch, connect screen or library, stream a book, download a book,
play the downloaded copy with the phone powered off / out of range, then bring the
phone back and confirm progress lands on the server.

If the app doesn't appear on the watch at all, the usual causes are, in order: the
form-factor opt-in isn't done, the Wear review hasn't passed for that track, or
the account isn't on the tester list. (Since v2 `standalone=true`, an untethered
watch is no longer a cause — Play serves it there too.)

### 2. Sideload the debug APK

Repo fact: `build-apk.yml` uploads an `audiobookshelf-apk` artifact that contains
**both** `app-debug.apk` and `native/wear/build/outputs/apk/debug/wear-debug.apk`.
`github-releases.yml` additionally attaches `tomesonic-wear-<tag>.apk` to every
GitHub Release.

```bash
adb devices                                          # watch usually over `adb connect <ip>:5555`
adb -s <watch-serial> install -r wear-debug.apk
```

`-s <watch-serial>` is not optional. Both APKs carry the same `applicationId`, so
a bare `adb install` cheerfully installs the watch app over the phone build (or
vice versa).

**The signature trap.** The Data Layer only pairs same-package, same-signature
apps. A Play-installed phone app (Play app signing key) plus a sideloaded watch
app (debug key) will *never* exchange credentials, and the watch will sit on the
connect screen forever looking like a bug. Sideload **both sides from the same
build**, or install both from the same Play track. The wear APK attached to
GitHub Releases is debug-signed too (`github-releases.yml` never receives the
upload-key props), so the same rule applies to it.

### 3. The phone → watch handshake is the first-run gate

Nothing else on the watch works until creds arrive. To test it deliberately:
pair the watch, install both apps, **log in on the phone** (or log out and back
in — `writeAutoCreds()` is the choke point that also calls the wear bridge), and
watch the watch move off the connect screen. Reboot-and-reconnect is worth one
pass too: on open, the watch also queries existing DataItems, so creds arrive even
when the app was installed after the phone login.

Local builds of the same artifacts, from `native/android`:

```bash
./gradlew :wear:assembleDebug          # wear-debug.apk
./gradlew :wear:bundleRelease          # wear-release.aab (debug-signed without the -P props)
./gradlew :wear:testDebugUnitTest      # what android-unit-tests.yml runs
```

### Then promote

**Test and release → Releases →** the internal release **→ Promote release →**
alpha / beta / production. Promotion moves the whole release, both AABs included —
there is nothing to rebuild and no second upload to do. (Re-running the deploy
workflow at a higher version against the target track works too, but then you are
shipping an untested build to that track.)

## Pre-release checklist

Copy this into the release PR or issue.

```markdown
### Play Console (first watch release only)
- [ ] Wear OS form factor added (Test and release → Advanced settings → Form factors)
- [ ] Wear OS program / review terms accepted
- [ ] Store listing text mentions the watch app and that the phone app is required
- [ ] Wear OS screenshots uploaded: home, player, downloads (1:1, ≥384×384, no frames)
- [ ] Data safety declaration re-read with the watch in mind — no changes needed
- [ ] Privacy policy URL still resolves

### Every release that includes the watch
- [ ] `native/wear` targetSdk still satisfies the current Wear OS row of the
      target-API table (developer.android.com/google/play/requirements/target-sdk)
- [ ] `:wear:testDebugUnitTest` green in CI
- [ ] Release notes claim nothing outside v1 scope (browse, stream, download,
      offline progress sync — no search/tiles/complications/Cast)
- [ ] "Deploy to Play Store" run with the intended version and track
- [ ] Play release shows TWO app bundles, wear code = phone code + 1 000 000
- [ ] Installed from the internal track onto a real watch (round screen)
- [ ] Streamed a book on the watch
- [ ] Downloaded a book, played it with the phone off, progress synced on reconnect
- [ ] Phone login → watch connect handshake verified from a clean install
- [ ] Wear OS review status checked before promoting to production
```
