/**
 * AddToListModal — "Add to…" sheet: loads collections + playlists, membership
 * toggles (POST/DELETE against the ABS endpoints), inline create-new rows,
 * podcast (playlists-only) mode, and the load-error/retry state.
 */
import { render, screen, fireEvent, act } from "@testing-library/react-native";

// Named exports are missing from the global safe-area mock.
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    SafeAreaView: ({ children, ...props }: any) => React.createElement(View, props, children),
    SafeAreaProvider: ({ children }: any) => children,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 320, height: 640 }),
  };
});

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import AddToListModal from "../../components/AddToListModal";
import { api } from "../../utils/api";

const apiGet = api.get as jest.Mock;
const apiPost = api.post as jest.Mock;
const apiDelete = api.delete as jest.Mock;

const ITEM = "item1";
const LIB = "lib1";

// item1 is already in "Favorites" (collection) and NOT in "Later" (playlist).
const collections = [
  { id: "c1", name: "Favorites", books: [{ id: "item1" }, { id: "b2" }] },
  { id: "c2", name: "Classics", books: [] },
];
const playlists = [
  { id: "p1", name: "Later", items: [{ libraryItemId: "other" }] },
];

function seedGet(colls: any[] = collections, pls: any[] = playlists) {
  apiGet.mockImplementation((url: string) => {
    if (url.includes("/collections")) return Promise.resolve({ data: { results: colls } });
    if (url.includes("/playlists")) return Promise.resolve({ data: { results: pls } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

const noop = () => {};

async function renderModal(props: any = {}) {
  await render(
    <AddToListModal visible onClose={noop} libraryItemId={ITEM} libraryId={LIB} {...props} />
  );
  await act(async () => {}); // flush fetchLists
}

// BUG: AddToListModal renders <Icon name="playlist-add" /> and <Icon name="add" />,
// but neither name exists in Icon.tsx's MAP (or its IconName union), so both fall
// back to the "help-outline" glyph instead of the intended add / playlist-add icons.

describe("AddToListModal — loading + sections", () => {
  it("fetches both lists on open and renders sections with counts", async () => {
    seedGet();
    await renderModal();
    expect(apiGet).toHaveBeenCalledWith(`/api/libraries/${LIB}/collections`);
    expect(apiGet).toHaveBeenCalledWith(`/api/libraries/${LIB}/playlists`);
    expect(screen.getByText("Add to…")).toBeTruthy();
    expect(screen.getByText("Collections")).toBeTruthy();
    expect(screen.getByText("Playlists")).toBeTruthy();
    expect(screen.getByLabelText("Favorites, 2 items")).toBeTruthy();
    expect(screen.getByLabelText("Classics, 0 items")).toBeTruthy();
    expect(screen.getByLabelText("Later, 1 item")).toBeTruthy();
  });

  it("marks rows containing the item as checked", async () => {
    seedGet();
    await renderModal();
    expect(
      screen.getByLabelText("Favorites, 2 items").props.accessibilityState?.checked
    ).toBe(true);
    expect(
      screen.getByLabelText("Classics, 0 items").props.accessibilityState?.checked
    ).toBe(false);
    expect(screen.getByLabelText("Later, 1 item").props.accessibilityState?.checked).toBe(false);
  });

  it("podcast mode hides collections and never fetches them", async () => {
    seedGet();
    await renderModal({ isPodcast: true });
    expect(screen.queryByText("Collections")).toBeNull();
    expect(screen.getByText("Playlists")).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalledWith(`/api/libraries/${LIB}/collections`);
    expect(apiGet).toHaveBeenCalledWith(`/api/libraries/${LIB}/playlists`);
  });

  it("shows the error state with a working Retry", async () => {
    apiGet.mockRejectedValue(new Error("network"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await renderModal();
    expect(screen.getByText("Couldn't load collections and playlists.")).toBeTruthy();

    seedGet();
    await fireEvent.press(screen.getByText("Retry"));
    await act(async () => {});
    expect(screen.getByText("Collections")).toBeTruthy();
    expect(screen.getByLabelText("Favorites, 2 items")).toBeTruthy();
    warnSpy.mockRestore();
  });
});

describe("AddToListModal — membership toggles", () => {
  it("adds the item to a collection it is not in (POST) and swaps in the response", async () => {
    seedGet();
    apiPost.mockResolvedValue({
      data: { id: "c2", name: "Classics", books: [{ id: ITEM }] },
    });
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Classics, 0 items"));
    await act(async () => {});
    expect(apiPost).toHaveBeenCalledWith(`/api/collections/c2/book`, { id: ITEM });
    const updated = screen.getByLabelText("Classics, 1 item");
    expect(updated.props.accessibilityState?.checked).toBe(true);
  });

  it("removes the item from a collection it is in (DELETE)", async () => {
    seedGet();
    apiDelete.mockResolvedValue({
      data: { id: "c1", name: "Favorites", books: [{ id: "b2" }] },
    });
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Favorites, 2 items"));
    await act(async () => {});
    expect(apiDelete).toHaveBeenCalledWith(`/api/collections/c1/book/${ITEM}`);
    expect(
      screen.getByLabelText("Favorites, 1 item").props.accessibilityState?.checked
    ).toBe(false);
  });

  it("adds the item to a playlist (POST /item)", async () => {
    seedGet();
    apiPost.mockResolvedValue({
      data: { id: "p1", name: "Later", items: [{ libraryItemId: "other" }, { libraryItemId: ITEM }] },
    });
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Later, 1 item"));
    await act(async () => {});
    expect(apiPost).toHaveBeenCalledWith(`/api/playlists/p1/item`, { libraryItemId: ITEM });
    expect(screen.getByLabelText("Later, 2 items").props.accessibilityState?.checked).toBe(true);
  });

  it("removes the item from a playlist it is in (DELETE /item)", async () => {
    const inPlaylist = [{ id: "p1", name: "Later", items: [{ libraryItemId: ITEM }] }];
    seedGet(collections, inPlaylist);
    apiDelete.mockResolvedValue({ data: { id: "p1", name: "Later", items: [] } });
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Later, 1 item"));
    await act(async () => {});
    expect(apiDelete).toHaveBeenCalledWith(`/api/playlists/p1/item/${ITEM}`);
    expect(screen.getByLabelText("Later, 0 items").props.accessibilityState?.checked).toBe(false);
  });

  it("refetches when the server response has no id", async () => {
    seedGet();
    apiPost.mockResolvedValue({ data: {} });
    await renderModal();
    apiGet.mockClear();
    await fireEvent.press(screen.getByLabelText("Classics, 0 items"));
    await act(async () => {});
    expect(apiGet).toHaveBeenCalledWith(`/api/libraries/${LIB}/collections`);
  });

  it("keeps state when a toggle fails", async () => {
    seedGet();
    apiPost.mockRejectedValue(new Error("500"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Classics, 0 items"));
    await act(async () => {});
    expect(screen.getByLabelText("Classics, 0 items")).toBeTruthy();
    warnSpy.mockRestore();
  });
});

describe("AddToListModal — create new", () => {
  it("creates a collection containing the item and prepends it", async () => {
    seedGet();
    apiPost.mockResolvedValue({
      data: { id: "c9", name: "Fresh", books: [{ id: ITEM }] },
    });
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Create new collection"));
    await fireEvent.changeText(screen.getByPlaceholderText("Collection name"), "Fresh");
    await fireEvent.press(screen.getByLabelText("Create collection"));
    await act(async () => {});
    expect(apiPost).toHaveBeenCalledWith(`/api/collections`, {
      libraryId: LIB,
      name: "Fresh",
      books: [ITEM],
    });
    expect(screen.getByLabelText("Fresh, 1 item").props.accessibilityState?.checked).toBe(true);
  });

  it("creates a playlist via keyboard submit", async () => {
    seedGet();
    apiPost.mockResolvedValue({
      data: { id: "p9", name: "Road trip", items: [{ libraryItemId: ITEM }] },
    });
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Create new playlist"));
    const input = screen.getByPlaceholderText("Playlist name");
    await fireEvent.changeText(input, "Road trip");
    await fireEvent(input, "submitEditing");
    await act(async () => {});
    expect(apiPost).toHaveBeenCalledWith(`/api/playlists`, {
      libraryId: LIB,
      name: "Road trip",
      items: [{ libraryItemId: ITEM }],
    });
    expect(screen.getByLabelText("Road trip, 1 item")).toBeTruthy();
  });

  it("ignores create with a blank name", async () => {
    seedGet();
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Create new collection"));
    await fireEvent.changeText(screen.getByPlaceholderText("Collection name"), "   ");
    await fireEvent.press(screen.getByLabelText("Create collection"));
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("cancel closes the create row", async () => {
    seedGet();
    await renderModal();
    await fireEvent.press(screen.getByLabelText("Create new collection"));
    expect(screen.getByPlaceholderText("Collection name")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(screen.queryByPlaceholderText("Collection name")).toBeNull();
    expect(screen.getByLabelText("Create new collection")).toBeTruthy();
  });
});
