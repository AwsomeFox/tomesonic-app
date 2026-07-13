/**
 * AdminLibrariesScreen — lists the server's libraries fresh from
 * GET /api/libraries, fires scan / force re-scan / match-all ONLY after a
 * showAppDialog confirm (then watches the task queue and snackbars the
 * outcome), navigates to AdminLibraryEdit for create/edit, and branches its
 * load-error state on the normalized AbsError kind (offline vs 403 vs 5xx).
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
// The shared task poller is exercised in its own suite — here it's stubbed so
// no timers run; tests inject snapshots / watch results directly.
jest.mock("../../utils/abs/tasks", () => ({
  subscribeTasks: jest.fn(() => jest.fn()),
  getTasksSnapshot: jest.fn(() => []),
  startTaskWatch: jest.fn(() => Promise.resolve(null)),
}));
jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (cb: any) => require("react").useEffect(cb, [cb]),
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import AdminLibrariesScreen from "../../screens/AdminLibrariesScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { subscribeTasks, getTasksSnapshot, startTaskWatch } from "../../utils/abs/tasks";

const LIBS = [
  {
    id: "lib1",
    name: "Audiobooks",
    mediaType: "book",
    icon: "books-1",
    folders: [{ id: "fol1", fullPath: "/srv/audiobooks" }, { id: "fol2", fullPath: "/srv/more" }],
  },
  {
    id: "lib2",
    name: "Podcasts",
    mediaType: "podcast",
    icon: "podcast",
    folders: [{ id: "fol3", fullPath: "/srv/podcasts" }],
  },
];

function mockLibrariesGet(libs: any[] = LIBS) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/libraries") return Promise.resolve({ data: { libraries: libs } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminLibrariesScreen navigation={navigation} route={{ params: {} }} />);
  return navigation;
}

// Find the most recent dialog whose title matches.
function dialogWithTitle(title: string | RegExp) {
  const calls = (showAppDialog as jest.Mock).mock.calls.map((c) => c[0]);
  return [...calls]
    .reverse()
    .find((d) => (typeof title === "string" ? d?.title === title : title.test(d?.title ?? "")));
}

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  (api.post as jest.Mock).mockResolvedValue({ data: {} });
  (showAppDialog as jest.Mock).mockClear();
  (showSnackbar as jest.Mock).mockClear();
  (subscribeTasks as jest.Mock).mockReturnValue(jest.fn());
  (getTasksSnapshot as jest.Mock).mockReturnValue([]);
  (startTaskWatch as jest.Mock).mockResolvedValue(null);
  mockLibrariesGet();
});

describe("AdminLibrariesScreen", () => {
  it("lists the server's libraries with media type + folder count subtitles", async () => {
    await renderScreen();

    expect(await screen.findByText("Audiobooks")).toBeTruthy();
    expect(screen.getByText("Podcasts")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries");
    expect(screen.getByText("Books · 2 folders")).toBeTruthy();
    expect(screen.getByText("Podcasts · 1 folder")).toBeTruthy();
  });

  it("header add navigates to AdminLibraryEdit in create mode; row tap edits", async () => {
    const navigation = await renderScreen();
    await screen.findByText("Audiobooks");

    await fireEvent.press(screen.getByLabelText("Add library"));
    expect(navigation.navigate).toHaveBeenCalledWith("AdminLibraryEdit", {});

    await fireEvent.press(screen.getByLabelText("Edit Audiobooks"));
    expect(navigation.navigate).toHaveBeenCalledWith("AdminLibraryEdit", { libraryId: "lib1" });
  });

  it("scan fires the POST only after the confirm dialog's Scan button", async () => {
    await renderScreen();
    await screen.findByText("Audiobooks");

    await fireEvent.press(screen.getByLabelText("Scan Audiobooks"));

    // Confirm requested, nothing fired yet.
    expect(api.post).not.toHaveBeenCalled();
    const dialog = dialogWithTitle('Scan "Audiobooks"');
    expect(dialog).toBeTruthy();

    dialog.buttons.find((b: any) => b.text === "Scan").onPress();

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect((api.post as jest.Mock).mock.calls[0][0]).toBe("/api/libraries/lib1/scan");
    // Plain scan carries no force param.
    expect((api.post as jest.Mock).mock.calls[0][2]?.params).toBeUndefined();
    // Kickoff snackbar + task watch for the scan's completion.
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Scanning "Audiobooks"') })
      )
    );
    expect(startTaskWatch).toHaveBeenCalled();
  });

  it("force re-scan passes force=1", async () => {
    await renderScreen();
    await screen.findByText("Audiobooks");

    await fireEvent.press(screen.getByLabelText("Scan Audiobooks"));
    dialogWithTitle('Scan "Audiobooks"').buttons
      .find((b: any) => b.text === "Force re-scan")
      .onPress();

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/libraries/lib1/scan",
        undefined,
        expect.objectContaining({ params: { force: 1 } })
      )
    );
  });

  it("snackbars the terminal task state once the watched scan finishes", async () => {
    (startTaskWatch as jest.Mock).mockResolvedValue({
      id: "t1",
      action: "library-scan",
      data: { libraryId: "lib1" },
      title: "Scanning Audiobooks",
      error: null,
      isFailed: false,
      isFinished: true,
      startedAt: 1,
      finishedAt: 2,
    });
    await renderScreen();
    await screen.findByText("Audiobooks");

    await fireEvent.press(screen.getByLabelText("Scan Audiobooks"));
    dialogWithTitle('Scan "Audiobooks"').buttons.find((b: any) => b.text === "Scan").onPress();

    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Scan of "Audiobooks" finished' })
      )
    );
  });

  it("match-all is confirm-gated (destructive) and fires the verified GET route", async () => {
    await renderScreen();
    await screen.findByText("Audiobooks");
    const matchallCalls = () =>
      (api.get as jest.Mock).mock.calls.filter((c) => c[0] === "/api/libraries/lib1/matchall");

    await fireEvent.press(screen.getByLabelText("Match all in Audiobooks"));
    expect(matchallCalls()).toHaveLength(0);

    const dialog = dialogWithTitle('Match all items in "Audiobooks"');
    expect(dialog).toBeTruthy();
    const confirm = dialog.buttons.find((b: any) => b.text === "Match all");
    expect(confirm.style).toBe("destructive");
    confirm.onPress();

    await waitFor(() => expect(matchallCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Matching all items") })
      )
    );
  });

  it("hides match-all for podcast libraries (book-library feature)", async () => {
    await renderScreen();
    await screen.findByText("Podcasts");

    expect(screen.queryByLabelText("Match all in Podcasts")).toBeNull();
    // Scanning still available for podcast libraries.
    expect(screen.getByLabelText("Scan Podcasts")).toBeTruthy();
  });

  it("a 403 on scan surfaces the forbidden message in a dialog", async () => {
    (api.post as jest.Mock).mockRejectedValue(
      Object.assign(new Error("forbidden"), { response: { status: 403, data: "" } })
    );
    await renderScreen();
    await screen.findByText("Audiobooks");

    await fireEvent.press(screen.getByLabelText("Scan Audiobooks"));
    dialogWithTitle('Scan "Audiobooks"').buttons.find((b: any) => b.text === "Scan").onPress();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't start the scan",
          message: expect.stringContaining("permission"),
        })
      )
    );
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it("offline load failure renders the offline ErrorState and retry refetches", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();

    // Server back — retry reloads the list.
    mockLibrariesGet();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("Audiobooks")).toBeTruthy();
  });

  it("403 load failure renders the admin-access ErrorState (not offline)", async () => {
    (api.get as jest.Mock).mockRejectedValue(
      Object.assign(new Error("forbidden"), { response: { status: 403, data: "" } })
    );
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it("shows a live status chip on rows with a running scan task", async () => {
    (getTasksSnapshot as jest.Mock).mockReturnValue([
      {
        id: "t1",
        action: "library-scan",
        data: { libraryId: "lib1" },
        title: "Scanning Audiobooks",
        error: null,
        isFailed: false,
        isFinished: false,
        startedAt: 1,
        finishedAt: null,
      },
    ]);
    await renderScreen();
    await screen.findByText("Audiobooks");

    expect(screen.getByText("Scanning")).toBeTruthy();
    // The screen subscribed to the shared poller while focused.
    expect(subscribeTasks).toHaveBeenCalled();
  });

  it("shows the empty state when the server has no libraries", async () => {
    mockLibrariesGet([]);
    await renderScreen();

    expect(await screen.findByText("No libraries")).toBeTruthy();
  });
});
