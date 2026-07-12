/**
 * usePolling — battery-conscious polling. Runs only while focused AND the app
 * is active AND enabled; never overlaps a pending fetch; backs off ×2 per
 * consecutive failure (capped at 60s, reset on success); and tears every
 * timer down on blur/background/unmount.
 */

// Controllable focus: capture the useFocusEffect callback so tests drive
// focus/blur by invoking it / its cleanup, exactly like react-navigation does.
let mockFocusEffectCb: (() => void | (() => void)) | null = null;
jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (cb: any) => {
    mockFocusEffectCb = cb;
  },
}));

import { AppState } from "react-native";
import { renderHook, act } from "@testing-library/react-native";
import { usePolling } from "../../hooks/usePolling";

// Controllable AppState: capture change listeners and emit transitions.
const appStateListeners: Array<(s: string) => void> = [];
const emitAppState = async (state: string) => {
  await act(async () => {
    appStateListeners.forEach((l) => l(state));
  });
};

let blurCleanup: (() => void) | void;
const focus = async () => {
  await act(async () => {
    blurCleanup = mockFocusEffectCb!();
  });
};
const blur = async () => {
  await act(async () => {
    if (typeof blurCleanup === "function") blurCleanup();
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockFocusEffectCb = null;
  blurCleanup = undefined;
  appStateListeners.length = 0;
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_type: string, handler: any) => {
    appStateListeners.push(handler);
    return {
      remove: () => {
        const i = appStateListeners.indexOf(handler);
        if (i >= 0) appStateListeners.splice(i, 1);
      },
    };
  }) as any);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("usePolling", () => {
  it("does not poll before focus", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    await renderHook(() => usePolling(fn, { intervalMs: 1000 }));
    await advance(10_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("polls immediately on focus, then every intervalMs", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderHook(() => usePolling(fn, { intervalMs: 1000 }));

    await focus();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.lastUpdatedAt).toEqual(expect.any(Number));

    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops on blur — nothing fires afterwards (battery contract)", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    await renderHook(() => usePolling(fn, { intervalMs: 1000 }));
    await focus();
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    await blur();
    // However long the app sits on another screen, the poller stays dead.
    await advance(600_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops on unmount — nothing fires afterwards", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const { unmount } = await renderHook(() => usePolling(fn, { intervalMs: 1000 }));
    await focus();
    expect(fn).toHaveBeenCalledTimes(1);

    await unmount();
    await advance(600_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never overlaps: a slow fetch defers the next tick until it settles", async () => {
    let resolveFetch!: () => void;
    const fn = jest.fn(
      () =>
        new Promise<void>((res) => {
          resolveFetch = res;
        })
    );
    const { result } = await renderHook(() => usePolling(fn, { intervalMs: 1000 }));

    await focus();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.isPolling).toBe(true);

    // Two intervals pass while the first fetch is still pending — no pile-up.
    await advance(2500);
    expect(fn).toHaveBeenCalledTimes(1);

    // Settle it: polling resumes on the normal cadence.
    await act(async () => {
      resolveFetch();
    });
    expect(result.current.isPolling).toBe(false);
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("doubles the delay per consecutive failure and resets on success", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error("boom")).mockRejectedValueOnce(new Error("boom"));
    fn.mockResolvedValue(undefined);
    await renderHook(() => usePolling(fn, { intervalMs: 1000 }));

    await focus(); // call 1 → fails → next delay 2000
    expect(fn).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(1); // 1000 < 2000: not yet
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(2); // call 2 → fails → next delay 4000

    await advance(3999);
    expect(fn).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fn).toHaveBeenCalledTimes(3); // call 3 → succeeds → backoff resets

    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(4); // back on the base cadence
  });

  it("caps the backoff at 60s", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("down"));
    await renderHook(() => usePolling(fn, { intervalMs: 10_000 }));

    await focus(); // fail 1 → 20s
    await advance(20_000); // fail 2 → 40s
    await advance(40_000); // fail 3 → 80s, capped to 60s
    expect(fn).toHaveBeenCalledTimes(3);

    await advance(59_999);
    expect(fn).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("pauses when the app leaves 'active' and resumes with a fresh poll", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    await renderHook(() => usePolling(fn, { intervalMs: 1000 }));
    await focus();
    expect(fn).toHaveBeenCalledTimes(1);

    await emitAppState("background");
    await advance(60_000);
    expect(fn).toHaveBeenCalledTimes(1);

    await emitAppState("active");
    expect(fn).toHaveBeenCalledTimes(2); // immediate poll on return
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(3); // and the cadence is re-armed
  });

  it("does not poll while enabled is false, starts when it flips true", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const { rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) => usePolling(fn, { intervalMs: 1000, enabled }),
      { initialProps: { enabled: false } }
    );
    await focus();
    await advance(5000);
    expect(fn).not.toHaveBeenCalled();

    await act(async () => {
      await rerender({ enabled: true });
    });
    expect(fn).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("refresh() fetches immediately and updates lastUpdatedAt", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderHook(() => usePolling(fn, { intervalMs: 1000 }));
    await focus();
    const firstStamp = result.current.lastUpdatedAt;
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.setSystemTime(Date.now() + 5);
      await result.current.refresh();
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.current.lastUpdatedAt).toBeGreaterThan(firstStamp!);
  });

  it("refresh() is in-flight guarded", async () => {
    let resolveFetch!: () => void;
    const fn = jest.fn(
      () =>
        new Promise<void>((res) => {
          resolveFetch = res;
        })
    );
    const { result } = await renderHook(() => usePolling(fn, { intervalMs: 1000 }));
    await focus();
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh(); // pending fetch → skipped
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch();
    });
  });
});
