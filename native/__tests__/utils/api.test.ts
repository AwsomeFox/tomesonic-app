import axios from "axios";
import * as FileSystem from "expo-file-system/legacy";
import { api, recoverSessionIfNeeded, __resetSessionRecoveryForTests } from "../../utils/api";
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
let getSpy: jest.SpyInstance;

beforeEach(() => {
  secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
  useUserStore.setState(initialUserState, true);
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
  (FileSystem.writeAsStringAsync as jest.Mock).mockResolvedValue(undefined);
  // Never real network: an un-stubbed refresh is ABS rejecting the token…
  postSpy = jest
    .spyOn(axios, "post")
    .mockRejectedValue({ response: { status: 401 }, message: "default: ABS rejects" });
  // …and the server answers /ping as ABS (the rejection is ABS's verdict).
  getSpy = jest.spyOn(axios, "get").mockResolvedValue({ status: 200, data: { success: true } });
});

afterEach(() => {
  postSpy.mockRestore();
  getSpy.mockRestore();
  __resetSessionRecoveryForTests();
  jest.useRealTimers();
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

  it("no refresh token anywhere: tries the COOKIE refresh, logs out only when ABS rejects it", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t" }); // no refreshToken
    useUserStore.setState({ user: { id: "u1" } } as any);

    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();

    // Cookie mode: no x-refresh-token header, the jar's refresh_token cookie.
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][0]).toBe("http://abs.local/auth/refresh");
    expect(postSpy.mock.calls[0][2].headers["x-refresh-token"]).toBeUndefined();
    expect(postSpy.mock.calls[0][2].withCredentials).toBe(true);
    expect(getSpy).toHaveBeenCalledWith("http://abs.local/ping", expect.anything());
    expect(useUserStore.getState().user).toBeNull();
    expect(storageHelper.getServerConfig()).toBeNull();
  });

  // REGRESSION (Fix #5): forceLogout cleared config + the AA downloads file but
  // never deactivated the download store, so it kept the signed-out account's
  // items — and a later mediaProgress write could repopulate the AA file via the
  // store subscription. forceLogout must stop surfacing them (like logout/login).
  it("empties the download store on forced logout", async () => {
    const { useDownloadStore } = require("../../store/useDownloadStore");
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t" }); // no refreshToken → forceLogout
    useUserStore.setState({ user: { id: "u1" } } as any);
    useDownloadStore.setState({
      completedDownloads: { item1: { id: "item1" } as any },
      activeDownloads: { item2: { id: "item2" } as any },
    });

    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();

    expect(useDownloadStore.getState().completedDownloads).toEqual({});
    expect(useDownloadStore.getState().activeDownloads).toEqual({});
  });

  // REGRESSION: a bare forceLogout left the live session's 1s tick + ~15s sync
  // running under the signed-out account, churning refresh→forceLogout. It must
  // stop playback (the way logout() does) so the session goes quiet.
  it("stops playback on forced logout", async () => {
    const { usePlaybackStore } = require("../../store/usePlaybackStore");
    const closeSpy = jest
      .spyOn(usePlaybackStore.getState(), "closePlayback")
      .mockResolvedValue(undefined);
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t" }); // no refreshToken
    useUserStore.setState({ user: { id: "u1" } } as any);

    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();

    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
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
    // 3. Android Auto creds mirror rewritten (atomically: content goes to the
    // temp, which is renamed over the destination).
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      "file:///test-documents/auto_creds.json.tmp",
      expect.stringContaining('"token":"fresh"')
    );
    expect(FileSystem.moveAsync).toHaveBeenCalledWith({
      from: "file:///test-documents/auto_creds.json.tmp",
      to: "file:///test-documents/auto_creds.json",
    });
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

  // REGRESSION: when the FILE candidate token produced the successful refresh
  // and the server didn't rotate (no new refreshToken), the used file token —
  // not the stale stored one — must be persisted. Falling back to
  // serverConfig.refreshToken here would clobber a working token → forced logout.
  it("persists the USED (file) refresh token when the response omits a new one", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "stored-refresh",
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "x", refreshToken: "file-refresh" })
    );
    // Refresh succeeds on the file token but the server does NOT rotate it.
    postSpy.mockResolvedValue({ status: 200, data: { user: { accessToken: "fresh" } } });

    await responseHandler.rejected(make401());

    // The file token that actually worked is kept — NOT the stale stored one.
    expect(postSpy.mock.calls[0][2].headers["x-refresh-token"]).toBe("file-refresh");
    expect(storageHelper.getServerConfig()).toMatchObject({
      token: "fresh",
      refreshToken: "file-refresh",
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

  // REGRESSION (poor-reception logout): after the native Android Auto service
  // rotates the pair, auto_creds holds the only LIVE refresh token and the
  // stored one is dead. Under poor reception the live candidate's POST can
  // time out while the dead one reaches the server and draws a real 401 —
  // and the round used to be classified by whichever error came LAST, logging
  // the user out of a live session. A round with an unheard candidate must
  // stay transient: no logout, next 401 retries.
  it("does NOT log out when the fresh candidate times out and only the stale one draws the 401", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "dead-stored-refresh",
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "x", refreshToken: "live-file-refresh" })
    );
    useUserStore.setState({ user: { id: "u1" } } as any);
    const timeoutErr = { message: "timeout of 20000ms exceeded" }; // no response — never heard
    postSpy
      .mockRejectedValueOnce(timeoutErr) // live-file-refresh: eaten by the network
      .mockRejectedValueOnce({ response: { status: 401 }, message: "dead token" }); // stored: real rejection

    await expect(responseHandler.rejected(make401())).rejects.toBe(timeoutErr);
    expect(postSpy.mock.calls[0][2].headers["x-refresh-token"]).toBe("live-file-refresh");
    expect(postSpy.mock.calls[1][2].headers["x-refresh-token"]).toBe("dead-stored-refresh");
    // Session survives: the unheard candidate may be the live one.
    expect(useUserStore.getState().user).toEqual({ id: "u1" });
    expect(storageHelper.getServerConfig()).toMatchObject({ refreshToken: "dead-stored-refresh" });
  });

  it("does NOT log out in the mirror order either (definitive first, then a network failure)", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "stored-refresh",
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "x", refreshToken: "file-refresh" })
    );
    useUserStore.setState({ user: { id: "u1" } } as any);
    const timeoutErr = { message: "Network Error" };
    postSpy
      .mockRejectedValueOnce({ response: { status: 403 }, message: "rejected" })
      .mockRejectedValueOnce(timeoutErr);

    await expect(responseHandler.rejected(make401())).rejects.toBe(timeoutErr);
    expect(useUserStore.getState().user).toEqual({ id: "u1" });
  });

  it("still logs out when EVERY candidate is definitively rejected (401/401)", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "dead-stored-refresh",
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "x", refreshToken: "dead-file-refresh" })
    );
    useUserStore.setState({ user: { id: "u1" } } as any);
    const deadErr = { response: { status: 401 }, message: "dead token" };
    postSpy.mockRejectedValue(deadErr);

    await expect(responseHandler.rejected(make401())).rejects.toBe(deadErr);
    expect(postSpy).toHaveBeenCalledTimes(2); // both candidates were heard and rejected
    expect(useUserStore.getState().user).toBeNull();
    expect(storageHelper.getServerConfig()).toBeNull();
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

  it("flags queued replays _retry so a replay that 401s again cannot start a second refresh", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "r1",
    });
    // Replays 401 again (per-resource authz / post-rotation rejection) — this
    // goes through the REAL axios pipeline, so an un-flagged replay would
    // re-enter the interceptor and kick off a second full refresh.
    const reject401Adapter = (cfg: any) =>
      Promise.reject({ config: cfg, response: { status: 401 }, message: "replay 401" });

    let releaseRefresh!: (v: any) => void;
    postSpy
      .mockImplementationOnce(() => new Promise((res) => (releaseRefresh = res)))
      // If a second refresh DID happen (regression), let it resolve so the
      // test fails on call count instead of timing out.
      .mockResolvedValue({ status: 200, data: { user: { accessToken: "fresh2" } } });

    const err1 = make401("/api/one", { adapter: reject401Adapter });
    const err2 = make401("/api/two", { adapter: reject401Adapter });

    const p1 = responseHandler.rejected(err1); // starts the refresh
    const p2 = responseHandler.rejected(err2); // queued behind it
    p1.catch(() => {});
    p2.catch(() => {});

    for (let i = 0; i < 50 && !releaseRefresh; i++) await Promise.resolve();
    releaseRefresh({ status: 200, data: { user: { accessToken: "fresh" } } });

    // Both replays 401ed again and must reject straight through.
    await expect(p1).rejects.toMatchObject({ response: { status: 401 } });
    await expect(p2).rejects.toMatchObject({ response: { status: 401 } });

    // The queued replay was flagged one-shot and no second refresh ran.
    expect(err2.config._retry).toBe(true);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT log out on refresh 401 when auto_creds rotated to an untried token meanwhile", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "dead",
    });
    useUserStore.setState({ user: { id: "u1" } } as any);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readAsStringAsync as jest.Mock)
      // Candidate snapshot: file holds the same (dead) token as the store.
      .mockResolvedValueOnce(
        JSON.stringify({ server: "http://abs.local", token: "t", refreshToken: "dead" })
      )
      // Re-read after the refresh 401: the native Android Auto service
      // rotated the pair in the meantime — this token was never tried.
      .mockResolvedValueOnce(
        JSON.stringify({ server: "http://abs.local", token: "t2", refreshToken: "rotated-by-auto" })
      );
    const refreshErr = { response: { status: 401 }, message: "dead token" };
    postSpy.mockRejectedValue(refreshErr);

    await expect(responseHandler.rejected(make401())).rejects.toBe(refreshErr);

    // Session left intact — the next 401 retries with the fresh file pair.
    expect(useUserStore.getState().user).toEqual({ id: "u1" });
    expect(storageHelper.getServerConfig()).toMatchObject({ refreshToken: "dead" });
  });

  it("still logs out on refresh 401 when the re-read auto_creds token was already tried", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "dead",
    });
    useUserStore.setState({ user: { id: "u1" } } as any);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    // Same file content on snapshot and re-read: nothing new to try.
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "t", refreshToken: "dead" })
    );
    const refreshErr = { response: { status: 401 }, message: "dead token" };
    postSpy.mockRejectedValue(refreshErr);

    await expect(responseHandler.rejected(make401())).rejects.toBe(refreshErr);

    expect(useUserStore.getState().user).toBeNull();
    expect(storageHelper.getServerConfig()).toBeNull();
  });

  it("still logs out on refresh 401 when the re-read auto_creds is for a different server", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "dead",
    });
    useUserStore.setState({ user: { id: "u1" } } as any);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readAsStringAsync as jest.Mock)
      .mockResolvedValueOnce(
        JSON.stringify({ server: "http://abs.local", token: "t", refreshToken: "dead" })
      )
      // Untried token, but it belongs to ANOTHER host — no reason to keep
      // this session alive.
      .mockResolvedValueOnce(
        JSON.stringify({ server: "http://other.local", token: "t2", refreshToken: "untried" })
      );
    const refreshErr = { response: { status: 403 }, message: "forbidden" };
    postSpy.mockRejectedValue(refreshErr);

    await expect(responseHandler.rejected(make401())).rejects.toBe(refreshErr);

    expect(useUserStore.getState().user).toBeNull();
    expect(storageHelper.getServerConfig()).toBeNull();
  });

  // SECURITY: the refresh can take up to 20s. If the user switches accounts (or
  // logs out) while it is in flight, the refreshed pair — built from the OLD
  // session — must be DISCARDED, not written over the new session's config.
  it("discards a refreshed pair when the stored config switched to a DIFFERENT user mid-refresh", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "r1",
      userId: "u1",
    });
    useUserStore.setState({
      serverConnectionConfig: { address: "http://abs.local", token: "u2-tok", userId: "u2" },
    } as any);
    const setSpy = jest.spyOn(storageHelper, "setServerConfig");
    // The refresh resolves AFTER account u2 switched in: the stored config now
    // belongs to a different user than the one this refresh was built for.
    postSpy.mockImplementation(async () => {
      storageHelper.setServerConfig({
        address: "http://abs.local",
        token: "u2-tok",
        refreshToken: "u2-refresh",
        userId: "u2",
      });
      return { status: 200, data: { user: { accessToken: "fresh", refreshToken: "r2" } } };
    });

    await responseHandler.rejected(make401());

    // u1's refreshed pair must NOT have overwritten u2's stored config.
    const stored = storageHelper.getServerConfig();
    expect(stored).toMatchObject({ userId: "u2", token: "u2-tok" });
    expect(setSpy).not.toHaveBeenCalledWith(expect.objectContaining({ token: "fresh" }));
    // No user-store update with the discarded pair.
    expect(useUserStore.getState().serverConnectionConfig).toMatchObject({ userId: "u2" });
    expect(useUserStore.getState().serverConnectionConfig.token).not.toBe("fresh");
    // No auto_creds mirror write carrying the discarded token.
    const freshMirrorWrites = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls.filter((c) =>
      String(c[1]).includes('"token":"fresh"')
    );
    expect(freshMirrorWrites).toHaveLength(0);
    setSpy.mockRestore();
  });

  it("discards a refreshed pair when the stored config was CLEARED (logout) mid-refresh", async () => {
    storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "stale",
      refreshToken: "r1",
      userId: "u1",
    });
    const setSpy = jest.spyOn(storageHelper, "setServerConfig");
    // Logout clears the stored session while the refresh is in flight.
    postSpy.mockImplementation(async () => {
      storageHelper.clearServerConfig();
      return { status: 200, data: { user: { accessToken: "fresh", refreshToken: "r2" } } };
    });

    await responseHandler.rejected(make401());

    // The logged-out session must not be resurrected by the stale refresh.
    expect(storageHelper.getServerConfig()).toBeNull();
    expect(setSpy).not.toHaveBeenCalledWith(expect.objectContaining({ token: "fresh" }));
    const freshMirrorWrites = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls.filter((c) =>
      String(c[1]).includes('"token":"fresh"')
    );
    expect(freshMirrorWrites).toHaveLength(0);
    setSpy.mockRestore();
  });

  // REGRESSION (A2): an in-place updateServerAddress (same account) can land
  // while a refresh is in flight, so the captured config's address no longer
  // matches the current one. The identity guard keys on userId ONLY, so the
  // freshly-rotated (and soon-ONLY-valid) pair is applied — onto the NEW
  // address — instead of being thrown away.
  it("tolerates an address change mid-refresh: applies the rotated pair on the NEW address (same user)", async () => {
    storageHelper.setServerConfig({
      address: "http://old.local",
      token: "stale",
      refreshToken: "r1",
      userId: "u1",
    });
    useUserStore.setState({
      serverConnectionConfig: { address: "http://old.local", token: "stale", userId: "u1" },
    } as any);
    // The refresh resolves AFTER the address moved (same account) — its config
    // was built from the OLD address.
    postSpy.mockImplementation(async () => {
      storageHelper.setServerConfig({
        address: "http://new.local",
        token: "stale",
        refreshToken: "r1",
        userId: "u1",
      });
      return { status: 200, data: { user: { accessToken: "fresh", refreshToken: "r2" } } };
    });

    await responseHandler.rejected(make401());

    const stored = storageHelper.getServerConfig();
    // The rotated pair was NOT discarded...
    expect(stored).toMatchObject({ token: "fresh", refreshToken: "r2", userId: "u1" });
    // ...and the NEW address was preserved (not reverted to the captured old one).
    expect(stored.address).toBe("http://new.local");
    expect(useUserStore.getState().serverConnectionConfig).toMatchObject({
      token: "fresh",
      address: "http://new.local",
    });
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

// ---------------------------------------------------------------------------
// "Logged out when the connection to the server drops" — the session must
// survive anything that isn't ABS itself rejecting the refresh token.
// ---------------------------------------------------------------------------
describe("session survival", () => {
  const user = { id: "u1" };

  it("renews a session that has NO refresh token through the login cookie (pre-fix logins)", async () => {
    // Every username/password login before x-return-tokens: ABS kept the
    // refresh token in an httpOnly cookie, the app stored none, and the first
    // 401 after the 1-hour access token expired forced a logout.
    storageHelper.setServerConfig({ address: "http://abs.local", token: "expired" });
    useUserStore.setState({ user } as any);
    postSpy.mockResolvedValue({
      status: 200,
      data: { user: { accessToken: "fresh", refreshToken: null } },
    });

    const res = await responseHandler.rejected(make401());
    expect(res.data).toBe("retried-ok");
    expect(postSpy.mock.calls[0][2].headers["x-refresh-token"]).toBeUndefined();
    expect(storageHelper.getServerConfig()).toMatchObject({ token: "fresh", refreshToken: null });
    expect(useUserStore.getState().user).toEqual(user);
  });

  it("a 401 that ISN'T ABS talking (captive portal / firewall / challenge page) keeps the session", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t", refreshToken: "r1" });
    useUserStore.setState({ user } as any);
    postSpy.mockRejectedValue({ response: { status: 403 }, message: "blocked by proxy" });
    // /ping isn't ABS's `{ success: true }` either — some HTML page.
    getSpy.mockResolvedValue({ status: 200, data: "<html>Access denied</html>" });

    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();
    expect(useUserStore.getState().user).toEqual(user);
    expect(storageHelper.getServerConfig()).toMatchObject({ refreshToken: "r1" });
  });

  it("…and so does one while /ping can't be reached at all", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t", refreshToken: "r1" });
    useUserStore.setState({ user } as any);
    getSpy.mockRejectedValue({ message: "Network Error" });

    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();
    expect(useUserStore.getState().user).toEqual(user);
  });

  it("cookie mode against a pre-2.26 server (no /auth/refresh → 404) is a dead legacy token", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "legacy" });
    useUserStore.setState({ user } as any);
    postSpy.mockRejectedValue({ response: { status: 404 }, message: "Not Found" });

    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();
    expect(useUserStore.getState().user).toBeNull();
  });

  it("…but a 404 from something that isn't ABS (proxy with the upstream down) is not", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "legacy" });
    useUserStore.setState({ user } as any);
    postSpy.mockRejectedValue({ response: { status: 404 }, message: "page not found" });
    getSpy.mockResolvedValue({ status: 404, data: "404 page not found" });

    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();
    expect(useUserStore.getState().user).toEqual(user);
  });

  it("a LOST rotation answer is recovered inside ABS's grace window by the retry ladder", async () => {
    jest.useFakeTimers();
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t", refreshToken: "r1" });
    useUserStore.setState({ user } as any);
    // The refresh reached ABS (which rotated the pair) but the answer never
    // came back — from here the app holds only the PREVIOUS refresh token.
    postSpy.mockRejectedValueOnce({ message: "timeout of 20000ms exceeded" });
    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();
    expect(useUserStore.getState().user).toEqual(user);

    // ABS answers the previous token inside its grace window with the
    // CURRENT pair — the first rung (15s) re-runs the refresh with it.
    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { user: { accessToken: "a2", refreshToken: "r2-current" } },
    });
    await jest.advanceTimersByTimeAsync(15_000);

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[1][2].headers["x-refresh-token"]).toBe("r1");
    expect(storageHelper.getServerConfig()).toMatchObject({ token: "a2", refreshToken: "r2-current" });
  });

  it("the ladder keeps retrying while the link stays down, then stops", async () => {
    jest.useFakeTimers();
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t", refreshToken: "r1" });
    useUserStore.setState({ user } as any);
    postSpy.mockRejectedValue({ message: "Network Error" });
    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();

    // 15s, 60s, 3m, 7m rungs — then the ladder is spent.
    await jest.advanceTimersByTimeAsync(15_000 + 60_000 + 180_000 + 420_000 + 60_000 * 30);
    expect(postSpy).toHaveBeenCalledTimes(1 + 4);
    expect(useUserStore.getState().user).toEqual(user);
  });

  it("foreground / connectivity-regained finish an unresolved refresh (JS timers stall in background)", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "t", refreshToken: "r1" });
    useUserStore.setState({ user } as any);
    postSpy.mockRejectedValueOnce({ message: "Network Error" });
    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { user: { accessToken: "a2", refreshToken: "r2" } },
    });
    await expect(recoverSessionIfNeeded("foreground")).resolves.toBe(true);
    expect(storageHelper.getServerConfig()).toMatchObject({ token: "a2", refreshToken: "r2" });
    // Nothing pending any more.
    await expect(recoverSessionIfNeeded("foreground")).resolves.toBe(false);
  });

  it("recovery is a no-op with nothing pending, and after a logout", async () => {
    await expect(recoverSessionIfNeeded("foreground")).resolves.toBe(false);
    expect(postSpy).not.toHaveBeenCalled();

    storageHelper.setServerConfig({ address: "http://abs.local", token: "t", refreshToken: "r1" });
    postSpy.mockRejectedValueOnce({ message: "Network Error" });
    await expect(responseHandler.rejected(make401())).rejects.toBeTruthy();
    storageHelper.clearServerConfig(); // user logged out meanwhile
    await expect(recoverSessionIfNeeded("connectivity")).resolves.toBe(false);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });
});
