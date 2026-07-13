/**
 * utils/abs/feeds — exact method+path+payload triples (verified against the
 * ABS v2.35.1 ApiRouter/RSSFeedController) and the throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import {
  getOpenFeeds,
  openItemFeed,
  openCollectionFeed,
  openSeriesFeed,
  closeFeed,
} from "../../../utils/abs/feeds";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
});

it("getOpenFeeds → GET /api/feeds, unwraps { feeds }", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ feeds: [{ id: "f1" }], minified: [] }));
  await expect(getOpenFeeds()).resolves.toEqual([{ id: "f1" }]);
  expect(api.get).toHaveBeenCalledWith("/api/feeds");
});

it("openItemFeed → POST /api/feeds/item/:itemId/open with the REQUIRED serverAddress+slug body", async () => {
  jest.mocked(api.post).mockResolvedValue(ok({ feed: { id: "my-slug", slug: "my-slug" } }));
  const feed = await openItemFeed("item1", {
    serverAddress: "https://abs.example.com",
    slug: "my-slug",
    metadataDetails: true,
  });
  expect(api.post).toHaveBeenCalledWith("/api/feeds/item/item1/open", {
    serverAddress: "https://abs.example.com",
    slug: "my-slug",
    metadataDetails: true,
  });
  expect(feed).toEqual({ id: "my-slug", slug: "my-slug" });
});

it("openCollectionFeed → POST /api/feeds/collection/:collectionId/open with serverAddress+slug body", async () => {
  jest.mocked(api.post).mockResolvedValue(ok({ feed: { id: "col-slug", slug: "col-slug" } }));
  const feed = await openCollectionFeed("col1", {
    serverAddress: "https://abs.example.com",
    slug: "col-slug",
    metadataDetails: true,
  });
  expect(api.post).toHaveBeenCalledWith("/api/feeds/collection/col1/open", {
    serverAddress: "https://abs.example.com",
    slug: "col-slug",
    metadataDetails: true,
  });
  expect(feed).toEqual({ id: "col-slug", slug: "col-slug" });
});

it("openSeriesFeed → POST /api/feeds/series/:seriesId/open with serverAddress+slug body", async () => {
  jest.mocked(api.post).mockResolvedValue(ok({ feed: { id: "ser-slug", slug: "ser-slug" } }));
  const feed = await openSeriesFeed("ser1", {
    serverAddress: "https://abs.example.com",
    slug: "ser-slug",
  });
  expect(api.post).toHaveBeenCalledWith("/api/feeds/series/ser1/open", {
    serverAddress: "https://abs.example.com",
    slug: "ser-slug",
  });
  expect(feed).toEqual({ id: "ser-slug", slug: "ser-slug" });
});

it("closeFeed → POST /api/feeds/:id/close", async () => {
  await closeFeed("f1");
  expect(api.post).toHaveBeenCalledWith("/api/feeds/f1/close");
});

describe("error normalization", () => {
  it("slug collision (400 + reason) keeps the server text", async () => {
    jest
      .mocked(api.post)
      .mockRejectedValue({ response: { status: 400, data: "Slug already in use" } });
    const err = await openItemFeed("item1", {
      serverAddress: "https://x",
      slug: "dup",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.message).toBe("Slug already in use");
  });

  it("non-admin (controller middleware 403) → forbidden", async () => {
    jest.mocked(api.get).mockRejectedValue({ response: { status: 403 } });
    await expect(getOpenFeeds()).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("offline → offline", async () => {
    jest.mocked(api.post).mockRejectedValue(new Error("Network Error"));
    await expect(closeFeed("f1")).rejects.toMatchObject({ kind: "offline" });
  });
});
