/**
 * AdminMaintenanceScreen — bulk library cleanup (tags / genres rename+delete,
 * per-library narrator rename via the derived base64 narrator id) and the two
 * server cache purges. Every mutation is confirm-gated through showAppDialog
 * (nothing fires before the confirm button), rename collisions read as merges,
 * and load errors branch on the normalized AbsError kind (offline vs 403).
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
import AdminMaintenanceScreen from "../../screens/AdminMaintenanceScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { narratorNameToId } from "../../utils/abs/libraries";

const initialLibraryState = useLibraryStore.getState();

const TAGS = ["Fiction", "Science Fiction"];
const GENRES = ["Fantasy", "Horror"];
const NARRATORS = [
  { id: narratorNameToId("John Doe"), name: "John Doe", numBooks: 3 },
  { id: narratorNameToId("Jane Roe"), name: "Jane Roe", numBooks: 1 },
];

function mockGets({
  tags = TAGS,
  genres = GENRES,
  narrators = NARRATORS,
}: { tags?: string[]; genres?: string[]; narrators?: any[] } = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/tags") return Promise.resolve({ data: { tags } });
    if (url === "/api/genres") return Promise.resolve({ data: { genres } });
    if (url === "/api/libraries/lib1/narrators")
      return Promise.resolve({ data: { narrators } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminMaintenanceScreen navigation={navigation} route={{ params: {} }} />);
  return navigation;
}

function dialogWithTitle(title: string | RegExp) {
  const calls = (showAppDialog as jest.Mock).mock.calls.map((c) => c[0]);
  return [...calls]
    .reverse()
    .find((d) => (typeof title === "string" ? d?.title === title : title.test(d?.title ?? "")));
}

beforeEach(() => {
  useLibraryStore.setState(initialLibraryState, true);
  useLibraryStore.setState({
    libraries: [
      { id: "lib1", name: "Audiobooks", mediaType: "book", settings: {} },
      { id: "lib2", name: "Podcasts", mediaType: "podcast", settings: {} },
    ] as any,
    currentLibraryId: "lib1",
  });
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  (api.patch as jest.Mock).mockReset();
  (api.delete as jest.Mock).mockReset();
  (api.post as jest.Mock).mockResolvedValue({ data: {} });
  (api.patch as jest.Mock).mockResolvedValue({ data: { updated: 3 } });
  (api.delete as jest.Mock).mockResolvedValue({ data: {} });
  (showAppDialog as jest.Mock).mockClear();
  (showSnackbar as jest.Mock).mockClear();
  mockGets();
});

describe("AdminMaintenanceScreen — tags", () => {
  it("loads and lists tags on mount", async () => {
    await renderScreen();

    expect(await screen.findByText("Fiction")).toBeTruthy();
    expect(screen.getByText("Science Fiction")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/tags");
  });

  it("rename is confirm-gated and posts the verified rename payload", async () => {
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText("Rename Fiction"));
    const input = await screen.findByLabelText("New name for Fiction");
    await fireEvent.changeText(input, "Sci-Fi");
    await fireEvent.press(screen.getByLabelText("Confirm rename of Fiction"));

    // Nothing fired before the dialog confirm.
    expect(api.post).not.toHaveBeenCalled();
    const dialog = dialogWithTitle("Rename tag");
    expect(dialog).toBeTruthy();
    expect(dialog.message).toContain('"Fiction"');
    expect(dialog.message).toContain('"Sci-Fi"');

    dialog.buttons.find((b: any) => b.text === "Rename").onPress();

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/tags/rename", { tag: "Fiction", newTag: "Sci-Fi" })
    );
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(expect.objectContaining({ message: "Tag renamed" }))
    );
    // The list refetches after the rename.
    await waitFor(() =>
      expect((api.get as jest.Mock).mock.calls.filter((c) => c[0] === "/api/tags").length).toBe(2)
    );
  });

  it("renaming onto an existing tag reads as a merge", async () => {
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText("Rename Fiction"));
    await fireEvent.changeText(await screen.findByLabelText("New name for Fiction"), "Science Fiction");
    await fireEvent.press(screen.getByLabelText("Confirm rename of Fiction"));

    const dialog = dialogWithTitle("Rename tag");
    expect(dialog.message).toContain("merged");
    expect(dialog.buttons.find((b: any) => b.text === "Merge")).toBeTruthy();
  });

  it("delete is confirm-gated (destructive) and URI-encodes the tag path", async () => {
    await renderScreen();
    await screen.findByText("Science Fiction");

    await fireEvent.press(screen.getByLabelText("Delete Science Fiction"));
    expect(api.delete).not.toHaveBeenCalled();

    const dialog = dialogWithTitle("Delete tag");
    expect(dialog).toBeTruthy();
    const del = dialog.buttons.find((b: any) => b.text === "Delete");
    expect(del.style).toBe("destructive");
    del.onPress();

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/tags/Science%20Fiction"));
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(expect.objectContaining({ message: "Tag deleted" }))
    );
  });

  it("cancelling an inline rename restores the row without a dialog", async () => {
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText("Rename Fiction"));
    await fireEvent.changeText(await screen.findByLabelText("New name for Fiction"), "Whatever");
    await fireEvent.press(screen.getByLabelText("Cancel rename"));

    await waitFor(() => expect(screen.queryByLabelText("New name for Fiction")).toBeNull());
    expect(screen.getByText("Fiction")).toBeTruthy();
    expect(showAppDialog).not.toHaveBeenCalled();
  });
});

describe("AdminMaintenanceScreen — genres", () => {
  it("switching segments loads genres and rename posts the genre payload", async () => {
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText("Genres"));
    expect(await screen.findByText("Fantasy")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/genres");

    await fireEvent.press(screen.getByLabelText("Rename Fantasy"));
    await fireEvent.changeText(await screen.findByLabelText("New name for Fantasy"), "High Fantasy");
    await fireEvent.press(screen.getByLabelText("Confirm rename of Fantasy"));

    dialogWithTitle("Rename genre").buttons.find((b: any) => b.text === "Rename").onPress();

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/genres/rename", {
        genre: "Fantasy",
        newGenre: "High Fantasy",
      })
    );
  });

  it("genre delete hits the encoded genre route after confirm", async () => {
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText("Genres"));
    await screen.findByText("Horror");

    await fireEvent.press(screen.getByLabelText("Delete Horror"));
    dialogWithTitle("Delete genre").buttons.find((b: any) => b.text === "Delete").onPress();

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/genres/Horror"));
  });
});

describe("AdminMaintenanceScreen — narrators", () => {
  it("loads the current library's narrators with book counts", async () => {
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText("Narrators"));

    expect(await screen.findByText("John Doe")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/narrators");
    expect(screen.getByText("3 books")).toBeTruthy();
    expect(screen.getByText("1 book")).toBeTruthy();
    // Narrator cleanup is rename-to-merge only — no delete endpoint exists.
    expect(screen.queryByLabelText("Delete John Doe")).toBeNull();
  });

  it("rename PATCHes the derived base64 narrator id after confirm", async () => {
    await renderScreen();
    await screen.findByText("Fiction");
    await fireEvent.press(screen.getByLabelText("Narrators"));
    await screen.findByText("John Doe");

    await fireEvent.press(screen.getByLabelText("Rename John Doe"));
    await fireEvent.changeText(await screen.findByLabelText("New name for John Doe"), "Jonathan Doe");
    await fireEvent.press(screen.getByLabelText("Confirm rename of John Doe"));

    expect(api.patch).not.toHaveBeenCalled();
    dialogWithTitle("Rename narrator").buttons.find((b: any) => b.text === "Rename").onPress();

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        `/api/libraries/lib1/narrators/${narratorNameToId("John Doe")}`,
        { name: "Jonathan Doe" }
      )
    );
    // The id is the server's encodeURIComponent(base64(name)) derivation.
    expect(narratorNameToId("John Doe")).toBe(encodeURIComponent("Sm9obiBEb2U="));
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Narrator renamed") })
      )
    );
  });
});

describe("AdminMaintenanceScreen — cache", () => {
  it("purge all cache fires only after the destructive confirm", async () => {
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText(/Purge all cache/));
    expect(api.post).not.toHaveBeenCalled();

    const dialog = dialogWithTitle("Purge all cache");
    const purge = dialog.buttons.find((b: any) => b.text === "Purge");
    expect(purge.style).toBe("destructive");
    purge.onPress();

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/cache/purge"));
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Server cache purged" })
      )
    );
  });

  it("purge items cache hits its own route after confirm", async () => {
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText(/Purge items cache/));
    dialogWithTitle("Purge items cache").buttons.find((b: any) => b.text === "Purge").onPress();

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/cache/items/purge"));
  });

  it("a purge failure surfaces the normalized error dialog", async () => {
    (api.post as jest.Mock).mockRejectedValue(
      Object.assign(new Error("forbidden"), { response: { status: 403, data: "" } })
    );
    await renderScreen();
    await screen.findByText("Fiction");

    await fireEvent.press(screen.getByLabelText(/Purge all cache/));
    dialogWithTitle("Purge all cache").buttons.find((b: any) => b.text === "Purge").onPress();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't purge the cache",
          message: expect.stringContaining("permission"),
        })
      )
    );
    expect(showSnackbar).not.toHaveBeenCalled();
  });
});

describe("AdminMaintenanceScreen — error states", () => {
  it("offline tag load renders the offline ErrorState and retry recovers", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();

    mockGets();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("Fiction")).toBeTruthy();
  });

  it("403 tag load renders the admin-access ErrorState (not offline)", async () => {
    (api.get as jest.Mock).mockRejectedValue(
      Object.assign(new Error("forbidden"), { response: { status: 403, data: "" } })
    );
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});
