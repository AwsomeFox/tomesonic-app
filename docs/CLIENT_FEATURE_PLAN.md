# Client-Only Feature Plan

Implementation plan for the missing ebook/audiobook features that need **no
Audiobookshelf (ABS) or ReadMeABook (RMAB) server changes**. Every item here can
ship from the app alone against endpoints/data that already exist.

Features that require server work are tracked separately in
[`SERVER_FEATURE_REQUIREMENTS.md`](./SERVER_FEATURE_REQUIREMENTS.md).

Verdicts were confirmed against the ABS server source (`advplyr/audiobookshelf`)
and the official ABS Vue/Capacitor app (`advplyr/audiobookshelf-app`), which
already implements several of these client-side (notably Year-in-Review and
named bookmarks) — proving they need no server support.

Effort key: **S** ≈ ≤1 day, **M** ≈ 2–4 days, **L** ≈ 1–2 weeks, **XL** ≈ multi-week.

---

## Tier 1 — high value, small, client-only (do first)

### 1.1 Named / editable audio bookmarks — S
- **Why:** Bookmarks are auto-named with a raw timestamp; users can't label "the twist" or "recipe start."
- **Server:** None. The app already POSTs `{ title, time }` to `/api/me/item/{id}/bookmark`; ABS also exposes `PATCH /api/me/item/{id}/bookmark` (matches by `time`, updates `title`) for rename. Confirmed in ABS source and the Vue `BookmarksModal.vue`.
- **Approach:** Add a title `TextInput` to the "add bookmark" flow in `components/BookmarksModal.tsx` (default to the current timestamp string so behavior is unchanged if left blank). Add an "edit" action per row that PATCHes the new title. Add a `pendingBookmarkRename_` offline queue in `utils/progressSync.ts` mirroring the existing create/delete queues, flushed on reconnect.
- **Tests:** rename online → PATCH called with `{ time, title }`; rename offline → queued then flushed; blank title falls back to timestamp.

### 1.2 Reader themes (sepia/paper) + independent brightness — S–M
- **Why:** The reader only inherits the app's light/dark surface; long-form readers expect a warm paper mode and in-app brightness without leaving the book.
- **Server:** None (render settings are local; ABS only serves the ebook file). The ABS **web** reader already ships a sepia theme (`rgb(244,236,216)` / `#5b4636`) as a purely client theme — precedent to mirror.
- **Approach:** In `screens/ReaderScreen.tsx`, add a reader-scoped theme set (`light`/`sepia`/`dark`/`black`) persisted to MMKV (`reader_theme`), independent of the app theme; pass its bg/fg into the Foliate `bg`/`fg` variables (currently hard-wired to `colors.surface`/`colors.onSurface`). Add a brightness slider that sets an overlay opacity or uses `expo-brightness` (app-scoped) while the reader is focused, restoring on blur.
- **Tests:** theme persists across remounts; Foliate receives the selected bg/fg; brightness restores on unmount.

### 1.3 Reader margin control + page/scroll toggle — S
- **Why:** Margins are hard-coded (16px); no paginated-vs-scrolled choice.
- **Server:** None.
- **Approach:** Add margin stepper (`reader_margin`) feeding the Foliate layout, and a paginated/scrolled toggle (`reader_flow`) passed to the Foliate view. Both persisted to MMKV alongside the existing font/spacing settings.
- **Tests:** each setting persists and reaches the Foliate bundle config.

### 1.4 "Time left in chapter / book" reading estimate — S
- **Why:** The reader shows only a clamped 1–99% and the TOC label; no "12 min left."
- **Server:** None — fraction + a rolling words-per-minute estimate are all local.
- **Approach:** Track a per-session reading-speed EMA in `ReaderScreen` (fraction delta ÷ elapsed), persist a per-book WPM to MMKV, and render "~N min left in chapter / book" in the reader footer. Fall back to a default WPM (≈250) until enough samples exist.
- **Tests:** estimate hidden until a sample exists; computed from fraction delta + elapsed.

### 1.5 Per-book playback-speed memory — S
- **Why:** Speed is effectively global; users want 1.5× for one narrator and 1.1× for another remembered per title.
- **Server:** None (ABS `playbackRate` is a global user setting; per-book override is a client convention). The Vue app confirms rate is global upstream — this is a net-new client nicety.
- **Approach:** Add a `perBookRate: Record<libraryItemId, number>` map in `useUserStore` settings. On book start, apply the per-book rate if present, else the global rate. When the user changes speed while a book is active, write the per-book entry. Add a settings toggle "Remember speed per book" (default on).
- **Tests:** starting a book with a saved rate applies it; changing speed writes the per-book entry; toggle off falls back to global.

---

## Tier 2 — high value, client-only, moderate

