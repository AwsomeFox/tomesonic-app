/**
 * UploadMediaScreen — upload device media files into a server library (issue #57).
 *
 * Pins the load-bearing behaviors:
 *  - the mount-time capability gate: a spinner until refreshCapabilities settles,
 *    then a lock ErrorState for a user WITHOUT the (grantable) upload permission,
 *    with NO fetches firing while denied;
 *  - the file picker: getDocumentAsync assets become removable rows (empty state
 *    otherwise);
 *  - destination library/folder selection (book libraries only, lone folder
 *    auto-selects);
 *  - the Upload gate (disabled until files + library + folder), the confirm →
 *    uploadMediaFiles(EXACT params) hand-off, the progress bar driven by
 *    onProgress, Cancel → handle.cancel(), and the success + failure dialogs.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));
jest.mock("../../utils/mediaUploader", () => ({ uploadMediaFiles: jest.fn() }));
jest.mock("expo-document-picker", () => ({ getDocumentAsync: jest.fn() }));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import UploadMediaScreen from "../../screens/UploadMediaScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { uploadMediaFiles } from "../../utils/mediaUploader";
import * as DocumentPicker from "expo-document-picker";
import { useUserStore } from "../../store/useUserStore";

const initialUser = useUserStore.getState();

const UPLOAD_USER = {
  id: "u1",
  username: "tony",
  type: "user",
  permissions: { upload: true },
};
const NO_UPLOAD_USER = {
  id: "u2",
  username: "pat",
  type: "user",
  permissions: { upload: false },
};

const LIBS = [
  {
    id: "lib-books",
    name: "Audiobooks",
    mediaType: "book",
    folders: [{ id: "fb", fullPath: "/audiobooks" }],
  },
  {
    id: "lib-books2",
    name: "More Books",
    mediaType: "book",
    folders: [
      { id: "g1", fullPath: "/more1" },
      { id: "g2", fullPath: "/more2" },
    ],
  },
  {
    id: "lib-pods",
    name: "Podcasts",
    mediaType: "podcast",
    folders: [{ id: "fp", fullPath: "/podcasts" }],
  },
];

const ASSET = { uri: "file:///a.m4b", name: "Book One.m4b", mimeType: "audio/mp4", size: 1234 };
const ASSET_2 = { uri: "file:///b.mp3", name: "Two.mp3", mimeType: "audio/mpeg", size: 4096 };

// A controllable upload handle: the test resolves/rejects the promise and asserts
// the injected onProgress / cancel.
let resolveUpload: (v: any) => void;
let rejectUpload: (e: any) => void;
let cancelFn: jest.Mock;
let capturedOnProgress: ((sent: number, total: number) => void) | undefined;

function primeUploader() {
  (uploadMediaFiles as jest.Mock).mockImplementation((_params: any, opts: any) => {
    capturedOnProgress = opts?.onProgress;
    cancelFn = jest.fn();
    const promise = new Promise((res, rej) => {
      resolveUpload = res;
      rejectUpload = rej;
    });
    return { promise, cancel: cancelFn };
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen(params: any = { libraryId: "lib-books" }) {
  const navigation = makeNavigation();
  await render(<UploadMediaScreen navigation={navigation} route={{ params }} />);
  await act(async () => {});
  return navigation;
}

/** Drive the file picker to return `assets`, then press "Choose files". */
async function chooseFiles(assets: any[]) {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets,
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId("choose-files"));
  });
}

/** Press Upload and confirm the dialog's Upload button. */
async function confirmUpload() {
  await act(async () => {
    fireEvent.press(screen.getByTestId("upload-submit"));
  });
  const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
  expect(dialog.title).toBe("Upload media");
  await act(async () => {
    dialog.buttons.find((b: any) => b.text === "Upload").onPress();
  });
}

const dialogByTitle = (title: string) =>
  (showAppDialog as jest.Mock).mock.calls.map((c) => c[0]).find((d) => d?.title === title);

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useUserStore.setState({ user: UPLOAD_USER } as any);
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/libraries") return Promise.resolve({ data: { libraries: LIBS } });
    return Promise.reject(new Error(`unmocked GET ${url}`));
  });
  (api.post as jest.Mock).mockResolvedValue({ data: {} });
  (DocumentPicker.getDocumentAsync as jest.Mock).mockReset();
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: true, assets: null });
  capturedOnProgress = undefined;
  primeUploader();
});

