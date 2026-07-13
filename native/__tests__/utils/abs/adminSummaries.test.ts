/**
 * utils/abs/adminSummaries — the "at a glance" reducers behind the
 * ServerAdminHub rows (issue #64). Focus here is the tricky reduction in
 * getBackupsSummary: pick the NEWEST backup's createdAt, ignore anything that
 * isn't a real timestamp, and keep lastCreatedAt null when there are no valid
 * ones (so the row shows "No backups yet" rather than a bogus 1970 time).
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import { getBackupsSummary, getLibrariesSummary } from "../../../utils/abs/adminSummaries";

const ok = (data: any = {}) => ({ data });

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
});

describe("getBackupsSummary", () => {
  it("returns the NEWEST backup's createdAt", async () => {
    jest.mocked(api.get).mockResolvedValue(
      ok({ backups: [{ createdAt: 100 }, { createdAt: 300 }, { createdAt: 200 }] })
    );
    await expect(getBackupsSummary()).resolves.toEqual({ lastCreatedAt: 300 });
  });

  it("returns null when there are no backups", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ backups: [] }));
    await expect(getBackupsSummary()).resolves.toEqual({ lastCreatedAt: null });
  });

  it("keeps a real epoch of 0", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ backups: [{ createdAt: 0 }] }));
    await expect(getBackupsSummary()).resolves.toEqual({ lastCreatedAt: 0 });
  });

  it("IGNORES a missing/invalid createdAt rather than coercing it to 0", async () => {
    // A backup with no (or a non-numeric) createdAt must not surface as a bogus
    // "1970" time, and must not mask a real timestamp on a sibling.
    jest.mocked(api.get).mockResolvedValue(
      ok({ backups: [{ createdAt: undefined }, { createdAt: 500 }, { createdAt: "nope" }] })
    );
    await expect(getBackupsSummary()).resolves.toEqual({ lastCreatedAt: 500 });
  });

  it("returns null when every createdAt is invalid (no false 1970 time)", async () => {
    jest.mocked(api.get).mockResolvedValue(
      ok({ backups: [{ createdAt: undefined }, { createdAt: NaN }, {}] })
    );
    await expect(getBackupsSummary()).resolves.toEqual({ lastCreatedAt: null });
  });
});

describe("getLibrariesSummary", () => {
  it("counts the libraries array", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ libraries: [{ id: "a" }, { id: "b" }] }));
    await expect(getLibrariesSummary()).resolves.toEqual({ count: 2 });
  });
});
