/**
 * Current-user (non-admin) actions used by the admin/library screens.
 * Endpoints verified against the ABS v2.35.1 ApiRouter/MeController:
 *   GET   /api/me/progress/:id/remove-from-continue-listening   → updated user JSON
 *   PATCH /api/me/progress/batch/update      body = ARRAY of progress payloads
 *   GET   /api/me/item/listening-sessions/:libraryItemId/:episodeId?
 *   POST  /api/playlists/collection/:collectionId  → created playlist
 *   POST  /api/me/ereader-devices             { ereaderDevices }
 *
 * VERIFIED continue-listening mechanism: hiding an item is the dedicated
 * GET /api/me/progress/:id/remove-from-continue-listening route, keyed by
 * the MEDIA-PROGRESS id (NOT the libraryItemId). The server flips
 * hideFromContinueListening directly in that handler — this is the route the
 * web client uses, so we use it too rather than PATCHing the flag through a
 * progress update.
 *
 * All functions THROW AbsError (see utils/abs/errors.ts for why this
 * contrasts with utils/upNext.ts's swallow-everything approach).
 */
import { api } from "../api";
import { useUserStore } from "../../store/useUserStore";
import { absRequest } from "./errors";
import type { AbsEreaderDevice, AbsListeningSession } from "./types";

/**
 * Hide an item from the Continue Listening shelf. `progressId` is the
 * media-progress row id (user.mediaProgress[].id) — NOT the libraryItemId.
 * Returns the server's updated user JSON.
 */
export async function hideFromContinueListening(progressId: string): Promise<any> {
  return absRequest(() =>
    api.get(`/api/me/progress/${progressId}/remove-from-continue-listening`)
  );
}

/**
 * Batch-update media progress. Each payload is a createUpdateMediaProgress
 * body PLUS its target ids, e.g.
 * { libraryItemId, episodeId?, isFinished?, currentTime?, progress?, ... }.
 * The request body is the bare ARRAY (verified — not wrapped in an object).
 */
export async function batchUpdateProgress(payloads: any[]): Promise<void> {
  await absRequest(() => api.patch("/api/me/progress/batch/update", payloads));
}

/** My listening sessions for one item (paged like the admin sessions list). */
export async function getMyItemListeningSessions(
  libraryItemId: string,
  episodeId?: string
): Promise<{ sessions: AbsListeningSession[]; [key: string]: any }> {
  const path = episodeId
    ? `/api/me/item/listening-sessions/${libraryItemId}/${episodeId}`
    : `/api/me/item/listening-sessions/${libraryItemId}`;
  return absRequest(() => api.get(path));
}

/** Create a playlist mirroring a collection (server copies the books). */
export async function createPlaylistFromCollection(collectionId: string): Promise<any> {
  return absRequest(() => api.post(`/api/playlists/collection/${collectionId}`));
}

/**
 * Replace MY e-reader devices (each must have availabilityOption
 * "specificUsers" with only my user id — the server 400s otherwise). On
 * success, re-fetches the store's ereaderDevices via the same /api/authorize
 * source login/initialize use, so "Send to device" pickers update at once.
 */
export async function updateMyEreaderDevices(devices: AbsEreaderDevice[]): Promise<void> {
  await absRequest(() => api.post("/api/me/ereader-devices", { ereaderDevices: devices }));
  try {
    await useUserStore.getState().loadEReaderDevices();
  } catch {
    // The update itself succeeded; a failed refresh just leaves the old list
    // until the next login/initialize refresh.
  }
}
