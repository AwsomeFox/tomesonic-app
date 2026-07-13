/**
 * ABS ADMIN ENDPOINT CONTRACT.
 *
 * Every admin screen in the app calls the server EXCLUSIVELY through the
 * utils/abs/* domain functions, and those functions encode the exact
 * method+path surface of the Audiobookshelf REST API — verified line-by-line
 * against the ABS v2.35.1 server source (server/routers/ApiRouter.js +
 * controllers), including the easy-to-get-wrong ones:
 *
 *   - matchall is a GET, not a POST;
 *   - the tasks list DOES have a REST route (GET /api/tasks) — the socket is
 *     not the only surface;
 *   - hiding from Continue Listening is the dedicated GET
 *     remove-from-continue-listening route keyed by the media-PROGRESS id;
 *   - batch progress update PATCHes a BARE ARRAY body;
 *   - share links live at /api/share/mediaitem (create/delete only);
 *   - feed-open REQUIRES { serverAddress, slug } in the body;
 *   - the only REST log surface is GET /api/logger-data (live logs are
 *     socket-only);
 *   - narrator ids are encodeURIComponent(base64(name)), not database ids.
 *
 * If a refactor changes any (function → method+path) pairing below, the
 * matching ABS server route must exist for the app to keep working against
 * real servers — this table is the tripwire. Update it ONLY alongside a
 * re-verification against the server source, never to make a refactor pass.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import * as libraries from "../../utils/abs/libraries";
import * as items from "../../utils/abs/items";
import * as users from "../../utils/abs/users";
import * as sessions from "../../utils/abs/sessions";
import * as server from "../../utils/abs/server";
import * as email from "../../utils/abs/email";
import * as feeds from "../../utils/abs/feeds";
import * as me from "../../utils/abs/me";
import * as tasks from "../../utils/abs/tasks";
import * as capabilities from "../../utils/abs/capabilities";

const { fetchTasksOnce, _resetTasksForTest } = tasks;

type Method = "get" | "post" | "patch" | "delete";

/**
 * The frozen surface: function → [method, literal path] (+ optional body
 * pin). Paths use fixed test ids so the literals are greppable against the
 * ABS ApiRouter.
 */
