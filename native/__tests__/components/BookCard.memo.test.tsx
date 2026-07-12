/**
 * BookCard perf (H1): the card is wrapped in React.memo and subscribes to only
 * THIS item's mediaProgress entry via a narrow selector, so a playback progress
 * tick that rewrites the playing item's entry doesn't re-render every other
 * mounted card on Home.
 */
import { render, act } from "@testing-library/react-native";

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
    useSharedValue: (init: any) => React.useRef({ value: init }).current,
    useAnimatedStyle: (fn: any) => {
      try {
        return fn() || {};
      } catch {
        return {};
      }
    },
    withSpring: (v: any) => v,
    withTiming: (v: any) => v,
  };
});

// Count re-renders per item by proxying the child BookProgressBadge, which is
// recreated every time its parent BookCard renders. (Scoped to this file so it
// doesn't affect the badge-content assertions in BookCard.test.tsx.)
const mockBadgeRender = jest.fn();
jest.mock("../../components/BookProgressBadge", () => ({
  __esModule: true,
  default: (props: any) => {
    mockBadgeRender(props.itemId);
    return null;
  },
  bookStatusA11yLabel: () => "",
}));

import BookCard from "../../components/BookCard";
import { useUserStore } from "../../store/useUserStore";

const userInitial = useUserStore.getState();

beforeEach(() => {
  useUserStore.setState(userInitial, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
    mediaProgress: {},
  } as any);
  mockBadgeRender.mockClear();
});

const bookA = {
  id: "A",
  mediaType: "book",
  media: { coverPath: "/a.jpg", duration: 3600, numTracks: 2, metadata: { title: "Book A", authorName: "Alice" } },
};
const bookB = {
  id: "B",
  mediaType: "book",
  media: { coverPath: "/b.jpg", duration: 3600, numTracks: 2, metadata: { title: "Book B", authorName: "Bob" } },
};

const nav = () => ({ navigate: jest.fn() });
const countFor = (id: string) => mockBadgeRender.mock.calls.filter((c) => c[0] === id).length;

describe("BookCard memoization (H1)", () => {
  it("is wrapped in React.memo", () => {
    expect((BookCard as any).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("a progress tick for one item does not re-render another item's card", async () => {
    useUserStore.setState({
      mediaProgress: {
        A: { libraryItemId: "A", progress: 0.1, currentTime: 360, duration: 3600 },
        B: { libraryItemId: "B", progress: 0.2, currentTime: 720, duration: 3600 },
      },
    } as any);

    await render(
      <>
        <BookCard item={bookA} navigation={nav()} />
        <BookCard item={bookB} navigation={nav()} />
      </>
    );

    const aBefore = countFor("A");
    const bBefore = countFor("B");
    expect(aBefore).toBeGreaterThan(0);
    expect(bBefore).toBeGreaterThan(0);

    // A playback tick rewrites ONLY item A's entry — the whole map object is new,
    // but item B's entry reference is preserved.
    await act(async () => {
      useUserStore.setState((s: any) => ({
        mediaProgress: { ...s.mediaProgress, A: { ...s.mediaProgress.A, progress: 0.5, currentTime: 1800 } },
      }));
    });

    // A re-rendered (its own entry changed); B did NOT (narrow per-item selector
    // + React.memo mean B's identical entry reference bails the update out).
    expect(countFor("A")).toBeGreaterThan(aBefore);
    expect(countFor("B")).toBe(bBefore);
  });
});

describe("latestPodcastFraction index cache", () => {
  const { latestPodcastFraction } = require("../../components/BookCard");

  it("builds the per-podcast index ONCE per map reference and reads O(1) after", () => {
    const map: Record<string, any> = {
      "pod1-ep1": { libraryItemId: "pod1", episodeId: "ep1", progress: 0.3, lastUpdate: 100 },
      "pod1-ep2": { libraryItemId: "pod1", episodeId: "ep2", progress: 0.7, lastUpdate: 200 },
      "pod2-ep1": { libraryItemId: "pod2", episodeId: "ep1", progress: 0.4, lastUpdate: 150 },
      book1: { libraryItemId: "book1", progress: 0.9, lastUpdate: 300 },
    };
    // Latest unfinished episode wins per podcast; multiple podcasts resolve
    // from the SAME single-pass index.
    expect(latestPodcastFraction(map, "pod1")).toBe(0.7);
    expect(latestPodcastFraction(map, "pod2")).toBe(0.4);

    // Same map REFERENCE → cached index: an in-place mutation is intentionally
    // NOT observed (proves no re-scan). The store always replaces the map on
    // write, so staleness can't occur in production — this pins the cache.
    map["pod1-ep3"] = { libraryItemId: "pod1", episodeId: "ep3", progress: 0.9, lastUpdate: 400 };
    expect(latestPodcastFraction(map, "pod1")).toBe(0.7);

    // New reference (how zustand writes land) → recomputed index sees ep3.
    expect(latestPodcastFraction({ ...map }, "pod1")).toBe(0.9);
  });

  it("skips finished and zero-progress entries and tolerates junk", () => {
    const map: Record<string, any> = {
      "pod1-ep1": { libraryItemId: "pod1", episodeId: "ep1", progress: 0.8, lastUpdate: 500, isFinished: true },
      "pod1-ep2": { libraryItemId: "pod1", episodeId: "ep2", progress: 0, lastUpdate: 600 },
      junk: null,
    };
    expect(latestPodcastFraction(map, "pod1")).toBe(0);
    expect(latestPodcastFraction({}, "pod1")).toBe(0);
    expect(latestPodcastFraction(map, "")).toBe(0);
  });
});
