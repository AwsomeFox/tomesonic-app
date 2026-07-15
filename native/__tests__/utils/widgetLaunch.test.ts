// navigationRef is mocked so we can observe navigation without a real container.
const mockNavigate = jest.fn();
let mockReady = true;
jest.mock("../../navigation/navigationRef", () => ({
  navigationRef: {
    isReady: () => mockReady,
    navigate: (...args: any[]) => mockNavigate(...args),
  },
}));

import { parseItemDeepLink, handleWidgetUrl, openItemById } from "../../utils/widgetLaunch";

describe("parseItemDeepLink", () => {
  it("extracts the item id from a tomesonic item deep link", () => {
    expect(parseItemDeepLink("tomesonic://item/abc123")).toBe("abc123");
  });

  it("also accepts the audiobookshelf scheme", () => {
    expect(parseItemDeepLink("audiobookshelf://item/xyz")).toBe("xyz");
  });

  it("ignores query/hash suffixes", () => {
    expect(parseItemDeepLink("tomesonic://item/abc?foo=1#frag")).toBe("abc");
  });

  it("URL-decodes the id", () => {
    expect(parseItemDeepLink("tomesonic://item/a%20b")).toBe("a b");
  });

  it("returns null for non-item URLs and junk", () => {
    expect(parseItemDeepLink("tomesonic://login?token=x")).toBeNull();
    expect(parseItemDeepLink("https://example.com/item/1")).toBeNull();
    expect(parseItemDeepLink("tomesonic://item/")).toBeNull();
    expect(parseItemDeepLink(null)).toBeNull();
    expect(parseItemDeepLink(undefined)).toBeNull();
    expect(parseItemDeepLink("")).toBeNull();
  });
});

describe("handleWidgetUrl", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockReady = true;
  });

  it("navigates to ItemDetail for an item deep link and reports handled", () => {
    expect(handleWidgetUrl("tomesonic://item/book7")).toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith("ItemDetail", { itemId: "book7" });
  });

  it("does nothing and reports not-handled for a non-item URL", () => {
    expect(handleWidgetUrl("tomesonic://login")).toBe(false);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe("openItemById", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockReady = true;
  });

  it("no-ops on an empty id", () => {
    openItemById("");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates immediately when the container is mockReady", () => {
    openItemById("b1");
    expect(mockNavigate).toHaveBeenCalledWith("ItemDetail", { itemId: "b1" });
  });

  it("retries until navigation becomes mockReady", () => {
    jest.useFakeTimers();
    mockReady = false;
    openItemById("b2");
    expect(mockNavigate).not.toHaveBeenCalled();
    mockReady = true;
    jest.advanceTimersByTime(200);
    expect(mockNavigate).toHaveBeenCalledWith("ItemDetail", { itemId: "b2" });
    jest.useRealTimers();
  });
});
