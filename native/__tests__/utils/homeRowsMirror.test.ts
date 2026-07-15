import { buildHomeRows } from "../../utils/homeRowsMirror";

const SERVER = "https://abs.example.com";
const TOKEN = "tok123";

const bookEntity = (id: string, title: string, author?: string) => ({
  id,
  media: { metadata: { title, authorName: author } },
});

describe("buildHomeRows", () => {
  it("maps a book-like shelf into a row with id/label/items + server cover URLs", () => {
    const shelves = [
      {
        id: "continue-listening",
        label: "Continue Listening",
        type: "book",
        entities: [bookEntity("li_1", "Dune", "Frank Herbert"), bookEntity("li_2", "Foundation")],
      },
    ];
    const rows = buildHomeRows(shelves, SERVER, TOKEN);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("continue-listening");
    expect(rows[0].label).toBe("Continue Listening");
    expect(rows[0].items).toHaveLength(2);
    expect(rows[0].items[0]).toEqual({
      id: "li_1",
      title: "Dune",
      author: "Frank Herbert",
      coverUrl: `${SERVER}/api/items/li_1/cover?width=400&format=webp&token=${TOKEN}`,
    });
    // Missing author becomes "".
    expect(rows[0].items[1].author).toBe("");
  });

  it("skips series/author/genre shelves (their entities aren't openable books)", () => {
    const shelves = [
      { id: "s1", label: "Series", type: "series", entities: [{ id: "ser_1", name: "Dune Saga" }] },
      { id: "a1", label: "Authors", type: "authors", entities: [{ id: "au_1", name: "Herbert" }] },
      { id: "g1", label: "Genres", type: "genres", entities: [{ id: "ge_1", name: "SciFi" }] },
    ];
    expect(buildHomeRows(shelves, SERVER, TOKEN)).toEqual([]);
  });

  it("drops shelves without a stable id or label, and rows that end up empty", () => {
    const shelves = [
      { label: "No id", type: "book", entities: [bookEntity("x", "X")] },
      { id: "no-label", type: "book", entities: [bookEntity("y", "Y")] },
      { id: "empty", label: "Empty", type: "book", entities: [{ id: "z" }] }, // no title -> dropped
    ];
    expect(buildHomeRows(shelves, SERVER, TOKEN)).toEqual([]);
  });

  it("caps items per row at 20", () => {
    const entities = Array.from({ length: 30 }, (_, i) => bookEntity(`b${i}`, `Book ${i}`));
    const rows = buildHomeRows([{ id: "big", label: "Big", type: "book", entities }], SERVER, TOKEN);
    expect(rows[0].items).toHaveLength(20);
  });

  it("falls back to an absolute entity coverUrl when server creds are missing", () => {
    const shelves = [
      {
        id: "r",
        label: "R",
        type: "book",
        entities: [{ id: "b1", title: "T", coverUrl: "https://cdn.example/x.jpg" }],
      },
    ];
    const rows = buildHomeRows(shelves, "", "");
    expect(rows[0].items[0].coverUrl).toBe("https://cdn.example/x.jpg");
  });

  it("does not emit a relative/local cover path the widget can't fetch", () => {
    const shelves = [
      {
        id: "r",
        label: "R",
        type: "book",
        entities: [{ id: "b1", title: "T", coverUrl: "file:///data/x.jpg" }],
      },
    ];
    const rows = buildHomeRows(shelves, "", "");
    expect(rows[0].items[0].coverUrl).toBe("");
  });

  it("returns [] for non-array input", () => {
    expect(buildHomeRows(null as any, SERVER, TOKEN)).toEqual([]);
    expect(buildHomeRows(undefined as any, SERVER, TOKEN)).toEqual([]);
  });

  it("joins multiple authors when authorName is absent", () => {
    const shelves = [
      {
        id: "r",
        label: "R",
        type: "book",
        entities: [
          { id: "b1", media: { metadata: { title: "T", authors: [{ name: "A" }, { name: "B" }] } } },
        ],
      },
    ];
    expect(buildHomeRows(shelves, SERVER, TOKEN)[0].items[0].author).toBe("A, B");
  });

  it("strips a trailing slash on the server address before building cover URLs", () => {
    const rows = buildHomeRows(
      [{ id: "r", label: "R", type: "book", entities: [bookEntity("b1", "T")] }],
      "https://abs.example.com/",
      TOKEN
    );
    expect(rows[0].items[0].coverUrl).toBe(
      `https://abs.example.com/api/items/b1/cover?width=400&format=webp&token=${TOKEN}`
    );
  });
});
