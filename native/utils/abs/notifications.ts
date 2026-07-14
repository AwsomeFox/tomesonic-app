/**
 * Apprise notification administration. Endpoints verified at DOCS level (the
 * published ABS openapi spec + web dashboard behavior) — NOT line-by-line
 * against the server source like the other utils/abs modules; the defensive
 * unwrapping below exists because of that weaker verification:
 *   GET   /api/notifications        → { data?, settings } (admin-gated)
 *   PATCH /api/notifications/:id    update one notification
 *
 * Conservative v1 surface: list + per-notification enabled toggle ONLY.
 * Creating/deleting notifications and editing the Apprise settings stay on the
 * Audiobookshelf web dashboard.
 *
 * All functions THROW AbsError (see utils/abs/errors.ts).
 */
import { api } from "../api";
import { absRequest } from "./errors";
import type { AbsNotification, AbsNotificationSettings } from "./types";

export async function getNotificationSettings(): Promise<AbsNotificationSettings> {
  const data = await absRequest<any>(() => api.get("/api/notifications"));
  // Docs show { settings } alongside event `data`; some payload dumps show the
  // settings object flat — accept both, and never return a missing list.
  const settings = data?.settings ?? data;
  return {
    ...settings,
    // Keep only entries with a real id — the toggle PATCHes /:id, so an
    // id-less entry would render a row whose write can never land.
    notifications: Array.isArray(settings?.notifications)
      ? settings.notifications.filter((n: any) => n?.id)
      : [],
  };
}

/**
 * Update one notification. Whether the server treats the PATCH body as a
 * partial or a full replacement is unverified — sending the FULL object is
 * superset-safe under both semantics, so callers must pass the whole
 * notification (e.g. `{ ...n, enabled: next }`), never a bare fragment.
 */
export async function updateNotification(notification: AbsNotification): Promise<any> {
  return absRequest(() =>
    api.patch(`/api/notifications/${encodeURIComponent(notification.id)}`, notification)
  );
}
