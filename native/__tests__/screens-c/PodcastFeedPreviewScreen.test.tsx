/**
 * PodcastFeedPreviewScreen — preview a feed and add the podcast (issue #56 P2).
 *
 * Pins the load-bearing behaviors:
 *  - mount POSTs /api/podcasts/feed { rssFeed } (the pinned body key);
 *  - folder options come from the SELECTED library's folders (lone folder
 *    auto-selects) and the destination path preview sanitizes the show title;
 *  - "Add podcast" stays disabled until a folder is chosen, confirms, then
 *    POSTs /api/podcasts with the EXACT web-client-mirrored payload
 *    (path/folderId/libraryId top-level; metadata + autoDownload* under media;
 *    autoDownloadSchedule only when the toggle is on);
 *  - create failure → dialog; feed-load failure → ErrorState with a working
 *    Retry.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import PodcastFeedPreviewScreen, {
  sanitizePodcastDirName,
} from "../../screens/PodcastFeedPreviewScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";

const FEED_URL = "https://feeds.example/show";

const FEED = {
  metadata: {
    title: "My Show: Extra!",
    author: "Jane Doe",
    description: "A show about things.",
    feedUrl: FEED_URL,
    imageUrl: "https://img.example/cover.jpg",
    itunesId: 123,
    language: "en",
    explicit: false,
    genres: ["Technology"],
  },
  episodes: Array.from({ length: 12 }, (_, i) => ({ title: `Episode ${i + 1}` })),
};

const LIBS = [
  {
    id: "lib-books",
    name: "Audiobooks",
    mediaType: "book",
    folders: [{ id: "fb", fullPath: "/books" }],
  },
  {
    id: "lib-pods",
    name: "Podcasts",
    mediaType: "podcast",
    folders: [{ id: "f1", fullPath: "/podcasts" }],
  },
  {
    id: "lib-pods2",
    name: "More Podcasts",
    mediaType: "podcast",
    folders: [
      { id: "f2", fullPath: "/other-pods" },
      { id: "f3", fullPath: "/more-pods" },
    ],
  },
];

function mockApi() {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/libraries") return Promise.resolve({ data: { libraries: LIBS } });
    return Promise.reject(new Error(`unmocked GET ${url}`));
  });
  (api.post as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/podcasts/feed") return Promise.resolve({ data: { podcast: FEED } });
    if (url === "/api/podcasts") return Promise.resolve({ data: {} });
    return Promise.reject(new Error(`unmocked POST ${url}`));
  });
}

function makeNavigation() {
  return {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  } as any;
}

async function renderScreen(params: any = { feedUrl: FEED_URL, libraryId: "lib-pods" }) {
  const navigation = makeNavigation();
  await render(<PodcastFeedPreviewScreen navigation={navigation} route={{ params }} />);
  await act(async () => {});
  return navigation;
}

/** Confirm the "Add podcast" dialog's Add button. */
const confirmAdd = async () => {
  const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
  expect(dialog.title).toBe("Add podcast");
  await act(async () => {
    await dialog.buttons.find((b: any) => b.text === "Add").onPress();
  });
};

const createCalls = () =>
  (api.post as jest.Mock).mock.calls.filter(([url]) => url === "/api/podcasts");

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  mockApi();
});

it("sanitizePodcastDirName strips illegal dirname characters and collapses whitespace", () => {
  expect(sanitizePodcastDirName("My Show: Extra!")).toBe("My Show Extra");
  expect(sanitizePodcastDirName("  a / b \\ c  ")).toBe("a b c");
  expect(sanitizePodcastDirName("under_score-dash 9")).toBe("under_score-dash 9");
  expect(sanitizePodcastDirName("???")).toBe("podcast");
  expect(sanitizePodcastDirName("")).toBe("podcast");
});

describe("PodcastFeedPreviewScreen — feed load", () => {
  it("mounts → POST /api/podcasts/feed { rssFeed } and renders the show header + episode preview", async () => {
    await renderScreen();
    expect(api.post).toHaveBeenCalledWith("/api/podcasts/feed", { rssFeed: FEED_URL });

    expect(screen.getByText("My Show: Extra!")).toBeTruthy();
    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.getByText("A show about things.")).toBeTruthy();
    // First 10 episode titles + the overflow line.
    expect(screen.getByText("Episode 1")).toBeTruthy();
    expect(screen.getByText("Episode 10")).toBeTruthy();
    expect(screen.queryByText("Episode 11")).toBeNull();
    expect(screen.getByText("…and 2 more")).toBeTruthy();
  });

  it("feed-load failure shows an ErrorState whose Retry refetches", async () => {
    (api.post as jest.Mock).mockRejectedValue(new Error("Network Error")); // no response → offline
    await renderScreen();
    await screen.findByText("You're offline");

    mockApi(); // heal the mock (implementation only — call history remains), then retry
    await fireEvent.press(screen.getByLabelText("Retry"));
    await screen.findByText("My Show: Extra!");
    expect(
      (api.post as jest.Mock).mock.calls.filter(([url]) => url === "/api/podcasts/feed")
    ).toHaveLength(2); // initial failed fetch + the retry's refetch
  });

  it("a libraries failure is NOT reported as a feed error — feed renders + inline retry", async () => {
    // Feed POST still succeeds (from beforeEach); only /api/libraries fails.
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/libraries")
        return Promise.reject(Object.assign(new Error("boom"), { response: { status: 500 } }));
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    await renderScreen();

    // The feed header renders — NOT the feed/offline error state…
    expect(await screen.findByText("My Show: Extra!")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
    // …and the destination section owns its own libraries retry.
    expect(screen.getByText("Couldn't load your libraries. Tap to retry.")).toBeTruthy();
  });
});

