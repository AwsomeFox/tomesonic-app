import { renderHook, act, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import { useNetworkStatus, isEffectivelyOffline } from "../../hooks/useNetworkStatus";
import { storage } from "../../utils/storage";

describe("useNetworkStatus", () => {
  beforeEach(() => {
    // The MMKV mock is a real in-memory store — persisted status from one
    // test must not leak into the next.
    storage.remove("lastNetworkStatus");
  });
  it("defaults to online and subscribes to NetInfo", async () => {
    const unsubscribe = jest.fn();
    jest.mocked(NetInfo.addEventListener).mockReturnValue(unsubscribe);

    const { result, unmount } = await renderHook(() => useNetworkStatus());

    expect(result.current).toMatchObject({ isConnected: true, isInternetReachable: true });
    expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);

    await unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reflects connectivity changes pushed by NetInfo", async () => {
    let listener: (state: any) => void = () => {};
    jest.mocked(NetInfo.addEventListener).mockImplementation((cb: any) => {
      listener = cb;
      return jest.fn();
    });

    const { result } = await renderHook(() => useNetworkStatus());

    await act(async () => {
      listener({ isConnected: false, isInternetReachable: false });
    });
    expect(result.current).toMatchObject({ isConnected: false, isInternetReachable: false });

    await act(async () => {
      listener({ isConnected: true, isInternetReachable: true });
    });
    expect(result.current).toMatchObject({ isConnected: true, isInternetReachable: true });
  });

  it("treats missing fields as online (nullish fallback)", async () => {
    let listener: (state: any) => void = () => {};
    jest.mocked(NetInfo.addEventListener).mockImplementation((cb: any) => {
      listener = cb;
      return jest.fn();
    });

    const { result } = await renderHook(() => useNetworkStatus());

    await act(async () => {
      listener({ isConnected: null, isInternetReachable: undefined });
    });
    expect(result.current).toMatchObject({ isConnected: true, isInternetReachable: true });
  });

  it("unknown reachability inherits the connection state (offline + null ≠ reachable)", async () => {
    let listener: (state: any) => void = () => {};
    jest.mocked(NetInfo.addEventListener).mockImplementation((cb: any) => {
      listener = cb;
      return jest.fn();
    });

    const { result } = await renderHook(() => useNetworkStatus());

    // NetInfo's common "unknown" shape while offline — must not persist
    // {isConnected:false, isInternetReachable:true} for the next cold start.
    await act(async () => {
      listener({ isConnected: false, isInternetReachable: null });
    });
    expect(result.current).toMatchObject({ isConnected: false, isInternetReachable: false });
    expect(JSON.parse(storage.getString("lastNetworkStatus")!)).toEqual({
      isConnected: false,
      isInternetReachable: false,
    });
  });

  it("initializes offline from the persisted lastNetworkStatus BEFORE any NetInfo event", async () => {
    storage.set("lastNetworkStatus", '{"isConnected":false,"isInternetReachable":false}');
    // Subscribe but never fire — the initial render alone must be offline.
    jest.mocked(NetInfo.addEventListener).mockReturnValue(jest.fn());

    const { result } = await renderHook(() => useNetworkStatus());

    expect(result.current).toMatchObject({ isConnected: false, isInternetReachable: false });
  });

  it("falls back to isConnected when the persisted entry lacks isInternetReachable", async () => {
    storage.set("lastNetworkStatus", '{"isConnected":false}');
    jest.mocked(NetInfo.addEventListener).mockReturnValue(jest.fn());

    const { result } = await renderHook(() => useNetworkStatus());

    expect(result.current).toMatchObject({ isConnected: false, isInternetReachable: false });
  });

  it("defaults to online when nothing is persisted", async () => {
    jest.mocked(NetInfo.addEventListener).mockReturnValue(jest.fn());

    const { result } = await renderHook(() => useNetworkStatus());

    expect(result.current).toMatchObject({ isConnected: true, isInternetReachable: true });
  });

  it("ignores a corrupt persisted entry and defaults to online", async () => {
    storage.set("lastNetworkStatus", "{not-json");
    jest.mocked(NetInfo.addEventListener).mockReturnValue(jest.fn());

    const { result } = await renderHook(() => useNetworkStatus());

    expect(result.current).toMatchObject({ isConnected: true, isInternetReachable: true });
  });

  it("ignores a persisted entry with a non-boolean isConnected and defaults to online", async () => {
    storage.set("lastNetworkStatus", '{"isConnected":"nope"}');
    jest.mocked(NetInfo.addEventListener).mockReturnValue(jest.fn());

    const { result } = await renderHook(() => useNetworkStatus());

    expect(result.current).toMatchObject({ isConnected: true, isInternetReachable: true });
  });

  it("persists each NetInfo event to storage as well as updating state", async () => {
    let listener: (state: any) => void = () => {};
    jest.mocked(NetInfo.addEventListener).mockImplementation((cb: any) => {
      listener = cb;
      return jest.fn();
    });

    const { result } = await renderHook(() => useNetworkStatus());

    await act(async () => {
      listener({ isConnected: false, isInternetReachable: false });
    });
    expect(result.current).toMatchObject({ isConnected: false, isInternetReachable: false });
    expect(JSON.parse(storage.getString("lastNetworkStatus")!)).toEqual({
      isConnected: false,
      isInternetReachable: false,
    });

    await act(async () => {
      listener({ isConnected: true, isInternetReachable: true });
    });
    expect(JSON.parse(storage.getString("lastNetworkStatus")!)).toEqual({
      isConnected: true,
      isInternetReachable: true,
    });
  });

  it("falls back to online defaults when NetInfo subscription throws", async () => {
    jest.mocked(NetInfo.addEventListener).mockImplementation(() => {
      throw new Error("native module missing");
    });

    const { result, unmount } = await renderHook(() => useNetworkStatus());
    expect(result.current).toMatchObject({ isConnected: true, isInternetReachable: true });
    // Unmount must not throw even though there is no unsubscribe handle.
    await unmount();
  });

  describe("isEffectivelyOffline derived signal", () => {
    it("treats an EXPLICIT unreachable (false) as offline, but UNKNOWN (null/undefined) as NOT offline", () => {
      // Explicit false → offline (captive portal / server-down-but-Wi-Fi-up).
      expect(isEffectivelyOffline({ isConnected: true, isInternetReachable: false })).toBe(true);
      // No device connection → offline regardless of reachability.
      expect(isEffectivelyOffline({ isConnected: false, isInternetReachable: true })).toBe(true);
      // UNKNOWN reachability must NOT be treated as offline while connected.
      expect(isEffectivelyOffline({ isConnected: true, isInternetReachable: null })).toBe(false);
      expect(isEffectivelyOffline({ isConnected: true, isInternetReachable: undefined })).toBe(false);
      // Fully online.
      expect(isEffectivelyOffline({ isConnected: true, isInternetReachable: true })).toBe(false);
    });

    it("isOffline is false on the online default and true when seeded from persisted offline", async () => {
      jest.mocked(NetInfo.addEventListener).mockReturnValue(jest.fn());
      const online = await renderHook(() => useNetworkStatus());
      expect(online.result.current.isOffline).toBe(false);

      storage.set("lastNetworkStatus", '{"isConnected":false,"isInternetReachable":false}');
      const offline = await renderHook(() => useNetworkStatus());
      // Seeded synchronously so a cold offline start renders offline immediately.
      expect(offline.result.current.isOffline).toBe(true);
    });

    it("flips isOffline once a live-connection-but-unreachable state holds (debounced)", async () => {
      let listener: (state: any) => void = () => {};
      jest.mocked(NetInfo.addEventListener).mockImplementation((cb: any) => {
        listener = cb;
        return jest.fn();
      });

      const { result } = await renderHook(() => useNetworkStatus());
      expect(result.current.isOffline).toBe(false);

      // Wi-Fi still up (isConnected true) but the internet is explicitly
      // unreachable — the raw fields update immediately, isOffline after debounce.
      await act(async () => {
        listener({ isConnected: true, isInternetReachable: false });
      });
      expect(result.current.isConnected).toBe(true);
      expect(result.current.isInternetReachable).toBe(false);

      await waitFor(() => expect(result.current.isOffline).toBe(true), { timeout: 2000 });
    });

    it("QA#5: a flap that reverses within the debounce window never flips isOffline (clearTimeout cancellation)", async () => {
      let listener: (state: any) => void = () => {};
      jest.mocked(NetInfo.addEventListener).mockImplementation((cb: any) => {
        listener = cb;
        return jest.fn();
      });

      const { result } = await renderHook(() => useNetworkStatus());
      expect(result.current.isOffline).toBe(false);

      // Wi-Fi up but internet EXPLICITLY unreachable — this render ARMS the
      // 500ms debounce timer toward isOffline:true.
      await act(async () => {
        listener({ isConnected: true, isInternetReachable: false });
      });

      // A brief pause WELL WITHIN the debounce window — the timer is still
      // pending, so isOffline must not have flipped yet.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(result.current.isOffline).toBe(false);

      // Reachability recovers before the window closes. The effect cleanup
      // (clearTimeout at ~120-125) cancels the pending flip.
      await act(async () => {
        listener({ isConnected: true, isInternetReachable: true });
      });

      // Wait past the ORIGINAL debounce window: isOffline must have NEVER
      // become true because the pending timer was cancelled.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      expect(result.current.isOffline).toBe(false);
    });

    it("does NOT mark isOffline for a connected device with UNKNOWN reachability", async () => {
      let listener: (state: any) => void = () => {};
      jest.mocked(NetInfo.addEventListener).mockImplementation((cb: any) => {
        listener = cb;
        return jest.fn();
      });

      const { result } = await renderHook(() => useNetworkStatus());
      // null reachability while connected coalesces to the connection state
      // (true) — must stay online, never flip to offline.
      await act(async () => {
        listener({ isConnected: true, isInternetReachable: null });
      });
      // Give any (unwanted) debounce timer a chance to fire.
      await new Promise((r) => setTimeout(r, 700));
      expect(result.current.isOffline).toBe(false);
    });
  });
});
