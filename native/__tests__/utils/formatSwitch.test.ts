import { api } from "../../utils/api";
import {
  audioPositionForReadingFraction,
  readingFractionForAudioPosition,
  canJumpToFraction,
  resolveAudioTarget,
  resolveEbookTarget,
  approximateClock,
} from "../../utils/formatSwitch";

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = jest.mocked(api.get);

beforeEach(() => {
  mockedGet.mockReset();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("audioPositionForReadingFraction", () => {
  it("scales linearly", () => {
    expect(audioPositionForReadingFraction(0.5, 3600)).toBe(1800);
    expect(audioPositionForReadingFraction(0, 3600)).toBe(0);
    expect(audioPositionForReadingFraction(1, 3600)).toBe(3600);
  });

  it("clamps fraction to 0..1 and duration to >= 0", () => {
    expect(audioPositionForReadingFraction(-0.5, 100)).toBe(0);
    expect(audioPositionForReadingFraction(2, 100)).toBe(100);
    expect(audioPositionForReadingFraction(0.5, -100)).toBe(0);
    expect(audioPositionForReadingFraction(NaN, 100)).toBe(0);
    expect(audioPositionForReadingFraction(0.5, NaN)).toBe(0);
  });
});

describe("readingFractionForAudioPosition", () => {
  it("scales linearly and clamps to 0..1", () => {
    expect(readingFractionForAudioPosition(1800, 3600)).toBe(0.5);
    expect(readingFractionForAudioPosition(7200, 3600)).toBe(1);
    expect(readingFractionForAudioPosition(-10, 3600)).toBe(0);
  });

  it("returns 0 for zero/negative/NaN duration", () => {
    expect(readingFractionForAudioPosition(100, 0)).toBe(0);
    expect(readingFractionForAudioPosition(100, -5)).toBe(0);
    expect(readingFractionForAudioPosition(100, NaN)).toBe(0);
  });
});

describe("canJumpToFraction", () => {
  it("allows reflowable formats", () => {
    for (const fmt of ["epub", "EPUB", "mobi", "azw3", "azw", "kf8"]) {
      expect(canJumpToFraction(fmt)).toBe(true);
    }
  });

  it("rejects page-based / unknown / missing formats", () => {
    expect(canJumpToFraction("pdf")).toBe(false);
    expect(canJumpToFraction("cbz")).toBe(false);
    expect(canJumpToFraction(null)).toBe(false);
    expect(canJumpToFraction(undefined)).toBe(false);
    expect(canJumpToFraction("")).toBe(false);
  });
});

describe("approximateClock", () => {
  it("formats h:mm, minute-grained", () => {
    expect(approximateClock(0)).toBe("0:00");
    expect(approximateClock(59)).toBe("0:00");
    expect(approximateClock(60)).toBe("0:01");
    expect(approximateClock(3600 + 23 * 60 + 45)).toBe("1:23");
    expect(approximateClock(47 * 60)).toBe("0:47");
  });

  it("clamps negatives and NaN to 0:00", () => {
    expect(approximateClock(-100)).toBe("0:00");
    expect(approximateClock(NaN)).toBe("0:00");
  });
});

// --- Target resolution --------------------------------------------------------

const expandedAudio = {
  id: "audio1",
  libraryId: "lib1",
  mediaType: "book",
  media: {
    duration: 5000,
    tracks: [{}, {}],
    metadata: { title: "Dune", authorName: "Frank Herbert" },
  },
};

const expandedEbookOnly = {
  id: "ebook1",
  libraryId: "lib1",
  mediaType: "book",
  media: {
    ebookFile: { ebookFormat: "epub" },
    metadata: { title: "Dune", authorName: "Frank Herbert" },
  },
};

const both = {
  id: "both1",
  libraryId: "lib1",
  mediaType: "book",
  media: {
    duration: 999,
    tracks: [{}],
    ebookFile: { ebookFormat: "epub" },
    metadata: { title: "Dune", authorName: "Frank Herbert" },
  },
};

describe("resolveAudioTarget", () => {
  it("returns the same item when it already has audio", async () => {
    mockedGet.mockResolvedValueOnce({ data: both } as any);
    const target = await resolveAudioTarget("both1");
    expect(target).toEqual({ itemId: "both1", duration: 999, title: "Dune" });
    expect(mockedGet).toHaveBeenCalledWith("/api/items/both1?expanded=1");
    expect(mockedGet).toHaveBeenCalledTimes(1); // no search needed
  });

  it("falls back to the fuzzy-matched audiobook sibling via library search", async () => {
    mockedGet.mockImplementation(async (url: any) => {
      if (url.startsWith("/api/items/ebook1")) return { data: expandedEbookOnly } as any;
      if (url.startsWith("/api/libraries/lib1/search"))
        return { data: { book: [{ libraryItem: expandedAudio }] } } as any;
      throw new Error(`unexpected url ${url}`);
    });
    const target = await resolveAudioTarget("ebook1");
    expect(target).toEqual({ itemId: "audio1", duration: 5000, title: "Dune" });
    expect(mockedGet).toHaveBeenCalledWith(
      expect.stringContaining("/api/libraries/lib1/search?q=Dune")
    );
  });

  it("returns null when no audio exists anywhere", async () => {
    mockedGet.mockImplementation(async (url: any) => {
      if (url.startsWith("/api/items/ebook1")) return { data: expandedEbookOnly } as any;
      return { data: { book: [] } } as any;
    });
    expect(await resolveAudioTarget("ebook1")).toBeNull();
  });

  it("returns null for podcasts", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { id: "pod1", mediaType: "podcast", media: { numTracks: 5 } },
    } as any);
    expect(await resolveAudioTarget("pod1")).toBeNull();
  });

  it("never throws — resolves null on fetch failure", async () => {
    mockedGet.mockRejectedValue(new Error("offline"));
    await expect(resolveAudioTarget("x")).resolves.toBeNull();
  });

  it("returns null when the item fetch has no data", async () => {
    mockedGet.mockResolvedValueOnce({ data: null } as any);
    expect(await resolveAudioTarget("gone")).toBeNull();
  });

  // REGRESSION: a downloaded book plays fully offline, so the resolver must
  // find it locally and NOT report "no audiobook available" when the network
  // is down (the callers translate null into exactly that message).
  it("resolves a downloaded audiobook locally without hitting the network", async () => {
    const { useDownloadStore } = require("../../store/useDownloadStore");
    useDownloadStore.setState({
      completedDownloads: {
        dl1: {
          id: "dl1",
          title: "Local Book",
          meta: { duration: 1234, chapters: [], tracks: [{ index: 0, filename: "a.mp3", duration: 1234, startOffset: 0 }] },
        },
      },
    } as any);
    const target = await resolveAudioTarget("dl1");
    expect(target).toEqual({ itemId: "dl1", duration: 1234, title: "Local Book" });
    expect(mockedGet).not.toHaveBeenCalled();
    useDownloadStore.setState({ completedDownloads: {} } as any);
  });
});

