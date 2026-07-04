import notifee from "@notifee/react-native";
import { downloadNotifications } from "../../utils/downloadNotifications";

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
