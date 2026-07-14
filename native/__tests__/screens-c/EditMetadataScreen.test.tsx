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
 *  - non-privileged users get a read-only lock state, never an editable form;
 *  - podcasts get the podcast-shaped Details form (feed URL / iTunes ID /
 *    episodic-serial type; no series/ISBN/narrators), the same dirty-only
 *    PATCH envelope, and NO Match tab (deferred for podcasts in this cut).
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
  uploadCoverFile: jest.fn(),
}));

import React from "react";
import { AccessibilityInfo, Linking } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import EditMetadataScreen, {
  buildDirtyPatch,
  assetToCoverFile,
} from "../../screens/EditMetadataScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import {
  updateItemMedia,
  searchBookMetadata,
  searchCovers,
  setCoverFromUrl,
  uploadCoverFile,
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

const PODCAST_ITEM = {
  id: "pod1",
  mediaType: "podcast",
  media: {
    id: "podcast-media-1",
    coverPath: "/covers/pod1.jpg",
    tags: ["News"],
    metadata: {
      title: "Daily Tech",
      author: "Jane Doe",
      description: "Tech news, daily.",
      releaseDate: "2020-01-01",
      genres: ["Technology"],
      feedUrl: "https://feeds.example/dailytech",
      imageUrl: "https://img.example/dt.jpg",
      itunesId: 123,
      explicit: false,
      language: "en",
      type: "episodic",
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
  (uploadCoverFile as jest.Mock).mockResolvedValue({ success: true, cover: "/covers/new.jpg" });
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

describe("EditMetadataScreen — cover upload from gallery (issue #61)", () => {
  const openCoverTab = async () => {
    await renderScreen();
    await screen.findByLabelText("Title");
    await fireEvent.press(screen.getByLabelText("Cover tab"));
  };

  it("picks an image and uploads it as a multipart cover file", async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///pick/pick.png", fileName: "pick.png", mimeType: "image/png" }],
    });
    await openCoverTab();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Upload from gallery"));
    });

    // NO pre-flight permission request: the system Photo Picker (Android) /
    // PHPicker (iOS) needs no media-library permission on SDK 57.
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    // SDK 57 string-array mediaTypes (MediaTypeOptions is deprecated).
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.9,
    });
    await waitFor(() =>
      expect(uploadCoverFile).toHaveBeenCalledWith("item1", {
        uri: "file:///pick/pick.png",
        name: "pick.png",
        type: "image/png",
      })
    );
    // Exact copy parity with set-by-URL and the search grid.
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Cover updated" });
    expect(showAppDialog).not.toHaveBeenCalled();
  });

  it("derives name from the uri and type from the extension when the picker omits them", async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///DCIM/Camera/abc.webp", fileName: null }],
    });
    await openCoverTab();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Upload from gallery"));
    });

    await waitFor(() =>
      expect(uploadCoverFile).toHaveBeenCalledWith("item1", {
        uri: "file:///DCIM/Camera/abc.webp",
        name: "abc.webp",
        type: "image/webp",
      })
    );
  });

  it("assetToCoverFile: fileName/mimeType win; falls back per-extension, then to cover.jpg/image/jpeg", () => {
    // Picker-provided metadata passes through untouched.
    expect(
      assetToCoverFile({ uri: "file:///a/b.png", fileName: "chosen.png", mimeType: "image/png" })
    ).toEqual({ uri: "file:///a/b.png", name: "chosen.png", type: "image/png" });
    // Extension inference: png / webp / jpg / unknown.
    expect(assetToCoverFile({ uri: "file:///x/y.PNG" }).type).toBe("image/png");
    expect(assetToCoverFile({ uri: "file:///x/y.webp" }).type).toBe("image/webp");
    expect(assetToCoverFile({ uri: "file:///x/y.jpeg" }).type).toBe("image/jpeg");
    expect(assetToCoverFile({ uri: "file:///x/y.bin" }).type).toBe("image/jpeg");
    // No usable last segment at all → bare cover.jpg / image/jpeg fallback.
    expect(assetToCoverFile({ uri: "content://media/" })).toEqual({
      uri: "content://media/",
      name: "cover.jpg",
      type: "image/jpeg",
    });
  });

  it("launches the picker directly — no pre-flight permission request; a permission-ish picker rejection falls back to the settings dialog", async () => {
    // SDK 57 uses the system Photo Picker (Android PickVisualMedia) / PHPicker
    // (iOS) — neither needs the media-library permission, so the pre-flight
    // gate is gone. If some OEM's picker still rejects with a permission
    // error, THAT is what routes to the settings dialog.
    const openSettingsSpy = jest
      .spyOn(Linking, "openSettings")
      .mockResolvedValue(undefined as any);
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockRejectedValueOnce(
      new Error("User rejected permissions")
    );
    await openCoverTab();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Upload from gallery"));
    });

    expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Photos permission needed" })
      )
    );
    expect(uploadCoverFile).not.toHaveBeenCalled();

    // The dialog's escape hatch routes to the system settings.
    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.buttons.find((b: any) => b.style === "cancel")).toBeTruthy();
    await act(async () => {
      dialog.buttons.find((b: any) => b.text === "Open settings").onPress();
    });
    expect(openSettingsSpy).toHaveBeenCalled();

    // Busy released — the flow is retryable.
    const btn = screen.getByLabelText("Upload from gallery");
    expect(btn.props.accessibilityState?.busy).toBe(false);
  });

  it("a non-permission picker rejection surfaces the cover error dialog and releases busy", async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockRejectedValueOnce(
      new Error("Failed to parse PhotoPicker result")
    );
    await openCoverTab();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Upload from gallery"));
    });

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't update cover",
          message: expect.stringContaining("PhotoPicker"),
        })
      )
    );
    // NOT the settings dialog — this isn't a permission problem.
    expect(showAppDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Photos permission needed" })
    );
    expect(uploadCoverFile).not.toHaveBeenCalled();
    expect(showSnackbar).not.toHaveBeenCalled();
    const btn = screen.getByLabelText("Upload from gallery");
    expect(btn.props.accessibilityState?.busy).toBe(false);
    expect(btn.props.accessibilityState?.disabled).toBe(false);
  });

  it("holds busy across the whole picker window — a double-tap launches only ONE picker", async () => {
    let resolvePick!: (v: any) => void;
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePick = resolve;
      })
    );
    await openCoverTab();

    const btn = screen.getByLabelText("Upload from gallery");
    await act(async () => {
      fireEvent.press(btn);
    });
    // Busy is held while the system picker is open (this is also what keeps
    // Set-cover-from-URL from interleaving mid-pick).
    expect(
      screen.getByLabelText("Upload from gallery").props.accessibilityState?.busy
    ).toBe(true);

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Upload from gallery"));
    });
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);

    // The user backs out — busy releases and nothing uploads.
    await act(async () => {
      resolvePick({ canceled: true, assets: null });
    });
    expect(uploadCoverFile).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Upload from gallery").props.accessibilityState?.busy
    ).toBe(false);
  });

  it("cancelling the picker is silent — no upload, no snackbar, no dialog", async () => {
    // jest.setup default: launchImageLibraryAsync resolves { canceled: true }.
    await openCoverTab();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Upload from gallery"));
    });

    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalled();
    expect(uploadCoverFile).not.toHaveBeenCalled();
    expect(showSnackbar).not.toHaveBeenCalled();
    expect(showAppDialog).not.toHaveBeenCalled();
  });

  it("upload failure surfaces the cover error dialog and releases the busy state", async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///pick/pick.jpg", fileName: "pick.jpg", mimeType: "image/jpeg" }],
    });
    (uploadCoverFile as jest.Mock).mockRejectedValue(
      Object.assign(new Error("boom"), { kind: "server" })
    );
    await openCoverTab();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Upload from gallery"));
    });

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't update cover",
          message: expect.stringContaining("boom"),
        })
      )
    );
    expect(showSnackbar).not.toHaveBeenCalled();
    // Busy released — the button is pressable again for a retry.
    const btn = screen.getByLabelText("Upload from gallery");
    expect(btn.props.accessibilityState?.busy).toBe(false);
    expect(btn.props.accessibilityState?.disabled).toBe(false);
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

