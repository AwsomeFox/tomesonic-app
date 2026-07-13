/**
 * ChapterEditorScreen — edits a book's chapter list as a LOCAL DRAFT (nothing
 * touches the server until Save), validates ABS chapter semantics (first
 * chapter at 0, strictly increasing starts, all within the duration) before
 * POSTing the whole array, previews Audnexus ASIN lookups behind an explicit
 * replace-confirm, and guards dirty drafts with a beforeRemove discard dialog.
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
import { AccessibilityInfo } from "react-native";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import ChapterEditorScreen, {
  parseTimestamp,
  formatTimestamp,
  validateChapterDraft,
  buildChaptersPayload,
} from "../../screens/ChapterEditorScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";

// Fresh item per test — the screen must never mutate what the API returned.
function makeItem() {
  return {
    id: "item1",
    media: {
      duration: 3600,
      metadata: { title: "My Book", asin: "B00TEST" },
      chapters: [
        { id: 0, start: 0, end: 1200, title: "Opening" },
        { id: 1, start: 1200, end: 2400, title: "Middle" },
        { id: 2, start: 2400, end: 3600, title: "End" },
      ],
    },
  };
}

const AUDNEXUS_RESULT = {
  asin: "B00TEST",
  runtimeLengthMs: 3600000,
  chapters: [
    { title: "Ch A", startOffsetMs: 0, lengthMs: 600000 },
    { title: "Ch B", startOffsetMs: 600000, lengthMs: 3000000 },
  ],
};

function mockRoutes({ item = makeItem(), audnexus = AUDNEXUS_RESULT }: any = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url.startsWith("/api/items/")) return Promise.resolve({ data: item });
    if (url === "/api/search/chapters") return Promise.resolve({ data: audnexus });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
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

async function renderScreen(params: any = { libraryItemId: "item1" }) {
  const { navigation, listeners } = makeNavigation();
  await render(<ChapterEditorScreen navigation={navigation} route={{ params }} />);
  return { navigation, listeners };
}

// Expand a chapter row via its composed accessibility label.
async function expandRow(label: RegExp | string) {
  fireEvent.press(screen.getByLabelText(label));
  await waitFor(() => expect(screen.getByLabelText("Chapter start time")).toBeTruthy());
}

// Set the expanded row's start-time field and commit it (endEditing).
async function setStartTime(text: string) {
  fireEvent.changeText(screen.getByLabelText("Chapter start time"), text);
  await waitFor(() =>
    expect(screen.getByLabelText("Chapter start time").props.value).toBe(text)
  );
  fireEvent(screen.getByLabelText("Chapter start time"), "endEditing");
}

function dialogByTitle(title: string) {
  return (showAppDialog as jest.Mock).mock.calls.map((c) => c[0]).find((d) => d?.title === title);
}

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  (api.post as jest.Mock).mockResolvedValue({ data: { success: true } });
  (showAppDialog as jest.Mock).mockClear();
  (showSnackbar as jest.Mock).mockClear();
  mockRoutes();
  // Read-only usage of the playback store: no session loaded by default.
  usePlaybackStore.setState({ currentSession: null, position: 0 } as any);
});

describe("time parsing", () => {
  it("parses HH:MM:SS.mmm, MM:SS, and bare seconds", () => {
    expect(parseTimestamp("01:02:03.5")).toBe(3723.5);
    expect(parseTimestamp("00:00:00")).toBe(0);
    expect(parseTimestamp("20:10")).toBe(1210);
    expect(parseTimestamp("90")).toBe(90);
    expect(parseTimestamp("12.345")).toBe(12.345);
    expect(parseTimestamp("1:02:03,250")).toBe(3723.25); // comma decimals tolerated
  });

  it("rejects garbage and out-of-range fields", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("abc")).toBeNull();
    expect(parseTimestamp("1:99")).toBeNull(); // seconds >= 60 with minutes present
    expect(parseTimestamp("1:75:00")).toBeNull(); // minutes >= 60 with hours present
    expect(parseTimestamp("1:2:3:4")).toBeNull();
    expect(parseTimestamp("-5")).toBeNull();
  });

  it("round-trips through formatTimestamp to millisecond precision", () => {
    for (const t of [0, 0.001, 1.5, 59.999, 60, 3599.25, 3723.5, 45296.789]) {
      expect(parseTimestamp(formatTimestamp(t))).toBe(t);
    }
    expect(formatTimestamp(3723.5)).toBe("01:02:03.500");
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(1210)).toBe("00:20:10");
  });
});

describe("draft validation + payload (pure)", () => {
  it("flags non-zero first start, non-increasing starts, and out-of-duration starts", () => {
    expect(validateChapterDraft([], 100)).toEqual([]);
    expect(validateChapterDraft([{ start: 0 }, { start: 50 }], 100)).toEqual([]);
    expect(validateChapterDraft([{ start: 5 }, { start: 50 }], 100).join(" ")).toMatch(
      /first chapter must start/i
    );
    expect(validateChapterDraft([{ start: 0 }, { start: 60 }, { start: 60 }], 100).join(" ")).toMatch(
      /strictly increasing/i
    );
    expect(validateChapterDraft([{ start: 0 }, { start: 100 }], 100).join(" ")).toMatch(
      /within the book/i
    );
  });

  it("derives each end from the next start (last ends at the duration) and re-indexes ids", () => {
    expect(
      buildChaptersPayload(
        [
          { key: 9, title: "A", start: 0 },
          { key: 3, title: "B", start: 10.5 },
        ],
        100
      )
    ).toEqual([
      { id: 0, start: 0, end: 10.5, title: "A" },
      { id: 1, start: 10.5, end: 100, title: "B" },
    ]);
  });
});

describe("ChapterEditorScreen", () => {
  it("loads the item and renders the chapter rows + header count", async () => {
    await renderScreen();

    expect(await screen.findByText("Opening")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/items/item1");
    expect(screen.getByText("Middle")).toBeTruthy();
    expect(screen.getByText("End")).toBeTruthy();
    expect(screen.getByText("3 chapters · 1h 0m")).toBeTruthy();
    expect(screen.getByText("00:20:00")).toBeTruthy();
    expect(screen.getByText("00:40:00")).toBeTruthy();
  });

  it("validation blocks save with out-of-order starts: error surfaced, no POST", async () => {
    await renderScreen();
    await screen.findByText("Opening");

    // Re-time chapter 2 PAST chapter 3 (2400s) → strictly-increasing violation.
    await expandRow(/^Chapter 2: Middle/);
    await setStartTime("00:45:00");

    // Inline banner surfaces the violation live…
    expect(await screen.findByText(/strictly increasing/)).toBeTruthy();

    // …and Save refuses to POST, explaining why.
    fireEvent.press(screen.getByLabelText("Save chapters"));
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Can't save chapters",
          message: expect.stringContaining("strictly increasing"),
        })
      )
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it("blocks save when the first chapter no longer starts at 0", async () => {
    await renderScreen();
    await screen.findByText("Opening");

    await expandRow(/^Chapter 1: Opening/);
    await setStartTime("00:00:05");

    // The inline banner reflects the committed (now invalid) draft…
    expect(await screen.findByText(/must start at 00:00:00/)).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Save chapters"));
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Can't save chapters",
          message: expect.stringContaining("must start at 00:00:00"),
        })
      )
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it("saves the exact whole-array payload (ends derived from the next start / duration)", async () => {
    await renderScreen();
    await screen.findByText("Opening");

    await expandRow(/^Chapter 2: Middle/);
    fireEvent.changeText(screen.getByLabelText("Chapter title"), "New Title");
    await waitFor(() =>
      expect(screen.getByLabelText("Chapter title").props.value).toBe("New Title")
    );

    fireEvent.press(screen.getByLabelText("Save chapters"));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/items/item1/chapters", {
        chapters: [
          { id: 0, start: 0, end: 1200, title: "Opening" },
          { id: 1, start: 1200, end: 2400, title: "New Title" },
          { id: 2, start: 2400, end: 3600, title: "End" },
        ],
      })
    );
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(expect.objectContaining({ message: "Chapters saved" }))
    );
  });

  it("surfaces a normalized error dialog when the save is rejected (403), keeping the draft", async () => {
    (api.post as jest.Mock).mockRejectedValue(
      Object.assign(new Error("rejected"), { response: { status: 403, data: "" } })
    );
    await renderScreen();
    await screen.findByText("Opening");

    await expandRow(/^Chapter 2: Middle/);
    fireEvent.changeText(screen.getByLabelText("Chapter title"), "New Title");
    await waitFor(() =>
      expect(screen.getByLabelText("Chapter title").props.value).toBe("New Title")
    );
    fireEvent.press(screen.getByLabelText("Save chapters"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't save chapters",
          message: expect.stringContaining("permission"),
        })
      )
    );
    // Draft intact — the edited title is still on screen.
    expect(screen.getByLabelText("Chapter title").props.value).toBe("New Title");
  });

  it("Audnexus lookup previews chapters and replaces the draft ONLY after confirm", async () => {
    await renderScreen();
    await screen.findByText("Opening");

    fireEvent.press(screen.getByLabelText("Find chapters by ASIN"));
    // ASIN prefilled from the item metadata.
    const asinInput = await screen.findByLabelText("ASIN");
    expect(asinInput.props.value).toBe("B00TEST");

    fireEvent.press(screen.getByLabelText("Look up chapters"));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/api/search/chapters", {
        params: { asin: "B00TEST", region: "us" },
      })
    );

    // Preview renders, but the draft is untouched.
    expect(await screen.findByText("Ch A")).toBeTruthy();
    expect(screen.getByText(/Found 2 chapters/)).toBeTruthy();
    expect(screen.getByText("Opening")).toBeTruthy();

    // Apply asks first…
    fireEvent.press(screen.getByLabelText("Replace draft"));
    await waitFor(() => expect(dialogByTitle("Replace chapters?")).toBeTruthy());
    expect(screen.getByText("Opening")).toBeTruthy(); // still not replaced

    // …and only the confirm button swaps the draft (server untouched until Save).
    const replaceBtn = dialogByTitle("Replace chapters?").buttons.find(
      (b: any) => b.text === "Replace"
    );
    // NOTE: async act — the confirm handler triggers React state updates, and
    // under React 19 a sync act() can leave the act queue stuck for the next test.
    await act(async () => replaceBtn.onPress());

    await waitFor(() => expect(screen.queryByText("Opening")).toBeNull());
    expect(screen.getByText("Ch B")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("Audnexus 200-with-error body surfaces a dialog and never builds a preview", async () => {
    mockRoutes({ audnexus: { error: "Chapters not found", stringKey: "MessageChaptersNotFound" } });
    await renderScreen();
    await screen.findByText("Opening");

    fireEvent.press(screen.getByLabelText("Find chapters by ASIN"));
    fireEvent.press(await screen.findByLabelText("Look up chapters"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Chapter lookup failed", message: "Chapters not found" })
      )
    );
    expect(screen.queryByLabelText("Replace draft")).toBeNull();
  });

  it("beforeRemove with a DIRTY draft blocks navigation until Discard is confirmed", async () => {
    const { navigation, listeners } = await renderScreen();
    await screen.findByText("Opening");

    await expandRow(/^Chapter 2: Middle/);
    fireEvent.changeText(screen.getByLabelText("Chapter title"), "Dirty");
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());

    const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
    await act(async () => listeners["beforeRemove"](event));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Discard chapter changes?" })
    );
    expect(navigation.dispatch).not.toHaveBeenCalled();

    const discard = dialogByTitle("Discard chapter changes?").buttons.find(
      (b: any) => b.text === "Discard"
    );
    await act(async () => discard.onPress());
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
  });

  it("beforeRemove with a CLEAN draft lets navigation proceed silently", async () => {
    const { listeners } = await renderScreen();
    await screen.findByText("Opening");

    const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
    await act(async () => listeners["beforeRemove"](event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(showAppDialog).not.toHaveBeenCalled();
  });

  it("offers 'Use current playback position' only when the loaded session IS this item", async () => {
    usePlaybackStore.setState({
      currentSession: { libraryItemId: "item1" },
      position: 1500.25,
    } as any);
    await renderScreen();
    await screen.findByText("Opening");

    await expandRow(/^Chapter 2: Middle/);
    fireEvent.press(screen.getByLabelText("Use current playback position"));

    await waitFor(() =>
      expect(screen.getByLabelText("Chapter start time").props.value).toBe("00:25:00.250")
    );
    expect(showSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("00:25:00.250") })
    );
  });

  it("hides the playback-position affordance when a DIFFERENT item is loaded", async () => {
    usePlaybackStore.setState({
      currentSession: { libraryItemId: "other-item" },
      position: 42,
    } as any);
    await renderScreen();
    await screen.findByText("Opening");

    await expandRow(/^Chapter 2: Middle/);
    expect(screen.queryByLabelText("Use current playback position")).toBeNull();
  });

  it("shift-all offsets every chapter except the first (which stays at 0)", async () => {
    await renderScreen();
    await screen.findByText("Opening");

    fireEvent.press(screen.getByLabelText("Shift all times"));
    fireEvent.changeText(await screen.findByLabelText("Shift amount in seconds"), "10");
    await waitFor(() =>
      expect(screen.getByLabelText("Shift amount in seconds").props.value).toBe("10")
    );
    fireEvent.press(screen.getByLabelText("Apply shift"));

    expect(await screen.findByText("00:20:10")).toBeTruthy();
    expect(screen.getByText("00:40:10")).toBeTruthy();
    expect(screen.getByLabelText(/^Chapter 1: Opening, starts at 00:00:00$/)).toBeTruthy();
  });

  it("an out-of-range shift is blocked with a dialog and changes nothing", async () => {
    await renderScreen();
    await screen.findByText("Opening");

    fireEvent.press(screen.getByLabelText("Shift all times"));
    fireEvent.changeText(await screen.findByLabelText("Shift amount in seconds"), "-1210");
    await waitFor(() =>
      expect(screen.getByLabelText("Shift amount in seconds").props.value).toBe("-1210")
    );
    fireEvent.press(screen.getByLabelText("Apply shift"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Can't shift chapters" })
      )
    );
    expect(screen.getByText("00:20:00")).toBeTruthy(); // untouched
  });

  it("adds a chapter at the end (midpoint of the remaining span) and removes it again", async () => {
    await renderScreen();
    await screen.findByText("Opening");

    fireEvent.press(screen.getByLabelText("Add chapter"));
    // Midpoint of last start (2400) → duration (3600) = 3000s.
    expect(await screen.findByText("Chapter 4")).toBeTruthy();
    expect(screen.getByLabelText("Chapter start time").props.value).toBe("00:50:00");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Remove chapter"));
    await waitFor(() => expect(screen.queryByText("Chapter 4")).toBeNull());
    // Add + remove restores the seeded draft → clean again.
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("announces the final start time once (debounced) after rapid stepper taps", async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => {});
    await renderScreen();
    await screen.findByText("Opening");
    await expandRow(/^Chapter 2: Middle/);

    // Stepper buttons are 40dp tall — the touch target is padded via hitSlop.
    expect(
      screen.getByLabelText("Increase start time by 1 second").props.hitSlop
    ).toEqual({ top: 4, bottom: 4 });

    // Two rapid taps, both inside the ~300ms debounce window: each schedules
    // an announcement, but TalkBack must hear only ONE (the final value).
    fireEvent.press(screen.getByLabelText("Increase start time by 1 second"));
    await waitFor(() =>
      expect(screen.getByLabelText("Chapter start time").props.value).toBe("00:20:01")
    );
    // Second tap lands well inside the ~300ms debounce window of the first…
    fireEvent.press(screen.getByLabelText("Increase start time by 1 second"));
    await waitFor(() =>
      expect(screen.getByLabelText("Chapter start time").props.value).toBe("00:20:02")
    );
    expect(announce).not.toHaveBeenCalled(); // debounced — nothing announced yet

    await waitFor(() => expect(announce).toHaveBeenCalled(), { timeout: 2000 });
    // Let any (buggy) per-tap announcement land before counting. Plain sleep —
    // announcing triggers no React state update, so no act() wrapper needed.
    await new Promise((r) => setTimeout(r, 400));
    // …so TalkBack hears ONE announcement, carrying the FINAL value.
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("00:20:02"));
    announce.mockRestore();
  });

  it("commits once when submit and endEditing both fire (Android): ONE snackbar for an invalid entry", async () => {
    await renderScreen();
    await screen.findByText("Opening");
    await expandRow(/^Chapter 2: Middle/);

    fireEvent.changeText(screen.getByLabelText("Chapter start time"), "not a time");
    await waitFor(() =>
      expect(screen.getByLabelText("Chapter start time").props.value).toBe("not a time")
    );
    // Android fires BOTH events, as separate dispatches, for one keyboard "done".
    fireEvent(screen.getByLabelText("Chapter start time"), "submitEditing");
    // First event commits: snackbar + field reset to the last valid value.
    await waitFor(() =>
      expect(screen.getByLabelText("Chapter start time").props.value).toBe("00:20:00")
    );
    fireEvent(screen.getByLabelText("Chapter start time"), "endEditing");
    // The deduped path performs no state update — a plain settle is enough.
    await new Promise((r) => setTimeout(r, 50));

    // The trailing endEditing is deduped: exactly ONE error snackbar…
    const invalidCalls = (showSnackbar as jest.Mock).mock.calls.filter((c) =>
      /Invalid time/.test(c[0]?.message)
    );
    expect(invalidCalls).toHaveLength(1);
    // …and the field stays on the committed value.
    expect(screen.getByLabelText("Chapter start time").props.value).toBe("00:20:00");
  });

  it("switching rows mid-edit commits the pending text instead of discarding it", async () => {
    await renderScreen();
    await screen.findByText("Opening");
    await expandRow(/^Chapter 2: Middle/);

    // Type a new start but DON'T blur — then tap another row header.
    fireEvent.changeText(screen.getByLabelText("Chapter start time"), "00:21:00");
    await waitFor(() =>
      expect(screen.getByLabelText("Chapter start time").props.value).toBe("00:21:00")
    );
    fireEvent.press(screen.getByLabelText(/^Chapter 3: End/));

    // The typed value was committed to chapter 2 before the switch…
    expect(
      await screen.findByLabelText(/^Chapter 2: Middle, starts at 00:21:00$/)
    ).toBeTruthy();
    // …and the late blur from the old input (Android ordering) is a no-op:
    // no snackbar, chapter 3's field untouched.
    fireEvent(screen.getByLabelText("Chapter start time"), "endEditing");
    await waitFor(() =>
      expect(screen.getByLabelText("Chapter start time").props.value).toBe("00:40:00")
    );
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it("shows a server error state (with retry) when the item fails to load", async () => {
    (api.get as jest.Mock).mockImplementation(() => {
      const err: any = new Error("boom");
      err.response = { status: 500 };
      return Promise.reject(err);
    });
    await renderScreen();

    expect(await screen.findByText("Failed to load the item's chapters.")).toBeTruthy();
    expect(screen.getByLabelText("Retry")).toBeTruthy();
  });

  it("shows the offline message when the load never reaches the server", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response
    await renderScreen();

    expect(await screen.findByText(/You're offline\. Reconnect to edit chapters\./)).toBeTruthy();
  });
});
