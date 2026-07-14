/**
 * utils/abs/notifications — exact method+path+payload triples (docs-level
 * verification, see the module header), the defensive settings unwrap (both
 * { settings } and flat shapes, notifications always an array), the
 * full-object PATCH contract, and the throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import { getNotificationSettings, updateNotification } from "../../../utils/abs/notifications";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

const NOTIFICATION = {
  id: "notif1",
  libraryId: null,
  eventName: "onPodcastEpisodeDownloaded",
  urls: ["apprises://host/key"],
  titleTemplate: "New episode",
  bodyTemplate: "{episodeTitle}",
  enabled: true,
  type: "info",
  lastFiredAt: 1700000000000,
  lastAttemptFailed: false,
  numConsecutiveFailedAttempts: 0,
  createdAt: 1690000000000,
};

const SETTINGS = {
  id: "notification-settings",
  appriseType: "api",
  appriseApiUrl: "https://apprise.example.com",
  notifications: [NOTIFICATION],
  maxFailedAttempts: 5,
  maxNotificationQueue: 20,
  notificationDelay: 1000,
};

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.patch).mockReset().mockResolvedValue(ok());
});

describe("getNotificationSettings", () => {
  it("→ GET /api/notifications, unwraps { settings }", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ settings: SETTINGS }));
    await expect(getNotificationSettings()).resolves.toEqual(SETTINGS);
    expect(api.get).toHaveBeenCalledWith("/api/notifications");
  });

  it("accepts a FLAT settings payload (no { settings } wrapper)", async () => {
    jest.mocked(api.get).mockResolvedValue(ok(SETTINGS));
    await expect(getNotificationSettings()).resolves.toEqual(SETTINGS);
  });

  it("defaults a missing/non-array notifications list to []", async () => {
    jest.mocked(api.get).mockResolvedValue(
      ok({ settings: { appriseApiUrl: null, notifications: null } })
    );
    await expect(getNotificationSettings()).resolves.toEqual({
      appriseApiUrl: null,
      notifications: [],
    });

    jest.mocked(api.get).mockResolvedValue(ok({ settings: { appriseApiUrl: null } }));
    await expect(getNotificationSettings()).resolves.toEqual({
      appriseApiUrl: null,
      notifications: [],
    });
  });

  it("drops id-less entries from the notifications list (the toggle PATCHes /:id)", async () => {
    jest.mocked(api.get).mockResolvedValue(
      ok({
        settings: {
          appriseApiUrl: null,
          notifications: [NOTIFICATION, { eventName: "onTest" }, null, { id: "" }],
        },
      })
    );
    await expect(getNotificationSettings()).resolves.toEqual({
      appriseApiUrl: null,
      notifications: [NOTIFICATION],
    });
  });
});

describe("updateNotification", () => {
  it("→ PATCH /api/notifications/:id with the FULL notification object", async () => {
    await updateNotification({ ...NOTIFICATION, enabled: false } as any);
    expect(api.patch).toHaveBeenCalledWith("/api/notifications/notif1", {
      ...NOTIFICATION,
      enabled: false,
    });
  });

  it("URI-encodes the notification id in the path", async () => {
    await updateNotification({ ...NOTIFICATION, id: "a b/c" } as any);
    expect(api.patch).toHaveBeenCalledWith(
      "/api/notifications/a%20b%2Fc",
      expect.objectContaining({ id: "a b/c" })
    );
  });
});

describe("error normalization", () => {
  it("non-admin (adminMiddleware 403) → forbidden AbsError", async () => {
    jest.mocked(api.get).mockRejectedValue({ response: { status: 403 } });
    const err = await getNotificationSettings().catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("forbidden");
  });

  it("offline → offline AbsError", async () => {
    jest.mocked(api.patch).mockRejectedValue(new Error("Network Error"));
    await expect(updateNotification(NOTIFICATION as any)).rejects.toMatchObject({
      kind: "offline",
    });
  });

  it("404 (older server without the route) → unsupported AbsError", async () => {
    jest.mocked(api.get).mockRejectedValue({ response: { status: 404 } });
    await expect(getNotificationSettings()).rejects.toMatchObject({ kind: "unsupported" });
  });
});
