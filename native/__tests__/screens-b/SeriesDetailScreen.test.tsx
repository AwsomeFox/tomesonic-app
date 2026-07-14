/**
 * SeriesDetailScreen — hero header (name, counts, finished count), sequence
 * sorting, Continue/Play-all targeting nextUnfinished, ebook/Reader routing,
 * hideNonAudiobooksGlobal filtering, description expand, error/empty states.
 *
 * REGRESSION GUARD: fetchSeriesDetail()'s item mapping must preserve the
 * format-detection fields (mediaType, numTracks/numAudioFiles/tracks/
 * audioFiles, ebookFile/ebookFormat). A past version dropped them, which made
 * isEbookOnly() true for EVERY row — audiobooks rendered "Read" buttons
 * routed to the Reader, the Reader got ebookFormat null for real epubs, and
 * hideNonAudiobooksGlobal emptied the whole series. The routing tests below
 * pin the CORRECT behavior.
 */
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);
jest.mock("react-native-reanimated", () => {
  const RN = require("react-native");
  const chainable = () => {
    const o: any = {};
    [
      "delay", "duration", "springify", "damping", "stiffness", "mass",
      "easing", "build", "withInitialValues", "randomDelay", "reduceMotion",
      "withCallback",
    ].forEach((k) => (o[k] = () => o));
    return o;
  };
  const id = (v: any) => v;
  const easing = (t: number) => t;
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (C: any) => C,
      View: RN.View, Text: RN.Text, Image: RN.Image,
      ScrollView: RN.ScrollView, FlatList: RN.FlatList,
    },
    useSharedValue: (v: any) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (fn: any) => ({ value: typeof fn === "function" ? fn() : fn }),
    useAnimatedRef: () => ({ current: null }),
    useAnimatedScrollHandler: () => () => {},
    useAnimatedReaction: () => {},
    useReducedMotion: () => false,
    withTiming: id, withSpring: id, withDelay: (_d: any, v: any) => v,
    withRepeat: id, withSequence: id,
    cancelAnimation: () => {},
    interpolate: () => 0,
    interpolateColor: () => "rgb(0, 0, 0)",
    Extrapolation: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    Extrapolate: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    runOnJS: (fn: any) => fn, runOnUI: (fn: any) => fn,
    Easing: {
      linear: easing, ease: easing, quad: easing, cubic: easing,
      bezier: () => ({ factory: () => easing }),
      in: (f: any) => f || easing, out: (f: any) => f || easing, inOut: (f: any) => f || easing,
    },
    FadeIn: chainable(), FadeOut: chainable(), FadeInDown: chainable(),
    FadeInUp: chainable(), FadeInRight: chainable(), FadeInLeft: chainable(),
    FadeOutDown: chainable(), FadeOutUp: chainable(),
    SlideInDown: chainable(), SlideOutDown: chainable(),
    LinearTransition: chainable(),
    ReduceMotion: { System: "system", Always: "always", Never: "never" },
  };
});
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/audible", () => ({
  audibleSeriesAsinFromBook: jest.fn().mockResolvedValue(null),
  audibleFindSeriesAsin: jest.fn().mockResolvedValue(null),
  audibleSeriesBooks: jest.fn().mockResolvedValue([]),
  buildOwnedTitleMatcher: jest.fn(() => () => false),
  audibleBookDetails: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../utils/rmab", () => ({
  searchAuthors: jest.fn(),
  getAuthorBooks: jest.fn(),
  resolveRmabUrl: (p: any) => p || undefined,
  rmabAuthMode: (cfg: any) => (cfg ? (cfg.apiToken ? "apiToken" : "jwt") : null),
  readRmabConfig: jest.fn(() => null),
  writeRmabConfig: jest.fn(),
  getMe: jest.fn(),
  createRequest: jest.fn(),
  getPendingApprovalCount: jest.fn().mockResolvedValue(0),
  listMyRequests: jest.fn().mockResolvedValue([]),
  clearRmabCaches: jest.fn(),
  setRmabSessionDeadHandler: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import SeriesDetailScreen from "../../screens/SeriesDetailScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useRmabStore } from "../../store/useRmabStore";
