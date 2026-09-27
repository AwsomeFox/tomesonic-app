# TomeSonic — Privacy Policy

**Effective date:** _TODO — fill in on publish_
**Contact:** _TODO — support email_

TomeSonic ("the app") is an open-source Android client for
[Audiobookshelf](https://www.audiobookshelf.org/), a self-hosted audiobook and
podcast server. **The app does not host, provide, or sell any content or
accounts.** It connects to an Audiobookshelf server that you — or someone you
know — operate, and to that server you supply your own account.

This policy explains what data the app handles, what leaves your device, and to
whom.

## Summary

- **No ads. No advertising IDs. No analytics or tracking SDKs.**
- The app's core data (your login, listening progress, uploads) goes **only to
  the Audiobookshelf server you choose** — not to the app's developer.
- A small number of **optional or feature-specific** third-party services are
  described below (book metadata, optional crash reporting, casting).
- Your credentials and tokens are stored **encrypted** on your device.

## 1. Data you provide to your Audiobookshelf server

When you connect and sign in, the app sends the following **to the server
address you enter** (and to no one else):

- **Account credentials** — your username and password, or an OpenID/SSO login,
  used to authenticate; and the resulting access/refresh tokens sent with each
  request.
- **Listening activity** — playback position, progress, finished state,
  bookmarks, and playback sessions.
- **Uploads (only if you use them)** — audio files you upload, and custom book
  cover images you choose from your photo library.
- **Administration (only if you are a server admin)** — user-management and
  session actions you initiate.

This data is controlled by the operator of the Audiobookshelf server you connect
to, under that server's own policies. If the server is reachable only over plain
`http://` (e.g. a home LAN), this data — including credentials — travels
**unencrypted**; the app warns you on the sign-in screen when a connection is
not encrypted, and uses HTTPS whenever your server offers it.

## 2. Third-party services the app contacts

- **Audible & Audnexus (book metadata).** For discovery features (finding other
  books by an author or in a series, and fetching descriptions), the app queries
  the public Audible catalog (`api.audible.com`) and Audnexus (`api.audnex.us`).
  These requests include book/author/series names and identifiers (ASINs)
  derived from your library. No account credentials are sent.
- **Crash reporting (Sentry) — _if enabled in the build you installed._** When a
  crash-reporting key is configured at build time, uncaught errors are sent to
  Sentry to help fix bugs. This includes error details and general device/app
  information (device model, OS and app version). It does **not** include your
  account username, password, tokens, or listening data. _Note: confirm whether
  your published build ships with this enabled and state it here accordingly._
- **Google Cast — only when you cast.** If you cast to a Chromecast/Google Cast
  device, media stream and cover-art URLs and playback metadata are shared with
  the cast device and Google's cast framework, as required to play on that
  device.
- **Connectivity check.** To detect whether you are online, the app's networking
  library may periodically request a Google connectivity endpoint
  (`clients3.google.com/generate_204`). No personal data is sent.
- **ReadMeABook (RMAB) — optional, only if you configure it.** If you connect an
  optional RMAB server, the app sends the login token/URL you provide, your
  search queries, and book-request details to that server. Its optional
  AI-recommendation ("BookDate") feature additionally sends your library and any
  custom prompt text you enter to that server. This is entirely opt-in.

The app performs **no over-the-air updates or telemetry** to the developer.

## 3. Data stored on your device

- **Encrypted (OS keystore–backed):** your server address, username, and
  access/refresh tokens; any RMAB configuration.
- **Unencrypted app storage:** app settings, UI state, and a cache of your
  listening progress.
- **App files:** audiobooks you download, and cached cover art. These live in
  the app's private storage and are removed when you delete the app.

On-device data is cleared when you log out. Diagnostic logs are stored locally
with secrets (tokens/credentials) redacted, and are not transmitted unless
crash reporting is enabled.

## 4. Permissions

- **Notifications** — to show playback and download controls/progress.
- **Photos** — only when you choose an image to upload as a custom book cover.
- **Foreground service / background audio** — to keep playing when the app is in
  the background.
- **Storage (older Android)** — for downloaded media.

## 5. Account & data deletion

Your account and all of your content and listening data live on the
Audiobookshelf server you connect to, **not** in the app or with the app's
developer. To delete on-device data, log out or uninstall the app. To delete
your **account and server-side data**, contact the operator/administrator of
your Audiobookshelf server (server administrators can delete user accounts on
the server). _TODO: if you distribute as a service with your own server, provide
a direct account-deletion request URL/instructions here, as Google Play
requires._

## 6. Children

TomeSonic is not directed to children and does not knowingly collect data from
children.

## 7. Changes

We may update this policy; the effective date above reflects the latest version.

## 8. Contact

Questions: _TODO — support email_ · Source code:
<https://github.com/AwsomeFox/tomesonic-app>