describe("PodcastFeedPreviewScreen — destination", () => {
  it("auto-selects a lone folder and previews the sanitized destination path", async () => {
    await renderScreen();
    // lib-pods (preselected via params) has one folder → auto-selected.
    expect(screen.getByLabelText("Folder, /podcasts")).toBeTruthy();
    expect(screen.getByText("Will be created at: /podcasts/My Show Extra")).toBeTruthy();
  });

  it("folder options come from the SELECTED library; Add is disabled until one is chosen", async () => {
    await renderScreen({ feedUrl: FEED_URL, libraryId: "lib-pods2" });

    // Two folders → nothing auto-selected → Add disabled.
    const addBtn = screen.getByLabelText("Add podcast");
    expect(addBtn.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText("Choose a folder to see the destination path.")).toBeTruthy();

    // The folder picker lists exactly lib-pods2's folders.
    await fireEvent.press(screen.getByLabelText("Folder, Choose a folder"));
    expect(screen.getByLabelText("/other-pods")).toBeTruthy();
    expect(screen.getByLabelText("/more-pods")).toBeTruthy();
    expect(screen.queryByLabelText("/podcasts")).toBeNull();

    await fireEvent.press(screen.getByLabelText("/more-pods"));
    expect(screen.getByText("Will be created at: /more-pods/My Show Extra")).toBeTruthy();
    expect(
      screen.getByLabelText("Add podcast").props.accessibilityState?.disabled
    ).toBe(false);
  });

  it("switching the library repopulates the folder choice", async () => {
    await renderScreen(); // lib-pods, folder /podcasts auto-selected
    await fireEvent.press(screen.getByLabelText("Library, Podcasts"));
    await fireEvent.press(screen.getByLabelText("More Podcasts"));

    // The stale folder selection is cleared (lib-pods2 has two folders).
    expect(screen.getByLabelText("Folder, Choose a folder")).toBeTruthy();
    expect(screen.getByText("Choose a folder to see the destination path.")).toBeTruthy();
  });
});

describe("PodcastFeedPreviewScreen — add podcast", () => {
  it("confirms, then POSTs /api/podcasts with the EXACT payload (no schedule when auto-download is off)", async () => {
    await renderScreen();

    await fireEvent.press(screen.getByLabelText("Add podcast"));
    // Nothing sent before the confirm.
    expect(createCalls()).toHaveLength(0);
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.message).toBe('Add "My Show: Extra!" to Podcasts?');

    await confirmAdd();

    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0][1]).toEqual({
      path: "/podcasts/My Show Extra",
      folderId: "f1",
      libraryId: "lib-pods",
      media: {
        metadata: {
          title: "My Show: Extra!",
          author: "Jane Doe",
          description: "A show about things.",
          feedUrl: FEED_URL,
          imageUrl: "https://img.example/cover.jpg",
          // Stringified to match the metadata editor's write path (the feed
          // seeds a numeric 123).
          itunesId: "123",
          language: "en",
          explicit: false,
          genres: ["Technology"],
        },
        autoDownloadEpisodes: false,
      },
    });

    // Success dialog follows (no deep link into P3-owned routes).
    const success = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(success.title).toBe("Podcast added");
  });

  it("falls back to the provider artworkUrl for the created cover when the feed has none", async () => {
    // Feed metadata carries no imageUrl; the provider seed exposes the art as
    // `artworkUrl` (not `cover`) — it must still reach the created podcast.
    (api.post as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/podcasts/feed")
        return Promise.resolve({ data: { podcast: { metadata: { title: "Arty Show" }, episodes: [] } } });
      if (url === "/api/podcasts") return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });
    await renderScreen({
      feedUrl: FEED_URL,
      libraryId: "lib-pods",
      seed: { artworkUrl: "https://provider/art.jpg" },
    });

    await fireEvent.press(screen.getByLabelText("Add podcast"));
    await confirmAdd();

    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0][1].media.metadata.imageUrl).toBe("https://provider/art.jpg");
  });

  it("success dialog's Done pops back with goBack()", async () => {
    const navigation = await renderScreen();
    await fireEvent.press(screen.getByLabelText("Add podcast"));
    await confirmAdd();

    const success = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(success.title).toBe("Podcast added");
    await act(async () => {
      success.buttons.find((b: any) => b.text === "Done").onPress();
    });
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("auto-download on + a cron preset chip rides into the payload as autoDownloadSchedule", async () => {
    await renderScreen();

    // ToggleRow (accessible switch) turns auto-download on; presets appear.
    await fireEvent.press(
      screen.getByLabelText(/Auto-download episodes/)
    );
    await fireEvent.press(screen.getByLabelText("Schedule: Daily"));

    await fireEvent.press(screen.getByLabelText("Add podcast"));
    await confirmAdd();

    expect(createCalls()[0][1].media).toEqual(
      expect.objectContaining({
        autoDownloadEpisodes: true,
        autoDownloadSchedule: "0 3 * * *", // PodcastSettings "Daily" preset value
      })
    );
  });

  it("create failure surfaces the AbsError dialog and releases the busy state", async () => {
    (api.post as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/podcasts/feed") return Promise.resolve({ data: { podcast: FEED } });
      if (url === "/api/podcasts")
        return Promise.reject({ response: { status: 500, data: "boom" } });
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });
    await renderScreen();

    await fireEvent.press(screen.getByLabelText("Add podcast"));
    await confirmAdd();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't add the podcast", message: "boom" })
      )
    );
    // Retryable: Add re-enables.
    const addBtn = screen.getByLabelText("Add podcast");
    expect(addBtn.props.accessibilityState?.busy).toBe(false);
    expect(addBtn.props.accessibilityState?.disabled).toBe(false);
  });
});
