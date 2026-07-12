import * as FileSystem from "expo-file-system/legacy";
import { downloader, autoDownloadNextAfterFinish } from "../../utils/downloader";
import { downloadNotifications } from "../../utils/downloadNotifications";
import { api } from "../../utils/api";
import { useDownloadStore } from "../../store/useDownloadStore";
import { useUserStore } from "../../store/useUserStore";
import { storageHelper, secureStorage } from "../../utils/storage";
import { dbStorage } from "../../utils/db";

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

jest.mock("../../utils/downloadNotifications", () => ({
  downloadNotifications: {
    start: jest.fn(),
    progress: jest.fn(),
    complete: jest.fn(),
    clear: jest.fn(),
  },
}));

const mockedApiGet = jest.mocked(api.get);
const notifications = jest.mocked(downloadNotifications);
const createResumable = FileSystem.createDownloadResumable as jest.Mock;

const initialDownloadState = useDownloadStore.getState();
const initialUserState = useUserStore.getState();

// Per-test controllable download behavior: url -> result factory.
let downloadImpl: (url: string, dest: string) => Promise<any>;
// Every resumable created, in creation order, with its captured args.
let resumables: Array<{
  url: string;
  dest: string;
  options: any;
  callback: any;
  cancelAsync: jest.Mock;
}>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushAsync = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await flushAsync();
  expect(cond()).toBe(true);
};

beforeEach(() => {
  useDownloadStore.setState(initialDownloadState, true);
  useUserStore.setState(initialUserState, true);
  dbStorage.getAllKeys().forEach((k) => dbStorage.remove(k));
  secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));

  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});

  resumables = [];
  downloadImpl = async () => ({ uri: "file:///done", status: 200 });
  createResumable.mockImplementation((url: string, dest: string, options: any, callback: any) => {
    const entry = {
      url,
      dest,
      options,
      callback,
      cancelAsync: jest.fn().mockResolvedValue(undefined),
      pauseAsync: jest.fn(),
      downloadAsync: jest.fn(() => downloadImpl(url, dest)),
    };
    resumables.push(entry);
    return entry;
  });
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
  (FileSystem.makeDirectoryAsync as jest.Mock).mockResolvedValue(undefined);
  (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
  (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([]);
  (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024);
  mockedApiGet.mockResolvedValue({ data: {} } as any);
});

const SERVER = "http://abs.local";
const TOKEN = "tok1";

const fullItem = () => ({
  id: "book1",
  libraryId: "lib1",
  media: {
    coverPath: "/metadata/items/book1/cover.jpg",
    chapters: [{ id: 0, title: "Ch 1" }],
    ebookFile: { ebookFormat: "epub", metadata: { size: 111 } },
    tracks: [
      {
        index: 1,
        contentUrl: "/api/items/book1/file/1",
        metadata: { ext: ".mp3", size: 1000 },
        duration: 100,
        startOffset: 0,
      },
      {
        index: 2,
        contentUrl: "/api/items/book1/file/2",
        metadata: { ext: ".m4b", size: 2000 },
        duration: 200,
        startOffset: 100,
      },
    ],
    metadata: { title: "My Book", authorName: "The Author" },
  },
});

