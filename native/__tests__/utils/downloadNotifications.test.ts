import notifee from "@notifee/react-native";
import {
  downloadNotifications,
  sweepStaleZipNotifications,
} from "../../utils/downloadNotifications";

const display = notifee.displayNotification as jest.Mock;
const cancel = notifee.cancelNotification as jest.Mock;

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

let nowSpy: jest.SpyInstance;
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  display.mockResolvedValue("id");
  cancel.mockResolvedValue(undefined);
});

afterEach(async () => {
  // Take down any live notification state so tests stay independent.
  await downloadNotifications.clear("item1");
  await downloadNotifications.clear("race1");
  nowSpy.mockRestore();
});

describe("start", () => {
  it("shows a 0% ongoing progress notification", async () => {
    downloadNotifications.start("item1", "My Book");
    await flushAsync();

    expect(display).toHaveBeenCalledTimes(1);
    expect(display).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dl_item1",
        title: "Downloading",
        subtitle: "0%",
        body: "My Book",
        android: expect.objectContaining({
          ongoing: true,
          onlyAlertOnce: true,
          progress: { max: 100, current: 0 },
        }),
      })
    );
  });
});

describe("progress", () => {
  it("updates in place with the rounded percent", async () => {
    downloadNotifications.start("item1", "My Book");
    await flushAsync();
    display.mockClear();

    now += 1000;
    downloadNotifications.progress("item1", "My Book", 0.374);
    await flushAsync();

    expect(display).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dl_item1", // same id = in-place update
        subtitle: "37%",
        android: expect.objectContaining({ progress: { max: 100, current: 37 } }),
      })
    );
  });

  it("skips no-op updates for the same whole percent", async () => {
    downloadNotifications.start("item1", "T");
    await flushAsync();
    now += 1000;
    downloadNotifications.progress("item1", "T", 0.371);
    await flushAsync();
    display.mockClear();

    now += 1000; // interval passed, but the pct is unchanged
    downloadNotifications.progress("item1", "T", 0.374);
    await flushAsync();
    expect(display).not.toHaveBeenCalled();
  });

  it("self-throttles updates faster than the minimum interval", async () => {
    downloadNotifications.start("item1", "T");
    await flushAsync();
    now += 1000;
    downloadNotifications.progress("item1", "T", 0.1);
    await flushAsync();
    display.mockClear();

    now += 100; // < 500ms since the last shown update
    downloadNotifications.progress("item1", "T", 0.2);
    await flushAsync();
    expect(display).not.toHaveBeenCalled();

    now += 500; // past the throttle window
    downloadNotifications.progress("item1", "T", 0.3);
    await flushAsync();
    expect(display).toHaveBeenCalledWith(expect.objectContaining({ subtitle: "30%" }));
  });

  it("clamps progress to 0..100", async () => {
    downloadNotifications.start("item1", "T");
    await flushAsync();
    now += 1000;
    downloadNotifications.progress("item1", "T", 1.7);
    await flushAsync();
    expect(display).toHaveBeenLastCalledWith(expect.objectContaining({ subtitle: "100%" }));
  });

  it("ignores progress for items that were already cleared", async () => {
    downloadNotifications.start("item1", "T");
    await flushAsync();
    await downloadNotifications.clear("item1");
    display.mockClear();

    now += 1000;
    downloadNotifications.progress("item1", "T", 0.5);
    await flushAsync();
    expect(display).not.toHaveBeenCalled();
  });
});

describe("complete", () => {
  it("replaces the progress notification with a done one", async () => {
    downloadNotifications.start("item1", "My Book");
    await flushAsync();
    display.mockClear();

    await downloadNotifications.complete("item1", "My Book");

    expect(cancel).toHaveBeenCalledWith("dl_item1");
    expect(display).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dl_done_item1",
        title: "Download complete",
        body: "My Book",
      })
    );

    // Progress after completion is ignored.
    display.mockClear();
    now += 1000;
    downloadNotifications.progress("item1", "My Book", 0.9);
    await flushAsync();
    expect(display).not.toHaveBeenCalled();
  });

  it("still shows the done notification when cancelNotification throws", async () => {
    downloadNotifications.start("item1", "T");
    await flushAsync();
    cancel.mockRejectedValueOnce(new Error("gone"));
    display.mockClear();
    await downloadNotifications.complete("item1", "T");
    expect(display).toHaveBeenCalledWith(expect.objectContaining({ id: "dl_done_item1" }));
  });
});

