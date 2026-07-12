// Locks the Home-shelf pure math (utils/shelfLayout.ts): the row-overflow
// predicate that gates the "see all" header arrow (its width inputs arrive
// from racing onLayout/onContentSizeChange callbacks, in either order), and
// the shelf → Library-tab destination mapping.
import { shelfOverflows, shelfToLibraryParams } from "../../utils/shelfLayout";
import { encodeFilterValue } from "../../components/FilterModal";

describe("shelfOverflows", () => {
  it("is false while either width is unmeasured (0)", () => {
    expect(shelfOverflows(0, 0)).toBe(false);
    expect(shelfOverflows(0, 500)).toBe(false); // content measured first
    expect(shelfOverflows(360, 0)).toBe(false); // viewport measured first
  });

  it("is false when the content exactly fits the viewport", () => {
    expect(shelfOverflows(360, 360)).toBe(false);
  });

  it("absorbs sub-pixel rounding: content up to viewport + 4 is NOT overflow", () => {
    expect(shelfOverflows(360, 361)).toBe(false);
    expect(shelfOverflows(360, 364)).toBe(false); // boundary: cw == vw + slack
  });

  it("is true once the content exceeds viewport + slack", () => {
    expect(shelfOverflows(360, 364.5)).toBe(true);
    expect(shelfOverflows(360, 365)).toBe(true);
    expect(shelfOverflows(360, 1200)).toBe(true);
  });

  it("honors a custom slack", () => {
    expect(shelfOverflows(360, 368, 10)).toBe(false);
    expect(shelfOverflows(360, 371, 10)).toBe(true);
    expect(shelfOverflows(360, 361, 0)).toBe(true);
  });
});

describe("shelfToLibraryParams", () => {
  it("honors an explicit synthetic destination (affinity shelf) before any heuristics", () => {
    const libParams = { filter: "genres.abc", showBack: true, title: "Sci-Fi" };
    // Even with a type/id that would otherwise match, libParams wins.
    expect(shelfToLibraryParams({ id: "recently-added", type: "series", libParams })).toBe(libParams);
  });

  it("maps series-type shelves to the Series browse segment", () => {
    expect(shelfToLibraryParams({ id: "continue-series", type: "series" })).toEqual({ segment: "series" });
  });

  it("maps author-type shelves (both spellings) to the Authors browse segment", () => {
    expect(shelfToLibraryParams({ id: "newest-authors", type: "authors" })).toEqual({ segment: "authors" });
    expect(shelfToLibraryParams({ id: "newest-authors", type: "author" })).toEqual({ segment: "authors" });
  });

  it("maps recently-added to the addedAt-descending sort", () => {
    expect(shelfToLibraryParams({ id: "recently-added", type: "book" })).toEqual({
      orderBy: "addedAt",
      descending: true,
    });
  });

  it("maps discover to the bare library browse — an empty but TRUTHY destination", () => {
    const params = shelfToLibraryParams({ id: "discover", type: "book" });
    expect(params).toEqual({});
    // The showSeeAll gate is `!!libParams && overflow` — {} must stay truthy or
    // Discover silently loses its "see all".
    expect(!!params).toBe(true);
  });

  it("maps continue-listening AND continue-reading to the in-progress filter", () => {
    const expected = { filter: `progress.${encodeFilterValue("in-progress")}` };
    expect(shelfToLibraryParams({ id: "continue-listening", type: "book" })).toEqual(expected);
    expect(shelfToLibraryParams({ id: "continue-reading", type: "book" })).toEqual(expected);
    // Pin the concrete wire format (base64 then URI-encoded) so an encoder
    // change is a conscious decision, not silent drift.
    expect(expected.filter).toBe("progress.aW4tcHJvZ3Jlc3M%3D");
  });

  it("maps listen-again to the finished filter", () => {
    expect(shelfToLibraryParams({ id: "listen-again", type: "book" })).toEqual({
      filter: `progress.${encodeFilterValue("finished")}`,
    });
  });

  it("returns null (header stays non-pressable) for unknown shelves and bad input", () => {
    expect(shelfToLibraryParams({ id: "newest-episodes", type: "episode" })).toBeNull();
    expect(shelfToLibraryParams({ id: "some-future-shelf" })).toBeNull();
    expect(shelfToLibraryParams({})).toBeNull();
    expect(shelfToLibraryParams(null)).toBeNull();
    expect(shelfToLibraryParams(undefined)).toBeNull();
  });
});
