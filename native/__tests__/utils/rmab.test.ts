jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  request: jest.fn(),
}));

import axios from "axios";
import {
  exchangeLoginToken,
  deleteRequest,
  approveRequest,
  resolveRmabUrl,
  getBookdatePreferences,
  updateBookdatePreferences,
  getBookdateLibrary,
  readRmabConfig,
  writeRmabConfig,
  searchBooks,
  searchSeries,
  getSeries,
  searchAuthors,
  getAuthorBooks,
  createRequest,
  listMyRequests,
  getMe,
  clearRmabCaches,
} from "../../utils/rmab";
import { secureStorage } from "../../utils/storage";

const mockedPost = axios.post as jest.Mock;
const mockedGet = axios.get as jest.Mock;
const mockedRequest = axios.request as jest.Mock;

const CONFIG = {
  url: "https://rmab.test",
  accessToken: "acc1",
  refreshToken: "ref1",
  user: { id: "u1", username: "tony" },
};

beforeEach(() => {
  secureStorage.getAllKeys().forEach((k: string) => secureStorage.remove(k));
  mockedPost.mockReset();
  mockedGet.mockReset();
  mockedRequest.mockReset();
});

describe("config persistence", () => {
  it("round-trips through secure storage and rejects partial configs", () => {
    expect(readRmabConfig()).toBeNull();
    writeRmabConfig(CONFIG);
    expect(readRmabConfig()).toEqual(CONFIG);
    writeRmabConfig(null);
    expect(readRmabConfig()).toBeNull();
    // Missing accessToken -> treated as unconfigured.
    secureStorage.set("rmab_config", JSON.stringify({ url: "https://x" }));
    expect(readRmabConfig()).toBeNull();
  });

  it("rejects a JWT config without a refreshToken (401 recovery would be impossible)", () => {
    secureStorage.set("rmab_config", JSON.stringify({ url: "https://x", accessToken: "acc" }));
    expect(readRmabConfig()).toBeNull();
    // An apiToken alongside makes it valid again — that mode never refreshes.
    secureStorage.set(
      "rmab_config",
      JSON.stringify({ url: "https://x", accessToken: "acc", apiToken: "rmab_t" })
    );
    expect(readRmabConfig()).not.toBeNull();
  });
});

describe("exchangeLoginToken", () => {
  it("normalizes the URL, posts the token, and returns the JWT pair", async () => {
    mockedPost.mockResolvedValue({
      data: { accessToken: "a", refreshToken: "r", user: { id: "u1", username: "tony" } },
    });
    const cfg = await exchangeLoginToken("https://rmab.test///", "  tok  ");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://rmab.test/api/auth/token/login",
      { token: "tok" },
      expect.any(Object)
    );
    expect(cfg).toEqual({
      url: "https://rmab.test",
      accessToken: "a",
      refreshToken: "r",
      user: { id: "u1", username: "tony" },
    });
  });

  it("throws when the response lacks tokens (and the static fallback also fails)", async () => {
    mockedPost.mockResolvedValue({ data: { error: "Invalid token" } });
    mockedGet.mockRejectedValue({ response: { status: 401 } });
    await expect(exchangeLoginToken("https://rmab.test", "bad")).rejects.toBeTruthy();
  });
});

