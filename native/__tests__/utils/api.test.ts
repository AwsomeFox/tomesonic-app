import axios from "axios";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "../../utils/api";
import { storageHelper, secureStorage } from "../../utils/storage";
import { useUserStore } from "../../store/useUserStore";

// The interceptor handlers registered at module load (axios 1.x keeps them on
// `handlers`). Driving them directly avoids any real network traffic.
const requestHandler = (api.interceptors.request as any).handlers[0];
const responseHandler = (api.interceptors.response as any).handlers[0];

const initialUserState = useUserStore.getState();

// A stub adapter so `api(originalRequest)` retries resolve in-process.
const stubAdapter = (cfg: any) =>
  Promise.resolve({ data: "retried-ok", status: 200, statusText: "OK", headers: {}, config: cfg });

const make401 = (url = "/api/items", extra: any = {}) => {
  const config: any = { url, method: "get", headers: {}, adapter: stubAdapter, ...extra };
  return { config, response: { status: 401 }, message: "Request failed with 401" };
};

let postSpy: jest.SpyInstance;

beforeEach(() => {
  secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
  useUserStore.setState(initialUserState, true);
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
  (FileSystem.writeAsStringAsync as jest.Mock).mockResolvedValue(undefined);
  postSpy = jest.spyOn(axios, "post");
});

afterEach(() => {
  postSpy.mockRestore();
});

describe("request interceptor", () => {
  it("injects baseURL (trailing slash stripped) and bearer token from the stored config", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local/", token: "tok1" });
    const config = await requestHandler.fulfilled({ url: "/api/me", method: "get", headers: {} });
    expect(config.baseURL).toBe("http://abs.local");
    expect(config.headers.Authorization).toBe("Bearer tok1");
  });

  it("leaves the config untouched when no server is configured", async () => {
    const config = await requestHandler.fulfilled({ url: "/api/me", method: "get", headers: {} });
    expect(config.baseURL).toBeUndefined();
    expect(config.headers.Authorization).toBeUndefined();
  });

  it("rejects request setup errors through", async () => {
    const err = new Error("bad config");
    await expect(requestHandler.rejected(err)).rejects.toBe(err);
  });
});

