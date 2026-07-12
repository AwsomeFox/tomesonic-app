/**
 * Playback-session administration. Endpoints verified against the ABS
 * v2.35.1 ApiRouter/SessionController:
 *   GET    /api/sessions?user=&sort=&desc=1&itemsPerPage=&page=
 *            → { total, numPages, page, itemsPerPage, sessions[, userId] }
 *            (admin; NOTE: non-admin gets a 404, not a 403)
 *   DELETE /api/sessions/:id               (owner or admin)
 *   POST   /api/sessions/batch/delete      { sessions: [uuid, ...] } (admin)
 *
 * All functions THROW AbsError (see utils/abs/errors.ts).
 */
import { api } from "../api";
import { absRequest } from "./errors";
import type { AbsListeningSession } from "./types";

export type SessionsSortKey =
  | "displayTitle"
  | "duration"
  | "playMethod"
  | "startTime"
  | "currentTime"
  | "timeListening"
  | "updatedAt"
  | "createdAt";

export async function getAllSessions(params?: {
  /** Filter by user id (uuid). */
  user?: string;
  sort?: SessionsSortKey;
  desc?: boolean;
  itemsPerPage?: number;
  page?: number;
}): Promise<{
  total: number;
  numPages: number;
  page: number;
  itemsPerPage: number;
  sessions: AbsListeningSession[];
  userId?: string;
}> {
  const { desc, ...rest } = params || {};
  return absRequest(() =>
    api.get("/api/sessions", { params: { ...rest, ...(desc !== undefined ? { desc: desc ? 1 : 0 } : {}) } })
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  await absRequest(() => api.delete(`/api/sessions/${sessionId}`));
}

export async function batchDeleteSessions(sessionIds: string[]): Promise<void> {
  await absRequest(() => api.post("/api/sessions/batch/delete", { sessions: sessionIds }));
}