describe("authed requests", () => {
  beforeEach(() => writeRmabConfig(CONFIG));

  it("throws when not configured", async () => {
    writeRmabConfig(null);
    await expect(getMe()).rejects.toThrow("not configured");
  });

  it("sends the bearer token", async () => {
    mockedRequest.mockResolvedValue({ data: { user: "me" } });
    await getMe();
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://rmab.test/api/auth/me",
        headers: { Authorization: "Bearer acc1" },
      })
    );
  });

  it("on 401: refreshes the access token, persists it, and retries once", async () => {
    mockedRequest
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce({ data: { results: [] } });
    mockedPost.mockResolvedValue({ data: { success: true, accessToken: "acc2" } });

    await searchBooks("dune");

    expect(mockedPost).toHaveBeenCalledWith(
      "https://rmab.test/api/auth/refresh",
      { refreshToken: "ref1" },
      expect.any(Object)
    );
    // Retry used the fresh token, and the new token was persisted.
    expect(mockedRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { Authorization: "Bearer acc2" } })
    );
    expect(readRmabConfig()?.accessToken).toBe("acc2");
  });

  it("non-401 failures propagate without a refresh attempt", async () => {
    mockedRequest.mockRejectedValue({ response: { status: 500 } });
    await expect(searchBooks("dune")).rejects.toBeTruthy();
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("concurrent 401s share a SINGLE refresh POST (single-flight)", async () => {
    // Both calls 401 on their first attempt, then succeed on retry.
    mockedRequest
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValue({ data: { results: [] } });
    // Refresh resolves a tick later so both 401s land while it is in flight.
    mockedPost.mockImplementation(
      () => new Promise((res) => setTimeout(() => res({ data: { accessToken: "acc2" } }), 0))
    );

    await Promise.all([searchBooks("dune"), searchBooks("hyperion")]);

    const refreshCalls = mockedPost.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/refresh")
    );
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0][1]).toEqual({ refreshToken: "ref1" });
    // Both retries went out with the shared fresh token, which was persisted.
    expect(mockedRequest).toHaveBeenCalledTimes(4);
    expect(mockedRequest.mock.calls.slice(2).map(([c]: any[]) => c.headers)).toEqual([
      { Authorization: "Bearer acc2" },
      { Authorization: "Bearer acc2" },
    ]);
    expect(readRmabConfig()?.accessToken).toBe("acc2");
  });

  it("a refresh AFTER the first completes issues its own POST (no stale sharing)", async () => {
    mockedRequest
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce({ data: { results: [] } })
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce({ data: { results: [] } });
    mockedPost.mockResolvedValue({ data: { accessToken: "acc2" } });

    await searchBooks("dune");
    await searchBooks("hyperion");

    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("a refresh landing AFTER disconnect does not resurrect the dead session", async () => {
    mockedRequest
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValue({ data: { results: [] } });
    // The refresh resolves only after we've disconnected mid-flight.
    let releaseRefresh: (v: any) => void = () => {};
    mockedPost.mockImplementation(() => new Promise((res) => (releaseRefresh = res)));

    const call = searchBooks("dune");
    // Give the 401 + refresh POST a chance to start, then disconnect.
    await new Promise((r) => setTimeout(r, 0));
    writeRmabConfig(null);
    releaseRefresh({ data: { accessToken: "acc2" } });
    await call;

    // The fresh token must NOT be written back over the disconnect.
    expect(readRmabConfig()).toBeNull();
  });

  it("a refresh landing after a RECONNECT to a different server keeps the new config", async () => {
    mockedRequest
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValue({ data: { results: [] } });
    let releaseRefresh: (v: any) => void = () => {};
    mockedPost.mockImplementation(() => new Promise((res) => (releaseRefresh = res)));

    const call = searchBooks("dune");
    await new Promise((r) => setTimeout(r, 0));
    const newCfg = {
      url: "https://other.test",
      accessToken: "other-acc",
      refreshToken: "other-ref",
      user: { id: "u2" },
    };
    writeRmabConfig(newCfg);
    releaseRefresh({ data: { accessToken: "acc2" } });
    await call;

    expect(readRmabConfig()).toEqual(newCfg);
  });
});

