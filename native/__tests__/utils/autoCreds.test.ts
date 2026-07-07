import * as FileSystem from "expo-file-system/legacy";
import {
  readAutoCreds,
  writeAutoCreds,
  writeAutoDownloads,
  writeWidgetState,
} from "../../utils/autoCreds";

const CREDS_PATH = "file:///test-documents/auto_creds.json";
const DOWNLOADS_PATH = "file:///test-documents/auto_downloads.json";
const WIDGET_PATH = "file:///test-documents/widget_state.json";

const getInfo = FileSystem.getInfoAsync as jest.Mock;
const readStr = FileSystem.readAsStringAsync as jest.Mock;
const writeStr = FileSystem.writeAsStringAsync as jest.Mock;
const del = FileSystem.deleteAsync as jest.Mock;

const lastWrittenJson = () => JSON.parse(writeStr.mock.calls[writeStr.mock.calls.length - 1][1]);

beforeEach(() => {
  getInfo.mockResolvedValue({ exists: false });
  readStr.mockResolvedValue("");
  writeStr.mockResolvedValue(undefined);
  del.mockResolvedValue(undefined);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("readAutoCreds", () => {
  it("returns null when the file doesn't exist", async () => {
    expect(await readAutoCreds()).toBeNull();
    expect(readStr).not.toHaveBeenCalled();
  });

  it("parses a valid creds file", async () => {
    getInfo.mockResolvedValue({ exists: true });
    readStr.mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "t", refreshToken: "r", libraryId: "L" })
    );
    expect(await readAutoCreds()).toEqual({
      server: "http://abs.local",
      token: "t",
      refreshToken: "r",
      libraryId: "L",
    });
    expect(readStr).toHaveBeenCalledWith(CREDS_PATH);
  });

  it("returns null when server or token is missing", async () => {
    getInfo.mockResolvedValue({ exists: true });
    readStr.mockResolvedValue(JSON.stringify({ server: "http://abs.local" }));
    expect(await readAutoCreds()).toBeNull();
    readStr.mockResolvedValue(JSON.stringify({ token: "t" }));
    expect(await readAutoCreds()).toBeNull();
  });

  it("returns null on corrupt JSON / read errors", async () => {
    getInfo.mockResolvedValue({ exists: true });
    readStr.mockResolvedValue("{corrupt");
    expect(await readAutoCreds()).toBeNull();

    readStr.mockRejectedValue(new Error("io"));
    expect(await readAutoCreds()).toBeNull();
  });

  // The atomic write deletes the main file before renaming the temp into
  // place — a kill between those steps leaves ONLY the fully-written temp.
  it("promotes the temp file when the main file is missing (crash-window recovery)", async () => {
    const move = FileSystem.moveAsync as jest.Mock;
    getInfo.mockImplementation(async (path: string) => ({
      exists: path === `${CREDS_PATH}.tmp`, // main gone, temp present
    }));
    readStr.mockResolvedValue(JSON.stringify({ server: "http://abs.local", token: "t" }));

    expect(await readAutoCreds()).toEqual({ server: "http://abs.local", token: "t" });
    expect(move).toHaveBeenCalledWith({ from: `${CREDS_PATH}.tmp`, to: CREDS_PATH });
  });

  it("recovers from the temp when the main file exists but is corrupt", async () => {
    const move = FileSystem.moveAsync as jest.Mock;
    getInfo.mockResolvedValue({ exists: true }); // both files present
    readStr.mockImplementation(async (path: string) =>
      path === CREDS_PATH
        ? "{torn-mid-write" // interrupted direct-write fallback
        : JSON.stringify({ server: "http://abs.local", token: "t2" })
    );

    expect(await readAutoCreds()).toEqual({ server: "http://abs.local", token: "t2" });
    // Promoted over the corrupt main: delete then rename.
    expect(del).toHaveBeenCalledWith(CREDS_PATH, { idempotent: true });
    expect(move).toHaveBeenCalledWith({ from: `${CREDS_PATH}.tmp`, to: CREDS_PATH });
  });

  it("returns null when both the main file and the temp are missing", async () => {
    const move = FileSystem.moveAsync as jest.Mock;
    getInfo.mockResolvedValue({ exists: false });
    expect(await readAutoCreds()).toBeNull();
    expect(move).not.toHaveBeenCalled();
    expect(readStr).not.toHaveBeenCalled();
  });
});

