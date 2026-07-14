/**
 * AdminNotificationsScreen — conservative v1 of the Apprise notifications
 * admin (admin-only on the server). Covers: list rendering from GET
 * /api/notifications (humanized event titles, url subtitles, failure marker),
 * the Apprise banner in both configured/unconfigured states plus the
 * web-dashboard pointer, the per-notification enabled toggle (optimistic flip
 * → PATCH full object → revert-with-snackbar on failure), the empty state, and
 * offline vs 403 error states. Only utils/api is mocked, so the real
 * utils/abs/notifications + errors modules run.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useSnackbarStore", () => ({
  showSnackbar: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import AdminNotificationsScreen from "../../screens/AdminNotificationsScreen";
import { api } from "../../utils/api";
import { showSnackbar } from "../../store/useSnackbarStore";

const EPISODE_NOTIF = {
  id: "n1",
  libraryId: "lib1",
  eventName: "onPodcastEpisodeDownloaded",
  urls: ["apprises://host/episode-key"],
  titleTemplate: "New episode",
  bodyTemplate: "{episodeTitle}",
  enabled: true,
  type: "info",
  lastFiredAt: null,
  lastAttemptFailed: false,
  numConsecutiveFailedAttempts: 0,
  createdAt: 1690000000000,
};
const BACKUP_NOTIF = {
  id: "n2",
  libraryId: null,
  eventName: "onBackupFailed",
  urls: ["apprises://host/backup-key"],
  enabled: false,
  lastAttemptFailed: true,
  numConsecutiveFailedAttempts: 3,
};
const CUSTOM_NOTIF = {
  id: "n3",
  eventName: "onSomethingNew",
  urls: ["apprises://host/new-key"],
  enabled: true,
};

function mockSettings(overrides: Record<string, any> = {}) {
  const settings = {
    id: "notification-settings",
    appriseType: "api",
    appriseApiUrl: "https://apprise.example.com",
    notifications: [EPISODE_NOTIF, BACKUP_NOTIF, CUSTOM_NOTIF],
    ...overrides,
  };
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/notifications") return Promise.resolve({ data: { settings } });
    return Promise.resolve({ data: {} });
  });
  return settings;
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminNotificationsScreen navigation={navigation} />);
  return navigation;
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  (api.patch as jest.Mock).mockReset();
  (showSnackbar as jest.Mock).mockClear();
  mockSettings();
});

describe("AdminNotificationsScreen", () => {
  it("lists notifications from GET /api/notifications with humanized titles and url subtitles", async () => {
    await renderScreen();

    expect(await screen.findByText("Podcast episode downloaded")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/notifications");
    expect(screen.getByText("Notifications (3)")).toBeTruthy();
    expect(screen.getByText("Backup failed")).toBeTruthy();
    // Unknown event names fall back to the raw eventName.
    expect(screen.getByText("onSomethingNew")).toBeTruthy();
    // First url as subtitle; the failing one carries the failure marker.
    expect(screen.getByText("apprises://host/episode-key")).toBeTruthy();
    expect(screen.getByText("apprises://host/backup-key · last attempt failed")).toBeTruthy();
  });

  it("banner shows the Apprise API url when configured, plus the web-dashboard pointer", async () => {
    await renderScreen();
    await screen.findByText("Podcast episode downloaded");

    expect(screen.getByText(/Apprise API: https:\/\/apprise\.example\.com/)).toBeTruthy();
    expect(
      screen.getByText(/Create and edit notifications from the Audiobookshelf web dashboard\./)
    ).toBeTruthy();
    expect(screen.queryByText(/Apprise is not configured/)).toBeNull();
  });

  it("banner says Apprise is not configured when the server has no API url", async () => {
    mockSettings({ appriseApiUrl: null });
    await renderScreen();
    await screen.findByText("Podcast episode downloaded");

    expect(screen.getByText(/Apprise is not configured on this server\./)).toBeTruthy();
    expect(screen.queryByText(/Apprise API:/)).toBeNull();
    // The dashboard pointer shows regardless.
    expect(screen.getByText(/Audiobookshelf web dashboard/)).toBeTruthy();
  });

  it("toggle PATCHes the FULL notification object with the flipped enabled flag", async () => {
    (api.patch as jest.Mock).mockResolvedValue({ data: {} });
    await renderScreen();
    await screen.findByText("Podcast episode downloaded");

    // ToggleRow rows are accessible switches labelled "title, subtitle".
    const row = screen.getByLabelText(/^Podcast episode downloaded,/);
    expect(row.props.accessibilityState?.checked).toBe(true);

    await fireEvent.press(row);

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/notifications/n1", {
        ...EPISODE_NOTIF,
        enabled: false,
      })
    );
    // Optimistic flip sticks on success.
    expect(
      screen.getByLabelText(/^Podcast episode downloaded,/).props.accessibilityState?.checked
    ).toBe(false);
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it("enabling a disabled notification sends enabled: true", async () => {
    (api.patch as jest.Mock).mockResolvedValue({ data: {} });
    await renderScreen();
    await screen.findByText("Backup failed");

    await fireEvent.press(screen.getByLabelText(/^Backup failed,/));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/notifications/n2", {
        ...BACKUP_NOTIF,
        enabled: true,
      })
    );
  });

  it("two concurrent toggles: each row stays guarded until ITS OWN patch settles", async () => {
    // One pending promise per PATCH url so each write settles independently.
    const pending: Record<string, (v: any) => void> = {};
    (api.patch as jest.Mock).mockImplementation(
      (url: string) => new Promise((res) => (pending[url] = res))
    );
    await renderScreen();
    await screen.findByText("Podcast episode downloaded");

    // Start both toggles WITHOUT awaiting their fireEvent promises — the
    // async fireEvent resolves only when the handler chain (the held-open
    // PATCH) settles; each is awaited below after ITS patch is released. The
    // setTimeout yields let each press's internal act() scope close before
    // the next opens — interleaved act scopes scramble the global act-env
    // restore and poison every later test in the file.
    const flushLoop = () => new Promise((r) => setTimeout(r, 0));
    const press1 = fireEvent.press(screen.getByLabelText(/^Podcast episode downloaded,/)); // n1
    await flushLoop();
    const press2 = fireEvent.press(screen.getByLabelText(/^Backup failed,/)); // n2
    await flushLoop();
    expect(api.patch).toHaveBeenCalledTimes(2);

    // n1's patch settles FIRST. n2's write is still in flight — its row must
    // STAY guarded (the old shared savingId was nulled by whichever patch
    // finished first, unguarding the other row mid-flight).
    await act(async () => {
      pending["/api/notifications/n1"]({ data: {} });
      await press1;
    });
    // Guarded re-press: handleToggle bails synchronously, no third PATCH.
    await fireEvent.press(screen.getByLabelText(/^Backup failed,/));
    expect(api.patch).toHaveBeenCalledTimes(2); // re-press swallowed

    // Once n2's OWN patch settles, its guard releases and a new toggle sends.
    await act(async () => {
      pending["/api/notifications/n2"]({ data: {} });
      await press2;
    });
    (api.patch as jest.Mock).mockResolvedValue({ data: {} });
    await fireEvent.press(screen.getByLabelText(/^Backup failed,/));
    expect(api.patch).toHaveBeenCalledTimes(3);
  });

  it("truncates long subtitle URLs (they can embed webhook tokens) for display AND the a11y label", async () => {
    const longUrl = "apprises://hooks.example.com/" + "s".repeat(60);
    mockSettings({ notifications: [{ ...EPISODE_NOTIF, urls: [longUrl] }] });
    await renderScreen();
    await screen.findByText("Podcast episode downloaded");

    const truncated = `${longUrl.slice(0, 48)}…`;
    expect(screen.getByText(truncated)).toBeTruthy();
    expect(screen.queryByText(longUrl)).toBeNull();
    // The STRING is truncated before rendering, so the row's accessibility
    // label (title, subtitle) reads the short form too — numberOfLines alone
    // would still speak the full token aloud.
    expect(screen.getByLabelText(`Podcast episode downloaded, ${truncated}`)).toBeTruthy();
  });

  it("a failed toggle reverts the optimistic flip and explains via snackbar", async () => {
    (api.patch as jest.Mock).mockRejectedValue(httpError(403));
    await renderScreen();
    await screen.findByText("Podcast episode downloaded");

    await fireEvent.press(screen.getByLabelText(/^Podcast episode downloaded,/));

    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith({
        message: "Only server admins can manage notifications.",
      })
    );
    // Reverted to the server's truth.
    expect(
      screen.getByLabelText(/^Podcast episode downloaded,/).props.accessibilityState?.checked
    ).toBe(true);
  });

  it("shows the empty state when the server has no notifications, pointing at the web dashboard", async () => {
    mockSettings({ notifications: [] });
    await renderScreen();

    expect(await screen.findByText("No notifications")).toBeTruthy();
    // The copy must reflect reality: notifications are created from the
    // Audiobookshelf web dashboard — the app only enables/disables them.
    expect(
      screen.getByText(/created from the Audiobookshelf web dashboard appear here/)
    ).toBeTruthy();
    expect(screen.queryByText(/^Notifications \(/)).toBeNull();
  });

  it("offline load failure shows the offline error state, and Retry refetches", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("Network Error")); // no .response
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(screen.getByText("Reconnect to manage notifications.")).toBeTruthy();

    mockSettings();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("Podcast episode downloaded")).toBeTruthy();
  });

  it("403 load failure shows the admin-access-required state (not the offline copy)", async () => {
    (api.get as jest.Mock).mockRejectedValue(httpError(403));
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.getByText("Only server admins can manage notifications.")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it("back button goes back", async () => {
    const navigation = await renderScreen();
    await screen.findByText("Podcast episode downloaded");
    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
