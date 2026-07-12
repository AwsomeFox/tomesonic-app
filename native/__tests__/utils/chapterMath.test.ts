/**
 * chapterMath — the shared chapter/track position math extracted from the four
 * copy-pasted derivations in usePlaybackStore (native progress samples, the 1s
 * tick's cast + local branches, and the end-of-chapter sleep timer). These
 * tests pin the BOUNDARY semantics so a future edit can't desync the scrubber,
 * notification title, EOC pause, and Android Auto handoff from one another.
 */
import { chapterIndexAt, absolutePositionFor } from "../../utils/chapterMath";

const chapters = [
  { id: 0, start: 0, end: 100, title: "One" },
  { id: 1, start: 100, end: 250, title: "Two" },
  { id: 2, start: 250, end: 400, title: "Three" },
];

describe("chapterIndexAt — half-open [start, end) boundaries", () => {
  it("pos === chapter.end rolls to the NEXT chapter (never both)", () => {
    // 100 is chapter 0's exclusive end AND chapter 1's inclusive start — it
    // must resolve to chapter 1, exactly once.
    expect(chapterIndexAt(chapters, 100)).toBe(1);
    expect(chapterIndexAt(chapters, 250)).toBe(2);
  });

  it("pos === chapter.start belongs to that chapter", () => {
    expect(chapterIndexAt(chapters, 0)).toBe(0);
    expect(chapterIndexAt(chapters, 100)).toBe(1);
    expect(chapterIndexAt(chapters, 250)).toBe(2);
  });

  it("positions strictly inside a chapter resolve to it", () => {
    expect(chapterIndexAt(chapters, 50)).toBe(0);
    expect(chapterIndexAt(chapters, 249.999)).toBe(1);
    expect(chapterIndexAt(chapters, 399.999)).toBe(2);
  });

  it("before the first chapter → -1", () => {
    const late = [
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ];
    expect(chapterIndexAt(late, 5)).toBe(-1);
    expect(chapterIndexAt(late, 9.999)).toBe(-1);
  });

  it("after the last chapter → -1 (the final end is exclusive too)", () => {
    expect(chapterIndexAt(chapters, 400)).toBe(-1);
    expect(chapterIndexAt(chapters, 5000)).toBe(-1);
  });

  it("empty / undefined / null chapters → -1", () => {
    expect(chapterIndexAt([], 50)).toBe(-1);
    expect(chapterIndexAt(undefined, 50)).toBe(-1);
    expect(chapterIndexAt(null, 50)).toBe(-1);
  });

  it("NaN / negative / non-finite positions match nothing without throwing", () => {
    expect(chapterIndexAt(chapters, NaN)).toBe(-1);
    expect(chapterIndexAt(chapters, -1)).toBe(-1);
    expect(chapterIndexAt(chapters, -0.0001)).toBe(-1);
    expect(chapterIndexAt(chapters, Infinity)).toBe(-1);
    expect(chapterIndexAt(chapters, -Infinity)).toBe(-1);
  });

  it("negative zero counts as 0 (first chapter)", () => {
    expect(chapterIndexAt(chapters, -0)).toBe(0);
  });

  it("treats a missing/undefined start as 0 and a missing end as unmatched", () => {
    // The defensive (c.start || 0) / (c.end || 0) form used by the sleep-timer
    // and seek paths — a start-less first chapter still matches; an end-less
    // chapter can never match (pos < 0 is impossible for valid positions).
    expect(chapterIndexAt([{ end: 10 }], 5)).toBe(0);
    expect(chapterIndexAt([{ start: 0 }], 5)).toBe(-1);
    expect(chapterIndexAt([null as any, { start: 0, end: 10 }], 5)).toBe(1);
  });

  it("every position resolves to at most ONE chapter across a fine sweep", () => {
    for (let pos = -10; pos <= 410; pos += 0.5) {
      const matches = chapters.filter((c) => pos >= c.start && pos < c.end);
      const idx = chapterIndexAt(chapters, pos);
      if (matches.length === 0) expect(idx).toBe(-1);
      else expect(chapters[idx]).toBe(matches[0]);
    }
  });
});

