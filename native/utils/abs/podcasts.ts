/**
 * Podcast administration (search, add, episode downloads, OPML import).
 * Endpoints verified at ISSUE-TEXT + WEB-CLIENT-BEHAVIOR level (issue #56 +
 * observing what the ABS web client sends) — NOT line-by-line against the
 * server source like most other utils/abs modules. The defensive unwrapping
 * below exists because of that weaker verification. The three weakest pins:
 *
 *   1. The request BODY KEYS `rssFeed` (POST /api/podcasts/feed), `opmlText`
 *      (POST /api/podcasts/opml/parse) and `feeds` (POST /api/podcasts/opml/
 *      create) — taken from web-client payloads, not the controller source.
 *   2. The POST /api/podcasts create payload's `media.metadata` NESTING
 *      (metadata + autoDownload* under a `media` key, path/folderId/libraryId
 *      top-level) — mirrored from the web client's add-podcast flow.
 *   3. DELETE /api/podcasts/:id/episode/:episodeId (see deletePodcastEpisode
 *      below) — medium confidence; callers must handle isUnsupportedError.
 *
 * Endpoint surface:
 *   GET    /api/search/podcast?term&country              → provider search results
 *   POST   /api/podcasts/feed                            { rssFeed } → { podcast }
 *   POST   /api/podcasts                                 create podcast library item
 *   POST   /api/podcasts/opml/parse                      { opmlText } → { feeds }
 *   POST   /api/podcasts/opml/create                     { feeds, libraryId, folderId, autoDownloadEpisodes? }
 *   GET    /api/podcasts/:id/checknew?limit              check feed for new episodes
 *   POST   /api/podcasts/:id/download-episodes           BARE ARRAY body of episodes
 *   GET    /api/podcasts/:id/downloads                   episode download queue
 *   GET    /api/podcasts/:id/clear-queue                 (side-effecting GET!)
 *   GET    /api/libraries/:id/episode-downloads          library-wide download queue
 *   DELETE /api/podcasts/:id/episode/:episodeId?hard=1   remove/delete an episode
 *
 * All functions THROW AbsError (see utils/abs/errors.ts).
 */
import { api } from "../api";
import { absRequest } from "./errors";
import type {
  AbsCreatePodcastPayload,
  AbsEpisodeDownload,
  AbsOpmlFeed,
  AbsPodcastFeed,
  AbsPodcastSearchResult,
} from "./types";

/**
 * Provider podcast search (iTunes by default on the server). Tolerates both a
 * bare array response and a { results } wrapper; anything else → [].
 */
