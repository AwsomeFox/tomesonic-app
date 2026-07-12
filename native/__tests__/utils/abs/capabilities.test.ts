/**
 * utils/abs/capabilities — role/permission matrix, meetsVersion edges, and
 * the refreshCapabilities store wiring (incl. the stale-session guard).
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
import { useUserStore } from "../../../store/useUserStore";
import {
  MIN_VERSION_API_KEYS,
  MIN_VERSION_SHARE_LINKS,
  meetsVersion,
  getCapabilities,
  getServerSettings,
  refreshCapabilities,
} from "../../../utils/abs/capabilities";

const initialState = useUserStore.getState();

const NO_PERMS = {
  download: false,
  update: false,
  delete: false,
  upload: false,
  accessAllLibraries: true,
  accessAllTags: true,
  accessExplicitContent: false,
};

function seed(user: any, serverSettings: any = null, config: any = { token: "tok" }) {
  useUserStore.setState({ user, serverSettings, serverConnectionConfig: config });
}

beforeEach(() => {
  jest.mocked(api.post).mockReset();
  useUserStore.setState(initialState, true);
});

describe("meetsVersion", () => {
  it.each([
    ["2.26.0", "2.26.0", true], // equal
    ["2.26.0", "2.26.1", true],
    ["2.26.0", "2.27.0", true],
    ["2.26.0", "3.0.0", true],
    ["2.26.0", "2.25.9", false],
    ["2.10.0", "2.9.0", false],
    ["2.10.0", "2.10", true], // missing patch counts as 0
    ["2.26.0", "v2.26.3", true], // leading v tolerated
    ["2.26.0", "2.26.0-beta.1", true], // prerelease suffix ignored
    ["2.26.0", null, false], // unknown → false
    ["2.26.0", undefined, false],
    ["2.26.0", "", false],
    ["2.26.0", "garbage", false],
    ["2.26.0", "2.x.0", false],
  ] as const)("min %s vs version %s → %s", (min, version, expected) => {
    expect(meetsVersion(min, version as any)).toBe(expected);
  });
});

describe("getCapabilities role/permission matrix", () => {
  it("root: everything on", () => {
    seed({ id: "u", type: "root", permissions: NO_PERMS }, { version: "2.30.0" });
    const c = getCapabilities();
    expect(c.isRoot).toBe(true);
    expect(c.isAdmin).toBe(true);
    expect(c.canEditMetadata).toBe(true);
    expect(c.canUploadCover).toBe(true);
    expect(c.canDelete).toBe(true);
    expect(c.canDownload).toBe(true);
    expect(c.canUpload).toBe(true);
  });

  it("admin: admin-implied capabilities without explicit permission flags", () => {
    seed({ id: "u", type: "admin", permissions: NO_PERMS });
    const c = getCapabilities();
    expect(c.isRoot).toBe(false);
    expect(c.isAdmin).toBe(true);
    expect(c.canEditMetadata).toBe(true);
    expect(c.canUploadCover).toBe(true);
    expect(c.canDelete).toBe(true);
  });

  it("plain user with no flags: everything off", () => {
    seed({ id: "u", type: "user", permissions: NO_PERMS });
    const c = getCapabilities();
    expect(c.isAdmin).toBe(false);
    expect(c.canEditMetadata).toBe(false);
    expect(c.canUploadCover).toBe(false);
    expect(c.canDelete).toBe(false);
    expect(c.canDownload).toBe(false);
    expect(c.canUpload).toBe(false);
  });

  it("user with update but NOT upload: can edit metadata but canUploadCover stays false", () => {
    // The cover route gates on the `upload` permission server-side — a client
    // that shows the cover picker on `update` alone would just get 403s.
    seed({ id: "u", type: "user", permissions: { ...NO_PERMS, update: true } });
    const c = getCapabilities();
    expect(c.canEditMetadata).toBe(true);
    expect(c.canUploadCover).toBe(false);
  });

  it("user with upload but NOT update: canUploadCover still false (cover changes are metadata edits)", () => {
    seed({ id: "u", type: "user", permissions: { ...NO_PERMS, upload: true } });
    const c = getCapabilities();
    expect(c.canEditMetadata).toBe(false);
    expect(c.canUpload).toBe(true);
    expect(c.canUploadCover).toBe(false);
  });

  it("user with update AND upload: canUploadCover true", () => {
    seed({ id: "u", type: "user", permissions: { ...NO_PERMS, update: true, upload: true } });
    expect(getCapabilities().canUploadCover).toBe(true);
  });

  it("per-flag permissions map for a plain user", () => {
    seed({
      id: "u",
      type: "user",
      permissions: { ...NO_PERMS, download: true, delete: true },
    });
    const c = getCapabilities();
    expect(c.canDownload).toBe(true);
    expect(c.canDelete).toBe(true);
    expect(c.canUpload).toBe(false);
  });

  it("no user (logged out / seed-only session): degrades to nothing", () => {
    seed(null);
    const c = getCapabilities();
    expect(c.isAdmin).toBe(false);
    expect(c.canEditMetadata).toBe(false);
    expect(c.refreshed).toBe(false);
  });

  it("version gates: serverSettings.version drives supportsApiKeys/supportsShareLinks", () => {
    seed({ id: "u", type: "admin", permissions: NO_PERMS }, { version: "2.26.0" });
    let c = getCapabilities();
    expect(c.serverVersion).toBe("2.26.0");
    expect(c.supportsApiKeys).toBe(true);
    expect(c.supportsShareLinks).toBe(true);

    seed({ id: "u", type: "admin", permissions: NO_PERMS }, { version: "2.11.0" });
    c = getCapabilities();
    expect(c.supportsApiKeys).toBe(false);
    expect(c.supportsShareLinks).toBe(true);

    seed({ id: "u", type: "admin", permissions: NO_PERMS }, { version: "2.9.9" });
    c = getCapabilities();
    expect(c.supportsApiKeys).toBe(false);
    expect(c.supportsShareLinks).toBe(false);
  });

  it("falls back to the connect-time config.version when serverSettings is absent", () => {
    seed({ id: "u", type: "admin", permissions: NO_PERMS }, null, {
      token: "tok",
      version: "2.27.0",
    });
    const c = getCapabilities();
    expect(c.serverVersion).toBe("2.27.0");
    expect(c.supportsApiKeys).toBe(true);
    expect(c.refreshed).toBe(false); // version known, but /api/authorize not yet hydrated
  });

  it("unknown version: gated features unsupported", () => {
    seed({ id: "u", type: "root", permissions: NO_PERMS });
    const c = getCapabilities();
    expect(c.serverVersion).toBeNull();
    expect(c.supportsApiKeys).toBe(false);
    expect(c.supportsShareLinks).toBe(false);
  });
});

describe("refreshCapabilities", () => {
  it("POSTs /api/authorize and writes user + serverSettings (+ereaderDevices) into the store", async () => {
    seed({ id: "u1", username: "amy" }, null, { token: "tok", userId: "u1" });
    const fullUser = { id: "u1", username: "amy", type: "admin", permissions: NO_PERMS };
    jest.mocked(api.post).mockResolvedValue({
      data: {
        user: fullUser,
        serverSettings: { version: "2.28.0", scannerParseSubtitle: true },
        ereaderDevices: [{ name: "Kindle", email: "k@x.com" }],
      },
    } as any);

    await refreshCapabilities();

    expect(api.post).toHaveBeenCalledWith("/api/authorize");
    expect(useUserStore.getState().user).toEqual(fullUser);
    expect(useUserStore.getState().serverSettings).toEqual({
      version: "2.28.0",
      scannerParseSubtitle: true,
    });
    expect(useUserStore.getState().ereaderDevices).toEqual([{ name: "Kindle", email: "k@x.com" }]);
    expect(getServerSettings()).toEqual({ version: "2.28.0", scannerParseSubtitle: true });
    expect(getCapabilities().refreshed).toBe(true);
    expect(getCapabilities().isAdmin).toBe(true);
  });

  it("stale-session guard: a response landing after logout/switch is discarded (loadEReaderDevices idiom)", async () => {
    seed({ id: "u1" }, null, { token: "tok-A", userId: "u1" });
    let resolveAuthorize: (v: any) => void;
    jest.mocked(api.post).mockReturnValue(
      new Promise((r) => {
        resolveAuthorize = r;
      }) as any
    );

    const p = refreshCapabilities();
    // Account switch lands while /api/authorize is in flight.
    useUserStore.setState({ serverConnectionConfig: { token: "tok-B", userId: "u2" }, user: { id: "u2" } });
    resolveAuthorize!({
      data: { user: { id: "u1", type: "root" }, serverSettings: { version: "9.9.9" } },
    });
    await p;

    expect(useUserStore.getState().user).toEqual({ id: "u2" });
    expect(useUserStore.getState().serverSettings).toBeNull();
  });

  it("does nothing when there is no session token", async () => {
    seed(null, null, null);
    await refreshCapabilities();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("never throws on failure and leaves state untouched", async () => {
    seed({ id: "u1" }, { version: "2.20.0" }, { token: "tok" });
    jest.mocked(api.post).mockRejectedValue(new Error("offline"));
    await expect(refreshCapabilities()).resolves.toBeUndefined();
    expect(useUserStore.getState().serverSettings).toEqual({ version: "2.20.0" });
  });

  it("ignores a degenerate 200 without a user object", async () => {
    seed({ id: "u1" }, null, { token: "tok" });
    jest.mocked(api.post).mockResolvedValue({ data: "<html>proxy error</html>" } as any);
    await refreshCapabilities();
    expect(useUserStore.getState().user).toEqual({ id: "u1" });
    expect(useUserStore.getState().serverSettings).toBeNull();
  });
});

describe("pinned MIN_VERSION constants", () => {
  it("exports the documented gate versions", () => {
    expect(MIN_VERSION_API_KEYS).toBe("2.26.0");
    expect(MIN_VERSION_SHARE_LINKS).toBe("2.10.0");
  });
});