import { useDialogStore } from "../../store/useDialogStore";
import { useSnackbarStore } from "../../store/useSnackbarStore";

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialRmab = useRmabStore.getState();

const LONG_DESC =
  "An epic multi-generational saga that sweeps across continents and decades, " +
  "following unlikely heroes, reluctant villains, and every flavor of magic " +
  "system between them, building toward a finale nobody saw coming at all. " +
  "It keeps going and going well past the fold.";

// Deliberately out of sequence order (2, 1, 3) to exercise the sort. Every
// item carries audio info in the RAW payload; the screen's mapping drops it.
const RAW_ITEMS = [
  {
    id: "b2",
    mediaType: "book",
    media: {
      metadata: { title: "Beta", authorName: "Author X", series: [{ id: "ser1", sequence: "2" }] },
      duration: 3600,
      numTracks: 4,
    },
    userMediaProgress: null,
  },
  {
    id: "b1",
    mediaType: "book",
    media: {
      metadata: { title: "Alpha", authorName: "Author X", series: [{ id: "ser1", sequence: "1" }] },
      duration: 3600,
      numTracks: 5,
    },
    userMediaProgress: { isFinished: true },
  },
  {
    id: "b3",
    mediaType: "book",
    media: {
      metadata: { title: "Gamma", authorName: "Author X", series: { id: "ser1", sequence: "3" } },
      duration: 3600,
      ebookFile: { ebookFormat: "epub" },
    },
    userMediaProgress: { progress: 0.5, currentTime: 1800, duration: 3600 },
  },
];