describe("UploadMediaScreen — capability gate", () => {
  it("shows a spinner until refreshCapabilities settles, then reveals the form", async () => {
    // Cold-restored thin user + a token → refreshCapabilities POSTs /api/authorize;
    // hold it pending so the gate spinner is on screen.
    let authorizeResolve: (v: any) => void = () => {};
    (api.post as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/authorize")
        return new Promise((res) => {
          authorizeResolve = res;
        });
      return Promise.resolve({ data: {} });
    });
    useUserStore.setState({
      user: { id: "u1", username: "tony" },
      serverConnectionConfig: { token: "sess" },
    } as any);

    await renderScreen();
    expect(screen.getByTestId("upload-spinner")).toBeTruthy();
    expect(screen.queryByText("Choose files")).toBeNull();

    await act(async () => {
      authorizeResolve({ data: { user: UPLOAD_USER } });
    });

    expect(await screen.findByText("Choose files")).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/api/authorize");
  });

  it("a user without the upload permission gets the lock ErrorState and NO fetches fire", async () => {
    useUserStore.setState({ user: NO_UPLOAD_USER } as any);
    await renderScreen();

    expect(await screen.findByText("Upload not allowed")).toBeTruthy();
    expect(
      screen.getByText("You don't have permission to upload media to this server.")
    ).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe("UploadMediaScreen — file picker", () => {
  it("shows the empty state until files are chosen", async () => {
    await renderScreen();
    expect(screen.getByText("No files chosen")).toBeTruthy();
    // Nothing to upload yet.
    expect(screen.getByTestId("upload-submit").props.accessibilityState?.disabled).toBe(true);
  });

  it("picking files adds a row per asset (deduped by uri); the empty state clears", async () => {
    await renderScreen();
    await chooseFiles([ASSET, ASSET_2]);

    expect(screen.getByText("Book One.m4b")).toBeTruthy();
    expect(screen.getByText("Two.mp3")).toBeTruthy();
    expect(screen.queryByText("No files chosen")).toBeNull();

    // Re-picking the same uri does not duplicate the row.
    await chooseFiles([ASSET]);
    expect(screen.getAllByText("Book One.m4b")).toHaveLength(1);
  });

  it("a chosen file can be removed", async () => {
    await renderScreen();
    await chooseFiles([ASSET, ASSET_2]);

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Remove Book One.m4b"));
    });
    expect(screen.queryByText("Book One.m4b")).toBeNull();
    expect(screen.getByText("Two.mp3")).toBeTruthy();
  });

  it("a cancelled picker leaves the list unchanged", async () => {
    await renderScreen();
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: true,
      assets: null,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId("choose-files"));
    });
    expect(screen.getByText("No files chosen")).toBeTruthy();
  });
});

describe("UploadMediaScreen — destination", () => {
  it("preselects the param library and auto-selects its lone folder", async () => {
    await renderScreen();
    expect(screen.getByLabelText("Library, Audiobooks")).toBeTruthy();
    expect(screen.getByLabelText("Folder, /audiobooks")).toBeTruthy();
    expect(screen.getByText("Files will be placed under: /audiobooks")).toBeTruthy();
  });

  it("the library picker lists book libraries only; switching repopulates the folders", async () => {
    await renderScreen();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Library, Audiobooks"));
    });
    // Book libraries present, the podcast library is not offered.
    expect(screen.getByLabelText("More Books")).toBeTruthy();
    expect(screen.queryByLabelText("Podcasts")).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("More Books"));
    });
    // Two folders → none auto-selected.
    expect(screen.getByLabelText("Folder, Choose a folder")).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Folder, Choose a folder"));
    });
    expect(screen.getByLabelText("/more1")).toBeTruthy();
    expect(screen.getByLabelText("/more2")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("/more2"));
    });
    expect(screen.getByText("Files will be placed under: /more2")).toBeTruthy();
  });

  it("a libraries load failure is non-fatal — inline retry, form still usable", async () => {
    (api.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/libraries")
        return Promise.reject(Object.assign(new Error("boom"), { response: { status: 500 } }));
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    await renderScreen();

    expect(screen.getByText("Couldn't load your libraries. Tap to retry.")).toBeTruthy();
    // File-picking still works despite the libraries failure.
    await chooseFiles([ASSET]);
    expect(screen.getByText("Book One.m4b")).toBeTruthy();
  });
});

