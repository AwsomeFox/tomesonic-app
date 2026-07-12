/**
 * useRmabStore restore-path contracts:
 *  - the persisted `rmab_requestedAsins` map is HOSTILE-INPUT territory (it's
 *    a raw JSON blob on disk; a bad backup restore or crafted value must not
 *    pollute Object.prototype or leak non-string junk into UI state), and
 *  - configs persisted by OLDER app versions (no authProvider field) must
 *    still infer a provider so session-expiry re-login routes correctly.
 * Mock setup mirrors __tests__/store/useRmabStore.test.ts.
 */
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
import { readRmabConfig } from "../../utils/rmab";
// Real in-memory MMKV (jest.setup.ts) — the store lazy-requires this module.
import { storage } from "../../utils/storage";

const { listMyRequests: mockedListMyRequests } = require("../../utils/rmab");

const initial = useRmabStore.getState();
const mockedRead = readRmabConfig as jest.Mock;

const CFG = {
  url: "https://rmab.test",
  accessToken: "a",
  refreshToken: "r",
  user: { id: "u1", username: "tony" },
};

beforeEach(async () => {
  useRmabStore.setState(initial, true);
  storage.remove("rmab_requestedAsins");
  jest.clearAllMocks();
  (mockedListMyRequests as jest.Mock).mockReset().mockResolvedValue([]);
  await new Promise((r) => setImmediate(r));
});

describe("requestedAsins hostile-restore", () => {
  it('a persisted "__proto__" key is dropped and Object.prototype stays clean', () => {
    // JSON.parse creates __proto__ as an OWN property (no setter invoked) —
    // the danger is downstream: spreading/assigning it into a plain object
    // would rewrite that object's prototype.
    storage.set(
      "rmab_requestedAsins",
      '{"__proto__":{"polluted":"yes"},"B001TEST":"pending"}'
    );
    mockedRead.mockReturnValue(CFG);

    useRmabStore.getState().initialize();

    const s = useRmabStore.getState();
    expect(Object.keys(s.requestedAsins)).toEqual(["B001TEST"]);
    expect(s.requestedAsins.B001TEST).toBe("pending");
    // No pollution: neither the global prototype nor fresh objects grew keys.
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    // And spreading the restored map (as selectors/actions do) stays safe.
    const spread = { ...s.requestedAsins };
    expect(Object.getPrototypeOf(spread)).toBe(Object.prototype);
    expect((spread as any).polluted).toBeUndefined();
  });

  it("non-string values are filtered out of the restored map", () => {
    storage.set(
      "rmab_requestedAsins",
      JSON.stringify({ B1: "pending", B2: 42, B3: null, B4: { nested: true }, B5: "downloaded" })
    );
    mockedRead.mockReturnValue(CFG);

    useRmabStore.getState().initialize();

    expect(useRmabStore.getState().requestedAsins).toEqual({
      B1: "pending",
      B5: "downloaded",
    });
  });

  it("a persisted ARRAY is rejected (shape guard) → empty map", () => {
    storage.set("rmab_requestedAsins", JSON.stringify(["B1", "B2"]));
    mockedRead.mockReturnValue(CFG);
    useRmabStore.getState().initialize();
    expect(useRmabStore.getState().requestedAsins).toEqual({});
  });

  it("corrupt JSON (torn write) never throws → empty map, store still configures", () => {
    storage.set("rmab_requestedAsins", '{"B1":"pend');
    mockedRead.mockReturnValue(CFG);
    expect(() => useRmabStore.getState().initialize()).not.toThrow();
    const s = useRmabStore.getState();
    expect(s.requestedAsins).toEqual({});
    expect(s.configured).toBe(true);
  });
});

describe("authProvider migration (configs persisted before the field existed)", () => {
  it("an old JWT config (no authProvider, no apiToken) infers 'loginToken'", () => {
    mockedRead.mockReturnValue({ ...CFG }); // no authProvider field
    useRmabStore.getState().initialize();
    const s = useRmabStore.getState();
    expect(s.authProvider).toBe("loginToken");
    expect(s.authMode).toBe("jwt");
  });

  it("an old API-token config (no authProvider) infers 'apiToken'", () => {
    mockedRead.mockReturnValue({ url: CFG.url, apiToken: "static-key", user: CFG.user });
    useRmabStore.getState().initialize();
    const s = useRmabStore.getState();
    expect(s.authProvider).toBe("apiToken");
    expect(s.authMode).toBe("apiToken");
  });

  it("an explicit persisted authProvider is preserved verbatim (no re-inference)", () => {
    mockedRead.mockReturnValue({ ...CFG, authProvider: "oidc" });
    useRmabStore.getState().initialize();
    expect(useRmabStore.getState().authProvider).toBe("oidc");
  });
});
