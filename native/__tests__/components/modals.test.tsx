/**
 * Bottom-sheet modals: ChaptersModal, BookmarksModal, PlaybackSpeedModal,
 * SleepTimerModal, SettingSelectModal, OrderModal, LibrarySelector —
 * open, list, select → callback wiring.
 */
import { render, screen, fireEvent } from "@testing-library/react-native";

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

import ChaptersModal from "../../components/ChaptersModal";
import BookmarksModal from "../../components/BookmarksModal";
import PlaybackSpeedModal from "../../components/PlaybackSpeedModal";
import SleepTimerModal from "../../components/SleepTimerModal";
import SettingSelectModal from "../../components/SettingSelectModal";
import OrderModal from "../../components/OrderModal";
import LibrarySelector from "../../components/LibrarySelector";
import { api } from "../../utils/api";
import { useUiStore } from "../../store/useUiStore";
import { useLibraryStore } from "../../store/useLibraryStore";

const apiGet = api.get as jest.Mock;
const apiPost = api.post as jest.Mock;
const apiDelete = api.delete as jest.Mock;

const uiInitial = useUiStore.getState();
const libraryInitial = useLibraryStore.getState();

beforeEach(() => {
  useUiStore.setState(uiInitial, true);
  useLibraryStore.setState(libraryInitial, true);
});

const noop = () => {};

