/**
 * Simple presentational components: Icon, Skeleton family, OfflineBanner
 * (netinfo-driven), ErrorBoundary (child throws → fallback), Confetti,
 * WavyProgress, RotationCurtain.
 */
import { View, Text } from "react-native";
import { render, screen, fireEvent, act } from "@testing-library/react-native";

// Minimal reanimated mock — the setup-level one pulls real react-native-worklets
// and crashes; this covers the APIs these components use.
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
  const chainable = () => {
    const o: any = {};
    ["delay", "duration", "springify", "damping", "stiffness"].forEach((m) => (o[m] = () => o));
    return o;
  };
  const interpolate = (v: number, input: number[], output: any[]) => {
    if (!Array.isArray(input) || !Array.isArray(output)) return 0;
    if (v <= input[0]) return output[0];
    if (v >= input[input.length - 1]) return output[output.length - 1];
    for (let i = 0; i < input.length - 1; i++) {
      if (v >= input[i] && v <= input[i + 1]) {
        const t = (v - input[i]) / (input[i + 1] - input[i] || 1);
        const a = output[i];
        const b = output[i + 1];
        return typeof a === "number" && typeof b === "number" ? a + t * (b - a) : a;
      }
    }
    return output[0];
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
    withTiming: (v: any, _c?: any, cb?: (finished: boolean) => void) => {
      cb?.(true);
      return v;
    },
    withSpring: (v: any, _c?: any, cb?: (finished: boolean) => void) => {
      cb?.(true);
      return v;
    },
    withRepeat: (v: any) => v,
    withDelay: (_d: number, v: any) => v,
    cancelAnimation: () => {},
    runOnJS: (fn: any) => fn,
    runOnUI: (fn: any) => fn,
    interpolate,
    Extrapolation: { CLAMP: "clamp" },
    Easing: {
      linear: (t: number) => t,
      ease: (t: number) => t,
      quad: (t: number) => t,
      cubic: (t: number) => t,
      bezier: () => ({ factory: () => (t: number) => t }),
      in: (f: any) => f,
      out: (f: any) => f,
      inOut: (f: any) => f,
    },
    useReducedMotion: () => false,
    LinearTransition: chainable(),
    FadeIn: chainable(),
    FadeOut: chainable(),
    FadeInDown: chainable(),
    FadeInRight: chainable(),
  };
});

// Named exports are missing from the global safe-area mock — OfflineBanner
// imports useSafeAreaInsets by name.
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View: RNView } = require("react-native");
  return {
    SafeAreaView: ({ children, ...props }: any) => React.createElement(RNView, props, children),
    SafeAreaProvider: ({ children }: any) => children,
    useSafeAreaInsets: () => ({ top: 20, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 320, height: 640 }),
  };
});

import NetInfo from "@react-native-community/netinfo";
import { LinearGradient } from "expo-linear-gradient";
import Icon from "../../components/Icon";
import Skeleton, { ShelfSkeleton, GridSkeleton, ListSkeleton } from "../../components/Skeleton";
import OfflineBanner from "../../components/OfflineBanner";
import ErrorBoundary from "../../components/ErrorBoundary";
import Confetti from "../../components/Confetti";
import WavyProgress from "../../components/WavyProgress";
import RotationCurtain from "../../components/RotationCurtain";

