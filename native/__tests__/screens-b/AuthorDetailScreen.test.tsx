/**
 * AuthorDetailScreen — profile header + book cards from the author endpoint,
 * isEbookOnly filtering under hideNonAudiobooksGlobal, description expand,
 * navigation, error/empty states.
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
jest.mock("../../utils/audible", () => ({
  audibleAuthorBooks: jest.fn().mockResolvedValue([]),
  buildOwnedTitleMatcher: jest.fn(() => () => false),
  audibleBookDetails: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../utils/rmab", () => ({
  searchAuthors: jest.fn(),
  getAuthorBooks: jest.fn(),
  resolveRmabUrl: (p: any) => p || undefined,
  rmabAuthMode: (cfg: any) => (cfg ? (cfg.apiToken ? "apiToken" : "jwt") : null),
  readRmabConfig: jest.fn(() => null),
  writeRmabConfig: jest.fn(),
  getMe: jest.fn(),
  createRequest: jest.fn(),
  getPendingApprovalCount: jest.fn().mockResolvedValue(0),
  listMyRequests: jest.fn().mockResolvedValue([]),
  clearRmabCaches: jest.fn(),
  setRmabSessionDeadHandler: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import AuthorDetailScreen from "../../screens/AuthorDetailScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useRmabStore } from "../../store/useRmabStore";

const initialUser = useUserStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialRmab = useRmabStore.getState();

const AUTHOR = {
  id: "a1",
  name: "Jane Author",
  description: "Writes sweeping sagas across many worlds.",
  imagePath: "/authors/a1.jpg",
  libraryItems: [
    {
      id: "b1",
      mediaType: "book",
      media: { metadata: { title: "Audio Novel" }, numTracks: 2 },
    },
    {
      id: "b2",
      mediaType: "book",
      media: {
        metadata: { title: "Ebook Novel", subtitle: "A Subtitle" },
        ebookFile: { ebookFormat: "epub" },
      },
    },
  ],
};

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderAuthor(params: any = { authorId: "a1", authorName: "Jane Author" }) {
  const navigation = makeNavigation();
  await render(<AuthorDetailScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  usePlaybackStore.setState(initialPlayback, true);
  useRmabStore.setState(initialRmab, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  usePlaybackStore.setState({ currentSession: null } as any);
  (api.get as jest.Mock).mockResolvedValue({ data: AUTHOR });
});

describe("AuthorDetailScreen", () => {
  it("renders profile, book count, description, and book cards", async () => {
    await renderAuthor();

    // Header bar + hero both carry the name.
    expect(await screen.findAllByText("Jane Author")).toHaveLength(2);
    expect(screen.getByText("2 books")).toBeTruthy();
    expect(screen.getByText("Writes sweeping sagas across many worlds.")).toBeTruthy();
    expect(screen.getByText("Audio Novel")).toBeTruthy();
    expect(screen.getByText("Ebook Novel")).toBeTruthy();
    expect(screen.getByText("A Subtitle")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/authors/a1?include=items,series");
  });

  it("filters ebook-only books under hideNonAudiobooksGlobal", async () => {
    useUserStore.setState({
      settings: { ...useUserStore.getState().settings, hideNonAudiobooksGlobal: true },
    } as any);
    await renderAuthor();
    await screen.findByText("Audio Novel");

    expect(screen.queryByText("Ebook Novel")).toBeNull();
    expect(screen.getByText("1 book")).toBeTruthy();
  });

  it("description tap toggles the collapsed line clamp", async () => {
    await renderAuthor();
    const desc = await screen.findByText("Writes sweeping sagas across many worlds.");

    expect(desc.props.numberOfLines).toBe(4);
    await fireEvent.press(desc);
    expect(
      screen.getByText("Writes sweeping sagas across many worlds.").props.numberOfLines
    ).toBeUndefined();
  });

  it("gives book cards a button role and a title/subtitle label", async () => {
    await renderAuthor();
    await screen.findByText("Audio Novel");

    // No subtitle → just the title.
    const audio = screen.getByLabelText("Audio Novel");
    expect(audio.props.accessibilityRole).toBe("button");
    // Title + subtitle folded together (BookCard pattern).
    const ebook = screen.getByLabelText("Ebook Novel. A Subtitle");
    expect(ebook.props.accessibilityRole).toBe("button");
  });

  it("gives the description toggle a button role and expanded state", async () => {
    await renderAuthor();
    await screen.findByText("Writes sweeping sagas across many worlds.");

    const toggle = screen.getByLabelText("Show more");
    expect(toggle.props.accessibilityRole).toBe("button");
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });

    await fireEvent.press(toggle);
    const expanded = screen.getByLabelText("Show less");
    expect(expanded.props.accessibilityState).toEqual({ expanded: true });
  });

  it("book card tap opens the item detail", async () => {
    const navigation = await renderAuthor();
    await screen.findByText("Audio Novel");

    await fireEvent.press(screen.getByText("Audio Novel"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "b1" });
  });

  it("back button stays reachable and works", async () => {
    const navigation = await renderAuthor();
    await screen.findByText("Audio Novel");

    await fireEvent.press(screen.getByLabelText("Back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("shows the shared EmptyState when the author has no books", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { ...AUTHOR, libraryItems: [], description: null },
    });
    await renderAuthor();

    // Shared <EmptyState> renders both the title and its supporting message.
    expect(await screen.findByText("No books by this author")).toBeTruthy();
    expect(
      screen.getByText(
        "Books appear here once this library has titles matched to this author."
      )
    ).toBeTruthy();
    expect(screen.getByText("0 books")).toBeTruthy();
  });

  it("shows the error state (also without an author id) and retries", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("down"));
    await renderAuthor();

    expect(await screen.findByText("Couldn't load author")).toBeTruthy();

    (api.get as jest.Mock).mockResolvedValue({ data: AUTHOR });
    await fireEvent.press(screen.getByLabelText("Retry"));

    expect(await screen.findByText("Audio Novel")).toBeTruthy();
  });

  it("errors immediately when no author id is provided", async () => {
    await renderAuthor({});

    expect(await screen.findByText("Couldn't load author")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("survives a null row in the library items without crashing the list", async () => {
    // A single null entry used to reach keyExtractor's item.id and crash the
    // FlatList (siblings guard with filter(Boolean)).
    (api.get as jest.Mock).mockResolvedValue({
      data: { ...AUTHOR, libraryItems: [AUTHOR.libraryItems[0], null] },
    });
    await renderAuthor();

    expect(await screen.findByText("Audio Novel")).toBeTruthy();
    // The null row is dropped from the count and the list.
    expect(screen.getByText("1 book")).toBeTruthy();
  });
});

describe("AuthorDetailScreen — missing-books discovery", () => {
  const { searchAuthors, getAuthorBooks } = require("../../utils/rmab");
  const { audibleAuthorBooks } = require("../../utils/audible");

  it("uses RMAB's server-side author list in jwt mode (reliable ASIN lookup, not Audible)", async () => {
    useRmabStore.setState({ configured: true, authMode: "jwt" } as any);
    (searchAuthors as jest.Mock).mockResolvedValue([{ name: "Jane Author", asin: "AUTH1" }]);
    (getAuthorBooks as jest.Mock).mockResolvedValue([
      { asin: "R1", title: "Server Missing Book", author: "Jane Author", isAvailable: false },
    ]);

    await renderAuthor();

    expect(await screen.findByText("Server Missing Book")).toBeTruthy();
    expect(searchAuthors).toHaveBeenCalledWith("Jane Author");
    expect(getAuthorBooks).toHaveBeenCalledWith("AUTH1");
    // The reliable server path means the Audible name text-match is not used.
    expect(audibleAuthorBooks).not.toHaveBeenCalled();
  });

  it("renders the missing section even when the author has NO owned books (empty branch)", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { ...AUTHOR, libraryItems: [], description: null },
    });
    useRmabStore.setState({ configured: true, authMode: "jwt" } as any);
    (searchAuthors as jest.Mock).mockResolvedValue([{ name: "Jane Author", asin: "AUTH1" }]);
    (getAuthorBooks as jest.Mock).mockResolvedValue([
      { asin: "R9", title: "Discoverable Book", author: "Jane Author", isAvailable: false },
    ]);

    await renderAuthor();

    // The empty-state copy AND the discovery/Request affordance both render.
    expect(await screen.findByText("No books by this author")).toBeTruthy();
    expect(await screen.findByText("Discoverable Book")).toBeTruthy();
    expect(screen.getByLabelText("Request Discoverable Book")).toBeTruthy();
  });

  it("falls back to Audible discovery for apiToken sessions", async () => {
    useRmabStore.setState({ configured: true, authMode: "apiToken" } as any);
    (audibleAuthorBooks as jest.Mock).mockResolvedValue([
      { asin: "A9", title: "Audible Book", author: "Jane Author" },
    ]);

    await renderAuthor();

    expect(await screen.findByText("Audible Book")).toBeTruthy();
    expect(searchAuthors).not.toHaveBeenCalled();
    expect(audibleAuthorBooks).toHaveBeenCalledWith("Jane Author");
  });
});
