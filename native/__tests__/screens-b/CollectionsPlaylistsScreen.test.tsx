/**
 * CollectionsPlaylistsScreen — segmented collections/playlists tabs with
 * per-tab fetching, row rendering + navigation, create-new dialog (POST +
 * refetch), search overlay swap, empty/error states.
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
import CollectionsPlaylistsScreen from "../../screens/CollectionsPlaylistsScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUiStore } from "../../store/useUiStore";

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialUi = useUiStore.getState();

const COLLECTIONS = [
  { id: "c1", name: "Favorites", books: [{ id: "b1" }, { id: "b2" }] },
  { id: "c2", name: "To Read", books: [{ id: "b3" }] },
];
const PLAYLISTS = [
  { id: "p1", name: "Morning Mix", items: [{ libraryItemId: "li1" }] },
];

function mockGets({ collections = COLLECTIONS, playlists = PLAYLISTS }: any = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url.includes("/collections")) return Promise.resolve({ data: { results: collections } });
    // Playlists are fetched library-scoped (matches the Add-to sheet).
    if (url === "/api/libraries/lib1/playlists")
      return Promise.resolve({ data: { results: playlists } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<CollectionsPlaylistsScreen navigation={navigation} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useLibraryStore.setState(initialLibrary, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUiStore.setState(initialUi, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  usePlaybackStore.setState({ currentSession: null } as any);
  mockGets();
  (api.post as jest.Mock).mockResolvedValue({ data: {} });
});

describe("CollectionsPlaylistsScreen", () => {
  it("loads and renders collections by default", async () => {
    await renderScreen();

    expect(await screen.findByText("Favorites")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/collections");
    expect(screen.getByLabelText("Collection: Favorites, 2 items")).toBeTruthy();
    expect(screen.getByLabelText("Collection: To Read, 1 item")).toBeTruthy();
    // Playlists are not fetched until that tab is selected.
    expect(api.get).not.toHaveBeenCalledWith("/api/libraries/lib1/playlists");
  });

  it("collection row navigates to CollectionDetail", async () => {
    const navigation = await renderScreen();
    await screen.findByText("Favorites");

    await fireEvent.press(screen.getByText("Favorites"));
    expect(navigation.navigate).toHaveBeenCalledWith("CollectionDetail", {
      collectionId: "c1",
      playlistId: "c1",
    });
  });

  it("switching tabs fetches playlists and rows navigate to PlaylistDetail", async () => {
    const navigation = await renderScreen();
    await screen.findByText("Favorites");

    await fireEvent.press(screen.getByText("Playlists"));

    expect(await screen.findByText("Morning Mix")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/playlists");
    expect(screen.queryByText("Favorites")).toBeNull();

    await fireEvent.press(screen.getByText("Morning Mix"));
    expect(navigation.navigate).toHaveBeenCalledWith("PlaylistDetail", {
      collectionId: "p1",
      playlistId: "p1",
    });
  });

  it("shows per-tab empty states", async () => {
    mockGets({ collections: [], playlists: [] });
    await renderScreen();

    expect(await screen.findByText("No collections yet")).toBeTruthy();

    await fireEvent.press(screen.getByText("Playlists"));
    expect(await screen.findByText("No playlists yet")).toBeTruthy();
  });

  it("creates a new collection through the dialog and refetches", async () => {
    await renderScreen();
    await screen.findByText("Favorites");
    (api.get as jest.Mock).mockClear();

    await fireEvent.press(screen.getByLabelText("Create new collection"));
    expect(screen.getByText("New collection")).toBeTruthy();

    await fireEvent.changeText(
      screen.getByPlaceholderText("Collection name"),
      "  Fresh Picks  "
    );
    await fireEvent.press(screen.getByLabelText("Create"));
    await act(async () => {});

    // Name is trimmed; new collections start empty.
    expect(api.post).toHaveBeenCalledWith("/api/collections", {
      libraryId: "lib1",
      name: "Fresh Picks",
      books: [],
    });
    // Dialog closed + list refetched.
    expect(screen.queryByText("New collection")).toBeNull();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/collections");
  });

  it("creates a new playlist when the playlists tab is active", async () => {
    await renderScreen();
    await screen.findByText("Favorites");
    await fireEvent.press(screen.getByText("Playlists"));
    await screen.findByText("Morning Mix");

    await fireEvent.press(screen.getByLabelText("Create new playlist"));
    await fireEvent.changeText(screen.getByPlaceholderText("Playlist name"), "Evening");
    await fireEvent.press(screen.getByLabelText("Create"));
    await act(async () => {});

    expect(api.post).toHaveBeenCalledWith("/api/playlists", {
      libraryId: "lib1",
      name: "Evening",
      items: [],
    });
  });

  it("surfaces a create failure inside the dialog", async () => {
    (api.post as jest.Mock).mockRejectedValue({ response: { status: 500 } });
    await renderScreen();
    await screen.findByText("Favorites");

    await fireEvent.press(screen.getByLabelText("Create new collection"));
    await fireEvent.changeText(screen.getByPlaceholderText("Collection name"), "Nope");
    await fireEvent.press(screen.getByLabelText("Create"));
    await act(async () => {});

    expect(
      screen.getByText("Couldn't create it — check the server connection.")
    ).toBeTruthy();
    // Dialog stays open so the user can retry.
    expect(screen.getByText("New collection")).toBeTruthy();
  });

  it("ignores create with a blank name", async () => {
    await renderScreen();
    await screen.findByText("Favorites");

    await fireEvent.press(screen.getByLabelText("Create new collection"));
    await fireEvent.changeText(screen.getByPlaceholderText("Collection name"), "   ");
    await fireEvent.press(screen.getByLabelText("Create"));

    expect(api.post).not.toHaveBeenCalled();
  });

  it("shows the error state and retries", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("down"));
    await renderScreen();

    expect(await screen.findByText("Couldn't load collections")).toBeTruthy();

    mockGets();
    await fireEvent.press(screen.getByLabelText("Retry loading collections"));

    expect(await screen.findByText("Favorites")).toBeTruthy();
  });

  it("swaps to the search overlay when search is active", async () => {
    await renderScreen();
    await screen.findByText("Favorites");

    await act(async () => {
      useUiStore.setState({ isSearchActive: true });
    });

    expect(screen.queryByText("Favorites")).toBeNull();
    expect(screen.getByPlaceholderText("Search library...")).toBeTruthy();
  });
});
