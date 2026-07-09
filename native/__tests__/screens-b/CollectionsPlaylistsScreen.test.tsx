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
import { Text } from "react-native";
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
  it("renders as a standalone bottom tab with its own sub-selector + create FAB", async () => {
    // As mounted by the new "Collections" bottom tab (no embedded/mode props),
    // the screen owns its Collections|Playlists sub-selector and inline create
    // button, and no hub list header is involved.
    await renderScreen();
    await screen.findByText("Favorites");

    // Both sub-tabs are present as tabs (the standalone toggle reaches Playlists).
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(2);
    // The row wrapping the tabs exposes itself as a tablist for assistive tech.
    // (A tablist container isn't an accessibility leaf, so getByRole can't reach
    // it — assert the role on the tabs' shared parent instead.)
    expect(tabs[0].parent?.props.accessibilityRole).toBe("tablist");
    expect(screen.getByLabelText("Create new collection")).toBeTruthy();
  });

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
    // Copy points at the inline create button now that the tab can create.
    expect(
      screen.getByText(
        "Tap + to create your first collection, or they'll appear here once created on the server."
      )
    ).toBeTruthy();

    await fireEvent.press(screen.getByText("Playlists"));
    expect(await screen.findByText("No playlists yet")).toBeTruthy();
  });

  it("keeps the skeleton (not the empty state) until the library id hydrates", async () => {
    // Cold start: currentLibraryId hasn't hydrated yet. fetchData no-ops
    // without it, so falling through to EmptyState would flash "No collections
    // yet" — the screen must stay in a loading state instead.
    mockGets({ collections: [], playlists: [] });
    useLibraryStore.setState({ currentLibraryId: undefined } as any);
    await renderScreen();
    await act(async () => {});

    expect(screen.queryByText("No collections yet")).toBeNull();
    // No library id -> no fetch was attempted for it.
    expect(api.get).not.toHaveBeenCalledWith("/api/libraries/undefined/collections");

    // Once the id hydrates, the real (empty) state resolves.
    await act(async () => {
      useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
    });
    expect(await screen.findByText("No collections yet")).toBeTruthy();
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
    await fireEvent.press(screen.getByLabelText("Retry"));

    expect(await screen.findByText("Favorites")).toBeTruthy();
  });

  it("discards a stale response for the previous library after a switch", async () => {
    // lib1's collections resolve slowly; the user switches to lib2 mid-flight.
    // The late lib1 response must not overwrite lib2's list.
    let resolveLib1: (v: any) => void = () => {};
    const lib1Promise = new Promise((res) => {
      resolveLib1 = res;
    });
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/libraries/lib1/collections") return lib1Promise;
      if (url === "/api/libraries/lib2/collections")
        return Promise.resolve({ data: { results: [{ id: "c9", name: "Lib2 Coll", books: [] }] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    await renderScreen();

    // Switch library before lib1's response resolves.
    await act(async () => {
      useLibraryStore.setState({ currentLibraryId: "lib2" } as any);
    });
    expect(await screen.findByText("Lib2 Coll")).toBeTruthy();

    // The stale lib1 response finally arrives — it must be dropped.
    await act(async () => {
      resolveLib1({ data: { results: [{ id: "c1", name: "Stale Lib1 Coll", books: [] }] } });
      await Promise.resolve();
    });

    expect(screen.queryByText("Stale Lib1 Coll")).toBeNull();
    expect(screen.getByText("Lib2 Coll")).toBeTruthy();
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

  describe("embedded in the Library hub", () => {
    it("locks the tab to `mode`, hides the sub-tab row, and renders the hub list header", async () => {
      const navigation = makeNavigation();
      await render(
        <CollectionsPlaylistsScreen
          navigation={navigation}
          embedded
          mode="playlists"
          listHeader={<Text>HUB_PILLS</Text>}
        />
      );

      // Fetches playlists directly (mode-pinned) — no Collections fetch.
      expect(await screen.findByText("Morning Mix")).toBeTruthy();
      expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/playlists");
      expect(api.get).not.toHaveBeenCalledWith("/api/libraries/lib1/collections");

      // Hub owns the pill row (passed as listHeader); the internal sub-tab
      // toggle + inline create button are gone in embedded mode.
      expect(screen.getByText("HUB_PILLS")).toBeTruthy();
      expect(screen.queryByLabelText("Create new playlist")).toBeNull();
      expect(screen.queryByRole("tab")).toBeNull();
    });

    it("opens the create dialog through the imperative openCreate() handle", async () => {
      const ref = React.createRef<any>();
      const navigation = makeNavigation();
      await render(
        <CollectionsPlaylistsScreen ref={ref} navigation={navigation} embedded mode="collections" />
      );
      await screen.findByText("Favorites");

      // No inline button in embedded mode; the hub FAB drives creation via ref.
      expect(screen.queryByText("New collection")).toBeNull();
      await act(async () => {
        ref.current.openCreate();
      });
      expect(screen.getByText("New collection")).toBeTruthy();
    });

    it("exposes a scrollToTop() handle", async () => {
      const ref = React.createRef<any>();
      const navigation = makeNavigation();
      await render(
        <CollectionsPlaylistsScreen ref={ref} navigation={navigation} embedded mode="collections" />
      );
      await screen.findByText("Favorites");
      expect(typeof ref.current.scrollToTop).toBe("function");
      // Should not throw when the scroll view is mounted.
      act(() => ref.current.scrollToTop());
    });
  });
});