describe("EditMetadataScreen — podcast items (issue #56 P2)", () => {
  const renderPodcast = async () => {
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url.startsWith("/api/items/pod1")) {
        return Promise.resolve({ data: JSON.parse(JSON.stringify(PODCAST_ITEM)) });
      }
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    return renderScreen({ libraryItemId: "pod1" });
  };

  it("renders the podcast-shaped Details form — feed fields present, book-only fields absent", async () => {
    await renderPodcast();

    expect((await screen.findByLabelText("Title")).props.value).toBe("Daily Tech");
    // Podcast author is a plain string field.
    expect(screen.getByLabelText("Author").props.value).toBe("Jane Doe");
    expect(screen.getByLabelText("Feed URL").props.value).toBe(
      "https://feeds.example/dailytech"
    );
    expect(screen.getByLabelText("iTunes ID").props.value).toBe("123");
    expect(screen.getByLabelText("Release date").props.value).toBe("2020-01-01");
    expect(screen.getByLabelText("Genres").props.value).toBe("Technology");
    expect(screen.getByLabelText("Tags").props.value).toBe("News");
    // Type renders as a select row seeded from metadata.type.
    expect(screen.getByLabelText("Podcast type, Episodic")).toBeTruthy();

    // Book-only fields must NOT exist on a podcast.
    expect(screen.queryByLabelText("ISBN")).toBeNull();
    expect(screen.queryByLabelText("ASIN")).toBeNull();
    expect(screen.queryByLabelText("Series")).toBeNull();
    expect(screen.queryByLabelText("Series sequence")).toBeNull();
    expect(screen.queryByLabelText("Narrators")).toBeNull();
    expect(screen.queryByLabelText("Publisher")).toBeNull();
    expect(screen.queryByLabelText("Abridged")).toBeNull();
  });

  it("editing feedUrl + podcast type PATCHes exactly { metadata: { feedUrl, type } }", async () => {
    await renderPodcast();
    await screen.findByLabelText("Title");

    await fireEvent.changeText(
      screen.getByLabelText("Feed URL"),
      "https://feeds.example/new-home"
    );
    // episodic → serial through the select row's sheet.
    await fireEvent.press(screen.getByLabelText("Podcast type, Episodic"));
    await fireEvent.press(await screen.findByLabelText("Serial"));

    await fireEvent.press(screen.getByLabelText("Save details"));
    await waitFor(() => expect(updateItemMedia).toHaveBeenCalled());
    // EXACT payload: podcast keys only, nothing book-shaped rides along.
    expect((updateItemMedia as jest.Mock).mock.calls[0][1]).toEqual({
      metadata: { feedUrl: "https://feeds.example/new-home", type: "serial" },
    });
  });

  it("a podcast author edit PATCHes metadata.author as a plain STRING (not an authors array)", async () => {
    await renderPodcast();
    await screen.findByLabelText("Title");
    await fireEvent.changeText(screen.getByLabelText("Author"), "New Host");
    await fireEvent.press(screen.getByLabelText("Save details"));

    await waitFor(() => expect(updateItemMedia).toHaveBeenCalled());
    expect((updateItemMedia as jest.Mock).mock.calls[0][1]).toEqual({
      metadata: { author: "New Host" },
    });
  });

  it("a podcast tags-only edit stays top-level { tags } with no metadata key", async () => {
    await renderPodcast();
    await screen.findByLabelText("Title");
    await fireEvent.changeText(screen.getByLabelText("Tags"), "News, Keepers");
    await fireEvent.press(screen.getByLabelText("Save details"));

    await waitFor(() => expect(updateItemMedia).toHaveBeenCalled());
    expect((updateItemMedia as jest.Mock).mock.calls[0][1]).toEqual({
      tags: ["News", "Keepers"],
    });
  });

  it("hides the Match tab for podcasts and keeps it for books (regression)", async () => {
    await renderPodcast();
    await screen.findByLabelText("Title");
    expect(screen.queryByLabelText("Match tab")).toBeNull();
    // Details and Cover remain.
    expect(screen.getByLabelText("Details tab")).toBeTruthy();
    expect(screen.getByLabelText("Cover tab")).toBeTruthy();

    screen.unmount();

    // Book regression: the Match tab is still offered. Restore the book item
    // mock (renderPodcast replaced the beforeEach implementation).
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url.startsWith("/api/items/item1")) {
        return Promise.resolve({ data: JSON.parse(JSON.stringify(ITEM)) });
      }
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    await renderScreen();
    await screen.findByLabelText("Title");
    expect(screen.getByLabelText("Match tab")).toBeTruthy();
  });

  it("buildDirtyPatch podcast branch: clean form → {}; cleared fields null out; book keys never emitted", () => {
    const seed: any = {
      title: "T",
      subtitle: "",
      authors: "Host",
      narrators: "",
      seriesName: "",
      seriesSequence: "",
      genres: "News",
      tags: "",
      description: "D",
      publisher: "",
      publishedYear: "",
      language: "en",
      isbn: "",
      asin: "",
      explicit: false,
      abridged: false,
      feedUrl: "https://f",
      itunesId: "1",
      podcastType: "episodic",
      releaseDate: "2020-01-01",
    };
    expect(buildDirtyPatch(seed, seed, [], true)).toEqual({});
    expect(
      buildDirtyPatch(
        { ...seed, authors: "", feedUrl: "", itunesId: "", releaseDate: "" },
        seed,
        [],
        true
      )
    ).toEqual({
      metadata: { author: null, feedUrl: null, itunesId: null, releaseDate: null },
    });
    // Book-shaped edits (series/ISBN/…) can never leak into a podcast patch.
    expect(
      buildDirtyPatch({ ...seed, seriesName: "S", isbn: "999", abridged: true }, seed, [], true)
    ).toEqual({});
    // explicit + type + genres + tags land in the shared envelope.
    expect(
      buildDirtyPatch(
        { ...seed, explicit: true, podcastType: "serial", genres: "News, Tech", tags: "a, b" },
        seed,
        [],
        true
      )
    ).toEqual({
      metadata: { explicit: true, type: "serial", genres: ["News", "Tech"] },
      tags: ["a", "b"],
    });
  });
});
