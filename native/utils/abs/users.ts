/**
 * User administration. Endpoints verified against the ABS v2.35.1
 * ApiRouter/UserController (all admin-and-up; mutations reject non-admins in
 * the controller middleware):
 *   GET    /api/users                      → { users } (?include=latestSession)
 *   GET    /api/users/:id                  → user JSON (includes mediaProgress)
 *   POST   /api/users                      { username, password, ... } → { user }
 *   PATCH  /api/users/:id                  → { success, user }
 *   DELETE /api/users/:id                  → { success }
 *   GET    /api/users/online               → { usersOnline, openSessions }
 *   GET    /api/users/:id/listening-sessions?itemsPerPage&page
 *   GET    /api/users/:id/listening-stats
 *
 * All functions THROW AbsError (see utils/abs/errors.ts).
 */
import { api } from "../api";
import { absRequest } from "./errors";
import type { AbsListeningSession, AbsUser, AbsUserPayload } from "./types";

export async function getUsers(opts?: { includeLatestSession?: boolean }): Promise<AbsUser[]> {
  const data = await absRequest<any>(() =>
    api.get("/api/users", {
      params: opts?.includeLatestSession ? { include: "latestSession" } : undefined,
    })
  );
  return Array.isArray(data?.users) ? data.users : [];
}

export async function getUser(userId: string): Promise<AbsUser> {
  return absRequest<AbsUser>(() => api.get(`/api/users/${userId}`));
}

/** Create a user. username + password are required by the server. */
export async function createUser(payload: AbsUserPayload): Promise<AbsUser> {
  const data = await absRequest<any>(() => api.post("/api/users", payload));
  return data?.user ?? data;
}

export async function updateUser(userId: string, payload: AbsUserPayload): Promise<AbsUser> {
  const data = await absRequest<any>(() => api.patch(`/api/users/${userId}`, payload));
  return data?.user ?? data;
}

export async function deleteUser(userId: string): Promise<void> {
  await absRequest(() => api.delete(`/api/users/${userId}`));
}

/** Currently connected users + their open playback sessions. */
export async function getOnlineUsers(): Promise<{ usersOnline: any[]; openSessions: any[] }> {
  const data = await absRequest<any>(() => api.get("/api/users/online"));
  return {
    usersOnline: Array.isArray(data?.usersOnline) ? data.usersOnline : [],
    openSessions: Array.isArray(data?.openSessions) ? data.openSessions : [],
  };
}

export async function getUserListeningSessions(
  userId: string,
  params?: { itemsPerPage?: number; page?: number }
): Promise<{ total: number; numPages: number; page: number; itemsPerPage: number; sessions: AbsListeningSession[] }> {
  return absRequest(() => api.get(`/api/users/${userId}/listening-sessions`, { params }));
}

export async function getUserListeningStats(userId: string): Promise<any> {
  return absRequest(() => api.get(`/api/users/${userId}/listening-stats`));
}
