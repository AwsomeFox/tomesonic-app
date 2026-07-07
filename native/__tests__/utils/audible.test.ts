jest.mock("axios", () => ({ get: jest.fn() }));
import axios from "axios";
import {
  audibleBookDetails,
  audibleAuthorBooks,
  audibleFindBookAsin,
  audibleSeriesAsinFromBook,
  audibleFindSeriesAsin,
  audibleSeriesBooks,
  titleKey,
  titleKeyFull,
  titlesLikelySame,
} from "../../utils/audible";

const mockedGet = axios.get as jest.Mock;

beforeEach(() => mockedGet.mockReset());

describe("titleKey", () => {
  it("normalizes subtitles, articles, and noise", () => {
    expect(titleKey("The Hobbit: There and Back Again")).toBe(titleKey("Hobbit"));
    expect(titleKey("Dune (Unabridged)")).toBe(titleKey("DUNE!"));
  });
});

describe("titleKeyFull", () => {
  it("keeps subtitles, so distinct series volumes stay distinct", () => {
    expect(titleKeyFull("Mistborn: The Final Empire")).not.toBe(
      titleKeyFull("Mistborn: The Well of Ascension")
    );
    // titleKey (pre-colon) collapses them — the exact bug titleKeyFull fixes.
    expect(titleKey("Mistborn: The Final Empire")).toBe(titleKey("Mistborn: The Well of Ascension"));
  });

  it("still normalizes articles, punctuation, and edition noise", () => {
    expect(titleKeyFull("The Hobbit (Unabridged)")).toBe(titleKeyFull("Hobbit"));
    expect(titleKeyFull("Dune!")).toBe(titleKeyFull("DUNE"));
  });
});

describe("titlesLikelySame", () => {
  it("distinct volumes sharing a series prefix are NOT the same book", () => {
    expect(titlesLikelySame("Mistborn: The Final Empire", "Mistborn: The Well of Ascension")).toBe(
      false
    );
  });

  it("a subtitle on ONE side only still matches via the pre-colon main title", () => {
    expect(titlesLikelySame("Oathbringer", "Oathbringer: Book Three of the Stormlight Archive")).toBe(
      true
    );
    // Symmetric: subtitle-bearing side first.
    expect(titlesLikelySame("Oathbringer: Book Three of the Stormlight Archive", "Oathbringer")).toBe(
      true
    );
  });

  it("identical full titles match through punctuation/article/edition drift", () => {
    expect(titlesLikelySame("The Final Empire", "Final Empire (Unabridged)")).toBe(true);
    expect(titlesLikelySame("The Goldfinch: A Novel", "Goldfinch")).toBe(true);
  });

  it("empty or null titles never match anything", () => {
    expect(titlesLikelySame("", "Dune")).toBe(false);
    expect(titlesLikelySame("Dune", "")).toBe(false);
    expect(titlesLikelySame(null, null)).toBe(false);
    expect(titlesLikelySame(undefined, "")).toBe(false);
  });
});

describe("audibleAuthorBooks", () => {
  it("maps catalog products to book rows", async () => {
    mockedGet.mockResolvedValue({
      data: {
        products: [
          {
            asin: "B01",
            title: "Dune",
            authors: [{ name: "Frank Herbert" }],
            narrators: [{ name: "Scott Brick" }],
            publisher_summary: "Spice",
            product_images: { "500": "https://img/500.jpg" },
            release_date: "1965-08-01",
          },
          { title: "no asin — dropped" },
        ],
      },
    });
    const books = await audibleAuthorBooks("Frank Herbert");
    expect(mockedGet).toHaveBeenCalledWith(
      "https://api.audible.com/1.0/catalog/products",
      expect.objectContaining({ params: expect.objectContaining({ author: "Frank Herbert" }) })
    );
    expect(books).toEqual([
      expect.objectContaining({
        asin: "B01",
        title: "Dune",
        author: "Frank Herbert",
        narrator: "Scott Brick",
        coverArtUrl: "https://img/500.jpg",
      }),
    ]);
  });
});

