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
import { AccessibilityInfo } from "react-native";
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
  // Captures navigation listeners so tests can drive `beforeRemove` (the
  // dirty guard covers hardware back through it — not just the header button).
  const listeners: Record<string, (e: any) => void> = {};
  const navigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    dispatch: jest.fn(),
    addListener: jest.fn((name: string, cb: (e: any) => void) => {
      listeners[name] = cb;
      return jest.fn();
    }),
  } as any;
  return { navigation, listeners };
}

function setAdmin() {
  useUserStore.setState({
    user: { id: "u1", username: "boss", type: "admin", permissions: {} },
    serverConnectionConfig: { address: "https://abs.test", token: "tok", version: "2.35.1" },
  } as any);
}

async function renderScreen(params: any = { libraryItemId: "item1" }) {
  const { navigation, listeners } = makeNavigation();
  await render(<EditMetadataScreen navigation={navigation} route={{ params }} />);
  return { navigation, listeners };
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

  it("multi-series book: editing the sequence PRESERVES the other series in the PATCH", async () => {
    // Data-loss class bug: the form edits series[0] only — the PATCH replaces
    // metadata.series wholesale, so the untouched tail MUST ride along.
    const twoSeriesItem = JSON.parse(JSON.stringify(ITEM));
    twoSeriesItem.media.metadata.series = [
      { id: "s1", name: "Middle Earth", sequence: "1" },
      { id: "s2", name: "Tolkien Legendarium", sequence: "3" },
    ];
    (api.get as jest.Mock).mockResolvedValue({ data: twoSeriesItem });

    await renderScreen();
    const seq = await screen.findByLabelText("Series sequence");
    // The form surfaces that only the first series is being edited.
    expect(screen.getByText("+1 more series — kept unchanged")).toBeTruthy();

    await fireEvent.changeText(seq, "2");
    await fireEvent.press(screen.getByLabelText("Save details"));

    await waitFor(() => expect(updateItemMedia).toHaveBeenCalled());
    expect((updateItemMedia as jest.Mock).mock.calls[0][1]).toEqual({
      metadata: {
        series: [
          { name: "Middle Earth", sequence: "2" },
          // Tail entry passes through verbatim (id intact).
          { id: "s2", name: "Tolkien Legendarium", sequence: "3" },
        ],
      },
    });
  });

  it("configures per-field keyboards and a returnKey 'next' chain", async () => {
    await renderScreen();
    const title = await screen.findByLabelText("Title");
    // Name/title fields capitalize words.
    expect(title.props.autoCapitalize).toBe("words");
    expect(screen.getByLabelText("Authors").props.autoCapitalize).toBe("words");
    expect(screen.getByLabelText("Series").props.autoCapitalize).toBe("words");
    expect(screen.getByLabelText("Publisher").props.autoCapitalize).toBe("words");
    // Numeric fields get numeric pads (sequence may hold decimals like 1.5).
    expect(screen.getByLabelText("Publish year").props.keyboardType).toBe("number-pad");
    expect(screen.getByLabelText("Series sequence").props.keyboardType).toBe("decimal-pad");
    // The chain: every single-line field advances with "next"; the last is done.
    expect(title.props.returnKeyType).toBe("next");
    expect(screen.getByLabelText("ISBN").props.returnKeyType).toBe("next");
    expect(screen.getByLabelText("ASIN").props.returnKeyType).toBe("done");
    // Description is multiline — return inserts a newline, not a focus hop.
    expect(screen.getByLabelText("Description").props.returnKeyType).toBeUndefined();
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

  it("beforeRemove with a DIRTY form blocks navigation (hardware back included) until Discard", async () => {
    const { navigation, listeners } = await renderScreen();
    await fireEvent.changeText(await screen.findByLabelText("Title"), "Edited");

    const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
    await act(async () => listeners["beforeRemove"](event));

    expect(event.preventDefault).toHaveBeenCalled();
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Discard changes?");
    expect(navigation.dispatch).not.toHaveBeenCalled();

    await act(async () => {
      dialog.buttons.find((b: any) => b.text === "Discard").onPress();
    });
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
  });

  it("beforeRemove with a CLEAN form lets navigation proceed silently", async () => {
    const { listeners } = await renderScreen();
    await screen.findByLabelText("Title");

    const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
    await act(async () => listeners["beforeRemove"](event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(showAppDialog).not.toHaveBeenCalled();
  });

  it("header back routes through goBack() so the beforeRemove guard owns the dirty check", async () => {
    const { navigation } = await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
    expect(showAppDialog).not.toHaveBeenCalled();
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
    // Multi-series original: the edited head replaces series[0]; the tail
    // rides along verbatim so the PATCH never drops the other series.
    expect(
      buildDirtyPatch({ ...seed, seriesName: "S", seriesSequence: "2" }, seed, [
        { id: "a", name: "Old First", sequence: "1" },
        { id: "b", name: "Second", sequence: "4" },
      ])
    ).toEqual({
      metadata: {
        series: [
          { name: "S", sequence: "2" },
          { id: "b", name: "Second", sequence: "4" },
        ],
      },
    });
  });

  it("buildDirtyPatch: a sequence-only edit with no series name is ignored (no silent data loss)", () => {
    const seed: any = {
      title: "T", subtitle: "", authors: "", narrators: "",
      seriesName: "", seriesSequence: "", genres: "", tags: "",
      description: "", publisher: "", publishedYear: "", language: "",
      isbn: "", asin: "", explicit: false, abridged: false,
    };
    // Typing a sequence while the name is (and stays) empty is meaningless in
    // ABS — it must NOT emit a series patch that drops the value into thin air.
    expect(buildDirtyPatch({ ...seed, seriesSequence: "3" }, seed)).toEqual({});
    // Clearing the name (with an original series present) still removes it.
    expect(
      buildDirtyPatch({ ...seed, seriesName: "" }, { ...seed, seriesName: "Old" }, [
        { id: "s1", name: "Old", sequence: "1" },
      ])
    ).toEqual({ metadata: { series: [] } });
  });

  it("disables the series-sequence field until a series name is present", async () => {
    await renderScreen();
    await screen.findByLabelText("Title");
    // Seeded book has a series → sequence is editable.
    expect(screen.getByLabelText("Series sequence").props.editable).toBe(true);

    // Clear the series name → the sequence field disables and explains why.
    await fireEvent.changeText(screen.getByLabelText("Series"), "");
    expect(screen.getByLabelText("Series sequence").props.editable).toBe(false);
    expect(screen.getByText("Add a series name to set a sequence.")).toBeTruthy();
  });

  it("routes a load failure through the shared error mapper (offline vs server distinguished)", async () => {
    // No `response` → offline: distinct icon+title, not a bare message.
    (api.get as jest.Mock).mockRejectedValue(new Error("Network Error"));
    await renderScreen();
    await screen.findByText("You're offline");
    expect(screen.getByLabelText("Retry")).toBeTruthy();
  });

  it("a server (500) load failure maps to the server error treatment", async () => {
    (api.get as jest.Mock).mockRejectedValue(
      Object.assign(new Error("boom"), { response: { status: 500 } })
    );
    await renderScreen();
    await screen.findByText("The server hit an error");
    expect(screen.getByLabelText("Retry")).toBeTruthy();
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

  it("cover search renders a grid; picking one applies INSTANTLY (Tier-1, same as set-by-URL)", async () => {
    const announceSpy = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
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
    // Result count announced for screen readers; grid labels carry i of N.
    expect(announceSpy).toHaveBeenCalledWith("2 cover options found");

    await fireEvent.press(await screen.findByLabelText("Cover option 2 of 2"));
    // No confirm dialog — instant apply + snackbar, matching set-by-URL's tier.
    await waitFor(() =>
      expect(setCoverFromUrl).toHaveBeenCalledWith("item1", "https://covers.example/2.jpg")
    );
    expect(showAppDialog).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Cover updated" });
  });

  it("set-cover-from-URL rejection surfaces a dialog and keeps the tab usable", async () => {
    (setCoverFromUrl as jest.Mock).mockRejectedValue(
      Object.assign(new Error("Server couldn't download that image."), { kind: "server" })
    );
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.press(screen.getByLabelText("Cover tab"));
    await fireEvent.changeText(screen.getByLabelText("Cover image URL"), "https://x/y.jpg");
    await fireEvent.press(screen.getByLabelText("Set cover from URL"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't update cover",
          message: "Server couldn't download that image.",
        })
      )
    );
    expect(showSnackbar).not.toHaveBeenCalled();
    // URL preserved for a retry (only cleared on success).
    expect(screen.getByLabelText("Cover image URL").props.value).toBe("https://x/y.jpg");
  });

  it("cover search rejection surfaces a dialog instead of an empty grid", async () => {
    (searchCovers as jest.Mock).mockRejectedValue(
      Object.assign(new Error("Provider timed out."), { kind: "server" })
    );
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.press(screen.getByLabelText("Cover tab"));
    await fireEvent.press(screen.getByLabelText("Run cover search"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Cover search failed", message: "Provider timed out." })
      )
    );
    // No stale "No covers found" empty state from a failed search.
    expect(screen.queryByText("No covers found")).toBeNull();
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

  it("hides the matched-cover row without the upload permission (cover apply = cover upload)", async () => {
    useUserStore.setState({
      user: {
        id: "u3",
        username: "editor",
        type: "user",
        permissions: { update: true, upload: false },
      },
    } as any);
    await openMatchAndSearch();
    await fireEvent.press(
      await screen.findByLabelText(/^Match result: The Hobbit: There and Back Again/)
    );

    // Field rows still offered; the cover pseudo-row is gone.
    expect(screen.getByLabelText(/^ASIN: current empty/)).toBeTruthy();
    expect(screen.queryByLabelText("Cover: use the matched cover image")).toBeNull();
  });

  it("partial failure (metadata PATCH landed, cover POST failed) says the details WERE saved", async () => {
    (setCoverFromUrl as jest.Mock).mockRejectedValue(
      Object.assign(new Error("image fetch failed"), { kind: "server" })
    );
    await openMatchAndSearch();
    await fireEvent.press(
      await screen.findByLabelText(/^Match result: The Hobbit: There and Back Again/)
    );
    // Opt in to the matched cover (ASIN fill-missing is checked by default).
    await fireEvent.press(screen.getByLabelText("Cover: use the matched cover image"));
    await fireEvent.press(screen.getByText("Apply match"));

    await waitFor(() =>
      expect(updateItemMedia).toHaveBeenCalledWith("item1", { metadata: { asin: "B0HOBBIT" } })
    );
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Cover not applied",
          message: expect.stringContaining("matched details were saved"),
        })
      )
    );
    // The generic all-failed copy must NOT show — the PATCH landed.
    expect(showAppDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't apply match" })
    );
  });

  it("applying a match with UNSAVED Details edits prompts before the reseed clobbers them", async () => {
    await openMatchAndSearch();
    // Dirty the Details form first.
    await fireEvent.press(screen.getByLabelText("Details tab"));
    await fireEvent.changeText(screen.getByLabelText("Title"), "My unsaved edit");
    await fireEvent.press(screen.getByLabelText("Match tab"));
    await fireEvent.press(
      await screen.findByLabelText(/^Match result: The Hobbit: There and Back Again/)
    );
    await fireEvent.press(screen.getByText("Apply match"));

    // Nothing applied yet — the unsaved-edits prompt gates the flow.
    expect(updateItemMedia).not.toHaveBeenCalled();
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.title).toBe("Unsaved edits on Details");
    await act(async () => {
      await dialog.buttons.find((b: any) => b.text === "Apply match").onPress();
    });
    await waitFor(() => expect(updateItemMedia).toHaveBeenCalled());
  });
});