describe("response interceptor", () => {
  it("passes successful responses through untouched", () => {
    const response = { status: 200, data: { ok: true } };
    expect(responseHandler.fulfilled(response)).toBe(response);
  });

  it("rejects non-401 errors without attempting a refresh", async () => {
    const err = { config: { url: "/api/x", headers: {} }, response: { status: 500 } };
    await expect(responseHandler.rejected(err)).rejects.toBe(err);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("rejects network errors (no response) without refreshing", async () => {
    const err = { config: { url: "/api/x", headers: {} }, message: "Network Error" };
    await expect(responseHandler.rejected(err)).rejects.toBe(err);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("never tries to refresh a 401 from the auth endpoints (no infinite loop)", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t", refreshToken: "r" });
    for (const url of ["http://abs.local/auth/refresh", "http://abs.local/login"]) {
      const err = make401(url);
      await expect(responseHandler.rejected(err)).rejects.toBe(err);
    }
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("does not retry a request already flagged _retry", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t", refreshToken: "r" });
    const err = make401("/api/x", { _retry: true });
    await expect(responseHandler.rejected(err)).rejects.toBe(err);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("forces logout when no server is configured", async () => {
    useUserStore.setState({
      user: { id: "u1" },
      serverConnectionConfig: { address: "http://abs.local", username: "me", token: "t" },
    } as any);
    const err = make401();
    await expect(responseHandler.rejected(err)).rejects.toBe(err);

    expect(useUserStore.getState().user).toBeNull();
    // Non-secret fields survive so the address can prefill on re-login.
    expect(useUserStore.getState().serverConnectionConfig).toEqual({
      address: "http://abs.local",
      username: "me",
      name: undefined,
    });
  });

  it("forces logout when there is no refresh token anywhere", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t" }); // no refreshToken
    useUserStore.setState({ user: { id: "u1" } } as any);

    const err = make401();
    await expect(responseHandler.rejected(err)).rejects.toBe(err);

    expect(postSpy).not.toHaveBeenCalled();
    expect(useUserStore.getState().user).toBeNull();
    expect(storageHelper.getServerConfig()).toBeNull();
  });

  it("refreshes the token, persists it everywhere and replays the request", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local/",
      token: "stale",
      refreshToken: "refresh-1",
    });
    postSpy.mockResolvedValue({
      status: 200,
      data: { user: { accessToken: "fresh", refreshToken: "refresh-2" } },
    });

    const err = make401();
    const result = await responseHandler.rejected(err);

    // Refresh went to the host with the stored refresh token.
    expect(postSpy).toHaveBeenCalledWith(
      "http://abs.local/auth/refresh",
      {},
      expect.objectContaining({
        headers: expect.objectContaining({ "x-refresh-token": "refresh-1" }),
        timeout: 20000,
      })
    );

    // The retried request carried the fresh token and resolved via our adapter.
    expect(result.data).toBe("retried-ok");
    expect(err.config._retry).toBe(true);
    expect(err.config.headers.Authorization).toBe("Bearer fresh");

    // 1. Secure store updated.
    expect(storageHelper.getServerConfig()).toMatchObject({
      token: "fresh",
      refreshToken: "refresh-2",
    });
    // 2. User store (cover/stream URL builders) updated.
    expect(useUserStore.getState().serverConnectionConfig).toMatchObject({ token: "fresh" });
    // 3. Android Auto creds mirror rewritten.
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      "file:///test-documents/auto_creds.json",
      expect.stringContaining('"token":"fresh"')
    );
  });

  it("keeps the old refresh token when the refresh response doesn't rotate it", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "refresh-1",
    });
    postSpy.mockResolvedValue({ status: 200, data: { user: { accessToken: "fresh" } } });

    await responseHandler.rejected(make401());
    expect(storageHelper.getServerConfig()).toMatchObject({
      token: "fresh",
      refreshToken: "refresh-1",
    });
  });

  it("prefers the Android Auto creds file's refresh token over the stored one", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "stored-refresh",
    });
    // auto_creds.json holds the freshest pair after a drive.
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "x", refreshToken: "file-refresh" })
    );
    postSpy.mockResolvedValue({
      status: 200,
      data: { user: { accessToken: "fresh", refreshToken: "r2" } },
    });

    await responseHandler.rejected(make401());
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][2].headers["x-refresh-token"]).toBe("file-refresh");
  });

  it("falls back to the stored refresh token when the file token fails", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "stored-refresh",
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "x", refreshToken: "dead-file-refresh" })
    );
    postSpy
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce({ status: 200, data: { user: { accessToken: "fresh" } } });

    const result = await responseHandler.rejected(make401());
    expect(result.data).toBe("retried-ok");
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[0][2].headers["x-refresh-token"]).toBe("dead-file-refresh");
    expect(postSpy.mock.calls[1][2].headers["x-refresh-token"]).toBe("stored-refresh");
  });

  it("logs out on a definitive refresh rejection (401/403)", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "dead",
    });
    useUserStore.setState({ user: { id: "u1" } } as any);
    const refreshErr = { response: { status: 401 }, message: "dead token" };
    postSpy.mockRejectedValue(refreshErr);

    await expect(responseHandler.rejected(make401())).rejects.toBe(refreshErr);
    expect(useUserStore.getState().user).toBeNull();
    expect(storageHelper.getServerConfig()).toBeNull();
  });

  it("does NOT log out on a transient refresh failure (network blip / 5xx)", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "r1",
    });
    useUserStore.setState({ user: { id: "u1" } } as any);
    const refreshErr = { message: "timeout of 20000ms exceeded" }; // no response
    postSpy.mockRejectedValue(refreshErr);

    await expect(responseHandler.rejected(make401())).rejects.toBe(refreshErr);
    // Session survives the blip: next 401 simply retries the refresh.
    expect(useUserStore.getState().user).toEqual({ id: "u1" });
    expect(storageHelper.getServerConfig()).toMatchObject({ refreshToken: "r1" });
  });

  it("treats an invalid refresh response structure as a failure (but not a logout)", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "r1",
    });
    useUserStore.setState({ user: { id: "u1" } } as any);
    postSpy.mockResolvedValue({ status: 200, data: { nope: true } });

    await expect(responseHandler.rejected(make401())).rejects.toThrow(
      "Invalid token refresh response structure"
    );
    expect(useUserStore.getState().user).toEqual({ id: "u1" });
  });

  it("queues concurrent 401s behind one refresh and replays them all with the new token", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "r1",
    });
    let releaseRefresh!: (v: any) => void;
    postSpy.mockImplementation(() => new Promise((res) => (releaseRefresh = res)));

    const err1 = make401("/api/one");
    const err2 = make401("/api/two");

    const p1 = responseHandler.rejected(err1); // starts the refresh
    const p2 = responseHandler.rejected(err2); // must queue, not double-refresh

    for (let i = 0; i < 50 && !releaseRefresh; i++) await Promise.resolve();
    releaseRefresh({ status: 200, data: { user: { accessToken: "fresh" } } });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(postSpy).toHaveBeenCalledTimes(1); // single refresh for both
    expect(r1.data).toBe("retried-ok");
    expect(r2.data).toBe("retried-ok");
    expect(err1.config.headers.Authorization).toBe("Bearer fresh");
    expect(err2.config.headers.Authorization).toBe("Bearer fresh");
  });

  it("rejects queued requests when the shared refresh fails", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "r1",
    });
    let rejectRefresh!: (e: any) => void;
    postSpy.mockImplementation(() => new Promise((_res, rej) => (rejectRefresh = rej)));

    const p1 = responseHandler.rejected(make401("/api/one"));
    const p2 = responseHandler.rejected(make401("/api/two"));
    p1.catch(() => {});
    p2.catch(() => {});

    for (let i = 0; i < 50 && !rejectRefresh; i++) await Promise.resolve();
    const refreshErr = { message: "server unreachable" };
    rejectRefresh(refreshErr);

    await expect(p1).rejects.toBe(refreshErr);
    await expect(p2).rejects.toBe(refreshErr);
  });
});
