jest.mock("../../utils/rmab", () => ({
  exchangeLoginToken: jest.fn(),
  readRmabConfig: jest.fn(),
  writeRmabConfig: jest.fn(),
  getMe: jest.fn(),
  createRequest: jest.fn(),
}));

import { useRmabStore } from "../../store/useRmabStore";
import {
  exchangeLoginToken,
  readRmabConfig,
  writeRmabConfig,
  getMe,
  createRequest,
} from "../../utils/rmab";

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
    expect(mockedWrite).toHaveBeenCalledWith(CFG);
    const s = useRmabStore.getState();
    expect(s.configured).toBe(true);
    expect(s.username).toBe("tony");
    expect(s.connectError).toBeNull();
  });

  it("bad token → friendly error, config wiped", async () => {
    mockedExchange.mockRejectedValue({ response: { status: 401 } });
    const ok = await useRmabStore.getState().connect("https://rmab.test", "bad");
    expect(ok).toBe(false);
    expect(mockedWrite).toHaveBeenCalledWith(null);
    expect(useRmabStore.getState().connectError).toBe("Invalid login token");
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

  it("generic failures report a request failure", async () => {
    mockedCreate.mockRejectedValue(new Error("boom"));
    const res = await useRmabStore.getState().requestBook(BOOK);
    expect(res).toEqual({ ok: false, message: "Request failed" });
  });
});
