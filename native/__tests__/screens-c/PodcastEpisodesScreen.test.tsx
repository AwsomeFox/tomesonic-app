/**
 * PodcastEpisodesScreen — browse a podcast's feed and manage server episodes
 * (issue #56 P3): feed fetch + on-server badge diffing (enclosure-url first),
 * the client-side title filter, multi-select download (BARE-ARRAY POST body of
 * the RAW feed episode objects + the download-podcast-episode task watch),
 * the sequential delete flow (hard param only when chosen; 404 → graceful
 * "not supported" dialog), and the non-admin lock.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));
// The task poller is module-level singleton state — control the watch promise
// instead of running the real timer loop.
jest.mock("../../utils/abs/tasks", () => ({ startTaskWatch: jest.fn() }));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import PodcastEpisodesScreen from "../../screens/PodcastEpisodesScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { startTaskWatch } from "../../utils/abs/tasks";
import { useUserStore } from "../../store/useUserStore";

const initialUser = useUserStore.getState();

const ADMIN_USER = { id: "u1", username: "tony", type: "admin", permissions: {} };
const PLAIN_USER = {
  id: "u2",
  username: "pat",
  type: "user",
  permissions: { update: false, delete: false, download: true, upload: false },
};

const FEED_URL = "https://feeds.example.com/pod.xml";

// Server episode A matches feed episode A on ENCLOSURE URL ONLY (different
// guid and title) — proving the diff's first-tier match.
const SERVER_EPISODES = [
  {
    id: "ep-a",
    title: "Episode A (remastered)",
    enclosure: { url: "https://cdn.example.com/a.mp3" },
    guid: "server-guid-a",
    pubDate: "2026-06-01T08:00:00.000Z",
    publishedAt: 1780000000000,
    size: 12 * 1024 * 1024,
  },
];

const ITEM = {
  id: "pod1",
  mediaType: "podcast",
  media: {
    metadata: { title: "My Great Podcast", feedUrl: FEED_URL },
    episodes: SERVER_EPISODES,
  },
};

// RAW feed episode objects — the POST body must carry these verbatim.
const FEED_EP_A = {
  title: "Episode A",
  enclosure: { url: "https://cdn.example.com/a.mp3", length: "1234" },
  guid: "guid-a",
  pubDate: "Mon, 01 Jun 2026 08:00:00 GMT",
};
const FEED_EP_B = {
  title: "Episode B",
  enclosure: { url: "https://cdn.example.com/b.mp3" },
  guid: "guid-b",
  pubDate: "Mon, 08 Jun 2026 08:00:00 GMT",
};
const FEED_EP_C = {
  title: "Chatter special",
  enclosure: { url: "https://cdn.example.com/c.mp3" },
  guid: "guid-c",
};
const FEED_EPISODES = [FEED_EP_A, FEED_EP_B, FEED_EP_C];

function mockApi({ item = ITEM, feedEpisodes = FEED_EPISODES }: any = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url.startsWith("/api/items/pod1")) return Promise.resolve({ data: item });
    return Promise.resolve({ data: {} });
  });
  (api.post as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/podcasts/feed")
      return Promise.resolve({ data: { podcast: { episodes: feedEpisodes } } });
    return Promise.resolve({ data: {} });
  });
  (api.delete as jest.Mock).mockResolvedValue({ data: {} });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen(params: any = { libraryItemId: "pod1" }) {
  const navigation = makeNavigation();
  await render(<PodcastEpisodesScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

function dialogByTitle(title: string) {
  return (showAppDialog as jest.Mock).mock.calls.map((c) => c[0]).find((d) => d?.title === title);
}

const itemGetCount = () =>
  (api.get as jest.Mock).mock.calls.filter((c) => String(c[0]).startsWith("/api/items/pod1")).length;

let resolveWatch: ((t: any) => void) | null;

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useUserStore.setState({ user: ADMIN_USER } as any);
  resolveWatch = null;
  (startTaskWatch as jest.Mock).mockImplementation(
    () => new Promise((res) => (resolveWatch = res))
  );
  mockApi();
});

describe("PodcastEpisodesScreen", () => {
  it("loads the item (?expanded=1) + feed and badges on-server episodes via the enclosure-url match", async () => {
    await renderScreen();

    expect(await screen.findByText("Episode A")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/items/pod1?expanded=1");
    // Feed parsed server-side from the item's feedUrl.
    expect(api.post).toHaveBeenCalledWith("/api/podcasts/feed", { rssFeed: FEED_URL });

    // Feed episode A matches the server episode on enclosure.url alone (guid
    // and title differ) → badged; B and C are not on the server.
    expect(screen.getByLabelText("Episode: Episode A, on server")).toBeTruthy();
    expect(screen.getAllByTestId("on-server-badge")).toHaveLength(1);
    expect(screen.getByLabelText("Episode: Episode B")).toBeTruthy();
    expect(screen.getByLabelText("Episode: Chatter special")).toBeTruthy();
    expect(screen.getByText("3 feed episodes")).toBeTruthy();
  });

  it("the client-side title filter narrows the feed list", async () => {
    await renderScreen();
    await screen.findByText("Episode A");

    fireEvent.changeText(screen.getByLabelText("Filter episodes by title"), "chatter");

    await waitFor(() => expect(screen.queryByText("Episode B")).toBeNull());
    expect(screen.getByText("Chatter special")).toBeTruthy();
    expect(screen.queryByText("Episode A")).toBeNull();
    expect(screen.getByText("1 feed episode")).toBeTruthy();
  });

  it("on-server feed rows can't enter selection mode", async () => {
    await renderScreen();
    await screen.findByText("Episode A");

    fireEvent(screen.getByLabelText("Episode: Episode A, on server"), "longPress");
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("server episodes without an id are not selectable (delete would no-op)", async () => {
    const item = {
      ...ITEM,
      media: {
        ...ITEM.media,
        episodes: [
          { title: "Has id", id: "ep-x", enclosure: { url: "https://cdn.example.com/x.mp3" } },
          { title: "No id episode", enclosure: { url: "https://cdn.example.com/y.mp3" } }, // no id
        ],
      },
    };
    mockApi({ item });
    await renderScreen();
    await screen.findByText("Episode A");

    fireEvent.press(screen.getByLabelText("Segment: On server"));
    await screen.findByText("No id episode");

    // The id-less row can't be selected (confirmDelete filters ep.id, so it
    // would enable the button yet delete nothing).
    fireEvent(screen.getByLabelText("Episode: No id episode"), "longPress");
    expect(screen.queryByText("1 selected")).toBeNull();

    // A row WITH an id still enters selection.
    fireEvent(screen.getByLabelText("Episode: Has id"), "longPress");
    expect(await screen.findByText("1 selected")).toBeTruthy();
  });

  it("multi-select download POSTs the BARE ARRAY of raw feed episode objects and re-diffs on task completion", async () => {
    await renderScreen();
    await screen.findByText("Episode A");

    // Long-press B → selection mode; tap C → both selected.
    fireEvent(screen.getByLabelText("Episode: Episode B"), "longPress");
    expect(await screen.findByText("1 selected")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Episode: Chatter special"));
    expect(await screen.findByText("2 selected")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Download 2 to server"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    const dialog = dialogByTitle("Download 2 episodes to server?");
    expect(dialog).toBeTruthy();
    expect(api.post).toHaveBeenCalledTimes(1); // only the feed parse so far

    const before = itemGetCount();
    await act(async () => {
      dialog.buttons.find((b: any) => b.text === "Download").onPress();
    });

    // BARE array body — the raw feed episode objects, no { episodes } wrapper.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/podcasts/pod1/download-episodes", [
        FEED_EP_B,
        FEED_EP_C,
      ])
    );
    expect(showSnackbar).toHaveBeenCalledWith({
      message: "Queued 2 episodes — downloading on the server",
    });

    // The watch matcher is pinned to this item's download-podcast-episode task.
    const matcher = (startTaskWatch as jest.Mock).mock.calls[0][0];
    expect(matcher({ action: "download-podcast-episode", data: { libraryItemId: "pod1" } })).toBe(true);
    expect(matcher({ action: "download-podcast-episode", data: { libraryItemId: "other" } })).toBe(false);
    expect(matcher({ action: "library-scan", data: { libraryItemId: "pod1" } })).toBe(false);

    // Task completes (inferred) → the item refetches so the diff can update.
    await act(async () => {
      resolveWatch!({ id: "t1", action: "download-podcast-episode", inferredCompletion: true });
    });
    await waitFor(() => expect(itemGetCount()).toBeGreaterThan(before));
  });

  it("On-server segment: delete WITHOUT files → DELETE /api/podcasts/pod1/episode/ep-a (no hard param), then refetch", async () => {
    await renderScreen();
    await screen.findByText("Episode A");

    fireEvent.press(screen.getByLabelText("Segment: On server"));
    expect(await screen.findByText("Episode A (remastered)")).toBeTruthy();

    fireEvent(screen.getByLabelText("Episode: Episode A (remastered)"), "longPress");
    await screen.findByText("1 selected");
    fireEvent.press(screen.getByLabelText("Delete 1"));

    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    const dialog = dialogByTitle("Delete 1 episode?");
    expect(dialog).toBeTruthy();
    expect(api.delete).not.toHaveBeenCalled();

    const before = itemGetCount();
    await act(async () => {
      dialog.buttons.find((b: any) => b.text === "Delete records").onPress();
    });

    // Soft delete: exactly one argument — no params, no hard flag.
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/api/podcasts/pod1/episode/ep-a")
    );
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Deleted 1 episode" });
    await waitFor(() => expect(itemGetCount()).toBeGreaterThan(before));
  });

  it("delete WITH files adds hard=1", async () => {
    await renderScreen();
    await screen.findByText("Episode A");

    fireEvent.press(screen.getByLabelText("Segment: On server"));
    await screen.findByText("Episode A (remastered)");
    fireEvent(screen.getByLabelText("Episode: Episode A (remastered)"), "longPress");
    await screen.findByText("1 selected");
    fireEvent.press(screen.getByLabelText("Delete 1"));

    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    const dialog = dialogByTitle("Delete 1 episode?");
    const hardBtn = dialog.buttons.find((b: any) => b.text === "Also delete files");
    expect(hardBtn.style).toBe("destructive");
    await act(async () => {
      hardBtn.onPress();
    });

    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/api/podcasts/pod1/episode/ep-a", {
        params: { hard: 1 },
      })
    );
  });

  it("a 404 from the delete route surfaces the graceful 'not supported' dialog and stops", async () => {
    (api.delete as jest.Mock).mockRejectedValue(
      Object.assign(new Error("no route"), { response: { status: 404 } })
    );
    await renderScreen();
    await screen.findByText("Episode A");

    fireEvent.press(screen.getByLabelText("Segment: On server"));
    await screen.findByText("Episode A (remastered)");
    fireEvent(screen.getByLabelText("Episode: Episode A (remastered)"), "longPress");
    await screen.findByText("1 selected");
    fireEvent.press(screen.getByLabelText("Delete 1"));

    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    await act(async () => {
      dialogByTitle("Delete 1 episode?").buttons
        .find((b: any) => b.text === "Delete records")
        .onPress();
    });

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Not supported",
          message: "Episode deletion isn't supported by this server.",
        })
      )
    );
    expect(api.delete).toHaveBeenCalledTimes(1);
    // No success snackbar for the failed delete.
    expect(showSnackbar).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/^Deleted/) })
    );
  });

  it("non-admin gets the lock ErrorState and no fetches fire", async () => {
    useUserStore.setState({ user: PLAIN_USER } as any);
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("cold-restored admin (thin store user) is unlocked once refreshCapabilities hydrates", async () => {
    // Cold restore: the store holds only a thin {id, username} user (no type)
    // plus a valid session token. Without the mount-time capability refresh this
    // real admin would hit the "Admin access required" lock; refreshCapabilities
    // → POST /api/authorize hydrates the full admin user and the screen unlocks.
    useUserStore.setState({
      user: { id: "u1", username: "tony" },
      serverConnectionConfig: { token: "sess" },
    } as any);
    (api.post as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/authorize") return Promise.resolve({ data: { user: ADMIN_USER } });
      if (url === "/api/podcasts/feed")
        return Promise.resolve({ data: { podcast: { episodes: FEED_EPISODES } } });
      return Promise.resolve({ data: {} });
    });

    await renderScreen();

    // The real content loads (not the lock) after capabilities hydrate.
    expect(await screen.findByText("Episode A")).toBeTruthy();
    expect(screen.queryByText("Admin access required")).toBeNull();
    expect(api.post).toHaveBeenCalledWith("/api/authorize");
  });

  it("a title filter never drops a selected-but-hidden episode from the download", async () => {
    await renderScreen();
    await screen.findByText("Episode A");

    // Select B and C (both not on server).
    fireEvent(screen.getByLabelText("Episode: Episode B"), "longPress");
    await screen.findByText("1 selected");
    fireEvent.press(screen.getByLabelText("Episode: Chatter special"));
    await screen.findByText("2 selected");

    // Filter to "chatter" — hides the selected Episode B from the list…
    fireEvent.changeText(screen.getByLabelText("Filter episodes by title"), "chatter");
    await waitFor(() => expect(screen.queryByText("Episode B")).toBeNull());

    // …but the action still targets BOTH selected episodes (count unchanged).
    expect(screen.getByLabelText("Download 2 to server")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Download 2 to server"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    const dialog = dialogByTitle("Download 2 episodes to server?");
    expect(dialog).toBeTruthy();
    await act(async () => {
      dialog.buttons.find((b: any) => b.text === "Download").onPress();
    });

    // The hidden Episode B is NOT dropped — the POST carries both B and C.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/podcasts/pod1/download-episodes", [
        FEED_EP_B,
        FEED_EP_C,
      ])
    );
  });

  it("a feed failure keeps the On-server segment working (segment-scoped error)", async () => {
    (api.post as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/podcasts/feed")
        return Promise.reject(Object.assign(new Error("feed down"), { response: { status: 500 } }));
      return Promise.resolve({ data: {} });
    });
    await renderScreen();

    // Feed segment shows its scoped error…
    expect(await screen.findByText("Couldn't load the feed")).toBeTruthy();
    // …but the server list still renders.
    fireEvent.press(screen.getByLabelText("Segment: On server"));
    expect(await screen.findByText("Episode A (remastered)")).toBeTruthy();
  });
});
