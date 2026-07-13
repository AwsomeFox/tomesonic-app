/**
 * ItemDetailScreen — item load + metadata render, per-format progress rows,
 * mark-finished (online w/ fuzzy counterpart + offline queue), download button
 * states, play/read routing, and podcast episode rows.
 */
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react-native";

// The global setup maps this package to the library's jest mock, which only
// has a `default` export — named imports (SafeAreaView) come back undefined.
// Override file-locally with a plain-View implementation.
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
  syncBothProgressFraction: jest.fn(),
  reconcileLinkedProgress: jest.fn(),
}));
jest.mock("../../utils/downloader", () => ({
  downloader: {
    downloadBook: jest.fn().mockResolvedValue(undefined),
    downloadEpisode: jest.fn().mockResolvedValue(undefined),
    resumeDownload: jest.fn().mockResolvedValue(undefined),
    abortBookParts: jest.fn().mockResolvedValue(undefined),
    sweepOrphanFolders: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));
jest.mock("../../store/useSnackbarStore", () => ({
  showSnackbar: jest.fn(),
}));
// Item admin actions (overflow entries). Capabilities are NOT mocked — they
// compute from the real useUserStore state, so the gating matrix below
// exercises the actual permission logic.
jest.mock("../../utils/abs/items", () => ({
  encodeM4b: jest.fn(),
  embedMetadata: jest.fn(),
  createShareLink: jest.fn(),
  deleteShareLink: jest.fn(),
  buildItemZipDownloadUrl: jest.fn(),
}));
jest.mock("../../utils/abs/tasks", () => ({
  startTaskWatch: jest.fn(),
}));

import ItemDetailScreen, { slugifyTitle } from "../../screens/ItemDetailScreen";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { api } from "../../utils/api";
import {
  encodeM4b,
  embedMetadata,
  createShareLink,
  deleteShareLink,
  buildItemZipDownloadUrl,
} from "../../utils/abs/items";
import { startTaskWatch } from "../../utils/abs/tasks";
import {
  queueFinishedPatch,
  queueProgressPatch,
  syncBothProgressFraction,
  reconcileLinkedProgress,
} from "../../utils/progressSync";
import { downloader } from "../../utils/downloader";
import { useUserStore } from "../../store/useUserStore";
import { useFavoritesStore } from "../../store/useFavoritesStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useDownloadStore } from "../../store/useDownloadStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { storage } from "../../utils/storage";
import { encodeFilterValue } from "../../components/FilterModal";

const mockedGet = api.get as jest.Mock;
const mockedPatch = api.patch as jest.Mock;

// Store snapshots (module singletons) — restored around every test.
const initialUser = useUserStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialDownloads = useDownloadStore.getState();
const initialLibrary = useLibraryStore.getState();

const makeNavigation = () => {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
};

// --- Fixtures ---------------------------------------------------------------

/** Book that carries BOTH audio and ebook on the same item (no counterpart). */
const bothFormatItem = {
  id: "item1",
  mediaType: "book",
  libraryId: "lib1",
  size: 123456789,
  media: {
    id: "book-media-1",
    duration: 3600,
    numTracks: 5,
    numAudioFiles: 5,
    ebookFile: { ebookFormat: "epub" },
    tags: ["Favorites"],
    chapters: [{ id: 0, title: "Chapter 1", start: 0, end: 1800 }],
    metadata: {
      title: "The Hobbit",
      authors: [{ id: "auth1", name: "J.R.R. Tolkien" }],
      authorName: "J.R.R. Tolkien",
      narrators: ["Rob Inglis"],
      series: [{ id: "ser1", name: "Middle Earth", sequence: "1" }],
      genres: ["Fantasy"],
      publishedYear: "1937",
      publisher: "Allen & Unwin",
      language: "English",
      description: "<p>A hobbit goes on an &amp; adventure.</p>",
    },
  },
  userMediaProgress: {
    libraryItemId: "item1",
    progress: 0.5,
    currentTime: 1800,
    duration: 3600,
    ebookProgress: 0.25,
    lastUpdate: 1000,
    isFinished: false,
  },
};

/** Audio-only item whose ebook lives as a separate (fuzzy-matched) item. */
const audioOnlyItem = {
  id: "item1",
  mediaType: "book",
  libraryId: "lib1",
  media: {
    duration: 3600,
    numTracks: 5,
    metadata: {
      title: "The Hobbit",
      authors: [{ id: "auth1", name: "J.R.R. Tolkien" }],
      authorName: "J.R.R. Tolkien",
    },
  },
  userMediaProgress: {
    libraryItemId: "item1",
    progress: 0.5,
    currentTime: 1800,
    duration: 3600,
    lastUpdate: 1000,
    isFinished: false,
  },
};

const ebookSibling = {
  id: "ebook1",
  mediaType: "book",
  media: {
    ebookFile: { ebookFormat: "epub" },
    metadata: { title: "The Hobbit", authorName: "J.R.R. Tolkien" },
  },
};

const ebookOnlyItem = {
  id: "item1",
  mediaType: "book",
  libraryId: "lib1",
  media: {
    ebookFile: { ebookFormat: "epub" },
    metadata: { title: "Silmarillion Reader", authorName: "J.R.R. Tolkien" },
  },
};

const podcastItem = {
  id: "pod1",
  mediaType: "podcast",
  libraryId: "lib1",
  media: {
    episodes: [
      { id: "ep1", title: "Episode One", publishedAt: 1700000000000, duration: 1800 },
      { id: "ep2", title: "Episode Two", publishedAt: 1800000000000, duration: 900 },
    ],
    metadata: { title: "My Podcast" },
  },
};

/** Route api.get by URL; item payload configurable per test. */
function routeApi(item: any, searchBooks: any[] = []) {
  mockedGet.mockImplementation((url: string) => {
    if (url.startsWith(`/api/items/${item.id}`)) {
      return Promise.resolve({ data: item });
    }
    if (url.includes("/search?")) {
      return Promise.resolve({ data: { book: searchBooks.map((b) => ({ libraryItem: b })) } });
    }
    return Promise.reject(new Error(`unmocked GET ${url}`));
  });
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  usePlaybackStore.setState(initialPlayback, true);
  useDownloadStore.setState(initialDownloads, true);
  useLibraryStore.setState(initialLibrary, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.test", token: "tok" },
  } as any);
  storage.getAllKeys().forEach((k: string) => storage.remove(k));
  useFavoritesStore.setState({ favorites: [] });
  mockedPatch.mockResolvedValue({ data: {} });
});