describe("clear", () => {
  it("cancels the progress notification", async () => {
    downloadNotifications.start("item1", "T");
    await flushAsync();
    await downloadNotifications.clear("item1");
    expect(cancel).toHaveBeenCalledWith("dl_item1");
  });

  it("swallows cancel errors", async () => {
    cancel.mockRejectedValueOnce(new Error("gone"));
    await expect(downloadNotifications.clear("item1")).resolves.toBeUndefined();
  });
});

describe("sweepStaleZipNotifications", () => {
  const getDisplayed = notifee.getDisplayedNotifications as jest.Mock;

  it("cancels only zip-prefixed notifications (dl_zip_* / legacy dl_done_zip_*)", async () => {
    getDisplayed.mockResolvedValue([
      { id: "dl_zip_item1", notification: { id: "dl_zip_item1" } },
      { id: "dl_done_zip_item2", notification: { id: "dl_done_zip_item2" } },
      // A live BOOK download's notification must survive the sweep.
      { id: "dl_book9", notification: { id: "dl_book9" } },
      { id: "dl_done_book9", notification: { id: "dl_done_book9" } },
      // Malformed entries (no id anywhere) are skipped, not thrown on.
      { notification: {} },
    ]);

    await sweepStaleZipNotifications();

    expect(cancel).toHaveBeenCalledWith("dl_zip_item1");
    expect(cancel).toHaveBeenCalledWith("dl_done_zip_item2");
    expect(cancel).not.toHaveBeenCalledWith("dl_book9");
    expect(cancel).not.toHaveBeenCalledWith("dl_done_book9");
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("falls back to the entry-level id when notification.id is absent", async () => {
    getDisplayed.mockResolvedValue([{ id: "dl_zip_item3", notification: {} }]);
    await sweepStaleZipNotifications();
    expect(cancel).toHaveBeenCalledWith("dl_zip_item3");
  });

  it("never throws when notifee fails", async () => {
    getDisplayed.mockRejectedValueOnce(new Error("no notifee"));
    await expect(sweepStaleZipNotifications()).resolves.toBeUndefined();

    // A single failing cancel doesn't stop the rest of the sweep either.
    getDisplayed.mockResolvedValue([
      { id: "dl_zip_a", notification: { id: "dl_zip_a" } },
      { id: "dl_zip_b", notification: { id: "dl_zip_b" } },
    ]);
    cancel.mockRejectedValueOnce(new Error("gone"));
    await expect(sweepStaleZipNotifications()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("dl_zip_b");
  });
});

describe("display/clear race", () => {
  it("takes a notification straight back down when cleared while displaying", async () => {
    let releaseDisplay!: () => void;
    display.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseDisplay = () => res("id");
        })
    );

    downloadNotifications.start("race1", "T");
    await flushAsync(); // showProgress is now awaiting displayNotification
    expect(releaseDisplay).toBeDefined();

    await downloadNotifications.clear("race1"); // cancels once, removes from _active
    cancel.mockClear();

    releaseDisplay();
    await flushAsync();
    // The post-display check noticed the clear and cancelled again.
    expect(cancel).toHaveBeenCalledWith("dl_race1");
  });

  it("swallows displayNotification failures", async () => {
    display.mockRejectedValueOnce(new Error("channel gone"));
    downloadNotifications.start("item1", "T");
    await flushAsync();
    // No unhandled rejection; a later progress still works.
    now += 1000;
    downloadNotifications.progress("item1", "T", 0.5);
    await flushAsync();
    expect(display).toHaveBeenCalledTimes(2);
  });
});

describe("permission denied", () => {
  it("never displays anything when notification permission is denied", async () => {
    jest.resetModules();
    const isolatedNotifee = require("@notifee/react-native").default;
    isolatedNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 0 });
    const { downloadNotifications: dn } = require("../../utils/downloadNotifications");

    dn.start("x", "T");
    await flushAsync();
    dn.progress("x", "T", 0.5);
    await flushAsync();

    expect(isolatedNotifee.displayNotification).not.toHaveBeenCalled();
  });
});