function mockSeriesApi({
  meta = { name: "Wax & Wayne", description: LONG_DESC },
  items = RAW_ITEMS,
  metaFails = false,
  itemsFail = false,
}: any = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url.startsWith("/api/series/")) {
      return metaFails
        ? Promise.reject(new Error("meta down"))
        : Promise.resolve({ data: meta });
    }
    if (url.includes("/items?filter=series.")) {
      return itemsFail
        ? Promise.reject(new Error("items down"))
        : Promise.resolve({ data: { results: items } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

let startPlayback: jest.Mock;

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderSeries(params: any = { seriesId: "ser1", seriesName: "Wax & Wayne" }) {
  const navigation = makeNavigation();
  await render(<SeriesDetailScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useLibraryStore.setState(initialLibrary, true);
  usePlaybackStore.setState(initialPlayback, true);
  useRmabStore.setState(initialRmab, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  startPlayback = jest.fn().mockResolvedValue(true);
  usePlaybackStore.setState({ startPlayback, currentSession: null } as any);
  useDialogStore.setState({ current: null } as any);
  useSnackbarStore.setState({ current: null } as any);
  mockSeriesApi();
});

describe("SeriesDetailScreen", () => {
  it("fetches by base64-encoded series filter and renders the hero header", async () => {
    await renderSeries();

    expect(await screen.findAllByText("Wax & Wayne")).toHaveLength(2); // bar + hero
    // 3 books x 1h -> "3 books · 3 hr 0 min", 1 finished.
    expect(screen.getByText(/3 books\s+·\s+3 hr 0 min/)).toBeTruthy();
    expect(screen.getByText("1 of 3 finished")).toBeTruthy();
    // "ser1" -> base64 "c2VyMQ==" -> URI-encoded.
    expect(api.get).toHaveBeenCalledWith(
      "/api/libraries/lib1/items?filter=series.c2VyMQ%3D%3D&include=progress"
    );
  });

  it("sorts rows by sequence and prefixes titles with #N", async () => {
    await renderSeries();
    await screen.findByText("#1 Alpha");

    const rows = screen.getAllByText(/^#\d /);
    expect(rows.map((r) => r.props.children)).toEqual(["#1 Alpha", "#2 Beta", "#3 Gamma"]);
    // Per-row duration lines render too.
    expect(screen.getAllByText("1 hr 0 min").length).toBe(3);
  });

  it("labels the header button Continue when any progress exists and targets nextUnfinished", async () => {
    const navigation = await renderSeries();
    await screen.findByText("#1 Alpha");

    const continueBtn = screen.getByText("Continue");
    await fireEvent.press(continueBtn);

    // nextUnfinished skips finished #1 Alpha and lands on #2 Beta — a real
    // audiobook (numTracks: 4), so it PLAYS instead of opening the Reader.
    expect(startPlayback).toHaveBeenCalledWith("b2");
    expect(navigation.navigate).not.toHaveBeenCalledWith(
      "Reader",
      expect.objectContaining({ itemId: "b2" })
    );
  });

  it("exposes an accessible label + button role on the hero action", async () => {
    await renderSeries();
    await screen.findByText("#1 Alpha");

    // anyProgress is true (Alpha finished, Gamma half) -> "Continue".
    const hero = screen.getByLabelText("Continue");
    expect(hero.props.accessibilityRole).toBe("button");
    expect(hero.props.accessibilityState).toMatchObject({ disabled: false, busy: false });
  });

  it("labels the header button Play all when nothing has progress", async () => {
    mockSeriesApi({
      items: RAW_ITEMS.map((i) => ({ ...i, userMediaProgress: null })),
    });
    await renderSeries();
    await screen.findByText("#1 Alpha");

    expect(screen.getByText("Play all")).toBeTruthy();
    expect(screen.queryByText("Continue")).toBeNull();
  });

  it("routes ebook-only rows to the Reader (with format) and audiobook rows to playback", async () => {
    const navigation = await renderSeries();
    await screen.findByText("#3 Gamma");

    // The genuinely ebook-only row routes to the Reader with its real format.
    await fireEvent.press(screen.getByLabelText("Read Gamma"));
    expect(navigation.navigate).toHaveBeenCalledWith("Reader", {
      itemId: "b3",
      ebookFormat: "epub",
      title: "Gamma",
    });

    // Audiobook rows keep Play buttons that start playback.
    expect(screen.getByLabelText("Play Alpha")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Play Beta"));
    expect(startPlayback).toHaveBeenCalledWith("b2");
  });

  it("exposes play as a row accessibility action so TalkBack can reach it", async () => {
    await renderSeries();
    await screen.findByText("#2 Beta");

    // The accessible row's own label composes title + author + status; the
    // nested Play button collapses under it, so the row carries a "play"
    // accessibility action as the assistive-tech path to the primary action.
    const betaRow = screen.getByLabelText(/^#2 Beta/);
    expect(betaRow.props.accessibilityActions).toEqual([{ name: "play", label: "Play" }]);

    fireEvent(betaRow, "accessibilityAction", { nativeEvent: { actionName: "play" } });
    // Beta is a real audiobook → the row action plays it.
    expect(startPlayback).toHaveBeenCalledWith("b2");
  });

  it("row play action routes ebook-only rows to the Reader (labeled Read)", async () => {
    const navigation = await renderSeries();
    await screen.findByText("#3 Gamma");

    const gammaRow = screen.getByLabelText(/^#3 Gamma/);
    expect(gammaRow.props.accessibilityActions).toEqual([{ name: "play", label: "Read" }]);

    fireEvent(gammaRow, "accessibilityAction", { nativeEvent: { actionName: "play" } });
    expect(navigation.navigate).toHaveBeenCalledWith("Reader", {
      itemId: "b3",
      ebookFormat: "epub",
      title: "Gamma",
    });
  });

  it("row tap opens the item detail", async () => {
    const navigation = await renderSeries();
    await screen.findByText("#1 Alpha");

    await fireEvent.press(screen.getByText("#1 Alpha"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "b1" });
  });

  it("hideNonAudiobooksGlobal filters only the ebook-only rows", async () => {
    useUserStore.setState({
      settings: { ...useUserStore.getState().settings, hideNonAudiobooksGlobal: true },
    } as any);
    await renderSeries();

    // Alpha and Beta are audiobooks — they survive; ebook-only Gamma is hidden.
    expect(await screen.findByText("#1 Alpha")).toBeTruthy();
    expect(screen.getByText("#2 Beta")).toBeTruthy();
    expect(screen.queryByText("#3 Gamma")).toBeNull();
  });

  it("long descriptions collapse to Show more and expand on tap", async () => {
    await renderSeries();
    await screen.findByText("#1 Alpha");

    expect(screen.getByText(LONG_DESC)).toBeTruthy();
    const showMore = screen.getByText("Show more");
    await fireEvent.press(showMore);
    expect(screen.getByText("Show less")).toBeTruthy();

    await fireEvent.press(screen.getByText("Show less"));
    expect(screen.getByText("Show more")).toBeTruthy();
  });

  it("falls back to the route's series name when the meta fetch fails", async () => {
    mockSeriesApi({ metaFails: true });
    await renderSeries({ seriesId: "ser1", seriesName: "Fallback Name" });

    expect(await screen.findAllByText("Fallback Name")).toHaveLength(2);
    // No description -> no expand affordance.
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("shows the error state when the items fetch fails, then retries", async () => {
    mockSeriesApi({ itemsFail: true });
    await renderSeries();

    expect(await screen.findByText("Failed to load series.")).toBeTruthy();

    mockSeriesApi();
    await fireEvent.press(screen.getByLabelText("Retry"));

    expect(await screen.findByText("#1 Alpha")).toBeTruthy();
  });

  it("shows the empty state when the series has no books", async () => {
    mockSeriesApi({ items: [] });
    await renderSeries();

    expect(await screen.findByText("No books in this series")).toBeTruthy();
  });
});

describe("SeriesDetailScreen — batch progress (mark finished / reset)", () => {
  beforeEach(() => {
    // The post-batch progress refresh must not hit the real /api/me loader.
    useUserStore.setState({
      loadMediaProgress: jest.fn().mockResolvedValue(undefined),
    } as any);
  });

  // RAW_ITEMS: b1 finished, b2 no progress, b3 half progress. Sorted order is
  // #1 Alpha (b1), #2 Beta (b2), #3 Gamma (b3).

  it("is available to any logged-in user (not admin-gated)", async () => {
    // Default user is null (non-admin): personal progress is never admin-gated.
    await renderSeries();
    await screen.findByText("#1 Alpha");

    expect(screen.getByLabelText("Mark series as finished")).toBeTruthy();
    expect(screen.getByLabelText("Reset series progress")).toBeTruthy();
  });

  describe("mark series as finished", () => {
    it("confirms with the unfinished count, then PATCHes a BARE-ARRAY body of finish payloads", async () => {
      (api.patch as jest.Mock).mockResolvedValue({ data: {} });
      await renderSeries();
      await screen.findByText("#1 Alpha");

      await fireEvent.press(screen.getByLabelText("Mark series as finished"));

      // Confirm first — nothing sent yet. b1 is already finished, so the count
      // covers only the 2 unfinished books (b2, b3).
      const dialog = useDialogStore.getState().current!;
      expect(dialog.title).toBe("Mark series as finished?");
      expect(dialog.message).toContain("2 books");
      expect(api.patch).not.toHaveBeenCalled();

      const confirm = dialog.buttons!.find((b) => b.text === "Mark finished")!;
      await act(async () => {
        await confirm.onPress!();
      });

      // The batch body is the bare ARRAY of finish payloads — NOT wrapped.
      expect(api.patch).toHaveBeenCalledWith("/api/me/progress/batch/update", [
        { libraryItemId: "b2", isFinished: true },
        { libraryItemId: "b3", isFinished: true },
      ]);
      const [, body] = (api.patch as jest.Mock).mock.calls[0];
      expect(Array.isArray(body)).toBe(true);

      expect(useSnackbarStore.getState().current?.message).toBe("2 books marked finished");
      // The progress map refresh fires (drives the header stats + row badges).
      expect(useUserStore.getState().loadMediaProgress).toHaveBeenCalled();
    });

    it("double-tapping the finish confirm only sends one batch (ref mutex)", async () => {
      (api.patch as jest.Mock).mockResolvedValue({ data: {} });
      await renderSeries();
      await screen.findByText("#1 Alpha");

      await fireEvent.press(screen.getByLabelText("Mark series as finished"));
      const confirm = useDialogStore.getState().current!.buttons!.find(
        (b) => b.text === "Mark finished"
      )!;
      // Two rapid taps before the in-flight state re-renders → one PATCH.
      await act(async () => {
        confirm.onPress!();
        confirm.onPress!();
      });
      expect(api.patch).toHaveBeenCalledTimes(1);
    });

    it("recomputes targets from the live progress map at confirm time (not dialog-open time)", async () => {
      (api.patch as jest.Mock).mockResolvedValue({ data: {} });
      await renderSeries();
      await screen.findByText("#1 Alpha");

      // Open the dialog with b2 + b3 unfinished (b1 already finished).
      await fireEvent.press(screen.getByLabelText("Mark series as finished"));
      // While the dialog is open, b2 becomes finished (e.g. a background sync).
      await act(async () => {
        useUserStore.setState({
          mediaProgress: { b2: { libraryItemId: "b2", isFinished: true } },
        } as any);
      });
      const confirm = useDialogStore.getState().current!.buttons!.find(
        (b) => b.text === "Mark finished"
      )!;
      await act(async () => {
        await confirm.onPress!();
      });

      // Only b3 is sent, and the snackbar count reflects the recomputed target.
      expect(api.patch).toHaveBeenCalledWith("/api/me/progress/batch/update", [
        { libraryItemId: "b3", isFinished: true },
      ]);
      expect(useSnackbarStore.getState().current?.message).toBe("1 book marked finished");
    });

    it("uses the progress MAP (not just the payload snapshot) for the finished check", async () => {
      (api.patch as jest.Mock).mockResolvedValue({ data: {} });
      // b2 finished in the authoritative map since the payload was taken.
      useUserStore.setState({
        mediaProgress: { b2: { libraryItemId: "b2", isFinished: true } },
      } as any);
      await renderSeries();
      await screen.findByText("#1 Alpha");

      await fireEvent.press(screen.getByLabelText("Mark series as finished"));
      const dialog = useDialogStore.getState().current!;
      // b1 (payload finished) + b2 (map finished) excluded -> only b3 left.
      expect(dialog.message).toContain("1 book");
      const confirm = dialog.buttons!.find((b) => b.text === "Mark finished")!;
      await act(async () => {
        await confirm.onPress!();
      });

      expect(api.patch).toHaveBeenCalledWith("/api/me/progress/batch/update", [
        { libraryItemId: "b3", isFinished: true },
      ]);
    });

    it("shows an already-finished snackbar (no dialog, no request) when every book is finished", async () => {
      useUserStore.setState({
        mediaProgress: {
          b2: { libraryItemId: "b2", isFinished: true },
          b3: { libraryItemId: "b3", isFinished: true },
        },
      } as any);
      await renderSeries();
      await screen.findByText("#1 Alpha");

      await fireEvent.press(screen.getByLabelText("Mark series as finished"));

      expect(useDialogStore.getState().current).toBeNull();
      expect(api.patch).not.toHaveBeenCalled();
      expect(useSnackbarStore.getState().current?.message).toMatch(/already finished/i);
    });

    it("surfaces a dialog and no success snackbar when the finish PATCH fails", async () => {
      (api.patch as jest.Mock).mockRejectedValue({ response: { status: 500 } });
      await renderSeries();
      await screen.findByText("#1 Alpha");

      await fireEvent.press(screen.getByLabelText("Mark series as finished"));
      const confirm = useDialogStore
        .getState()
        .current!.buttons!.find((b) => b.text === "Mark finished")!;
      await act(async () => {
        await confirm.onPress!();
      });

      expect(useDialogStore.getState().current?.title).toBe("Couldn't mark as finished");
      expect(useSnackbarStore.getState().current).toBeNull();
    });
  });

  describe("reset series progress", () => {
    it("confirms (destructive) with the has-progress count, then PATCHes a BARE-ARRAY body of reset payloads", async () => {
      (api.patch as jest.Mock).mockResolvedValue({ data: {} });
      await renderSeries();
      await screen.findByText("#1 Alpha");

      await fireEvent.press(screen.getByLabelText("Reset series progress"));

      // Confirm first — nothing sent yet. b1 (finished) + b3 (half) have
      // progress; b2 has none -> count is 2.
      const dialog = useDialogStore.getState().current!;
      expect(dialog.title).toBe("Reset series progress?");
      expect(dialog.message).toContain("2 books");
      expect(api.patch).not.toHaveBeenCalled();

      const confirm = dialog.buttons!.find((b) => b.text === "Reset")!;
      // The reset action is styled destructive (data loss).
      expect(confirm.style).toBe("destructive");

      await act(async () => {
        await confirm.onPress!();
      });

      // Reset payloads zero out currentTime + progress + ebookProgress and
      // clear isFinished — aligned with the per-item reset in ItemDetailScreen.
      expect(api.patch).toHaveBeenCalledWith("/api/me/progress/batch/update", [
        { libraryItemId: "b1", isFinished: false, currentTime: 0, progress: 0, ebookProgress: 0 },
        { libraryItemId: "b3", isFinished: false, currentTime: 0, progress: 0, ebookProgress: 0 },
      ]);
      const [, body] = (api.patch as jest.Mock).mock.calls[0];
      expect(Array.isArray(body)).toBe(true);

      expect(useSnackbarStore.getState().current?.message).toBe("Progress reset on 2 books");
      expect(useUserStore.getState().loadMediaProgress).toHaveBeenCalled();
    });

    it("shows a nothing-to-reset snackbar (no dialog, no request) when no book has progress", async () => {
      mockSeriesApi({
        items: RAW_ITEMS.map((i) => ({ ...i, userMediaProgress: null })),
      });
      await renderSeries();
      await screen.findByText("#1 Alpha");

      await fireEvent.press(screen.getByLabelText("Reset series progress"));

      expect(useDialogStore.getState().current).toBeNull();
      expect(api.patch).not.toHaveBeenCalled();
      expect(useSnackbarStore.getState().current?.message).toMatch(/no progress to reset/i);
    });

    it("surfaces a dialog and no success snackbar when the reset PATCH fails", async () => {
      (api.patch as jest.Mock).mockRejectedValue({ response: { status: 500 } });
      await renderSeries();
      await screen.findByText("#1 Alpha");

      await fireEvent.press(screen.getByLabelText("Reset series progress"));
      const confirm = useDialogStore
        .getState()
        .current!.buttons!.find((b) => b.text === "Reset")!;
      await act(async () => {
        await confirm.onPress!();
      });

      expect(useDialogStore.getState().current?.title).toBe("Couldn't reset progress");
      expect(useSnackbarStore.getState().current).toBeNull();
    });
  });
});

describe("SeriesDetailScreen — re-release dedup (same sequence collapses)", () => {
  // Each sequence appears twice (re-releases: same sequence, different id).
  const mk = (over: any) => ({
    mediaType: "book",
    userMediaProgress: null,
    ...over,
    media: {
      metadata: { authorName: "Author X", series: [{ id: "ser1", sequence: over.seq }], ...over.meta },
      duration: 3600,
      numTracks: 3,
      ...over.media,
    },
  });
  const DUP_ITEMS = [
    // seq 1: the copy WITH progress wins over the one without.
    mk({ id: "s1a", seq: "1", meta: { title: "Old One" }, addedAt: 100 }),
    mk({ id: "s1b", seq: "1", meta: { title: "New One" }, userMediaProgress: { progress: 0.5 }, addedAt: 50 }),
    // seq 2: neither has progress → the downloaded copy wins.
    mk({ id: "s2a", seq: "2", meta: { title: "Plain Two" }, addedAt: 10 }),
    mk({ id: "s2b", seq: "2", meta: { title: "Downloaded Two" }, isLocal: true, addedAt: 5 }),
    // seq 3: neither progress nor download → the newest (addedAt) wins.
    mk({ id: "s3a", seq: "3", meta: { title: "Older Three" }, addedAt: 1 }),
    mk({ id: "s3b", seq: "3", meta: { title: "Newer Three" }, addedAt: 999 }),
  ];

  it("collapses each sequence to the progress/downloaded/newest representative and recomputes header stats", async () => {
    mockSeriesApi({ items: DUP_ITEMS });
    const navigation = await renderSeries();
    await screen.findByText("#1 New One");

    // One row per sequence — the losing re-releases are gone.
    const rows = screen.getAllByText(/^#\d /);
    expect(rows.map((r) => r.props.children)).toEqual(["#1 New One", "#2 Downloaded Two", "#3 Newer Three"]);
    expect(screen.queryByText("#1 Old One")).toBeNull();
    expect(screen.queryByText("#2 Plain Two")).toBeNull();
    expect(screen.queryByText("#3 Older Three")).toBeNull();

    // Header stats come from the DEDUPED list (3 books · 3h), not the raw 6.
    expect(screen.getByText(/3 books\s+·\s+3 hr 0 min/)).toBeTruthy();

    // Continue targets the deduped nextUnfinished — the progress-bearing s1b.
    await fireEvent.press(screen.getByText("Continue"));
    expect(startPlayback).toHaveBeenCalledWith("s1b");
  });

  it("never collapses blank/whitespace sequences — each stays its own entry", async () => {
    const BLANK_ITEMS = [
      mk({ id: "n1", seq: "", meta: { title: "Blank A" }, addedAt: 1 }),
      mk({ id: "n2", seq: "", meta: { title: "Blank B" }, addedAt: 2 }),
    ];
    mockSeriesApi({ items: BLANK_ITEMS });
    await renderSeries();

    // Both survive despite sharing an (empty) sequence.
    expect(await screen.findByText("Blank A")).toBeTruthy();
    expect(screen.getByText("Blank B")).toBeTruthy();
    expect(screen.getByText(/2 books/)).toBeTruthy();
  });

  it("never collapses whitespace-only sequences and the header count reflects it", async () => {
    // Whitespace sequences must trim to empty (→ un-collapsed). Without the
    // .trim(), "  " would key together and wrongly collapse both into one.
    const WS_ITEMS = [
      mk({ id: "w1", seq: "  ", meta: { title: "Space A" }, addedAt: 1 }),
      mk({ id: "w2", seq: "\t", meta: { title: "Space B" }, addedAt: 2 }),
    ];
    mockSeriesApi({ items: WS_ITEMS });
    await renderSeries();

    // Both entries stay distinct despite whitespace-only sequences.
    expect(await screen.findByText(/Space A/)).toBeTruthy();
    expect(screen.getByText(/Space B/)).toBeTruthy();
    // Header bookCount reflects the (un-collapsed) deduped list of 2.
    expect(screen.getByText(/2 books/)).toBeTruthy();
  });
});

describe("SeriesDetailScreen — missing-books section on empty series", () => {
  const { audibleFindSeriesAsin, audibleSeriesBooks } = require("../../utils/audible");

  it("offers the discovery/Request affordance even when nothing is owned", async () => {
    mockSeriesApi({ items: [] });
    useRmabStore.setState({ configured: true, authMode: "jwt" } as any);
    (audibleFindSeriesAsin as jest.Mock).mockResolvedValue("SER_ASIN");
    (audibleSeriesBooks as jest.Mock).mockResolvedValue([
      { asin: "M1", title: "Missing Volume", author: "Author X" },
    ]);

    await renderSeries();

    expect(await screen.findByText("No books in this series")).toBeTruthy();
    expect(await screen.findByText("Missing Volume")).toBeTruthy();
    expect(screen.getByLabelText("Request Missing Volume")).toBeTruthy();
  });
});

describe("SeriesDetailScreen — Open RSS feed (admin-only)", () => {
  const setAdmin = () =>
    useUserStore.setState({
      user: { id: "u1", username: "boss", type: "admin", permissions: {} },
      serverConnectionConfig: { address: "https://abs.example.com", token: "tok", version: "2.35.1" },
    } as any);

  it("admin: the header action opens the shared feed flow (address seeded from the series name)", async () => {
    setAdmin();
    await renderSeries();
    await screen.findByText("#1 Alpha");

    await fireEvent.press(screen.getByLabelText("Open RSS feed"));
    const input = await screen.findByLabelText("RSS feed address");
    expect(input.props.value).toBe("wax-wayne");
  });

  it("non-admin: no Open RSS feed action is shown", async () => {
    // Default restored user is a plain (non-admin) session.
    await renderSeries();
    await screen.findByText("#1 Alpha");
    expect(screen.queryByLabelText("Open RSS feed")).toBeNull();
  });
});
