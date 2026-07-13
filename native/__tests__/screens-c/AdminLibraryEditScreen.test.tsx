/**
 * AdminLibraryEditScreen — create mode (no libraryId param) posts a full
 * create payload; edit mode loads/seed-and-PATCHes; the two Tier-3 destructive
 * flows (delete library, remove an existing folder) require the typed-confirm
 * dialog (confirmInput) before anything fires; dirty back is discard-guarded;
 * load errors branch on the normalized AbsError kind.
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

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import AdminLibraryEditScreen from "../../screens/AdminLibraryEditScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";

const LIB_RESPONSE = {
  library: {
    id: "lib1",
    name: "Audiobooks",
    mediaType: "book",
    provider: "audible",
    folders: [
      { id: "fol1", fullPath: "/srv/audiobooks" },
      { id: "fol2", fullPath: "/srv/more-books" },
    ],
  },
};

function mockLibraryGet(response: any = LIB_RESPONSE) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/libraries/lib1") return Promise.resolve({ data: response });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen(params: any = {}) {
  const navigation = makeNavigation();
  await render(<AdminLibraryEditScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

function dialogWithTitle(title: string | RegExp) {
  const calls = (showAppDialog as jest.Mock).mock.calls.map((c) => c[0]);
  return [...calls]
    .reverse()
    .find((d) => (typeof title === "string" ? d?.title === title : title.test(d?.title ?? "")));
}

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  (api.patch as jest.Mock).mockReset();
  (api.delete as jest.Mock).mockReset();
  (api.post as jest.Mock).mockResolvedValue({ data: {} });
  (api.patch as jest.Mock).mockResolvedValue({ data: {} });
  (api.delete as jest.Mock).mockResolvedValue({ data: {} });
  (showAppDialog as jest.Mock).mockClear();
  (showSnackbar as jest.Mock).mockClear();
  mockLibraryGet();
});

describe("AdminLibraryEditScreen — create mode", () => {
  it("renders create mode without fetching, with media type pickable", async () => {
    await renderScreen({});

    expect(await screen.findByText("New library")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Media type: Books").props.accessibilityState.selected).toBe(true);
    // No delete affordance before a library exists.
    expect(screen.queryByLabelText("Delete library")).toBeNull();
  });

  it("creates a book library with the exact POST payload", async () => {
    const navigation = await renderScreen({});
    await screen.findByText("New library");

    await fireEvent.changeText(screen.getByLabelText("Library name"), "My Books");
    await fireEvent.press(screen.getByLabelText("Add folder"));
    await fireEvent.changeText(await screen.findByLabelText("Folder path 1"), "/data/books");

    await fireEvent.press(screen.getByLabelText("Create library"));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/libraries", {
        name: "My Books",
        mediaType: "book",
        provider: "google",
        folders: [{ fullPath: "/data/books" }],
      })
    );
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(expect.objectContaining({ message: "Library created" }))
    );
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("podcast media type flips the default provider and the payload", async () => {
    await renderScreen({});
    await screen.findByText("New library");

    await fireEvent.press(screen.getByLabelText("Media type: Podcasts"));
    await fireEvent.changeText(screen.getByLabelText("Library name"), "My Pods");
    await fireEvent.press(screen.getByLabelText("Add folder"));
    await fireEvent.changeText(await screen.findByLabelText("Folder path 1"), "/data/podcasts");

    await fireEvent.press(screen.getByLabelText("Create library"));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/libraries", {
        name: "My Pods",
        mediaType: "podcast",
        provider: "itunes",
        folders: [{ fullPath: "/data/podcasts" }],
      })
    );
  });

  it("blocks save without a name, then without a folder — no POST", async () => {
    await renderScreen({});
    await screen.findByText("New library");

    await fireEvent.press(screen.getByLabelText("Create library"));
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(expect.objectContaining({ title: "Missing name" }))
    );

    await fireEvent.changeText(screen.getByLabelText("Library name"), "My Books");
    await fireEvent.press(screen.getByLabelText("Create library"));
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(expect.objectContaining({ title: "Missing folder" }))
    );

    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("AdminLibraryEditScreen — edit mode", () => {
  it("loads the library and seeds the form (media type immutable)", async () => {
    await renderScreen({ libraryId: "lib1" });

    expect(await screen.findByText("Edit library")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1");
    expect(screen.getByLabelText("Library name").props.value).toBe("Audiobooks");
    expect(screen.getByLabelText("Metadata provider").props.value).toBe("audible");
    expect(screen.getByText("/srv/audiobooks")).toBeTruthy();
    expect(screen.getByText("/srv/more-books")).toBeTruthy();
    // Editing can't change the media type — shown read-only.
    expect(screen.getByText(/can't be changed after creation/)).toBeTruthy();
    expect(screen.queryByLabelText("Media type: Books")).toBeNull();
  });

  it("PATCHes name/provider/folders on save and pops back", async () => {
    const navigation = await renderScreen({ libraryId: "lib1" });
    await screen.findByText("Edit library");

    await fireEvent.changeText(screen.getByLabelText("Library name"), "Renamed Books");
    await fireEvent.press(screen.getByLabelText("Save library"));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/libraries/lib1", {
        name: "Renamed Books",
        provider: "audible",
        folders: [
          { id: "fol1", fullPath: "/srv/audiobooks" },
          { id: "fol2", fullPath: "/srv/more-books" },
        ],
      })
    );
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(expect.objectContaining({ message: "Library saved" }))
    );
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("removing an existing folder is a typed confirm (last path segment) and only applies on confirm", async () => {
    await renderScreen({ libraryId: "lib1" });
    await screen.findByText("Edit library");

    await fireEvent.press(screen.getByLabelText("Remove folder /srv/more-books"));

    const dialog = dialogWithTitle("Remove folder");
    expect(dialog).toBeTruthy();
    // Typed-confirm gate: the folder's last path segment must be typed.
    expect(dialog.confirmInput).toEqual(
      expect.objectContaining({ requiredText: "more-books" })
    );
    expect(dialog.message).toContain("Files on disk are NOT deleted");
    // Still present until confirmed.
    expect(screen.getByText("/srv/more-books")).toBeTruthy();

    const remove = dialog.buttons.find((b: any) => b.text === "Remove");
    expect(remove.style).toBe("destructive");
    remove.onPress();

    await waitFor(() => expect(screen.queryByText("/srv/more-books")).toBeNull());

    // Save now PATCHes without the removed folder.
    await fireEvent.press(screen.getByLabelText("Save library"));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/libraries/lib1", {
        name: "Audiobooks",
        provider: "audible",
        folders: [{ id: "fol1", fullPath: "/srv/audiobooks" }],
      })
    );
  });

  it("newly added (unsaved) folders are removable without a confirm", async () => {
    await renderScreen({ libraryId: "lib1" });
    await screen.findByText("Edit library");
    (showAppDialog as jest.Mock).mockClear();

    await fireEvent.press(screen.getByLabelText("Add folder"));
    const input = await screen.findByLabelText("Folder path 3");
    await fireEvent.changeText(input, "/draft/path");

    await fireEvent.press(screen.getByLabelText("Remove folder /draft/path"));
    await waitFor(() => expect(screen.queryByLabelText("Folder path 3")).toBeNull());
    expect(showAppDialog).not.toHaveBeenCalled();
  });

  it("delete library requires typing the library name and only DELETEs on confirm", async () => {
    const navigation = await renderScreen({ libraryId: "lib1" });
    await screen.findByText("Edit library");

    await fireEvent.press(screen.getByLabelText("Delete library"));

    expect(api.delete).not.toHaveBeenCalled();
    const dialog = dialogWithTitle("Delete library");
    expect(dialog).toBeTruthy();
    expect(dialog.confirmInput).toEqual(expect.objectContaining({ requiredText: "Audiobooks" }));
    expect(dialog.message).toContain("Files on disk are NOT deleted");

    const del = dialog.buttons.find((b: any) => b.text === "Delete");
    expect(del.style).toBe("destructive");
    del.onPress();

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/libraries/lib1"));
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(expect.objectContaining({ message: "Library deleted" }))
    );
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("back with unsaved edits asks to discard; clean back leaves silently", async () => {
    // Clean back: no dialog.
    let navigation = await renderScreen({ libraryId: "lib1" });
    await screen.findByText("Edit library");
    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(showAppDialog).not.toHaveBeenCalled();
    expect(navigation.goBack).toHaveBeenCalled();

    // Dirty back: discard-guarded.
    await screen.unmount();
    navigation = await renderScreen({ libraryId: "lib1" });
    await screen.findByText("Edit library");
    await fireEvent.changeText(screen.getByLabelText("Library name"), "Changed");
    await fireEvent.press(screen.getByLabelText("Go back"));

    const dialog = dialogWithTitle("Discard changes?");
    expect(dialog).toBeTruthy();
    expect(navigation.goBack).not.toHaveBeenCalled();
    dialog.buttons.find((b: any) => b.text === "Discard").onPress();
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("save failure surfaces the normalized error and stays on screen", async () => {
    (api.patch as jest.Mock).mockRejectedValue(
      Object.assign(new Error("forbidden"), { response: { status: 403, data: "" } })
    );
    const navigation = await renderScreen({ libraryId: "lib1" });
    await screen.findByText("Edit library");

    await fireEvent.changeText(screen.getByLabelText("Library name"), "Renamed");
    await fireEvent.press(screen.getByLabelText("Save library"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't save the library",
          message: expect.stringContaining("permission"),
        })
      )
    );
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it("offline load failure renders the offline ErrorState with retry", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response
    await renderScreen({ libraryId: "lib1" });

    expect(await screen.findByText("You're offline")).toBeTruthy();

    mockLibraryGet();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText(/can't be changed after creation/)).toBeTruthy();
  });

  it("403 load failure renders the admin-access ErrorState", async () => {
    (api.get as jest.Mock).mockRejectedValue(
      Object.assign(new Error("forbidden"), { response: { status: 403, data: "" } })
    );
    await renderScreen({ libraryId: "lib1" });

    expect(await screen.findByText("Admin access required")).toBeTruthy();
  });
});
