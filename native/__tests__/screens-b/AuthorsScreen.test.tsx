/**
 * AuthorsScreen — grid renders from the authors endpoint, sort chips reorder,
 * cards navigate to AuthorDetail, the search overlay replaces the grid when
 * useUiStore.isSearchActive, and the error state offers retry.
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
import AuthorsScreen from "../../screens/AuthorsScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUiStore } from "../../store/useUiStore";

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialUi = useUiStore.getState();

const AUTHORS = [
  { id: "a1", name: "Brandon Sanderson", numBooks: 3, imagePath: "/img/a1", addedAt: 100 },
  { id: "a2", name: "Ann Leckie", numBooks: 10, addedAt: 300 },
  {
    id: "a3",
    name: "Ursula K. Le Guin",
    numBooks: 5,
    addedAt: 200,
    books: [{ id: "b1" }, { id: "b2" }],
  },
];

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderAuthors() {
  const navigation = makeNavigation();
  await render(<AuthorsScreen navigation={navigation} />);
  return navigation;
}

function renderedAuthorLabels(): string[] {
  return screen
    .getAllByLabelText(/^Author: /)
    .map((el) => el.props.accessibilityLabel as string);
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
  (api.get as jest.Mock).mockResolvedValue({ data: { authors: AUTHORS } });
});

describe("AuthorsScreen", () => {
  it("renders the author grid sorted by name with book counts", async () => {
    await renderAuthors();

    expect(await screen.findByText("Brandon Sanderson")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/authors");
    expect(renderedAuthorLabels()).toEqual([
      "Author: Ann Leckie, 10 books",
      "Author: Brandon Sanderson, 3 books",
      "Author: Ursula K. Le Guin, 5 books",
    ]);
    expect(screen.getByText("10 Books")).toBeTruthy();
  });

  it("sorting via the OrderModal reorders the grid and persists the choice", async () => {
    await renderAuthors();
    await screen.findByText("Brandon Sanderson");

    // Number of Books defaults to descending (biggest first).
    await fireEvent.press(screen.getByLabelText("Sort"));
    await fireEvent.press(screen.getByText("Number of Books"));
    expect(renderedAuthorLabels()).toEqual([
      "Author: Ann Leckie, 10 books",
      "Author: Ursula K. Le Guin, 5 books",
      "Author: Brandon Sanderson, 3 books",
    ]);
    // Choice is persisted to user settings (survives restarts).
    expect((useUserStore.getState().settings as any).mobileAuthorsOrderBy).toBe("numBooks");
    expect((useUserStore.getState().settings as any).mobileAuthorsOrderDesc).toBe(true);

    // Added At also defaults descending (most recent first).
    await fireEvent.press(screen.getByLabelText("Sort"));
    await fireEvent.press(screen.getByText("Added At"));
    expect(renderedAuthorLabels()).toEqual([
      "Author: Ann Leckie, 10 books", // addedAt 300
      "Author: Ursula K. Le Guin, 5 books", // 200
      "Author: Brandon Sanderson, 3 books", // 100
    ]);

    // Last-name sort ascends by default…
    await fireEvent.press(screen.getByLabelText("Sort"));
    await fireEvent.press(screen.getByText("Name (Last, First)"));
    expect(renderedAuthorLabels()).toEqual([
      "Author: Ursula K. Le Guin, 5 books", // Guin
      "Author: Ann Leckie, 10 books", // Leckie
      "Author: Brandon Sanderson, 3 books", // Sanderson
    ]);

    // …and re-picking the selected field flips the direction.
    await fireEvent.press(screen.getByLabelText("Sort"));
    await fireEvent.press(screen.getByText("Name (Last, First)"));
    expect(renderedAuthorLabels()).toEqual([
      "Author: Brandon Sanderson, 3 books",
      "Author: Ann Leckie, 10 books",
      "Author: Ursula K. Le Guin, 5 books",
    ]);
  });

  it("tapping a card opens the author detail", async () => {
    const navigation = await renderAuthors();
    await screen.findByText("Ann Leckie");

    await fireEvent.press(screen.getByLabelText("Author: Ann Leckie, 10 books"));
    expect(navigation.navigate).toHaveBeenCalledWith("AuthorDetail", {
      authorId: "a2",
      authorName: "Ann Leckie",
    });
  });

  it("swaps to the search overlay when search is active", async () => {
    await renderAuthors();
    await screen.findByText("Ann Leckie");

    await act(async () => {
      useUiStore.setState({ isSearchActive: true });
    });

    // Grid (and its sort affordance) are replaced by the search UI.
    expect(screen.queryByLabelText(/^Author: /)).toBeNull();
    expect(screen.queryByLabelText("Sort")).toBeNull();
    expect(screen.getByPlaceholderText("Search library...")).toBeTruthy();

    await act(async () => {
      useUiStore.setState({ isSearchActive: false });
    });
    expect(await screen.findByText("Ann Leckie")).toBeTruthy();
  });

  it("shows the empty state when the library has no authors", async () => {
    (api.get as jest.Mock).mockResolvedValue({ data: { authors: [] } });
    await renderAuthors();

    expect(await screen.findByText("No authors found")).toBeTruthy();
  });

  it("shows the error state and retries", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("down"));
    await renderAuthors();

    expect(await screen.findByText("Couldn't load authors")).toBeTruthy();

    (api.get as jest.Mock).mockResolvedValue({ data: { authors: AUTHORS } });
    await fireEvent.press(screen.getByLabelText("Retry"));

    expect(await screen.findByText("Ann Leckie")).toBeTruthy();
  });

  it("renders the hub list header and exposes scrollToTop when embedded", async () => {
    const ref = React.createRef<any>();
    const navigation = makeNavigation();
    await render(
      <AuthorsScreen ref={ref} navigation={navigation} embedded listHeader={<Text>HUB_PILLS</Text>} />
    );
    expect(await screen.findByText("Ann Leckie")).toBeTruthy();
    expect(screen.getByText("HUB_PILLS")).toBeTruthy();
    expect(typeof ref.current.scrollToTop).toBe("function");
    expect(typeof ref.current.openSort).toBe("function");
  });
});