describe("UploadMediaScreen — upload", () => {
  it("Upload is disabled until files + library + folder are all present", async () => {
    await renderScreen();
    // Library + lone folder auto-selected, but no files yet → disabled.
    expect(screen.getByTestId("upload-submit").props.accessibilityState?.disabled).toBe(true);

    await chooseFiles([ASSET]);
    expect(screen.getByTestId("upload-submit").props.accessibilityState?.disabled).toBe(false);
    expect(screen.getByLabelText("Upload 1 file")).toBeTruthy();
  });

  it("confirm → uploadMediaFiles is called with the EXACT params + options", async () => {
    await renderScreen();
    await chooseFiles([ASSET]);

    await fireEvent.changeText(screen.getByTestId("meta-title"), "My Book");
    await fireEvent.changeText(screen.getByTestId("meta-author"), "Me");
    await fireEvent.changeText(screen.getByTestId("meta-series"), "S1");

    // Nothing sent before the confirm.
    await act(async () => {
      fireEvent.press(screen.getByTestId("upload-submit"));
    });
    expect(uploadMediaFiles).not.toHaveBeenCalled();

    const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
    expect(dialog.message).toBe("Upload 1 file to Audiobooks?");
    await act(async () => {
      dialog.buttons.find((b: any) => b.text === "Upload").onPress();
    });

    expect(uploadMediaFiles).toHaveBeenCalledTimes(1);
    expect((uploadMediaFiles as jest.Mock).mock.calls[0][0]).toEqual({
      libraryId: "lib-books",
      folderId: "fb",
      title: "My Book",
      author: "Me",
      series: "S1",
      files: [{ uri: "file:///a.m4b", name: "Book One.m4b", type: "audio/mp4" }],
    });
    const opts = (uploadMediaFiles as jest.Mock).mock.calls[0][1];
    expect(opts.notifyTitle).toBe("My Book");
    expect(opts.notifyId).toMatch(/^upload-/);
    expect(typeof opts.onProgress).toBe("function");
  });

  it("progress from onProgress drives the progress bar; Cancel calls handle.cancel()", async () => {
    await renderScreen();
    await chooseFiles([ASSET]);
    await confirmUpload();

    // Uploading UI is up.
    expect(screen.getByTestId("upload-progress")).toBeTruthy();

    await act(async () => {
      capturedOnProgress!(50, 100);
    });
    expect(screen.getByText(/Uploading.*50%/)).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId("upload-cancel"));
    });
    expect(cancelFn).toHaveBeenCalledTimes(1);

    // The cancel rejects the upload promise, but cancellation is user-initiated
    // — it must NOT surface an "Upload failed" dialog.
    await act(async () => {
      rejectUpload(new Error("Upload cancelled"));
    });
    expect(dialogByTitle("Upload failed")).toBeUndefined();
  });

  it("success shows the 'Upload complete' dialog whose Done pops back", async () => {
    const navigation = await renderScreen();
    await chooseFiles([ASSET]);
    await confirmUpload();

    await act(async () => {
      resolveUpload({});
    });

    const done = dialogByTitle("Upload complete");
    expect(done).toBeTruthy();
    await act(async () => {
      done.buttons.find((b: any) => b.text === "Done").onPress();
    });
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("failure surfaces the error message in a dialog and releases busy", async () => {
    await renderScreen();
    await chooseFiles([ASSET]);
    await confirmUpload();

    await act(async () => {
      rejectUpload(new Error("disk full"));
    });

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Upload failed", message: "disk full" })
      )
    );
    // Retryable: the submit button is back (busy released).
    expect(screen.getByTestId("upload-submit").props.accessibilityState?.disabled).toBe(false);
  });

  it("a successful upload shows the Upload complete dialog", async () => {
    await renderScreen();
    await chooseFiles([ASSET]);
    await confirmUpload();

    await act(async () => {
      resolveUpload({ libraryItemId: "li-99" });
    });
    await waitFor(() => expect(dialogByTitle("Upload complete")).toBeTruthy());
  });

  it("an upload that finishes AFTER the screen unmounts fires no dialog and no goBack", async () => {
    const navigation = makeNavigation();
    const { unmount } = await render(
      <UploadMediaScreen navigation={navigation} route={{ params: { libraryId: "lib-books" } }} />
    );
    await act(async () => {});
    await chooseFiles([ASSET]);
    await confirmUpload();

    // User leaves the screen mid-upload, THEN the upload resolves.
    await act(async () => {
      unmount();
    });
    await act(async () => {
      resolveUpload({ libraryItemId: "li-1" });
    });

    // No completion dialog popped over the next screen, and no stray goBack.
    expect(dialogByTitle("Upload complete")).toBeUndefined();
    expect(navigation.goBack).not.toHaveBeenCalled();
  });
});
