jest.mock("axios", () => ({ get: jest.fn() }));
import axios from "axios";
import {
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
