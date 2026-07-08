jest.mock("../../utils/rmab", () => ({
  exchangeLoginToken: jest.fn(),
  readRmabConfig: jest.fn(),
  writeRmabConfig: jest.fn(),
  // Real implementation: apiToken presence decides the mode.
  rmabAuthMode: (cfg: any) => (cfg ? (cfg.apiToken ? "apiToken" : "jwt") : null),
  getMe: jest.fn(),
  createRequest: jest.fn(),
  cancelRequest: jest.fn(),
  getPendingApprovalCount: jest.fn().mockResolvedValue(0),
  listMyRequests: jest.fn().mockResolvedValue([]),
  clearRmabCaches: jest.fn(),
  setRmabSessionExpiredHandler: jest.fn(),
}));

import { useRmabStore } from "../../store/useRmabStore";
import {
  exchangeLoginToken,
  readRmabConfig,
  writeRmabConfig,
  getMe,
  createRequest,
  cancelRequest,
} from "../../utils/rmab";
// Real in-memory MMKV (see jest.setup.ts) — the store lazy-requires this same
// module to persist requested-state.
import { storage } from "../../utils/storage";

const initial = useRmabStore.getState();
const mockedExchange = exchangeLoginToken as jest.Mock;
const mockedRead = readRmabConfig as jest.Mock;
const mockedWrite = writeRmabConfig as jest.Mock;
const mockedMe = getMe as jest.Mock;
const mockedCreate = createRequest as jest.Mock;
const mockedCancel = cancelRequest as jest.Mock;

const CFG = {
  url: "https://rmab.test",
  accessToken: "a",
  refreshToken: "r",
  user: { id: "u1", username: "tony" },
};

beforeEach(() => {
  useRmabStore.setState(initial, true);
  storage.remove("rmab_requestedAsins");
  jest.clearAllMocks();
});

describe("initialize", () => {
  it("adopts a persisted config", () => {
    mockedRead.mockReturnValue(CFG);
    useRmabStore.getState().initialize();
    const s = useRmabStore.getState();
    expect(s.configured).toBe(true);
    expect(s.serverUrl).toBe("https://rmab.test");
    expect(s.username).toBe("tony");
  });

  it("stays unconfigured with no persisted config", () => {
    mockedRead.mockReturnValue(null);
    useRmabStore.getState().initialize();
    expect(useRmabStore.getState().configured).toBe(false);
  });
});

