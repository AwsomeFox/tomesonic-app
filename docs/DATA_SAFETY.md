# Play Console — Data Safety form worksheet

Recommended answers for the Play Console **Data safety** section, derived from a
code audit of what actually leaves the device. Transcribe into the Console.
Items marked **⚠ VERIFY** need a decision/confirmation before you submit.

Guiding distinction Google draws:
- **"Collected"** = data leaves the device.
- **"Shared"** = data is sent to a *third party*.
- Data sent **only to the user's own self-hosted server** that the user
  configures is still "collected" (it leaves the device), but you should
  describe it as processed on the user's server, not shared with the developer.

---

## Top-level questions

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all user data encrypted in transit? | **No** — the app supports self-hosted `http://` servers, so transit encryption is not guaranteed (the app warns the user and prefers HTTPS). Third-party calls (Audible/Audnexus/Sentry) are HTTPS. |
| Do you provide a way for users to request deletion of their data? | **Yes, but off-app** — account/server data is deleted by the user's Audiobookshelf server admin; on-device data clears on logout/uninstall. ⚠ VERIFY: Google may want an account-deletion **URL** — provide one if you run a hosted service. |

---

## Data types to declare

### Personal info → Account (username/email/user id)
- **Collected:** Yes. **Shared:** No (goes to the user's own server).
- **Purpose:** App functionality (authentication).
- **Optional:** No (required to use the app).
- Source: `screens/ConnectScreen.tsx:312`, `utils/api.ts:66`.

### App activity → other user-generated / "App interactions"
- Listening progress, positions, bookmarks, playback sessions.
- **Collected:** Yes. **Shared:** No (user's own server).
- **Purpose:** App functionality.
- Source: `utils/progressSync.ts`, `store/usePlaybackStore.ts:2148`.

### Files & docs / Photos → uploads
- Uploaded audio files and custom cover images (photo picker).
- **Collected:** Yes (sent to the user's server). **Shared:** No.
- **Purpose:** App functionality. **Optional:** Yes (only if the user uploads).
- Source: `utils/mediaUploader.ts:95`, `app.json` expo-image-picker.

### Search / library-derived metadata → **shared with third parties**
- Book/author/series titles and ASINs from the user's library are sent to
  **Audible** (`api.audible.com`) and **Audnexus** (`api.audnex.us`) for the
  discovery features.
- **Collected:** Yes. **Shared:** **Yes (third party).**
- **Purpose:** App functionality (content discovery).
- **Optional:** ⚠ VERIFY — there is no in-app toggle today; declare as
  functional, or add an opt-out if you'd rather declare it optional.
- Source: `utils/audible.ts:10,148,222`.

### App info & performance → Crash logs / Diagnostics — ⚠ VERIFY (Sentry)
- Only if the published build injects `EXPO_PUBLIC_SENTRY_DSN`. Then: crash
  logs + device/app info to **Sentry (third party)**. No account PII, no tokens.
- **If enabled:** Collected **Yes**, Shared **Yes (Sentry)**, Purpose =
  Analytics/Crash, Optional = No in-app toggle.
- **If not enabled in the production build:** declare **nothing** here.
- ⚠ VERIFY whether the production build ships a real DSN (not in the repo).
- Source: `utils/sentry.ts:13-26`.

### Device or other IDs
- **None.** Playback `deviceInfo` sent to the server is only a static client
  name/version — no device model, IMEI, or advertising ID.
- No analytics/ads SDKs are bundled.
- Source: `store/usePlaybackStore.ts:2150`.

### Optional feature — RMAB / "BookDate" (declare only if you keep it)
- If the user connects an optional ReadMeABook server: login token, search
  queries, book requests, and (for the AI feature) the user's **library +
  custom prompt** go to that user-configured server.
- **Collected/Shared:** to a user-configured third-party server; **Optional:**
  Yes (fully opt-in).
- Source: `utils/rmab.ts:96,375,531`.

---

## Security practices to check in the form

- ☑ Data is encrypted in transit — **cannot claim unconditionally** (self-hosted
  http). Answer **No** and rely on the per-connection HTTPS + the in-app
  cleartext warning.
- ☑ Users can request data deletion — **Yes** (server-side/admin; on-device on
  logout). Provide instructions/URL.
- Data at rest: tokens/credentials encrypted (expo-secure-store + keystore);
  other settings + progress cache in unencrypted app-private storage.
  Source: `utils/storage.ts:16-40`.

---

## Pre-submit action items (⚠ verify / fix)

1. **Confirm Sentry DSN** in the production build. If shipped → declare crash
   diagnostics + Sentry as a third-party recipient. If not → declare none.
2. **Account-deletion URL.** No in-app "delete my account" flow exists for
   normal users. Decide: (a) point users to their server admin (document it), or
   (b) add an in-app/`web` deletion path if you host a service. Google's form
   asks for this.
3. **`SYSTEM_ALERT_WINDOW`** is declared in the manifest but has **no code
   usage** — overlay permission draws review scrutiny. Verify it's needed
   (cast/widget dependency?) and **remove it if not** to simplify review.
4. **Audible/Audnexus discovery** — decide whether to declare as functional
   (current) or add an opt-out and declare optional.
5. **NetInfo connectivity probe** to `clients3.google.com` — low-risk
   (no personal data); no declaration needed, but be aware of it.
