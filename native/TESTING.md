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
