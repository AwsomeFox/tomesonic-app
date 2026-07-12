/**
 * utils/abs/users — exact method+path+payload triples (verified against the
 * ABS v2.35.1 ApiRouter/UserController) and the throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  getOnlineUsers,
  getUserListeningSessions,
  getUserListeningStats,
} from "../../../utils/abs/users";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  jest.mocked(api.patch).mockReset().mockResolvedValue(ok());
  jest.mocked(api.delete).mockReset().mockResolvedValue(ok());
});

it("getUsers → GET /api/users, unwraps { users }", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ users: [{ id: "u1" }] }));
  await expect(getUsers()).resolves.toEqual([{ id: "u1" }]);
  expect(api.get).toHaveBeenCalledWith("/api/users", { params: undefined });
});

it("getUsers can include the latest session per user", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ users: [] }));
  await getUsers({ includeLatestSession: true });
  expect(api.get).toHaveBeenCalledWith("/api/users", { params: { include: "latestSession" } });
});

it("getUser → GET /api/users/:id", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ id: "u1", username: "amy" }));
  await expect(getUser("u1")).resolves.toEqual({ id: "u1", username: "amy" });
  expect(api.get).toHaveBeenCalledWith("/api/users/u1");
});

it("createUser → POST /api/users, unwraps { user }", async () => {
  jest.mocked(api.post).mockResolvedValue(ok({ user: { id: "u2", username: "bob" } }));
  const payload = {
    username: "bob",
    password: "pw",
    type: "user" as const,
    isActive: true,
    permissions: { download: true },
    librariesAccessible: ["lib1"],
  };
  await expect(createUser(payload)).resolves.toEqual({ id: "u2", username: "bob" });
  expect(api.post).toHaveBeenCalledWith("/api/users", payload);
});

it("updateUser → PATCH /api/users/:id, unwraps { user }", async () => {
  jest.mocked(api.patch).mockResolvedValue(ok({ success: true, user: { id: "u2", isActive: false } }));
  await expect(updateUser("u2", { isActive: false })).resolves.toEqual({
    id: "u2",
    isActive: false,
  });
  expect(api.patch).toHaveBeenCalledWith("/api/users/u2", { isActive: false });
});

it("deleteUser → DELETE /api/users/:id", async () => {
  await deleteUser("u2");
  expect(api.delete).toHaveBeenCalledWith("/api/users/u2");
});

it("getOnlineUsers → GET /api/users/online, tolerant unwrap", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ usersOnline: [{ id: "u1" }], openSessions: [] }));
  await expect(getOnlineUsers()).resolves.toEqual({ usersOnline: [{ id: "u1" }], openSessions: [] });
  expect(api.get).toHaveBeenCalledWith("/api/users/online");

  jest.mocked(api.get).mockResolvedValue(ok(null));
  await expect(getOnlineUsers()).resolves.toEqual({ usersOnline: [], openSessions: [] });
});

it("getUserListeningSessions → GET /api/users/:id/listening-sessions with paging params", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ total: 0, sessions: [] }));
  await getUserListeningSessions("u1", { itemsPerPage: 10, page: 2 });
  expect(api.get).toHaveBeenCalledWith("/api/users/u1/listening-sessions", {
    params: { itemsPerPage: 10, page: 2 },
  });
});

it("getUserListeningStats → GET /api/users/:id/listening-stats", async () => {
  await getUserListeningStats("u1");
  expect(api.get).toHaveBeenCalledWith("/api/users/u1/listening-stats");
});

describe("error normalization", () => {
  it("deleteUser 403 → forbidden AbsError", async () => {
    jest.mocked(api.delete).mockRejectedValue({ response: { status: 403 } });
    const err = await deleteUser("u1").catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("forbidden");
  });

  it("createUser keeps the server's 400 reason text", async () => {
    jest
      .mocked(api.post)
      .mockRejectedValue({ response: { status: 400, data: "Username already taken" } });
    await expect(createUser({ username: "bob", password: "x" })).rejects.toMatchObject({
      message: "Username already taken",
    });
  });

  it("offline → offline AbsError", async () => {
    jest.mocked(api.get).mockRejectedValue(new Error("Network Error"));
    await expect(getUsers()).rejects.toMatchObject({ kind: "offline" });
  });
});
