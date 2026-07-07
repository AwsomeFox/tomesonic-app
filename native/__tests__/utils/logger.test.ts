import { appLogger } from "../../utils/logger";

describe("appLogger", () => {
  beforeEach(() => {
    appLogger.clearLogs();
  });

  it("records info/warn/error entries with level, message, tag and timestamp", () => {
    appLogger.info("hello", "Tag1");
    appLogger.warn("careful");
    appLogger.error("boom", "Tag2");

    const logs = appLogger.getLogs();
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ level: "INFO", message: "hello", tag: "Tag1" });
    expect(logs[1]).toMatchObject({ level: "WARN", message: "careful", tag: undefined });
    expect(logs[2]).toMatchObject({ level: "ERROR", message: "boom", tag: "Tag2" });
    // ISO timestamp
    expect(new Date(logs[0].timestamp).toISOString()).toBe(logs[0].timestamp);
  });

  it("getLogs returns a copy (mutations don't affect internal state)", () => {
    appLogger.info("a");
    const logs = appLogger.getLogs();
    logs.pop();
    expect(appLogger.getLogs()).toHaveLength(1);
  });

  it("caps the buffer at 500 entries, dropping the oldest", () => {
    for (let i = 0; i < 505; i++) appLogger.info(`msg ${i}`);
    const logs = appLogger.getLogs();
    expect(logs).toHaveLength(500);
    expect(logs[0].message).toBe("msg 5");
    expect(logs[499].message).toBe("msg 504");
  });

  it("clearLogs empties the buffer", () => {
    appLogger.info("a");
    appLogger.clearLogs();
    expect(appLogger.getLogs()).toHaveLength(0);
  });

  it("notifies listeners on every entry and stops after unsubscribe", () => {
    const seen: string[] = [];
    const unsub = appLogger.addListener((e) => seen.push(`${e.level}:${e.message}`));

    appLogger.info("one");
    appLogger.error("two");
    expect(seen).toEqual(["INFO:one", "ERROR:two"]);

    unsub();
    appLogger.warn("three");
    expect(seen).toEqual(["INFO:one", "ERROR:two"]);

    // Unsubscribing twice is harmless
    expect(() => unsub()).not.toThrow();
  });
});

describe("secret redaction at write time", () => {
  const { appLogger } = require("../../utils/logger");
  it("redacts token query params and bearer/refresh headers regardless of display masking", () => {
    appLogger.clearLogs();
    appLogger.info("GET https://abs.example/api/items/x/cover?width=200&token=SECRETTOKEN123");
    // base64url JWT with padding + slash/plus refresh token — the narrow char
    // class used to leave the tail unredacted.
    appLogger.warn('headers { authorization: "Bearer eyJhbGci.eyJz+b/dy==", x-refresh-token: rt_99=/+88 }');
    const msgs = appLogger.getLogs().map((e: any) => e.message);
    expect(msgs[0]).toContain("token=[REDACTED]");
    expect(msgs[0]).not.toContain("SECRETTOKEN123");
    expect(msgs[1]).not.toContain("eyJz+b/dy==");
    expect(msgs[1]).not.toContain("rt_99=/+88");
  });
});
