/**
 * PlaylistDetailScreen — book + podcast-episode rows, composite-key episode
 * progress badges, play routing with episodeId, Play all targeting the first
 * unfinished entry.
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

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import PlaylistDetailScreen from "../../screens/PlaylistDetailScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useDialogStore } from "../../store/useDialogStore";

// Invoke the destructive "Delete" button of the confirm dialog the trash icon
// opens (no AppDialog host is mounted in the unit render).
async function confirmDelete() {
  const del = useDialogStore.getState().current!.buttons.find((b) => b.style === "destructive")!;
  await act(async () => {
    await del.onPress!();
  });
}

const initialUser = useUserStore.getState();
const initialPlayback = usePlaybackStore.getState();

const PLAYLIST = {
  id: "pl1",
  name: "Road Trip",
  description: "Long drives.",
  items: [
    {
      id: "pi1",
      libraryItemId: "li1",
      libraryItem: {
        id: "li1",
        mediaType: "book",
        media: { metadata: { title: "Audiobook One", authorName: "Author A" }, duration: 3600, numTracks: 3 },
      },
      userMediaProgress: { isFinished: true },
    },
    {
      id: "pi2",
      libraryItemId: "li2",
      episodeId: "ep1",
      episode: {
        id: "ep1",
        title: "Episode One",
        duration: 1800,
        podcast: { metadata: { title: "Pod Show" } },
      },
      libraryItem: { id: "li2", mediaType: "podcast", media: { metadata: { title: "Pod Show" } } },
    },
  ],
};

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

async function renderPlaylist(params: any = { playlistId: "pl1" }) {
  const navigation = makeNavigation();
  await render(<PlaylistDetailScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  startPlayback = jest.fn().mockResolvedValue(true);
  usePlaybackStore.setState({ startPlayback, currentSession: null } as any);
  (api.get as jest.Mock).mockResolvedValue({ data: PLAYLIST });
  (api.delete as jest.Mock).mockReset();
  useDialogStore.setState({ current: null });
});

describe("PlaylistDetailScreen", () => {
  it("renders name, description, counts and both row types", async () => {
    await renderPlaylist();

    expect(await screen.findAllByText("Road Trip")).toHaveLength(2); // bar + hero
    expect(screen.getByText("Long drives.")).toBeTruthy();
    // 3600 + 1800 = 5400s -> "1 hr 30 min"
    expect(screen.getByText(/2 items\s+·\s+1 hr 30 min/)).toBeTruthy();
    expect(screen.getByText("Audiobook One")).toBeTruthy();
    expect(screen.getByText("Author A")).toBeTruthy();
    expect(screen.getByText("Episode One")).toBeTruthy();
    // Episode subtitle falls back to the podcast title.
    expect(screen.getByText("Pod Show")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/playlists/pl1");
  });

  it("episode rows read progress from the composite `${itemId}-${episodeId}` key", async () => {
    useUserStore.setState({
      mediaProgress: {
        "li2-ep1": {
          libraryItemId: "li2",
          episodeId: "ep1",
          progress: 0.5,
          currentTime: 900,
          duration: 1800,
        },
      },
    } as any);
    await renderPlaylist();
    await screen.findByText("Episode One");

    // 900s remaining on THIS episode -> "15m" badge (not a podcast summary).
    expect(screen.getByText("15m")).toBeTruthy();
  });

  it("episode row play starts playback with the episode id", async () => {
    await renderPlaylist();
    await screen.findByText("Episode One");

    await fireEvent.press(screen.getByLabelText("Play Episode One"));
    expect(startPlayback).toHaveBeenCalledWith("li2", "ep1");
  });

  it("book row play starts playback without an episode id", async () => {
    await renderPlaylist();
    await screen.findByText("Audiobook One");

    await fireEvent.press(screen.getByLabelText("Play Audiobook One"));
    expect(startPlayback).toHaveBeenCalledWith("li1", undefined);
  });

  it("Play all targets the first unfinished item (skips the finished book)", async () => {
    await renderPlaylist();
    await screen.findByText("Audiobook One");

    await fireEvent.press(screen.getByText("Play all"));
    expect(startPlayback).toHaveBeenCalledWith("li2", "ep1");
  });

  it("hides Play all when every item is ebook-only (nothing playable)", async () => {
    // Regression: the button gated on items.length > 0, so an all-ebook playlist
    // showed a "Play all" that no-op'd (handlePlayAll finds no playable item).
    (api.get as jest.Mock).mockResolvedValue({
      data: {
        id: "pl1",
        name: "Ebooks Only",
        items: [
          {
            id: "pi1",
            libraryItemId: "li1",
            libraryItem: {
              id: "li1",
              mediaType: "book",
              media: { ebookFormat: "epub", metadata: { title: "Ebook One", authorName: "Author A" } },
            },
          },
        ],
      },
    });
    await renderPlaylist();
    await screen.findByText("Ebook One");
    expect(screen.queryByText("Play all")).toBeNull();
  });

  it("shows Play all when at least one item is playable among ebook-only entries", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: {
        id: "pl1",
        name: "Mixed",
        items: [
          {
            id: "pi1",
            libraryItemId: "li1",
            libraryItem: {
              id: "li1",
              mediaType: "book",
              media: { ebookFormat: "epub", metadata: { title: "Ebook One" } },
            },
          },
          {
            id: "pi2",
            libraryItemId: "li2",
            libraryItem: {
              id: "li2",
              mediaType: "book",
              media: { metadata: { title: "Audiobook Two" }, duration: 3600, numTracks: 2 },
            },
          },
        ],
      },
    });
    await renderPlaylist();
    await screen.findByText("Audiobook Two");
    expect(screen.getByText("Play all")).toBeTruthy();
    // Play all skips the ebook-only entry and starts the audiobook.
    await fireEvent.press(screen.getByText("Play all"));
    expect(startPlayback).toHaveBeenCalledWith("li2", undefined);
  });

  it("row tap opens the item detail for the underlying library item", async () => {
    const navigation = await renderPlaylist();
    await screen.findByText("Episode One");

    await fireEvent.press(screen.getByText("Episode One"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "li2" });
  });

  it("renders the empty state for an empty playlist", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { id: "pl1", name: "Empty List", items: [] },
    });
    await renderPlaylist();

    expect(await screen.findByText("No items yet")).toBeTruthy();
    expect(screen.queryByText("Play all")).toBeNull();
  });

  it("errors without a playlist id and offers no retry", async () => {
    await renderPlaylist({});

    expect(await screen.findByText("No playlist ID provided.")).toBeTruthy();
    expect(screen.queryByLabelText("Retry")).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows the fetch error state and retries successfully", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });
    await renderPlaylist();

    expect(await screen.findByText("Failed to load playlist.")).toBeTruthy();

    (api.get as jest.Mock).mockResolvedValue({ data: PLAYLIST });
    await fireEvent.press(screen.getByLabelText("Retry"));

    expect(await screen.findByText("Audiobook One")).toBeTruthy();
  });

  describe("delete", () => {
    it("deletes the playlist on confirm and navigates back", async () => {
      (api.delete as jest.Mock).mockResolvedValue({ data: {} });
      const navigation = await renderPlaylist();
      await screen.findByText("Audiobook One");

      await fireEvent.press(screen.getByLabelText("Delete playlist"));
      await confirmDelete();

      expect(api.delete).toHaveBeenCalledWith("/api/playlists/pl1");
      expect(navigation.goBack).toHaveBeenCalled();
    });

    it("surfaces a \"Couldn't delete\" dialog when the delete fails", async () => {
      (api.delete as jest.Mock).mockRejectedValue({ response: { status: 500 } });
      const navigation = await renderPlaylist();
      await screen.findByText("Audiobook One");

      await fireEvent.press(screen.getByLabelText("Delete playlist"));
      await confirmDelete();

      expect(navigation.goBack).not.toHaveBeenCalled();
      const dialog = useDialogStore.getState().current!;
      expect(dialog.title).toBe("Couldn't delete");
    });
  });
});