describe("downloadBook — part list construction", () => {
  it("builds cover/ebook/track parts with correct ids, filenames and urls, then completes", async () => {
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);

    const done = useDownloadStore.getState().completedDownloads["book1"];
    expect(done).toBeTruthy();
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(1);
    expect(done.title).toBe("My Book");
    expect(done.author).toBe("The Author");
    expect(done.localFolderPath).toBe("file:///test-documents/downloads/book1_My_Book/");

    expect(done.parts.map((p) => p.id)).toEqual(["cover", "ebook", "track_1", "track_2"]);
    expect(done.parts.map((p) => p.filename)).toEqual([
      "cover.jpg",
      "book.epub",
      "track_1.mp3",
      "track_2.m4b",
    ]);
    expect(done.parts.map((p) => p.fileSize)).toEqual([0, 111, 1000, 2000]);

    // URLs: cover via coverUrl builder, ebook plain (auth via header), tracks tokenized.
    expect(resumables.map((r) => r.url)).toEqual([
      "http://abs.local/api/items/book1/cover?token=tok1",
      "http://abs.local/api/items/book1/ebook",
      "http://abs.local/api/items/book1/file/1?token=tok1",
      "http://abs.local/api/items/book1/file/2?token=tok1",
    ]);
    // Every part downloads with a Bearer header into the book folder.
    for (const r of resumables) {
      expect(r.options).toEqual({ headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(r.dest.startsWith("file:///test-documents/downloads/book1_My_Book/")).toBe(true);
    }

    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith(
      "file:///test-documents/downloads/book1_My_Book/",
      { intermediates: true }
    );
    expect(notifications.start).toHaveBeenCalledWith("book1", "My Book");
    expect(notifications.complete).toHaveBeenCalledWith("book1", "My Book");
  });

  it("maps offline playback meta: duration falls back to summed track durations", async () => {
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    const done = useDownloadStore.getState().completedDownloads["book1"];
    expect(done.meta).toEqual({
      duration: 300, // media.duration missing -> 100 + 200
      chapters: [{ id: 0, title: "Ch 1" }],
      tracks: [
        { index: 1, filename: "track_1.mp3", duration: 100, startOffset: 0 },
        { index: 2, filename: "track_2.m4b", duration: 200, startOffset: 100 },
      ],
    });
  });

  it("prefers media.duration when present", async () => {
    const item = fullItem();
    (item.media as any).duration = 12345;
    await downloader.downloadBook(item, SERVER, TOKEN);
    expect(useDownloadStore.getState().completedDownloads["book1"].meta!.duration).toBe(12345);
  });

  it("falls back to ino-based track urls, mp3 ext and positional index", async () => {
    const item = {
      id: "book2",
      media: {
        metadata: { title: "T" },
        tracks: [{ ino: "ino9", fileSize: 500, duration: 50 }],
      },
    };
    await downloader.downloadBook(item, SERVER, TOKEN);
    const done = useDownloadStore.getState().completedDownloads["book2"];
    expect(done.parts).toHaveLength(1);
    expect(done.parts[0]).toMatchObject({
      id: "track_0",
      filename: "track_0.mp3",
      fileSize: 500,
    });
    expect(resumables[0].url).toBe("http://abs.local/api/items/book2/file/ino9?token=tok1");
  });

  it("skips the cover part when the url can't be built (no server address)", async () => {
    const item = {
      id: "book3",
      media: {
        coverPath: "/x/cover.png",
        metadata: { title: "T" },
        tracks: [{ index: 1, contentUrl: "/api/items/book3/file/1", duration: 1 }],
      },
    };
    await downloader.downloadBook(item, "", TOKEN);
    const done = useDownloadStore.getState().completedDownloads["book3"];
    expect(done.parts.map((p) => p.id)).toEqual(["track_1"]);
  });

  it("does nothing when there is nothing to download", async () => {
    await downloader.downloadBook({ id: "empty1", media: { metadata: { title: "E" } } }, SERVER, TOKEN);
    expect(useDownloadStore.getState().activeDownloads["empty1"]).toBeUndefined();
    expect(useDownloadStore.getState().completedDownloads["empty1"]).toBeUndefined();
    expect(notifications.start).not.toHaveBeenCalled();
  });
});

describe("downloadEpisode — podcast episode downloads", () => {
  const podcastItem = () => ({
    id: "pod1",
    libraryId: "lib1",
    media: {
      coverPath: "/metadata/items/pod1/cover.jpg",
      metadata: { title: "My Podcast", author: "Podcaster" },
    },
  });

  const episode = () => ({
    id: "ep1",
    title: "Episode One",
    duration: 1800,
    audioTrack: { contentUrl: "/api/items/pod1/file/aud1", metadata: { ext: ".mp3", size: 5000 } },
  });

  it("stores the completed download under the composite `${itemId}::${episodeId}` key", async () => {
    await downloader.downloadEpisode(podcastItem(), episode(), SERVER, TOKEN);

    // Keyed by the composite, NOT the bare podcast id.
    expect(useDownloadStore.getState().completedDownloads["pod1"]).toBeUndefined();
    const done = useDownloadStore.getState().completedDownloads["pod1::ep1"];
    expect(done).toBeTruthy();
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(1);
    expect(done.id).toBe("pod1::ep1");
    expect(done.libraryItemId).toBe("pod1");
    expect(done.episodeId).toBe("ep1");
    expect(done.title).toBe("Episode One");
    expect(done.author).toBe("Podcaster");
    expect(done.localFolderPath).toBe("file:///test-documents/downloads/pod1::ep1_Episode_One/");
  });

  it("builds a cover + single track_0 audio part with the right urls/meta", async () => {
    await downloader.downloadEpisode(podcastItem(), episode(), SERVER, TOKEN);
    const done = useDownloadStore.getState().completedDownloads["pod1::ep1"];

    expect(done.parts.map((p) => p.id)).toEqual(["cover", "track_0"]);
    expect(done.parts.map((p) => p.filename)).toEqual(["cover.jpg", "track_0.mp3"]);
    expect(done.parts.map((p) => p.fileSize)).toEqual([0, 5000]);
    // Single-track meta, same shape a book records (offline builder maps it).
    expect(done.meta).toEqual({
      duration: 1800,
      chapters: [],
      tracks: [{ index: 0, filename: "track_0.mp3", duration: 1800, startOffset: 0 }],
    });
    expect(resumables.map((r) => r.url)).toEqual([
      "http://abs.local/api/items/pod1/cover?token=tok1",
      "http://abs.local/api/items/pod1/file/aud1?token=tok1",
    ]);
    for (const r of resumables) {
      expect(r.options).toEqual({ headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(r.dest.startsWith("file:///test-documents/downloads/pod1::ep1_Episode_One/")).toBe(true);
    }
    expect(notifications.start).toHaveBeenCalledWith("pod1::ep1", "Episode One");
    expect(notifications.complete).toHaveBeenCalledWith("pod1::ep1", "Episode One");
  });

  it("falls back to the ino-based file url + audioFile ext/duration when no audioTrack", async () => {
    const ep = {
      id: "ep2",
      title: "E2",
      audioFile: { ino: "ino5", duration: 600, metadata: { ext: ".m4a", size: 700 } },
    };
    await downloader.downloadEpisode(podcastItem(), ep, SERVER, TOKEN);
    const done = useDownloadStore.getState().completedDownloads["pod1::ep2"];
    expect(done.parts.map((p) => p.id)).toEqual(["cover", "track_0"]);
    expect(done.parts[1]).toMatchObject({ filename: "track_0.m4a", fileSize: 700 });
    expect(done.meta!.tracks[0]).toEqual({ index: 0, filename: "track_0.m4a", duration: 600, startOffset: 0 });
    expect(resumables[1].url).toBe("http://abs.local/api/items/pod1/file/ino5?token=tok1");
  });

  it("ignores a duplicate start while the same episode is already downloading", async () => {
    const gate = deferred<any>();
    downloadImpl = () => gate.promise;

    const first = downloader.downloadEpisode(podcastItem(), episode(), SERVER, TOKEN);
    await until(() => resumables.length === 1);

    await downloader.downloadEpisode(podcastItem(), episode(), SERVER, TOKEN);
    expect(notifications.start).toHaveBeenCalledTimes(1);

    gate.resolve({ uri: "x", status: 200 });
    downloadImpl = async () => ({ uri: "x", status: 200 });
    await first;
    expect(useDownloadStore.getState().completedDownloads["pod1::ep1"]).toBeTruthy();
  });

  it("fails the episode entry (keyed by composite) when a part errors", async () => {
    downloadImpl = async () => ({ uri: "x", status: 500 });
    await downloader.downloadEpisode(podcastItem(), episode(), SERVER, TOKEN);
    const failed = useDownloadStore.getState().activeDownloads["pod1::ep1"];
    expect(failed.status).toBe("failed");
    expect(failed.episodeId).toBe("ep1");
  });

  it("does nothing without an item/episode id", async () => {
    await downloader.downloadEpisode({ media: {} }, { title: "x" }, SERVER, TOKEN);
    expect(notifications.start).not.toHaveBeenCalled();
    expect(resumables).toHaveLength(0);
  });

  it("throws (no invalid /file/ request) when the episode has no contentUrl or ino", async () => {
    // No audioTrack.contentUrl and no audioFile.ino → the ino fallback would be
    // an invalid `/api/items/pod1/file/` endpoint; bail loudly instead so the
    // caller can surface the error rather than 404-ing a download.
    const noAudio = { id: "ep1", title: "Episode One", duration: 1800 };
    await expect(
      downloader.downloadEpisode(podcastItem(), noAudio, SERVER, TOKEN)
    ).rejects.toThrow(/no downloadable audio/i);
    expect(notifications.start).not.toHaveBeenCalled();
    expect(useDownloadStore.getState().completedDownloads["pod1::ep1"]).toBeUndefined();
  });
});

describe("downloadBook — duplicate-start guard", () => {
  it("ignores a second start while a loop is already driving the book", async () => {
    const gate = deferred<any>();
    downloadImpl = () => gate.promise;

    const first = downloader.downloadBook(fullItem(), SERVER, TOKEN);
    await until(() => resumables.length === 1);

    // Second start returns immediately without touching state/notifications.
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    expect(notifications.start).toHaveBeenCalledTimes(1);

    // Release: all remaining parts complete normally.
    gate.resolve({ uri: "x", status: 200 });
    downloadImpl = async () => ({ uri: "x", status: 200 });
    await first;
    expect(useDownloadStore.getState().completedDownloads["book1"]).toBeTruthy();
  });

  it("allows a fresh start after the previous run finished", async () => {
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    // Completed run released the guard; a new download re-drives the book.
    useDownloadStore.setState(initialDownloadState, true);
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    expect(notifications.start).toHaveBeenCalledTimes(2);
  });
});

describe("downloadBook — cancel mid-flight", () => {
  it("stops the loop, aborts the native part and never completes/fails the item", async () => {
    const gate = deferred<any>();
    downloadImpl = () => gate.promise;

    const run = downloader.downloadBook(fullItem(), SERVER, TOKEN);
    await until(() => resumables.length === 1);
    expect(useDownloadStore.getState().activeDownloads["book1"]).toBeTruthy();

    // Store cancel is the single choke point: removes the entry + aborts parts.
    useDownloadStore.getState().cancelDownload("book1");
    await until(() => resumables[0].cancelAsync.mock.calls.length === 1);
    expect(useDownloadStore.getState().activeDownloads["book1"]).toBeUndefined();

    // cancelAsync makes the native downloadAsync resolve undefined.
    gate.resolve(undefined);
    await run;

    expect(useDownloadStore.getState().completedDownloads["book1"]).toBeUndefined();
    expect(useDownloadStore.getState().activeDownloads["book1"]).toBeUndefined();
    expect(notifications.complete).not.toHaveBeenCalled();
    expect(notifications.clear).toHaveBeenCalledWith("book1");
  });

  it("treats an undefined result WITHOUT a cancel as an unexpected stop (fails)", async () => {
    downloadImpl = async () => undefined;
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    const item = useDownloadStore.getState().activeDownloads["book1"];
    expect(item.status).toBe("failed");
    expect(item.error).toContain("stopped unexpectedly");
    expect(notifications.clear).toHaveBeenCalledWith("book1");
  });

  it("late progress callbacks after cancel don't resurrect store state or notifications", async () => {
    const gate = deferred<any>();
    downloadImpl = () => gate.promise;

    const run = downloader.downloadBook(fullItem(), SERVER, TOKEN);
    await until(() => resumables.length === 1);

    // While active, progress flows through to the store + notification.
    resumables[0].callback({ totalBytesWritten: 50, totalBytesExpectedToWrite: 100 });
    expect(notifications.progress).toHaveBeenCalledTimes(1);

    useDownloadStore.getState().cancelDownload("book1");
    notifications.progress.mockClear();

    // A late native callback after cancel must be a no-op.
    resumables[0].callback({ totalBytesWritten: 80, totalBytesExpectedToWrite: 100 });
    expect(notifications.progress).not.toHaveBeenCalled();

    gate.resolve(undefined);
    await run;
  });
});

describe("downloadBook — failure paths", () => {
  it("fails fast with a friendly message when the disk clearly lacks space", async () => {
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(10 * 1024 * 1024);
    const item = fullItem();
    item.media.tracks[0].metadata.size = 500 * 1024 * 1024;

    await downloader.downloadBook(item, SERVER, TOKEN);

    const failed = useDownloadStore.getState().activeDownloads["book1"];
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Not enough storage space on this device");
    expect(resumables).toHaveLength(0); // never started writing
    expect(notifications.clear).toHaveBeenCalledWith("book1");
  });

  it("skips the space preflight when sizes are unknown", async () => {
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(1);
    const item = {
      id: "book4",
      media: { metadata: { title: "T" }, tracks: [{ index: 1, contentUrl: "/f/1", duration: 1 }] },
    };
    await downloader.downloadBook(item, SERVER, TOKEN);
    expect(useDownloadStore.getState().completedDownloads["book4"]).toBeTruthy();
  });

  it("skips the space preflight when the free-space API is unavailable", async () => {
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockRejectedValue(new Error("nope"));
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    expect(useDownloadStore.getState().completedDownloads["book1"]).toBeTruthy();
  });

  it("maps ENOSPC-style errors to the friendly storage message", async () => {
    downloadImpl = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    expect(useDownloadStore.getState().activeDownloads["book1"].error).toBe(
      "Not enough storage space on this device"
    );
  });

  it("keeps other error messages as-is", async () => {
    downloadImpl = async () => {
      throw new Error("Network request failed");
    };
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    expect(useDownloadStore.getState().activeDownloads["book1"].error).toBe(
      "Network request failed"
    );
  });

  it("describes a 404 part response and deletes the garbage body file", async () => {
    downloadImpl = async () => ({ uri: "x", status: 404 });
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    const failed = useDownloadStore.getState().activeDownloads["book1"];
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe('"cover.jpg" was not found on the server');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      "file:///test-documents/downloads/book1_My_Book/cover.jpg",
      { idempotent: true }
    );
  });

  it("describes a 500 part response", async () => {
    downloadImpl = async () => ({ uri: "x", status: 500 });
    await downloader.downloadBook(fullItem(), SERVER, TOKEN);
    expect(useDownloadStore.getState().activeDownloads["book1"].error).toBe(
      'Server returned 500 for "cover.jpg"'
    );
  });
});

describe("downloadBook — 401 auth retry", () => {
  const trackOnlyItem = () => ({
    id: "book5",
    media: {
      metadata: { title: "T5" },
      tracks: [{ index: 1, contentUrl: "/api/items/book5/file/1", duration: 1 }],
    },
  });

  it("refreshes the token via /api/me and retries the part once", async () => {
    // The stored config already carries the refreshed token (as it would after
    // the axios interceptor ran during api.get("/api/me")).
    storageHelper.setServerConfig({ address: SERVER, token: "fresh-tok" });
    let calls = 0;
    downloadImpl = async () => (++calls === 1 ? { uri: "x", status: 401 } : { uri: "x", status: 200 });

    await downloader.downloadBook(trackOnlyItem(), SERVER, TOKEN);

    expect(mockedApiGet).toHaveBeenCalledWith("/api/me");
    expect(resumables).toHaveLength(2);
    expect(resumables[1].url).toBe("http://abs.local/api/items/book5/file/1?token=fresh-tok");
    expect(resumables[1].options.headers.Authorization).toBe("Bearer fresh-tok");
    expect(useDownloadStore.getState().completedDownloads["book5"]).toBeTruthy();
  });

  it("surfaces the original 401 when no refresh happened (same token)", async () => {
    storageHelper.setServerConfig({ address: SERVER, token: TOKEN }); // unchanged
    downloadImpl = async () => ({ uri: "x", status: 401 });

    await downloader.downloadBook(trackOnlyItem(), SERVER, TOKEN);

    expect(resumables).toHaveLength(1); // no retry
    const failed = useDownloadStore.getState().activeDownloads["book5"];
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Not authorized to download");
  });
});

describe("resumeDownload", () => {
  const seedResumable = () => {
    const item: any = {
      id: "r1",
      libraryItemId: "r1",
      title: "Resume Me",
      author: "A",
      coverUrl: "",
      progress: 0.5,
      status: "failed",
      error: "Interrupted",
      parts: [
        {
          id: "track_1",
          filename: "track_1.mp3",
          url: "http://abs.local/api/items/r1/file/1?token=stale",
          bytesDownloaded: 10,
          fileSize: 10,
          completed: true,
          localFilePath: "file:///test-documents/downloads/r1_Resume_Me/track_1.mp3",
        },
        {
          id: "track_2",
          filename: "track_2.mp3",
          url: "http://abs.local/api/items/r1/file/2?token=stale",
          bytesDownloaded: 0,
          fileSize: 10,
          completed: false,
        },
      ],
      // no localFolderPath: exercises the backfill path
    };
    useDownloadStore.setState({ activeDownloads: { r1: item } } as any);
    return item;
  };

  it("downloads only the incomplete parts with a re-tokenized url and completes", async () => {
    const item = seedResumable();
    await downloader.resumeDownload(item, SERVER, "new-tok");

    expect(resumables).toHaveLength(1);
    expect(resumables[0].url).toBe("http://abs.local/api/items/r1/file/2?token=new-tok");
    expect(resumables[0].options.headers.Authorization).toBe("Bearer new-tok");

    const done = useDownloadStore.getState().completedDownloads["r1"];
    expect(done.status).toBe("completed");
    // localFolderPath was backfilled from id+title.
    expect(done.localFolderPath).toBe("file:///test-documents/downloads/r1_Resume_Me/");
    expect(notifications.complete).toHaveBeenCalledWith("r1", "Resume Me");
  });

  it("only preflights free space for the remaining parts", async () => {
    (FileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(
      60 * 1024 * 1024 // enough for 10 bytes + margin, not for a big completed part
    );
    const item = seedResumable();
    item.parts[0].fileSize = 500 * 1024 * 1024; // already completed — must not count
    useDownloadStore.setState({ activeDownloads: { r1: item } } as any);

    await downloader.resumeDownload(item, SERVER, "new-tok");
    expect(useDownloadStore.getState().completedDownloads["r1"]).toBeTruthy();
  });

  it("fails the item when a resumed part errors", async () => {
    const item = seedResumable();
    downloadImpl = async () => ({ uri: "x", status: 500 });
    await downloader.resumeDownload(item, SERVER, "new-tok");
    const failed = useDownloadStore.getState().activeDownloads["r1"];
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe('Server returned 500 for "track_2.mp3"');
  });

  it("ignores a duplicate resume while one is already running", async () => {
    const item = seedResumable();
    const gate = deferred<any>();
    downloadImpl = () => gate.promise;

    const first = downloader.resumeDownload(item, SERVER, "new-tok");
    await until(() => resumables.length === 1);

    await downloader.resumeDownload(item, SERVER, "new-tok"); // double-tapped retry
    expect(resumables).toHaveLength(1); // nothing re-driven

    gate.resolve({ uri: "x", status: 200 });
    await first;
    expect(useDownloadStore.getState().completedDownloads["r1"]).toBeTruthy();
  });

  it("bails out silently when the item was cancelled before resuming", async () => {
    const item = seedResumable();
    useDownloadStore.setState({ activeDownloads: {} } as any); // cancelled elsewhere
    await downloader.resumeDownload(item, SERVER, "new-tok");
    expect(resumables).toHaveLength(0);
    expect(notifications.clear).toHaveBeenCalledWith("r1");
  });
});

describe("sweepOrphanFolders", () => {
  it("deletes folders no download record owns, keeping owned ones", async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([
      "owned1_Title",
      "done1_Other",
      "orphan_folder",
    ]);
    useDownloadStore.setState({
      activeDownloads: { owned1: { id: "owned1" } },
      completedDownloads: { done1: { id: "done1" } },
    } as any);

    await downloader.sweepOrphanFolders();

    // Ignore the auto_downloads.json mirror bookkeeping (atomic-write pre-delete).
    const folderDeletes = (FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      (c) => !String(c[0]).includes("auto_downloads")
    );
    expect(folderDeletes).toHaveLength(1);
    expect(folderDeletes[0][0]).toBe("file:///test-documents/downloads/orphan_folder");
    expect(folderDeletes[0][1]).toEqual({ idempotent: true });
  });

  it("does NOT delete folders owned by ANOTHER account's DB rows (namespace-aware)", async () => {
    // The in-memory store only holds the CURRENT account's downloads, but a
    // folder owned by a DIFFERENT account's persisted row must never be swept.
    const { db } = require("../../utils/db");
    db.saveDownloadItem({
      id: "bBook",
      libraryItemId: "bBook",
      status: "completed",
      parts: [],
      sessionKey: "https://b.example.com::userB",
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([
      "bBook_Family_Book", // owned by account B's DB row — must survive
      "orphan_folder", // owned by nobody — must be deleted
    ]);
    // Current account's store is empty (switched away from A, on B's namespace
    // but bBook isn't loaded in memory in this test).
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} } as any);

    await downloader.sweepOrphanFolders();

    const folderDeletes = (FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      (c) => !String(c[0]).includes("auto_downloads")
    );
    expect(folderDeletes).toHaveLength(1);
    expect(folderDeletes[0][0]).toBe("file:///test-documents/downloads/orphan_folder");
  });

  it("does nothing when the downloads root doesn't exist", async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    await downloader.sweepOrphanFolders();
    expect(FileSystem.readDirectoryAsync).not.toHaveBeenCalled();
    const folderDeletes = (FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      (c) => !String(c[0]).includes("auto_downloads")
    );
    expect(folderDeletes).toHaveLength(0);
  });

  it("survives a failing delete and keeps sweeping", async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue(["orphanA", "orphanB"]);
    (FileSystem.deleteAsync as jest.Mock)
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);

    await expect(downloader.sweepOrphanFolders()).resolves.toBeUndefined();
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
  });
});