describe("connect", () => {
  it("exchanges the token, verifies with an authed call, persists", async () => {
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockResolvedValue({ user: {} });
    const ok = await useRmabStore.getState().connect("https://rmab.test", "tok");
    expect(ok).toBe(true);
    // Persisted with the provider tag so a later expiry routes re-login correctly.
    expect(mockedWrite).toHaveBeenCalledWith({ ...CFG, authProvider: "loginToken" });
    const s = useRmabStore.getState();
    expect(s.configured).toBe(true);
    expect(s.username).toBe("tony");
    expect(s.authMode).toBe("jwt");
    expect(s.authProvider).toBe("loginToken");
    expect(s.connectError).toBeNull();
  });

  it("accepts RMAB's one-time login URL pasted whole, extracting server + token", async () => {
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockResolvedValue({});
    const ok = await useRmabStore
      .getState()
      .connect("", "https://rmab.test/auth/token/login?token=SECRET123");
    expect(ok).toBe(true);
    expect(mockedExchange).toHaveBeenCalledWith("https://rmab.test", "SECRET123", { preferApiToken: false });
  });

  it("login URL in the SERVER field with an empty token field connects too", async () => {
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockResolvedValue({});
    const ok = await useRmabStore
      .getState()
      .connect("https://rmab.test/auth/token/login?token=SECRET123", "");
    expect(ok).toBe(true);
    expect(mockedExchange).toHaveBeenCalledWith("https://rmab.test", "SECRET123", { preferApiToken: false });
  });

  it("plain server URL with no token of any kind fails with guidance, no network call", async () => {
    const ok = await useRmabStore.getState().connect("https://rmab.test", "");
    expect(ok).toBe(false);
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(useRmabStore.getState().connectError).toBe("Paste a login URL, or add an API token");
  });

  it("empty server URL (with a non-URL token) asks for the address, no network call", async () => {
    const ok = await useRmabStore.getState().connect("", "sometoken");
    expect(ok).toBe(false);
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(useRmabStore.getState().connectError).toBe("Enter your server's address");
  });

  it("an rmab_ API token connects in limited apiToken mode", async () => {
    mockedExchange.mockResolvedValue({ url: "https://rmab.test", apiToken: "rmab_x", user: { id: "u1" } });
    mockedMe.mockResolvedValue({});
    const ok = await useRmabStore.getState().connect("https://rmab.test", "rmab_x");
    expect(ok).toBe(true);
    expect(useRmabStore.getState().authMode).toBe("apiToken");
  });

  it("bad token → friendly error, config wiped", async () => {
    mockedExchange.mockRejectedValue({ response: { status: 401 } });
    const ok = await useRmabStore.getState().connect("https://rmab.test", "bad");
    expect(ok).toBe(false);
    expect(mockedWrite).toHaveBeenCalledWith(null);
    expect(useRmabStore.getState().connectError).toContain("Token rejected");
    expect(useRmabStore.getState().configured).toBe(false);
  });

  it("unreachable server → network error message", async () => {
    mockedExchange.mockRejectedValue(new Error("ECONNREFUSED"));
    const ok = await useRmabStore.getState().connect("https://nope.test", "tok");
    expect(ok).toBe(false);
    expect(useRmabStore.getState().connectError).toBe("Could not reach the server");
  });

  it("a token that exchanges but fails the authed round-trip is rejected", async () => {
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockRejectedValue({ response: { status: 401 } });
    const ok = await useRmabStore.getState().connect("https://rmab.test", "tok");
    expect(ok).toBe(false);
    expect(mockedWrite).toHaveBeenLastCalledWith(null);
  });

  it("failure clears identity left over from a previous connection", async () => {
    // Connected as an admin, then a reconnect attempt fails: the persisted
    // config is wiped, so none of the old session may survive in memory.
    useRmabStore.setState({
      configured: true,
      serverUrl: "https://old.test",
      username: "olduser",
      authMode: "jwt",
      isAdmin: true,
      pendingApprovalCount: 4,
      requestedAsins: { B01: "pending" },
    } as any);
    mockedExchange.mockRejectedValue({ response: { status: 401 } });
    const ok = await useRmabStore.getState().connect("https://new.test", "bad");
    expect(ok).toBe(false);
    const s = useRmabStore.getState();
    expect(s.configured).toBe(false);
    expect(s.serverUrl).toBeNull();
    expect(s.username).toBeNull();
    expect(s.authMode).toBeNull();
    expect(s.isAdmin).toBe(false);
    expect(s.pendingApprovalCount).toBe(0);
    expect(s.requestedAsins).toEqual({});
  });

  it("success clears optimistic Requested chips from a previous session", async () => {
    // Reconnecting (possibly to a DIFFERENT server/user) — the old session's
    // local request overlay doesn't describe the new one.
    useRmabStore.setState({ requestedAsins: { B01: "pending" } } as any);
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockResolvedValue({ user: {} });
    const ok = await useRmabStore.getState().connect("https://rmab.test", "tok");
    expect(ok).toBe(true);
    expect(useRmabStore.getState().requestedAsins).toEqual({});
  });

  it("success also clears the PERSISTED chip map so a restart can't resurrect it", async () => {
    storage.set("rmab_requestedAsins", JSON.stringify({ B01: "pending" }));
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockResolvedValue({ user: {} });
    await useRmabStore.getState().connect("https://rmab.test", "tok");
    expect(storage.getString("rmab_requestedAsins")).toBeFalsy();
  });
});

