jest.mock("../../utils/rmab", () => ({
  exchangeLoginToken: jest.fn(),
  readRmabConfig: jest.fn(),
  writeRmabConfig: jest.fn(),
  // Real implementation: apiToken presence decides the mode.
  rmabAuthMode: (cfg: any) => (cfg ? (cfg.apiToken ? "apiToken" : "jwt") : null),
  getMe: jest.fn(),
  createRequest: jest.fn(),
  getPendingApprovalCount: jest.fn().mockResolvedValue(0),
  listMyRequests: jest.fn().mockResolvedValue([]),
  clearRmabCaches: jest.fn(),
  setRmabSessionDeadHandler: jest.fn(),
}));

import { useRmabStore } from "../../store/useRmabStore";
import {
  exchangeLoginToken,
  readRmabConfig,
  writeRmabConfig,
  getMe,
  createRequest,
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

describe("dead-session self-heal wiring", () => {
  const { setRmabSessionDeadHandler } = require("../../utils/rmab");

  it("initialize registers a handler that disconnects the store (Discover drops)", () => {
    mockedRead.mockReturnValue(CFG);
    useRmabStore.getState().initialize();
    expect(setRmabSessionDeadHandler).toHaveBeenCalled();
    const handler = (setRmabSessionDeadHandler as jest.Mock).mock.calls.at(-1)![0];
    expect(useRmabStore.getState().configured).toBe(true);
    // Firing it (as a definitively-rejected refresh would) tears the session
    // down: configured flips false and the persisted config is cleared.
    handler();
    expect(useRmabStore.getState().configured).toBe(false);
    expect(mockedWrite).toHaveBeenLastCalledWith(null);
  });
});

describe("connect", () => {
  it("exchanges the token, verifies with an authed call, persists", async () => {
    mockedExchange.mockResolvedValue(CFG);
    mockedMe.mockResolvedValue({ user: {} });
    const ok = await useRmabStore.getState().connect("https://rmab.test", "tok");
    expect(ok).toBe(true);
    expect(mockedWrite).toHaveBeenCalledWith(CFG);
    const s = useRmabStore.getState();
    expect(s.configured).toBe(true);
    expect(s.username).toBe("tony");
    expect(s.authMode).toBe("jwt");
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