### 2.1 In-book full-text search — M
- **Why:** No way to find a phrase or character name inside an open EPUB.
- **Server:** None — Foliate exposes search over the rendered book.
- **Approach:** Wire the Foliate bundle's search API through the `ReaderScreen` WebView bridge; add a search field + results list in the reader toolbar that navigates to the selected match's CFI. PDF search via `react-native-pdf` where supported (otherwise hide for PDF).
- **Tests:** query posts to the bridge; selecting a result calls `goToFraction`/CFI nav; empty-state when no matches.

### 2.2 Tap-to-look-up dictionary — M
- **Why:** No define-on-long-press.
- **Server:** None.
- **Approach:** Add a text-selection handler in the Foliate WebView; on selection, show a bottom sheet with the OS dictionary (`expo` `Linking`/`ACTION_PROCESS_TEXT` on Android, `UIReferenceLibraryViewController` on iOS if/when iOS ships) or an on-device/offline definition source. Keep it graceful when unavailable.
- **Tests:** selection posts the term to RN; sheet renders the term; dismiss restores reading.

### 2.3 Cross-book play queue + auto-play next in series — M
- **Why:** Playback is single-item; finishing book 3 of a series should roll into book 4. Biggest retention lever.
- **Server:** None — series/next-up data is already available; ABS has no play-queue concept, so this is a pure client construct (the Vue app has none either).
- **Approach:** Add a `queue: QueueItem[]` to `usePlaybackStore` (persisted). On `PlaybackQueueEnded`/book-finish, if the finished book is in a series and a next book exists (or the queue is non-empty), auto-advance. Add "Play next" / "Add to queue" actions on item and series screens and a queue view in the player sheet. Respect the existing auto-download-next setting for offline continuity.
- **Tests:** finishing a queued book advances to the next; series auto-next resolves the correct book; empty queue stops cleanly; casting path advances too.

### 2.4 Podcast engagement: auto-download settings, per-podcast config, episode queue — M
- **Why:** Today it's a flat manual latest-episodes list.
- **Server:** None — ABS already schedules and runs auto-downloads via `CronManager`; the `Podcast` model carries `autoDownloadEpisodes`, `autoDownloadSchedule` (cron), `maxEpisodesToKeep`, `maxNewEpisodesToDownload`, and the client updates them via `PATCH /api/items/{id}/media`. `GET /api/podcasts/{id}/checknew` and `POST /api/podcasts/{id}/download-episodes` already exist.
- **Approach:** Add a per-podcast settings screen that reads/writes the model fields above (auto-download on/off, schedule, keep/keep-new counts). Surface "check for new" and a per-podcast episode download queue view over the existing endpoints. (Most of these routes are admin-gated — hide/disable the controls for non-admin sessions.)
- **Tests:** settings PATCH the right fields; non-admin sees read-only; checknew renders results.
- **Note:** *New-episode push notifications* are **not** client-only — see the server doc.

### 2.5 Genre/tag browse + basic "because you listened" — M
- **Why:** Strong search/filters but no genre/tag *browse* surface and no recs.
- **Server:** None for browse and heuristic recs (a true server-computed rec shelf is separate — see server doc).
- **Approach:** Add a genre/tag browse surface from `GET /api/libraries/{id}/filterdata` (`genres`, `tags`), each opening the existing filtered Library list (`items?filter=<type>.<base64>`). For "because you listened," compute a client-side genre affinity from the user's finished items and surface a home shelf querying those genres.
- **Tests:** genres/tags render from filterdata; tapping applies the right base64 filter; affinity shelf excludes finished/started items.

### 2.6 Goals, streak surfacing & Year-in-Review — M
- **Why:** A streak is already computed but buried; no goals; no annual wrap-up. (Per the correction: the ABS Vue app ships Year-in-Review and ABS supports it — so this is client-only.)
- **Server:** None. `GET /api/me/stats/year/{year}` returns `numBooksFinished`, `totalListeningTime`, `topAuthors`, `topGenres`, `mostListenedNarrator`, `mostListenedMonth`, `numBooksListened`, `longestAudiobookFinished`, `finishedBooksWithCovers`. This is exactly what the Vue `YearInReview.vue` renders.
- **Approach:** Add a "Your Year in Audio" screen fed by `/api/me/stats/year/{year}`, rendered as a shareable card (mirror the Vue Canvas approach → an off-screen view captured with `react-native-view-shot` for share). Add a Dec/Jan banner entry from Stats/Home. Surface the existing streak prominently on Stats and add a simple local listening goal (daily/weekly minutes) with progress, persisted to MMKV.
- **Tests:** year screen maps stats fields; share captures an image; goal progress computes from listening-stats; banner shows only in-season.

### 2.7 Wishlist / "Want to Read" + favorites — M
- **Why:** No save-for-later or mark-loved anywhere.
- **Server:** None *required*. ABS has no per-user `isFavorite` flag, but a client "Want to Read" can be built on the existing **collections** API (`POST /api/collections`, `POST /api/collections/{id}/book`, …) or **playlists** (`/api/playlists`, which are per-user), or a purely local list in `useUserStore`.
- **Approach:** Add a "Want to Read"/favorite toggle on item screens. Default to a **local** list (survives no server round-trip, works offline) with an option to back it by a named collection/playlist for cross-device sync. Surface it as a home shelf and a Library filter.
- **Tests:** toggle adds/removes locally; optional collection-backed mode calls the collections endpoints; shelf reflects membership.
- **Note:** *Ratings & reviews* need a server store — see the server doc. A **local-only** rating that only tunes client rec heuristics is the client-only subset and can ship here if desired.

