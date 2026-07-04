/**
 * BookCard — cover/placeholder rendering, title/author, progress badge +
 * progress bars, download badge/overlay, book-count pill, tap → ItemDetail.
 */
import { render, screen, fireEvent } from "@testing-library/react-native";

// Minimal reanimated mock (setup-level mock pulls real react-native-worklets).
jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const RN = require("react-native");
  const strip = (C: any) =>
    React.forwardRef(({ entering, exiting, layout, animatedProps, ...rest }: any, ref: any) =>
      React.createElement(C, { ...rest, ...(animatedProps || {}), ref })
    );
  const Animated = {
    View: strip(RN.View),
    Text: strip(RN.Text),
    ScrollView: strip(RN.ScrollView),
    Image: strip(RN.Image),
    createAnimatedComponent: strip,
  };
  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    // Stable across renders (like the real hook) so effect-driven .value
    // writes survive re-renders and later style/props evaluations see them.
    useSharedValue: (init: any) => React.useRef({ value: init }).current,
    useAnimatedStyle: (fn: any) => {
      try {
        return fn() || {};
      } catch {
        return {};
      }
    },
    useAnimatedProps: (fn: any) => {
      try {
        return fn() || {};
      } catch {
        return {};
      }
    },
    withTiming: (v: any) => v,
    withSpring: (v: any) => v,
    withRepeat: (v: any) => v,
    withDelay: (_d: number, v: any) => v,
    cancelAnimation: () => {},
    runOnJS: (fn: any) => fn,
    interpolate: () => 0,
    Easing: {
      linear: (t: number) => t,
      bezier: () => ({ factory: () => (t: number) => t }),
      in: (f: any) => f,
      out: (f: any) => f,
      inOut: (f: any) => f,
    },
    useReducedMotion: () => false,
  };
});

import BookCard from "../../components/BookCard";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const userInitial = useUserStore.getState();
const downloadInitial = useDownloadStore.getState();

beforeEach(() => {
  useUserStore.setState(userInitial, true);
  useDownloadStore.setState(downloadInitial, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
});

function makeNav() {
  return { navigate: jest.fn() };
}

/** Depth-first search of the rendered JSON tree for a node whose flattened
 *  style matches `pred`. */
function findByStyle(node: any, pred: (style: any) => boolean): boolean {
  if (!node) return false;
  const arr = Array.isArray(node) ? node : [node];
  for (const el of arr) {
    if (!el || typeof el === "string") continue;
    const styles = Array.isArray(el.props?.style) ? el.props.style : [el.props?.style];
    const flat = Object.assign({}, ...styles.filter(Boolean));
    if (pred(flat)) return true;
    if (findByStyle(el.children, pred)) return true;
  }
  return false;
}

const bookWithCover = {
  id: "item1",
  mediaType: "book",
  media: {
    coverPath: "/covers/item1.jpg",
    numTracks: 2,
    duration: 3600,
    metadata: { title: "The Hobbit", authorName: "J.R.R. Tolkien" },
  },
};

const bookNoCover = {
  id: "item2",
  mediaType: "book",
  media: {
    numTracks: 1,
    metadata: { title: "Plain Book", authorName: "Nobody" },
  },
};

describe("BookCard", () => {
  it("renders title + author in the bottom meta panel (with cover)", async () => {
    await render(<BookCard item={bookWithCover} navigation={makeNav()} />);
    expect(screen.getByText("The Hobbit")).toBeTruthy();
    expect(screen.getByText("J.R.R. Tolkien")).toBeTruthy();
    expect(screen.getByLabelText("The Hobbit by J.R.R. Tolkien")).toBeTruthy();
  });

  it("renders the colored placeholder (title + author twice) without a cover", async () => {
    await render(<BookCard item={bookNoCover} navigation={makeNav()} />);
    // Placeholder text AND the meta panel both show the title.
    expect(screen.getAllByText("Plain Book").length).toBe(2);
    expect(screen.getAllByText("Nobody").length).toBe(2);
  });

  it("tapping navigates to ItemDetail with the item id", async () => {
    const navigation = makeNav();
    await render(<BookCard item={bookWithCover} navigation={navigation} />);
    await fireEvent.press(screen.getByLabelText("The Hobbit by J.R.R. Tolkien"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "item1" });
  });

  it("an onPress override wins over the default navigation", async () => {
    const navigation = makeNav();
    const onPress = jest.fn();
    await render(<BookCard item={bookWithCover} navigation={navigation} onPress={onPress} />);
    await fireEvent.press(screen.getByLabelText("The Hobbit by J.R.R. Tolkien"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("shows the progress badge from the global mediaProgress map", async () => {
    useUserStore.setState({
      mediaProgress: {
        item1: { libraryItemId: "item1", progress: 0.5, currentTime: 1800, duration: 3600 },
      },
    } as any);
    await render(<BookCard item={bookWithCover} navigation={makeNav()} />);
    expect(screen.getByText("30m")).toBeTruthy(); // badge remaining label
  });

  it("shows the book-count pill when badgeCount is set", async () => {
    await render(<BookCard item={bookWithCover} navigation={makeNav()} badgeCount={7} />);
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("shows the live download overlay while downloading", async () => {
    useDownloadStore.setState({
      activeDownloads: {
        item1: { id: "item1", status: "downloading", progress: 0.42 },
      },
    } as any);
    await render(<BookCard item={bookWithCover} navigation={makeNav()} />);
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("file-download")).toBeTruthy(); // download glyph
  });

  it("no download overlay for completed downloads (cloud badge instead)", async () => {
    useDownloadStore.setState({
      completedDownloads: { item1: { id: "item1", status: "completed" } },
    } as any);
    await render(<BookCard item={bookWithCover} navigation={makeNav()} />);
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(screen.getByText("Downloaded")).toBeTruthy(); // badge label
    expect(screen.getByText("cloud-done")).toBeTruthy();
  });

  it("falls back to embedded progress for the bottom audio bar", async () => {
    const item = {
      ...bookWithCover,
      userMediaProgress: { progress: 0.25, currentTime: 900, duration: 3600 },
    };
    await render(<BookCard item={item} navigation={makeNav()} />);
    // The embedded snapshot drives the 3px bottom progress bar (width 25%).
    expect(findByStyle(screen.toJSON(), (s) => s?.width === "25%" && s?.height === 3)).toBe(true);
  });

  it("podcast card renders with per-episode progress driving the bar", async () => {
    const podcast = {
      id: "pod1",
      mediaType: "podcast",
      media: { coverPath: "/c.jpg", metadata: { title: "The Daily", author: "NYT" } },
    };
    useUserStore.setState({
      mediaProgress: {
        "pod1-ep1": {
          libraryItemId: "pod1",
          episodeId: "ep1",
          progress: 0.5,
          currentTime: 600,
          duration: 1200,
          lastUpdate: 5,
        },
      },
    } as any);
    await render(<BookCard item={podcast} navigation={makeNav()} />);
    expect(screen.getByText("The Daily")).toBeTruthy();
    // Episode-derived remaining label in the badge (10m of 20m episode left).
    expect(screen.getByText("10m")).toBeTruthy();
  });
});