describe("audibleAuthorBooks pagination", () => {
  const fullPage = (prefix: string) =>
    Array.from({ length: 50 }, (_, i) => ({ asin: `${prefix}${i}`, title: `Book ${prefix}${i}` }));

  it("follows a full 50-result page onto page 2 and dedupes by asin", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: { products: fullPage("A") } })
      .mockResolvedValueOnce({
        data: {
          products: [
            { asin: "A0", title: "Book A0" }, // straddles the page boundary — deduped
            { asin: "B50", title: "Book B50" },
            { asin: "B51", title: "Book B51" },
          ],
        },
      });

    const books = await audibleAuthorBooks("Prolific Author");

    expect(mockedGet).toHaveBeenCalledTimes(2); // short page 2 stops the loop
    expect(mockedGet).toHaveBeenNthCalledWith(
      1,
      "https://api.audible.com/1.0/catalog/products",
      expect.objectContaining({ params: expect.objectContaining({ page: 1 }) })
    );
    expect(mockedGet).toHaveBeenNthCalledWith(
      2,
      "https://api.audible.com/1.0/catalog/products",
      expect.objectContaining({ params: expect.objectContaining({ page: 2 }) })
    );
    expect(books).toHaveLength(52);
    expect(books.filter((b) => b.asin === "A0")).toHaveLength(1);
    expect(books.slice(-2).map((b) => b.asin)).toEqual(["B50", "B51"]);
  });

  it("a later page failing keeps page 1's books instead of throwing", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: { products: fullPage("A") } })
      .mockRejectedValueOnce(new Error("timeout"));

    const books = await audibleAuthorBooks("Prolific Author");
    expect(books).toHaveLength(50);
    expect(books[0].asin).toBe("A0");
  });

  it("page 1 failing still throws (nothing loaded — not a partial result)", async () => {
    mockedGet.mockRejectedValueOnce(new Error("network down"));
    await expect(audibleAuthorBooks("Anyone")).rejects.toThrow("network down");
  });
});