describe("connectWithOidc", () => {
  it("persists the SSO config, adopts the role from /auth/me, marks it jwt + oidc", async () => {
    mockedMe.mockResolvedValue({ user: { id: "u1", username: "tony", role: "admin" } });
    const ok = await useRmabStore.getState().connectWithOidc(CFG as any);
    expect(ok).toBe(true);
    const s = useRmabStore.getState();
    expect(s.configured).toBe(true);
    expect(s.authMode).toBe("jwt");
    expect(s.authProvider).toBe("oidc");
    expect(s.isAdmin).toBe(true);
    expect(s.username).toBe("tony");
    expect(s.sessionExpired).toBe(false);
    // The persisted config carries authProvider so re-login routes to SSO later.
    expect(mockedWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https://rmab.test", authProvider: "oidc" })
    );
  });

  it("clears everything when the fresh JWT is REJECTED (401) with no prior connection", async () => {
    mockedRead.mockReturnValue(null); // first-time connect, nothing to restore
    mockedMe.mockRejectedValue({ response: { status: 401 } });
    const ok = await useRmabStore.getState().connectWithOidc(CFG as any);
    expect(ok).toBe(false);
    expect(mockedWrite).toHaveBeenLastCalledWith(null);
    const s = useRmabStore.getState();
    expect(s.configured).toBe(false);
    expect(s.connectError).toBeTruthy();
  });

  it("preserves an existing connection when an in-place re-login fails transiently", async () => {
    const prev = {
      url: "https://rmab.test",
      accessToken: "old",
      refreshToken: "oldr",
      authProvider: "oidc",
      user: { id: "u1", username: "tony" },
    };
    mockedRead.mockReturnValue(prev);
    useRmabStore.setState({
      configured: true,
      serverUrl: "https://rmab.test",
      username: "tony",
      authMode: "jwt",
      authProvider: "oidc",
      sessionExpired: true,
    } as any);
    mockedMe.mockRejectedValue(new Error("ECONNRESET")); // transient — no response.status
    const ok = await useRmabStore
      .getState()
      .connectWithOidc({ url: "https://rmab.test", accessToken: "new", refreshToken: "newr", user: null } as any);
    expect(ok).toBe(false);
    // Prior config restored (last write), the session left intact for a retry.
    expect(mockedWrite).toHaveBeenLastCalledWith(prev);
    const s = useRmabStore.getState();
    expect(s.configured).toBe(true);
    expect(s.serverUrl).toBe("https://rmab.test");
    expect(s.sessionExpired).toBe(true);
  });

  it("wipes fully when an in-place re-login is auth-REJECTED (403) despite a prior connection", async () => {
    // Distinct from the transient case (which restores) and the no-prior case
    // (which also wipes): here a connection EXISTS but the fresh JWT is refused,
    // so the session is genuinely over — nothing may survive, config wiped last.
    const prev = {
      url: "https://rmab.test",
      accessToken: "old",
      refreshToken: "oldr",
      authProvider: "oidc",
      user: { id: "u1", username: "tony" },
    };
    mockedRead.mockReturnValue(prev);
    useRmabStore.setState({
      configured: true,
      serverUrl: "https://rmab.test",
      username: "tony",
      authMode: "jwt",
      authProvider: "oidc",
      isAdmin: true,
      sessionExpired: true,
    } as any);
    mockedMe.mockRejectedValue({ response: { status: 403 } });
    const ok = await useRmabStore
      .getState()
      .connectWithOidc({ url: "https://rmab.test", accessToken: "new", refreshToken: "newr", user: null } as any);
    expect(ok).toBe(false);
    // No restore — the LAST write is the wipe.
    expect(mockedWrite).toHaveBeenLastCalledWith(null);
    const s = useRmabStore.getState();
    expect(s.configured).toBe(false);
    expect(s.serverUrl).toBeNull();
    expect(s.username).toBeNull();
    expect(s.isAdmin).toBe(false);
    expect(s.connectError).toBeTruthy();
  });
});

