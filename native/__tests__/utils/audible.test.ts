jest.mock("axios", () => ({ get: jest.fn() }));
import axios from "axios";
import {
  audibleBookDetails,
  audibleAuthorBooks,
  audibleSeriesAsinFromBook,
  audibleFindSeriesAsin,
  audibleSeriesBooks,
  titleKey,
} from "../../utils/audible";

const mockedGet = axios.get as jest.Mock;

beforeEach(() => mockedGet.mockReset());

describe("titleKey", () => {
  it("normalizes subtitles, articles, and noise", () => {
    expect(titleKey("The Hobbit: There and Back Again")).toBe(titleKey("Hobbit"));
    expect(titleKey("Dune (Unabridged)")).toBe(titleKey("DUNE!"));
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
