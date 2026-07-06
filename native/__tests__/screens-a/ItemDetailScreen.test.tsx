/**
 * ItemDetailScreen — item load + metadata render, per-format progress rows,
 * mark-finished (online w/ fuzzy counterpart + offline queue), download button
 * states, play/read routing, and podcast episode rows.
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert } from "react-native";

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
}));
jest.mock("../../utils/downloader", () => ({
  downloader: {
    downloadBook: jest.fn().mockResolvedValue(undefined),
    resumeDownload: jest.fn().mockResolvedValue(undefined),
    abortBookParts: jest.fn().mockResolvedValue(undefined),
    sweepOrphanFolders: jest.fn().mockResolvedValue(undefined),
  },
}));

import ItemDetailScreen from "../../screens/ItemDetailScreen";
import { api } from "../../utils/api";
import { queueFinishedPatch } from "../../utils/progressSync";
import { downloader } from "../../utils/downloader";
import { useUserStore } from "../../store/useUserStore";
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

  it("download button: downloaded → confirm-delete Alert then removeDownload", async () => {
    routeApi(bothFormatItem);
    const removeDownload = jest.fn();
    useDownloadStore.setState({
      removeDownload,
      completedDownloads: {
        item1: { id: "item1", libraryItemId: "item1", title: "The Hobbit", status: "completed", parts: [] },
      },
    } as any);
    const alertSpy = jest.spyOn(Alert, "alert");
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Listening");

    await fireEvent.press(screen.getByLabelText("Delete download"));
    expect(alertSpy).toHaveBeenCalledWith(
      "Delete download",
      expect.stringContaining("The Hobbit"),
      expect.any(Array)
    );
    // Confirm the destructive action.
    const buttons = alertSpy.mock.calls[0][2] as any[];
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

    await fireEvent.press(screen.getByLabelText("Play Episode One"));
    await waitFor(() => expect(startPlayback).toHaveBeenCalledWith("pod1", "ep1"));
  });

  it("shows the error state and recovers via Retry", async () => {
    mockedGet.mockRejectedValueOnce(new Error("boom"));
    const navigation = makeNavigation();
    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={navigation} />
    );
    await screen.findByText("Failed to load item details.");

    routeApi(bothFormatItem);
    await fireEvent.press(screen.getByText("Retry"));
    await screen.findByText("Listening");
  });

  it("shows an error when no itemId is provided", async () => {
    const navigation = makeNavigation();
    await render(<ItemDetailScreen route={{ params: {} }} navigation={navigation} />);
    await screen.findByText("No item ID provided.");
    expect(screen.queryByText("Retry")).toBeNull();
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
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

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
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Ebook sent", "Sent to My Kindle."));
    alertSpy.mockRestore();
  });

  it("surfaces a failure alert when the server rejects the send", async () => {
    routeApi(ebookOnlyItem);
    useUserStore.setState({ ereaderDevices: [{ name: "My Kindle" }] } as any);
    mockedPost.mockRejectedValue(new Error("smtp down"));
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await render(
      <ItemDetailScreen route={{ params: { itemId: "item1" } }} navigation={makeNavigation()} />
    );
    await screen.findAllByText("Silmarillion Reader");
    await fireEvent.press(screen.getByLabelText("Send ebook to device"));
    await screen.findByText("My Kindle");
    await fireEvent.press(screen.getByLabelText("Send to My Kindle"));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "Send failed",
        "Could not send the ebook. Check the server's email settings."
      )
    );
    alertSpy.mockRestore();
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
