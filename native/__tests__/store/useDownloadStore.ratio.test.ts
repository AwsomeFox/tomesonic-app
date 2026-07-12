/**
 * useDownloadStore.updateDownloadProgress — ratio invariants.
 *
 * Drives the REAL store action (no math extraction here, per the refactor
 * plan) and pins the invariants the progress UI depends on:
 *  - NaN bytesDownloaded → early-return: state untouched, nothing persisted.
 *  - Unknown-size parts (fileSize <= 0) count expected bytes as
 *    max(fileSize, bytesDownloaded), so the ratio can never exceed 1 nor run
 *    backwards as more bytes land.
 *  - The overall progress is clamped to [0, 0.99] until completion wraps up.
 *
 * Mocks mirror __tests__/store/useDownloadStore.test.ts: downloader/autoCreds
 * factory-mocked, usePlaybackStore reduced to getState, real db over the
 * in-memory MMKV from jest.setup.
 */
jest.mock("../../utils/downloader", () => ({
  downloader: {
    abortBookParts: jest.fn().mockResolvedValue(undefined),
    resumeDownload: jest.fn().mockResolvedValue(undefined),
    sweepOrphanFolders: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../store/usePlaybackStore", () => ({
  usePlaybackStore: { getState: jest.fn(() => ({ currentSession: null, isPlaying: false })) },
}));

import { db, dbStorage } from "../../utils/db";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { useDownloadStore, DownloadItem } from "../../store/useDownloadStore";

const initial = useDownloadStore.getState();

function baseItem(over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: "item1",
    libraryItemId: "item1",
    title: "The Hobbit",
    author: "J.R.R. Tolkien",
    coverUrl: "https://server/cover.jpg",
    progress: 0,
    status: "pending",
    parts: [
      { id: "track_0", filename: "a.m4b", url: "u0", bytesDownloaded: 0, fileSize: 1000, completed: false },
      { id: "cover", filename: "cover.jpg", url: "u1", bytesDownloaded: 0, fileSize: 0, completed: false },
    ],
    localFolderPath: "file:///downloads/item1/",
    ...over,
  };
}

describe("useDownloadStore.updateDownloadProgress ratio invariants", () => {
  beforeEach(() => {
    dbStorage.getAllKeys().forEach((k) => dbStorage.remove(k));
    storage.getAllKeys().forEach((k) => storage.remove(k));
    secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
    storageHelper.setLastSessionKey("https://a.example.com::userA");
    useDownloadStore.setState(initial, true);
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} });
  });

  describe("NaN bytesDownloaded early-return", () => {
    it("leaves the item object untouched (same reference) and persists nothing", () => {
      const item = baseItem();
      useDownloadStore.setState({ activeDownloads: { item1: item } });

      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", NaN, 1000);

      const after = useDownloadStore.getState().activeDownloads["item1"];
      expect(after).toBe(item); // early-return before set(): exact same object
      expect(after.status).toBe("pending"); // never flipped to "downloading"
      expect(after.progress).toBe(0);
      expect(after.parts[0].bytesDownloaded).toBe(0);
      // Nothing reached the DB — a NaN must not be serialized.
      expect(db.getAllDownloads()).toHaveLength(0);
    });

    it("rejects Infinity too (Number.isFinite gate), and NaN can never poison a live ratio", () => {
      const item = baseItem();
      useDownloadStore.setState({ activeDownloads: { item1: item } });
      // Establish real progress first.
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", 500, 1000);
      const before = useDownloadStore.getState().activeDownloads["item1"];
      expect(before.progress).toBeCloseTo(0.5, 5);

      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", Infinity, 1000);
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", NaN, 1000);

      const after = useDownloadStore.getState().activeDownloads["item1"];
      expect(after).toBe(before); // both samples dropped whole
      expect(after.progress).toBeCloseTo(0.5, 5);
      expect(Number.isNaN(after.progress)).toBe(false);
    });
  });

  describe("unknown-size parts (fileSize <= 0)", () => {
    it("counts expected bytes as max(fileSize, bytesDownloaded) so the ratio never exceeds 1", () => {
      // Item with ONLY an unknown-size part: expected always equals downloaded,
      // so the raw ratio is exactly 1 → visible progress is the 0.99 clamp,
      // never anything above it.
      const item = baseItem({
        id: "coverOnly",
        libraryItemId: "coverOnly",
        parts: [{ id: "cover", filename: "c.jpg", url: "u", bytesDownloaded: 0, fileSize: 0, completed: false }],
      });
      useDownloadStore.setState({ activeDownloads: { coverOnly: item } });

      for (const bytes of [1, 500, 123456]) {
        useDownloadStore.getState().updateDownloadProgress("coverOnly", "cover", bytes, 0);
        const p = useDownloadStore.getState().activeDownloads["coverOnly"].progress;
        expect(p).toBeLessThanOrEqual(0.99);
        expect(p).toBeGreaterThanOrEqual(0);
      }
    });

    it("keeps the prior fileSize estimate when the callback reports -1/0, and the part ratio never decreases", () => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem() } });
      const progressAt = () => useDownloadStore.getState().activeDownloads["item1"].progress;

      // Known part at 40%: 400 / (1000 + 0).
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", 400, -1);
      const item = useDownloadStore.getState().activeDownloads["item1"];
      expect(item.parts[0].fileSize).toBe(1000); // -1 didn't clobber the estimate
      expect(progressAt()).toBeCloseTo(0.4, 5);

      // Unknown-size cover grows: denominator grows WITH it (max(0, bytes)),
      // and overall progress climbs monotonically — never > 0.99.
      let prev = progressAt();
      for (const coverBytes of [100, 300, 800, 800]) {
        useDownloadStore.getState().updateDownloadProgress("item1", "cover", coverBytes, 0);
        const p = progressAt();
        // Exact expected ratio: (400 + coverBytes) / (1000 + coverBytes).
        expect(p).toBeCloseTo(Math.min(0.99, (400 + coverBytes) / (1000 + coverBytes)), 10);
        expect(p).toBeGreaterThanOrEqual(prev); // never runs backwards
        expect(p).toBeLessThanOrEqual(0.99);
        prev = p;
      }
    });

    it("negative bytesDownloaded clamps to 0 — progress floor holds at 0", () => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem() } });
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", -500, 1000);
      const item = useDownloadStore.getState().activeDownloads["item1"];
      expect(item.parts[0].bytesDownloaded).toBe(0);
      expect(item.progress).toBe(0);
    });
  });

  describe("overall clamp to [0, 0.99] until completion", () => {
    it("holds at 0.99 when every byte is in but completion hasn't wrapped up", () => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem() } });
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", 1000, 1000);
      expect(useDownloadStore.getState().activeDownloads["item1"].progress).toBe(0.99);

      // Even overshooting the expected size (server lied about Content-Length)
      // stays pinned at 0.99 — the raw ratio is >1 but never surfaces.
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", 2500, 1000);
      expect(useDownloadStore.getState().activeDownloads["item1"].progress).toBe(0.99);
    });

    it("only completeDownload takes progress to 1", () => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem({ status: "downloading" }) } });
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", 1000, 1000);
      expect(useDownloadStore.getState().activeDownloads["item1"].progress).toBe(0.99);

      useDownloadStore.getState().completeDownload("item1", "file:///downloads/item1/");
      expect(useDownloadStore.getState().completedDownloads["item1"].progress).toBe(1);
    });
  });
});