---

## Tier 3 — larger / platform, still client-only

### 3.1 iOS + CarPlay parity — XL
- **Why:** No `ios/` project exists; Android Auto, the Resume widget, and notifications are all Android-native. This caps the market.
- **Server:** None — pure app/platform work.
- **Approach:** Stand up the Expo iOS target (`ios/` via prebuild), port the config-plugin-backed native features that have iOS equivalents, and add a CarPlay scene (`react-native-carplay`) mirroring the Android Auto browse tree. Large, phased; scope in its own epic.
- **Tests:** platform-gated; iOS CI profile in `eas.json`; Maestro iOS smoke where feasible.

### 3.2 Silence trimming & volume normalization/boost — L
- **Why:** "Smart speed" and loudness boost are daily-listener staples for slow or quiet narrators.
- **Server:** None — audio DSP is client/native. `react-native-track-player` (our patched Media3 fork) has no built-in support, so this needs native audio-processing work in the patch (silence detection / gain). Heavy but server-free.
- **Approach:** Prototype in the Media3 layer via `native/patches/react-native-track-player+…patch` (`node_modules` edit → `patch-package`), gated behind a setting; measure battery/CPU before shipping.
- **Tests:** native compile via CI `build-apk`; JS-side setting plumbing unit-tested.

### 3.3 Sleep-timer shake-to-reset + rewind-on-wake — S
- **Server:** None.
- **Approach:** Use the accelerometer (`expo-sensors`) while a timer is armed to extend it on shake; add an optional "rewind N seconds when a timer paused you" using the existing timer/auto-rewind logic.
- **Tests:** shake event extends the armed timer; wake rewind seeks back N.

### 3.4 TTS read-aloud for ebook-only titles — M
- **Server:** None (`expo-speech`).
- **Approach:** Add a play control in the reader for books with no audio counterpart that reads the current section via `expo-speech`, advancing pages as it goes. Robotic quality; clearly a fallback.
- **Tests:** start/stop speech; page advance on section end.

### 3.5 In-reader highlights & notes (local-first) + quote-image share — M (local) / see server doc for sync
- **Why:** The reader has no highlights/notes; the Kindle stickiness habit.
- **Server:** Quote-image share and **local-only** highlights are client-only. **Sync** of highlights/notes needs an ABS annotations API (server doc).
- **Approach:** Use Foliate's selection/annotation support to store highlights locally (MMKV, keyed by book + CFI range). Render a highlights list and a styled quote-image via `react-native-view-shot` for sharing. Design the local store so it can later back onto a server annotations endpoint without a data migration.
- **Tests:** highlight persists locally by CFI; list renders; quote-image capture returns a file.

### 3.6 Tablet/large-screen layout + richer now-playing widget — M
- **Server:** None.
- **Approach:** Add responsive two-pane layouts for large screens; extend the Resume widget to a now-playing/progress widget reading the existing `widget_state.json`.
- **Tests:** layout picks panes by width; widget state serialization unit-tested.

---

## Summary table

| # | Feature | Effort | Server? |
|---|---------|--------|---------|
| 1.1 | Named/editable bookmarks | S | none |
| 1.2 | Reader sepia/paper + brightness | S–M | none |
| 1.3 | Reader margins + page/scroll toggle | S | none |
| 1.4 | Time-left reading estimate | S | none |
| 1.5 | Per-book speed memory | S | none |
| 2.1 | In-book text search | M | none |
| 2.2 | Tap-to-look-up dictionary | M | none |
| 2.3 | Cross-book play queue + series auto-next | M | none |
| 2.4 | Podcast auto-download settings / per-podcast / queue | M | none (push is server) |
| 2.5 | Genre/tag browse + heuristic recs | M | none (true recs are server) |
| 2.6 | Goals + streak + Year-in-Review | M | none |
| 2.7 | Wishlist / favorites (local or via collections) | M | none (ratings are server) |
| 3.1 | iOS + CarPlay parity | XL | none |
| 3.2 | Silence trim / volume boost | L | none (native DSP) |
| 3.3 | Sleep-timer shake / rewind-on-wake | S | none |
| 3.4 | TTS read-aloud | M | none |
| 3.5 | Highlights/notes (local) + quote share | M | none (sync is server) |
| 3.6 | Tablet layout + richer widget | M | none |

**Suggested first batch (best value-per-effort, all S/M, no dependencies):**
1.1 named bookmarks, 1.2 reader themes+brightness, 1.4 time-left, 1.5 per-book
speed, 2.6 Year-in-Review + streak. Then 2.3 cross-book queue as the biggest
retention lever.