const CONTRACT: Array<{
  name: string;
  invoke: () => Promise<any>;
  method: Method;
  path: string;
  body?: any;
}> = [
  // --- tasks -----------------------------------------------------------
  { name: "fetchTasksOnce", invoke: () => fetchTasksOnce(), method: "get", path: "/api/tasks" },
  // --- capabilities ------------------------------------------------------
  {
    name: "refreshCapabilities",
    invoke: async () => {
      // Needs a session token or it returns without calling the server.
      useUserStore.setState({ serverConnectionConfig: { token: "tok" } as any });
      await capabilities.refreshCapabilities();
    },
    method: "post",
    path: "/api/authorize",
  },
  // --- libraries ---------------------------------------------------------
  { name: "scanLibrary", invoke: () => libraries.scanLibrary("LIB"), method: "post", path: "/api/libraries/LIB/scan" },
  { name: "matchAllLibrary (GET!)", invoke: () => libraries.matchAllLibrary("LIB"), method: "get", path: "/api/libraries/LIB/matchall" },
  { name: "createLibrary", invoke: () => libraries.createLibrary({ name: "x" }), method: "post", path: "/api/libraries" },
  { name: "updateLibrary", invoke: () => libraries.updateLibrary("LIB", { name: "x" }), method: "patch", path: "/api/libraries/LIB" },
  { name: "deleteLibrary", invoke: () => libraries.deleteLibrary("LIB"), method: "delete", path: "/api/libraries/LIB" },
  { name: "getLibraryStats", invoke: () => libraries.getLibraryStats("LIB"), method: "get", path: "/api/libraries/LIB/stats" },
  { name: "getLibraryNarrators", invoke: () => libraries.getLibraryNarrators("LIB"), method: "get", path: "/api/libraries/LIB/narrators" },
  { name: "updateNarrator", invoke: () => libraries.updateNarrator("LIB", "NARR", "New Name"), method: "patch", path: "/api/libraries/LIB/narrators/NARR", body: { name: "New Name" } },
  { name: "getLibraryFilterData", invoke: () => libraries.getLibraryFilterData("LIB"), method: "get", path: "/api/libraries/LIB/filterdata" },
  // --- items ---------------------------------------------------------------
  { name: "updateItemMedia", invoke: () => items.updateItemMedia("ITEM", { tags: [] }), method: "patch", path: "/api/items/ITEM/media", body: { tags: [] } },
  { name: "searchBookMetadata", invoke: () => items.searchBookMetadata({ title: "t" }), method: "get", path: "/api/search/books" },
  { name: "searchCovers", invoke: () => items.searchCovers({ title: "t" }), method: "get", path: "/api/search/covers" },
  { name: "quickMatchItem", invoke: () => items.quickMatchItem("ITEM"), method: "post", path: "/api/items/ITEM/match" },
  { name: "setCoverFromUrl", invoke: () => items.setCoverFromUrl("ITEM", "https://u"), method: "post", path: "/api/items/ITEM/cover", body: { url: "https://u" } },
  { name: "uploadCoverFile", invoke: () => items.uploadCoverFile("ITEM", { uri: "file:///c.jpg" }), method: "post", path: "/api/items/ITEM/cover" },
  { name: "removeCover", invoke: () => items.removeCover("ITEM"), method: "delete", path: "/api/items/ITEM/cover" },
  { name: "updateChapters", invoke: () => items.updateChapters("ITEM", []), method: "post", path: "/api/items/ITEM/chapters", body: { chapters: [] } },
  { name: "searchChaptersByAsin", invoke: () => items.searchChaptersByAsin("ASIN"), method: "get", path: "/api/search/chapters" },
  { name: "encodeM4b", invoke: () => items.encodeM4b("ITEM"), method: "post", path: "/api/tools/item/ITEM/encode-m4b" },
  { name: "cancelEncodeM4b", invoke: () => items.cancelEncodeM4b("ITEM"), method: "delete", path: "/api/tools/item/ITEM/encode-m4b" },
  { name: "embedMetadata", invoke: () => items.embedMetadata("ITEM"), method: "post", path: "/api/tools/item/ITEM/embed-metadata" },
  { name: "createShareLink", invoke: () => items.createShareLink({ slug: "s", mediaItemId: "M", mediaItemType: "book", expiresAt: 0 }), method: "post", path: "/api/share/mediaitem" },
  { name: "deleteShareLink", invoke: () => items.deleteShareLink("SHARE"), method: "delete", path: "/api/share/mediaitem/SHARE" },
  // --- users ---------------------------------------------------------------
  { name: "getUsers", invoke: () => users.getUsers(), method: "get", path: "/api/users" },
  { name: "getUser", invoke: () => users.getUser("USER"), method: "get", path: "/api/users/USER" },
  { name: "createUser", invoke: () => users.createUser({ username: "u", password: "p" }), method: "post", path: "/api/users" },
  { name: "updateUser", invoke: () => users.updateUser("USER", { isActive: false }), method: "patch", path: "/api/users/USER" },
  { name: "deleteUser", invoke: () => users.deleteUser("USER"), method: "delete", path: "/api/users/USER" },
  { name: "getOnlineUsers", invoke: () => users.getOnlineUsers(), method: "get", path: "/api/users/online" },
  { name: "getUserListeningSessions", invoke: () => users.getUserListeningSessions("USER"), method: "get", path: "/api/users/USER/listening-sessions" },
  { name: "getUserListeningStats", invoke: () => users.getUserListeningStats("USER"), method: "get", path: "/api/users/USER/listening-stats" },
  // --- sessions --------------------------------------------------------------
  { name: "getAllSessions", invoke: () => sessions.getAllSessions(), method: "get", path: "/api/sessions" },
  { name: "deleteSession", invoke: () => sessions.deleteSession("SES"), method: "delete", path: "/api/sessions/SES" },
  { name: "batchDeleteSessions", invoke: () => sessions.batchDeleteSessions(["SES"]), method: "post", path: "/api/sessions/batch/delete", body: { sessions: ["SES"] } },
  // --- server ---------------------------------------------------------------
  { name: "getBackups", invoke: () => server.getBackups(), method: "get", path: "/api/backups" },
  { name: "createBackup", invoke: () => server.createBackup(), method: "post", path: "/api/backups" },
  { name: "deleteBackup", invoke: () => server.deleteBackup("BAK"), method: "delete", path: "/api/backups/BAK" },
  { name: "getServerLogs (REST log surface)", invoke: () => server.getServerLogs(), method: "get", path: "/api/logger-data" },
  { name: "purgeCache", invoke: () => server.purgeCache(), method: "post", path: "/api/cache/purge" },
  { name: "purgeItemsCache", invoke: () => server.purgeItemsCache(), method: "post", path: "/api/cache/items/purge" },
  { name: "updateServerSettings", invoke: () => server.updateServerSettings({ x: 1 }), method: "patch", path: "/api/settings", body: { x: 1 } },
  { name: "getTags", invoke: () => server.getTags(), method: "get", path: "/api/tags" },
  { name: "renameTag", invoke: () => server.renameTag("a", "b"), method: "post", path: "/api/tags/rename", body: { tag: "a", newTag: "b" } },
  { name: "deleteTag (URI-encoded)", invoke: () => server.deleteTag("a b"), method: "delete", path: "/api/tags/a%20b" },
  { name: "getGenres", invoke: () => server.getGenres(), method: "get", path: "/api/genres" },
  { name: "renameGenre", invoke: () => server.renameGenre("a", "b"), method: "post", path: "/api/genres/rename", body: { genre: "a", newGenre: "b" } },
  { name: "deleteGenre (URI-encoded)", invoke: () => server.deleteGenre("a b"), method: "delete", path: "/api/genres/a%20b" },
  { name: "getApiKeys", invoke: () => server.getApiKeys(), method: "get", path: "/api/api-keys" },
  { name: "createApiKey", invoke: () => server.createApiKey({ name: "k", userId: "USER" }), method: "post", path: "/api/api-keys" },
  { name: "updateApiKey", invoke: () => server.updateApiKey("KEY", { isActive: false }), method: "patch", path: "/api/api-keys/KEY", body: { isActive: false } },
  { name: "deleteApiKey", invoke: () => server.deleteApiKey("KEY"), method: "delete", path: "/api/api-keys/KEY" },
  // --- email ---------------------------------------------------------------
  { name: "getEmailSettings", invoke: () => email.getEmailSettings(), method: "get", path: "/api/emails/settings" },
  { name: "updateEmailSettings", invoke: () => email.updateEmailSettings({}), method: "patch", path: "/api/emails/settings" },
  { name: "sendTestEmail", invoke: () => email.sendTestEmail(), method: "post", path: "/api/emails/test" },
  { name: "updateAdminEreaderDevices", invoke: () => email.updateAdminEreaderDevices([]), method: "post", path: "/api/emails/ereader-devices", body: { ereaderDevices: [] } },
  // --- feeds ---------------------------------------------------------------
  { name: "getOpenFeeds", invoke: () => feeds.getOpenFeeds(), method: "get", path: "/api/feeds" },
  { name: "openItemFeed (requires serverAddress+slug)", invoke: () => feeds.openItemFeed("ITEM", { serverAddress: "https://a", slug: "s" }), method: "post", path: "/api/feeds/item/ITEM/open", body: { serverAddress: "https://a", slug: "s" } },
  { name: "closeFeed", invoke: () => feeds.closeFeed("FEED"), method: "post", path: "/api/feeds/FEED/close" },
  // --- me ------------------------------------------------------------------
  { name: "hideFromContinueListening (GET by PROGRESS id)", invoke: () => me.hideFromContinueListening("PROG"), method: "get", path: "/api/me/progress/PROG/remove-from-continue-listening" },
  { name: "batchUpdateProgress (bare array body)", invoke: () => me.batchUpdateProgress([{ libraryItemId: "LI" }]), method: "patch", path: "/api/me/progress/batch/update", body: [{ libraryItemId: "LI" }] },
  { name: "getMyItemListeningSessions", invoke: () => me.getMyItemListeningSessions("LI"), method: "get", path: "/api/me/item/listening-sessions/LI" },
  { name: "getMyItemListeningSessions (episode)", invoke: () => me.getMyItemListeningSessions("LI", "EP"), method: "get", path: "/api/me/item/listening-sessions/LI/EP" },
  { name: "createPlaylistFromCollection", invoke: () => me.createPlaylistFromCollection("COL"), method: "post", path: "/api/playlists/collection/COL" },
  { name: "updateMyEreaderDevices", invoke: () => me.updateMyEreaderDevices([]), method: "post", path: "/api/me/ereader-devices", body: { ereaderDevices: [] } },
];

