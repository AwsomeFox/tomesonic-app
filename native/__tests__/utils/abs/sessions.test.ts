/**
 * utils/abs/sessions — exact method+path+payload triples (verified against
 * the ABS v2.35.1 ApiRouter/SessionController) and the throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import { getAllSessions, deleteSession, batchDeleteSessions } from "../../../utils/abs/sessions";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  jest.mocked(api.delete).mockReset().mockResolvedValue(ok());
});

it("getAllSessions → GET /api/sessions with the server's paging/sort params (desc as 1/0)", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ total: 1, sessions: [{ id: "s1" }] }));
  const res = await getAllSessions({
    user: "u1",
    sort: "updatedAt",
    desc: true,
    itemsPerPage: 25,
    page: 1,
  });
  expect(api.get).toHaveBeenCalledWith("/api/sessions", {
    params: { user: "u1", sort: "updatedAt", itemsPerPage: 25, page: 1, desc: 1 },
  });
  expect(res.sessions).toEqual([{ id: "s1" }]);
});

it("getAllSessions omits desc when unset and works param-less", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ total: 0, sessions: [] }));
  await getAllSessions();
  expect(api.get).toHaveBeenCalledWith("/api/sessions", { params: {} });
});

it("getAllSessions desc:false → desc: 0", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ sessions: [] }));
  await getAllSessions({ desc: false });
  expect(api.get).toHaveBeenCalledWith("/api/sessions", { params: { desc: 0 } });
});

it("deleteSession → DELETE /api/sessions/:id", async () => {
  await deleteSession("s1");
  expect(api.delete).toHaveBeenCalledWith("/api/sessions/s1");
});

it("batchDeleteSessions → POST /api/sessions/batch/delete { sessions }", async () => {
  await batchDeleteSessions(["s1", "s2"]);
  expect(api.post).toHaveBeenCalledWith("/api/sessions/batch/delete", { sessions: ["s1", "s2"] });
});

describe("error normalization", () => {
  it("non-admin sessions list: the server answers 404 (not 403) → unsupported kind, still an AbsError", async () => {
    jest.mocked(api.get).mockRejectedValue({ response: { status: 404 } });
    const err = await getAllSessions().catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("unsupported");
  });

  it("batch delete 403 → forbidden", async () => {
    jest.mocked(api.post).mockRejectedValue({ response: { status: 403 } });
    await expect(batchDeleteSessions(["s1"])).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("offline → offline", async () => {
    jest.mocked(api.delete).mockRejectedValue(new Error("Network Error"));
    await expect(deleteSession("s1")).rejects.toMatchObject({ kind: "offline" });
  });
});
