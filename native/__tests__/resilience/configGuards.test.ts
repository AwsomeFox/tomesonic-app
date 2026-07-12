/**
 * CONFIG GUARDS — regression tripwires for the player configuration that makes
 * background / doze playback survivable. None of this "tests doze" (impossible
 * in JS); each assertion pins a config literal whose silent loss in a refactor
 * would only surface as overnight-playback death or post-update data loss:
 *
 *  - androidWakeMode: 2 (WAKE_MODE_NETWORK) — the partial wake + WiFi lock
 *    that keeps screen-off playback (and shake detection) alive.
 *  - androidSkipSilence seeded from settings at setupPlayer AND carried by the
 *    live options path (buildPlayerOptions → updateOptions).
 *  - appKilledPlaybackBehavior: StopPlaybackAndRemoveNotification (the current
 *    intended literal — drift is caught).
 *  - progressUpdateEventInterval: 1 — the native 1s events are the
 *    background-proof persistence driver; dropping this re-opens the
 *    "minutes lost on background kill" hole.
 *  - persistence key names (playbackQueue / lastPlaybackSession / autoPlayNext)
 *    and the autoPlayNext default — key drift = silent data loss after update.
 */

jest.mock("react-native-mmkv", () => require("./persistentMmkvDisk.cjs").mmkvDiskModule());
jest.mock("../../utils/api", () => require("./persistentMmkvDisk.cjs").apiMockModule());
jest.mock("../../utils/progressSync", () =>
  require("./persistentMmkvDisk.cjs").progressSyncMockModule()
);
jest.mock("../../utils/autoCreds", () => require("./persistentMmkvDisk.cjs").autoCredsMockModule());
jest.mock("../../utils/upNext", () => require("./persistentMmkvDisk.cjs").upNextMockModule());

const { boot, wipeDisk } = require("./persistentMmkvDisk.cjs");

const BASE = new Date("2026-04-04T10:00:00Z").getTime();

// Fresh module registry per test (via boot): initializePlayer memoizes through
// module-level state (_initPromise), so setupPlayer options are only
// inspectable on a first-ever init.
describe("doze/background survivability config guards (regression tripwires)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    wipeDisk();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("setupPlayer holds androidWakeMode: 2 (WAKE_MODE_NETWORK — partial wake + WiFi lock for screen-off playback)", async () => {
    const w = boot();
    await w.playback.usePlaybackStore.getState().initializePlayer();

    expect(w.TrackPlayer.setupPlayer).toHaveBeenCalledTimes(1);
    const opts = w.TrackPlayer.setupPlayer.mock.calls[0][0];
    // THE doze tripwire: without this the CPU/WiFi suspend mid-stream once the
    // screen is off, and shake-to-extend dies with them.
    expect(opts.androidWakeMode).toBe(2);
    // Native audio-focus handling must stay on (works dozed / in Android Auto).
    expect(opts.autoHandleInterruptions).toBe(true);
  });

  it("androidSkipSilence is SEEDED from persisted settings at setupPlayer time (construction-time state, not just live toggles)", async () => {
    // Persist skipSilence=ON as user settings, then boot a fresh process that
    // initializes the user store from disk before the player comes up.
    let w = boot();
    w.storageHelper.setUserSettings({ skipSilence: true });
    w = boot();
    w.user.useUserStore.setState({
      settings: { ...w.user.useUserStore.getState().settings, ...w.storageHelper.getUserSettings() },
    });

    await w.playback.usePlaybackStore.getState().initializePlayer();

    const setupOpts = w.TrackPlayer.setupPlayer.mock.calls[0][0];
    expect(setupOpts.androidSkipSilence).toBe(true);
    // And the first full options push carries it too (live path, same init).
    const updateOpts = w.TrackPlayer.updateOptions.mock.calls[0][0];
    expect(updateOpts.android.androidSkipSilence).toBe(true);
  });

  it("androidSkipSilence defaults OFF in both the setup literal and the live options", async () => {
    const w = boot();
    await w.playback.usePlaybackStore.getState().initializePlayer();
    expect(w.TrackPlayer.setupPlayer.mock.calls[0][0].androidSkipSilence).toBe(false);
    expect(w.TrackPlayer.updateOptions.mock.calls[0][0].android.androidSkipSilence).toBe(false);
  });

  it("the LIVE options path (buildPlayerOptions via applyJumpOptions) carries skipSilence, the 1s native progress driver, and the full capability set", async () => {
    const w = boot();
    const { Capability } = w.rntp;
    w.user.useUserStore.setState({
      settings: { ...w.user.useUserStore.getState().settings, skipSilence: true },
    });

    await w.playback.applyJumpOptions();

    const opts = w.TrackPlayer.updateOptions.mock.calls.at(-1)![0];
    expect(opts.android.androidSkipSilence).toBe(true);
    // Native 1s progress events = the background-proof persistence driver.
    expect(opts.progressUpdateEventInterval).toBe(1);
    // The COMPLETE capability set must always be pushed (partial pushes wipe
    // the Android Auto layout).
    expect(opts.capabilities).toEqual(
      expect.arrayContaining([
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
        Capability.JumpForward,
        Capability.JumpBackward,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ])
    );
  });

  it("appKilledPlaybackBehavior is StopPlaybackAndRemoveNotification (the intended literal — drift is caught here)", async () => {
    const w = boot();
    const { AppKilledPlaybackBehavior } = w.rntp;
    await w.playback.usePlaybackStore.getState().initializePlayer();

    const opts = w.TrackPlayer.updateOptions.mock.calls[0][0];
    expect(opts.android.appKilledPlaybackBehavior).toBe(
      AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification
    );
    // Pin the wire value too, so an enum rename can't silently change behavior.
    expect(opts.android.appKilledPlaybackBehavior).toBe(
      "stop-playback-and-remove-notification"
    );
  });

  it("persistence key names are unchanged: 'playbackQueue' and 'lastPlaybackSession' (key drift = silent data loss after an update)", () => {
    let w = boot();
    w.playback.usePlaybackStore.getState().addToQueue({ libraryItemId: "b1" });
    // The queue writes under EXACTLY this key…
    expect(JSON.parse(w.storage.getString("playbackQueue")!)).toEqual([{ libraryItemId: "b1" }]);

    w.storageHelper.setLastPlaybackSession({ id: "s1", libraryItemId: "b1", currentTime: 7 });
    expect(w.storage.getString("lastPlaybackSession")).toBeDefined();

    // …and a fresh process reads its state back through the same keys.
    w = boot();
    expect(w.playback.usePlaybackStore.getState().queue).toEqual([{ libraryItemId: "b1" }]);
    expect(w.storageHelper.getLastPlaybackSession()).toEqual(
      expect.objectContaining({ id: "s1", currentTime: 7 })
    );
  });

  it("autoPlayNext defaults ON and is gated by the persisted 'autoPlayNext' key", async () => {
    const w = boot();
    // Default (no key on disk): the finish auto-advance consults the series
    // resolver — its network GET is the observable proof the gate passed.
    w.api.get.mockRejectedValue(new Error("offline")); // resolver no-ops after the gate
    await w.playback.autoAdvanceAfterFinish("item1");
    expect(w.api.get).toHaveBeenCalledWith("/api/items/item1?expanded=1");

    // An explicit false persisted under the key must turn it off. If the key
    // name drifted, this write would be ignored and the GET below would fire.
    w.api.get.mockClear();
    w.storage.set("autoPlayNext", false);
    await w.playback.autoAdvanceAfterFinish("item1");
    expect(w.api.get).not.toHaveBeenCalled();
  });
});