describe("markSessionExpired", () => {
  it("flags a live session as expired and drops the approval badge", () => {
    useRmabStore.setState({ configured: true, sessionExpired: false, pendingApprovalCount: 3 } as any);
    useRmabStore.getState().markSessionExpired();
    const s = useRmabStore.getState();
    expect(s.sessionExpired).toBe(true);
    expect(s.pendingApprovalCount).toBe(0);
  });

  it("is a no-op when not configured (never expires a fresh/disconnected store)", () => {
    useRmabStore.setState({ configured: false, sessionExpired: false } as any);
    useRmabStore.getState().markSessionExpired();
    expect(useRmabStore.getState().sessionExpired).toBe(false);
  });

  it("registers itself as the rmab.ts session-expiry handler on initialize", () => {
    const { setRmabSessionExpiredHandler } = require("../../utils/rmab");
    mockedRead.mockReturnValue(null);
    useRmabStore.getState().initialize();
    expect(setRmabSessionExpiredHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it("a successful reconnect clears the expired flag", async () => {
    useRmabStore.setState({ configured: true, sessionExpired: true } as any);
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockResolvedValue({ user: {} });
    await useRmabStore.getState().connect("https://rmab.test", "tok");
    expect(useRmabStore.getState().sessionExpired).toBe(false);
  });
});

describe("disconnect", () => {
  it("wipes config and state", async () => {
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockResolvedValue({});
    await useRmabStore.getState().connect("https://rmab.test", "tok");
    useRmabStore.getState().disconnect();
    expect(mockedWrite).toHaveBeenLastCalledWith(null);
    const s = useRmabStore.getState();
    expect(s.configured).toBe(false);
    expect(s.serverUrl).toBeNull();
    expect(s.requestedAsins).toEqual({});
  });
});

describe("refreshPendingCount", () => {
  const { getPendingApprovalCount } = require("../../utils/rmab");

  it("loads the count for admin JWT sessions", async () => {
    useRmabStore.setState({ configured: true, isAdmin: true, authMode: "jwt" } as any);
    (getPendingApprovalCount as jest.Mock).mockResolvedValue(3);
    await useRmabStore.getState().refreshPendingCount();
    expect(useRmabStore.getState().pendingApprovalCount).toBe(3);
  });

  it("no-ops for non-admins and API-token sessions (endpoint would 403)", async () => {
    (getPendingApprovalCount as jest.Mock).mockClear();
    useRmabStore.setState({ configured: true, isAdmin: false, authMode: "jwt" } as any);
    await useRmabStore.getState().refreshPendingCount();
    useRmabStore.setState({ configured: true, isAdmin: true, authMode: "apiToken" } as any);
    await useRmabStore.getState().refreshPendingCount();
    expect(getPendingApprovalCount).not.toHaveBeenCalled();
  });

  it("keeps the last count when the fetch fails", async () => {
    useRmabStore.setState({ configured: true, isAdmin: true, authMode: "jwt", pendingApprovalCount: 2 } as any);
    (getPendingApprovalCount as jest.Mock).mockRejectedValue(new Error("down"));
    await useRmabStore.getState().refreshPendingCount();
    expect(useRmabStore.getState().pendingApprovalCount).toBe(2);
  });
});

describe("requestBook", () => {
  const BOOK = { asin: "B01", title: "Dune" } as any;

  it("marks the asin requested on success", async () => {
    mockedCreate.mockResolvedValue({ id: "req1" });
    const res = await useRmabStore.getState().requestBook(BOOK);
    expect(res.ok).toBe(true);
    expect(useRmabStore.getState().requestedAsins["B01"]).toBe("pending");
  });

  it("409 duplicate still flips the button to Requested", async () => {
    mockedCreate.mockRejectedValue({ response: { data: { error: "DuplicateRequest" } } });
    const res = await useRmabStore.getState().requestBook(BOOK);
    expect(res).toEqual({ ok: false, message: "Already requested" });
    expect(useRmabStore.getState().requestedAsins["B01"]).toBe("pending");
  });

  it("already-available reports without marking requested", async () => {
    mockedCreate.mockRejectedValue({ response: { data: { error: "AlreadyAvailable" } } });
    const res = await useRmabStore.getState().requestBook(BOOK);
    expect(res).toEqual({ ok: false, message: "Already in the library" });
    expect(useRmabStore.getState().requestedAsins["B01"]).toBeUndefined();
  });

  it("failures without a response read as offline", async () => {
    mockedCreate.mockRejectedValue(new Error("Network Error"));
    const res = await useRmabStore.getState().requestBook(BOOK);
    expect(res).toEqual({ ok: false, message: "You're offline — try again when connected" });
  });

  it("401/403 point the user at reconnecting RMAB", async () => {
    mockedCreate.mockRejectedValue({ response: { status: 401, data: {} } });
    const res = await useRmabStore.getState().requestBook(BOOK);
    expect(res).toEqual({
      ok: false,
      message: "Session expired — reconnect ReadMeABook in Settings",
    });
  });

  it("other server rejections surface the server's detail instead of a bare failure", async () => {
    mockedCreate.mockRejectedValue({ response: { status: 400, data: { error: "InvalidAsin" } } });
    const res = await useRmabStore.getState().requestBook(BOOK);
    expect(res).toEqual({ ok: false, message: "Request failed: InvalidAsin" });

    mockedCreate.mockRejectedValue({ response: { status: 500, data: { message: "db down" } } });
    const res2 = await useRmabStore.getState().requestBook(BOOK);
    expect(res2).toEqual({ ok: false, message: "Request failed: db down" });

    mockedCreate.mockRejectedValue({ response: { status: 500, data: {} } });
    const res3 = await useRmabStore.getState().requestBook(BOOK);
    expect(res3).toEqual({ ok: false, message: "Request failed" });
  });

  it("concurrent requests each land their status (functional set — no lost updates)", async () => {
    mockedCreate.mockResolvedValue({ id: "req" });
    await Promise.all([
      useRmabStore.getState().requestBook({ asin: "B01", title: "A" } as any),
      useRmabStore.getState().requestBook({ asin: "B02", title: "B" } as any),
      useRmabStore.getState().requestBook({ asin: "B03", title: "C" } as any),
    ]);
    expect(useRmabStore.getState().requestedAsins).toEqual({
      B01: "pending",
      B02: "pending",
      B03: "pending",
    });
  });

  it("noteRequestStatus merges into the current map rather than replacing it", () => {
    useRmabStore.getState().noteRequestStatus("B01", "pending");
    useRmabStore.getState().noteRequestStatus("B02", "approved");
    // Updating an existing asin keeps the others.
    useRmabStore.getState().noteRequestStatus("B01", "downloading");
    expect(useRmabStore.getState().requestedAsins).toEqual({
      B01: "downloading",
      B02: "approved",
    });
  });
});

describe("cancelMyRequest (requester self-cancel)", () => {
  beforeEach(() => {
    storage.remove("rmab_myRequestStatuses");
    mockedCancel.mockReset();
  });

  it("cancels, clears the requestedAsins chip, and persists the drop", async () => {
    mockedCancel.mockResolvedValue(undefined);
    useRmabStore.setState({
      configured: true,
      requestedAsins: { B01: "pending", B02: "pending" },
    } as any);

    const res = await useRmabStore.getState().cancelMyRequest("r1", "B01");

    expect(res).toEqual({ ok: true });
    expect(mockedCancel).toHaveBeenCalledWith("r1");
    // B01's chip is gone (discovery re-shows "Request"); B02 untouched.
    expect(useRmabStore.getState().requestedAsins).toEqual({ B02: "pending" });
    expect(JSON.parse(storage.getString("rmab_requestedAsins")!)).toEqual({ B02: "pending" });
  });

  it("records the cancellation in the fulfillment baseline so the poller won't call it 'failed'", async () => {
    mockedCancel.mockResolvedValue(undefined);
    // A pending baseline for this request already exists.
    storage.set("rmab_myRequestStatuses", JSON.stringify({ r1: "pending" }));
    useRmabStore.setState({ configured: true, isAdmin: false } as any);

    await useRmabStore.getState().cancelMyRequest("r1", "B01");
    // Baseline now reads cancelled, so the next diff sees no pending→failed jump.
    expect(JSON.parse(storage.getString("rmab_myRequestStatuses")!)).toEqual({ r1: "cancelled" });

    const { listMyRequests } = require("../../utils/rmab");
    (listMyRequests as jest.Mock).mockResolvedValue([{ id: "r1", status: "cancelled" }]);
    await useRmabStore.getState().refreshMyRequestStatuses();
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 0, failed: 0 });
  });

  it("a 403 surfaces a 'server doesn't allow it' message and leaves the chip intact (revert-safe)", async () => {
    mockedCancel.mockRejectedValue({ response: { status: 403 } });
    useRmabStore.setState({ configured: true, requestedAsins: { B01: "pending" } } as any);

    const res = await useRmabStore.getState().cancelMyRequest("r1", "B01");

    expect(res).toEqual({
      ok: false,
      message: "This server doesn't allow cancelling your own requests",
    });
    // No local mutation on failure — the caller reverts its own row from this.
    expect(useRmabStore.getState().requestedAsins).toEqual({ B01: "pending" });
  });

  it("a 400 (no longer cancellable) surfaces the server's detail without touching state", async () => {
    mockedCancel.mockRejectedValue({
      response: { status: 400, data: { message: "Cannot cancel request with status: available" } },
    });
    useRmabStore.setState({ configured: true, requestedAsins: { B01: "pending" } } as any);

    const res = await useRmabStore.getState().cancelMyRequest("r1", "B01");

    expect(res).toEqual({ ok: false, message: "Cannot cancel request with status: available" });
    expect(useRmabStore.getState().requestedAsins).toEqual({ B01: "pending" });
  });

  it("an offline failure reads as offline", async () => {
    mockedCancel.mockRejectedValue(new Error("Network Error"));
    const res = await useRmabStore.getState().cancelMyRequest("r1", "B01");
    expect(res).toEqual({ ok: false, message: "You're offline — try again when connected" });
  });
});

describe("requested-state persistence (survives restarts)", () => {
  it("noteRequestStatus mirrors the full map to storage", () => {
    useRmabStore.getState().noteRequestStatus("B01", "pending");
    expect(JSON.parse(storage.getString("rmab_requestedAsins")!)).toEqual({ B01: "pending" });
    // Subsequent notes persist the MERGED map, not just the last entry.
    useRmabStore.getState().noteRequestStatus("B02", "approved");
    expect(JSON.parse(storage.getString("rmab_requestedAsins")!)).toEqual({
      B01: "pending",
      B02: "approved",
    });
  });

  it("initialize hydrates requestedAsins from storage when a config exists", () => {
    mockedRead.mockReturnValue(CFG);
    storage.set("rmab_requestedAsins", JSON.stringify({ B09: "pending", B10: "approved" }));
    useRmabStore.getState().initialize();
    const s = useRmabStore.getState();
    expect(s.configured).toBe(true);
    expect(s.requestedAsins).toEqual({ B09: "pending", B10: "approved" });
  });

  it("corrupt or non-object persisted JSON is ignored (empty map)", () => {
    mockedRead.mockReturnValue(CFG);
    storage.set("rmab_requestedAsins", "{not valid json");
    useRmabStore.getState().initialize();
    expect(useRmabStore.getState().requestedAsins).toEqual({});

    // Arrays don't count as a status map either.
    useRmabStore.setState(initial, true);
    storage.set("rmab_requestedAsins", JSON.stringify(["B01"]));
    useRmabStore.getState().initialize();
    expect(useRmabStore.getState().requestedAsins).toEqual({});
  });

  it("disconnect removes the persisted key and empties the in-memory map", () => {
    useRmabStore.getState().noteRequestStatus("B01", "pending");
    expect(storage.getString("rmab_requestedAsins")).toBeDefined();

    useRmabStore.getState().disconnect();

    expect(storage.getString("rmab_requestedAsins")).toBeUndefined();
    expect(useRmabStore.getState().requestedAsins).toEqual({});
  });
});

describe("reconcileRequestedAsins", () => {
  const { listMyRequests } = require("../../utils/rmab");

  it("drops chips for requests the server no longer knows, keeps the rest, persists", async () => {
    useRmabStore.setState({
      configured: true,
      requestedAsins: { B01: "pending", B02: "pending" },
    } as any);
    (listMyRequests as jest.Mock).mockResolvedValue([{ audiobook: { asin: "B02" } }]);

    await useRmabStore.getState().reconcileRequestedAsins();

    expect(useRmabStore.getState().requestedAsins).toEqual({ B02: "pending" });
    expect(JSON.parse(storage.getString("rmab_requestedAsins")!)).toEqual({ B02: "pending" });
  });

  it("keeps the local overlay when the server can't be reached", async () => {
    useRmabStore.setState({
      configured: true,
      requestedAsins: { B01: "pending" },
    } as any);
    (listMyRequests as jest.Mock).mockRejectedValue(new Error("offline"));

    await useRmabStore.getState().reconcileRequestedAsins();

    expect(useRmabStore.getState().requestedAsins).toEqual({ B01: "pending" });
  });

  it("is a no-op when unconfigured", async () => {
    (listMyRequests as jest.Mock).mockResolvedValue([]);
    await useRmabStore.getState().reconcileRequestedAsins();
    expect(listMyRequests).not.toHaveBeenCalled();
  });
});

describe("reconcileRequestedAsins mid-flight race", () => {
  const { listMyRequests } = require("../../utils/rmab");

  it("keeps a chip added WHILE the server list was in flight", async () => {
    useRmabStore.setState({
      configured: true,
      requestedAsins: { OLD1: "pending" },
    } as any);
    let release: (v: any) => void = () => {};
    (listMyRequests as jest.Mock).mockImplementation(
      () => new Promise((res) => (release = res))
    );

    const run = useRmabStore.getState().reconcileRequestedAsins();
    await new Promise((r) => setTimeout(r, 0));
    // User requests a book while the (stale) server list is still loading.
    useRmabStore.getState().noteRequestStatus("NEW1", "pending");
    release([]); // server list knows neither asin
    await run;

    // OLD1 (pre-snapshot, server-unknown) drops; NEW1 (mid-flight) survives.
    expect(useRmabStore.getState().requestedAsins).toEqual({ NEW1: "pending" });
    expect(JSON.parse(storage.getString("rmab_requestedAsins")!)).toEqual({ NEW1: "pending" });
  });
});

describe("prototype-pollution hardening", () => {
  it("noteRequestStatus rejects a __proto__ asin", () => {
    useRmabStore.getState().noteRequestStatus("__proto__", "pending");
    expect(useRmabStore.getState().requestedAsins).toEqual({});
    expect(({} as any).polluted).toBeUndefined();
  });

  it("initialize sanitizes a hostile persisted requestedAsins map", () => {
    mockedRead.mockReturnValue(CFG);
    storage.set(
      "rmab_requestedAsins",
      JSON.stringify({ __proto__: { polluted: true }, B01: "pending", B02: 5 })
    );
    useRmabStore.getState().initialize();
    const map = useRmabStore.getState().requestedAsins;
    expect(map.B01).toBe("pending");
    expect(map.B02).toBeUndefined(); // non-string dropped
    expect(({} as any).polluted).toBeUndefined();
  });
});

// PO4: non-admins never learned a request was fulfilled (refreshPendingCount
// returns 0 for them). refreshMyRequestStatuses diffs listMyRequests() against a
// persisted status snapshot and surfaces newly-fulfilled / newly-failed counts.
describe("refreshMyRequestStatuses (non-admin fulfillment awareness)", () => {
  const { listMyRequests } = require("../../utils/rmab");

  beforeEach(() => {
    storage.remove("rmab_myRequestStatuses");
    (listMyRequests as jest.Mock).mockReset();
  });

  it("seeds a baseline on the first poll WITHOUT reporting pre-existing states", async () => {
    useRmabStore.setState({ configured: true, isAdmin: false } as any);
    (listMyRequests as jest.Mock).mockResolvedValue([
      { id: "1", status: "available" },
      { id: "2", status: "pending" },
    ]);
    await useRmabStore.getState().refreshMyRequestStatuses();
    // Nothing "new" on the first observation.
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 0, failed: 0 });
    expect(JSON.parse(storage.getString("rmab_myRequestStatuses")!)).toEqual({
      "1": "available",
      "2": "pending",
    });
  });

  it("counts a newly-fulfilled and a newly-failed request, and won't double-count", async () => {
    useRmabStore.setState({ configured: true, isAdmin: false } as any);
    (listMyRequests as jest.Mock).mockResolvedValue([
      { id: "1", status: "pending" },
      { id: "2", status: "pending" },
    ]);
    await useRmabStore.getState().refreshMyRequestStatuses(); // baseline

    (listMyRequests as jest.Mock).mockResolvedValue([
      { id: "1", status: "available" }, // fulfilled
      { id: "2", status: "failed" }, // failed
    ]);
    await useRmabStore.getState().refreshMyRequestStatuses();
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 1, failed: 1 });

    // A repeat poll with the SAME states adds nothing (transition-only counting).
    await useRmabStore.getState().refreshMyRequestStatuses();
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 1, failed: 1 });
  });

  it("accumulates across polls and clearMyRequestUpdates resets it", async () => {
    useRmabStore.setState({ configured: true, isAdmin: false } as any);
    (listMyRequests as jest.Mock).mockResolvedValue([{ id: "1", status: "pending" }]);
    await useRmabStore.getState().refreshMyRequestStatuses(); // baseline
    (listMyRequests as jest.Mock).mockResolvedValue([{ id: "1", status: "completed" }]);
    await useRmabStore.getState().refreshMyRequestStatuses();
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 1, failed: 0 });

    useRmabStore.getState().clearMyRequestUpdates();
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 0, failed: 0 });
  });

  it("keys by book asin when the server omits a request id", async () => {
    useRmabStore.setState({ configured: true, isAdmin: false } as any);
    (listMyRequests as jest.Mock).mockResolvedValue([{ audiobook: { asin: "B01" }, status: "pending" }]);
    await useRmabStore.getState().refreshMyRequestStatuses();
    (listMyRequests as jest.Mock).mockResolvedValue([{ audiobook: { asin: "B01" }, status: "available" }]);
    await useRmabStore.getState().refreshMyRequestStatuses();
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 1, failed: 0 });
  });

  it("is a no-op for admins (they use pendingApprovalCount) and when unconfigured", async () => {
    useRmabStore.setState({ configured: true, isAdmin: true } as any);
    await useRmabStore.getState().refreshMyRequestStatuses();
    expect(listMyRequests).not.toHaveBeenCalled();

    useRmabStore.setState({ configured: false, isAdmin: false } as any);
    await useRmabStore.getState().refreshMyRequestStatuses();
    expect(listMyRequests).not.toHaveBeenCalled();
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 0, failed: 0 });
  });

  it("keeps the baseline and counts intact when the fetch fails (self-corrects later)", async () => {
    useRmabStore.setState({
      configured: true,
      isAdmin: false,
      myRequestUpdates: { fulfilled: 1, failed: 0 },
    } as any);
    storage.set("rmab_myRequestStatuses", JSON.stringify({ "1": "pending" }));
    (listMyRequests as jest.Mock).mockRejectedValue(new Error("offline"));
    await useRmabStore.getState().refreshMyRequestStatuses();
    expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 1, failed: 0 });
    expect(JSON.parse(storage.getString("rmab_myRequestStatuses")!)).toEqual({ "1": "pending" });
  });
});