describe("resolveEbookTarget", () => {
  it("returns the same item when it already has an ebook", async () => {
    mockedGet.mockResolvedValueOnce({ data: both } as any);
    const target = await resolveEbookTarget("both1");
    expect(target).toEqual({ itemId: "both1", ebookFormat: "epub", title: "Dune" });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("falls back to the fuzzy-matched ebook sibling", async () => {
    mockedGet.mockImplementation(async (url: any) => {
      if (url.startsWith("/api/items/audio1")) return { data: expandedAudio } as any;
      if (url.startsWith("/api/libraries/lib1/search"))
        return { data: { book: [{ libraryItem: expandedEbookOnly }] } } as any;
      throw new Error(`unexpected url ${url}`);
    });
    const target = await resolveEbookTarget("audio1");
    expect(target).toEqual({ itemId: "ebook1", ebookFormat: "epub", title: "Dune" });
  });

  it("returns null when no ebook exists anywhere", async () => {
    mockedGet.mockImplementation(async (url: any) => {
      if (url.startsWith("/api/items/audio1")) return { data: expandedAudio } as any;
      return { data: {} } as any; // search returns no book key at all
    });
    expect(await resolveEbookTarget("audio1")).toBeNull();
  });

  it("returns null for podcasts and on errors", async () => {
    mockedGet.mockResolvedValueOnce({ data: { id: "p", mediaType: "podcast" } } as any);
    expect(await resolveEbookTarget("p")).toBeNull();

    mockedGet.mockRejectedValue(new Error("offline"));
    await expect(resolveEbookTarget("x")).resolves.toBeNull();
  });

  it("resolves a downloaded ebook locally (format from the file) without the network", async () => {
    const { useDownloadStore } = require("../../store/useDownloadStore");
    useDownloadStore.setState({
      completedDownloads: {
        dl2: { id: "dl2", title: "Local Ebook", parts: [{ id: "ebook", filename: "book.epub" }] },
      },
    } as any);
    const target = await resolveEbookTarget("dl2");
    expect(target).toEqual({ itemId: "dl2", ebookFormat: "epub", title: "Local Ebook" });
    expect(mockedGet).not.toHaveBeenCalled();
    useDownloadStore.setState({ completedDownloads: {} } as any);
  });
});