// ---------------------------------------------------------------------------
describe("ChaptersModal", () => {
  const chapters = [
    { id: 0, title: "Opening", start: 0, end: 600 },
    { id: 1, title: "The Journey", start: 600, end: 4200 },
    { id: 2, title: "", start: 4200, end: 5000 }, // untitled → "Chapter 3"
  ];

  it("lists chapters with formatted start timestamps", async () => {
    await render(
      <ChaptersModal
        visible
        onClose={noop}
        chapters={chapters}
        currentChapterIndex={1}
        onSeekToChapter={noop}
      />
    );
    expect(screen.getByText("Chapters")).toBeTruthy();
    expect(screen.getByText("Opening")).toBeTruthy();
    expect(screen.getByText("The Journey")).toBeTruthy();
    expect(screen.getByText("Chapter 3")).toBeTruthy();
    expect(screen.getByText("0:00")).toBeTruthy();
    expect(screen.getByText("10:00")).toBeTruthy();
    expect(screen.getByText("1:10:00")).toBeTruthy(); // h:mm:ss over an hour
  });

  it("marks the active chapter selected", async () => {
    await render(
      <ChaptersModal
        visible
        onClose={noop}
        chapters={chapters}
        currentChapterIndex={1}
        onSeekToChapter={noop}
      />
    );
    const active = screen.getByLabelText(/The Journey, starts at 10:00/);
    expect(active.props.accessibilityState?.selected).toBe(true);
  });

  it("tapping a chapter seeks to its index and closes", async () => {
    const onSeekToChapter = jest.fn();
    const onClose = jest.fn();
    await render(
      <ChaptersModal
        visible
        onClose={onClose}
        chapters={chapters}
        currentChapterIndex={0}
        onSeekToChapter={onSeekToChapter}
      />
    );
    await fireEvent.press(screen.getByText("The Journey"));
    expect(onSeekToChapter).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an empty state without chapters", async () => {
    await render(
      <ChaptersModal
        visible
        onClose={noop}
        chapters={[]}
        currentChapterIndex={-1}
        onSeekToChapter={noop}
      />
    );
    expect(screen.getByText("No chapters available")).toBeTruthy();
  });

  it("close button fires onClose", async () => {
    const onClose = jest.fn();
    await render(
      <ChaptersModal
        visible
        onClose={onClose}
        chapters={chapters}
        currentChapterIndex={0}
        onSeekToChapter={noop}
      />
    );
    await fireEvent.press(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("BookmarksModal", () => {
  const serverBookmarks = [
    { libraryItemId: "item1", title: "Great quote", time: 90 },
    { libraryItemId: "item1", title: "Chapter start", time: 30 },
    { libraryItemId: "other", title: "Different book", time: 10 },
  ];

  it("loads, filters to the item, and sorts bookmarks by time", async () => {
    apiGet.mockResolvedValue({ data: { bookmarks: serverBookmarks } });
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    expect(await screen.findByText("Chapter start")).toBeTruthy();
    expect(screen.getByText("Great quote")).toBeTruthy();
    expect(screen.queryByText("Different book")).toBeNull();
    expect(screen.getByText("0:30")).toBeTruthy();
    expect(screen.getByText("1:30")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith("/api/me");
  });

  it("tapping a bookmark seeks and closes", async () => {
    apiGet.mockResolvedValue({ data: { bookmarks: serverBookmarks } });
    const onSeek = jest.fn();
    const onClose = jest.fn();
    await render(
      <BookmarksModal visible onClose={onClose} libraryItemId="item1" currentTime={200} onSeek={onSeek} />
    );
    await fireEvent.press(await screen.findByText("Great quote"));
    expect(onSeek).toHaveBeenCalledWith(90);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the empty state when the item has no bookmarks", async () => {
    apiGet.mockResolvedValue({ data: { bookmarks: [] } });
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={0} onSeek={noop} />
    );
    expect(await screen.findByText("No bookmarks")).toBeTruthy();
  });

  it("adds a bookmark at the current time (optimistic + POST)", async () => {
    apiGet.mockResolvedValue({ data: { bookmarks: [] } });
    apiPost.mockResolvedValue({ data: {} });
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={125} onSeek={noop} />
    );
    await fireEvent.press(await screen.findByLabelText("Add bookmark at 2:05"));
    expect(apiPost).toHaveBeenCalledWith("/api/me/item/item1/bookmark", {
      title: expect.any(String),
      time: 125,
    });
  });

  it("hides the add row when the current time is already bookmarked", async () => {
    apiGet.mockResolvedValue({
      data: { bookmarks: [{ libraryItemId: "item1", title: "Here", time: 125 }] },
    });
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={125.4} onSeek={noop} />
    );
    expect(await screen.findByText("Here")).toBeTruthy();
    expect(screen.queryByLabelText(/Add bookmark/)).toBeNull();
  });

  it("deletes a bookmark locally and on the server", async () => {
    apiGet.mockResolvedValue({ data: { bookmarks: serverBookmarks } });
    apiDelete.mockResolvedValue({ data: {} });
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId="item1" currentTime={200} onSeek={noop} />
    );
    await screen.findByText("Great quote");
    await fireEvent.press(screen.getAllByLabelText("Delete bookmark")[1]); // "Great quote" (time 90, sorted 2nd)
    expect(apiDelete).toHaveBeenCalledWith("/api/me/item/item1/bookmark/90");
    expect(screen.queryByText("Great quote")).toBeNull();
  });

  it("local-only item (no server id) never fetches and shows empty state", async () => {
    await render(
      <BookmarksModal visible onClose={noop} libraryItemId={undefined} currentTime={0} onSeek={noop} />
    );
    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.getByText("No bookmarks")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("PlaybackSpeedModal", () => {
  it("shows the current speed and quick-pick chips", async () => {
    await render(<PlaybackSpeedModal visible onClose={noop} speed={1.0} onChange={noop} />);
    expect(screen.getByLabelText("Current speed 1.00 times")).toBeTruthy();
    for (const chip of ["0.75×", "1×", "1.25×", "1.5×", "1.75×", "2×"]) {
      expect(screen.getByText(chip)).toBeTruthy();
    }
  });

  it("stepper increments/decrements by 0.05", async () => {
    const onChange = jest.fn();
    await render(<PlaybackSpeedModal visible onClose={noop} speed={1.0} onChange={onChange} />);
    await fireEvent.press(screen.getByLabelText("Increase speed"));
    expect(onChange).toHaveBeenCalledWith(1.05);
    await fireEvent.press(screen.getByLabelText("Decrease speed"));
    expect(onChange).toHaveBeenCalledWith(0.95);
  });

  it("clamps at the minimum speed (0.5×)", async () => {
    const onChange = jest.fn();
    await render(<PlaybackSpeedModal visible onClose={noop} speed={0.5} onChange={onChange} />);
    const dec = screen.getByLabelText("Decrease speed");
    expect(dec.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(dec);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clamps at the maximum speed (3.0×)", async () => {
    const onChange = jest.fn();
    await render(<PlaybackSpeedModal visible onClose={noop} speed={3.0} onChange={onChange} />);
    const inc = screen.getByLabelText("Increase speed");
    expect(inc.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(inc);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("quick-pick chip selects that rate", async () => {
    const onChange = jest.fn();
    await render(<PlaybackSpeedModal visible onClose={noop} speed={1.0} onChange={onChange} />);
    await fireEvent.press(screen.getByText("1.5×"));
    expect(onChange).toHaveBeenCalledWith(1.5);
  });

  it("marks the active chip selected", async () => {
    await render(<PlaybackSpeedModal visible onClose={noop} speed={1.25} onChange={noop} />);
    expect(screen.getByLabelText("1.25 times speed").props.accessibilityState?.selected).toBe(true);
    expect(screen.getByLabelText("1.5 times speed").props.accessibilityState?.selected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("SleepTimerModal", () => {
  it("lists preset durations and End of chapter when a chapter exists", async () => {
    await render(
      <SleepTimerModal visible onClose={noop} timer={null} hasChapter onSet={noop} onCancel={noop} />
    );
    for (const label of ["5 min", "10 min", "15 min", "30 min", "45 min", "60 min"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("End of chapter")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("hides End of chapter without a chapter", async () => {
    await render(
      <SleepTimerModal visible onClose={noop} timer={null} hasChapter={false} onSet={noop} onCancel={noop} />
    );
    expect(screen.queryByText("End of chapter")).toBeNull();
  });

  it("preset row sets seconds and closes", async () => {
    const onSet = jest.fn();
    const onClose = jest.fn();
    await render(
      <SleepTimerModal visible onClose={onClose} timer={null} hasChapter onSet={onSet} onCancel={noop} />
    );
    await fireEvent.press(screen.getByText("30 min"));
    expect(onSet).toHaveBeenCalledWith(1800, false);
    expect(onClose).toHaveBeenCalled();
  });

  it("End of chapter arms the end-of-chapter timer", async () => {
    const onSet = jest.fn();
    await render(
      <SleepTimerModal visible onClose={noop} timer={null} hasChapter onSet={onSet} onCancel={noop} />
    );
    await fireEvent.press(screen.getByText("End of chapter"));
    expect(onSet).toHaveBeenCalledWith(0, true);
  });

  it("custom stepper adjusts minutes and sets the timer", async () => {
    const onSet = jest.fn();
    await render(
      <SleepTimerModal visible onClose={noop} timer={null} hasChapter onSet={onSet} onCancel={noop} />
    );
    await fireEvent.press(screen.getByText("Custom"));
    expect(screen.getByText("15 min")).toBeTruthy(); // default custom minutes
    await fireEvent.press(screen.getByLabelText("Increase minutes"));
    await fireEvent.press(screen.getByLabelText("Increase minutes"));
    expect(screen.getByText("17 min")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Decrease minutes"));
    expect(screen.getByText("16 min")).toBeTruthy();
    await fireEvent.press(screen.getByText("Set Timer"));
    expect(onSet).toHaveBeenCalledWith(16 * 60, false);
  });

  it("active timer shows remaining time and cancels", async () => {
    const onCancel = jest.fn();
    const onClose = jest.fn();
    await render(
      <SleepTimerModal
        visible
        onClose={onClose}
        timer={{ endOfChapter: false, remaining: 754 }}
        hasChapter
        onSet={noop}
        onCancel={onCancel}
      />
    );
    expect(screen.getByText("12:34")).toBeTruthy();
    await fireEvent.press(screen.getByText("Cancel Timer"));
    expect(onCancel).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("active end-of-chapter timer is labeled as such", async () => {
    await render(
      <SleepTimerModal
        visible
        onClose={noop}
        timer={{ endOfChapter: true, remaining: 300 }}
        hasChapter
        onSet={noop}
        onCancel={noop}
      />
    );
    expect(screen.getByText("End of chapter")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("SettingSelectModal", () => {
  const options = [
    { label: "Small", value: "s" },
    { label: "Medium", value: "m" },
    { label: "Large", value: "l" },
  ];

  it("renders title and options with the selection checked", async () => {
    await render(
      <SettingSelectModal
        visible
        title="Cover size"
        options={options}
        selected="m"
        onSelect={noop}
        onClose={noop}
      />
    );
    expect(screen.getByText("Cover size")).toBeTruthy();
    expect(screen.getByLabelText("Medium").props.accessibilityState?.checked).toBe(true);
    expect(screen.getByLabelText("Small").props.accessibilityState?.checked).toBe(false);
  });

  it("selecting an option fires onSelect with the value then closes", async () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    await render(
      <SettingSelectModal
        visible
        title="Cover size"
        options={options}
        selected="s"
        onSelect={onSelect}
        onClose={onClose}
      />
    );
    await fireEvent.press(screen.getByText("Large"));
    expect(onSelect).toHaveBeenCalledWith("l");
    expect(onClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("OrderModal", () => {
  beforeEach(() => {
    useLibraryStore.setState({
      libraries: [{ id: "lib1", name: "Books", mediaType: "book", settings: {} }],
      currentLibraryId: "lib1",
    } as any);
  });

  it("lists the book sort fields", async () => {
    await render(
      <OrderModal visible onClose={noop} orderBy="addedAt" descending onChange={noop} />
    );
    expect(screen.getByText("Sort by")).toBeTruthy();
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Author (First Last)")).toBeTruthy();
    expect(screen.getByText("Duration")).toBeTruthy();
  });

  it("uses series sort fields when series flag is set", async () => {
    await render(
      <OrderModal visible onClose={noop} orderBy="name" descending={false} series onChange={noop} />
    );
    expect(screen.getByText("Number of Books")).toBeTruthy();
    expect(screen.queryByText("Duration")).toBeNull();
    expect(screen.getByText("Total Duration")).toBeTruthy();
  });

  it("selecting a new field defaults ascending (except addedAt → descending)", async () => {
    const onChange = jest.fn();
    await render(
      <OrderModal visible onClose={noop} orderBy="addedAt" descending onChange={onChange} />
    );
    await fireEvent.press(screen.getByText("Title"));
    expect(onChange).toHaveBeenCalledWith("media.metadata.title", false);
  });

  it("selecting addedAt anew defaults to descending", async () => {
    const onChange = jest.fn();
    await render(
      <OrderModal visible onClose={noop} orderBy="media.metadata.title" descending={false} onChange={onChange} />
    );
    await fireEvent.press(screen.getByText("Added At"));
    expect(onChange).toHaveBeenCalledWith("addedAt", true);
  });

  it("re-selecting the current field toggles direction", async () => {
    const onChange = jest.fn();
    const onClose = jest.fn();
    await render(
      <OrderModal visible onClose={onClose} orderBy="media.metadata.title" descending={false} onChange={onChange} />
    );
    await fireEvent.press(screen.getByText("Title"));
    expect(onChange).toHaveBeenCalledWith("media.metadata.title", true);
    expect(onClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("LibrarySelector", () => {
  beforeEach(() => {
    useLibraryStore.setState({
      libraries: [
        { id: "lib1", name: "Audiobooks", mediaType: "book", settings: {} },
        { id: "lib2", name: "Podcasts", mediaType: "podcast", settings: {} },
      ],
      currentLibraryId: "lib1",
      setCurrentLibraryId: jest.fn(),
    } as any);
    useUiStore.setState({ librarySelectorOpen: true } as any);
  });

  it("lists libraries and flags the current one", async () => {
    await render(<LibrarySelector />);
    expect(screen.getByText("Libraries")).toBeTruthy();
    expect(screen.getByLabelText("Audiobooks, current library")).toBeTruthy();
    expect(screen.getByLabelText("Podcasts")).toBeTruthy();
  });

  it("selecting another library switches and closes", async () => {
    await render(<LibrarySelector />);
    await fireEvent.press(screen.getByText("Podcasts"));
    expect(useLibraryStore.getState().setCurrentLibraryId).toHaveBeenCalledWith("lib2");
    expect(useUiStore.getState().librarySelectorOpen).toBe(false);
  });

  it("re-selecting the current library only closes", async () => {
    await render(<LibrarySelector />);
    await fireEvent.press(screen.getByText("Audiobooks"));
    expect(useLibraryStore.getState().setCurrentLibraryId).not.toHaveBeenCalled();
    expect(useUiStore.getState().librarySelectorOpen).toBe(false);
  });

  it("shows the empty state without libraries", async () => {
    useLibraryStore.setState({ libraries: [] } as any);
    await render(<LibrarySelector />);
    expect(screen.getByText("No libraries available.")).toBeTruthy();
  });
});
