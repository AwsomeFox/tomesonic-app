# Server Feature Requirements

Features the app **cannot ship alone** — they need changes on a backend. Two
backends are involved:

- **Audiobookshelf (ABS)** — the upstream open-source media server
  (`advplyr/audiobookshelf`). Changes here would be upstream contributions (or a
  fork).
- **ReadMeABook (RMAB)** — the companion book-request service the app connects
  to for discovery/requests. Changes here are ours to make.

Client-only features (the majority) are planned in
[`CLIENT_FEATURE_PLAN.md`](./CLIENT_FEATURE_PLAN.md). This document covers only
what genuinely requires server work, plus the **RMAB SSO** improvements and the
**ABS improvements** that would most help the mobile client.

Verdicts confirmed against ABS server source (`MeController.js`,
`CollectionController.js`, `PodcastController.js`, `NotificationManager.js`,
`CronManager.js`, and the `MediaProgress`/`Podcast` models).

---

## Part A — Audiobookshelf server changes

### A1. Per-user ratings & reviews  — *needed for: ratings/reviews*
**Status today:** None. There is no `userRating`/`review` field on any user or
`MediaProgress` model; book metadata has no per-user rating either. The RMAB
BookDate preferences already gate on a future `supportsRatings` capability, so
recs would improve from explicit ratings too.

**What the server needs:**
- New model `MediaRating` (or fields on a per-user media record): `userId`,
  `mediaItemId`, `value` (e.g. 0.5–5 in half-steps), optional `review` (text),
  `updatedAt`.
- Endpoints:
  - `GET /api/me/item/{id}/rating` — the caller's rating for an item.
  - `PUT /api/me/item/{id}/rating` — set/update `{ value, review? }`.
  - `DELETE /api/me/item/{id}/rating`.
  - Optionally expose an aggregate (`averageRating`, `ratingCount`) on the item.
- Include the caller's rating in the media-progress or item payload so the client
  can render stars without an extra round-trip.

**Client-only fallback (can ship now):** a **local** rating stored on-device that
only tunes client rec heuristics — no cross-device sync, no reviews. Full
ratings/reviews need the above.

---

### A2. Ebook highlights / notes / annotations sync — *needed for: synced highlights & notes*
**Status today:** None. ABS stores only reading *position* for ebooks
(`ebookLocation` = CFI, `ebookProgress` = 0–1 on the `MediaProgress` record). No
annotations API exists; the SMIL/media-overlay references in this repo live only
inside the client's bundled Foliate renderer, not the server.

**What the server needs:**
- New model `EbookAnnotation`: `id`, `userId`, `libraryItemId`, `type`
  (`highlight` | `note` | `bookmark`), `cfiRange` (or start/end CFI), `text`
  (selected text), `note` (user note), `color`, `createdAt`, `updatedAt`.
- Endpoints:
  - `GET /api/me/item/{id}/annotations`
  - `POST /api/me/item/{id}/annotations`
  - `PATCH /api/me/item/{id}/annotations/{annotationId}`
  - `DELETE /api/me/item/{id}/annotations/{annotationId}`
  - Optional batch upsert for offline flush.

**Client-only fallback (can ship now):** local-first highlights keyed by CFI
range (see client plan §3.5). Design the local store to map 1:1 onto the model
above so enabling sync later needs no data migration.

---

### A3. Whispersync-style read-along / media overlays — *needed for: word/sentence-level immersion*
**Status today:** None. No SMIL, EPUB3 media-overlay, or per-word/sentence
audio↔text timing anywhere in the server. The app already links reading and
listening *positions* (approximate percent handoff via `utils/formatSwitch.ts`),
which is the client-only ceiling — true immersion needs alignment data.

**What the server needs:**
- Generate or ingest alignment data per book:
  - Ingest EPUB3 **media-overlay SMIL** when present in the source, **or**
  - Run **forced alignment** (audio ↔ text) as an optional background job to
    produce a fragment/timestamp map.
- Store a normalized alignment artifact (e.g. per-fragment `cfi` ↔ `startTime`/
  `endTime`).
