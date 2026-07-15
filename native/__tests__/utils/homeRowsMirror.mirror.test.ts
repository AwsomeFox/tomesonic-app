// mirrorHomeRows() reads the shelves + server creds from the stores and writes
// the widget mirror, deduped by a content signature that now includes coverUrl
// (which embeds the access token) — so a token refresh forces a rewrite instead
// of leaving the widget with stale, 401-ing cover URLs.
const mockWrite = jest.fn().mockResolvedValue(undefined);
let mockShelves: any[] = [];
let mockConfig: any = { address: "https://s", token: "t1" };

jest.mock("../../utils/autoCreds", () => ({
  writeHomeRowsState: (...a: any[]) => mockWrite(...a),
}));
jest.mock("../../store/useLibraryStore", () => ({
  useLibraryStore: { getState: () => ({ personalizedShelves: mockShelves }) },
}));
jest.mock("../../utils/storage", () => ({
  storageHelper: { getServerConfig: () => mockConfig },
}));

import { mirrorHomeRows, __resetHomeRowsMirror } from "../../utils/homeRowsMirror";

const shelf = {
  id: "continue-listening",
  label: "Continue Listening",
  type: "book",
  entities: [{ id: "li_1", media: { metadata: { title: "Dune" } } }],
};

describe("mirrorHomeRows", () => {
  beforeEach(() => {
    mockWrite.mockClear();
    __resetHomeRowsMirror();
    mockShelves = [shelf];
    mockConfig = { address: "https://s", token: "t1" };
  });

  it("writes rows built from the shelves + server creds", () => {
    mirrorHomeRows();
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const rows = mockWrite.mock.calls[0][0];
    expect(rows[0].id).toBe("continue-listening");
    expect(rows[0].items[0].coverUrl).toContain("token=t1");
  });

  it("dedupes identical content (no rewrite on an unchanged reload)", () => {
    mirrorHomeRows();
    mirrorHomeRows();
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("rewrites with fresh cover URLs after a token refresh", () => {
    mirrorHomeRows();
    expect(mockWrite).toHaveBeenCalledTimes(1);
    // Token rotates (401 refresh) without any shelf change.
    mockConfig = { address: "https://s", token: "t2" };
    mirrorHomeRows();
    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(mockWrite.mock.calls[1][0][0].items[0].coverUrl).toContain("token=t2");
  });
});
