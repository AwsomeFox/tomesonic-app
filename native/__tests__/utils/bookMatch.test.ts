import {
  hasAudio,
  hasEbook,
  getEbookFormat,
  isKnownEbookFormat,
  isEbookOnly,
  normalizeTitle,
  titleSimilarity,
  authorsMatch,
  isLikelySameBook,
  bestCounterpart,
} from "../../utils/bookMatch";

// Payload-shape helpers: ABS returns expanded items (tracks/audioFiles arrays)
// or minified ones (numTracks/numAudioFiles counters).
const book = (title: string, author?: string, media: any = {}, extra: any = {}) => ({
  id: `id-${title}-${Math.random().toString(36).slice(2, 6)}`,
  mediaType: "book",
  media: { metadata: { title, authorName: author }, ...media },
  ...extra,
});

describe("hasAudio", () => {
  it("detects audio via minified counters", () => {
    expect(hasAudio({ media: { numTracks: 3 } })).toBe(true);
    expect(hasAudio({ media: { numAudioFiles: 1 } })).toBe(true);
    expect(hasAudio({ media: { numTracks: 0, numAudioFiles: 0 } })).toBe(false);
  });

  it("detects audio via expanded arrays", () => {
    expect(hasAudio({ media: { tracks: [{}, {}] } })).toBe(true);
    expect(hasAudio({ media: { audioFiles: [{}] } })).toBe(true);
    expect(hasAudio({ media: { tracks: [], audioFiles: [] } })).toBe(false);
  });

  it("prefers explicit counters over arrays (numTracks=0 with tracks array absent)", () => {
    // numTracks explicitly 0 short-circuits the tracks-array fallback
    expect(hasAudio({ media: { numTracks: 0 } })).toBe(false);
  });

  it("is false for missing media / null item", () => {
    expect(hasAudio(null)).toBe(false);
    expect(hasAudio({})).toBe(false);
    expect(hasAudio(undefined)).toBe(false);
  });
});

describe("hasEbook", () => {
  it("true when ebookFile (expanded) present", () => {
    expect(hasEbook({ media: { ebookFile: { ebookFormat: "epub" } } })).toBe(true);
  });

  it("true when ebookFormat (minified) present", () => {
    expect(hasEbook({ media: { ebookFormat: "pdf" } })).toBe(true);
  });

  it("false otherwise", () => {
    expect(hasEbook({ media: {} })).toBe(false);
    expect(hasEbook(null)).toBe(false);
  });
});

describe("getEbookFormat", () => {
  it("reads ebookFile.ebookFormat first", () => {
    expect(getEbookFormat({ media: { ebookFile: { ebookFormat: "EPUB" } } })).toBe("epub");
  });

  it("falls back to ebookFile.metadata.ext, stripping the dot", () => {
    expect(getEbookFormat({ media: { ebookFile: { metadata: { ext: ".Mobi" } } } })).toBe("mobi");
  });

  it("falls back to media.ebookFormat", () => {
    expect(getEbookFormat({ media: { ebookFormat: "PDF" } })).toBe("pdf");
  });

  it("returns null when nothing is present", () => {
    expect(getEbookFormat({ media: {} })).toBeNull();
    expect(getEbookFormat(null)).toBeNull();
  });
});

describe("isKnownEbookFormat", () => {
  it("recognizes the known formats case-insensitively", () => {
    for (const fmt of ["epub", "mobi", "azw3", "azw", "pdf", "cbr", "cbz", "fb2", "txt"]) {
      expect(isKnownEbookFormat(fmt)).toBe(true);
      expect(isKnownEbookFormat(fmt.toUpperCase())).toBe(true);
    }
  });

  it("rejects unknown / null formats", () => {
    expect(isKnownEbookFormat("docx")).toBe(false);
    expect(isKnownEbookFormat(null)).toBe(false);
    expect(isKnownEbookFormat("")).toBe(false);
  });
});

describe("isEbookOnly", () => {
  it("true for a book with no audio", () => {
    expect(isEbookOnly({ mediaType: "book", media: { ebookFormat: "epub" } })).toBe(true);
  });

  it("false for a book with audio", () => {
    expect(isEbookOnly({ mediaType: "book", media: { numTracks: 4 } })).toBe(false);
  });

  it("never hides podcasts", () => {
    expect(isEbookOnly({ mediaType: "podcast", media: {} })).toBe(false);
  });
});

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("Dune!")).toBe("dune");
  });

  it("drops subtitles after a colon", () => {
    expect(normalizeTitle("Project Hail Mary: A Novel")).toBe("project hail mary");
  });

  it("removes parenthesized and bracketed segments", () => {
    expect(normalizeTitle("Dune (Unabridged) [Special]")).toBe("dune");
  });

  it("strips diacritics", () => {
    expect(normalizeTitle("Les Misérables")).toBe("les miserables");
  });

  it("removes stopwords", () => {
    expect(normalizeTitle("The Name of the Wind")).toBe("name wind");
    expect(normalizeTitle("A Game of Thrones, Book 1")).toBe("game thrones 1");
  });

  it("returns empty string for empty/missing input", () => {
    expect(normalizeTitle("")).toBe("");
    expect(normalizeTitle(undefined as any)).toBe("");
  });
});