describe("language filtering (app is English-only)", () => {
  it("author books drop foreign-language editions but keep unknown-language rows", async () => {
    mockedGet.mockResolvedValue({
      data: {
        products: [
          { asin: "EN1", title: "English Book", language: "english" },
          { asin: "DE1", title: "German Book", language: "german" },
          { asin: "XX1", title: "No Language Field" },
        ],
      },
    });
    const books = await audibleAuthorBooks("Someone");
    expect(books.map((b) => b.asin)).toEqual(["EN1", "XX1"]);
  });

  it('keeps "English (US)"-style variants (startsWith, not strict equality)', async () => {
    mockedGet.mockResolvedValue({
      data: {
        products: [
          { asin: "US1", title: "US Edition", language: "English (US)" },
          { asin: "GB1", title: "UK Edition", language: "English (UK)" },
          { asin: "DE1", title: "German Book", language: "german" },
        ],
      },
    });
    const books = await audibleAuthorBooks("Someone");
    expect(books.map((b) => b.asin)).toEqual(["US1", "GB1"]);
  });

  it("series books apply the same language filter", async () => {
    mockedGet
      .mockResolvedValueOnce({
        data: {
          product: {
            relationships: [
              { asin: "EN1", relationship_to_product: "child", sort: "1" },
              { asin: "FR1", relationship_to_product: "child", sort: "2" },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          products: [
            { asin: "EN1", title: "English Entry", language: "English" },
            { asin: "FR1", title: "French Entry", language: "french" },
          ],
        },
      });
    const books = await audibleSeriesBooks("SERIES1");
    expect(books.map((b) => b.asin)).toEqual(["EN1"]);
  });
});

describe("audibleBookDetails (Audnexus)", () => {
  it("maps summary/narrators/series from Audnexus (the catalog API never returns summaries)", async () => {
    mockedGet.mockResolvedValue({
      data: {
        asin: "B08G9PRS1K",
        title: "Project Hail Mary",
        authors: [{ name: "Andy Weir" }],
        narrators: [{ name: "Ray Porter" }],
        summary: "<p>Ryland  Grace</p> wakes.",
        image: "https://img/x.jpg",
        seriesPrimary: { asin: "S1", name: "Solo", position: "1" },
        language: "english",
      },
    });
    const d = await audibleBookDetails("B08G9PRS1K");
    expect(mockedGet).toHaveBeenCalledWith(
      "https://api.audnex.us/books/B08G9PRS1K",
      expect.any(Object)
    );
    expect(d).toMatchObject({
      title: "Project Hail Mary",
      narrator: "Ray Porter",
      description: "Ryland Grace wakes.",
      coverArtUrl: "https://img/x.jpg",
      sequence: "1",
    });
  });

  it("returns null for stub/missing books", async () => {
    mockedGet.mockResolvedValue({ data: { asin: "X" } });
    expect(await audibleBookDetails("X")).toBeNull();
  });
});

describe("series resolution", () => {
  it("finds the parent series from a book's relationships", async () => {
    mockedGet.mockResolvedValue({
      data: {
        product: {
          relationships: [
            { asin: "SERIES1", relationship_type: "series", relationship_to_product: "parent" },
            { asin: "OTHER", relationship_type: "component", relationship_to_product: "child" },
          ],
        },
      },
    });
    expect(await audibleSeriesAsinFromBook("B01")).toBe("SERIES1");
  });

  it("falls back to keyword search matched by normalized series title", async () => {
    mockedGet.mockResolvedValue({
      data: {
        products: [
          { series: [{ asin: "SNOPE", title: "Unrelated" }] },
          { series: [{ asin: "SYES", title: "The Lost Fleet" }] },
        ],
      },
    });
    expect(await audibleFindSeriesAsin("Lost Fleet")).toBe("SYES");
  });

  it("fetches series children in order with batched details", async () => {
    mockedGet
      .mockResolvedValueOnce({
        data: {
          product: {
            relationships: [
              { asin: "B2", relationship_to_product: "child", sort: "2" },
              { asin: "B1", relationship_to_product: "child", sort: "1" },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          products: [
            { asin: "B2", title: "Book Two" },
            { asin: "B1", title: "Book One" },
          ],
        },
      });
    const books = await audibleSeriesBooks("SERIES1");
    expect(books.map((b) => b.title)).toEqual(["Book One", "Book Two"]);
  });
});

describe("audibleFindBookAsin scoring", () => {
  it("matches a bare library title against the catalog's series-prefixed title (containment)", async () => {
    mockedGet.mockResolvedValue({
      data: { products: [{ asin: "B1", title: "Mistborn: The Final Empire" }] },
    });
    expect(await audibleFindBookAsin("The Final Empire", "Brandon Sanderson")).toBe("B1");
    expect(mockedGet).toHaveBeenCalledWith(
      "https://api.audible.com/1.0/catalog/products",
      expect.objectContaining({
        params: expect.objectContaining({ keywords: "The Final Empire Brandon Sanderson" }),
      })
    );
  });

  it("an exact full-title match outranks a containment match regardless of result order", async () => {
    mockedGet.mockResolvedValue({
      data: {
        products: [
          // Containment hit listed FIRST — must not win over the exact hit below.
          { asin: "CONTAIN", title: "Mistborn: The Final Empire" },
          { asin: "EXACT", title: "The Final Empire" },
        ],
      },
    });
    expect(await audibleFindBookAsin("The Final Empire")).toBe("EXACT");
  });

  it("returns null when nothing scores", async () => {
    mockedGet.mockResolvedValue({
      data: { products: [{ asin: "X1", title: "Completely Unrelated Memoir" }] },
    });
    expect(await audibleFindBookAsin("The Final Empire")).toBeNull();
  });
});

describe("audibleFindSeriesAsin matching tiers", () => {
  it("an exact normalized name match wins over an earlier contains-only match", async () => {
    mockedGet.mockResolvedValue({
      data: {
        products: [
          { series: [{ asin: "SCONTAIN", title: "The Stormlight Archive Companion" }] },
          { series: [{ asin: "SEXACT", title: "Stormlight Archive" }] },
        ],
      },
    });
    expect(await audibleFindSeriesAsin("The Stormlight Archive")).toBe("SEXACT");
  });

  it("accepts a contains-style near match when no exact name exists", async () => {
    mockedGet.mockResolvedValue({
      data: {
        products: [
          { series: [{ asin: "SNEAR", title: "The Wheel of Time (Original Recording)" }] },
        ],
      },
    });
    expect(await audibleFindSeriesAsin("Wheel of Time")).toBe("SNEAR");
  });

  it("returns null when the top hits belong to unrelated series (no arbitrary fallback)", async () => {
    // The old code grabbed the top hit's first series here — rendering a
    // DIFFERENT series' books as "missing", request buttons and all.
    mockedGet.mockResolvedValue({
      data: {
        products: [
          { series: [{ asin: "SWRONG", title: "Some Other Saga" }] },
          { series: [{ asin: "SWRONG2", title: "Another Thing Entirely" }] },
        ],
      },
    });
    expect(await audibleFindSeriesAsin("Lost Fleet")).toBeNull();
  });
});

describe("audibleSeriesBooks partial tolerance", () => {
  const children = Array.from({ length: 41 }, (_, i) => ({
    asin: `C${i}`,
    relationship_to_product: "child",
    sort: String(i + 1),
  }));
  const chunk1Products = Array.from({ length: 40 }, (_, i) => ({
    asin: `C${i}`,
    title: `Volume ${i}`,
  }));

  it("a failed LATER detail chunk keeps the earlier chunk's books", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockedGet
        .mockResolvedValueOnce({ data: { product: { relationships: children } } })
        .mockResolvedValueOnce({ data: { products: chunk1Products } })
        .mockRejectedValueOnce(new Error("timeout"));

      const books = await audibleSeriesBooks("SERIES1");

      expect(mockedGet).toHaveBeenCalledTimes(3); // relationships + 2 detail chunks
      expect(books).toHaveLength(40);
      expect(books[0].asin).toBe("C0");
      expect(books[39].asin).toBe("C39");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the FIRST detail chunk failing still throws (nothing partial to keep)", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: { product: { relationships: children } } })
      .mockRejectedValueOnce(new Error("boom"));
    await expect(audibleSeriesBooks("SERIES1")).rejects.toThrow("boom");
  });
});

describe("buildOwnedTitleMatcher (series-name guard over titlesLikelySame)", () => {
  const { buildOwnedTitleMatcher } = require("../../utils/audible");

  it("a bare owned title that IS the series name does not hide 'Series: Volume' candidates", () => {
    // Owning a bare "Mistborn" (omnibus / series-titled item) must not match
    // — and hide — every other volume that shares the pre-colon prefix.
    const matches = buildOwnedTitleMatcher(["Mistborn"]);
    expect(
      matches({ title: "Mistborn: The Well of Ascension", seriesTitle: "Mistborn" })
    ).toBe(false);
    expect(
      matches({ title: "Mistborn: The Hero of Ages", seriesTitle: "Mistborn" })
    ).toBe(false);
    // The exact same-title candidate still matches.
    expect(matches({ title: "Mistborn", seriesTitle: "Mistborn" })).toBe(true);
  });

  it("a bare owned BOOK title still matches its subtitled catalog variant", () => {
    const matches = buildOwnedTitleMatcher(["Oathbringer"]);
    expect(
      matches({
        title: "Oathbringer: Book Three of the Stormlight Archive",
        seriesTitle: "The Stormlight Archive",
      })
    ).toBe(true);
  });

  it("falls back to the screen's series name when the candidate lacks seriesTitle", () => {
    const matches = buildOwnedTitleMatcher(["Mistborn"], "Mistborn");
    expect(matches({ title: "Mistborn: The Well of Ascension" })).toBe(false);
  });

  it("owned subtitled titles match bare candidates; distinct volumes stay distinct", () => {
    const matches = buildOwnedTitleMatcher(["Mistborn: The Final Empire"]);
    expect(matches({ title: "Mistborn", seriesTitle: "Mistborn" })).toBe(true);
    expect(
      matches({ title: "Mistborn: The Well of Ascension", seriesTitle: "Mistborn" })
    ).toBe(false);
  });
});

describe("partial-list flags", () => {
  it("audibleSeriesBooks marks a cut-short list as partial", async () => {
    const children = Array.from({ length: 41 }, (_, i) => ({
      asin: `C${i}`,
      relationship_to_product: "child",
      sort: String(i + 1),
    }));
    const chunk1 = Array.from({ length: 40 }, (_, i) => ({ asin: `C${i}`, title: `V${i}` }));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockedGet
        .mockResolvedValueOnce({ data: { product: { relationships: children } } })
        .mockResolvedValueOnce({ data: { products: chunk1 } })
        .mockRejectedValueOnce(new Error("timeout"));
      const books = await audibleSeriesBooks("SERIES1");
      expect((books as any).partial).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("audibleAuthorBooks marks a cut-short backlist as partial; full lists are not", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ asin: `A${i}`, title: `B${i}` }));
    mockedGet
      .mockResolvedValueOnce({ data: { products: page1 } })
      .mockRejectedValueOnce(new Error("timeout"));
    const cut = await audibleAuthorBooks("Author");
    expect(cut).toHaveLength(50);
    expect((cut as any).partial).toBe(true);

    mockedGet.mockReset();
    mockedGet.mockResolvedValueOnce({ data: { products: page1.slice(0, 3) } });
    const full = await audibleAuthorBooks("Author");
    expect((full as any).partial).toBeUndefined();
  });
});