describe("ItemDetailScreen", () => {
  it("loads the item and renders title, series, author, duration, size and progress rows", async () => {
    routeApi(bothFormatItem);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );

    // Title appears in the app bar and in the body.
    const titles = await screen.findAllByText("The Hobbit");
    expect(titles.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Middle Earth, Book 1")).toBeTruthy();
    expect(screen.getByText("J.R.R. Tolkien")).toBeTruthy();
    expect(screen.getByText("1 hr 0 min")).toBeTruthy(); // duration MetaRow
    expect(screen.getByText("Rob Inglis")).toBeTruthy();
    expect(screen.getByText("1937")).toBeTruthy();
    expect(screen.getByText("Allen & Unwin")).toBeTruthy();
    expect(screen.getByText("118 MB")).toBeTruthy(); // 123456789 bytes, >=10MB rounds to integer
    // Stripped-HTML description with decoded entity.
    expect(screen.getAllByText("A hobbit goes on an & adventure.").length).toBeGreaterThanOrEqual(1);

    // Per-format progress rows: audio 50% + remaining time, ebook 25%.
    expect(screen.getByText("Listening")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("30 min remaining")).toBeTruthy();
    expect(screen.getByText("Reading")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();

    // Audio progress > 0 relabels play as Continue.
    expect(screen.getByText("Continue")).toBeTruthy();
  });

  it("opens the dedicated AuthorDetail screen from the author link", async () => {
    routeApi(bothFormatItem);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByText("J.R.R. Tolkien"));
    expect(navigation.navigate).toHaveBeenCalledWith("AuthorDetail", {
      authorId: "auth1",
      authorName: "J.R.R. Tolkien",
    });
  });

  it("starts playback from the play button", async () => {
    routeApi(bothFormatItem);
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback } as any);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("Continue listening"));
    await waitFor(() => expect(startPlayback).toHaveBeenCalledWith("item1"));
  });

  it("play on the ALREADY-LOADED book resumes instead of churning a new session", async () => {
    routeApi(bothFormatItem);
    const startPlayback = jest.fn().mockResolvedValue(true);
    const play = jest.fn().mockResolvedValue(undefined);
    const setPlayerExpanded = jest.fn();
    usePlaybackStore.setState({
      startPlayback,
      play,
      setPlayerExpanded,
      currentSession: { id: "sess1", libraryItemId: "item1" },
      isPlaying: false,
    } as any);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("Continue listening"));
    // A fresh /play would reset the queue (audible hiccup) and could jump
    // back to the last-synced position — resume + expand instead.
    expect(startPlayback).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalled();
    expect(setPlayerExpanded).toHaveBeenCalledWith(true);
  });

  it("marks finished online: PATCHes the item AND its fuzzy-matched counterpart, updates the local map", async () => {
    routeApi(audioOnlyItem, [ebookSibling]);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    // The counterpart supplies the Read button — wait for the fuzzy match.
    await screen.findByLabelText("Read ebook");

    await fireEvent.press(screen.getByLabelText("Mark as finished"));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith("/api/me/progress/item1", { isFinished: true });
      expect(mockedPatch).toHaveBeenCalledWith("/api/me/progress/ebook1", { isFinished: true });
    });
    // Optimistic map update covers BOTH items.
    const map = useUserStore.getState().mediaProgress;
    expect(map["item1"].isFinished).toBe(true);
    expect(map["ebook1"].isFinished).toBe(true);
    expect(queueFinishedPatch).not.toHaveBeenCalled();
  });

  it("queues the finished toggle when offline (patch rejects) and still updates the local map", async () => {
    routeApi(audioOnlyItem, [ebookSibling]);
    mockedPatch.mockRejectedValue(new Error("Network Error"));
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByLabelText("Read ebook");

    await fireEvent.press(screen.getByLabelText("Mark as finished"));

    await waitFor(() => {
      expect(queueFinishedPatch).toHaveBeenCalledWith("item1", true);
      expect(queueFinishedPatch).toHaveBeenCalledWith("ebook1", true);
    });
    const map = useUserStore.getState().mediaProgress;
    expect(map["item1"].isFinished).toBe(true);
    expect(map["ebook1"].isFinished).toBe(true);
  });

  it("does NOT queue an offline finish patch on a server rejection (403) and surfaces an error", async () => {
    routeApi(audioOnlyItem, [ebookSibling]);
    // A rejection WITH a response is a real server error — NOT offline.
    mockedPatch.mockRejectedValue({ response: { status: 403 } });
    const alertSpy = showAppDialog as jest.Mock;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByLabelText("Read ebook");

    await fireEvent.press(screen.getByLabelText("Mark as finished"));

    // Error surfaced to the user.
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't update" })
      )
    );
    // The offline queue must NOT be poisoned by a genuine server error…
    expect(queueFinishedPatch).not.toHaveBeenCalled();
    // …and the local map must not be optimistically flipped either.
    expect(useUserStore.getState().mediaProgress["item1"]?.isFinished).not.toBe(true);
    warnSpy.mockRestore();
  });

  it("download failure surfaces the actual error reason (not a generic connectivity message)", async () => {
    routeApi(bothFormatItem);
    (downloader.downloadBook as jest.Mock).mockRejectedValueOnce(
      new Error("No space left on device")
    );
    const alertSpy = showAppDialog as jest.Mock;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("Download"));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Download failed",
          message: expect.stringContaining("No space left on device"),
        })
      )
    );
    warnSpy.mockRestore();
  });

  it("wraps the secondary action row so all actions stay reachable on narrow screens", async () => {
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");
    const row = screen.getByTestId("detail-action-row");
    const style = Array.isArray(row.props.style)
      ? Object.assign({}, ...row.props.style)
      : row.props.style;
    // A single non-wrapping row overflowed off-screen once 7-8 circular actions
    // showed — it must wrap (with a rowGap for the extra lines).
    expect(style.flexWrap).toBe("wrap");
    expect(style.rowGap).toBeGreaterThan(0);
  });

  it("seek-from-here falls back to a TIME seek when the loaded session has no store chapters", async () => {
    // Item is the loaded session, but the STORE's chapter array is empty, so the
    // modal fell back to the RAW item chapter list. Indexing seekToChapter() into
    // the empty store array would silently no-op — seek by the chapter's TIME.
    const chapteredItem = {
      ...bothFormatItem,
      media: {
        ...bothFormatItem.media,
        chapters: [
          { id: 0, title: "Chapter 1", start: 0, end: 600 },
          { id: 1, title: "Chapter 2", start: 600, end: 1800 },
        ],
      },
    };
    routeApi(chapteredItem);
    const seek = jest.fn().mockResolvedValue(undefined);
    const seekToChapter = jest.fn().mockResolvedValue(undefined);
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({
      seek,
      seekToChapter,
      startPlayback,
      currentSession: { id: "sess1", libraryItemId: "item1" },
      chapters: [], // store has NO chapters → modal shows the raw list
    } as any);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("View chapters"));
    // Chapter 2 starts at 600s (10:00) — tapping it must seek to that TIME.
    await fireEvent.press(screen.getByLabelText("Chapter 2, starts at 10:00"));

    await waitFor(() => expect(seek).toHaveBeenCalledWith(600));
    // The empty-store index path must NOT be used, and no fresh /play churned.
    expect(seekToChapter).not.toHaveBeenCalled();
    expect(startPlayback).not.toHaveBeenCalled();
  });

  it("download button: not downloaded → downloadBook with server address + token", async () => {
    routeApi(bothFormatItem);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("Download"));
    await waitFor(() =>
      expect(downloader.downloadBook).toHaveBeenCalledWith(
        expect.objectContaining({ id: "item1" }),
        "https://abs.test",
        "tok"
      )
    );
  });

  it("download button: while downloading shows percent and cancels", async () => {
    routeApi(bothFormatItem);
    const cancelDownload = jest.fn();
    useDownloadStore.setState({
      cancelDownload,
      activeDownloads: {
        item1: {
          id: "item1",
          libraryItemId: "item1",
          title: "The Hobbit",
          author: "",
          coverUrl: "",
          progress: 0.42,
          status: "downloading",
          parts: [],
        },
      },
    } as any);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Listening");

    const btn = screen.getByLabelText("Cancel download, 42 percent complete");
    expect(screen.getByText("42%")).toBeTruthy();
    await fireEvent.press(btn);
    expect(cancelDownload).toHaveBeenCalledWith("item1");
  });

  it("download button: downloaded → confirm-delete dialog then removeDownload", async () => {
    routeApi(bothFormatItem);
    const removeDownload = jest.fn();
    useDownloadStore.setState({
      removeDownload,
      completedDownloads: {
        item1: { id: "item1", libraryItemId: "item1", title: "The Hobbit", status: "completed", parts: [] },
      },
    } as any);
    const alertSpy = showAppDialog as jest.Mock;
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("Delete download"));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete download",
        message: expect.stringContaining("The Hobbit"),
        buttons: expect.any(Array),
      })
    );
    // Confirm the destructive action.
    const buttons = alertSpy.mock.calls[0][0].buttons as any[];
    const del = buttons.find((b) => b.text === "Delete");
    await act(async () => {
      del.onPress();
    });
    expect(removeDownload).toHaveBeenCalledWith("item1");
  });

  it("ebook-only item shows Read as the primary action and routes to the Reader", async () => {
    routeApi(ebookOnlyItem, []);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    const readBtn = await screen.findByLabelText("Read ebook");
    // No audio anywhere → no play button.
    expect(screen.queryByLabelText("Play")).toBeNull();
    expect(screen.queryByLabelText("Continue listening")).toBeNull();

    await fireEvent.press(readBtn);
    expect(navigation.navigate).toHaveBeenCalledWith("Reader", {
      itemId: "item1",
      ebookFormat: "epub",
      title: "Silmarillion Reader",
    });
  });

  it("podcast: renders episode rows (newest first) with progress and plays an episode", async () => {
    routeApi(podcastItem);
    useUserStore.setState({
      mediaProgress: {
        "pod1-ep1": { libraryItemId: "pod1", episodeId: "ep1", progress: 0.5, isFinished: false },
      },
    } as any);
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback } as any);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={navigation} />
    );

    await screen.findByText("2 Episodes");
    expect(screen.getByText("Episode One")).toBeTruthy();
    expect(screen.getByText("Episode Two")).toBeTruthy();

    // No item-level Download button for podcasts (no item-level audio), and the
    // old "aren't downloaded" note is gone now that episodes download per-row.
    expect(screen.queryByLabelText("Download")).toBeNull();
    expect(screen.queryByText(/aren't downloaded/)).toBeNull();
    // Each episode carries its own download control instead.
    expect(screen.getByLabelText("Download Episode One")).toBeTruthy();
    expect(screen.getByLabelText("Download Episode Two")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Play Episode One"));
    await waitFor(() => expect(startPlayback).toHaveBeenCalledWith("pod1", "ep1"));
  });

  it("podcast: per-episode download button triggers downloadEpisode and reflects downloaded/downloading state", async () => {
    routeApi(podcastItem);
    // ep1 already downloaded (composite key); ep2 mid-download.
    useDownloadStore.setState({
      completedDownloads: {
        "pod1::ep1": { id: "pod1::ep1", libraryItemId: "pod1", episodeId: "ep1", title: "Episode One" },
      },
      activeDownloads: {
        "pod1::ep2": {
          id: "pod1::ep2",
          libraryItemId: "pod1",
          episodeId: "ep2",
          title: "Episode Two",
          status: "downloading",
          progress: 0.42,
        },
      },
    } as any);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("2 Episodes");

    // ep1 downloaded → delete affordance; ep2 downloading → cancel affordance.
    expect(screen.getByLabelText("Delete download of Episode One")).toBeTruthy();
    expect(screen.getByLabelText(/Cancel download of Episode Two, 42 percent complete/)).toBeTruthy();

    // A NOT-downloaded episode would show a plain Download control — swap the
    // store to a clean slate and verify pressing it drives downloadEpisode.
    useDownloadStore.setState({ completedDownloads: {}, activeDownloads: {} } as any);
    await waitFor(() => expect(screen.getByLabelText("Download Episode One")).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Download Episode One"));
    await waitFor(() =>
      expect(downloader.downloadEpisode).toHaveBeenCalledWith(
        expect.objectContaining({ id: "pod1" }),
        expect.objectContaining({ id: "ep1" }),
        expect.any(String),
        expect.any(String)
      )
    );
  });

  it("podcast: filters episodes by Unplayed / In-Progress against the progress map", async () => {
    routeApi(podcastItem);
    // ep1 in-progress; ep2 has no progress → unplayed.
    useUserStore.setState({
      mediaProgress: {
        "pod1-ep1": { libraryItemId: "pod1", episodeId: "ep1", progress: 0.5, isFinished: false },
      },
    } as any);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("2 Episodes");
    expect(screen.getByText("Episode One")).toBeTruthy();
    expect(screen.getByText("Episode Two")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Filter: Unplayed"));
    expect(screen.queryByText("Episode One")).toBeNull();
    expect(screen.getByText("Episode Two")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Filter: In-Progress"));
    expect(screen.getByText("Episode One")).toBeTruthy();
    expect(screen.queryByText("Episode Two")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Filter: All"));
    expect(screen.getByText("Episode One")).toBeTruthy();
    expect(screen.getByText("Episode Two")).toBeTruthy();
  });

  it("podcast with no episodes: shows an empty state and disables the Play button", async () => {
    const emptyPodcast = {
      ...podcastItem,
      id: "pod-empty",
      media: { episodes: [], metadata: { title: "Silent Podcast" } },
    };
    routeApi(emptyPodcast);
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback } as any);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod-empty" } }} navigation={makeNavigation()} />
    );

    expect(await screen.findByText("No episodes available yet")).toBeTruthy();
    // A prominent Play button that does nothing is worse than a disabled one.
    const playBtn = screen.getByLabelText("Play");
    expect(playBtn).toBeDisabled();
    await fireEvent.press(playBtn);
    expect(startPlayback).not.toHaveBeenCalled();
  });

  it("podcast: hides the item-level Mark as finished button (episodes track their own progress)", async () => {
    routeApi(podcastItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("2 Episodes");
    // An item-level isFinished PATCH would write a bogus podcast-item entry.
    expect(screen.queryByLabelText("Mark as finished")).toBeNull();
    expect(screen.queryByLabelText("Mark as not finished")).toBeNull();
  });

  it("podcast: per-episode mark finished PATCHes the episode-scoped endpoint and updates the map", async () => {
    routeApi(podcastItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("2 Episodes");

    // Episodes render newest-first (ep2 published later than ep1), so the first
    // toggle belongs to ep2.
    const toggles = screen.getAllByLabelText("Mark episode finished");
    expect(toggles.length).toBe(2);
    await fireEvent.press(toggles[0]);

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith("/api/me/progress/pod1/ep2", { isFinished: true })
    );
    // Episode-scoped map key updates so the row flips immediately.
    expect(useUserStore.getState().mediaProgress["pod1-ep2"].isFinished).toBe(true);
    // No item-level write.
    expect(mockedPatch).not.toHaveBeenCalledWith("/api/me/progress/pod1", expect.anything());
  });

  it("podcast: episode mark finished queues an episode-scoped patch when offline", async () => {
    routeApi(podcastItem);
    mockedPatch.mockRejectedValue(new Error("Network Error"));
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("2 Episodes");

    await fireEvent.press(screen.getAllByLabelText("Mark episode finished")[0]);

    await waitFor(() =>
      expect(queueProgressPatch).toHaveBeenCalledWith(
        "pod1",
        expect.anything(),
        expect.anything(),
        "ep2",
        { isFinished: true }
      )
    );
    expect(useUserStore.getState().mediaProgress["pod1-ep2"].isFinished).toBe(true);
  });

  it("shows the error state and recovers via Retry", async () => {
    // A rejection WITH a response is a server failure (the offline copy is
    // reserved for requests that never reached the server).
    mockedGet.mockRejectedValueOnce({ response: { status: 500 } });
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Failed to load item details.");

    routeApi(bothFormatItem);
    await fireEvent.press(screen.getByText("Retry"));
    await screen.findByText("Listening");
  });

  it("shows offline copy when the request never reached the server", async () => {
    mockedGet.mockRejectedValueOnce(new Error("Network Error"));
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText(
      "You're offline. Reconnect to load this item, or download books ahead of time to use them offline."
    );
  });

  it("points offline users at the Downloads tab when the book is already downloaded", async () => {
    mockedGet.mockRejectedValueOnce(new Error("Network Error"));
    useDownloadStore.setState({
      completedDownloads: {
        item1: { id: "item1", libraryItemId: "item1", title: "The Hobbit", status: "completed", parts: [] },
      },
    } as any);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText(
      "You're offline. This book is downloaded — you can keep listening from the Downloads tab."
    );
  });

  it("shows and toggles the Want to Read (favorite) control, persisting to the store", async () => {
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");

    // Starts un-favorited.
    const addBtn = screen.getByLabelText("Add to Want to Read");
    expect(useFavoritesStore.getState().isFavorite("item1")).toBe(false);

    // The heart now lives over the cover, NOT in the secondary action row.
    expect(
      within(screen.getByTestId("detail-action-row")).queryByLabelText("Add to Want to Read")
    ).toBeNull();

    await fireEvent.press(addBtn);

    // Store reflects the toggle and the control flips to the "remove" state.
    await waitFor(() => expect(useFavoritesStore.getState().isFavorite("item1")).toBe(true));
    expect(screen.getByLabelText("Remove from Want to Read")).toBeTruthy();
    expect(screen.queryByLabelText("Add to Want to Read")).toBeNull();

    // Persisted under the store's own MMKV key.
    expect(JSON.parse(storage.getString("favorites") || "[]")).toContain("item1");

    // Toggling again removes it.
    await fireEvent.press(screen.getByLabelText("Remove from Want to Read"));
    await waitFor(() => expect(useFavoritesStore.getState().isFavorite("item1")).toBe(false));
  });

  it("reflects an already-favorited item on load", async () => {
    useFavoritesStore.setState({ favorites: ["item1"] });
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");
    expect(screen.getByLabelText("Remove from Want to Read")).toBeTruthy();
  });

  it("shows an error when no itemId is provided", async () => {
    const navigation = makeNavigation();
    await render(<ItemDetailScreen route={{ params: {} }} navigation={navigation} />);
    await screen.findByText("No item ID provided.");
    expect(screen.queryByText("Retry")).toBeNull();
  });
});

describe("Add to… (combined Up Next / collection / playlist sheet)", () => {
  // The combined sheet fetches collections + playlists on open — resolve them
  // (empty) so the sheet body renders instead of the load-error state.
  function routeApiWithLists(item: any, searchBooks: any[] = []) {
    mockedGet.mockImplementation((url: string) => {
      if (url.includes("/collections")) return Promise.resolve({ data: { results: [] } });
      if (url.includes("/playlists")) return Promise.resolve({ data: { results: [] } });
      if (url.startsWith(`/api/items/${item.id}`)) return Promise.resolve({ data: item });
      if (url.includes("/search?")) {
        return Promise.resolve({ data: { book: searchBooks.map((b) => ({ libraryItem: b })) } });
      }
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
  }

  it("merges the two add-buttons into a single Add to… button that opens the sheet", async () => {
    routeApiWithLists(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");

    // The two old, visually-identical add buttons are gone from the row.
    expect(screen.queryByLabelText("Add to Up Next queue")).toBeNull();
    expect(screen.queryByLabelText("Add to collection or playlist")).toBeNull();

    // A single combined button remains and opens the sheet.
    await fireEvent.press(screen.getByLabelText("Add to…"));
    await act(async () => {}); // flush the sheet's fetchLists

    // Sheet shows the Up Next toggle (audio book) plus collections/playlists.
    const upNextRow = await screen.findByLabelText("Up Next");
    expect(upNextRow).toBeTruthy();
    expect(upNextRow.props.accessibilityState?.checked).toBe(false);
    expect(screen.getByText("Collections")).toBeTruthy();
    expect(screen.getByText("Playlists")).toBeTruthy();
  });

  it("the Up Next row in the sheet queues the playable book via the store", async () => {
    routeApiWithLists(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("Add to…"));
    await act(async () => {});
    await fireEvent.press(await screen.findByLabelText("Up Next"));

    // Store now holds the queued book (title/author carried through).
    const queue = usePlaybackStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(
      expect.objectContaining({ libraryItemId: "item1", title: "The Hobbit", author: "J.R.R. Tolkien" })
    );
    // Row flips to the queued/checked state.
    expect(screen.getByLabelText("Up Next").props.accessibilityState?.checked).toBe(true);
  });

  it("an ebook-only item opens the sheet WITHOUT an Up Next row (nothing to queue)", async () => {
    routeApiWithLists(ebookOnlyItem, []);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findAllByText("Silmarillion Reader");

    // The combined button is still offered (collections/playlists apply)…
    await fireEvent.press(screen.getByLabelText("Add to…"));
    await act(async () => {});
    // …but there is nothing to queue, so no Up Next toggle appears.
    expect(await screen.findByText("Collections")).toBeTruthy();
    expect(screen.queryByLabelText("Up Next")).toBeNull();
  });

  it("hides the combined Add to… button for podcasts", async () => {
    routeApi(podcastItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("2 Episodes");
    expect(screen.queryByLabelText("Add to…")).toBeNull();
    // The stale separate queue button must be gone too.
    expect(screen.queryByLabelText("Add to Up Next queue")).toBeNull();
  });
});

describe("Podcast settings entry", () => {
  it("navigates to PodcastSettings with the podcast's libraryItemId and title", async () => {
    routeApi(podcastItem);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={navigation} />
    );
    await screen.findByText("2 Episodes");

    await fireEvent.press(screen.getByLabelText("Podcast settings"));
    expect(navigation.navigate).toHaveBeenCalledWith("PodcastSettings", {
      libraryItemId: "pod1",
      podcastTitle: "My Podcast",
    });
  });

  it("hides the Podcast settings entry for non-podcast (book) items", async () => {
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");
    expect(screen.queryByLabelText("Podcast settings")).toBeNull();
  });
});

describe("send ebook to device (Kindle etc.)", () => {
  const mockedPost = api.post as jest.Mock;

  it("hides the send action when no e-reader devices are configured", async () => {
    routeApi(ebookOnlyItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findAllByText("Silmarillion Reader");
    expect(screen.queryByLabelText("Send ebook to device")).toBeNull();
  });

  it("sends the ebook to the picked device via the email API", async () => {
    routeApi(ebookOnlyItem);
    useUserStore.setState({ ereaderDevices: [{ name: "My Kindle" }, { name: "Kobo" }] } as any);
    mockedPost.mockResolvedValue({ data: {} });
    const alertSpy = showAppDialog as jest.Mock;

    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findAllByText("Silmarillion Reader");

    await fireEvent.press(screen.getByLabelText("Send ebook to device"));
    // Device sheet lists both configured devices.
    await screen.findByText("My Kindle");
    expect(screen.getByText("Kobo")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Send to My Kindle"));
    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith("/api/emails/send-ebook-to-device", {
        libraryItemId: "item1",
        deviceName: "My Kindle",
      })
    );
    // In-sheet M3 result burst, not a system dialog.
    await screen.findByText("Sent to My Kindle");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("surfaces a failure alert when the server rejects the send", async () => {
    routeApi(ebookOnlyItem);
    useUserStore.setState({ ereaderDevices: [{ name: "My Kindle" }] } as any);
    mockedPost.mockRejectedValue(new Error("smtp down"));
    const alertSpy = showAppDialog as jest.Mock;
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findAllByText("Silmarillion Reader");
    await fireEvent.press(screen.getByLabelText("Send ebook to device"));
    await screen.findByText("My Kindle");
    await fireEvent.press(screen.getByLabelText("Send to My Kindle"));

    // Failure burst with a retry affordance, still inside the sheet.
    await screen.findByText("Couldn't send");
    await screen.findByLabelText("Try again");
    expect(alertSpy).not.toHaveBeenCalled();

    // Retry returns to the device list.
    await fireEvent.press(screen.getByLabelText("Try again"));
    await screen.findByText("My Kindle");
    errSpy.mockRestore();
  });

  it("audio-only items never show the send action even with devices", async () => {
    routeApi(audioOnlyItem);
    useUserStore.setState({ ereaderDevices: [{ name: "My Kindle" }] } as any);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");
    expect(screen.queryByLabelText("Send ebook to device")).toBeNull();
  });
});

describe("request the other format via ReadMeABook", () => {
  const rmab = require("../../utils/rmab");
  const { useRmabStore } = require("../../store/useRmabStore");

  afterEach(() => jest.restoreAllMocks());

  it("audio-only book on a JWT session offers Request ebook (fetch-ebook pipeline)", async () => {
    useRmabStore.setState({ configured: true, authMode: "jwt" } as any);
    const spy = jest.spyOn(rmab, "requestEbookForAsin").mockResolvedValue({});
    const withAsin = {
      ...audioOnlyItem,
      media: { ...audioOnlyItem.media, metadata: { ...audioOnlyItem.media.metadata, asin: "B0AUDIO01" } },
    };
    routeApi(withAsin);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("Request ebook edition"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("B0AUDIO01"));
    await screen.findByText("Ebook requested");
  });

  it("ebook-only book offers Request audiobook as an ordinary RMAB request", async () => {
    useRmabStore.setState({ configured: true, authMode: "apiToken" } as any);
    const spy = jest.spyOn(rmab, "createRequest").mockResolvedValue({});
    const withAsin = {
      ...ebookOnlyItem,
      media: { ...ebookOnlyItem.media, metadata: { ...ebookOnlyItem.media.metadata, asin: "B0EBOOK01" } },
    };
    routeApi(withAsin);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findAllByText("Silmarillion Reader");

    await fireEvent.press(screen.getByLabelText("Request audiobook edition"));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ asin: "B0EBOOK01", title: "Silmarillion Reader" })
      )
    );
    await screen.findByText("Audiobook requested");
  });

  it("collapses a rapid double-tap into a single RMAB request (in-flight guard)", async () => {
    useRmabStore.setState({ configured: true, authMode: "apiToken" } as any);
    // Hold the request open so the second tap lands while it's still "working".
    let resolveReq: (v?: any) => void = () => {};
    const spy = jest
      .spyOn(rmab, "createRequest")
      .mockImplementation(() => new Promise((r) => { resolveReq = r; }));
    const withAsin = {
      ...ebookOnlyItem,
      media: { ...ebookOnlyItem.media, metadata: { ...ebookOnlyItem.media.metadata, asin: "B0EBOOK01" } },
    };
    routeApi(withAsin);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findAllByText("Silmarillion Reader");

    // First tap starts the request and flips the button to working/disabled.
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Request audiobook edition"));
    });
    // Second tap while the request is in flight must be swallowed (guard +
    // disabled button) — no duplicate createRequest.
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Request audiobook edition"));
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // Settle the request so the success burst renders (no dangling promise/act).
    await act(async () => {
      resolveReq({});
    });
    await screen.findByText("Audiobook requested");
  });

  it("Request ebook stays hidden on API-token sessions (endpoint rejects them) and when RMAB is off", async () => {
    useRmabStore.setState({ configured: true, authMode: "apiToken" } as any);
    routeApi(audioOnlyItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");
    expect(screen.queryByLabelText("Request ebook edition")).toBeNull();

    useRmabStore.setState({ configured: false, authMode: null } as any);
    routeApi(ebookOnlyItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findAllByText("Silmarillion Reader");
    expect(screen.queryByLabelText("Request audiobook edition")).toBeNull();
  });
});

// --- Cross-medium progress: Sync button + Link (lock) toggle ----------------
describe("ItemDetailScreen — sync progress + link toggle", () => {
  /** Both-format item whose two progresses are within the 2pt threshold. */
  const alignedItem = {
    ...bothFormatItem,
    userMediaProgress: {
      ...bothFormatItem.userMediaProgress,
      progress: 0.5,
      ebookProgress: 0.49, // 50% vs 49% → below the |Δ|>=2 drift threshold
    },
  };

  it("shows the Sync progress action ONLY when both rows show and they differ", async () => {
    routeApi(bothFormatItem); // audio 50% vs ebook 25% → drifted
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");
    expect(screen.getByText("Sync progress")).toBeTruthy();
    // The lock toggle is always present on both-format items.
    expect(screen.getByLabelText("Link reading and listening")).toBeTruthy();
  });

  it("hides the Sync progress action when the two progresses are aligned (<2pt)", async () => {
    routeApi(alignedItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");
    expect(screen.queryByText("Sync progress")).toBeNull();
    // Toggle still offered (linking a currently-aligned book is valid).
    expect(screen.getByLabelText("Link reading and listening")).toBeTruthy();
  });

  it("is inert for a single-format (audio-only) item: no Sync button, no Link toggle", async () => {
    routeApi(audioOnlyItem); // no counterpart searchBooks → only the Listening row
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Listening");
    expect(screen.queryByText("Sync progress")).toBeNull();
    expect(screen.queryByLabelText("Link reading and listening")).toBeNull();
  });

  it("confirming Sync writes BOTH media to the max fraction (0.5)", async () => {
    (syncBothProgressFraction as jest.Mock).mockClear();
    (showAppDialog as jest.Mock).mockClear();
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("Sync progress");

    await fireEvent.press(screen.getByText("Sync progress"));
    // First dialog is the reconcile confirmation naming both percentages.
    const opts = (showAppDialog as jest.Mock).mock.calls[0][0];
    expect(opts.title).toBe("Sync progress");
    expect(opts.message).toContain("Listening 50%");
    expect(opts.message).toContain("Reading 25%");
    const confirmBtn = opts.buttons.find((b: any) => /Sync to 50%/.test(b.text));
    expect(confirmBtn).toBeTruthy();

    confirmBtn.onPress();
    // Furthest-along fraction (max of 0.5 audio / 0.25 ebook), duration passed
    // for the audio currentTime = fraction*duration write.
    expect(syncBothProgressFraction).toHaveBeenCalledWith(
      "item1",
      0.5,
      expect.objectContaining({ duration: 3600 })
    );
  });

  it("the Link toggle persists the per-item lock (and unlinks it)", async () => {
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    const toggle = await screen.findByLabelText("Link reading and listening");
    expect(useUserStore.getState().settings.linkedProgress?.item1).toBeFalsy();

    await fireEvent.press(toggle);
    await waitFor(() =>
      expect(useUserStore.getState().settings.linkedProgress?.item1).toBe(true)
    );

    await fireEvent.press(screen.getByLabelText("Link reading and listening"));
    await waitFor(() =>
      expect(useUserStore.getState().settings.linkedProgress?.item1).toBeFalsy()
    );
  });
});

// --- Read handoff: the READER owns the linked catch-up seek (P1/P2) ----------
// The old percentage gate here was self-defeating: ItemDetail's focus-effect /
// audio-close reconcile bumps this item's ebookProgress % up to the audio
// fraction WITHOUT moving the CFI, so by the time the user taps Read the gate
// (ebook% < audio%) was already false and the reader opened at the stale CFI.
// openReader now NEVER passes an automatic initialFraction — the reader
// self-handles the forward-only linked seek on its 'ready' message, keyed off
// its TRUE rendered page. That also fixes every OTHER entry point at once.
describe("ItemDetailScreen — open reader (linked catch-up is reader-owned)", () => {
  /** Pull the params of the (single) navigate("Reader", …) call. */
  const readerParams = (navigation: any) => {
    const call = (navigation.navigate as jest.Mock).mock.calls.find(
      (c) => c[0] === "Reader"
    );
    return call?.[1];
  };

  const linkItem = (id: string) =>
    useUserStore.setState((s) => ({
      settings: { ...s.settings, linkedProgress: { ...s.settings.linkedProgress, [id]: true } },
    }));

  it("LINKED book listened ahead of reading: Read routes WITHOUT an initialFraction (reader self-seeks)", async () => {
    // audio 50% vs ebook 25% (bothFormatItem), epub → jumpable. The reader, not
    // ItemDetail, performs the forward seek on ready, so no fraction is passed.
    linkItem("item1");
    routeApi(bothFormatItem);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await fireEvent.press(await screen.findByLabelText("Read ebook"));

    const params = readerParams(navigation);
    expect(params.itemId).toBe("item1");
    expect(params.ebookFormat).toBe("epub");
    // No auto initialFraction — the reader is the single source of truth.
    expect(params.initialFraction).toBeUndefined();
    expect("initialFraction" in params).toBe(false);
  });

  it("NON-linked book (even when listened ahead): Read opens with no forced seek", async () => {
    routeApi(bothFormatItem);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await fireEvent.press(await screen.findByLabelText("Read ebook"));

    expect(readerParams(navigation).initialFraction).toBeUndefined();
  });

  it("LINKED book already read PAST the listening spot: Read passes no fraction (reader forward-only guards backward)", async () => {
    const readAhead = {
      ...bothFormatItem,
      userMediaProgress: {
        ...bothFormatItem.userMediaProgress,
        progress: 0.3,
        ebookProgress: 0.6,
      },
    };
    linkItem("item1");
    routeApi(readAhead);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await fireEvent.press(await screen.findByLabelText("Read ebook"));

    expect(readerParams(navigation).initialFraction).toBeUndefined();
  });
});

// --- Overflow (More actions): capability-gated admin/tools/share/zip/history --
describe("ItemDetailScreen — overflow (More actions)", () => {
  const { Linking, Clipboard } = require("react-native");

  /** admin session on a share-capable server version. */
  const setAdmin = () =>
    useUserStore.setState({
      user: { id: "u1", username: "boss", type: "admin", permissions: {} },
      serverConnectionConfig: { address: "https://abs.test", token: "tok", version: "2.35.1" },
    } as any);

  /** plain user with NO permission flags. */
  const setPlainUser = () =>
    useUserStore.setState({
      user: {
        id: "u2",
        username: "joe",
        type: "user",
        permissions: { download: false, update: false, delete: false, upload: false },
      },
    } as any);

  const openOverflow = async () => {
    await screen.findByText("Listening");
    await fireEvent.press(screen.getByLabelText("More actions"));
  };

  it("admin: overflow lists every capability-gated entry", async () => {
    setAdmin();
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();

    expect(screen.getByText("Edit metadata")).toBeTruthy();
    expect(screen.getByText("Edit chapters")).toBeTruthy();
    expect(screen.getByText("Tools")).toBeTruthy();
    expect(screen.getByText("Download all (zip)")).toBeTruthy();
    expect(screen.getByText("Share link")).toBeTruthy();
    expect(screen.getByText("Listening history")).toBeTruthy();
  });

  it("non-privileged user: only Listening history remains", async () => {
    setPlainUser();
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();

    expect(screen.queryByText("Edit metadata")).toBeNull();
    expect(screen.queryByText("Edit chapters")).toBeNull();
    expect(screen.queryByText("Tools")).toBeNull();
    expect(screen.queryByText("Download all (zip)")).toBeNull();
    expect(screen.queryByText("Share link")).toBeNull();
    expect(screen.getByText("Listening history")).toBeTruthy();
  });

  it("update+download permissions (non-admin) unlock metadata/chapters/zip but NOT admin-only Tools/Share", async () => {
    useUserStore.setState({
      user: {
        id: "u3",
        username: "editor",
        type: "user",
        permissions: { update: true, download: true, delete: false, upload: false },
      },
      serverConnectionConfig: { address: "https://abs.test", token: "tok", version: "2.35.1" },
    } as any);
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();

    expect(screen.getByText("Edit metadata")).toBeTruthy();
    expect(screen.getByText("Edit chapters")).toBeTruthy();
    expect(screen.getByText("Download all (zip)")).toBeTruthy();
    // Tools + share links are admin-typed operations, not permission flags.
    expect(screen.queryByText("Tools")).toBeNull();
    expect(screen.queryByText("Share link")).toBeNull();
  });

  it("admin WITHOUT a known server version: Share link hidden (version gate), rest intact", async () => {
    useUserStore.setState({
      user: { id: "u1", username: "boss", type: "admin", permissions: {} },
      serverConnectionConfig: { address: "https://abs.test", token: "tok" }, // no version
    } as any);
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();

    expect(screen.queryByText("Share link")).toBeNull();
    expect(screen.getByText("Edit metadata")).toBeTruthy();
    expect(screen.getByText("Tools")).toBeTruthy();
  });

  it("podcast: audio-file entries (chapters/tools/share) hidden; metadata + history offered", async () => {
    setAdmin();
    routeApi(podcastItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "pod1" } }} navigation={makeNavigation()} />
    );
    await screen.findByText("2 Episodes");
    await fireEvent.press(screen.getByLabelText("More actions"));

    expect(screen.getByText("Edit metadata")).toBeTruthy();
    expect(screen.getByText("Listening history")).toBeTruthy();
    expect(screen.queryByText("Edit chapters")).toBeNull();
    expect(screen.queryByText("Tools")).toBeNull();
    expect(screen.queryByText("Share link")).toBeNull();
  });

  it("navigates to EditMetadata / ChapterEditor / ItemHistory by route name + libraryItemId", async () => {
    setAdmin();
    routeApi(bothFormatItem);
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );

    await openOverflow();
    await fireEvent.press(screen.getByText("Edit metadata"));
    expect(navigation.navigate).toHaveBeenCalledWith("EditMetadata", { libraryItemId: "item1" });

    await fireEvent.press(screen.getByLabelText("More actions"));
    await fireEvent.press(screen.getByText("Edit chapters"));
    expect(navigation.navigate).toHaveBeenCalledWith("ChapterEditor", { libraryItemId: "item1" });

    await fireEvent.press(screen.getByLabelText("More actions"));
    await fireEvent.press(screen.getByText("Listening history"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemHistory", { libraryItemId: "item1" });
  });

  it("zip download: confirm dialog → URL builder → OS handoff (never axios)", async () => {
    setAdmin();
    (buildItemZipDownloadUrl as jest.Mock).mockReturnValue(
      "https://abs.test/api/items/item1/download?token=tok"
    );
    const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as any);
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();

    await fireEvent.press(screen.getByText("Download all (zip)"));
    expect(buildItemZipDownloadUrl).toHaveBeenCalledWith("item1");
    // Informational confirm first (size + download-manager handoff note).
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Download all files");
    expect(dialog.message).toContain("118 MB"); // fixture size, surfaced pre-confirm
    expect(openSpy).not.toHaveBeenCalled();

    await act(async () => {
      dialog.buttons.find((b: any) => b.text === "Download").onPress();
    });
    expect(openSpy).toHaveBeenCalledWith("https://abs.test/api/items/item1/download?token=tok");
    expect(showSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("download") })
    );
    openSpy.mockRestore();
  });

  it("tools: M4B encode = confirm → POST → task watch → completion snackbar", async () => {
    setAdmin();
    (encodeM4b as jest.Mock).mockResolvedValue(undefined);
    (startTaskWatch as jest.Mock).mockResolvedValue({
      id: "t1",
      action: "encode-m4b",
      data: { libraryItemId: "item1" },
      title: "Encoding",
      error: null,
      isFailed: false,
      isFinished: true,
      startedAt: 1,
      finishedAt: 2,
    });
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();
    await fireEvent.press(screen.getByText("Tools"));
    await fireEvent.press(await screen.findByText("Encode as M4B"));

    // Nothing fires before the Tier-2 confirm.
    expect(encodeM4b).not.toHaveBeenCalled();
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Encode as M4B");

    await act(async () => {
      await dialog.buttons.find((b: any) => b.text === "Start encode").onPress();
    });
    expect(encodeM4b).toHaveBeenCalledWith("item1");
    expect(showSnackbar).toHaveBeenCalledWith({ message: "M4B encode started" });
    // The watch matcher keys on the encode action AND this item's id.
    const matcher = (startTaskWatch as jest.Mock).mock.calls[0][0];
    expect(matcher({ action: "encode-m4b", data: { libraryItemId: "item1" } })).toBe(true);
    expect(matcher({ action: "encode-m4b", data: { libraryItemId: "other" } })).toBe(false);
    expect(matcher({ action: "library-scan", data: { libraryItemId: "item1" } })).toBe(false);
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith({ message: "M4B encode finished" })
    );
  });

  it("tools: embed metadata confirm → POST → failure snackbar carries the task error", async () => {
    setAdmin();
    (embedMetadata as jest.Mock).mockResolvedValue(undefined);
    (startTaskWatch as jest.Mock).mockResolvedValue({
      id: "t2",
      action: "embed-metadata",
      data: { libraryItemId: "item1" },
      title: "Embedding",
      error: "ffmpeg exploded",
      isFailed: true,
      isFinished: true,
      startedAt: 1,
      finishedAt: 2,
    });
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();
    await fireEvent.press(screen.getByText("Tools"));
    await fireEvent.press(await screen.findByText("Embed metadata"));

    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Embed metadata");
    await act(async () => {
      await dialog.buttons.find((b: any) => b.text === "Embed").onPress();
    });
    expect(embedMetadata).toHaveBeenCalledWith("item1");
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith({
        message: expect.stringContaining("ffmpeg exploded"),
      })
    );
  });

  it("share link: create posts the MEDIA id (not libraryItemId) with numeric expiresAt 0 for Never", async () => {
    setAdmin();
    (createShareLink as jest.Mock).mockResolvedValue({
      id: "share1",
      slug: "the-hobbit",
      expiresAt: 0,
      mediaItemId: "book-media-1",
    });
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();
    await fireEvent.press(screen.getByText("Share link"));

    // Slug prefilled from the title.
    const slugInput = await screen.findByLabelText("Share link slug");
    expect(slugInput.props.value).toBe("the-hobbit");

    await fireEvent.press(screen.getByLabelText("Expires: Never"));
    await fireEvent.press(screen.getByLabelText("Create share link"));

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        slug: "the-hobbit",
        mediaItemId: "book-media-1", // media id, NOT "item1"
        mediaItemType: "book",
        expiresAt: 0,
      })
    );
    // The minted public URL renders for copying.
    await screen.findByText("https://abs.test/share/the-hobbit");
  });

  it("share link: default expiry produces a future numeric timestamp", async () => {
    setAdmin();
    (createShareLink as jest.Mock).mockResolvedValue({ id: "share1", slug: "the-hobbit" });
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();
    await fireEvent.press(screen.getByText("Share link"));
    await screen.findByLabelText("Share link slug");
    const before = Date.now();
    await fireEvent.press(screen.getByLabelText("Create share link"));

    await waitFor(() => expect(createShareLink).toHaveBeenCalled());
    const payload = (createShareLink as jest.Mock).mock.calls[0][0];
    // Default preset is 1 week — a real epoch-ms number, never null.
    expect(typeof payload.expiresAt).toBe("number");
    expect(payload.expiresAt).toBeGreaterThanOrEqual(before + 6 * 24 * 60 * 60 * 1000);
  });

  it("share link: copy uses the clipboard; delete confirms then DELETEs", async () => {
    setAdmin();
    (createShareLink as jest.Mock).mockResolvedValue({ id: "share1", slug: "the-hobbit" });
    (deleteShareLink as jest.Mock).mockResolvedValue(undefined);
    const clipSpy = jest.spyOn(Clipboard, "setString").mockImplementation(() => {});
    routeApi(bothFormatItem);
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await openOverflow();
    await fireEvent.press(screen.getByText("Share link"));
    await screen.findByLabelText("Share link slug");
    await fireEvent.press(screen.getByLabelText("Create share link"));
    await screen.findByText("Copy link");

    await fireEvent.press(screen.getByText("Copy link"));
    expect(clipSpy).toHaveBeenCalledWith("https://abs.test/share/the-hobbit");
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Link copied" });

    await fireEvent.press(screen.getByText("Delete link"));
    expect(deleteShareLink).not.toHaveBeenCalled(); // Tier-2 confirm first
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Delete share link");
    await act(async () => {
      await dialog.buttons.find((b: any) => b.text === "Delete").onPress();
    });
    expect(deleteShareLink).toHaveBeenCalledWith("share1");
    clipSpy.mockRestore();
  });

  it("slugifyTitle produces url-safe slugs", () => {
    expect(slugifyTitle("The Hobbit")).toBe("the-hobbit");
    expect(slugifyTitle("  Dune: Messiah! (Unabridged)  ")).toBe("dune-messiah-unabridged");
    expect(slugifyTitle("")).toBe("");
  });
});
