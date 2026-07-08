/**
 * BookmarksModal offline deletion — a delete that fails (offline) queues a
 * durable deletion via progressSync and still removes the row locally, and
 * server bookmarks with a queued-but-unflushed deletion are hidden on load.
 * (Online/list behavior lives in modals.test.tsx, which uses the real
 * progressSync module — this file mocks it to assert the queue wiring.)
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

// Named exports (SafeAreaView/useSafeAreaInsets) are missing from the global
// safe-area mock (default-only export) — provide them file-locally.
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
jest.mock("../../utils/progressSync", () => ({
  queueBookmark: jest.fn(),
  removePendingBookmark: jest.fn(),
  pendingBookmarksFor: jest.fn(() => []),
  queueBookmarkDeletion: jest.fn(),
  pendingBookmarkDeletionsFor: jest.fn(() => []),
  queueBookmarkRename: jest.fn(),
  pendingBookmarkRenamesFor: jest.fn(() => []),
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));

import BookmarksModal from "../../components/BookmarksModal";
import { showAppDialog } from "../../store/useDialogStore";
import { api } from "../../utils/api";
import {
  pendingBookmarksFor,
  queueBookmarkDeletion,
  pendingBookmarkDeletionsFor,
  queueBookmarkRename,
  pendingBookmarkRenamesFor,
} from "../../utils/progressSync";

const apiGet = api.get as jest.Mock;
const apiDelete = api.delete as jest.Mock;
const apiPatch = api.patch as jest.Mock;

const noop = () => {};

const serverBookmarks = [
  { libraryItemId: "item1", title: "Chapter start", time: 30 },
  { libraryItemId: "item1", title: "Great quote", time: 90.7 }, // floored to 90 for dedupe keys
];

const showDialog = showAppDialog as jest.Mock;

beforeEach(() => {
  (pendingBookmarksFor as jest.Mock).mockReturnValue([]);
  (pendingBookmarkDeletionsFor as jest.Mock).mockReturnValue([]);
  (pendingBookmarkRenamesFor as jest.Mock).mockReturnValue([]);
  (queueBookmarkRename as jest.Mock).mockClear();
  apiGet.mockResolvedValue({ data: { bookmarks: serverBookmarks } });
  apiPatch.mockResolvedValue({ data: {} });
  // Deletion now confirms first via the themed dialog — auto-tap the
  // destructive button so the existing deletion assertions still exercise the
  // delete path.
  showDialog.mockImplementation((opts: any) => {
    (opts?.buttons || []).find((b: any) => b.style === "destructive")?.onPress?.();
  });
});

describe("BookmarksModal offline deletion", () => {
  it("queues the deletion and still removes the row when the DELETE fails", async () => {
    apiDelete.mockRejectedValue(new Error("Network Error"));
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    await screen.findByText("Great quote");

    await fireEvent.press(screen.getAllByLabelText("Delete bookmark")[1]); // "Great quote" (sorted 2nd)

    await waitFor(() =>
      expect(queueBookmarkDeletion).toHaveBeenCalledWith("item1", 90.7)
    );
    // The row stays gone locally despite the failed request.
    expect(screen.queryByText("Great quote")).toBeNull();
    expect(screen.getByText("Chapter start")).toBeTruthy();
  });

  it("confirms before deleting, and Cancel keeps the bookmark", async () => {
    // Cancel path: the dialog shows but no destructive button is invoked.
    showDialog.mockImplementation(() => {});
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    await screen.findByText("Great quote");

    await fireEvent.press(screen.getAllByLabelText("Delete bookmark")[1]);

    expect(showDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete bookmark",
        message: expect.stringContaining("Great quote"),
        buttons: expect.any(Array),
      })
    );
    // Nothing deleted while the confirmation is pending / cancelled.
    expect(apiDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Great quote")).toBeTruthy();
  });

  it("never queues a deletion when the DELETE succeeds", async () => {
    apiDelete.mockResolvedValue({ data: {} });
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    await screen.findByText("Great quote");

    await fireEvent.press(screen.getAllByLabelText("Delete bookmark")[1]);

    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith("/api/me/item/item1/bookmark/90.7"));
    expect(queueBookmarkDeletion).not.toHaveBeenCalled();
  });

  it("hides server bookmarks whose queued deletion hasn't flushed yet", async () => {
    (pendingBookmarkDeletionsFor as jest.Mock).mockReturnValue([90]); // floored time
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );

    expect(await screen.findByText("Chapter start")).toBeTruthy();
    expect(pendingBookmarkDeletionsFor).toHaveBeenCalledWith("item1");
    // time 90.7 floors to 90, which is pending deletion — must not reappear.
    expect(screen.queryByText("Great quote")).toBeNull();
  });
});

describe("BookmarksModal per-item reset on offline loads", () => {
  // The item-match guard must be captured BEFORE setBookmarks — React defers
  // the functional updater, so reading loadedForRef inside it would see the
  // reassignment that follows and the previous item's rows would never drop.
  it(
    "switching items while offline drops the previous item's rows and shows only the new queue",
    async () => {
      // Item A loads its server bookmarks online...
      const { rerender } = await render(
        <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
      );
      await screen.findByText("Great quote");

      // ...then the user switches books while OFFLINE. Item A's rows must not
      // survive (they'd render — and delete — against item B's id).
      apiGet.mockRejectedValue(new Error("Network Error"));
      (pendingBookmarksFor as jest.Mock).mockImplementation((id: string) =>
        id === "item2" ? [{ time: 10, title: "B queued" }] : []
      );
      await rerender(
        <BookmarksModal visible onClose={noop} libraryItemId="item2" currentTime={200} onSeek={noop} />
      );

      await screen.findByText("B queued");
      expect(screen.queryByText("Great quote")).toBeNull();
      expect(screen.queryByText("Chapter start")).toBeNull();
    }
  );

  it("a same-item offline reload KEEPS the previously loaded rows and merges the queue", async () => {
    const { rerender } = await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    await screen.findByText("Great quote");

    // Connectivity drops, the sheet is closed and reopened on the SAME book:
    // the offline reload must merge, not wipe, what was already on screen.
    apiGet.mockRejectedValue(new Error("Network Error"));
    (pendingBookmarksFor as jest.Mock).mockReturnValue([{ time: 500, title: "Queued offline" }]);
    await rerender(
      <BookmarksModal visible={false} onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    await rerender(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );

    await screen.findByText("Queued offline");
    expect(screen.getByText("Chapter start")).toBeTruthy();
    expect(screen.getByText("Great quote")).toBeTruthy();
  });
});

describe("BookmarksModal named / editable bookmarks", () => {
  it("adds a bookmark with the typed title", async () => {
    apiGet.mockResolvedValue({ data: { bookmarks: [] } });
    const apiPost = api.post as jest.Mock;
    apiPost.mockResolvedValue({ data: {} });
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={125} onSeek={noop} />
    );

    await fireEvent.changeText(await screen.findByLabelText("Bookmark title"), "My favorite line");
    await fireEvent.press(screen.getByLabelText("Add bookmark at 2:05"));

    expect(apiPost).toHaveBeenCalledWith("/api/me/item/item1/bookmark", {
      title: "My favorite line",
      time: 125,
    });
  });

  it("a blank title falls back to a timestamp string (behavior unchanged)", async () => {
    apiGet.mockResolvedValue({ data: { bookmarks: [] } });
    const apiPost = api.post as jest.Mock;
    apiPost.mockClear();
    apiPost.mockResolvedValue({ data: {} });
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={125} onSeek={noop} />
    );

    // Add without typing a title.
    await fireEvent.press(await screen.findByLabelText("Add bookmark at 2:05"));

    expect(apiPost).toHaveBeenCalledWith("/api/me/item/item1/bookmark", {
      title: expect.any(String),
      time: 125,
    });
    const sent = apiPost.mock.calls[0][1].title as string;
    expect(sent.length).toBeGreaterThan(0); // non-empty auto-name
  });

  it("renames a bookmark online: PATCHes { time, title } and updates the row", async () => {
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    await screen.findByText("Great quote"); // time 90.7, sorted 2nd

    // Enter rename mode on the 2nd row and save a new title.
    await fireEvent.press(screen.getAllByLabelText("Rename bookmark")[1]);
    await fireEvent.changeText(screen.getByLabelText("Edit bookmark title"), "Best quote");
    await fireEvent.press(screen.getByLabelText("Save bookmark title"));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/api/me/item/item1/bookmark", {
        time: 90.7,
        title: "Best quote",
      })
    );
    expect(screen.getByText("Best quote")).toBeTruthy();
    expect(screen.queryByText("Great quote")).toBeNull();
    expect(queueBookmarkRename).not.toHaveBeenCalled();
  });

  it("queues the rename and still updates the row when the PATCH fails (offline)", async () => {
    apiPatch.mockRejectedValue(new Error("Network Error"));
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    await screen.findByText("Great quote");

    await fireEvent.press(screen.getAllByLabelText("Rename bookmark")[1]);
    await fireEvent.changeText(screen.getByLabelText("Edit bookmark title"), "Best quote");
    await fireEvent.press(screen.getByLabelText("Save bookmark title"));

    await waitFor(() =>
      expect(queueBookmarkRename).toHaveBeenCalledWith("item1", 90.7, "Best quote")
    );
    // The new title stays on screen despite the failed request.
    expect(screen.getByText("Best quote")).toBeTruthy();
  });

  it("applies a queued-offline rename over the server title on load", async () => {
    // A rename queued offline must show its new title even before it flushes.
    (pendingBookmarkRenamesFor as jest.Mock).mockReturnValue([{ time: 90.7, title: "Renamed offline" }]);
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );

    expect(await screen.findByText("Renamed offline")).toBeTruthy();
    expect(screen.queryByText("Great quote")).toBeNull();
    expect(pendingBookmarkRenamesFor).toHaveBeenCalledWith("item1");
  });
});