describe("abortBookParts / cancelBookDownload", () => {
  it("clears the notification even with no in-flight parts", async () => {
    await downloader.abortBookParts("ghost");
    expect(notifications.clear).toHaveBeenCalledWith("ghost");
  });

  it("keeps going when a part's cancelAsync fails", async () => {
    const gate = deferred<any>();
    downloadImpl = () => gate.promise;
    const run = downloader.downloadBook(fullItem(), SERVER, TOKEN);
    await until(() => resumables.length === 1);
    resumables[0].cancelAsync.mockRejectedValueOnce(new Error("native abort failed"));

    await expect(downloader.abortBookParts("book1")).resolves.toBeUndefined();
    expect(notifications.clear).toHaveBeenCalledWith("book1");

    // The item is still active (abort didn't cancel the store entry), so an
    // undefined result is an unexpected stop -> failed.
    gate.resolve(undefined);
    await run;
    expect(useDownloadStore.getState().activeDownloads["book1"].status).toBe("failed");
  });

  it("cancelBookDownload delegates to the store's cancelDownload", async () => {
    useDownloadStore.setState({
      activeDownloads: {
        c1: { id: "c1", title: "C", parts: [], status: "downloading", progress: 0 },
      },
    } as any);
    await downloader.cancelBookDownload("c1");
    expect(useDownloadStore.getState().activeDownloads["c1"]).toBeUndefined();
  });
});

