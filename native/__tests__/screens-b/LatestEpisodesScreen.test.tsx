/**
 * LatestEpisodesScreen — recent podcast episodes for the current library,
 * episode play routing with episodeId, row navigation, no-library / empty /
 * error states.
 */
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);
jest.mock("react-native-reanimated", () => {
  const RN = require("react-native");
  const chainable = () => {
    const o: any = {};
    [
      "delay", "duration", "springify", "damping", "stiffness", "mass",
      "easing", "build", "withInitialValues", "randomDelay", "reduceMotion",
      "withCallback",
    ].forEach((k) => (o[k] = () => o));
    return o;
  };
  const id = (v: any) => v;
  const easing = (t: number) => t;
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (C: any) => C,
      View: RN.View, Text: RN.Text, Image: RN.Image,
      ScrollView: RN.ScrollView, FlatList: RN.FlatList,
    },
    useSharedValue: (v: any) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (fn: any) => ({ value: typeof fn === "function" ? fn() : fn }),
    useAnimatedRef: () => ({ current: null }),
    useAnimatedScrollHandler: () => () => {},
    useAnimatedReaction: () => {},
    useReducedMotion: () => false,
    withTiming: id, withSpring: id, withDelay: (_d: any, v: any) => v,
    withRepeat: id, withSequence: id,
    cancelAnimation: () => {},
    interpolate: () => 0,
    interpolateColor: () => "rgb(0, 0, 0)",
    Extrapolation: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    Extrapolate: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    runOnJS: (fn: any) => fn, runOnUI: (fn: any) => fn,
    Easing: {
      linear: easing, ease: easing, quad: easing, cubic: easing,
      bezier: () => ({ factory: () => easing }),
      in: (f: any) => f || easing, out: (f: any) => f || easing, inOut: (f: any) => f || easing,
    },
    FadeIn: chainable(), FadeOut: chainable(), FadeInDown: chainable(),
    FadeInUp: chainable(), FadeInRight: chainable(), FadeInLeft: chainable(),
    FadeOutDown: chainable(), FadeOutUp: chainable(),
    SlideInDown: chainable(), SlideOutDown: chainable(),
    LinearTransition: chainable(),
    ReduceMotion: { System: "system", Always: "always", Never: "never" },
  };
});
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/progressSync", () => ({
  queueProgressPatch: jest.fn(),
}));
jest.mock("../../utils/downloader", () => ({
  downloader: {
    downloadEpisode: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import LatestEpisodesScreen from "../../screens/LatestEpisodesScreen";
import { api } from "../../utils/api";
import { queueProgressPatch } from "../../utils/progressSync";
import { downloader } from "../../utils/downloader";
import { showAppDialog } from "../../store/useDialogStore";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialDownloads = useDownloadStore.getState();

const EPISODES = [
  {
    id: "ep1",
    libraryItemId: "li1",
    title: "Fresh Episode",
    pubDate: "2026-06-01T08:00:00.000Z",
    duration: 5400, // 1h 30m
    podcast: { metadata: { title: "Great Show" } },
  },
  {
    id: "ep2",
    libraryItemId: "li2",
    title: "Short Episode",
    duration: 900, // 15m
  },
];

let startPlayback: jest.Mock;

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderEpisodes() {
  const navigation = makeNavigation();
  await render(<LatestEpisodesScreen navigation={navigation} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useLibraryStore.setState(initialLibrary, true);
  usePlaybackStore.setState(initialPlayback, true);
  useDownloadStore.setState(initialDownloads, true);
  (downloader.downloadEpisode as jest.Mock).mockClear();
  (downloader.downloadEpisode as jest.Mock).mockResolvedValue(undefined);
  (showAppDialog as jest.Mock).mockClear();
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  startPlayback = jest.fn().mockResolvedValue(true);
  usePlaybackStore.setState({ startPlayback, currentSession: null } as any);
  (api.get as jest.Mock).mockResolvedValue({ data: { episodes: EPISODES } });
  (api.patch as jest.Mock).mockResolvedValue({ data: {} });
});

describe("LatestEpisodesScreen", () => {
  it("fetches recent episodes and renders podcast name, title, date and duration", async () => {
    await renderEpisodes();

    expect(await screen.findByText("Fresh Episode")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/recent-episodes?limit=25");
    expect(screen.getByText("2 Recent Episodes")).toBeTruthy();
    expect(screen.getByText("Great Show")).toBeTruthy();
    expect(screen.getByText("Jun 1, 2026")).toBeTruthy();
    expect(screen.getByText("1h 30m")).toBeTruthy();
    expect(screen.getByText("15m")).toBeTruthy();
  });

  it("episode play button starts playback with the episode id", async () => {
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Play Fresh Episode"));
    expect(startPlayback).toHaveBeenCalledWith("li1", "ep1");
  });

  it("no longer shows a redundant per-episode podcast-settings gear", async () => {
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // The per-row settings gear was removed: the list spans many podcasts and
    // repeated the same podcast across its episodes, so the gear was redundant.
    // The single podcast-settings entry point lives on ItemDetail instead.
    expect(screen.queryByLabelText("Podcast settings for Great Show")).toBeNull();
    expect(screen.queryByLabelText(/Podcast settings for/)).toBeNull();
  });

  it("row tap opens the podcast's item detail", async () => {
    const navigation = await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByText("Fresh Episode"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "li1" });
  });

  it("keeps both the open-podcast control and the Play button reachable (not collapsed)", async () => {
    const navigation = await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // The cover/text block is its OWN labelled button (so TalkBack can't collapse
    // the row and hide the Play button)...
    const openBtn = screen.getByLabelText("Fresh Episode, Great Show");
    await fireEvent.press(openBtn);
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "li1" });

    // ...and the Play button is a separate, independently reachable node.
    await fireEvent.press(screen.getByLabelText("Play Fresh Episode"));
    expect(startPlayback).toHaveBeenCalledWith("li1", "ep1");
  });

  it("renders played state: in-progress bar and Finished/dimming from the progress map", async () => {
    useUserStore.setState({
      mediaProgress: {
        "li1-ep1": { libraryItemId: "li1", episodeId: "ep1", progress: 0.4, isFinished: false },
        "li2-ep2": { libraryItemId: "li2", episodeId: "ep2", isFinished: true },
      },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // Finished episode shows the "· Finished" marker and its toggle reads unfinish.
    expect(screen.getByText("· Finished")).toBeTruthy();
    expect(screen.getByLabelText("Mark episode not finished")).toBeTruthy();
    // Unfinished-but-started episode still offers "Mark episode finished".
    expect(screen.getByLabelText("Mark episode finished")).toBeTruthy();
  });

  it("per-episode mark finished PATCHes the episode-scoped endpoint and updates the map", async () => {
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // Fresh Episode (ep1 / li1) is first; toggle it finished.
    await fireEvent.press(screen.getAllByLabelText("Mark episode finished")[0]);

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/me/progress/li1/ep1", { isFinished: true })
    );
    expect(useUserStore.getState().mediaProgress["li1-ep1"].isFinished).toBe(true);
  });

  it("queues an episode-scoped patch when the mark-finished PATCH fails offline", async () => {
    (api.patch as jest.Mock).mockRejectedValue(new Error("Network Error"));
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getAllByLabelText("Mark episode finished")[0]);

    await waitFor(() =>
      expect(queueProgressPatch).toHaveBeenCalledWith(
        "li1",
        expect.anything(),
        expect.anything(),
        "ep1",
        { isFinished: true }
      )
    );
    expect(useUserStore.getState().mediaProgress["li1-ep1"].isFinished).toBe(true);
  });

  it("errors when no library is selected (no fetch)", async () => {
    useLibraryStore.setState({ currentLibraryId: null } as any);
    await renderEpisodes();

    expect(await screen.findByText("No library selected.")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows the empty state when there are no recent episodes", async () => {
    (api.get as jest.Mock).mockResolvedValue({ data: { episodes: [] } });
    await renderEpisodes();

    expect(await screen.findByText("No recent episodes")).toBeTruthy();
  });

  it("shows the error state when the fetch fails", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("down"));
    await renderEpisodes();

    expect(await screen.findByText("Failed to load episodes.")).toBeTruthy();
  });

  it("back button goes back", async () => {
    const navigation = await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("filters the list by Unplayed / In-Progress against the progress map", async () => {
    // ep1 (li1) is in-progress; ep2 (li2) has no progress → unplayed.
    useUserStore.setState({
      mediaProgress: {
        "li1-ep1": { libraryItemId: "li1", episodeId: "ep1", progress: 0.4, isFinished: false },
      },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // Unplayed → only the untouched episode remains.
    await fireEvent.press(screen.getByLabelText("Filter: Unplayed"));
    expect(screen.queryByText("Fresh Episode")).toBeNull();
    expect(screen.getByText("Short Episode")).toBeTruthy();

    // In-Progress → only the partially-played episode remains.
    await fireEvent.press(screen.getByLabelText("Filter: In-Progress"));
    expect(screen.getByText("Fresh Episode")).toBeTruthy();
    expect(screen.queryByText("Short Episode")).toBeNull();

    // Back to All → both return.
    await fireEvent.press(screen.getByLabelText("Filter: All"));
    expect(screen.getByText("Fresh Episode")).toBeTruthy();
    expect(screen.getByText("Short Episode")).toBeTruthy();
  });

  it("sort toggle flips between newest and oldest", async () => {
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // Default is newest-first.
    expect(screen.getByLabelText("Sort oldest first")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Sort oldest first"));
    // Label flips; both episodes still render.
    expect(screen.getByLabelText("Sort newest first")).toBeTruthy();
    expect(screen.getByText("Fresh Episode")).toBeTruthy();
    expect(screen.getByText("Short Episode")).toBeTruthy();
  });

  it("re-tapping the currently-playing episode resumes instead of starting a new session", async () => {
    const play = jest.fn().mockResolvedValue(undefined);
    const setPlayerExpanded = jest.fn();
    usePlaybackStore.setState({
      startPlayback,
      currentSession: { libraryItemId: "li1", episodeId: "ep1" },
      isPlaying: false,
      play,
      setPlayerExpanded,
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // The now-playing episode's Play button flips to a "Resume" affordance.
    await fireEvent.press(screen.getByLabelText("Resume Fresh Episode"));

    // No fresh /play — resume/expand the existing session instead.
    expect(startPlayback).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalled();
    expect(setPlayerExpanded).toHaveBeenCalledWith(true);
  });

  it("play button shows a now-playing (Resume) state for the loaded session's episode", async () => {
    usePlaybackStore.setState({
      startPlayback,
      currentSession: { libraryItemId: "li1", episodeId: "ep1" },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // ep1 is the session → "Resume"; ep2 is not → plain "Play".
    expect(screen.getByLabelText("Resume Fresh Episode")).toBeTruthy();
    expect(screen.getByLabelText("Play Short Episode")).toBeTruthy();
    expect(screen.queryByLabelText("Play Fresh Episode")).toBeNull();
  });

  it("per-episode download button drives downloader.downloadEpisode with a built libraryItem", async () => {
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Download Fresh Episode"));

    await waitFor(() =>
      expect(downloader.downloadEpisode).toHaveBeenCalledWith(
        expect.objectContaining({ id: "li1" }),
        expect.objectContaining({ id: "ep1" }),
        expect.any(String),
        expect.any(String)
      )
    );
  });

  it("does NOT start a download (shows connect-first) when the server is not connected", async () => {
    useUserStore.setState({ serverConnectionConfig: null } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Download Fresh Episode"));

    // No network call with an empty address/token — a clear message instead.
    expect(downloader.downloadEpisode).not.toHaveBeenCalled();
  });

  it("download button reflects downloaded (delete) and downloading (cancel %) states", async () => {
    useDownloadStore.setState({
      completedDownloads: {
        "li1::ep1": { id: "li1::ep1", libraryItemId: "li1", episodeId: "ep1", title: "Fresh Episode" },
      },
      activeDownloads: {
        "li2::ep2": {
          id: "li2::ep2",
          libraryItemId: "li2",
          episodeId: "ep2",
          title: "Short Episode",
          status: "downloading",
          progress: 0.42,
        },
      },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    expect(screen.getByLabelText("Delete download of Fresh Episode")).toBeTruthy();
    expect(
      screen.getByLabelText(/Cancel download of Short Episode, 42 percent complete/)
    ).toBeTruthy();
  });

  it("header count and empty-state reflect the active filter, not the raw fetch count", async () => {
    // ep1 in-progress, ep2 unplayed.
    useUserStore.setState({
      mediaProgress: {
        "li1-ep1": { libraryItemId: "li1", episodeId: "ep1", progress: 0.4, isFinished: false },
      },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // Both visible → "2 Recent Episodes".
    expect(screen.getByText("2 Recent Episodes")).toBeTruthy();

    // In-Progress → only ep1 → count drops to 1 (singular).
    await fireEvent.press(screen.getByLabelText("Filter: In-Progress"));
    expect(screen.getByText("1 Recent Episode")).toBeTruthy();
    expect(screen.queryByText("2 Recent Episodes")).toBeNull();

    // A filter with no matches → the empty-state line renders.
    useUserStore.setState({
      mediaProgress: {
        "li1-ep1": { libraryItemId: "li1", episodeId: "ep1", isFinished: true },
        "li2-ep2": { libraryItemId: "li2", episodeId: "ep2", isFinished: true },
      },
    } as any);
    await fireEvent.press(screen.getByLabelText("Filter: Unplayed"));
    expect(screen.getByText("No episodes match this filter.")).toBeTruthy();
    expect(screen.getByText("0 Recent Episodes")).toBeTruthy();
  });

  it("pressing a completed download confirms then deletes via removeDownload", async () => {
    const removeDownload = jest.fn();
    useDownloadStore.setState({
      removeDownload,
      completedDownloads: {
        "li1::ep1": { id: "li1::ep1", libraryItemId: "li1", episodeId: "ep1", title: "Fresh Episode" },
      },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Delete download of Fresh Episode"));

    // A destructive confirm dialog — not an immediate delete.
    expect(showAppDialog).toHaveBeenCalledTimes(1);
    const dialog = (showAppDialog as jest.Mock).mock.calls[0][0];
    expect(dialog.title).toBe("Delete download");
    const deleteBtn = dialog.buttons.find((b: any) => b.style === "destructive");
    expect(deleteBtn).toBeTruthy();
    expect(removeDownload).not.toHaveBeenCalled();

    // Confirming runs removeDownload with the composite key.
    deleteBtn.onPress();
    expect(removeDownload).toHaveBeenCalledWith("li1::ep1");
  });

  it("pressing a downloading episode cancels it via cancelDownload", async () => {
    const cancelDownload = jest.fn();
    useDownloadStore.setState({
      cancelDownload,
      activeDownloads: {
        "li1::ep1": {
          id: "li1::ep1",
          libraryItemId: "li1",
          episodeId: "ep1",
          title: "Fresh Episode",
          status: "downloading",
          progress: 0.42,
        },
      },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(
      screen.getByLabelText(/Cancel download of Fresh Episode, 42 percent complete/)
    );

    expect(cancelDownload).toHaveBeenCalledWith("li1::ep1");
    // Cancel is offline-safe — no dialog, no download start.
    expect(downloader.downloadEpisode).not.toHaveBeenCalled();
  });

  it("shows a retry affordance and retries via retryDownload for a failed download", async () => {
    const retryDownload = jest.fn().mockResolvedValue(undefined);
    useDownloadStore.setState({
      retryDownload,
      activeDownloads: {
        "li1::ep1": {
          id: "li1::ep1",
          libraryItemId: "li1",
          episodeId: "ep1",
          title: "Fresh Episode",
          status: "failed",
          progress: 0,
        },
      },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    // The failed state surfaces a "tap to retry" label...
    const retryBtn = screen.getByLabelText("Download of Fresh Episode failed, tap to retry");
    expect(retryBtn).toBeTruthy();

    // ...and pressing it retries the same composite key.
    await fireEvent.press(retryBtn);
    expect(retryDownload).toHaveBeenCalledWith("li1::ep1");
  });

  it("shows a Download failed dialog when downloadEpisode rejects", async () => {
    (downloader.downloadEpisode as jest.Mock).mockRejectedValue(new Error("boom"));
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Download Fresh Episode"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Download failed" })
      )
    );
  });

  it("carries the podcast cover into the built libraryItem so a cover part is downloaded", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: {
        episodes: [
          {
            id: "ep1",
            libraryItemId: "li1",
            title: "Fresh Episode",
            podcast: { metadata: { title: "Great Show" }, coverPath: "/covers/great.jpg" },
          },
        ],
      },
    });
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Download Fresh Episode"));

    await waitFor(() =>
      expect(downloader.downloadEpisode).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "li1",
          media: expect.objectContaining({ coverPath: "/covers/great.jpg" }),
        }),
        expect.objectContaining({ id: "ep1" }),
        expect.any(String),
        expect.any(String)
      )
    );
  });

  it("renders the per-row podcast name without a hyperlink underline", async () => {
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    const name = screen.getByText("Great Show");
    const style = Array.isArray(name.props.style)
      ? Object.assign({}, ...name.props.style)
      : name.props.style;
    expect(style.textDecorationLine).toBeUndefined();
  });

  it("caps the download percent font scale so it can't clip at large text sizes", async () => {
    useDownloadStore.setState({
      activeDownloads: {
        "li1::ep1": {
          id: "li1::ep1",
          libraryItemId: "li1",
          episodeId: "ep1",
          title: "Fresh Episode",
          status: "downloading",
          progress: 0.42,
        },
      },
    } as any);
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    const pct = screen.getByText("42%");
    expect(pct.props.maxFontSizeMultiplier).toBe(1.2);
  });
});
