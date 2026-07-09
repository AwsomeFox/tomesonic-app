/**
 * PodcastSettingsScreen — surfaces a podcast's server-managed auto-download
 * settings: loads the item + current user, PATCHes the podcast media fields on
 * save (admin only), shows non-admins a read-only view, and surfaces the
 * check-new feed results.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import PodcastSettingsScreen from "../../screens/PodcastSettingsScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { useUserStore } from "../../store/useUserStore";

const initialUser = useUserStore.getState();

const PODCAST_ITEM = {
  id: "pod1",
  media: {
    metadata: { title: "My Great Podcast" },
    autoDownloadEpisodes: true,
    autoDownloadSchedule: "0 3 * * *", // Daily
    maxEpisodesToKeep: 10,
    maxNewEpisodesToDownload: 3,
    lastEpisodeCheck: "2026-06-01T08:00:00.000Z",
  },
};

const ADMIN_ME = { id: "u1", username: "admin", type: "admin" };
const USER_ME = { id: "u2", username: "joe", type: "user" };

// Route the two parallel GETs (item + /api/me) by URL.
function mockGet({ me = ADMIN_ME, item = PODCAST_ITEM }: { me?: any; item?: any } = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/me") return Promise.resolve({ data: me });
    if (url.startsWith("/api/items/")) return Promise.resolve({ data: item });
    if (url.includes("/checknew")) return Promise.resolve({ data: { episodes: [] } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen(params: any = { libraryItemId: "pod1" }) {
  const navigation = makeNavigation();
  await render(<PodcastSettingsScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  (showAppDialog as jest.Mock).mockClear();
  (api.get as jest.Mock).mockReset();
  (api.patch as jest.Mock).mockReset();
  (api.patch as jest.Mock).mockResolvedValue({ data: {} });
  mockGet();
});

describe("PodcastSettingsScreen", () => {
  it("loads the item and seeds the podcast title + settings", async () => {
    await renderScreen();

    expect(await screen.findByText("My Great Podcast")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/items/pod1");
    // Daily preset (0 3 * * *) is the seeded schedule → its chip reads selected.
    expect(screen.getByLabelText("Schedule: Daily").props.accessibilityState.selected).toBe(true);
    // Values seeded into the number fields.
    expect(screen.getByLabelText("Max episodes to keep").props.value).toBe("10");
    expect(screen.getByLabelText("Max new episodes to download").props.value).toBe("3");
  });

  it("auto-download switch is the sole control and reflects/toggles checked state", async () => {
    await renderScreen();
    await screen.findByText("My Great Podcast");

    // Exactly one accessible node carries the label — the switch itself — so
    // TalkBack doesn't land on a roleless duplicate actionable row wrapping it.
    const toggle = screen.getByLabelText("Auto-download episodes");
    expect(toggle.props.accessibilityRole).toBe("switch");
    // Seeded on (autoDownloadEpisodes: true) → checked, admin → not disabled.
    expect(toggle.props.accessibilityState.checked).toBe(true);
    expect(toggle.props.accessibilityState.disabled).toBe(false);

    fireEvent.press(toggle);
    await waitFor(() =>
      expect(screen.getByLabelText("Auto-download episodes").props.accessibilityState.checked).toBe(
        false
      )
    );
  });

  it("schedule preset chips extend their touch target with hitSlop", async () => {
    await renderScreen();
    await screen.findByText("My Great Podcast");

    // Chips are 34dp tall; a vertical hitSlop lifts the effective touch target
    // toward the ~44dp minimum.
    const chip = screen.getByLabelText("Schedule: Daily");
    expect(chip.props.hitSlop).toEqual({ top: 6, bottom: 6 });
  });

  it("saves the changed podcast media fields via PATCH (admin)", async () => {
    await renderScreen();
    await screen.findByText("My Great Podcast");

    // Change a limit so the form is dirty, then pick the Weekly preset. Await the
    // controlled value/selection updates so `dirty` is flushed before Save.
    fireEvent.changeText(screen.getByLabelText("Max new episodes to download"), "5");
    await waitFor(() =>
      expect(screen.getByLabelText("Max new episodes to download").props.value).toBe("5")
    );
    fireEvent.press(screen.getByLabelText("Schedule: Weekly"));
    await waitFor(() =>
      expect(screen.getByLabelText("Schedule: Weekly").props.accessibilityState.selected).toBe(true)
    );

    // Save opens a confirm dialog; run its Save button.
    fireEvent.press(screen.getByLabelText("Save podcast settings"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    const dialog = (showAppDialog as jest.Mock).mock.calls[0][0];
    expect(dialog.title).toBe("Save podcast settings");
    const saveBtn = dialog.buttons.find((b: any) => b.text === "Save");
    saveBtn.onPress();

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/items/pod1/media", {
        autoDownloadEpisodes: true,
        autoDownloadSchedule: "0 3 * * 0", // Weekly cron
        maxEpisodesToKeep: 10,
        maxNewEpisodesToDownload: 5,
      })
    );
  });

  // Helper: make the form dirty (valid), press Save, and run the confirm
  // dialog's Save button so the doSave PATCH actually fires.
  async function dirtyAndConfirmSave() {
    fireEvent.changeText(screen.getByLabelText("Max new episodes to download"), "5");
    await waitFor(() =>
      expect(screen.getByLabelText("Max new episodes to download").props.value).toBe("5")
    );
    fireEvent.press(screen.getByLabelText("Save podcast settings"));
    await waitFor(() =>
      expect(
        (showAppDialog as jest.Mock).mock.calls.some(
          (c) => c[0]?.title === "Save podcast settings"
        )
      ).toBe(true)
    );
    const confirm = (showAppDialog as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((d) => d.title === "Save podcast settings");
    confirm.buttons.find((b: any) => b.text === "Save").onPress();
  }

  it("G4: save failure WITH a server response shows the permission/rejected dialog", async () => {
    (api.patch as jest.Mock).mockRejectedValue(
      Object.assign(new Error("rejected"), { response: { status: 403 } })
    );
    await renderScreen();
    await screen.findByText("My Great Podcast");

    await dirtyAndConfirmSave();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't save",
          message: expect.stringContaining("permission"),
        })
      )
    );
  });

  it("G4: save failure WITHOUT a response shows the offline dialog", async () => {
    (api.patch as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response
    await renderScreen();
    await screen.findByText("My Great Podcast");

    await dirtyAndConfirmSave();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't save",
          message: expect.stringContaining("offline"),
        })
      )
    );
  });

  it("G5: turning on auto-download with an unshaped schedule blocks save", async () => {
    await renderScreen();
    await screen.findByText("My Great Podcast");

    // Auto-download is seeded ON; replace the valid 5-field cron with a 2-field
    // string (also makes the form dirty so Save is pressable).
    fireEvent.changeText(screen.getByLabelText("Auto-download schedule (cron)"), "0 3");
    await waitFor(() =>
      expect(screen.getByLabelText("Auto-download schedule (cron)").props.value).toBe("0 3")
    );

    fireEvent.press(screen.getByLabelText("Save podcast settings"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Invalid schedule" })
      )
    );
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("G5: a check-for-new failure surfaces the couldn't-check dialog", async () => {
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/me") return Promise.resolve({ data: ADMIN_ME });
      if (url.startsWith("/api/items/")) return Promise.resolve({ data: PODCAST_ITEM });
      if (url.includes("/checknew")) {
        const err: any = new Error("feed down");
        err.response = { status: 500 };
        return Promise.reject(err);
      }
      return Promise.resolve({ data: {} });
    });
    await renderScreen();
    await screen.findByText("My Great Podcast");

    fireEvent.press(screen.getByLabelText("Check for new episodes now"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't check the feed" })
      )
    );
  });

  it("validates non-numeric limits before saving", async () => {
    await renderScreen();
    await screen.findByText("My Great Podcast");

    fireEvent.changeText(screen.getByLabelText("Max new episodes to download"), "abc");
    await waitFor(() =>
      expect(screen.getByLabelText("Max new episodes to download").props.value).toBe("abc")
    );

    fireEvent.press(screen.getByLabelText("Save podcast settings"));
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Invalid input" })
      )
    );
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("non-admin sees a read-only note and no Save control", async () => {
    mockGet({ me: USER_ME });
    await renderScreen();
    await screen.findByText("My Great Podcast");

    expect(
      screen.getByText("Only server admins can change these settings. Showing the current values.")
    ).toBeTruthy();
    // The write toggle/inputs are disabled and the Save button is absent.
    expect(screen.queryByLabelText("Save podcast settings")).toBeNull();
    expect(screen.getByLabelText("Auto-download episodes").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText("Max episodes to keep").props.editable).toBe(false);
  });

  it("check-for-new surfaces the returned episodes in a dialog", async () => {
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/me") return Promise.resolve({ data: ADMIN_ME });
      if (url.startsWith("/api/items/")) return Promise.resolve({ data: PODCAST_ITEM });
      if (url.includes("/checknew"))
        return Promise.resolve({ data: { episodes: [{ title: "Brand New Ep" }, { title: "Another" }] } });
      return Promise.resolve({ data: {} });
    });
    await renderScreen();
    await screen.findByText("My Great Podcast");

    fireEvent.press(screen.getByLabelText("Check for new episodes now"));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/podcasts/pod1/checknew?limit=3"));
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Found 2 new episodes" })
      )
    );
  });

  it("check-for-new reports when the feed has nothing new", async () => {
    await renderScreen();
    await screen.findByText("My Great Podcast");

    fireEvent.press(screen.getByLabelText("Check for new episodes now"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "No new episodes" })
      )
    );
  });

  it("shows an error state (with retry) when the item fails to load", async () => {
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/me") return Promise.resolve({ data: ADMIN_ME });
      const err: any = new Error("boom");
      err.response = { status: 500 };
      return Promise.reject(err);
    });
    await renderScreen();

    expect(await screen.findByText("Failed to load podcast settings.")).toBeTruthy();
  });

  it("shows an offline message when the request never reaches the server", async () => {
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/me") return Promise.resolve({ data: ADMIN_ME });
      return Promise.reject(new Error("Network Error")); // no .response
    });
    await renderScreen();

    expect(
      await screen.findByText(/You're offline\. Reconnect to view or change/)
    ).toBeTruthy();
  });

  it("errors when no podcast id is provided (no fetch)", async () => {
    await renderScreen({});
    expect(await screen.findByText("No podcast provided.")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("falls back to the store user for admin gating when /api/me fails", async () => {
    useUserStore.setState({ user: { id: "u1", type: "root" } } as any);
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/me") return Promise.reject(new Error("me down"));
      if (url.startsWith("/api/items/")) return Promise.resolve({ data: PODCAST_ITEM });
      return Promise.resolve({ data: {} });
    });
    await renderScreen();
    await screen.findByText("My Great Podcast");

    // Store user is root → admin controls remain available.
    expect(screen.getByLabelText("Save podcast settings")).toBeTruthy();
  });
});
