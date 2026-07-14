/**
 * utils/abs/podcasts — method+path+payload pins and the response-shape
 * TOLERANCE this module carries because its verification is issue-text +
 * web-client-behavior level (not server-source-in-hand): every list-shaped
 * response is accepted bare, wrapped, or missing. Plus the throw-AbsError
 * contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import {
  searchPodcasts,
  getPodcastFeed,
  createPodcast,
  parseOpml,
  createPodcastsFromOpml,
  checkNewEpisodes,
  downloadPodcastEpisodes,
  getPodcastEpisodeDownloads,
  clearPodcastDownloadQueue,
  getLibraryEpisodeDownloads,
  deletePodcastEpisode,
} from "../../../utils/abs/podcasts";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  jest.mocked(api.patch).mockReset().mockResolvedValue(ok());
  jest.mocked(api.delete).mockReset().mockResolvedValue(ok());
});

describe("searchPodcasts", () => {
  it("GET /api/search/podcast with term (+country only when given)", async () => {
    await searchPodcasts("serial");
    expect(api.get).toHaveBeenCalledWith("/api/search/podcast", { params: { term: "serial" } });
    await searchPodcasts("serial", "de");
    expect(api.get).toHaveBeenLastCalledWith("/api/search/podcast", {
      params: { term: "serial", country: "de" },
    });
  });

  it("passes a bare array response through", async () => {
    jest.mocked(api.get).mockResolvedValue(ok([{ title: "Serial" }]));
    await expect(searchPodcasts("serial")).resolves.toEqual([{ title: "Serial" }]);
  });

  it("unwraps a { results } wrapper", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ results: [{ title: "Serial" }] }));
    await expect(searchPodcasts("serial")).resolves.toEqual([{ title: "Serial" }]);
  });

  it("returns [] for any non-list shape", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({}));
    await expect(searchPodcasts("serial")).resolves.toEqual([]);
    jest.mocked(api.get).mockResolvedValue(ok(null));
    await expect(searchPodcasts("serial")).resolves.toEqual([]);
  });
});

describe("getPodcastFeed", () => {
  it("POST /api/podcasts/feed with the rssFeed body key, unwraps { podcast }", async () => {
    jest.mocked(api.post).mockResolvedValue(ok({ podcast: { metadata: { title: "P" } } }));
    const res = await getPodcastFeed("https://feed.example/rss");
    expect(api.post).toHaveBeenCalledWith("/api/podcasts/feed", {
      rssFeed: "https://feed.example/rss",
    });
    expect(res).toEqual({ metadata: { title: "P" } });
  });

  it("passes a bare (unwrapped) feed body through", async () => {
    jest.mocked(api.post).mockResolvedValue(ok({ metadata: { title: "P" }, episodes: [] }));
    await expect(getPodcastFeed("https://feed.example/rss")).resolves.toEqual({
      metadata: { title: "P" },
      episodes: [],
    });
  });
});

describe("createPodcast", () => {
  it("POST /api/podcasts with the payload verbatim (media nesting untouched)", async () => {
    const payload = {
      path: "/pods/serial",
      folderId: "fol1",
      libraryId: "lib1",
      media: { metadata: { title: "Serial" }, autoDownloadEpisodes: true },
    };
    await createPodcast(payload);
    expect(api.post).toHaveBeenCalledWith("/api/podcasts", payload);
  });
});

describe("OPML", () => {
  it("parseOpml → POST /api/podcasts/opml/parse { opmlText }, unwraps { feeds }", async () => {
    jest.mocked(api.post).mockResolvedValue(ok({ feeds: [{ feedUrl: "https://f" }] }));
    const res = await parseOpml("<opml/>");
    expect(api.post).toHaveBeenCalledWith("/api/podcasts/opml/parse", { opmlText: "<opml/>" });
    expect(res).toEqual([{ feedUrl: "https://f" }]);
  });

  it("parseOpml defaults to [] when feeds is missing", async () => {
    jest.mocked(api.post).mockResolvedValue(ok({}));
    await expect(parseOpml("<opml/>")).resolves.toEqual([]);
  });

  it("createPodcastsFromOpml → POST /api/podcasts/opml/create with the params body", async () => {
    const params = {
      feeds: [{ feedUrl: "https://f" }],
      libraryId: "lib1",
      folderId: "fol1",
      autoDownloadEpisodes: true,
    };
    await createPodcastsFromOpml(params);
    expect(api.post).toHaveBeenCalledWith("/api/podcasts/opml/create", params);
  });
});

describe("episode downloads", () => {
  it("checkNewEpisodes → GET /api/podcasts/:id/checknew, limit only when given", async () => {
    await checkNewEpisodes("p1");
    expect(api.get).toHaveBeenCalledWith("/api/podcasts/p1/checknew", { params: {} });
    await checkNewEpisodes("p1", 5);
    expect(api.get).toHaveBeenLastCalledWith("/api/podcasts/p1/checknew", {
      params: { limit: 5 },
    });
  });

  it("downloadPodcastEpisodes → POST with the BARE ARRAY as the body", async () => {
    const episodes = [{ title: "Ep 1" }, { title: "Ep 2" }];
    await downloadPodcastEpisodes("p1", episodes);
    expect(api.post).toHaveBeenCalledWith("/api/podcasts/p1/download-episodes", episodes);
    // The bare array itself, not an { episodes } wrapper.
    expect(Array.isArray(jest.mocked(api.post).mock.calls[0][1])).toBe(true);
  });

  it("encodes ids in paths", async () => {
    await checkNewEpisodes("p 1");
    expect(api.get).toHaveBeenCalledWith("/api/podcasts/p%201/checknew", { params: {} });
  });

  it.each([
    ["{ downloads } wrapper", { downloads: [{ id: "d1" }] }, [{ id: "d1" }], null],
    [
      "{ queue, currentDownload }",
      { queue: [{ id: "d2" }], currentDownload: { id: "d1" } },
      [{ id: "d2" }],
      { id: "d1" },
    ],
    ["bare array", [{ id: "d1" }], [{ id: "d1" }], null],
    ["empty object", {}, [], null],
  ])(
    "getPodcastEpisodeDownloads normalizes %s",
    async (_label, body, queue, currentDownload) => {
      jest.mocked(api.get).mockResolvedValue(ok(body));
      await expect(getPodcastEpisodeDownloads("p1")).resolves.toEqual({ queue, currentDownload });
      expect(api.get).toHaveBeenCalledWith("/api/podcasts/p1/downloads");
    }
  );

  it("getLibraryEpisodeDownloads hits /api/libraries/:id/episode-downloads with the same normalization", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ downloads: [{ id: "d1" }] }));
    await expect(getLibraryEpisodeDownloads("lib1")).resolves.toEqual({
      queue: [{ id: "d1" }],
      currentDownload: null,
    });
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/episode-downloads");

    jest.mocked(api.get).mockResolvedValue(ok([{ id: "d2" }]));
    await expect(getLibraryEpisodeDownloads("lib1")).resolves.toEqual({
      queue: [{ id: "d2" }],
      currentDownload: null,
    });
  });

  it("clearPodcastDownloadQueue → the side-effecting GET /api/podcasts/:id/clear-queue", async () => {
    await clearPodcastDownloadQueue("p1");
    expect(api.get).toHaveBeenCalledWith("/api/podcasts/p1/clear-queue");
  });
});

describe("deletePodcastEpisode", () => {
  it("DELETE /api/podcasts/:id/episode/:episodeId without params by default", async () => {
    await deletePodcastEpisode("p1", "ep1");
    expect(api.delete).toHaveBeenCalledWith("/api/podcasts/p1/episode/ep1");
  });

  it("adds hard=1 params ONLY when opts.hard", async () => {
    await deletePodcastEpisode("p1", "ep1", { hard: true });
    expect(api.delete).toHaveBeenCalledWith("/api/podcasts/p1/episode/ep1", {
      params: { hard: 1 },
    });
    await deletePodcastEpisode("p1", "ep1", { hard: false });
    expect(api.delete).toHaveBeenLastCalledWith("/api/podcasts/p1/episode/ep1");
  });

  it("encodes both ids", async () => {
    await deletePodcastEpisode("p 1", "ep/1");
    expect(api.delete).toHaveBeenCalledWith("/api/podcasts/p%201/episode/ep%2F1");
  });
});

describe("error normalization", () => {
  it("403 → forbidden AbsError", async () => {
    jest.mocked(api.post).mockRejectedValue({ response: { status: 403 } });
    const err = await createPodcast({
      path: "/p",
      folderId: "f",
      libraryId: "l",
      media: { metadata: {} },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("forbidden");
  });

  it("no response → offline kind", async () => {
    jest.mocked(api.get).mockRejectedValue(new Error("Network Error"));
    await expect(searchPodcasts("serial")).rejects.toMatchObject({ kind: "offline" });
  });

  it("404 on deletePodcastEpisode (the weakest pin) → unsupported kind for callers to catch", async () => {
    jest.mocked(api.delete).mockRejectedValue({ response: { status: 404 } });
    await expect(deletePodcastEpisode("p1", "ep1")).rejects.toMatchObject({
      kind: "unsupported",
    });
  });
});
