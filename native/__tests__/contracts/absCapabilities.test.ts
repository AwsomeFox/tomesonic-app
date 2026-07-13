/**
 * SERVER-CAPABILITY GATING CONTRACT.
 *
 * Every admin screen decides what to RENDER from utils/abs/capabilities,
 * while the SERVER independently enforces the same rules per-request (403s).
 * If the client matrix ever drifts from the server's — a permission read from
 * the wrong flag, an admin-implied capability dropped, a version gate moved —
 * users either see controls that only produce 403 toasts, or lose controls
 * they're entitled to. This pins the exact client matrix to the server rules
 * verified in the ABS v2.35.1 source:
 *
 *   - `update` permission (or admin) gates metadata edits
 *     (LibraryItemController.middleware PATCH/POST branch);
 *   - the COVER routes additionally gate on `upload`
 *     (LibraryItemController.uploadCover: req.user.canUpload) — so
 *     canUploadCover REQUIRES canEditMetadata AND (admin OR upload);
 *   - delete/download gate on their own flags (or admin);
 *   - /api/api-keys shipped in 2.26.0 and /api/share/mediaitem in 2.10.0 —
 *     older servers 404 those routes, so the version gates below must not
 *     loosen without re-verifying against the ABS release history.
 *
 * Update this file ONLY alongside a server-source re-verification, never to
 * make a refactor pass.
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

import { useUserStore } from "../../store/useUserStore";
import {
  MIN_VERSION_API_KEYS,
  MIN_VERSION_SHARE_LINKS,
  meetsVersion,
  getCapabilities,
} from "../../utils/abs/capabilities";

const initialState = useUserStore.getState();

beforeEach(() => {
  useUserStore.setState(initialState, true);
});

function capsFor(user: any, version: string | null = "2.30.0") {
  useUserStore.setState({
    user,
    serverSettings: version ? { version } : null,
    serverConnectionConfig: { token: "tok" },
  });
  return getCapabilities();
}

const perms = (overrides: Partial<Record<string, boolean>> = {}) => ({
  download: false,
  update: false,
  delete: false,
  upload: false,
  accessAllLibraries: true,
  accessAllTags: true,
  accessExplicitContent: false,
  ...overrides,
});

describe("pinned role matrix (client gates ≡ server 403 rules)", () => {
  // Columns: [description, user, expected capability subset]
  const MATRIX: Array<[string, any, Partial<ReturnType<typeof getCapabilities>>]> = [
    [
      "root",
      { id: "u", type: "root", permissions: perms() },
      {
        isRoot: true,
        isAdmin: true,
        canEditMetadata: true,
        canUploadCover: true,
        canDelete: true,
        canDownload: true,
        canUpload: true,
      },
    ],
    [
      "admin",
      { id: "u", type: "admin", permissions: perms() },
      {
        isRoot: false,
        isAdmin: true,
        canEditMetadata: true,
        canUploadCover: true,
        canDelete: true,
        canDownload: true,
        canUpload: true,
      },
    ],
    [
      "user, no flags",
      { id: "u", type: "user", permissions: perms() },
      {
        isRoot: false,
        isAdmin: false,
        canEditMetadata: false,
        canUploadCover: false,
        canDelete: false,
        canDownload: false,
        canUpload: false,
      },
    ],
    [
      "user, update only — cover editing still OFF (server cover route needs upload)",
      { id: "u", type: "user", permissions: perms({ update: true }) },
      { canEditMetadata: true, canUploadCover: false, canUpload: false },
    ],
    [
      "user, upload only — cover editing still OFF (cover change is a metadata edit)",
      { id: "u", type: "user", permissions: perms({ upload: true }) },
      { canEditMetadata: false, canUploadCover: false, canUpload: true },
    ],
    [
      "user, update+upload — cover editing ON",
      { id: "u", type: "user", permissions: perms({ update: true, upload: true }) },
      { canEditMetadata: true, canUploadCover: true },
    ],
    [
      "user, download+delete flags map 1:1",
      { id: "u", type: "user", permissions: perms({ download: true, delete: true }) },
      { canDownload: true, canDelete: true, canUpload: false },
    ],
    [
      // FROZEN NAME `canCreateEreader` — AccountScreen consumes it. Semantics:
      // ONLY an explicit createEreader:false denies (the server defaults the
      // flag on, and thin cold-restored users have no permissions object yet).
      "user, no createEreader flag — e-reader creation defaults ON",
      { id: "u", type: "user", permissions: perms() },
      { canCreateEreader: true },
    ],
    [
      "user, createEreader explicitly false — the ONLY denying value",
      { id: "u", type: "user", permissions: perms({ createEreader: false }) },
      { canCreateEreader: false },
    ],
    [
      "thin cold-restored user ({id, username} only) — e-reader creation stays ON",
      { id: "u", username: "amy" },
      { canCreateEreader: true },
    ],
    [
      "guest",
      { id: "u", type: "guest", permissions: perms() },
      { isAdmin: false, canEditMetadata: false, canDelete: false },
    ],
    [
      "no user (restored-session seed / logged out)",
      null,
      { isAdmin: false, isRoot: false, canEditMetadata: false, canUploadCover: false },
    ],
  ];

  it.each(MATRIX)("%s", (_desc, user, expected) => {
    const caps = capsFor(user);
    for (const [key, value] of Object.entries(expected)) {
      expect({ [key]: (caps as any)[key] }).toEqual({ [key]: value });
    }
  });
});

describe("pinned version gates", () => {
  it("MIN_VERSION literals are frozen (re-verify upstream before changing)", () => {
    expect(MIN_VERSION_API_KEYS).toBe("2.26.0");
    expect(MIN_VERSION_SHARE_LINKS).toBe("2.10.0");
  });

  it("boundary behavior: exact minimum qualifies; one patch below does not", () => {
    expect(meetsVersion(MIN_VERSION_API_KEYS, "2.26.0")).toBe(true);
    expect(meetsVersion(MIN_VERSION_API_KEYS, "2.25.99")).toBe(false);
    expect(meetsVersion(MIN_VERSION_SHARE_LINKS, "2.10.0")).toBe(true);
    expect(meetsVersion(MIN_VERSION_SHARE_LINKS, "2.9.9")).toBe(false);
  });

  it("an UNKNOWN server version must gate features OFF, not on", () => {
    const caps = capsFor({ id: "u", type: "root", permissions: perms() }, null);
    expect(caps.serverVersion).toBeNull();
    expect(caps.supportsApiKeys).toBe(false);
    expect(caps.supportsShareLinks).toBe(false);
  });

  it("supports* flags are pure version predicates (role handled separately by isAdmin/isRoot)", () => {
    const admin = capsFor({ id: "u", type: "admin", permissions: perms() }, "2.26.0");
    expect(admin.supportsApiKeys).toBe(true);
    const plain = capsFor({ id: "u", type: "user", permissions: perms() }, "2.26.0");
    expect(plain.supportsApiKeys).toBe(true); // visibility gating combines this with isAdmin
  });
});
