import { withToken, absoluteUrl, coverUrl } from "../../utils/urls";

describe("withToken", () => {
  it("appends ?token= when the url has no query", () => {
    expect(withToken("http://abs.local/file", "tok")).toBe("http://abs.local/file?token=tok");
  });

  it("appends &token= when the url already has a query", () => {
    expect(withToken("http://abs.local/file?a=1", "tok")).toBe("http://abs.local/file?a=1&token=tok");
  });

  it("returns the url unchanged when a token param is already present", () => {
    expect(withToken("http://abs.local/file?token=old", "new")).toBe("http://abs.local/file?token=old");
  });

  it("returns the url unchanged when token is empty", () => {
    expect(withToken("http://abs.local/file", "")).toBe("http://abs.local/file");
  });
});

describe("absoluteUrl", () => {
  it("prefixes the server address onto relative urls", () => {
    expect(absoluteUrl("/api/items/1/file/2", "http://abs.local", "tok")).toBe(
      "http://abs.local/api/items/1/file/2?token=tok"
    );
  });

  it("strips a trailing slash from the server address", () => {
    expect(absoluteUrl("/api/x", "http://abs.local/", "tok")).toBe("http://abs.local/api/x?token=tok");
  });

  it("leaves already-absolute urls alone (still appends the token)", () => {
    expect(absoluteUrl("https://cdn.example/x", "http://abs.local", "tok")).toBe(
      "https://cdn.example/x?token=tok"
    );
  });

  it("tolerates a missing server address", () => {
    expect(absoluteUrl("/api/x", "", "tok")).toBe("/api/x?token=tok");
    expect(absoluteUrl("/api/x", undefined as any, "")).toBe("/api/x");
  });
});

describe("coverUrl", () => {
  it("builds the cover url", () => {
    expect(coverUrl("item1", "http://abs.local", "tok")).toBe(
      "http://abs.local/api/items/item1/cover?token=tok"
    );
  });

  it("strips a trailing slash from the server address", () => {
    expect(coverUrl("item1", "http://abs.local/", "tok")).toBe(
      "http://abs.local/api/items/item1/cover?token=tok"
    );
  });

  it("returns null when itemId or serverAddress is missing", () => {
    expect(coverUrl("", "http://abs.local", "tok")).toBeNull();
    expect(coverUrl("item1", "", "tok")).toBeNull();
  });
});
