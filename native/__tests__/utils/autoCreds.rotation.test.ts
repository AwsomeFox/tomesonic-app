/**
 * REGRESSION: refresh-token rotation vs mirror-only writes.
 *
 * ABS rotates refresh tokens on every /auth/refresh, and the NATIVE Android
 * Auto service refreshes on its own while JS is backgrounded — after a drive,
 * auto_creds.json can hold the ONLY valid token pair. An untrusted (mirror-
 * only) writeAutoCreds — e.g. a library switch writing the secure store's
 * now-stale pair — used to clobber that rotated pair, killing the recovery
 * path and forcing a logout on the next 401.
 */
import * as FileSystem from "expo-file-system/legacy";
import { writeAutoCreds } from "../../utils/autoCreds";

const getInfo = FileSystem.getInfoAsync as jest.Mock;
const readStr = FileSystem.readAsStringAsync as jest.Mock;
const writeStr = FileSystem.writeAsStringAsync as jest.Mock;

const lastWrittenJson = () => JSON.parse(writeStr.mock.calls[writeStr.mock.calls.length - 1][1]);

const fileHolds = (creds: any) => {
  getInfo.mockResolvedValue({ exists: true });
  readStr.mockResolvedValue(JSON.stringify(creds));
};

beforeEach(() => {
  getInfo.mockResolvedValue({ exists: false });
  readStr.mockResolvedValue("");
  writeStr.mockResolvedValue(undefined);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("writeAutoCreds — token rotation safety", () => {
  it("an UNTRUSTED write preserves the file's rotated pair (library switch after a drive)", async () => {
    fileHolds({ server: "http://abs.local", token: "t_rotated", refreshToken: "r_rotated" });

    // Library switch mirrors the secure store's STALE pair (default trust).
    await writeAutoCreds("http://abs.local", "t_stale", "lib2", "r_stale");

    const written = lastWrittenJson();
    expect(written.refreshToken).toBe("r_rotated"); // NOT downgraded
    expect(written.token).toBe("t_rotated"); // pair kept together
    expect(written.libraryId).toBe("lib2"); // metadata still updates
  });

  it("a TRUSTED write (fresh login / just-refreshed) overwrites the pair", async () => {
    fileHolds({ server: "http://abs.local", token: "t_old", refreshToken: "r_old" });

    await writeAutoCreds("http://abs.local", "t_new", "lib1", "r_new", true);

    const written = lastWrittenJson();
    expect(written.token).toBe("t_new");
    expect(written.refreshToken).toBe("r_new");
  });

  it("an untrusted write for a DIFFERENT server does not inherit the old server's pair", async () => {
    fileHolds({ server: "http://old.local", token: "t_old", refreshToken: "r_old" });

    await writeAutoCreds("http://new.local", "t_new", "libX", "r_new");

    const written = lastWrittenJson();
    expect(written.server).toBe("http://new.local");
    expect(written.token).toBe("t_new");
    expect(written.refreshToken).toBe("r_new");
  });

  it("never DROPS an existing refresh token when the caller passes none", async () => {
    fileHolds({ server: "http://abs.local", token: "t1", refreshToken: "r1" });

    await writeAutoCreds("http://abs.local", "t2", "lib1", null);

    expect(lastWrittenJson().refreshToken).toBe("r1");
  });

  it("writes the provided pair when no file exists yet", async () => {
    await writeAutoCreds("http://abs.local", "t1", "lib1", "r1");

    const written = lastWrittenJson();
    expect(written).toEqual({
      server: "http://abs.local",
      token: "t1",
      refreshToken: "r1",
      libraryId: "lib1",
    });
  });
});