- Endpoint: `GET /api/items/{id}/media-overlay` (or `/alignment`) returning the
  fragment map (paged/segmented for large books).

**Effort:** Large / ecosystem-level. This is the app's unique differentiator but
the lowest-feasibility item; the position-linking we already have is the
pragmatic 80%.

---

### A4. Mobile push notifications (new episodes, re-engagement) — *needed for: real push*
**Status today:** ABS has an **Apprise**-based notification system
(`NotificationManager` → `Database.notificationSettings.appriseApiUrl`) firing on
events like `onPodcastEpisodeDownloaded`, `onRSSFeedFailed`, `onBackupCompleted`.
But it is **admin-global** (a single settings row), pushes **outbound to an
Apprise server**, has **no per-user targeting**, and exposes **no endpoint a
mobile client can subscribe to** — no APNs/FCM device registration.

**What the server needs:**
- Per-user device-token registration:
  - `POST /api/me/push-tokens` `{ platform: "fcm"|"apns", token }`
  - `DELETE /api/me/push-tokens/{token}`
- Server-side delivery to registered devices (FCM/APNs) for per-user events:
  new podcast episode for a subscribed show, "next book in your series is now
  available," optional inactivity nudges.
- Per-user notification preferences (`/api/me/notification-settings`).

**Client-only fallback (can ship now):**
- **Local scheduled** nudges (e.g. "haven't listened in 3 days") via
  `expo-notifications` / local scheduling — no server.
- **Poll** `GET /api/podcasts/{id}/checknew` and library "recently added" on
  foreground and surface an in-app badge — approximates "new episode" without
  push.

Note: the app's podcast **auto-download** itself needs **no** server change — ABS
`CronManager` already schedules and runs it; the client just surfaces the
existing `Podcast` model settings (see client plan §2.4). Only *push* is server
work.

---

### A5. Per-user private favorites/wishlist flag *(optional)* — *nice-to-have*
**Status today:** No `isFavorite` flag. Collections exist but are **shared/global**
(not per-user private); playlists are per-user.

**What would help:** a first-class per-user `favorite` flag on the media-progress
record (`GET`/`PUT /api/me/item/{id}/favorite`) so favorites don't have to
piggyback on collections/playlists.

**Client-only fallback (can ship now):** local favorites, or a per-user
**playlist**/collection named "Want to Read" (client plan §2.7). The flag is only
a convenience.

---

### A6. Server-computed recommendations ("because you listened") *(optional)*
**Status today:** The `personalized` shelves include `discover`, but it is
essentially random/newly-surfaced, **not** affinity-computed. Shelf ids today:
`continue-listening`, `continue-reading`, `continue-series`, `recently-added`,
`recent-series`, `discover`, `listen-again`, `read-again`, `newest-authors`.

**What would help:** a genuine affinity/recommended shelf computed server-side
from listening history + metadata, exposed as a new `personalized` shelf id.

**Client-only fallback (can ship now):** compute a simple genre/author affinity
on-device from finished items + `GET /api/libraries/{id}/filterdata` and render a
client shelf (client plan §2.5). Good enough for v1; a server rec engine is a
quality upgrade, not a prerequisite.

---

## Part B — ReadMeABook (RMAB) SSO changes

