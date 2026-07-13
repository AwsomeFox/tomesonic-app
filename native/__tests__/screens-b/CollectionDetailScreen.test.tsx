/**
 * CollectionDetailScreen — rows render from the collection payload; play
 * buttons are hasAudio-based (minified numTracks payloads included) and hidden
 * for ebook-only/missing items; header Play all targets the first unfinished
 * playable book; hideNonAudiobooksGlobal filters ebook-only rows.
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

import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import CollectionDetailScreen from "../../screens/CollectionDetailScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useDialogStore } from "../../store/useDialogStore";
import { useSnackbarStore } from "../../store/useSnackbarStore";

// Pull the destructive "Delete" button out of the confirm dialog the trash
// icon opens (no AppDialog host is mounted in the unit render) and invoke it.
async function confirmDelete() {
  const del = useDialogStore.getState().current!.buttons.find((b) => b.style === "destructive")!;
  await act(async () => {
    await del.onPress!();
  });
}

const initialUser = useUserStore.getState();
const initialPlayback = usePlaybackStore.getState();

const COLLECTION = {
  id: "col1",
  name: "Space Operas",
  description: "The best of the void.",
  books: [
    {
      // Minified payload: audio signalled only via numTracks.
      id: "b1",
      media: { metadata: { title: "Finished Book", authorName: "Author One" }, duration: 3600, numTracks: 2 },
      userMediaProgress: { isFinished: true },
    },
    {
      // Full payload: audio via tracks array.
      id: "b2",
      media: { metadata: { title: "Unfinished Book", authorName: "Author Two" }, duration: 1800, tracks: [{}, {}] },
      userMediaProgress: { progress: 0.2 },
    },
    {
      // Ebook-only: no audio at all.
      id: "b3",
      media: { metadata: { title: "Ebook Only" }, ebookFile: { ebookFormat: "epub" } },
    },
    {
      // Missing item: has audio but flagged missing.
      id: "b4",
      isMissing: true,
      media: { metadata: { title: "Missing Book" }, numTracks: 1, duration: 60 },
    },
  ],
};

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

async function renderCollection(params: any = { collectionId: "col1" }) {
  const navigation = makeNavigation();
  await render(<CollectionDetailScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  startPlayback = jest.fn().mockResolvedValue(true);
  usePlaybackStore.setState({ startPlayback, currentSession: null } as any);
  (api.get as jest.Mock).mockResolvedValue({ data: COLLECTION });
  (api.delete as jest.Mock).mockReset();
  useDialogStore.setState({ current: null });
  useSnackbarStore.setState({ current: null } as any);
});

describe("CollectionDetailScreen", () => {
  it("renders the header, description, item count and rows", async () => {
    await renderCollection();

    expect(await screen.findAllByText("Space Operas")).toHaveLength(2); // bar + hero
    expect(screen.getByText("The best of the void.")).toBeTruthy();
    // 4 items, total duration 3600+1800+0+60 = 5460s -> "1 hr 31 min"
    expect(screen.getByText(/4 items\s+·\s+1 hr 31 min/)).toBeTruthy();
    expect(screen.getByText("Finished Book")).toBeTruthy();
    expect(screen.getByText("Unfinished Book")).toBeTruthy();
    expect(screen.getByText("Ebook Only")).toBeTruthy();
    expect(screen.getByText("Missing Book")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/collections/col1");
  });

  it("shows row play buttons only for non-missing items with audio (incl. minified numTracks)", async () => {
    await renderCollection();
    await screen.findByText("Finished Book");

    expect(screen.getByLabelText("Play Finished Book")).toBeTruthy();
    expect(screen.getByLabelText("Play Unfinished Book")).toBeTruthy();
    // Ebook-only and missing rows get no play affordance.
    expect(screen.queryByLabelText("Play Ebook Only")).toBeNull();
    expect(screen.queryByLabelText("Play Missing Book")).toBeNull();
  });

  it("header Play all starts the first unfinished playable book", async () => {
    await renderCollection();
    await screen.findByText("Finished Book");

    await fireEvent.press(screen.getByText("Play all"));
    // b1 is finished, so playback starts at b2.
    expect(startPlayback).toHaveBeenCalledWith("b2");
  });

  it("row play button starts that specific book", async () => {
    await renderCollection();
    await screen.findByText("Finished Book");

    await fireEvent.press(screen.getByLabelText("Play Finished Book"));
    expect(startPlayback).toHaveBeenCalledWith("b1");
  });

  it("row tap opens the item detail", async () => {
    const navigation = await renderCollection();
    await screen.findByText("Finished Book");

    await fireEvent.press(screen.getByText("Ebook Only"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "b3" });
  });

  it("hideNonAudiobooksGlobal drops ebook-only rows", async () => {
    useUserStore.setState({
      settings: { ...useUserStore.getState().settings, hideNonAudiobooksGlobal: true },
    } as any);
    await renderCollection();
    await screen.findByText("Finished Book");

    expect(screen.queryByText("Ebook Only")).toBeNull();
    expect(screen.getByText(/3 items/)).toBeTruthy();
    // Audio rows survive the filter.
    expect(screen.getByText("Unfinished Book")).toBeTruthy();
    expect(screen.getByText("Missing Book")).toBeTruthy();
  });

  it("hides the header play button when nothing is playable", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: {
        id: "col1",
        name: "Ebooks Only",
        books: [{ id: "e1", media: { metadata: { title: "Only Ebook" }, ebookFile: {} } }],
      },
    });
    await renderCollection();
    await screen.findByText("Only Ebook");

    expect(screen.queryByText("Play all")).toBeNull();
  });

  it("renders the empty state for an empty collection", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { id: "col1", name: "Empty", books: [] },
    });
    await renderCollection();

    expect(await screen.findByText("No items yet")).toBeTruthy();
    expect(screen.getByText("Empty Collection")).toBeTruthy(); // collage placeholder
  });

  it("empty state is message-only (no dead-end Add books CTA)", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { id: "col1", name: "Empty", books: [] },
    });
    const navigation = await renderCollection();

    // Matches PlaylistDetail: guide the user to a book's details screen rather
    // than routing to a headerless Library that can't actually add anything.
    expect(
      await screen.findByText("Add books to this collection from a book's details screen.")
    ).toBeTruthy();
    // No "Add books" button, and nothing navigates to Library.
    expect(screen.queryByLabelText("Add books")).toBeNull();
    expect(navigation.navigate).not.toHaveBeenCalledWith("Library");
  });

  it("does not show any Add books CTA once the collection has items", async () => {
    await renderCollection();
    await screen.findByText("Finished Book");

    expect(screen.queryByLabelText("Add books")).toBeNull();
  });

  it("errors without a collection id and offers no retry", async () => {
    await renderCollection({});

    expect(await screen.findByText("No collection ID provided.")).toBeTruthy();
    expect(screen.queryByLabelText("Retry")).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows the fetch error state and retries successfully", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });
    await renderCollection();

    expect(await screen.findByText("Failed to load collection.")).toBeTruthy();

    (api.get as jest.Mock).mockResolvedValue({ data: COLLECTION });
    await fireEvent.press(screen.getByLabelText("Retry"));

    expect(await screen.findByText("Finished Book")).toBeTruthy();
  });

  describe("create playlist from collection", () => {
    it("POSTs the playlists-from-collection route and shows a success snackbar with a View action", async () => {
      (api.post as jest.Mock).mockResolvedValue({ data: { id: "pl1" } });
      const navigation = await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Create playlist from collection"));

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledWith("/api/playlists/collection/col1");
        expect(useSnackbarStore.getState().current?.message).toBe(
          'Playlist created from "Space Operas"'
        );
      });
      // Success is transient feedback, never a blocking dialog.
      expect(useDialogStore.getState().current).toBeNull();

      // The snackbar's "View" action jumps straight to the created playlist's
      // detail screen (the id comes from the POST response).
      const action = useSnackbarStore.getState().current?.action;
      expect(action?.label).toBe("View");
      await act(async () => {
        action!.onPress();
      });
      expect(navigation.navigate).toHaveBeenCalledWith("PlaylistDetail", { playlistId: "pl1" });
    });

    it("surfaces a dialog (not a snackbar) when the playlist POST fails", async () => {
      (api.post as jest.Mock).mockRejectedValue({ response: { status: 500 } });
      await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Create playlist from collection"));

      await waitFor(() => {
        expect(useDialogStore.getState().current?.title).toBe("Couldn't create playlist");
      });
      expect(useSnackbarStore.getState().current).toBeNull();
    });
  });

  describe("batch mark-finished", () => {
    beforeEach(() => {
      // The post-batch progress refresh must not hit the real /api/me loader.
      useUserStore.setState({
        loadMediaProgress: jest.fn().mockResolvedValue(undefined),
      } as any);
    });

    it("confirms with the unfinished count, then PATCHes a BARE-ARRAY body", async () => {
      (api.patch as jest.Mock).mockResolvedValue({ data: {} });
      await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Mark all as finished"));

      // Confirm first — nothing sent yet. b1 is already finished, so the
      // count covers only the 3 unfinished books.
      const dialog = useDialogStore.getState().current!;
      expect(dialog.title).toBe("Mark all as finished?");
      expect(dialog.message).toContain("3 books");
      expect(api.patch).not.toHaveBeenCalled();

      const confirm = dialog.buttons.find((b) => b.text === "Mark finished")!;
      await act(async () => {
        await confirm.onPress!();
      });

      // The batch body is the bare ARRAY of progress payloads (verified server
      // contract) — NOT wrapped in an object.
      expect(api.patch).toHaveBeenCalledWith("/api/me/progress/batch/update", [
        { libraryItemId: "b2", isFinished: true },
        { libraryItemId: "b3", isFinished: true },
        { libraryItemId: "b4", isFinished: true },
      ]);
      const [, body] = (api.patch as jest.Mock).mock.calls[0];
      expect(Array.isArray(body)).toBe(true);

      expect(useSnackbarStore.getState().current?.message).toBe("3 books marked finished");
      // The progress map refresh + silent collection revalidation both fire.
      expect(useUserStore.getState().loadMediaProgress).toHaveBeenCalled();
      await waitFor(() => {
        expect(
          (api.get as jest.Mock).mock.calls.filter((c) => c[0] === "/api/collections/col1").length
        ).toBeGreaterThanOrEqual(2);
      });
    });

    it("excludes books the progress MAP marks finished (not just the payload snapshot)", async () => {
      (api.patch as jest.Mock).mockResolvedValue({ data: {} });
      // The global map is authoritative: b2 finished there since the payload
      // snapshot was taken.
      useUserStore.setState({
        mediaProgress: { b2: { libraryItemId: "b2", isFinished: true } },
      } as any);
      await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Mark all as finished"));
      const dialog = useDialogStore.getState().current!;
      expect(dialog.message).toContain("2 books");
      const confirm = dialog.buttons.find((b) => b.text === "Mark finished")!;
      await act(async () => {
        await confirm.onPress!();
      });

      expect(api.patch).toHaveBeenCalledWith("/api/me/progress/batch/update", [
        { libraryItemId: "b3", isFinished: true },
        { libraryItemId: "b4", isFinished: true },
      ]);
    });

    it("shows an already-finished snackbar (no dialog, no request) when nothing is unfinished", async () => {
      useUserStore.setState({
        mediaProgress: {
          b2: { libraryItemId: "b2", isFinished: true },
          b3: { libraryItemId: "b3", isFinished: true },
          b4: { libraryItemId: "b4", isFinished: true },
        },
      } as any);
      await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Mark all as finished"));

      expect(useDialogStore.getState().current).toBeNull();
      expect(api.patch).not.toHaveBeenCalled();
      expect(useSnackbarStore.getState().current?.message).toMatch(/already finished/i);
    });

    it("surfaces a dialog and no success snackbar when the batch PATCH fails", async () => {
      (api.patch as jest.Mock).mockRejectedValue({ response: { status: 500 } });
      await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Mark all as finished"));
      const confirm = useDialogStore.getState().current!.buttons.find(
        (b) => b.text === "Mark finished"
      )!;
      await act(async () => {
        await confirm.onPress!();
      });

      expect(useDialogStore.getState().current?.title).toBe("Couldn't mark as finished");
      expect(useSnackbarStore.getState().current).toBeNull();
    });
  });

  describe("delete (admin-gated)", () => {
    it("hides the delete control for a non-admin user", async () => {
      // Default user is null (non-admin): deleting is an admin-only endpoint.
      await renderCollection();
      await screen.findByText("Finished Book");

      expect(screen.queryByLabelText("Delete collection")).toBeNull();
    });

    it("shows the delete control for an admin and deletes on confirm", async () => {
      useUserStore.setState({ user: { type: "admin" } } as any);
      (api.delete as jest.Mock).mockResolvedValue({ data: {} });
      const navigation = await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Delete collection"));
      await confirmDelete();

      expect(api.delete).toHaveBeenCalledWith("/api/collections/col1");
      expect(navigation.goBack).toHaveBeenCalled();
    });

    it("surfaces a permissions message (not offline) on a 403", async () => {
      useUserStore.setState({ user: { type: "admin" } } as any);
      (api.delete as jest.Mock).mockRejectedValue({ response: { status: 403 } });
      const navigation = await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Delete collection"));
      await confirmDelete();

      expect(navigation.goBack).not.toHaveBeenCalled();
      const dialog = useDialogStore.getState().current!;
      expect(dialog.title).toBe("Not allowed");
      expect(dialog.message).toMatch(/permission/i);
      // The offline copy must NOT be used for a permissions error.
      expect(dialog.message).not.toMatch(/connection/i);
    });

    it("surfaces an offline message when the delete fails without a 403", async () => {
      useUserStore.setState({ user: { type: "admin" } } as any);
      (api.delete as jest.Mock).mockRejectedValue({ response: { status: 500 } });
      const navigation = await renderCollection();
      await screen.findByText("Finished Book");

      await fireEvent.press(screen.getByLabelText("Delete collection"));
      await confirmDelete();

      expect(navigation.goBack).not.toHaveBeenCalled();
      const dialog = useDialogStore.getState().current!;
      expect(dialog.title).toBe("Couldn't delete");
      expect(dialog.message).toMatch(/connection/i);
    });
  });
});