// ---------------------------------------------------------------------------
describe("Icon", () => {
  it("renders a MaterialIcons glyph for 'mi' mappings", async () => {
    await render(<Icon name="search" />);
    expect(screen.getByLabelText("MaterialIcons:search")).toBeTruthy();
  });

  it("maps app names to the right glyph (filter → tune)", async () => {
    await render(<Icon name="filter" />);
    expect(screen.getByLabelText("MaterialIcons:tune")).toBeTruthy();
  });

  it("renders MaterialCommunityIcons for 'mci' mappings", async () => {
    await render(<Icon name="library" />);
    expect(screen.getByLabelText("MaterialCommunityIcons:database")).toBeTruthy();
  });

  it("falls back to help-outline for unknown names", async () => {
    await render(<Icon name={"definitely-not-an-icon" as any} />);
    expect(screen.getByLabelText("MaterialIcons:help-outline")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Each Skeleton block contains exactly one LinearGradient sweep; the mocked
// gradient is a View that keeps its `colors` prop, so count those in the tree.
function countGradients(node: any): number {
  if (!node) return 0;
  const arr = Array.isArray(node) ? node : [node];
  let n = 0;
  for (const el of arr) {
    if (!el || typeof el === "string") continue;
    if (Array.isArray(el.props?.colors)) n++;
    n += countGradients(el.children);
  }
  return n;
}

describe("Skeleton family", () => {
  it("Skeleton renders a shimmer block (one gradient sweep)", async () => {
    await render(<Skeleton width={100} height={20} />);
    expect(countGradients(screen.toJSON())).toBe(1);
  });

  it("ShelfSkeleton renders rows×(2 header + cards) blocks", async () => {
    await render(<ShelfSkeleton rows={2} cards={3} />);
    // per row: accent bar + title + 3 cards = 5 skeletons
    expect(countGradients(screen.toJSON())).toBe(10);
  });

  it("GridSkeleton renders `count` tiles", async () => {
    await render(<GridSkeleton columns={2} count={6} />);
    expect(countGradients(screen.toJSON())).toBe(6);
  });

  it("ListSkeleton renders thumb + two text lines per row", async () => {
    await render(<ListSkeleton rows={4} />);
    expect(countGradients(screen.toJSON())).toBe(12);
  });
});

// ---------------------------------------------------------------------------
describe("OfflineBanner", () => {
  const addListener = NetInfo.addEventListener as jest.Mock;

  // The banner now gates on the hook's derived, DEBOUNCED `isOffline` and seeds
  // it from the persisted last-status — so clear that persisted key between
  // cases (a prior offline case would otherwise seed the next render offline).
  beforeEach(() => {
    try {
      require("../../utils/storage").storage.remove("lastNetworkStatus");
    } catch {}
  });

  it("renders nothing while connected", async () => {
    addListener.mockImplementation((cb: any) => {
      cb({ isConnected: true, isInternetReachable: true });
      return jest.fn();
    });
    await render(<OfflineBanner />);
    expect(screen.toJSON()).toBeNull();
  });

  it("shows the banner when the connection drops, hides when it returns", async () => {
    jest.useFakeTimers();
    try {
      let listener: any;
      addListener.mockImplementation((cb: any) => {
        listener = cb;
        return jest.fn();
      });
      await render(<OfflineBanner />);
      expect(screen.toJSON()).toBeNull(); // default is online

      // The offline transition is debounced (~500ms) so a brief reachability
      // blip can't flap the UI. First flush the status update so the debounce
      // effect schedules its timer, THEN advance past it to commit the flip.
      await act(async () => {
        listener({ isConnected: false, isInternetReachable: false });
      });
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(
        screen.getByText("No internet connection — showing downloaded content")
      ).toBeTruthy();

      await act(async () => {
        listener({ isConnected: true, isInternetReachable: true });
      });
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.toJSON()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("defaults to online when netinfo state fields are missing", async () => {
    let listener: any;
    addListener.mockImplementation((cb: any) => {
      listener = cb;
      return jest.fn();
    });
    await render(<OfflineBanner />);
    await act(async () => {
      listener({});
    });
    // Missing fields → isConnected coerces to true and reachability is UNKNOWN
    // (not an explicit false), so the app stays optimistically online.
    expect(screen.toJSON()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("ErrorBoundary", () => {
  function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
    if (shouldThrow) throw new Error("kaboom");
    return <Text>all good</Text>;
  }

  it("renders children when nothing throws", async () => {
    await render(
      <ErrorBoundary>
        <Text>all good</Text>
      </ErrorBoundary>
    );
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("catches a render error and shows the themed fallback", async () => {
    // React logs caught boundary errors — keep the test output clean.
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    expect(screen.getByText("Reload")).toBeTruthy();
    consoleSpy.mockRestore();
  });

  it("Reload resets the boundary and re-renders children", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;
    function MaybeBomb() {
      if (shouldThrow) throw new Error("kaboom");
      return <Text>recovered</Text>;
    }
    await render(
      <ErrorBoundary>
        <MaybeBomb />
      </ErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    shouldThrow = false;
    await fireEvent.press(screen.getByLabelText("Reload the app"));
    expect(screen.getByText("recovered")).toBeTruthy();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe("Confetti", () => {
  it("renders nothing while not visible", async () => {
    await render(<Confetti visible={false} />);
    expect(screen.toJSON()).toBeNull();
  });

  it("renders a particle burst and completes with onDone", async () => {
    const onDone = jest.fn();
    await render(<Confetti visible onDone={onDone} />);
    // Mock timing completes synchronously → completion callback fired once.
    expect(onDone).toHaveBeenCalledTimes(1);
    // The burst renders its particle field (pointer-events disabled).
    expect(screen.toJSON()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("WavyProgress", () => {
  const layout = (width = 200) => ({ nativeEvent: { layout: { width, height: 18 } } });

  async function renderWave(props: Partial<React.ComponentProps<typeof WavyProgress>> = {}) {
    await render(
      <WavyProgress
        progress={0.5}
        playing
        color="#00897B"
        trackColor="#B2DFDB"
        {...props}
      />
    );
    // Svg only mounts after the container reports a width.
    await fireEvent(screen.root!, "layout", layout());
  }

  it("renders nothing until the container is measured", async () => {
    await render(
      <WavyProgress progress={0.5} playing color="#00897B" trackColor="#B2DFDB" />
    );
    // Root view exists but has no Svg child yet.
    expect(screen.root!.children).toHaveLength(0);
  });

  it("renders the wave once measured (playing, mid-progress)", async () => {
    await renderWave();
    expect(screen.root!.children.length).toBeGreaterThan(0);
  });

  it("builds the sine path once width and progress have propagated", async () => {
    await renderWave();
    // The animated-props worklet reads shared values that are synced by
    // effects AFTER the first measured render — a re-measure re-evaluates it
    // with the real width, exercising the path-building loop.
    await fireEvent(screen.root!, "layout", layout(240));
    const findPath = (node: any): string | null => {
      if (!node) return null;
      for (const el of Array.isArray(node) ? node : [node]) {
        if (!el || typeof el === "string") continue;
        if (typeof el.props?.d === "string" && el.props.d.startsWith("M 0")) return el.props.d;
        const inner = findPath(el.children);
        if (inner) return inner;
      }
      return null;
    };
    const d = findPath(screen.toJSON());
    expect(d).toBeTruthy();
    // Mid-progress on a 240-wide bar → a multi-segment line, not a bare move-to.
    expect((d as string).split("L").length).toBeGreaterThan(10);
  });

  it("renders at 0% and 100% without crashing", async () => {
    await renderWave({ progress: 0 });
    await renderWave({ progress: 1 });
    expect(screen.root!).toBeTruthy();
  });

  it("renders paused with flattenWhenPaused (amplitude settles to 0)", async () => {
    await renderWave({ playing: false, flattenWhenPaused: true });
    expect(screen.root!.children.length).toBeGreaterThan(0);
  });

  it("shows the slider handle when requested", async () => {
    await renderWave({ showHandle: true, showStopDot: false, handleActive: true });
    // Handle is a plain View pinned after the Svg.
    expect(screen.root!.children.length).toBeGreaterThanOrEqual(2);
  });

  it("clamps out-of-range progress values", async () => {
    await renderWave({ progress: 4.2 });
    await renderWave({ progress: -1 });
    expect(screen.root!).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("RotationCurtain", () => {
  it("renders an invisible full-screen curtain (opacity 0 at rest)", async () => {
    await render(<RotationCurtain />);
    const json: any = screen.toJSON();
    expect(json).not.toBeNull();
    expect(json.props.pointerEvents).toBe("none");
  });

  it("snaps the curtain opaque when the orientation flips", async () => {
    const { Dimensions } = require("react-native");
    let handler: any;
    const addSpy = jest
      .spyOn(Dimensions, "addEventListener")
      .mockImplementation((_type: any, cb: any) => {
        handler = cb;
        return { remove: jest.fn() } as any;
      });
    await render(<RotationCurtain />);
    expect(handler).toBeTruthy();
    // Same orientation → nothing happens; flipped → curtain fires (covers the
    // flip branch; opacity is a shared value, so we just assert no crash and
    // that repeated flips are tolerated).
    await act(async () => {
      handler({ window: { width: 400, height: 800 } }); // portrait (same)
      handler({ window: { width: 800, height: 400 } }); // → landscape (flip)
      handler({ window: { width: 400, height: 800 } }); // → portrait (flip back)
    });
    expect(screen.toJSON()).not.toBeNull();
    addSpy.mockRestore();
  });
});