### B1. Native OAuth via the system browser + app redirect (replace the WebView UA hack)
**Status today:** RMAB OIDC/SSO runs inside an **embedded WebView**
(`components/RmabSsoLoginModal.tsx`) driving the server's browser-oriented
`/api/auth/oidc/login` and scraping the JWT bundle from the callback URL hash
(`#authData=<uri-encoded JSON>`). Because Google blocks embedded WebViews with
**"Error 403: disallowed_useragent,"** the modal spoofs a Chrome mobile
user-agent to get federated (Google-backed) IdPs to proceed. This is a
documented, pragmatic **workaround** — it's fragile (Google can tighten the
policy), less secure (the app's WebView sees IdP credentials), and won't satisfy
IdPs that hard-block non-browser agents.

**Target (what ABS already does):** ABS OpenID in this same app uses the **system
browser** via `expo-web-browser` `WebBrowser.openAuthSessionAsync(...)` with
**PKCE** (`code_challenge`/`S256`) and a registered app redirect scheme
(`utils/oauth.ts`). RMAB should support the identical pattern so we can delete
the WebView + UA hack entirely.

**What RMAB needs to add:**
1. **Register a mobile redirect URI** on the RMAB OAuth/OIDC client — an app deep
   link, e.g. `tomesonic://rmab-auth` (the app already owns the `tomesonic://`
   scheme; add this path). Allow it as a valid `redirect_uri`.
2. **Support Authorization Code + PKCE** for the mobile client (public client, no
   secret): accept `code_challenge`/`code_challenge_method=S256` on the authorize
   request and verify `code_verifier` on token exchange.
3. **Return via the redirect, not a scraped hash:** redirect to
   `tomesonic://rmab-auth?code=…&state=…`; the app exchanges the code at a token
   endpoint (below). (If keeping the current bundle approach short-term, at least
   deliver it to the **registered app redirect** opened in the system browser
   rather than an in-app WebView.)
4. **Token endpoint** for the code exchange returning the RMAB JWT pair:
   `POST /api/auth/oidc/token` `{ code, code_verifier, redirect_uri }` →
   `{ token, refreshToken, expiresAt, user }` (the same bundle the app parses
   today via `parseRmabAuthData`).
5. **`state` + PKCE validation** server-side to prevent CSRF/interception.

**App side (once RMAB supports the above):** replace `RmabSsoLoginModal`'s WebView
with `WebBrowser.openAuthSessionAsync(authorizeUrl, "tomesonic://rmab-auth")`,
generate PKCE like `utils/oauth.ts`, exchange the code, and store the bundle —
removing `SSO_USER_AGENT` and the `react-native-webview` dependency for auth.
This fixes the Google block properly and is more secure.

### B2. Refresh-token rotation & a mobile refresh endpoint
**Status today:** The app captures a JWT pair from the SSO bundle and detects
session expiry with a reconnect banner, but re-auth means running the whole SSO
flow again.

**What RMAB needs to add:**
- `POST /api/auth/refresh` `{ refreshToken }` → new `{ token, refreshToken,
  expiresAt }`, with **rotation** (old refresh token invalidated) and a sane
  lifetime, so a long-lived mobile session refreshes silently instead of
  bouncing the user back through the IdP.
- Return `expiresAt` on every token response so the client can refresh
  pre-emptively (it already models an expiry banner).

### B3. Consistent auth mode capability discovery
**Status today:** The app distinguishes `jwt` (full) vs `apiToken` (limited)
modes client-side and gates BookDate on server capabilities.

**What would help:** a small `GET /api/auth/capabilities` (or fields on an
existing status endpoint) advertising supported flows (`pkce`, `refresh`,
`oidc`, `apiToken`) and feature flags (`supportsRatings`, `bookdateEnabled`) so
the client stops inferring them and can present the right connect options.

---

## Priority summary

| Item | Backend | Priority | Client fallback exists? |
|------|---------|----------|--------------------------|
| B1 RMAB native OAuth (kill WebView UA hack) | RMAB | **High** (ours; fixes Google block properly) | Current WebView hack works but is fragile |
| B2 RMAB refresh-token rotation | RMAB | High | Re-run SSO on expiry |
| A4 Mobile push (new episode / re-engagement) | ABS | Medium | Local nudges + polling |
| A1 Ratings & reviews | ABS | Medium | Local-only rating (no sync/reviews) |
| A2 Highlights/notes sync | ABS | Medium | Local-first highlights |
| B3 RMAB capability discovery | RMAB | Low | Client inference |
| A5 Per-user favorites flag | ABS | Low | Local / playlist-backed |
| A6 Server-computed recs | ABS | Low | Client affinity heuristic |
| A3 Read-along / media overlays | ABS | Low (high effort) | Percent-based position handoff |

**Recommendation:** the only server items worth doing *soon* are the **RMAB**
ones (B1/B2) — they're ours, and B1 replaces a fragile Google-WebView workaround
with the same robust system-browser+PKCE flow the app already uses for ABS. All
the ABS-side items have working client-only fallbacks today, so they can wait for
upstream contribution or a decision to fork.
