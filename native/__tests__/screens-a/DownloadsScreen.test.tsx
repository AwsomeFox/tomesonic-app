/**
 * DownloadsScreen — completed tab rows (title/author/size, storage summary),
 * ebook-only rows routing to the Reader, delete confirmation → removeDownload,
 * the Delete-all confirmation → removeAllDownloads, the split
 * Downloading/Failed tab label, and the active tab's progress/retry/cancel
 * wiring.
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 320, height: 640 };
  return {
    SafeAreaProvider: ({ children }: any) => children,
    SafeAreaView: ({ children, edges, ...props }: any) => React.createElement(View, props, children),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { frame, insets },
  };
});

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/progressSync", () => ({
  queueFinishedPatch: jest.fn(),
  queueProgressPatch: jest.fn(),
  queueEbookProgressPatch: jest.fn(),
  flushPendingSyncs: jest.fn().mockResolvedValue(undefined),
  clearAllPending: jest.fn(),
  syncProgress: jest.fn().mockResolvedValue(undefined),
  closeSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));

import DownloadsScreen from "../../screens/DownloadsScreen";
import { useDownloadStore } from "../../store/useDownloadStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { showAppDialog } from "../../store/useDialogStore";

const initialDownloads = useDownloadStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();

const makeNavigation = () => {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
};

const MB = 1024 * 1024;

const audioDownload = {
  id: "b1",
  libraryItemId: "b1",
  title: "Audio DL",
  author: "Alice Author",
  coverUrl: "https://abs.test/api/items/b1/cover",
  status: "completed" as const,
  progress: 1,
  parts: [
    { id: "track1", filename: "t1.mp3", url: "", fileSize: 8 * MB, bytesDownloaded: 8 * MB, completed: true, localFilePath: "file:///dl/b1/t1.mp3" },
    // Size never reported for the cover — bytesDownloaded must count instead.
    { id: "cover", filename: "cover.jpg", url: "", fileSize: 0, bytesDownloaded: 0.5 * MB, completed: true, localFilePath: "file:///dl/b1/cover.jpg" },
  ],
  meta: { duration: 3600, chapters: [], tracks: [{ index: 1, filename: "t1.mp3", duration: 3600, startOffset: 0 }] },
};

const ebookDownload = {
  id: "e1",
  libraryItemId: "e1",
  title: "Ebook DL",
  author: "Eve Writer",
  coverUrl: "",
  status: "completed" as const,
  progress: 1,
  parts: [
    { id: "ebook", filename: "great.epub", url: "", fileSize: 1 * MB, bytesDownloaded: 1 * MB, completed: true, localFilePath: "file:///dl/e1/great.epub" },
  ],
  meta: { duration: 0, chapters: [], tracks: [] },
};

const activeDownload = {
  id: "a1",
  libraryItemId: "a1",
  title: "Active Book",
  author: "Auth Or",
  coverUrl: "",
  status: "downloading" as const,
  progress: 0.42,
  parts: [],
};

const failedDownload = {
  id: "f1",
  libraryItemId: "f1",
  title: "Failed Book",
  author: "Auth Or",
  coverUrl: "",
  status: "failed" as const,
  progress: 0.2,
  error: "Not enough storage space",
  parts: [],
};

function seed(overrides: Partial<Record<string, any>> = {}) {
  useDownloadStore.setState({
    completedDownloads: { b1: audioDownload, e1: ebookDownload },
    activeDownloads: { a1: activeDownload, f1: failedDownload },
    // The screen reloads from the DB on mount — stub so seeds survive.
    loadDownloadsFromDb: jest.fn(),
    cancelDownload: jest.fn(),
    retryDownload: jest.fn(),
    removeDownload: jest.fn(),
    removeAllDownloads: jest.fn(),
    ...overrides,
  } as any);
}

beforeEach(() => {
  useDownloadStore.setState(initialDownloads, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUserStore.setState(initialUser, true);
});

describe("DownloadsScreen", () => {
  it("renders the completed tab with rows, sizes, and the storage summary header", async () => {
    seed();
    const navigation = makeNavigation();
    await render(<DownloadsScreen navigation={navigation} />);

    expect(screen.getByText("Downloaded (2)")).toBeTruthy();
    // 1 in-flight + 1 failed: the tab label splits the counts honestly.
    expect(screen.getByText("Downloading (1) · Failed (1)")).toBeTruthy();

    // Rows: title + author + formatted byte size (8.5 MB and 1.0 MB).
    expect(screen.getByText("Audio DL")).toBeTruthy();
    expect(screen.getByText("Alice Author")).toBeTruthy();
    expect(screen.getByText("8.5 MB")).toBeTruthy();
    expect(screen.getByText("Ebook DL")).toBeTruthy();
    expect(screen.getByText("1.0 MB")).toBeTruthy();

    // Storage summary sums every part (fileSize or bytes actually written), and
    // once device free space loads it's appended for context.
    expect(screen.getByText("Internal App Storage")).toBeTruthy();
    expect(await screen.findByText(/2 items · 9\.5 MB used · .* free/)).toBeTruthy();
  });

  it("plays audio rows offline and opens ebook-only rows in the Reader", async () => {
    seed();
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback } as any);
    const navigation = makeNavigation();
    await render(<DownloadsScreen navigation={navigation} />);

    await fireEvent.press(screen.getByLabelText("Play Audio DL"));
    // Books carry no episodeId — the second arg is undefined (episode rows pass
    // their episodeId so the right episode plays offline).
    await waitFor(() => expect(startPlayback).toHaveBeenCalledWith("b1", undefined));

    await fireEvent.press(screen.getByLabelText("Read Ebook DL"));
    expect(navigation.navigate).toHaveBeenCalledWith("Reader", {
      itemId: "e1",
      ebookFormat: "epub",
      title: "Ebook DL",
    });
  });

  it("plays a downloaded podcast episode with its libraryItemId + episodeId", async () => {
    const episodeDownload = {
      id: "pod1::ep1",
      libraryItemId: "pod1",
      episodeId: "ep1",
      title: "Episode DL",
      author: "Podcaster",
      coverUrl: "",
      status: "completed" as const,
      progress: 1,
      parts: [
        { id: "track_0", filename: "track_0.mp3", url: "", fileSize: 5 * MB, bytesDownloaded: 5 * MB, completed: true, localFilePath: "file:///dl/pod1::ep1/track_0.mp3" },
      ],
      meta: { duration: 1800, chapters: [], tracks: [{ index: 0, filename: "track_0.mp3", duration: 1800, startOffset: 0 }] },
    };
    seed({ completedDownloads: { "pod1::ep1": episodeDownload }, activeDownloads: {} });
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback } as any);
    await render(<DownloadsScreen navigation={makeNavigation()} />);

    await fireEvent.press(screen.getByLabelText("Play Episode DL"));
    await waitFor(() => expect(startPlayback).toHaveBeenCalledWith("pod1", "ep1"));
  });

  it("delete goes through a confirm dialog before removeDownload", async () => {
    seed();
    const removeDownload = useDownloadStore.getState().removeDownload as jest.Mock;
    const alertSpy = showAppDialog as jest.Mock;
    const navigation = makeNavigation();
    await render(<DownloadsScreen navigation={navigation} />);

    await fireEvent.press(screen.getByLabelText("Delete download of Audio DL"));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete download",
        message: expect.stringContaining("Audio DL"),
        buttons: expect.any(Array),
      })
    );
    expect(removeDownload).not.toHaveBeenCalled(); // not before confirming

    const buttons = alertSpy.mock.calls[0][0].buttons as any[];
    await act(async () => {
      buttons.find((b) => b.text === "Delete").onPress();
    });
    expect(removeDownload).toHaveBeenCalledWith("b1");
  });

  it("active tab shows progress, failure reason, and wires retry/cancel", async () => {
    seed();
    const cancelDownload = useDownloadStore.getState().cancelDownload as jest.Mock;
    const retryDownload = useDownloadStore.getState().retryDownload as jest.Mock;
    const navigation = makeNavigation();
    await render(<DownloadsScreen navigation={navigation} />);

    await fireEvent.press(screen.getByText("Downloading (1) · Failed (1)"));

    expect(screen.getByText("Active Book")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("Downloading")).toBeTruthy();
    expect(screen.getByText("Failed Book")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Not enough storage space")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Retry download of Failed Book"));
    expect(retryDownload).toHaveBeenCalledWith("f1");
    // Non-failed items get no retry affordance.
    expect(screen.queryByLabelText("Retry download of Active Book")).toBeNull();

    // Cancelling a LIVE download is destructive (partial files are deleted)
    // and now goes through a confirm dialog first.
    const alertSpy = showAppDialog as jest.Mock;
    await fireEvent.press(screen.getByLabelText("Cancel download of Active Book"));
    expect(cancelDownload).not.toHaveBeenCalled(); // not before confirming
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Cancel download?",
        message: expect.stringContaining("Active Book"),
        buttons: expect.any(Array),
      })
    );
    const buttons = alertSpy.mock.calls[0][0].buttons as any[];
    await act(async () => {
      buttons.find((b) => b.text === "Cancel download").onPress();
    });
    expect(cancelDownload).toHaveBeenCalledWith("a1");
  });

  it("omits the Failed split from the tab label when nothing has failed", async () => {
    seed({ activeDownloads: { a1: activeDownload } });
    const navigation = makeNavigation();
    await render(<DownloadsScreen navigation={navigation} />);

    expect(screen.getByText("Downloading (1)")).toBeTruthy();
    expect(screen.queryByText(/Failed \(/)).toBeNull();
  });

  it("Delete all goes through a confirm dialog before removeAllDownloads", async () => {
    seed();
    const removeAllDownloads = useDownloadStore.getState().removeAllDownloads as jest.Mock;
    const alertSpy = showAppDialog as jest.Mock;
    const navigation = makeNavigation();
    await render(<DownloadsScreen navigation={navigation} />);

    await fireEvent.press(screen.getByLabelText("Delete all downloads"));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete all downloads",
        // Copy must disclose the FULL scope: completed items AND the in-flight/
        // failed downloads the wipe aborts (seed has 2 of each).
        message: expect.stringContaining("2 downloaded items and cancel 2 in-progress/failed downloads"),
        buttons: expect.any(Array),
      })
    );
    expect(removeAllDownloads).not.toHaveBeenCalled(); // not before confirming

    const buttons = alertSpy.mock.calls[0][0].buttons as any[];
    const destructive = buttons.find((b) => b.text === "Delete all");
    expect(destructive.style).toBe("destructive");
    await act(async () => {
      destructive.onPress();
    });
    expect(removeAllDownloads).toHaveBeenCalled();
  });

  it("shows empty states on both tabs and navigates back", async () => {
    seed({ completedDownloads: {}, activeDownloads: {} });
    const navigation = makeNavigation();
    await render(<DownloadsScreen navigation={navigation} />);

    expect(screen.getByText("No downloads yet")).toBeTruthy();
    expect(screen.queryByText("Internal App Storage")).toBeNull(); // header hidden when empty

    await fireEvent.press(screen.getByText("Downloading (0)"));
    expect(screen.getByText("Nothing downloading")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
