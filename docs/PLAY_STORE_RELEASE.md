# Play Store release readiness — closed testing → production

Living checklist for taking TomeSonic from internal testing to a Google
production review. Split into **[code]** (done in this repo) and
**[console]** (done by the account owner in the Play Console — no code).

Package: `com.tomesonic.app` · Deploy: Actions → **Deploy to Play Store**
(`.github/workflows/deploy-playstore.yml`).

---

## TL;DR — the two real blockers

1. **Reviewer access.** The app is useless without an Audiobookshelf server, so
   Google reviewers hit the login wall. Solved by the **"Try the demo"** path
   (points the app at a public read-only demo server) + demo credentials in
   Play Console → **App access**. See [Demo / reviewer access](#demo--reviewer-access).
2. **Closed-test-before-production rule.** Personal developer accounts created
   after 2023‑11‑13 must run a **closed test with ≥12 testers opted in for 14
   continuous days** before applying for production. This is a calendar cost,
   not an engineering one — start the closed test early. (Organization accounts
   are exempt — confirm which you have.)

Everything else below is straightforward.

---

## How the tracks map

The deploy workflow's `track` input maps to Play's tracks:

| workflow `track` | Play Console track |
| ---------------- | ------------------ |
| `internal`       | Internal testing (current) |
| **`alpha`**      | **Closed testing** ← next step |
| `beta`           | Open testing |
| `production`     | Production |

**To push to closed testing:** run the deploy workflow with `track: alpha`
(same pipeline you use for internal), after creating a closed-testing track +
tester list in the Console.

---

## Technical gates — [code], mostly already met

- [x] **Target API level** — Expo SDK 57 / RN 0.86 → **targetSdk 36 (Android
      16)**. Meets Play's current requirement (35) and the 2026 requirement
      (36). Nothing to do.
- [x] **Signed AAB** via Play App Signing (upload keystore in CI secrets).
- [x] **64-bit** (RN/Hermes arm64) — satisfied by the RN build.
- [ ] **Permissions justification** — the app requests, and must be able to
      justify in the Console/data-safety:
      - `INTERNET` — talk to the user's ABS server.
      - `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` (from
        react-native-track-player) — background audio playback.
      - `POST_NOTIFICATIONS` — media notification / playback controls.
      - `READ/WRITE_EXTERNAL_STORAGE` (maxSdk 32) — legacy download storage.
      - `SYSTEM_ALERT_WINDOW` — (verify it's still needed; overlays draw
        scrutiny — remove if unused).
      - Photo access (expo-image-picker) — custom cover upload.
      - **Stripped:** `ACTIVITY_RECOGNITION` is removed in the manifest (it was
        pulled in transitively and trips the health/fitness gate).
- [ ] **Cleartext traffic** (`usesCleartextTraffic: true`) — required so users
      can reach self-hosted `http://` LAN servers. Legitimate; note it in the
      data-safety "data in transit" answer (the app already warns the user on
      the login screen when a connection is plain http).

---

## Play Console store setup — [console], one-time

- [ ] **Store listing:** app name, short description (80), full description
      (4000), app icon (512²), **feature graphic (1024×500)**, **phone
      screenshots** (≥2; refreshed set tracked below), category (Music & Audio
      or Books & Reference), tags, contact email + website.
- [ ] **Privacy policy URL** — required. Draft lives at
      [`docs/PRIVACY_POLICY.md`](./PRIVACY_POLICY.md) (host it on GitHub Pages
      or your domain and paste the URL here). **[code]** drafts it; **[console]**
      hosts + links it.
- [ ] **Data safety form** — mapping worksheet at
      [`docs/DATA_SAFETY.md`](./DATA_SAFETY.md) (generated from a code audit of
      what actually leaves the device: the user's ABS server, Sentry crash
      reporting, and nothing else). **[console]** transcribes it into the form.
- [ ] **Content rating** (IARC questionnaire).
- [ ] **App content declarations:** ads (none), target audience & age, news
      (no), COVID (no), data safety (above), government (no), financial (no),
      health (no).
- [ ] **App access** — because login is required, provide the demo server URL +
      demo credentials + a one-line "tap **Try the demo** on the first screen"
      instruction, so reviewers can reach core functionality.

---

## Demo / reviewer access — [code]

Add a **"Try the demo"** button to the Connect screen that points the app at a
public read-only Audiobookshelf demo instance and signs in automatically, so
both new users and Play reviewers can explore the app without their own server.

- [ ] Wire the button (pending confirmation of the demo server URL + demo
      account username/password from the owner).
- [ ] Add demo URL + credentials to Play Console → **App access**.

---

## Store screenshots — [code]

Existing screenshots predate the recent UI (Library hub, Material 3 dialogs,
reader, home-screen widgets). Refresh to the current build:

- [ ] Capture phone screenshots (home shelves, library hub, player, reader,
      widgets) from the latest build.
- [ ] (Optional) 7"/10" tablet screenshots.

---

## Suggested sequence

1. **[code]** Land: privacy policy draft, data-safety worksheet, "Try the demo"
   button, refreshed screenshots.
2. **[console]** Fill store listing + data safety + content rating + app access;
   host the privacy policy.
3. **[console]** Promote a build to **Closed testing** (`track: alpha`), recruit
   **≥12 testers**, keep the test running **14 days**.
4. **[console]** Apply for production access; submit for review with the demo
   credentials in App access.