describe("writeAutoCreds", () => {
  it("writes server (trailing slash stripped) + token, omitting absent fields", async () => {
    const move = FileSystem.moveAsync as jest.Mock;
    await writeAutoCreds("http://abs.local/", "tok");
    // Atomic write: content lands in the temp, which is then renamed over the
    // (pre-deleted) destination — never an in-place write of the main file.
    expect(writeStr).toHaveBeenCalledWith(`${CREDS_PATH}.tmp`, expect.any(String));
    expect(del).toHaveBeenCalledWith(CREDS_PATH, { idempotent: true });
    expect(move).toHaveBeenCalledWith({ from: `${CREDS_PATH}.tmp`, to: CREDS_PATH });
    expect(lastWrittenJson()).toEqual({ server: "http://abs.local", token: "tok" });
  });

  it("includes refreshToken and libraryId when provided", async () => {
    await writeAutoCreds("http://abs.local", "tok", "lib1", "refresh1");
    expect(lastWrittenJson()).toEqual({
      server: "http://abs.local",
      token: "tok",
      refreshToken: "refresh1",
      libraryId: "lib1",
    });
  });

  it("preserves the existing libraryId for the same server when none is passed", async () => {
    getInfo.mockResolvedValue({ exists: true });
    readStr.mockResolvedValue(
      JSON.stringify({ server: "http://abs.local", token: "old", libraryId: "keep-me" })
    );
    await writeAutoCreds("http://abs.local", "newTok");
    expect(lastWrittenJson()).toEqual({
      server: "http://abs.local",
      token: "newTok",
      libraryId: "keep-me",
    });
  });

  it("does NOT carry a libraryId over from a different server", async () => {
    getInfo.mockResolvedValue({ exists: true });
    readStr.mockResolvedValue(
      JSON.stringify({ server: "http://other.host", token: "old", libraryId: "not-mine" })
    );
    await writeAutoCreds("http://abs.local", "newTok");
    expect(lastWrittenJson()).toEqual({ server: "http://abs.local", token: "newTok" });
  });

  it("deletes the creds file when address/token are missing (logout)", async () => {
    await writeAutoCreds(null, null);
    expect(del).toHaveBeenCalledWith(CREDS_PATH, { idempotent: true });
    expect(writeStr).not.toHaveBeenCalled();

    del.mockClear();
    await writeAutoCreds("http://abs.local", null);
    expect(del).toHaveBeenCalledWith(CREDS_PATH, { idempotent: true });
  });

  it("swallows write failures with a warning", async () => {
    writeStr.mockRejectedValue(new Error("disk io"));
    await expect(writeAutoCreds("http://abs.local", "tok")).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("[AutoCreds] write failed", expect.any(Error));
  });
});

describe("writeAutoDownloads", () => {
  const entry = {
    id: "a",
    title: "The Test Book",
    author: "Test Author",
    folder: "file:///data/dl/a/",
    coverPath: "file:///data/dl/a/cover.jpg",
    currentTime: 42,
    duration: 180,
    tracks: [{ filename: "track_0.mp3", startOffset: 0, duration: 180 }],
  };

  it("writes the rich entries as JSON (native offline browse reads these)", async () => {
    await writeAutoDownloads([entry]);
    expect(writeStr).toHaveBeenCalledWith(`${DOWNLOADS_PATH}.tmp`, JSON.stringify([entry]));
    expect(FileSystem.moveAsync).toHaveBeenCalledWith({ from: `${DOWNLOADS_PATH}.tmp`, to: DOWNLOADS_PATH });
  });

  it("writes an empty array for falsy input", async () => {
    await writeAutoDownloads(undefined as any);
    expect(writeStr).toHaveBeenCalledWith(`${DOWNLOADS_PATH}.tmp`, "[]");
  });

  it("swallows failures with a warning", async () => {
    writeStr.mockRejectedValue(new Error("io"));
    await expect(writeAutoDownloads([entry])).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("[AutoCreds] downloads write failed", expect.any(Error));
  });
});

describe("writeWidgetState", () => {
  it("writes the state when a title is present", async () => {
    await writeWidgetState({ title: "Dune", author: "Frank Herbert" });
    expect(writeStr).toHaveBeenCalledWith(
      `${WIDGET_PATH}.tmp`,
      JSON.stringify({ title: "Dune", author: "Frank Herbert" })
    );
  });

  it("includes itemId when provided (Android Auto resumption reads it)", async () => {
    await writeWidgetState({ title: "Dune", author: "Frank Herbert", itemId: "li_123" });
    expect(lastWrittenJson()).toEqual({ title: "Dune", author: "Frank Herbert", itemId: "li_123" });
  });

  it("deletes the state file for null or title-less state", async () => {
    await writeWidgetState(null);
    expect(del).toHaveBeenCalledWith(WIDGET_PATH, { idempotent: true });
    // Also the temp: the native readers fall back to .tmp when the main file
    // is missing, so a stale temp would resurrect the cleared state.
    expect(del).toHaveBeenCalledWith(`${WIDGET_PATH}.tmp`, { idempotent: true });

    del.mockClear();
    await writeWidgetState({ author: "nobody" } as any);
    expect(del).toHaveBeenCalledWith(WIDGET_PATH, { idempotent: true });
    expect(writeStr).not.toHaveBeenCalled();
  });

  it("swallows failures with a warning", async () => {
    writeStr.mockRejectedValue(new Error("io"));
    await expect(writeWidgetState({ title: "T" })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("[Widget] state write failed", expect.any(Error));
  });
});