describe("ensurePlaybackNotificationPermission", () => {
  // The runtime POST_NOTIFICATIONS permission only exists on Android 13+.
  // Platform.OS is a getter in jest-expo — defineProperty to override it.
  function setPlatform(os: string, version: number) {
    const { Platform } = require("react-native");
    Object.defineProperty(Platform, "OS", { value: os, configurable: true });
    Object.defineProperty(Platform, "Version", { value: version, configurable: true });
  }

  it("requests permission once and remembers it (no re-prompt on the next launch)", async () => {
    jest.resetModules();
    setPlatform("android", 34);
    const isolatedNotifee = require("@notifee/react-native").default;
    isolatedNotifee.requestPermission.mockClear();
    isolatedNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 1 });
    const { storage } = require("../../utils/storage");
    storage.remove("notifPermRequested");

    const mod = require("../../utils/downloadNotifications");
    await mod.ensurePlaybackNotificationPermission();
    expect(isolatedNotifee.requestPermission).toHaveBeenCalledTimes(1);
    expect(storage.getBoolean("notifPermRequested")).toBe(true);

    // Same JS lifetime → the in-memory guard blocks a second request.
    await mod.ensurePlaybackNotificationPermission();
    expect(isolatedNotifee.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not re-ask when the persisted flag is already set (next launch)", async () => {
    jest.resetModules();
    setPlatform("android", 34);
    const isolatedNotifee = require("@notifee/react-native").default;
    isolatedNotifee.requestPermission.mockClear();
    const { storage } = require("../../utils/storage");
    storage.set("notifPermRequested", true); // as if a previous launch asked

    const mod = require("../../utils/downloadNotifications");
    await mod.ensurePlaybackNotificationPermission();
    expect(isolatedNotifee.requestPermission).not.toHaveBeenCalled();
  });

  it("the download path reads status without re-prompting once the flag is set", async () => {
    jest.resetModules();
    setPlatform("android", 34);
    const isolatedNotifee = require("@notifee/react-native").default;
    isolatedNotifee.requestPermission.mockClear();
    isolatedNotifee.getNotificationSettings.mockClear();
    isolatedNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
    require("../../utils/storage").storage.set("notifPermRequested", true); // asked already
    const mod = require("../../utils/downloadNotifications");

    mod.downloadNotifications.start("dlA", "Book A");
    await new Promise((r) => setTimeout(r, 0));

    expect(isolatedNotifee.requestPermission).not.toHaveBeenCalled();
    expect(isolatedNotifee.getNotificationSettings).toHaveBeenCalled();
    await mod.downloadNotifications.clear("dlA");
  });

  it("does not re-prompt (or display) if the non-prompt status read throws once asked", async () => {
    jest.resetModules();
    setPlatform("android", 34);
    const isolatedNotifee = require("@notifee/react-native").default;
    isolatedNotifee.requestPermission.mockClear();
    isolatedNotifee.getNotificationSettings.mockClear();
    // Already asked → ensureReady must take the non-prompt branch. Make that
    // read fail and assert it never falls back to requestPermission().
    isolatedNotifee.getNotificationSettings.mockRejectedValueOnce(new Error("notifee init"));
    require("../../utils/storage").storage.set("notifPermRequested", true);
    const mod = require("../../utils/downloadNotifications");

    mod.downloadNotifications.start("dlThrow", "Book");
    await new Promise((r) => setTimeout(r, 0));

    expect(isolatedNotifee.requestPermission).not.toHaveBeenCalled();
    expect(isolatedNotifee.displayNotification).not.toHaveBeenCalled();

    // _permChecked stayed false — a later update retries the status read.
    isolatedNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
    mod.downloadNotifications.progress("dlThrow", "Book", 0.5);
    await new Promise((r) => setTimeout(r, 0));
    expect(isolatedNotifee.getNotificationSettings).toHaveBeenCalledTimes(2);
    await mod.downloadNotifications.clear("dlThrow");
  });

  it("never prompts on iOS or on Android < 13 (no runtime permission there)", async () => {
    jest.resetModules();
    setPlatform("ios", 17);
    let isolatedNotifee = require("@notifee/react-native").default;
    isolatedNotifee.requestPermission.mockClear();
    require("../../utils/storage").storage.remove("notifPermRequested");
    await require("../../utils/downloadNotifications").ensurePlaybackNotificationPermission();
    expect(isolatedNotifee.requestPermission).not.toHaveBeenCalled();

    jest.resetModules();
    setPlatform("android", 30); // Android 11 — permission auto-granted
    isolatedNotifee = require("@notifee/react-native").default;
    isolatedNotifee.requestPermission.mockClear();
    await require("../../utils/downloadNotifications").ensurePlaybackNotificationPermission();
    expect(isolatedNotifee.requestPermission).not.toHaveBeenCalled();
  });
});