describe("absolutePositionFor — chapter-queue translation", () => {
  it("adds the chapter's absolute start to the chapter-relative position", () => {
    expect(
      absolutePositionFor({ chapterQueue: true, chapters, trackIndex: 1, position: 5 })
    ).toBe(105);
    expect(
      absolutePositionFor({ chapterQueue: true, chapters, trackIndex: 0, position: 42 })
    ).toBe(42);
  });

  it("treats a falsy chapter start as 0 (matches the `start || 0` inline copies)", () => {
    expect(
      absolutePositionFor({
        chapterQueue: true,
        chapters: [{ end: 100 }, { start: 100, end: 200 }],
        trackIndex: 0,
        position: 7,
      })
    ).toBe(7);
  });

  it("returns null for an unknown/invalid track index (mid track-transition)", () => {
    expect(
      absolutePositionFor({ chapterQueue: true, chapters, trackIndex: undefined, position: 5 })
    ).toBeNull();
    expect(
      absolutePositionFor({ chapterQueue: true, chapters, trackIndex: null, position: 5 })
    ).toBeNull();
    expect(
      absolutePositionFor({ chapterQueue: true, chapters, trackIndex: 99, position: 5 })
    ).toBeNull();
    expect(
      absolutePositionFor({ chapterQueue: true, chapters, trackIndex: -1, position: 5 })
    ).toBeNull();
  });

  it("falls through to the multi-file/raw path when the chapter list is empty", () => {
    // chapterQueue flag set but no chapters — same as the inline
    // `chapterQueue && chapters.length` guards at every call site.
    expect(
      absolutePositionFor({
        chapterQueue: true,
        chapters: [],
        trackOffsets: [0, 3600],
        trackIndex: 1,
        position: 30,
      })
    ).toBe(3630);
  });
});

describe("absolutePositionFor — multi-file translation", () => {
  const trackOffsets = [0, 3600, 7200];

  it("adds the active track's start offset to the file-relative position", () => {
    expect(
      absolutePositionFor({ chapterQueue: false, chapters, trackOffsets, trackIndex: 2, position: 30 })
    ).toBe(7230);
    expect(
      absolutePositionFor({ chapterQueue: false, chapters, trackOffsets, trackIndex: 1, position: 0 })
    ).toBe(3600);
  });

  it("a track-0 offset of 0 is a SUCCESSFUL mapping (returns the position, not null)", () => {
    // Callers distinguish mapped-vs-not (e.g. adopting whole-book duration),
    // so offset 0 must not be conflated with "could not map".
    expect(
      absolutePositionFor({ chapterQueue: false, chapters, trackOffsets, trackIndex: 0, position: 12 })
    ).toBe(12);
  });

  it("returns null when the index or its offset is unknown", () => {
    expect(
      absolutePositionFor({ chapterQueue: false, trackOffsets, trackIndex: undefined, position: 30 })
    ).toBeNull();
    expect(
      absolutePositionFor({ chapterQueue: false, trackOffsets, trackIndex: 99, position: 30 })
    ).toBeNull();
  });

  it("returns null for single-file books (raw position is already absolute)", () => {
    expect(
      absolutePositionFor({ chapterQueue: false, chapters, trackOffsets: [0], trackIndex: 0, position: 30 })
    ).toBeNull();
    expect(
      absolutePositionFor({ chapterQueue: false, chapters, trackOffsets: [], trackIndex: 0, position: 30 })
    ).toBeNull();
    expect(
      absolutePositionFor({ chapterQueue: false, chapters, trackIndex: 0, position: 30 })
    ).toBeNull();
  });
});

describe("cross-helper invariant: translated positions land in the expected chapter", () => {
  it("chapter-queue: end-of-chapter relative position rolls into the NEXT chapter", () => {
    // Playing chapter 0 (0..100) at its very last instant vs exactly its end.
    const justBefore = absolutePositionFor({
      chapterQueue: true,
      chapters,
      trackIndex: 0,
      position: 99.999,
    })!;
    const atEnd = absolutePositionFor({
      chapterQueue: true,
      chapters,
      trackIndex: 0,
      position: 100,
    })!;
    expect(chapterIndexAt(chapters, justBefore)).toBe(0);
    expect(chapterIndexAt(chapters, atEnd)).toBe(1); // rolls forward, never sticks
  });
});