const METHODS: Method[] = ["get", "post", "patch", "delete"];

beforeEach(() => {
  _resetTasksForTest();
  for (const m of METHODS) {
    jest.mocked(api[m]).mockReset().mockResolvedValue({ data: {} } as any);
  }
});

describe("utils/abs endpoint table (fn → method + literal path)", () => {
  it.each(CONTRACT.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    await c.invoke();
    const calls = jest.mocked(api[c.method]).mock.calls.filter(([url]) => url === c.path);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    if (c.body !== undefined) {
      expect(calls[0][1]).toEqual(c.body);
    }
    // The pinned path must not ALSO be hit with a different verb.
    for (const other of METHODS) {
      if (other === c.method) continue;
      const crossCalls = jest
        .mocked(api[other])
        .mock.calls.filter(([url]) => url === c.path);
      expect(crossCalls).toEqual([]);
    }
  });

  it("covers every exported async endpoint function of the domain modules", () => {
    // Tripwire for silent surface growth: a NEW exported function in a domain
    // module must be added to the table above (URL builders + pure helpers
    // are exempt — they never hit the network).
    const exempt = new Set([
      "buildItemZipDownloadUrl",
      "buildBackupDownloadUrl",
      "narratorNameToId",
      // utils/abs/tasks — poller/watch machinery around the one pinned
      // endpoint (fetchTasksOnce ↑); these never issue their own requests
      // outside the shared poll loop.
      "subscribeTasks",
      "getTasksSnapshot",
      "startTaskWatch",
      "_resetTasksForTest",
      // utils/abs/capabilities — pure predicates/store readers around the one
      // pinned endpoint (refreshCapabilities → POST /api/authorize ↑).
      "getCapabilities",
      "useServerCapabilities",
      "getServerSettings",
      "meetsVersion",
      "bumpSettingsWriteSeq",
    ]);
    const exportedFns = [
      libraries,
      items,
      users,
      sessions,
      server,
      email,
      feeds,
      me,
      tasks,
      capabilities,
    ].flatMap((mod) =>
      Object.entries(mod)
        .filter(([name, v]) => typeof v === "function" && !exempt.has(name))
        .map(([name]) => name)
    );
    const pinned = new Set(CONTRACT.map((c) => c.name.split(" ")[0]));
    for (const fn of exportedFns) {
      expect(pinned).toContain(fn);
    }
  });
});
