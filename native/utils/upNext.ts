import { api } from "./api";
import { storage, storageHelper } from "./storage";

/**
 * Server-backed mirror of the local "Up Next" playback queue.
 *
 * The local `queue` array in usePlaybackStore stays the SOURCE OF TRUTH for
 * ordering + instant UI (badge counts, de-dupe). This module maintains ONE
 * reserved ABS playlist per library underneath it — best-effort and
 * non-blocking — so the queue persists and syncs across devices.
 *
 * ABS playlist REST API (verified against the server ApiRouter, same shapes
 * used by components/AddToListModal.tsx):
 *   GET    /api/libraries/:libraryId/playlists          -> res.data.results
 *   POST   /api/playlists { libraryId, name, items[] }  -> res.data (created)
 *   POST   /api/playlists/:id/item { libraryItemId, episodeId? }
 *   DELETE /api/playlists/:id/item/:libraryItemId
 *
 * ABS has NO hidden/system flag for playlists, so we identify our reserved
 * list purely by an exact (case-sensitive) name match within the library.
 * "Up Next" mirrors the in-app label the user already sees, so if they open
 * ABS they'll recognise it; the trade-off is that a user who hand-creates a
 * playlist named exactly "Up Next" would share it — acceptable, since that IS
 * conceptually their up-next list. We cache the resolved id per libraryId (in
 * memory + MMKV) to avoid re-scanning the playlist list on every call.
 *
 * IMPORTANT: ABS auto-DELETES a playlist when its last item is removed, so a
 * maintained list can vanish server-side. Every path tolerates that (clears
 * the stale id cache) and lazily re-creates on the next add.
 *
 * Every function is defensive: it swallows network/HTTP errors and never
 * throws to the caller, so the local queue keeps working offline exactly as
 * before.
 */

// Reserved playlist name. Documented above; matched case-sensitive + exact.
export const UP_NEXT_PLAYLIST_NAME = "Up Next";

// A queued book / podcast episode — mirrors QueueItem in usePlaybackStore.
// Re-declared here (rather than imported) to keep this module free of a
// circular dependency on the store.
export interface UpNextItem {
  libraryItemId: string;
  episodeId?: string;
  title?: string;
  author?: string;
  coverUrl?: string;
}

// In-memory id cache: libraryId -> playlist id. Backed by MMKV so it survives
// restarts (and so a cold start doesn't re-scan on the very first add).
const _idCache = new Map<string, string>();

function mmkvKey(libraryId: string): string {
  return `upNextPlaylistId_${libraryId}`;
}

function getCachedId(libraryId: string): string | null {
  const mem = _idCache.get(libraryId);
  if (mem) return mem;
  try {
    const persisted = storage.getString(mmkvKey(libraryId));
    if (persisted) {
      _idCache.set(libraryId, persisted);
      return persisted;
    }
  } catch {}
  return null;
}

function setCachedId(libraryId: string, id: string) {
  _idCache.set(libraryId, id);
  try {
    storage.set(mmkvKey(libraryId), id);
  } catch {}
}

function clearCachedId(libraryId: string) {
  _idCache.delete(libraryId);
  try {
    storage.remove(mmkvKey(libraryId));
  } catch {}
}

// True when an axios error is a 404 (item/playlist already gone — a benign
// outcome for a remove, and the signal that a playlist auto-deleted).
function isNotFound(e: any): boolean {
  return e?.response?.status === 404;
}

function itemMatches(i: any, libraryItemId: string, episodeId?: string): boolean {
  const iId = i?.libraryItemId ?? i?.libraryItem?.id;
  if (iId !== libraryItemId) return false;
  // Match episode too so a podcast's episodes are treated as distinct entries.
  return (i?.episodeId || null) === (episodeId || null);
}

/**
 * Resolve the reserved "Up Next" playlist for a library, creating it (with
 * `firstItem`) if it's missing and a first item was supplied.
 *
 * Returns the playlist object (including its `items`) or null when it can't be
 * resolved/created (offline, no library, missing + no firstItem, etc.). Never
 * throws.
 */