describe("endpoint wrappers", () => {
  beforeEach(() => {
    writeRmabConfig(CONFIG);
    mockedRequest.mockResolvedValue({ data: { results: [{ asin: "B01", title: "T" }] } });
  });

  it("searchBooks encodes the query", async () => {
    const out = await searchBooks("dune & spice", 2);
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://rmab.test/api/audiobooks/search?q=dune%20%26%20spice&page=2",
      })
    );
    expect(out).toEqual([{ asin: "B01", title: "T" }]);
  });

  it("series + author lookups hit their endpoints", async () => {
    await searchSeries("Lost Fleet");
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://rmab.test/api/series/search?q=Lost%20Fleet" })
    );
    // Series detail nests books under series.books.
    mockedRequest.mockResolvedValue({ data: { series: { books: [{ asin: "B02" }] } } });
    const detail = await getSeries("B0SERIES01");
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://rmab.test/api/series/B0SERIES01?page=1" })
    );
    expect(detail.books).toEqual([{ asin: "B02" }]);

    await searchAuthors("Jack Campbell");
    expect(mockedRequest).toHaveBeenCalledWith(
      // authors/search takes `name`, not `q`
      expect.objectContaining({ url: "https://rmab.test/api/authors/search?name=Jack%20Campbell" })
    );
    await getAuthorBooks("B0AUTH01");
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://rmab.test/api/authors/B0AUTH01/books" })
    );
  });

  it("createRequest sends only the metadata RMAB expects", async () => {
    mockedRequest.mockResolvedValue({ data: { id: "req1" } });
    await createRequest({
      asin: "B01",
      title: "Dune",
      author: "Frank Herbert",
      narrator: "Scott Brick",
      description: "Spice",
      coverArtUrl: "https://img/x.jpg",
      isAvailable: false,
      extraJunk: "should not be sent",
    } as any);
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "post",
        url: "https://rmab.test/api/requests",
        data: {
          audiobook: {
            asin: "B01",
            title: "Dune",
            author: "Frank Herbert",
            narrator: "Scott Brick",
            description: "Spice",
            coverArtUrl: "https://img/x.jpg",
          },
        },
      })
    );
  });

  it("createRequest defaults a missing author to Unknown (RMAB requires one) but keeps a real author", async () => {
    mockedRequest.mockResolvedValue({ data: { id: "req1" } });
    // Audible catalog rows legitimately omit authors (anthologies, older
    // titles) — undefined here was a guaranteed 400.
    await createRequest({ asin: "B02", title: "Anthology of Unknowns" } as any);
    expect(mockedRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { audiobook: expect.objectContaining({ asin: "B02", author: "Unknown" }) },
      })
    );
    // A real author passes through untouched.
    await createRequest({ asin: "B03", title: "Dune", author: "Frank Herbert" } as any);
    expect(mockedRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { audiobook: expect.objectContaining({ author: "Frank Herbert" }) },
      })
    );
  });

  it("resolveRmabUrl absolutizes server-relative cover paths", () => {
    expect(resolveRmabUrl("/api/cache/thumbnails/x.jpg")).toBe(
      "https://rmab.test/api/cache/thumbnails/x.jpg"
    );
    expect(resolveRmabUrl("https://img.audible.com/x.jpg")).toBe("https://img.audible.com/x.jpg");
    expect(resolveRmabUrl(null)).toBeUndefined();
  });

  it("listMyRequests unwraps either results or requests arrays", async () => {
    mockedRequest.mockResolvedValue({ data: { requests: [{ id: 1 }] } });
    expect(await listMyRequests()).toEqual([{ id: 1 }]);
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://rmab.test/api/requests?take=100" })
    );
  });

  it("bookdate preferences round-trip PUT with the expected payload", async () => {
    mockedRequest.mockResolvedValue({ data: { libraryScope: "full", favoriteBookIds: [], customPrompt: "" } });
    await getBookdatePreferences();
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "get", url: "https://rmab.test/api/bookdate/preferences" })
    );
    mockedRequest.mockResolvedValue({ data: { success: true } });
    await updateBookdatePreferences({ libraryScope: "favorites", favoriteBookIds: ["b1"], customPrompt: "fun narrators" });
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "put",
        url: "https://rmab.test/api/bookdate/preferences",
        data: { libraryScope: "favorites", favoriteBookIds: ["b1"], customPrompt: "fun narrators" },
      })
    );
  });

  it("getBookdateLibrary unwraps the books array", async () => {
    mockedRequest.mockResolvedValue({ data: { books: [{ id: "b1", title: "T" }] } });
    expect(await getBookdateLibrary()).toEqual([{ id: "b1", title: "T" }]);
  });

  it("deleteRequest issues DELETE on the request", async () => {
    mockedRequest.mockResolvedValue({ data: { success: true } });
    await deleteRequest("req9");
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "delete", url: "https://rmab.test/api/requests/req9" })
    );
  });

  it("approveRequest posts the action to the admin endpoint", async () => {
    mockedRequest.mockResolvedValue({ data: { success: true } });
    await approveRequest("req9", "approve");
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "post",
        url: "https://rmab.test/api/admin/requests/req9/approve",
        data: { action: "approve" },
      })
    );
    await approveRequest("req9", "deny");
    expect(mockedRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { action: "deny" } })
    );
  });
});

