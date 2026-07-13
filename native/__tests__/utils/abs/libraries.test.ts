/**
 * utils/abs/libraries — exact method+path+payload triples (verified against
 * the ABS v2.35.1 ApiRouter) and the throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import {
  narratorNameToId,
  scanLibrary,
  matchAllLibrary,
  createLibrary,
  updateLibrary,
  deleteLibrary,
  getLibraryStats,
  getLibraryNarrators,
  updateNarrator,
  getLibraryFilterData,
} from "../../../utils/abs/libraries";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  jest.mocked(api.patch).mockReset().mockResolvedValue(ok());
  jest.mocked(api.delete).mockReset().mockResolvedValue(ok());
});

describe("narratorNameToId", () => {
  it("matches the server's encodeURIComponent(base64(name)) scheme", () => {
    // Buffer.from("Ray Porter").toString("base64") === "UmF5IFBvcnRlcg=="
    expect(narratorNameToId("Ray Porter")).toBe(encodeURIComponent("UmF5IFBvcnRlcg=="));
  });

  it("handles padding variants (1- and 2-byte tails)", () => {
    expect(narratorNameToId("ab")).toBe(encodeURIComponent("YWI=")); // 2-byte tail
    expect(narratorNameToId("a")).toBe(encodeURIComponent("YQ==")); // 1-byte tail
    expect(narratorNameToId("abc")).toBe("YWJj"); // no padding
  });

  it("UTF-8 encodes non-ASCII names like Buffer.from does", () => {
    // Buffer.from("Zoë").toString("base64") === "Wm/Dqw=="
    expect(narratorNameToId("Zoë")).toBe(encodeURIComponent("Wm/Dqw=="));
  });
});

describe("endpoint shapes", () => {
  it("scanLibrary → POST /api/libraries/:id/scan (no force by default)", async () => {
    await scanLibrary("lib1");
    expect(api.post).toHaveBeenCalledWith("/api/libraries/lib1/scan", undefined, {
      params: undefined,
    });
  });

  it("scanLibrary force → ?force=1", async () => {
    await scanLibrary("lib1", { force: true });
    expect(api.post).toHaveBeenCalledWith("/api/libraries/lib1/scan", undefined, {
      params: { force: 1 },
    });
  });

  it("matchAllLibrary → GET (not POST) /api/libraries/:id/matchall", async () => {
    await matchAllLibrary("lib1");
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/matchall");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("createLibrary → POST /api/libraries", async () => {
    await createLibrary({ name: "Books", folders: [{ fullPath: "/audiobooks" }] });
    expect(api.post).toHaveBeenCalledWith("/api/libraries", {
      name: "Books",
      folders: [{ fullPath: "/audiobooks" }],
    });
  });

  it("updateLibrary → PATCH /api/libraries/:id", async () => {
    await updateLibrary("lib1", { name: "Renamed" });
    expect(api.patch).toHaveBeenCalledWith("/api/libraries/lib1", { name: "Renamed" });
  });

  it("deleteLibrary → DELETE /api/libraries/:id", async () => {
    await deleteLibrary("lib1");
    expect(api.delete).toHaveBeenCalledWith("/api/libraries/lib1");
  });

  it("getLibraryStats → GET /api/libraries/:id/stats", async () => {
    jest.mocked(api.get).mockResolvedValue(ok({ totalItems: 3 }));
    await expect(getLibraryStats("lib1")).resolves.toEqual({ totalItems: 3 });
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/stats");
  });

  it("getLibraryNarrators → GET .../narrators, unwraps { narrators }", async () => {
    const narrators = [{ id: "abc", name: "N", numBooks: 2 }];
    jest.mocked(api.get).mockResolvedValue(ok({ narrators }));
    await expect(getLibraryNarrators("lib1")).resolves.toEqual(narrators);
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/narrators");
  });

  it("getLibraryNarrators tolerates a degenerate body", async () => {
    jest.mocked(api.get).mockResolvedValue(ok(null));
    await expect(getLibraryNarrators("lib1")).resolves.toEqual([]);
  });

  it("updateNarrator → PATCH .../narrators/:narratorId with { name } (id is base64-of-name)", async () => {
    jest.mocked(api.patch).mockResolvedValue(ok({ updated: 4 }));
    const id = narratorNameToId("Ray Porter");
    await expect(updateNarrator("lib1", id, "Ray A. Porter")).resolves.toEqual({ updated: 4 });
    expect(api.patch).toHaveBeenCalledWith(`/api/libraries/lib1/narrators/${id}`, {
      name: "Ray A. Porter",
    });
  });

  it("getLibraryFilterData → GET /api/libraries/:id/filterdata", async () => {
    await getLibraryFilterData("lib1");
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/filterdata");
  });
});

describe("error normalization (throws AbsError, unlike utils/upNext)", () => {
  it.each([
    [{ message: "Network Error" }, "offline"],
    [{ response: { status: 401 } }, "auth"],
    [{ response: { status: 403 } }, "forbidden"],
    [{ response: { status: 404 } }, "unsupported"],
    [{ response: { status: 500 } }, "server"],
  ] as const)("scanLibrary maps %j to kind %s", async (raw, kind) => {
    jest.mocked(api.post).mockRejectedValue(raw);
    const err = await scanLibrary("lib1").catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe(kind);
  });

  it("deleteLibrary rethrows AbsError too", async () => {
    jest.mocked(api.delete).mockRejectedValue({ response: { status: 403 } });
    await expect(deleteLibrary("lib1")).rejects.toMatchObject({ kind: "forbidden" });
  });
});
