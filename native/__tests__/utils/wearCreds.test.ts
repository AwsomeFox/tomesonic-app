/**
 * PHONE → WATCH creds mirror. The native WearBridge module is absent on iOS,
 * under jest and on any build without it, so the wrapper must be a silent
 * no-op everywhere except a real Android build — and `utils/autoCreds` (the
 * single write path for credentials) must actually drive it, or the watch app
 * never learns about a login/logout.
 */
import { NativeModules, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { pushWearCreds, clearWearCreds } from "../../utils/wearCreds";
import { writeAutoCreds } from "../../utils/autoCreds";

const origOS = Platform.OS;

const injectBridge = () => {
  const putCreds = jest.fn().mockResolvedValue(true);
  const clearCreds = jest.fn().mockResolvedValue(true);
  (Platform as any).OS = "android";
  (NativeModules as any).WearBridge = { putCreds, clearCreds };
  return { putCreds, clearCreds };
};

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  (Platform as any).OS = origOS;
  delete (NativeModules as any).WearBridge;
  // Restore the console spy so a leaked mock can't swallow warnings in other
  // test files that share this worker.
  jest.restoreAllMocks();
});

describe("pushWearCreds / clearWearCreds", () => {
  it("pushes server + token through the native module (userId/username default to \"\")", () => {
    const { putCreds, clearCreds } = injectBridge();
    pushWearCreds({ server: "http://abs.local", token: "tok" });
    // Positional args — the Kotlin side reads them in this order.
    expect(putCreds).toHaveBeenCalledWith("http://abs.local", "tok", "", "");
    expect(clearCreds).not.toHaveBeenCalled();
  });

  it("passes userId/username when the caller has them", () => {
    const { putCreds } = injectBridge();
    pushWearCreds({ server: "http://abs.local", token: "tok", userId: "u1", username: "tony" });
    expect(putCreds).toHaveBeenCalledWith("http://abs.local", "tok", "u1", "tony");
  });

  it("clears through clearCreds (native puts empty strings, never a delete)", () => {
    const { putCreds, clearCreds } = injectBridge();
    clearWearCreds();
    expect(clearCreds).toHaveBeenCalledTimes(1);
    expect(putCreds).not.toHaveBeenCalled();
  });

  it("no-ops (without throwing) when the native module isn't present", () => {
    (Platform as any).OS = "android";
    expect(() => pushWearCreds({ server: "s", token: "t" })).not.toThrow();
    expect(() => clearWearCreds()).not.toThrow();
  });

  it("no-ops on iOS even if something registered the module", () => {
    const { putCreds, clearCreds } = injectBridge();
    (Platform as any).OS = "ios";
    pushWearCreds({ server: "s", token: "t" });
    clearWearCreds();
    expect(putCreds).not.toHaveBeenCalled();
    expect(clearCreds).not.toHaveBeenCalled();
  });

  it("ignores a module missing the methods", () => {
    (Platform as any).OS = "android";
    (NativeModules as any).WearBridge = {};
    expect(() => pushWearCreds({ server: "s", token: "t" })).not.toThrow();
    expect(() => clearWearCreds()).not.toThrow();
  });

  it("swallows a throwing native method and a rejected promise", async () => {
    (Platform as any).OS = "android";
    (NativeModules as any).WearBridge = {
      putCreds: () => {
        throw new Error("boom");
      },
      clearCreds: () => Promise.reject(new Error("no play services")),
    };
    expect(() => pushWearCreds({ server: "s", token: "t" })).not.toThrow();
    expect(() => clearWearCreds()).not.toThrow();
    await Promise.resolve();
    expect(console.warn).toHaveBeenCalled();
  });
});

// The mirror hangs off the ONE function that writes auto_creds.json, so every
// login / token refresh / library switch feeds the watch for free.
describe("autoCreds write path drives the watch mirror", () => {
  const getInfo = FileSystem.getInfoAsync as jest.Mock;
  const readStr = FileSystem.readAsStringAsync as jest.Mock;
  const writeStr = FileSystem.writeAsStringAsync as jest.Mock;
  const del = FileSystem.deleteAsync as jest.Mock;
  const move = FileSystem.moveAsync as jest.Mock;

  beforeEach(() => {
    getInfo.mockResolvedValue({ exists: false });
    readStr.mockResolvedValue("");
    writeStr.mockResolvedValue(undefined);
    del.mockResolvedValue(undefined);
    move.mockResolvedValue(undefined);
  });

  it("writeAutoCreds pushes the SAME server + token it writes to the file", async () => {
    const { putCreds } = injectBridge();
    await writeAutoCreds("http://abs.local/", "tok", "lib1", "refresh1", true);
    // Trailing slash stripped, refresh token deliberately NOT forwarded.
    expect(putCreds).toHaveBeenCalledWith("http://abs.local", "tok", "", "");
  });

  it("mirrors the token the file actually kept, not the caller's stale one", async () => {
    const { putCreds } = injectBridge();
    // File holds a natively-rotated pair; an untrusted write keeps it.
    getInfo.mockResolvedValue({ exists: true });
    readStr.mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "t_rotated", refreshToken: "r_rotated" })
    );
    await writeAutoCreds("http://abs.local", "t_stale", "lib2", "r_stale");
    expect(putCreds).toHaveBeenCalledWith("http://abs.local", "t_rotated", "", "");
  });

  it("logout (no address/token) clears the watch instead of pushing", async () => {
    const { putCreds, clearCreds } = injectBridge();
    await writeAutoCreds(null, null);
    expect(clearCreds).toHaveBeenCalledTimes(1);
    expect(putCreds).not.toHaveBeenCalled();
  });

  it("stays a no-op when the native module is missing (jest/iOS/older builds)", async () => {
    await expect(writeAutoCreds("http://abs.local", "tok")).resolves.toBeUndefined();
    await expect(writeAutoCreds(null, null)).resolves.toBeUndefined();
  });
});