describe("token-kind resolution (both kinds share the rmab_ prefix)", () => {
  it("preferApiToken: validates via /api/auth/me first, no exchange attempt on success", async () => {
    mockedGet.mockResolvedValue({ data: { user: { id: "u1", username: "tony" } } });
    const cfg = await exchangeLoginToken("https://rmab.test/", " rmab_abc123 ", { preferApiToken: true });
    expect(mockedGet).toHaveBeenCalledWith(
      "https://rmab.test/api/auth/me",
      expect.objectContaining({ headers: { Authorization: "Bearer rmab_abc123" } })
    );
    expect(mockedPost).not.toHaveBeenCalled();
    expect(cfg).toEqual({
      url: "https://rmab.test",
      apiToken: "rmab_abc123",
      user: { id: "u1", username: "tony" },
    });
  });

  it("an rmab_ LOGIN token (from a login URL) exchanges to a JWT despite the prefix", async () => {
    mockedPost.mockResolvedValue({
      data: { accessToken: "a", refreshToken: "r", user: { id: "u1" } },
    });
    const cfg = await exchangeLoginToken("https://rmab.test", "rmab_logintoken", {});
    expect(mockedPost).toHaveBeenCalledWith(
      "https://rmab.test/api/auth/token/login",
      { token: "rmab_logintoken" },
      expect.any(Object)
    );
    expect(cfg.accessToken).toBe("a");
    expect(cfg.apiToken).toBeUndefined();
  });

  it("falls back to the other interpretation when the first is auth-rejected", async () => {
    // Exchange 401s (it's actually an API token) -> static validation succeeds.
    mockedPost.mockRejectedValue({ response: { status: 401 } });
    mockedGet.mockResolvedValue({ data: { user: { id: "u1" } } });
    const cfg = await exchangeLoginToken("https://rmab.test", "rmab_static");
    expect(cfg.apiToken).toBe("rmab_static");

    // And the reverse: static 401s (it's a login token) -> exchange succeeds.
    mockedGet.mockRejectedValue({ response: { status: 401 } });
    mockedPost.mockResolvedValue({
      data: { accessToken: "a", refreshToken: "r", user: null },
    });
    const cfg2 = await exchangeLoginToken("https://rmab.test", "rmab_login", { preferApiToken: true });
    expect(cfg2.accessToken).toBe("a");
  });

  it("non-auth failures (network/5xx) do NOT trigger the fallback", async () => {
    mockedPost.mockRejectedValue({ response: { status: 500 } });
    await expect(exchangeLoginToken("https://rmab.test", "tok")).rejects.toBeTruthy();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("requests use the static token as bearer and a 401 does NOT try to refresh", async () => {
    writeRmabConfig({ url: "https://rmab.test", apiToken: "rmab_abc123" } as any);
    mockedRequest.mockRejectedValue({ response: { status: 401 } });
    await expect(searchBooks("dune")).rejects.toBeTruthy();
    expect(mockedPost).not.toHaveBeenCalled(); // no /api/auth/refresh attempt

    mockedRequest.mockReset();
    mockedRequest.mockResolvedValue({ data: { results: [] } });
    await searchBooks("dune");
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { Authorization: "Bearer rmab_abc123" } })
    );
  });

  it("an apiToken-only config counts as configured", () => {
    writeRmabConfig({ url: "https://rmab.test", apiToken: "rmab_abc123" } as any);
    expect(readRmabConfig()).toEqual({ url: "https://rmab.test", apiToken: "rmab_abc123" });
  });
});

describe("discovery cache", () => {
  beforeEach(() => {
    writeRmabConfig(CONFIG);
    clearRmabCaches();
    mockedRequest.mockResolvedValue({ data: { results: [] } });
  });

  it("serves repeat lookups from cache within the TTL", async () => {
    await searchSeries("lost fleet");
    await searchSeries("lost fleet");
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("refetches once an entry passes the 15-minute TTL", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000_000);
      await searchSeries("dune");
      nowSpy.mockReturnValue(1_000_000 + 15 * 60 * 1000 + 1);
      await searchSeries("dune");
      expect(mockedRequest).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("caps at 100 entries, evicting the oldest first", async () => {
    for (let i = 0; i < 100; i++) await searchSeries(`q${i}`);
    expect(mockedRequest).toHaveBeenCalledTimes(100);
    // The 101st insert evicts q0 (the oldest)...
    await searchSeries("q100");
    // ...but q1 survives and still serves from cache.
    await searchSeries("q1");
    expect(mockedRequest).toHaveBeenCalledTimes(101);
    // q0 was evicted, so it refetches.
    await searchSeries("q0");
    expect(mockedRequest).toHaveBeenCalledTimes(102);
  });
});
