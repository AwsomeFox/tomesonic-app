/**
 * utils/abs/server — backups/logs/caches/settings/tags/genres/api-keys:
 * exact method+path+payload triples (verified against the ABS v2.35.1
 * ApiRouter + controllers), the serverSettings store write-back, and the
 * throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

import { api } from "../../../utils/api";
import { storageHelper } from "../../../utils/storage";
import { useUserStore } from "../../../store/useUserStore";
import {
  getBackups,
  createBackup,
  deleteBackup,
  applyBackup,
  buildBackupDownloadUrl,
  getServerLogs,
  purgeCache,
  purgeItemsCache,
  updateServerSettings,
  getTags,
  renameTag,
  deleteTag,
  getGenres,
  renameGenre,
  deleteGenre,
  getApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
} from "../../../utils/abs/server";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });
const initialState = useUserStore.getState();

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  jest.mocked(api.patch).mockReset().mockResolvedValue(ok());
  jest.mocked(api.delete).mockReset().mockResolvedValue(ok());
  useUserStore.setState(initialState, true);
  storageHelper.clearServerConfig();
});

describe("backups", () => {
  it("getBackups → GET /api/backups (full payload incl. backupLocation)", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ backups: [], backupLocation: "/meta/backups" }));
    await expect(getBackups()).resolves.toEqual({ backups: [], backupLocation: "/meta/backups" });
    expect(api.get).toHaveBeenCalledWith("/api/backups");
  });

  it("createBackup → POST /api/backups", async () => {
    jest.mocked(api.post).mockResolvedValue(ok({ backups: [{ id: "b1" }] }));
    await expect(createBackup()).resolves.toEqual({ backups: [{ id: "b1" }] });
    expect(api.post).toHaveBeenCalledWith("/api/backups");
  });

  it("deleteBackup → DELETE /api/backups/:id", async () => {
    jest.mocked(api.delete).mockResolvedValue(ok({ backups: [] }));
    await expect(deleteBackup("b1")).resolves.toEqual({ backups: [] });
    expect(api.delete).toHaveBeenCalledWith("/api/backups/b1");
  });

  it("applyBackup → GET /api/backups/:id/apply (the side-effecting restore GET)", async () => {
    jest.mocked(api.get).mockResolvedValue(ok());
    await expect(applyBackup("b1")).resolves.toBeUndefined();
    expect(api.get).toHaveBeenCalledWith("/api/backups/b1/apply");
  });

  it("applyBackup with no response rejects as AbsError kind 'offline' (expected mid-restore drop)", async () => {
    // The restore drops every connection, so the common outcome is an axios
    // error WITHOUT a response — the screen relies on the "offline" kind to
    // tell the expected drop apart from a real server refusal.
    jest.mocked(api.get).mockRejectedValue(new Error("Network Error"));
    const err = await applyBackup("b1").catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("offline");
  });

  it("applyBackup 404 is a REAL miss (backup deleted under us) — kind 'unknown' with the gone copy, NOT 'unsupported'", async () => {
    // The default admin-route 404 mapping ("server needs an update") would be
    // wrong here: we just listed this backup, so a 404 means it was rotated
    // away or deleted by another admin.
    jest
      .mocked(api.get)
      .mockRejectedValue(Object.assign(new Error("HTTP 404"), { response: { status: 404 } }));
    const err = await applyBackup("b1").catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("unknown");
    expect(err.message).toBe("That backup no longer exists on the server.");
  });

  it("buildBackupDownloadUrl builds the tokened URL / null without a session", () => {
    expect(buildBackupDownloadUrl("b1")).toBeNull();
    storageHelper.setServerConfig({ address: "https://abs.example.com/", token: "tok" });
    expect(buildBackupDownloadUrl("b1")).toBe(
      "https://abs.example.com/api/backups/b1/download?token=tok"
    );
  });
});

describe("logs", () => {
  it("getServerLogs → GET /api/logger-data, unwraps currentDailyLogs (the ONLY REST log surface — live logs are socket-only)", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ currentDailyLogs: [{ message: "hi" }] }));
    await expect(getServerLogs()).resolves.toEqual([{ message: "hi" }]);
    expect(api.get).toHaveBeenCalledWith("/api/logger-data");
  });

  it("tolerates a degenerate body", async () => {
    jest.mocked(api.get).mockResolvedValue(ok(null));
    await expect(getServerLogs()).resolves.toEqual([]);
  });
});

describe("caches", () => {
  it("purgeCache → POST /api/cache/purge", async () => {
    await purgeCache();
    expect(api.post).toHaveBeenCalledWith("/api/cache/purge");
  });

  it("purgeItemsCache → POST /api/cache/items/purge", async () => {
    await purgeItemsCache();
    expect(api.post).toHaveBeenCalledWith("/api/cache/items/purge");
  });
});

describe("updateServerSettings", () => {
  it("PATCHes /api/settings and writes the echoed serverSettings into useUserStore", async () => {
    jest
      .mocked(api.patch)
      .mockResolvedValue(ok({ serverSettings: { version: "2.30.1", scannerParseSubtitle: true } }));
    const result = await updateServerSettings({ scannerParseSubtitle: true });
    expect(api.patch).toHaveBeenCalledWith("/api/settings", { scannerParseSubtitle: true });
    expect(result).toEqual({ version: "2.30.1", scannerParseSubtitle: true });
    expect(useUserStore.getState().serverSettings).toEqual({
      version: "2.30.1",
      scannerParseSubtitle: true,
    });
  });

  it("leaves the store untouched on a degenerate response", async () => {
    useUserStore.setState({ serverSettings: { version: "2.20.0" } });
    jest.mocked(api.patch).mockResolvedValue(ok({}));
    await expect(updateServerSettings({ x: 1 })).resolves.toBeNull();
    expect(useUserStore.getState().serverSettings).toEqual({ version: "2.20.0" });
  });

  it("throws AbsError (store untouched) on rejection", async () => {
    useUserStore.setState({ serverSettings: { version: "2.20.0" } });
    jest.mocked(api.patch).mockRejectedValue({ response: { status: 403 } });
    await expect(updateServerSettings({ x: 1 })).rejects.toMatchObject({ kind: "forbidden" });
    expect(useUserStore.getState().serverSettings).toEqual({ version: "2.20.0" });
  });
});

describe("tags & genres", () => {
  it("getTags → GET /api/tags, unwraps { tags }", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ tags: ["a", "b"] }));
    await expect(getTags()).resolves.toEqual(["a", "b"]);
    expect(api.get).toHaveBeenCalledWith("/api/tags");
  });

  it("renameTag → POST /api/tags/rename { tag, newTag }", async () => {
    await renameTag("Sci-Fi", "Science Fiction");
    expect(api.post).toHaveBeenCalledWith("/api/tags/rename", {
      tag: "Sci-Fi",
      newTag: "Science Fiction",
    });
  });

  it("deleteTag → DELETE /api/tags/:tag with URI encoding (tags can contain slashes/spaces)", async () => {
    await deleteTag("Sci-Fi / Fantasy");
    expect(api.delete).toHaveBeenCalledWith(`/api/tags/${encodeURIComponent("Sci-Fi / Fantasy")}`);
  });

  it("getGenres → GET /api/genres, unwraps { genres }", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ genres: ["Horror"] }));
    await expect(getGenres()).resolves.toEqual(["Horror"]);
    expect(api.get).toHaveBeenCalledWith("/api/genres");
  });

  it("renameGenre → POST /api/genres/rename { genre, newGenre }", async () => {
    await renameGenre("Horror", "Gothic Horror");
    expect(api.post).toHaveBeenCalledWith("/api/genres/rename", {
      genre: "Horror",
      newGenre: "Gothic Horror",
    });
  });

  it("deleteGenre → DELETE /api/genres/:genre with URI encoding", async () => {
    await deleteGenre("True Crime");
    expect(api.delete).toHaveBeenCalledWith(`/api/genres/${encodeURIComponent("True Crime")}`);
  });
});

describe("api keys", () => {
  it("getApiKeys → GET /api/api-keys, unwraps { apiKeys }", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ apiKeys: [{ id: "k1" }] }));
    await expect(getApiKeys()).resolves.toEqual([{ id: "k1" }]);
    expect(api.get).toHaveBeenCalledWith("/api/api-keys");
  });

  it("createApiKey → POST /api/api-keys, unwraps { apiKey } (token only appears here)", async () => {
    jest
      .mocked(api.post)
      .mockResolvedValue(ok({ apiKey: { id: "k1", apiKey: "secret-jwt", name: "CI" } }));
    const res = await createApiKey({ name: "CI", userId: "u1", expiresIn: 3600, isActive: true });
    expect(api.post).toHaveBeenCalledWith("/api/api-keys", {
      name: "CI",
      userId: "u1",
      expiresIn: 3600,
      isActive: true,
    });
    expect(res.apiKey).toBe("secret-jwt");
  });

  it("updateApiKey → PATCH /api/api-keys/:id (only isActive/userId are server-updatable)", async () => {
    jest.mocked(api.patch).mockResolvedValue(ok({ apiKey: { id: "k1", isActive: false } }));
    await expect(updateApiKey("k1", { isActive: false })).resolves.toEqual({
      id: "k1",
      isActive: false,
    });
    expect(api.patch).toHaveBeenCalledWith("/api/api-keys/k1", { isActive: false });
  });

  it("deleteApiKey → DELETE /api/api-keys/:id", async () => {
    await deleteApiKey("k1");
    expect(api.delete).toHaveBeenCalledWith("/api/api-keys/k1");
  });

  it("a 404 from an old server (pre-2.26) surfaces as unsupported", async () => {
    jest.mocked(api.get).mockRejectedValue({ response: { status: 404 } });
    const err = await getApiKeys().catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("unsupported");
  });
});