export async function searchPodcasts(
  term: string,
  country?: string
): Promise<AbsPodcastSearchResult[]> {
  const data = await absRequest<any>(() =>
    api.get("/api/search/podcast", { params: { term, ...(country ? { country } : {}) } })
  );
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

/**
 * Fetch + parse an RSS feed on the server. The `rssFeed` body key is one of
 * this module's weakest pins (see header). Tolerates both { podcast } and a
 * bare podcast-feed body.
 */
export async function getPodcastFeed(rssFeedUrl: string): Promise<AbsPodcastFeed> {
  const data = await absRequest<any>(() =>
    api.post("/api/podcasts/feed", { rssFeed: rssFeedUrl })
  );
  return data?.podcast ?? data;
}

/**
 * Create a podcast library item. The payload is sent VERBATIM — callers own
 * the media.metadata nesting (a weak pin, see header).
 */
export async function createPodcast(payload: AbsCreatePodcastPayload): Promise<any> {
  return absRequest(() => api.post("/api/podcasts", payload));
}

/** Parse OPML text into feed entries. Unwraps { feeds }; anything else → []. */
export async function parseOpml(opmlText: string): Promise<AbsOpmlFeed[]> {
  const data = await absRequest<any>(() => api.post("/api/podcasts/opml/parse", { opmlText }));
  return Array.isArray(data?.feeds) ? data.feeds : [];
}

/** Bulk-create podcasts from parsed OPML feeds. */
export async function createPodcastsFromOpml(params: {
  feeds: any[];
  libraryId: string;
  folderId: string;
  autoDownloadEpisodes?: boolean;
}): Promise<any> {
  return absRequest(() => api.post("/api/podcasts/opml/create", params));
}

/** Check the podcast's feed for new episodes (server-side feed refresh). */
export async function checkNewEpisodes(itemId: string, limit?: number): Promise<any> {
  return absRequest(() =>
    api.get(`/api/podcasts/${encodeURIComponent(itemId)}/checknew`, {
      // Send limit whenever it's provided — including 0 (a valid
      // maxNewEpisodesToDownload). A truthiness check would drop 0 and let the
      // server silently fall back to its default.
      params: { ...(typeof limit === "number" ? { limit } : {}) },
    })
  );
}

/**
 * Queue episode downloads. The body is the BARE ARRAY of episode objects, not
 * an { episodes } wrapper — same pattern as me.batchUpdateProgress.
 */
export async function downloadPodcastEpisodes(itemId: string, episodes: any[]): Promise<any> {
  return absRequest(() =>
    api.post(`/api/podcasts/${encodeURIComponent(itemId)}/download-episodes`, episodes)
  );
}

/**
 * Normalize the episode-download-queue response shapes seen in the wild:
 * { downloads }, { queue, currentDownload }, or a bare array.
 */
function normalizeEpisodeDownloads(data: any): {
  queue: AbsEpisodeDownload[];
  currentDownload: AbsEpisodeDownload | null;
} {
  if (Array.isArray(data)) return { queue: data, currentDownload: null };
  if (Array.isArray(data?.downloads)) {
    return { queue: data.downloads, currentDownload: data?.currentDownload ?? null };
  }
  return {
    queue: Array.isArray(data?.queue) ? data.queue : [],
    currentDownload: data?.currentDownload ?? null,
  };
}

/** The podcast's episode download queue (see normalizeEpisodeDownloads). */
export async function getPodcastEpisodeDownloads(itemId: string): Promise<{
  queue: AbsEpisodeDownload[];
  currentDownload: AbsEpisodeDownload | null;
}> {
  const data = await absRequest<any>(() =>
    api.get(`/api/podcasts/${encodeURIComponent(itemId)}/downloads`)
  );
  return normalizeEpisodeDownloads(data);
}

/**
 * Clear the podcast's episode download queue. NOTE: a side-effecting GET —
 * that's the route the server exposes (same wart as GET /api/backups/:id/apply).
 */
export async function clearPodcastDownloadQueue(itemId: string): Promise<any> {
  return absRequest(() =>
    api.get(`/api/podcasts/${encodeURIComponent(itemId)}/clear-queue`)
  );
}

/** The library-wide episode download queue (see normalizeEpisodeDownloads). */
export async function getLibraryEpisodeDownloads(libraryId: string): Promise<{
  queue: AbsEpisodeDownload[];
  currentDownload: AbsEpisodeDownload | null;
}> {
  const data = await absRequest<any>(() =>
    api.get(`/api/libraries/${encodeURIComponent(libraryId)}/episode-downloads`)
  );
  return normalizeEpisodeDownloads(data);
}

/**
 * Remove an episode from the podcast. `hard: true` adds ?hard=1 which also
 * deletes the audio file from disk; without it only the library record goes.
 *
 * WEAKEST PIN in this module (medium confidence — see header): the route and
 * the hard=1 query param are mirrored from web-client behavior only. Callers
 * MUST catch and check isUnsupportedError (a 404 here most likely means the
 * server doesn't route this) and fall back gracefully.
 */
export async function deletePodcastEpisode(
  itemId: string,
  episodeId: string,
  opts?: { hard?: boolean }
): Promise<any> {
  const url = `/api/podcasts/${encodeURIComponent(itemId)}/episode/${encodeURIComponent(
    episodeId
  )}`;
  return absRequest(() => (opts?.hard ? api.delete(url, { params: { hard: 1 } }) : api.delete(url)));
}
