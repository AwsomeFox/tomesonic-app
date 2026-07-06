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

  it("throws when the response lacks tokens", async () => {
    mockedPost.mockResolvedValue({ data: { error: "Invalid token" } });
    await expect(exchangeLoginToken("https://rmab.test", "bad")).rejects.toThrow();
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
    mockedRequest.mockResolvedValue({ data: { books: [{ asin: "B02" }] } });
    const detail = await getSeries("B0SERIES01");
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://rmab.test/api/series/B0SERIES01?page=1" })
    );
    expect(detail.books).toEqual([{ asin: "B02" }]);

    await searchAuthors("Jack Campbell");
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://rmab.test/api/authors/search?q=Jack%20Campbell" })
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

  it("listMyRequests unwraps either results or requests arrays", async () => {
    mockedRequest.mockResolvedValue({ data: { requests: [{ id: 1 }] } });
    expect(await listMyRequests()).toEqual([{ id: 1 }]);
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

describe("static rmab_ API tokens", () => {
  it("exchangeLoginToken validates rmab_ tokens against /api/auth/me instead of exchanging", async () => {
    mockedGet.mockResolvedValue({ data: { user: { id: "u1", username: "tony" } } });
    const cfg = await exchangeLoginToken("https://rmab.test/", " rmab_abc123 ");
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
