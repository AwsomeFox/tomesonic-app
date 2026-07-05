import { renderHook, act } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";

describe("useNetworkStatus", () => {
  it("defaults to online and subscribes to NetInfo", async () => {
    const unsubscribe = jest.fn();
    jest.mocked(NetInfo.addEventListener).mockReturnValue(unsubscribe);

    const { result, unmount } = await renderHook(() => useNetworkStatus());

    expect(result.current).toEqual({ isConnected: true, isInternetReachable: true });
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
    expect(result.current).toEqual({ isConnected: false, isInternetReachable: false });

    await act(async () => {
      listener({ isConnected: true, isInternetReachable: true });
    });
    expect(result.current).toEqual({ isConnected: true, isInternetReachable: true });
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
    expect(result.current).toEqual({ isConnected: true, isInternetReachable: true });
  });

  it("falls back to online defaults when NetInfo subscription throws", async () => {
    jest.mocked(NetInfo.addEventListener).mockImplementation(() => {
      throw new Error("native module missing");
    });

    const { result, unmount } = await renderHook(() => useNetworkStatus());
    expect(result.current).toEqual({ isConnected: true, isInternetReachable: true });
    // Unmount must not throw even though there is no unsubscribe handle.
    await unmount();
  });
});