describe("auto-download next in series (on finish)", () => {
  const seriesItem = () => ({
    id: "s-book1",
    libraryId: "lib1",
    media: {
      metadata: { title: "Series One", series: [{ id: "ser1", sequence: "1" }] },
      tracks: [{ index: 1, contentUrl: "/api/items/s-book1/file/1", duration: 10 }],
    },
  });

  const enableAutoNext = () =>
    useUserStore.setState({
      settings: { ...(initialUserState.settings as any), autoDownloadNextInSeries: true },
    } as any);
  // The finish-triggered path reads server config via getServerConfig().
  const setConfig = () => storageHelper.setServerConfig({ address: SERVER, token: TOKEN });
  // The trigger is gated on the FINISHED book being downloaded.
  const markBook1Downloaded = () =>
    useDownloadStore.setState({
      completedDownloads: { "s-book1": { id: "s-book1", title: "Series One" } },
    } as any);

  const mockSeriesApi = () =>
    mockedApiGet.mockImplementation(async (url: any) => {
      if (url === "/api/items/s-book1?expanded=1") {
        return {
          data: { id: "s-book1", libraryId: "lib1", media: { metadata: { series: [{ id: "ser1", sequence: "1" }] } } },
        } as any;
      }
      if (url === "/api/libraries/lib1/series/ser1") {
        return {
          data: {
            books: [
              { id: "s-book1", media: { metadata: { series: [{ id: "ser1", sequence: "1" }] } } },
              { id: "s-book2", media: { metadata: { series: [{ id: "ser1", sequence: "2" }] } } },
              { id: "s-book3", media: { metadata: { series: [{ id: "ser1", sequence: "3" }] } } },
            ],
          },
        } as any;
      }
      if (url === "/api/items/s-book2?expanded=1") {
        return {
          data: {
            id: "s-book2",
            libraryId: "lib1",
            media: {
              metadata: { title: "Series Two" },
              tracks: [{ index: 1, contentUrl: "/api/items/s-book2/file/1", duration: 10 }],
            },
          },
        } as any;
      }
      return { data: {} } as any;
    });

  it("downloads ONLY the single next book when a downloaded book is finished", async () => {
    enableAutoNext();
    setConfig();
    markBook1Downloaded();
    mockSeriesApi();

    await autoDownloadNextAfterFinish("s-book1");

    expect(useDownloadStore.getState().completedDownloads["s-book2"]).toBeTruthy();
    expect(useDownloadStore.getState().completedDownloads["s-book2"].title).toBe("Series Two");
    // No cascade: book 3 is never fetched even though it's next after book 2.
    expect(mockedApiGet).not.toHaveBeenCalledWith("/api/items/s-book3?expanded=1");
    expect(useDownloadStore.getState().completedDownloads["s-book3"]).toBeFalsy();
  });

  it("resolves each candidate's sequence by the REQUESTED series id, not series[0]", async () => {
    enableAutoNext();
    setConfig();
    markBook1Downloaded();
    // s-book2 belongs to TWO series: its series[0] is an UNRELATED series
    // (sequence 5) while its ser1 sequence is 2 — the true next after book 1.
    // s-book3 is ser1 sequence 3. Reading series[0] would sort/pick book 3
    // (unrelated seq 5 vs book3's 3) and wrongly skip book 2.
    mockedApiGet.mockImplementation(async (url: any) => {
      if (url === "/api/items/s-book1?expanded=1") {
        return { data: { id: "s-book1", libraryId: "lib1", media: { metadata: { series: [{ id: "ser1", sequence: "1" }] } } } } as any;
      }
      if (url === "/api/libraries/lib1/series/ser1") {
        return {
          data: {
            books: [
              { id: "s-book1", media: { metadata: { series: [{ id: "ser1", sequence: "1" }] } } },
              { id: "s-book2", media: { metadata: { series: [{ id: "otherSer", sequence: "5" }, { id: "ser1", sequence: "2" }] } } },
              { id: "s-book3", media: { metadata: { series: [{ id: "ser1", sequence: "3" }] } } },
            ],
          },
        } as any;
      }
      if (url === "/api/items/s-book2?expanded=1") {
        return {
          data: {
            id: "s-book2",
            libraryId: "lib1",
            media: {
              metadata: { title: "Series Two" },
              tracks: [{ index: 1, contentUrl: "/api/items/s-book2/file/1", duration: 10 }],
            },
          },
        } as any;
      }
      return { data: {} } as any;
    });

    await autoDownloadNextAfterFinish("s-book1");

    // Correct next (ser1 seq 2) is book 2 — not book 3.
    expect(mockedApiGet).toHaveBeenCalledWith("/api/items/s-book2?expanded=1");
    expect(mockedApiGet).not.toHaveBeenCalledWith("/api/items/s-book3?expanded=1");
    expect(useDownloadStore.getState().completedDownloads["s-book2"]).toBeTruthy();
    expect(useDownloadStore.getState().completedDownloads["s-book3"]).toBeFalsy();
  });

  it("does NOT trigger on download completion (no cascade)", async () => {
    enableAutoNext();
    setConfig();
    mockSeriesApi();

    await downloader.downloadBook(seriesItem(), SERVER, TOKEN);

    // Finishing the DOWNLOAD must not pull the series.
    expect(mockedApiGet).not.toHaveBeenCalledWith("/api/libraries/lib1/series/ser1");
    expect(Object.keys(useDownloadStore.getState().completedDownloads)).toEqual(["s-book1"]);
  });

  it("does nothing when the setting is off", async () => {
    setConfig();
    markBook1Downloaded();
    mockSeriesApi();
    await autoDownloadNextAfterFinish("s-book1");
    expect(mockedApiGet).not.toHaveBeenCalled();
  });

  it("does nothing when the finished book was not downloaded (streaming-only)", async () => {
    enableAutoNext();
    setConfig();
    mockSeriesApi();
    // s-book1 is NOT in completedDownloads.
    await autoDownloadNextAfterFinish("s-book1");
    expect(mockedApiGet).not.toHaveBeenCalled();
  });

  it("skips when the next book is already downloaded", async () => {
    enableAutoNext();
    setConfig();
    useDownloadStore.setState({
      completedDownloads: { "s-book1": { id: "s-book1" }, "s-book2": { id: "s-book2" } },
    } as any);
    mockedApiGet.mockImplementation(async (url: any) => {
      if (url === "/api/items/s-book1?expanded=1") {
        return { data: { id: "s-book1", libraryId: "lib1", media: { metadata: { series: [{ id: "ser1", sequence: "1" }] } } } } as any;
      }
      if (url === "/api/libraries/lib1/series/ser1") {
        return { data: { books: [{ id: "s-book2", media: { metadata: { series: [{ id: "ser1", sequence: "2" }] } } }] } } as any;
      }
      return { data: {} } as any;
    });
    await autoDownloadNextAfterFinish("s-book1");
    expect(mockedApiGet).not.toHaveBeenCalledWith("/api/items/s-book2?expanded=1");
  });

  it("FALLBACK: with no strictly-next sequence, picks the first not-downloaded/not-active book", async () => {
    // The finished book is the HIGHEST sequence, so no book has sequence >
    // current — the strict-next find fails and the fallback kicks in:
    // sorted.find(!completed && !active). s-book2 (seq 1) is already
    // downloaded, so the fallback must skip it and choose s-book3 (seq 2).
    enableAutoNext();
    setConfig();
    markBook1Downloaded();
    useDownloadStore.setState({
      completedDownloads: {
        "s-book1": { id: "s-book1", title: "Series One" },
        "s-book2": { id: "s-book2", title: "Series Two" },
      },
    } as any);
    mockedApiGet.mockImplementation(async (url: any) => {
      if (url === "/api/items/s-book1?expanded=1") {
        return { data: { id: "s-book1", libraryId: "lib1", media: { metadata: { series: [{ id: "ser1", sequence: "3" }] } } } } as any;
      }
      if (url === "/api/libraries/lib1/series/ser1") {
        return {
          data: {
            books: [
              { id: "s-book1", media: { metadata: { series: [{ id: "ser1", sequence: "3" }] } } },
              { id: "s-book2", media: { metadata: { series: [{ id: "ser1", sequence: "1" }] } } },
              { id: "s-book3", media: { metadata: { series: [{ id: "ser1", sequence: "2" }] } } },
            ],
          },
        } as any;
      }
      if (url === "/api/items/s-book3?expanded=1") {
        return {
          data: {
            id: "s-book3",
            libraryId: "lib1",
            media: {
              metadata: { title: "Series Three" },
              tracks: [{ index: 1, contentUrl: "/api/items/s-book3/file/1", duration: 10 }],
            },
          },
        } as any;
      }
      return { data: {} } as any;
    });

    await autoDownloadNextAfterFinish("s-book1");

    // The already-downloaded s-book2 is skipped; s-book3 is fetched + downloaded.
    expect(mockedApiGet).toHaveBeenCalledWith("/api/items/s-book3?expanded=1");
    expect(mockedApiGet).not.toHaveBeenCalledWith("/api/items/s-book2?expanded=1");
    expect(useDownloadStore.getState().completedDownloads["s-book3"]).toBeTruthy();
    expect(useDownloadStore.getState().completedDownloads["s-book3"].title).toBe("Series Three");
  });

  it("RE-ENTRANCY: a second finish for the same item while one is in flight is a no-op", async () => {
    enableAutoNext();
    setConfig();
    markBook1Downloaded();
    const gate = deferred<void>();
    let book1Fetches = 0;
    mockedApiGet.mockImplementation(async (url: any) => {
      if (url === "/api/items/s-book1?expanded=1") {
        book1Fetches++;
        await gate.promise; // hold the first run in flight (autoNextInFlight set)
        return { data: { id: "s-book1", libraryId: "lib1", media: { metadata: { series: [{ id: "ser1", sequence: "1" }] } } } } as any;
      }
      if (url === "/api/libraries/lib1/series/ser1") {
        return {
          data: {
            books: [
              { id: "s-book1", media: { metadata: { series: [{ id: "ser1", sequence: "1" }] } } },
              { id: "s-book2", media: { metadata: { series: [{ id: "ser1", sequence: "2" }] } } },
            ],
          },
        } as any;
      }
      if (url === "/api/items/s-book2?expanded=1") {
        return {
          data: {
            id: "s-book2",
            libraryId: "lib1",
            media: {
              metadata: { title: "Series Two" },
              tracks: [{ index: 1, contentUrl: "/api/items/s-book2/file/1", duration: 10 }],
            },
          },
        } as any;
      }
      return { data: {} } as any;
    });

    const first = autoDownloadNextAfterFinish("s-book1");
    await until(() => book1Fetches === 1);

    // Second finish for the SAME item while the first is still awaiting: the
    // autoNextInFlight guard must short-circuit it before any further fetch.
    await autoDownloadNextAfterFinish("s-book1");
    expect(book1Fetches).toBe(1);

    gate.resolve();
    await first;
    // The single in-flight run still finishes normally.
    expect(useDownloadStore.getState().completedDownloads["s-book2"]).toBeTruthy();
  });

  it("never throws to the caller on error", async () => {
    enableAutoNext();
    setConfig();
    markBook1Downloaded();
    mockedApiGet.mockRejectedValue(new Error("series fetch broke"));
    await expect(autoDownloadNextAfterFinish("s-book1")).resolves.toBeUndefined();
  });
});

