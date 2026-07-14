/**
 * PodcastDownloadQueueScreen — the server's episode-download queue (issue #56
 * P3): per-podcast rows from GET /api/podcasts/:id/downloads (queue +
 * currentDownload), the confirmed clear-queue action (side-effecting GET
 * /api/podcasts/:id/clear-queue, then refetch), the view-only library mode
 * (GET /api/libraries/:id/episode-downloads, no clear action), the ~5s
 * polling refetch (fake timers), and the empty state.
 */
// Capture the useFocusEffect callback (usePolling's focus gate) so tests can
// drive "focus" explicitly — exactly what react-navigation does on focus.
let mockFocusCb: (() => void | (() => void)) | null = null;
jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (cb: any) => {
    mockFocusCb = cb;
  },
}));

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import PodcastDownloadQueueScreen from "../../screens/PodcastDownloadQueueScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";

const CURRENT = {
  id: "dl-0",
  episodeDisplayTitle: "Now downloading episode",
  podcastTitle: "My Great Podcast",
  libraryItemId: "pod1",
  startedAt: Date.now() - 5000,
};
const QUEUED = [
  { id: "dl-1", episodeDisplayTitle: "Queued one", libraryItemId: "pod1" },
  { id: "dl-2", episodeDisplayTitle: "Queued two", libraryItemId: "pod1", podcastTitle: "My Great Podcast" },
];

function mockApi({
  queue = QUEUED,
  currentDownload = CURRENT as any,
}: { queue?: any[]; currentDownload?: any } = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/podcasts/pod1/downloads")
      return Promise.resolve({ data: { queue, currentDownload } });
    if (url === "/api/podcasts/pod1/clear-queue") return Promise.resolve({ data: {} });
    if (url === "/api/libraries/lib1/episode-downloads")
      return Promise.resolve({ data: { queue, currentDownload } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen(params: any) {
  const navigation = makeNavigation();
  await render(<PodcastDownloadQueueScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

// Fire the captured focus callback so usePolling runs its first poll.
async function focusScreen() {
  await act(async () => {
    mockFocusCb?.();
  });
}

const downloadsGetCount = (url: string) =>
  (api.get as jest.Mock).mock.calls.filter((c) => c[0] === url).length;

beforeEach(() => {
  mockFocusCb = null;
  mockApi();
});

describe("PodcastDownloadQueueScreen", () => {
  it("per-podcast mode: polls /api/podcasts/:id/downloads and renders the in-flight row + queue rows", async () => {
    await renderScreen({ libraryItemId: "pod1" });
    await focusScreen();

    expect(await screen.findByText("Now downloading episode")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/podcasts/pod1/downloads");
    // The in-flight download renders as the marked "Downloading now" row.
    expect(screen.getByText("Downloading now")).toBeTruthy();
    expect(screen.getByTestId("task-progress-row")).toBeTruthy();
    // Queue rows (episodeDisplayTitle) in order, with the queued count.
    expect(screen.getByText("Queued one")).toBeTruthy();
    expect(screen.getByText("Queued two")).toBeTruthy();
    expect(screen.getByText("2 queued")).toBeTruthy();
  });

  it("clear queue confirms, hits the side-effecting GET clear-queue route, then refetches", async () => {
    await renderScreen({ libraryItemId: "pod1" });
    await focusScreen();
    await screen.findByText("Queued one");

    const fetchesBefore = downloadsGetCount("/api/podcasts/pod1/downloads");
    fireEvent.press(screen.getByLabelText("Clear queue"));

    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    const dialog = (showAppDialog as jest.Mock).mock.calls[0][0];
    expect(dialog.title).toBe("Clear download queue?");
    // The copy must make clear only QUEUED episodes are dropped, not the
    // in-flight download.
    expect(dialog.message).toMatch(/QUEUED/);
    expect(dialog.message).toMatch(/not cancelled/i);
    // Nothing cleared until confirmed.
    expect(downloadsGetCount("/api/podcasts/pod1/clear-queue")).toBe(0);

    const clearBtn = dialog.buttons.find((b: any) => b.text === "Clear queue");
    expect(clearBtn.style).toBe("destructive");
    await act(async () => {
      clearBtn.onPress();
    });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/api/podcasts/pod1/clear-queue")
    );
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Download queue cleared" });
    // Refetched after the clear so the emptied queue shows immediately.
    await waitFor(() =>
      expect(downloadsGetCount("/api/podcasts/pod1/downloads")).toBeGreaterThan(fetchesBefore)
    );
  });

  it("library mode polls the library route and is VIEW-ONLY (no clear action)", async () => {
    await renderScreen({ libraryId: "lib1" });
    await focusScreen();

    expect(await screen.findByText("Queued one")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/episode-downloads");
    expect(api.get).not.toHaveBeenCalledWith("/api/podcasts/pod1/downloads");
    // No library-wide clear-queue route exists on the server → no action.
    expect(screen.queryByLabelText("Clear queue")).toBeNull();
  });

  it("a polling tick (~5s) refetches the queue", async () => {
    jest.useFakeTimers();
    try {
      await renderScreen({ libraryItemId: "pod1" });
      await focusScreen();
      expect(downloadsGetCount("/api/podcasts/pod1/downloads")).toBe(1);

      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(downloadsGetCount("/api/podcasts/pod1/downloads")).toBe(2);

      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(downloadsGetCount("/api/podcasts/pod1/downloads")).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("renders the empty state when nothing is downloading or queued", async () => {
    mockApi({ queue: [], currentDownload: null });
    await renderScreen({ libraryItemId: "pod1" });
    await focusScreen();

    expect(await screen.findByText("No queued episode downloads")).toBeTruthy();
    expect(screen.queryByText("Downloading now")).toBeNull();
  });

  it("surfaces a load failure as an ErrorState with a working retry", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("Network Error")); // no .response → offline
    await renderScreen({ libraryItemId: "pod1" });
    await focusScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();

    // Retry refetches and recovers.
    mockApi();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("Queued one")).toBeTruthy();
  });

  it("errors when neither (or both) params are provided, without fetching", async () => {
    await renderScreen({});
    expect(await screen.findByText("No queue to show")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });
});
