/**
 * OpmlImportSheet — bulk-add podcasts from OPML (issue #56 P2).
 *
 * Pins the load-bearing behaviors:
 *  - "Parse" POSTs /api/podcasts/opml/parse { opmlText } (the pinned body key)
 *    and every parsed feed renders as a CHECKED checkbox row;
 *  - deselecting a feed means the import POSTs ONLY the selected feeds;
 *  - "Import N podcasts" confirms, then POSTs /api/podcasts/opml/create with
 *    the exact { feeds, libraryId, folderId, autoDownloadEpisodes } body,
 *    snackbars "Import started on the server" and closes the sheet;
 *  - an empty parse shows the inline "No feeds found" message;
 *  - parse/create failures surface dialogs (and a failed create keeps the
 *    sheet open for a retry).
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));

import OpmlImportSheet from "../../components/OpmlImportSheet";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";

const Clipboard = require("expo-clipboard");

const OPML = "<opml><body><outline xmlUrl='https://a/rss'/></body></opml>";

const FEEDS = [
  { title: "Feed One", feedUrl: "https://a/rss" },
  { title: "Feed Two", feedUrl: "https://b/rss" },
];

const LIBS = [
  {
    id: "lib-books",
    name: "Audiobooks",
    mediaType: "book",
    folders: [{ id: "fb", fullPath: "/books" }],
  },
  {
    id: "lib-pods",
    name: "Podcasts",
    mediaType: "podcast",
    folders: [{ id: "f1", fullPath: "/podcasts" }],
  },
];

function mockApi({ feeds = FEEDS }: { feeds?: any[] } = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/libraries") return Promise.resolve({ data: { libraries: LIBS } });
    return Promise.reject(new Error(`unmocked GET ${url}`));
  });
  (api.post as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/podcasts/opml/parse") return Promise.resolve({ data: { feeds } });
    if (url === "/api/podcasts/opml/create") return Promise.resolve({ data: {} });
    return Promise.reject(new Error(`unmocked POST ${url}`));
  });
}

async function renderSheet(props: any = {}) {
  const onClose = jest.fn();
  await render(<OpmlImportSheet visible libraryId="lib-pods" onClose={onClose} {...props} />);
  await act(async () => {}); // flush the libraries fetch
  return onClose;
}

/** Paste OPML text and run the server-side parse. */
async function parseOpmlText(text: string = OPML) {
  await fireEvent.changeText(screen.getByLabelText("OPML content"), text);
  await fireEvent.press(screen.getByLabelText("Parse"));
  await act(async () => {});
}

/** Confirm the import dialog's Import button. */
async function confirmImport() {
  const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
  expect(dialog.title).toBe("Import podcasts");
  await act(async () => {
    await dialog.buttons.find((b: any) => b.text === "Import").onPress();
  });
}

const createCalls = () =>
  (api.post as jest.Mock).mock.calls.filter(([url]) => url === "/api/podcasts/opml/create");

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  mockApi();
});

it("Parse POSTs /api/podcasts/opml/parse { opmlText } and renders every feed CHECKED", async () => {
  await renderSheet();
  await parseOpmlText();

  expect(api.post).toHaveBeenCalledWith("/api/podcasts/opml/parse", { opmlText: OPML });

  const one = screen.getByLabelText("Feed: Feed One");
  const two = screen.getByLabelText("Feed: Feed Two");
  expect(one.props.accessibilityState?.checked).toBe(true);
  expect(two.props.accessibilityState?.checked).toBe(true);
  // Default selection drives the button label.
  expect(screen.getByLabelText("Import 2 podcasts")).toBeTruthy();
});

it("import posts the EXACT body + snackbar + onClose", async () => {
  const onClose = await renderSheet();
  await parseOpmlText();

  await fireEvent.press(screen.getByLabelText("Import 2 podcasts"));
  // Nothing sent before the confirm.
  expect(createCalls()).toHaveLength(0);
  await confirmImport();

  expect(createCalls()).toHaveLength(1);
  expect(createCalls()[0][1]).toEqual({
    feeds: FEEDS,
    libraryId: "lib-pods",
    folderId: "f1", // lib-pods' lone folder auto-selects
    autoDownloadEpisodes: false,
  });
  expect(showSnackbar).toHaveBeenCalledWith({ message: "Import started on the server" });
  expect(onClose).toHaveBeenCalled();
});

it("deselecting a feed imports ONLY the selected ones", async () => {
  await renderSheet();
  await parseOpmlText();

  await fireEvent.press(screen.getByLabelText("Feed: Feed Two"));
  expect(
    screen.getByLabelText("Feed: Feed Two").props.accessibilityState?.checked
  ).toBe(false);

  await fireEvent.press(screen.getByLabelText("Import 1 podcast"));
  await confirmImport();

  expect(createCalls()[0][1].feeds).toEqual([FEEDS[0]]);
});

it("the auto-download toggle rides into the create body", async () => {
  await renderSheet();
  await parseOpmlText();

  await fireEvent.press(screen.getByLabelText(/Auto-download episodes/));
  await fireEvent.press(screen.getByLabelText("Import 2 podcasts"));
  await confirmImport();

  expect(createCalls()[0][1].autoDownloadEpisodes).toBe(true);
});

it("an empty parse shows the inline 'No feeds found' message (no import UI)", async () => {
  mockApi({ feeds: [] });
  await renderSheet();
  await parseOpmlText();

  expect(screen.getByText("No feeds found in that OPML.")).toBeTruthy();
  expect(screen.queryByLabelText(/^Import \d/)).toBeNull();
});

it("Paste from clipboard fills the paste area via expo-clipboard", async () => {
  const clipSpy = jest
    .spyOn(Clipboard, "getStringAsync")
    .mockResolvedValue("<opml>from-clipboard</opml>");
  await renderSheet();

  await act(async () => {
    fireEvent.press(screen.getByLabelText("Paste from clipboard"));
  });

  expect(clipSpy).toHaveBeenCalled();
  expect(screen.getByLabelText("OPML content").props.value).toBe("<opml>from-clipboard</opml>");
  clipSpy.mockRestore();
});

it("a parse failure surfaces a dialog instead of feed rows", async () => {
  (api.post as jest.Mock).mockRejectedValue({ response: { status: 500, data: "bad opml" } });
  await renderSheet();
  await parseOpmlText();

  await waitFor(() =>
    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't parse the OPML", message: "bad opml" })
    )
  );
  expect(screen.queryByLabelText(/^Feed:/)).toBeNull();
});

it("a create failure surfaces a dialog and keeps the sheet open for a retry", async () => {
  const onClose = await renderSheet();
  await parseOpmlText();

  (api.post as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/podcasts/opml/create")
      return Promise.reject({ response: { status: 403, data: "" } });
    return Promise.reject(new Error(`unmocked POST ${url}`));
  });

  await fireEvent.press(screen.getByLabelText("Import 2 podcasts"));
  await confirmImport();

  await waitFor(() =>
    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't import podcasts" })
    )
  );
  expect(showSnackbar).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  // Retryable: the import button is enabled again.
  expect(
    screen.getByLabelText("Import 2 podcasts").props.accessibilityState?.disabled
  ).toBe(false);
});
