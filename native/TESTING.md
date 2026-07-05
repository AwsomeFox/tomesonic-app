# Testing conventions (jest-expo + @testing-library/react-native v14)

Run: `npm test` (all), `npx jest __tests__/<area>` (one area),
`npx jest --coverage` (full coverage per jest.config.js `collectCoverageFrom`).

## Non-negotiables

1. **RNTL v14 is ASYNC**: always `await render(...)`, `await fireEvent.press(...)`,
   `await screen.findByText(...)`. A missing `await` fails with
   "`render` function has not been called".
2. **Never edit `jest.setup.ts`, `jest.config.js`, or app source.** Global
   native-module mocks live in jest.setup.ts (MMKV in-memory, TrackPlayer,
   Google Cast, Notifee, Sentry, expo-*, reanimated, safe-area, netinfo,
   webview, vector-icons). Per-test overrides: `jest.mocked(...)` /
   `jest.spyOn(...)` on those, or file-local `jest.mock(...)` for app modules.
   If a test reveals a REAL app bug, do not fix the source — assert current
   behavior with a `// BUG:` comment and list it in your final report.
3. **Own directory only**: write tests only under your assigned
   `__tests__/<area>/` folder.

## Recipes

**Server API**: `utils/api` exports an axios instance. Prefer file-local
`jest.mock("../../utils/api", () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }))`
(add other exports your target file imports), or `jest.spyOn(api, "get")`.
Axios-style rejections carry `{ response: { status } }` — build errors that
shape when testing 401/404 paths.

**Zustand stores** are module singletons — snapshot & restore around tests:
```ts
const initial = useUserStore.getState();
beforeEach(() => useUserStore.setState(initial, true));
```
(`true` = replace). Set test state with `useXStore.setState({...} as any)`.

**MMKV** (`utils/storage`) is a REAL in-memory store: writes persist across
tests in a file — clear keys you touch in `beforeEach`
(`storage.getAllKeys().forEach(k => storage.remove(k))` if needed).

**TrackPlayer**: `import TrackPlayer from "react-native-track-player"` gives
the mock. Every method is a jest.fn. Fire remote events registered by
`playbackService` via the test-only helper `(TrackPlayer as any).__emit("remote-play", payload)`.
`jest.config clearMocks:true` clears CALL DATA before each test but keeps
implementations; re-apply `mockResolvedValue` in `beforeEach` if a test
changed it.

**Timers**: the playback store runs 1s intervals. Use
`jest.useFakeTimers()` + `jest.advanceTimersByTime(1000)`; wrap store-tick
assertions in `await act(async () => { jest.advanceTimersByTime(1000); })`.
Restore real timers in `afterEach`.

**Navigation in component/screen tests**: pass a stub
`const navigation = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()), getParent: jest.fn(() => navigation) }`.
For screens reading `route.params`, pass `route={{ params: {...} }}`.
Full-navigator integration isn't required — screen-level render + interaction
is the target.

**Theme**: components call `useThemeColors()` which works out of the box
(material3 mock returns null → built-in palette). No provider needed unless a
component imports `DynamicThemeContext` directly.

**Icons** render as `<Text>{name}</Text>` with
`accessibilityLabel="MaterialIcons:<name>"` — query icons by glyph text.

**Determinism**: no real network, no real timers left running, no `Date.now()`
assumptions tighter than ±few seconds (or `jest.setSystemTime`).

## E2E (Maestro)

Flows live in `.maestro/flows/` and run against the REAL app on a connected
device/emulator (`brew install mobile-dev-inc/tap/maestro`):

- `npm run e2e` — all flows except login. Assumes the installed app is
  **already logged in** with at least one audiobook library.
- `npm run e2e:smoke` — launch smoke only (no session needed).
- Login (fresh install, opt-in — never hardcode credentials):
  `maestro test .maestro/flows/10-login.yaml -e SERVER_URL=... -e ABS_USER=... -e ABS_PASS=...`

Coverage: cold launch, login handshake, shelf → detail → play → transport →
collapse, search (result opens on top of the overlay — tab-collision
regression), Library/Series browsing (audiobook rows must offer PLAY —
SeriesDetail mapping regression), settings toggle persistence across restart.

Selectors are accessibility labels / visible text — when adding UI, give
interactive elements stable `accessibilityLabel`s so flows stay robust.

Additional core flows: `22-chapters-sleep` (chapter transport + chapters
modal + sleep timer set/cancel), `60-resume` (progress survives an app
kill — session restores on relaunch, item offers Continue), `70-download` +
`71-offline` (download, then play the on-device copy with networking
disabled — 71 is tagged manual because ci-flows.sh toggles the emulator's
network around it via adb).

Reader flow: `80-reader` opens the seeded EPUB (generated in CI by
`.maestro/make-epub.py`), waits for foliate's page indicator, exercises the
TOC/settings sheets, and asserts the Continue Reading shelf appears after
closing — the whole reader→PATCH→shelf progress pipeline. Audio flows take a
`BOOK` env (CI pins "The Test Book by .*" so the ebook card isn't grabbed).