describe("ensureLocalCover — backfill a missing local cover", () => {
  const downloadAsync = FileSystem.downloadAsync as jest.Mock;

  const completedNoCover = () =>
    useDownloadStore.setState({
      completedDownloads: {
        book1: {
          id: "book1",
          libraryItemId: "book1",
          title: "My Book",
          author: "The Author",
          status: "completed",
          progress: 1,
          coverUrl: "",
          localFolderPath: "file:///test-documents/downloads/book1_My_Book/",
          // No cover part — a legacy download.
          parts: [{ id: "track_1", filename: "track_1.mp3", completed: true, bytesDownloaded: 1, fileSize: 1, localFilePath: "file:///x/track_1.mp3" }],
        },
      },
    } as any);

  beforeEach(() => {
    downloadAsync.mockResolvedValue({ uri: "file:///cover", status: 200 });
    storageHelper.setServerConfig({ address: SERVER, token: TOKEN });
  });

  it("fetches only the cover and records it as a completed 'cover' part (persisted)", async () => {
    completedNoCover();
    await downloader.ensureLocalCover("book1");

    // Downloaded exactly once, from the cover url, into the item's local folder,
    // with the Bearer header.
    expect(downloadAsync).toHaveBeenCalledTimes(1);
    const [url, dest, options] = downloadAsync.mock.calls[0];
    expect(url).toBe("http://abs.local/api/items/book1/cover?token=tok1");
    expect(dest).toBe("file:///test-documents/downloads/book1_My_Book/cover.jpg");
    expect(options).toEqual({ headers: { Authorization: `Bearer ${TOKEN}` } });

    const cover = useDownloadStore.getState().completedDownloads["book1"].parts.find(
      (p) => p.id === "cover"
    );
    expect(cover?.localFilePath).toBe("file:///test-documents/downloads/book1_My_Book/cover.jpg");
    expect(cover?.completed).toBe(true);
    // Audio part is untouched.
    expect(
      useDownloadStore.getState().completedDownloads["book1"].parts.some((p) => p.id === "track_1")
    ).toBe(true);
    // Persisted to the download DB so it survives a restart.
    expect(dbStorage.getAllKeys().some((k) => k.includes("book1"))).toBe(true);
  });

  it("no-ops when the item already has a local cover part", async () => {
    useDownloadStore.setState({
      completedDownloads: {
        book1: {
          id: "book1",
          libraryItemId: "book1",
          status: "completed",
          localFolderPath: "file:///x/",
          parts: [{ id: "cover", filename: "cover.jpg", completed: true, bytesDownloaded: 0, fileSize: 0, localFilePath: "file:///x/cover.jpg" }],
        },
      },
    } as any);
    await downloader.ensureLocalCover("book1");
    expect(downloadAsync).not.toHaveBeenCalled();
  });

  it("no-ops offline (no token) — leaves current behavior, no crash", async () => {
    completedNoCover();
    storageHelper.setServerConfig({ address: SERVER, token: "" });
    await expect(downloader.ensureLocalCover("book1")).resolves.toBeUndefined();
    expect(downloadAsync).not.toHaveBeenCalled();
  });

  it("no-ops for an item that isn't a completed download", async () => {
    await expect(downloader.ensureLocalCover("not-downloaded")).resolves.toBeUndefined();
    expect(downloadAsync).not.toHaveBeenCalled();
  });

  it("does not add a cover part when the fetch fails (non-2xx)", async () => {
    completedNoCover();
    downloadAsync.mockResolvedValue({ uri: "file:///err", status: 404 });
    await downloader.ensureLocalCover("book1");
    expect(
      useDownloadStore.getState().completedDownloads["book1"].parts.some((p) => p.id === "cover")
    ).toBe(false);
  });

  it("does NOT resurrect an item removed while the cover fetch was in flight (N2 race)", async () => {
    completedNoCover();
    // Hold the cover fetch open so a removeDownload can land in the gap between
    // the fetch finishing and the store write — the exact window where the old
    // read-modify-write wrote back a stale snapshot and revived a deleted item.
    let resolveDownload!: (v: any) => void;
    downloadAsync.mockReturnValueOnce(new Promise((r) => { resolveDownload = r; }));

    const p = downloader.ensureLocalCover("book1");
    // The user deletes the download while the fetch is still open.
    useDownloadStore.setState({ completedDownloads: {} } as any);
    // Fetch now completes; the merge runs against the CURRENT (empty) state.
    resolveDownload({ uri: "file:///cover", status: 200 });
    await p;

    // The deleted item stays deleted — no re-add to the store...
    expect(useDownloadStore.getState().completedDownloads["book1"]).toBeUndefined();
    // ...and nothing re-persisted to the download DB.
    expect(dbStorage.getAllKeys().some((k) => k.includes("book1"))).toBe(false);
  });
});