export async function findOrCreateUpNextPlaylist(
  libraryId: string,
  firstItem?: UpNextItem
): Promise<any | null> {
  if (!libraryId) return null;
  try {
    const res = await api.get(`/api/libraries/${libraryId}/playlists`);
    const results: any[] = res?.data?.results || [];
    const existing = results.find((p) => p?.name === UP_NEXT_PLAYLIST_NAME);
    if (existing?.id) {
      setCachedId(libraryId, existing.id);
      return existing;
    }
    // Missing (never created, or auto-deleted when it went empty). Drop any
    // stale id and lazily re-create — but only when we have a first item to
    // seed it with (ABS won't create an empty playlist, and there's nothing
    // to add otherwise).
    clearCachedId(libraryId);
    if (!firstItem?.libraryItemId) return null;
    const created = await api.post(`/api/playlists`, {
      libraryId,
      name: UP_NEXT_PLAYLIST_NAME,
      items: [
        firstItem.episodeId
          ? { libraryItemId: firstItem.libraryItemId, episodeId: firstItem.episodeId }
          : { libraryItemId: firstItem.libraryItemId },
      ],
    });
    if (created?.data?.id) {
      setCachedId(libraryId, created.data.id);
      return created.data;
    }
    return null;
  } catch {
    // Offline / server error — the local queue is unaffected.
    return null;
  }
}

/**
 * Add an item to the server "Up Next" playlist. Find-or-creates the playlist,
 * then POSTs the item unless it's already present. Swallows all errors
 * (offline etc.) — never throws to the caller.
 */
export async function upNextAddItem(libraryId: string, item: UpNextItem): Promise<void> {
  if (!libraryId || !item?.libraryItemId) return;
  try {
    // Passing `item` as firstItem means a freshly-created playlist already
    // contains it (so the presence check below skips the redundant POST).
    const playlist = await findOrCreateUpNextPlaylist(libraryId, item);
    if (!playlist?.id) return;
    const already = (playlist.items || []).some((i: any) =>
      itemMatches(i, item.libraryItemId, item.episodeId)
    );
    if (already) return;
    await api.post(`/api/playlists/${playlist.id}/item`, {
      libraryItemId: item.libraryItemId,
      ...(item.episodeId ? { episodeId: item.episodeId } : {}),
    });
  } catch {
    // Non-fatal — the local queue already reflects the add.
  }
}

/**
 * Remove an item from the server "Up Next" playlist. Tolerates a 404 (item or
 * playlist already gone) and the playlist-auto-deleted case (clears the id
 * cache so the next add re-creates it). Never throws.
 */
export async function upNextRemoveItem(libraryId: string, libraryItemId: string): Promise<void> {
  if (!libraryId || !libraryItemId) return;
  try {
    let id = getCachedId(libraryId);
    if (!id) {
      // No cached id — resolve without creating (we're removing, not adding).
      const playlist = await findOrCreateUpNextPlaylist(libraryId);
      id = playlist?.id || null;
    }
    if (!id) return; // Nothing on the server to remove from.
    await api.delete(`/api/playlists/${id}/item/${libraryItemId}`);
    // ABS deletes the playlist when its last item is removed — if this DELETE
    // emptied it, our cached id is now dead. We can't know from the DELETE
    // response alone, so leave the cache; findOrCreate will self-heal (it
    // clears the id on a subsequent scan miss). A 404 below is handled too.
  } catch (e) {
    if (isNotFound(e)) {
      // Item already gone OR the whole playlist auto-deleted. Drop the id so
      // the next add re-creates it fresh.
      clearCachedId(libraryId);
      return;
    }
    // Other error (offline) — non-fatal, local queue already updated.
  }
}

/**
 * Fetch the server "Up Next" playlist and map its items to UpNextItem[]
 * (libraryItemId, episodeId, title, author, coverUrl). Returns [] when there's
 * no playlist or we're offline. Never throws.
 */
export async function upNextListItems(libraryId: string): Promise<UpNextItem[]> {
  if (!libraryId) return [];
  try {
    const playlist = await findOrCreateUpNextPlaylist(libraryId);
    const items: any[] = playlist?.items || [];
    if (!items.length) return [];
    const cfg = storageHelper.getServerConfig();
    const address: string | undefined = cfg?.address;
    const token: string | undefined = cfg?.token;
    return items
      .map((i): UpNextItem | null => {
        const li = i?.libraryItem || {};
        const libraryItemId: string = i?.libraryItemId || li?.id;
        if (!libraryItemId) return null;
        const meta = li?.media?.metadata || {};
        const episodeId: string | undefined = i?.episodeId || undefined;
        const coverUrl =
          address && token
            ? `${address}/api/items/${libraryItemId}/cover?width=400&format=webp&token=${token}`
            : undefined;
        return {
          libraryItemId,
          ...(episodeId ? { episodeId } : {}),
          title: meta.title || undefined,
          author: meta.authorName || undefined,
          coverUrl,
        };
      })
      .filter((x): x is UpNextItem => !!x);
  } catch {
    return [];
  }
}
