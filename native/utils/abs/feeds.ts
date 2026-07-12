/**
 * RSS feed administration. Endpoints verified against the ABS v2.35.1
 * ApiRouter/RSSFeedController (ALL feed routes are admin-and-up — the
 * controller middleware rejects non-admins):
 *   GET  /api/feeds                        → { feeds, minified }
 *   POST /api/feeds/item/:itemId/open      { serverAddress, slug, metadataDetails? } → { feed }
 *   POST /api/feeds/:id/close
 *
 * VERIFIED payload details: openRSSFeedForItem REQUIRES both `serverAddress`
 * (the public base URL the feed will be reachable at) and `slug` (which
 * becomes the feed id/URL path) as strings; it 400s otherwise, and 400s when
 * the slug is already in use or the item has no audio tracks.
 *
 * All functions THROW AbsError (see utils/abs/errors.ts).
 */
import { api } from "../api";
import { absRequest } from "./errors";
import type { AbsFeed } from "./types";

export async function getOpenFeeds(): Promise<AbsFeed[]> {
  const data = await absRequest<any>(() => api.get("/api/feeds"));
  return Array.isArray(data?.feeds) ? data.feeds : [];
}

/** Open a public RSS feed for a library item (podcast or audiobook). */
export async function openItemFeed(
  itemId: string,
  params: {
    /** Public base address the feed URL is built on (usually the connect address). */
    serverAddress: string;
    /** URL slug — becomes the feed id; must be unique across open feeds. */
    slug: string;
    /** Include full episode metadata in the feed XML. */
    metadataDetails?: boolean;
  }
): Promise<AbsFeed> {
  const data = await absRequest<any>(() => api.post(`/api/feeds/item/${itemId}/open`, params));
  return data?.feed ?? data;
}

export async function closeFeed(feedId: string): Promise<void> {
  await absRequest(() => api.post(`/api/feeds/${feedId}/close`));
}