describe("titleSimilarity", () => {
  it("is 1 for identical titles up to normalization", () => {
    expect(titleSimilarity("The Hobbit", "Hobbit (Unabridged)")).toBe(1);
  });

  it("is 0 when either side normalizes to empty", () => {
    expect(titleSimilarity("", "Dune")).toBe(0);
    expect(titleSimilarity("The", "Dune")).toBe(0); // pure stopwords
  });

  it("is 0 for disjoint titles", () => {
    expect(titleSimilarity("Dune", "Hyperion")).toBe(0);
  });

  it("is the Jaccard index for partial overlap", () => {
    // {dune} vs {dune, messiah}: 1/2
    expect(titleSimilarity("Dune", "Dune Messiah")).toBeCloseTo(0.5);
    // {name, wind} vs {wise, mans, fear}: 0/5
    expect(titleSimilarity("The Name of the Wind", "The Wise Man's Fear")).toBe(0);
  });
});

describe("authorsMatch", () => {
  it("matches identical authors ignoring case/diacritics", () => {
    expect(authorsMatch("Frank Herbert", "frank herbert")).toBe(true);
    expect(authorsMatch("José Saramago", "Jose Saramago")).toBe(true);
  });

  it("matches when one name contains the other", () => {
    expect(authorsMatch("J.R.R. Tolkien", "Tolkien")).toBe(true);
  });

  it("matches on shared surname (longer than 2 chars)", () => {
    expect(authorsMatch("Frank Herbert", "F. Herbert")).toBe(true);
  });

  it("does not match on a short shared surname token", () => {
    expect(authorsMatch("Stephen Fu", "Robert Fu")).toBe(false);
  });

  it("does not match different authors", () => {
    expect(authorsMatch("Frank Herbert", "Brandon Sanderson")).toBe(false);
  });

  it("passes when either side lacks author info", () => {
    expect(authorsMatch("", "Frank Herbert")).toBe(true);
    expect(authorsMatch("Frank Herbert", "")).toBe(true);
  });
});

describe("isLikelySameBook", () => {
  it("matches the same title with subtitle variants and same author", () => {
    const a = book("Project Hail Mary", "Andy Weir");
    const b = book("Project Hail Mary: A Novel", "Andy Weir");
    expect(isLikelySameBook(a, b)).toBe(true);
  });

  it("rejects Dune vs Dune Messiah (containment guard)", () => {
    const a = book("Dune", "Frank Herbert");
    const b = book("Dune Messiah", "Frank Herbert");
    // sim is exactly 0.5 and containment holds, but token ratio 1/2 < 0.7
    expect(isLikelySameBook(a, b)).toBe(false);
    expect(isLikelySameBook(b, a)).toBe(false);
  });

  it("rejects same title with a different author", () => {
    const a = book("Dune", "Frank Herbert");
    const b = book("Dune", "Someone Else");
    expect(isLikelySameBook(a, b)).toBe(false);
  });

  it("rejects self / null / same id", () => {
    const a = book("Dune", "Frank Herbert");
    expect(isLikelySameBook(a, a)).toBe(false);
    expect(isLikelySameBook(a, null)).toBe(false);
    expect(isLikelySameBook(null, a)).toBe(false);
    expect(isLikelySameBook(a, { ...a })).toBe(false); // same id
  });

  it("accepts containment when token counts are close", () => {
    // {wise, mans, fear} vs {wise, mans, fear, kingkiller}: containment,
    // sim 3/4 = 0.75 >= 0.5, ratio 3/4 >= 0.7
    const a = book("The Wise Man's Fear", "Patrick Rothfuss");
    const b = book("The Wise Man's Fear Kingkiller", "Patrick Rothfuss");
    expect(isLikelySameBook(a, b)).toBe(true);
  });

  it("reads titles/authors from flat item fields too", () => {
    const a = { id: "1", title: "Dune", author: "Frank Herbert" };
    const b = { id: "2", title: "Dune", author: "Frank Herbert" };
    expect(isLikelySameBook(a, b)).toBe(true);
  });
});

describe("bestCounterpart", () => {
  it("picks the candidate with the highest title similarity among matches", () => {
    const base = book("The Wise Man's Fear", "Patrick Rothfuss");
    // Containment match, but only 0.75 similar.
    const partial = book("The Wise Man's Fear Kingkiller", "Patrick Rothfuss");
    // Exact normalized match — 1.0 similar.
    const exact = book("The Wise Man's Fear (Unabridged)", "Patrick Rothfuss");
    const unrelated = book("Artemis", "Andy Weir");
    expect(bestCounterpart(base, [unrelated, partial, exact])).toBe(exact);
  });

  it("keeps the first candidate on similarity ties", () => {
    const base = book("Project Hail Mary", "Andy Weir");
    const first = book("Project Hail Mary: A Novel", "Andy Weir"); // subtitle strips → sim 1
    const second = book("Project Hail Mary", "Andy Weir");
    expect(bestCounterpart(base, [first, second])).toBe(first);
  });

  it("returns null when nothing matches", () => {
    const base = book("Dune", "Frank Herbert");
    expect(bestCounterpart(base, [book("Hyperion", "Dan Simmons")])).toBeNull();
    expect(bestCounterpart(base, [])).toBeNull();
    expect(bestCounterpart(base, undefined as any)).toBeNull();
  });
});
