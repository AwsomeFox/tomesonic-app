/**
 * EditMetadataScreen — segmented Details / Cover / Match editor.
 *
 * Pins the load-bearing behaviors:
 *  - the Details save PATCHes ONLY dirty fields (a whole-object PATCH would
 *    silently clobber concurrent web-side edits — data-loss class bug);
 *  - cover set-by-URL and cover-search-grid both land on POST /cover {url};
 *  - the match flow searches the chosen provider, defaults its choose-fields
 *    step to fill-missing-only, confirms before overwriting, and applies as a
 *    minimal media PATCH (+ cover POST when picked);
 *  - non-privileged users get a read-only lock state, never an editable form.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));
jest.mock("../../store/useSnackbarStore", () => ({
  showSnackbar: jest.fn(),
}));
jest.mock("../../utils/abs/items", () => ({
  updateItemMedia: jest.fn(),
  searchBookMetadata: jest.fn(),
  searchCovers: jest.fn(),
  setCoverFromUrl: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import EditMetadataScreen, { buildDirtyPatch } from "../../screens/EditMetadataScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import {
  updateItemMedia,
  searchBookMetadata,
  searchCovers,
  setCoverFromUrl,
} from "../../utils/abs/items";
import { useUserStore } from "../../store/useUserStore";

const initialUser = useUserStore.getState();

const ITEM = {
  id: "item1",
  mediaType: "book",
  media: {
    id: "book-media-1",
    coverPath: "/covers/item1.jpg",
    tags: ["Favorites"],
    metadata: {
      title: "The Hobbit",
      subtitle: "",
      authors: [{ id: "a1", name: "J.R.R. Tolkien" }],
      narrators: ["Rob Inglis"],
      series: [{ id: "s1", name: "Middle Earth", sequence: "1" }],
      genres: ["Fantasy"],
      description: "A hobbit adventure.",
      publisher: "Allen & Unwin",
      publishedYear: "1937",
      language: "English",
      isbn: "",
      asin: "",
      explicit: false,
      abridged: false,
    },
  },
};

const CANDIDATE = {
  title: "The Hobbit: There and Back Again",
  author: "J. R. R. Tolkien",
  narrator: "Rob Inglis", // identical to current → excluded from the diff
  publishedYear: "1937", // identical → excluded
  asin: "B0HOBBIT", // current empty → fill-missing default CHECKED
  cover: "https://covers.example/hobbit.jpg",
};

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

function setAdmin() {
  useUserStore.setState({
    user: { id: "u1", username: "boss", type: "admin", permissions: {} },
    serverConnectionConfig: { address: "https://abs.test", token: "tok", version: "2.35.1" },
  } as any);
}

async function renderScreen(params: any = { libraryItemId: "item1" }) {
  const navigation = makeNavigation();
  await render(<EditMetadataScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  setAdmin();
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url.startsWith("/api/items/item1")) {
      return Promise.resolve({ data: JSON.parse(JSON.stringify(ITEM)) });
    }
    return Promise.reject(new Error(`unmocked GET ${url}`));
  });
  (updateItemMedia as jest.Mock).mockResolvedValue({ updated: true });
  (setCoverFromUrl as jest.Mock).mockResolvedValue({ success: true, cover: "/covers/new.jpg" });
});

describe("EditMetadataScreen — details form", () => {
  it("loads the item, seeds every field, and disables Save while clean", async () => {
    await renderScreen();
    const title = await screen.findByLabelText("Title");
    expect(title.props.value).toBe("The Hobbit");
    expect(screen.getByLabelText("Authors").props.value).toBe("J.R.R. Tolkien");
    expect(screen.getByLabelText("Narrators").props.value).toBe("Rob Inglis");
    expect(screen.getByLabelText("Series").props.value).toBe("Middle Earth");
    expect(screen.getByLabelText("Series sequence").props.value).toBe("1");
    expect(screen.getByLabelText("Genres").props.value).toBe("Fantasy");
    expect(screen.getByLabelText("Tags").props.value).toBe("Favorites");
    expect(screen.getByLabelText("Publish year").props.value).toBe("1937");

    const save = screen.getByLabelText("Save details");
    expect(save.props.accessibilityState?.disabled).toBe(true);
  });

  it("saves ONLY the dirty field — a title edit PATCHes { metadata: { title } } and nothing else", async () => {
    await renderScreen();
    const title = await screen.findByLabelText("Title");
    await fireEvent.changeText(title, "The Hobbit, Revised");
    await fireEvent.press(screen.getByLabelText("Save details"));

    await waitFor(() =>
      expect(updateItemMedia).toHaveBeenCalledWith("item1", {
        metadata: { title: "The Hobbit, Revised" },
      })
    );
    // EXACT payload — no tags key, no untouched metadata fields.
    expect((updateItemMedia as jest.Mock).mock.calls[0][1]).toEqual({
      metadata: { title: "The Hobbit, Revised" },
    });
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Details saved" });
    // The form re-seeds: Save disables again.
    await waitFor(() =>
      expect(screen.getByLabelText("Save details").props.accessibilityState?.disabled).toBe(true)
    );
  });

  it("a tags-only edit PATCHes top-level { tags } with NO metadata key", async () => {
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.changeText(screen.getByLabelText("Tags"), "Favorites, To Re-read");
    await fireEvent.press(screen.getByLabelText("Save details"));

    await waitFor(() => expect(updateItemMedia).toHaveBeenCalled());
    expect((updateItemMedia as jest.Mock).mock.calls[0][1]).toEqual({
      tags: ["Favorites", "To Re-read"],
    });
  });

  it("list fields split on commas: authors become [{name}] objects, narrators plain strings", async () => {
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.changeText(
      screen.getByLabelText("Authors"),
      "J.R.R. Tolkien, Christopher Tolkien"
    );
    await fireEvent.changeText(screen.getByLabelText("Narrators"), "Rob Inglis, Andy Serkis");
    await fireEvent.press(screen.getByLabelText("Save details"));

    await waitFor(() =>
      expect(updateItemMedia).toHaveBeenCalledWith("item1", {
        metadata: {
          authors: [{ name: "J.R.R. Tolkien" }, { name: "Christopher Tolkien" }],
          narrators: ["Rob Inglis", "Andy Serkis"],
        },
      })
    );
  });

  it("save failure surfaces a dialog and PRESERVES the edited form", async () => {
    (updateItemMedia as jest.Mock).mockRejectedValue(
      Object.assign(new Error("You don't have permission to do that."), { kind: "forbidden" })
    );
    await renderScreen();
    const title = await screen.findByLabelText("Title");
    await fireEvent.changeText(title, "Nope");
    await fireEvent.press(screen.getByLabelText("Save details"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't save",
          message: "You don't have permission to do that.",
        })
      )
    );
    // Edits intact for a retry.
    expect(screen.getByLabelText("Title").props.value).toBe("Nope");
  });

  it("dirty back press asks to discard instead of silently dropping edits", async () => {
    const navigation = await renderScreen();
    await fireEvent.changeText(await screen.findByLabelText("Title"), "Edited");
    await fireEvent.press(screen.getByLabelText("Go back"));

    expect(navigation.goBack).not.toHaveBeenCalled();
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Discard changes?");
    await act(async () => {
      dialog.buttons.find((b: any) => b.text === "Discard").onPress();
    });
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("non-privileged user gets the read-only lock state — no form, no Save", async () => {
    useUserStore.setState({
      user: { id: "u2", username: "joe", type: "user", permissions: { update: false } },
    } as any);
    await renderScreen();
    await screen.findByText("Permission needed");
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.queryByLabelText("Save details")).toBeNull();
  });

  it("buildDirtyPatch: clean form → empty patch; null-able fields clear to null", () => {
    const seed: any = {
      title: "T",
      subtitle: "Sub",
      authors: "A",
      narrators: "",
      seriesName: "",
      seriesSequence: "",
      genres: "",
      tags: "",
      description: "",
      publisher: "P",
      publishedYear: "",
      language: "",
      isbn: "",
      asin: "",
      explicit: false,
      abridged: false,
    };
    expect(buildDirtyPatch(seed, seed)).toEqual({});
    expect(buildDirtyPatch({ ...seed, subtitle: "", publisher: "" }, seed)).toEqual({
      metadata: { subtitle: null, publisher: null },
    });
    // Clearing the series name sends an EMPTY array (removes the series).
    expect(buildDirtyPatch({ ...seed, seriesName: "S", seriesSequence: "2" }, seed)).toEqual({
      metadata: { series: [{ name: "S", sequence: "2" }] },
    });
  });
});

describe("EditMetadataScreen — cover tab", () => {
  it("sets a cover by URL via POST /cover { url }", async () => {
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.press(screen.getByLabelText("Cover tab"));

    await fireEvent.changeText(
      screen.getByLabelText("Cover image URL"),
      "https://example.com/cover.jpg"
    );
    await fireEvent.press(screen.getByLabelText("Set cover from URL"));

    await waitFor(() =>
      expect(setCoverFromUrl).toHaveBeenCalledWith("item1", "https://example.com/cover.jpg")
    );
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Cover updated" });
  });

  it("cover search renders a grid; picking one confirms then POSTs that URL", async () => {
    (searchCovers as jest.Mock).mockResolvedValue([
      "https://covers.example/1.jpg",
      "https://covers.example/2.jpg",
    ]);
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.press(screen.getByLabelText("Cover tab"));

    await fireEvent.press(screen.getByLabelText("Run cover search"));
    await waitFor(() =>
      expect(searchCovers).toHaveBeenCalledWith(
        expect.objectContaining({ title: "The Hobbit", author: "J.R.R. Tolkien" })
      )
    );

    await fireEvent.press(await screen.findByLabelText("Cover option 2"));
    // Confirm gate before the server call.
    expect(setCoverFromUrl).not.toHaveBeenCalled();
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Use this cover?");
    await act(async () => {
      await dialog.buttons.find((b: any) => b.text === "Use cover").onPress();
    });
    expect(setCoverFromUrl).toHaveBeenCalledWith("item1", "https://covers.example/2.jpg");
  });

  it("hides cover controls without the upload permission (update alone isn't enough)", async () => {
    useUserStore.setState({
      user: {
        id: "u3",
        username: "editor",
        type: "user",
        permissions: { update: true, upload: false },
      },
    } as any);
    await renderScreen();
    await screen.findByLabelText("Title"); // details form IS editable (update perm)
    await fireEvent.press(screen.getByLabelText("Cover tab"));
    await screen.findByText("Permission needed");
    expect(screen.queryByLabelText("Cover image URL")).toBeNull();
  });
});

describe("EditMetadataScreen — match flow", () => {
  const openMatchAndSearch = async () => {
    (searchBookMetadata as jest.Mock).mockResolvedValue([CANDIDATE]);
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.press(screen.getByLabelText("Match tab"));
    await fireEvent.press(screen.getByLabelText("Search provider"));
    await waitFor(() => expect(searchBookMetadata).toHaveBeenCalled());
  };

  it("searches the selected provider with the prefilled title/author", async () => {
    (searchBookMetadata as jest.Mock).mockResolvedValue([]);
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.press(screen.getByLabelText("Match tab"));

    expect(screen.getByLabelText("Search title").props.value).toBe("The Hobbit");
    expect(screen.getByLabelText("Search author").props.value).toBe("J.R.R. Tolkien");
    await fireEvent.press(screen.getByLabelText("Provider: Google Books"));
    await fireEvent.press(screen.getByLabelText("Search provider"));

    await waitFor(() =>
      expect(searchBookMetadata).toHaveBeenCalledWith({
        title: "The Hobbit",
        author: "J.R.R. Tolkien",
        provider: "google",
      })
    );
    await screen.findByText("No matches");
  });

  it("choose-fields defaults to fill-missing-only: empty current → checked, existing → unchecked", async () => {
    await openMatchAndSearch();
    await fireEvent.press(
      await screen.findByLabelText(/^Match result: The Hobbit: There and Back Again/)
    );

    // Title differs but current is non-empty → unchecked (overwrite is opt-in).
    const titleRow = screen.getByLabelText(/^Title: current The Hobbit/);
    expect(titleRow.props.accessibilityState?.checked).toBe(false);
    // ASIN is empty locally → checked by default.
    const asinRow = screen.getByLabelText(/^ASIN: current empty/);
    expect(asinRow.props.accessibilityState?.checked).toBe(true);
    // Identical fields (narrator, publish year) never appear in the diff.
    expect(screen.queryByLabelText(/^Narrator:/)).toBeNull();
    expect(screen.queryByLabelText(/^Publish year:/)).toBeNull();
    // Item already has a cover → the matched cover starts unchecked.
    expect(
      screen.getByLabelText("Cover: use the matched cover image").props.accessibilityState?.checked
    ).toBe(false);
  });

  it("fill-missing apply skips the confirm and PATCHes only the checked fields", async () => {
    await openMatchAndSearch();
    await fireEvent.press(
      await screen.findByLabelText(/^Match result: The Hobbit: There and Back Again/)
    );
    await fireEvent.press(screen.getByText("Apply match"));

    // No overwrites → no Tier-2 dialog, straight to the PATCH.
    await waitFor(() =>
      expect(updateItemMedia).toHaveBeenCalledWith("item1", {
        metadata: { asin: "B0HOBBIT" },
      })
    );
    expect(setCoverFromUrl).not.toHaveBeenCalled(); // cover unchecked
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Matched from Audible" });
  });

  it("overwriting an existing field requires a confirm, then lands in the same PATCH (+ cover POST when checked)", async () => {
    await openMatchAndSearch();
    await fireEvent.press(
      await screen.findByLabelText(/^Match result: The Hobbit: There and Back Again/)
    );
    // Opt in to the title overwrite and the matched cover.
    await fireEvent.press(screen.getByLabelText(/^Title: current The Hobbit/));
    await fireEvent.press(screen.getByLabelText("Cover: use the matched cover image"));
    await fireEvent.press(screen.getByText("Apply match"));

    expect(updateItemMedia).not.toHaveBeenCalled();
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Overwrite existing fields?");
    expect(dialog.message).toContain("1 existing field");
    await act(async () => {
      await dialog.buttons.find((b: any) => b.text === "Apply").onPress();
    });

    expect(updateItemMedia).toHaveBeenCalledWith("item1", {
      metadata: { title: "The Hobbit: There and Back Again", asin: "B0HOBBIT" },
    });
    expect(setCoverFromUrl).toHaveBeenCalledWith("item1", "https://covers.example/hobbit.jpg");
  });
});
