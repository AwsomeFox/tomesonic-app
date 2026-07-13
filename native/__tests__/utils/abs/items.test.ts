/**
 * utils/abs/items — exact method+path+payload triples (verified against the
 * ABS v2.35.1 ApiRouter/LibraryItemController/ToolsController/
 * SearchController/ShareController) and the throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import { storageHelper } from "../../../utils/storage";
import {
  updateItemMedia,
  searchBookMetadata,
  searchCovers,
  quickMatchItem,
  setCoverFromUrl,
  uploadCoverFile,
  removeCover,
  updateChapters,
  searchChaptersByAsin,
  encodeM4b,
  cancelEncodeM4b,
  embedMetadata,
  buildItemZipDownloadUrl,
  createShareLink,
  deleteShareLink,
} from "../../../utils/abs/items";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  jest.mocked(api.patch).mockReset().mockResolvedValue(ok());
  jest.mocked(api.delete).mockReset().mockResolvedValue(ok());
  storageHelper.clearServerConfig();
});

describe("metadata + match", () => {
  it("updateItemMedia → PATCH /api/items/:id/media", async () => {
    jest.mocked(api.patch).mockResolvedValue(ok({ updated: true, libraryItem: { id: "i1" } }));
    const res = await updateItemMedia("i1", { metadata: { title: "T" } });
    expect(api.patch).toHaveBeenCalledWith("/api/items/i1/media", { metadata: { title: "T" } });
    expect(res.updated).toBe(true);
  });

  it("searchBookMetadata → GET /api/search/books with params", async () => {
    jest.mocked(api.get).mockResolvedValue(ok([{ title: "Hit" }]));
    const res = await searchBookMetadata({ title: "Dune", author: "Herbert", provider: "audible" });
    expect(api.get).toHaveBeenCalledWith("/api/search/books", {
      params: { title: "Dune", author: "Herbert", provider: "audible" },
    });
    expect(res).toEqual([{ title: "Hit" }]);
  });

  it("searchCovers → GET /api/search/covers, podcast flag becomes podcast=1, unwraps { results }", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ results: ["http://c/1.jpg"] }));
    const res = await searchCovers({ title: "Serial", podcast: true });
    expect(api.get).toHaveBeenCalledWith("/api/search/covers", {
      params: { title: "Serial", podcast: 1 },
    });
    expect(res).toEqual(["http://c/1.jpg"]);
  });

  it("quickMatchItem → POST /api/items/:id/match with options body", async () => {
    await quickMatchItem("i1", { provider: "audible", asin: "B00X", overrideCover: true });
    expect(api.post).toHaveBeenCalledWith("/api/items/i1/match", {
      provider: "audible",
      asin: "B00X",
      overrideCover: true,
    });
  });

  it("quickMatchItem with no options sends an empty object", async () => {
    await quickMatchItem("i1");
    expect(api.post).toHaveBeenCalledWith("/api/items/i1/match", {});
  });
});

describe("covers", () => {
  it("setCoverFromUrl → POST /api/items/:id/cover { url }", async () => {
    await setCoverFromUrl("i1", "https://img/c.jpg");
    expect(api.post).toHaveBeenCalledWith("/api/items/i1/cover", { url: "https://img/c.jpg" });
  });

  it("uploadCoverFile → multipart POST with the `cover` field the server reads", async () => {
    await uploadCoverFile("i1", { uri: "file:///c.png", name: "c.png", type: "image/png" });
    const [url, body, config] = jest.mocked(api.post).mock.calls[0];
    expect(url).toBe("/api/items/i1/cover");
    expect(body).toBeInstanceOf(FormData);
    expect(config).toEqual({ headers: { "Content-Type": "multipart/form-data" } });
  });

  it("removeCover → DELETE /api/items/:id/cover", async () => {
    await removeCover("i1");
    expect(api.delete).toHaveBeenCalledWith("/api/items/i1/cover");
  });
});

describe("chapters", () => {
  it("updateChapters → POST /api/items/:id/chapters { chapters }", async () => {
    const chapters = [{ id: 0, start: 0, end: 10, title: "Ch 1" }];
    await updateChapters("i1", chapters);
    expect(api.post).toHaveBeenCalledWith("/api/items/i1/chapters", { chapters });
  });

  it("searchChaptersByAsin → GET /api/search/chapters?asin&region (default region us)", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ chapters: [] }));
    await searchChaptersByAsin("B00XLJ1D0W");
    expect(api.get).toHaveBeenCalledWith("/api/search/chapters", {
      params: { asin: "B00XLJ1D0W", region: "us" },
    });
  });

  it("searchChaptersByAsin passes the miss body ({ error }) through — the server 200s misses", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ error: "Chapters not found" }));
    await expect(searchChaptersByAsin("B00XLJ1D0W", "de")).resolves.toEqual({
      error: "Chapters not found",
    });
  });
});

describe("tools", () => {
  it("encodeM4b → POST /api/tools/item/:id/encode-m4b with query options", async () => {
    await encodeM4b("i1", { bitrate: "128k" });
    expect(api.post).toHaveBeenCalledWith("/api/tools/item/i1/encode-m4b", undefined, {
      params: { bitrate: "128k" },
    });
  });

  it("cancelEncodeM4b → DELETE /api/tools/item/:id/encode-m4b", async () => {
    await cancelEncodeM4b("i1");
    expect(api.delete).toHaveBeenCalledWith("/api/tools/item/i1/encode-m4b");
  });

  it("embedMetadata → POST /api/tools/item/:id/embed-metadata with flag params as 1", async () => {
    await embedMetadata("i1", { forceEmbedChapters: true, backup: true });
    expect(api.post).toHaveBeenCalledWith("/api/tools/item/i1/embed-metadata", undefined, {
      params: { forceEmbedChapters: 1, backup: 1 },
    });
  });

  it("embedMetadata omits unset flags", async () => {
    await embedMetadata("i1");
    expect(api.post).toHaveBeenCalledWith("/api/tools/item/i1/embed-metadata", undefined, {
      params: {},
    });
  });
});

describe("buildItemZipDownloadUrl", () => {
  it("builds the tokened zip URL from the stored config", () => {
    storageHelper.setServerConfig({ address: "https://abs.example.com/", token: "tok1" });
    expect(buildItemZipDownloadUrl("i1")).toBe(
      "https://abs.example.com/api/items/i1/download?token=tok1"
    );
  });

  it("returns null without a full session (never a token=undefined URL)", () => {
    expect(buildItemZipDownloadUrl("i1")).toBeNull();
    storageHelper.setServerConfig({ address: "https://abs.example.com" });
    expect(buildItemZipDownloadUrl("i1")).toBeNull();
  });
});

describe("share links", () => {
  it("createShareLink → POST /api/share/mediaitem with the verified payload", async () => {
    jest.mocked(api.post).mockResolvedValue(ok({ id: "s1", slug: "my-book" }));
    const res = await createShareLink({
      slug: "my-book",
      mediaItemId: "book-media-id",
      mediaItemType: "book",
      expiresAt: 0,
      isDownloadable: true,
    });
    expect(api.post).toHaveBeenCalledWith("/api/share/mediaitem", {
      slug: "my-book",
      mediaItemId: "book-media-id",
      mediaItemType: "book",
      expiresAt: 0,
      isDownloadable: true,
    });
    expect(res.id).toBe("s1");
  });

  it("deleteShareLink → DELETE /api/share/mediaitem/:id", async () => {
    await deleteShareLink("s1");
    expect(api.delete).toHaveBeenCalledWith("/api/share/mediaitem/s1");
  });
});

describe("error normalization", () => {
  it("updateItemMedia surfaces a 403 as forbidden AbsError", async () => {
    jest.mocked(api.patch).mockRejectedValue({ response: { status: 403 } });
    const err = await updateItemMedia("i1", {}).catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("forbidden");
  });

  it("createShareLink keeps the server's plain-text 400 reason", async () => {
    jest
      .mocked(api.post)
      .mockRejectedValue({ response: { status: 409, data: "Slug is already in use" } });
    const err = await createShareLink({
      slug: "x",
      mediaItemId: "m",
      mediaItemType: "book",
      expiresAt: 0,
    }).catch((e) => e);
    expect(err.message).toBe("Slug is already in use");
  });

  it("offline (no response) → offline kind", async () => {
    jest.mocked(api.post).mockRejectedValue(new Error("Network Error"));
    await expect(encodeM4b("i1")).rejects.toMatchObject({ kind: "offline" });
  });
});
