/**
 * OpenFeedSheet — the shared admin-only "Open RSS feed" flow used by the item,
 * series, and collection detail screens. Covers: slug defaulting, the
 * public-access confirm BEFORE opening, success (URL + copy + snackbar), the
 * distinct slug-collision (400) copy, per-kind route selection, and the
 * non-admin hidden gate.
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));

import OpenFeedSheet, { slugifyFeedTitle } from "../../components/OpenFeedSheet";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { useUserStore } from "../../store/useUserStore";

const mockedPost = api.post as jest.Mock;
const Clipboard = require("expo-clipboard");

const initialUser = useUserStore.getState();

const setAdmin = () =>
  useUserStore.setState({
    user: { id: "u1", username: "boss", type: "admin", permissions: {} },
    serverConnectionConfig: { address: "https://abs.test", token: "tok", version: "2.35.1" },
  } as any);

const itemEntity = { kind: "item" as const, id: "item1", title: "The Wheel of Time" };

/** Fire the confirm dialog's "Open feed" button (the flow gates on it). */
const confirmOpen = async () => {
  const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
  await act(async () => {
    await dialog.buttons.find((b: any) => b.text === "Open feed").onPress();
  });
};

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  setAdmin();
  mockedPost.mockReset().mockResolvedValue({ data: {} });
  (showAppDialog as jest.Mock).mockClear();
  (showSnackbar as jest.Mock).mockClear();
});

it("slugifyFeedTitle produces url-safe slugs", () => {
  expect(slugifyFeedTitle("The Wheel of Time")).toBe("the-wheel-of-time");
  expect(slugifyFeedTitle("  Dune: Messiah! (Unabridged)  ")).toBe("dune-messiah-unabridged");
  expect(slugifyFeedTitle("")).toBe("");
});

it("defaults the address to the slugified title", async () => {
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  const input = await screen.findByLabelText("RSS feed address");
  expect(input.props.value).toBe("the-wheel-of-time");
});

it("blocks opening with no server session (serverAddress absent)", async () => {
  useUserStore.setState({ serverConnectionConfig: { token: "tok" } } as any);
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  await screen.findByLabelText("RSS feed address");

  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  expect(showAppDialog).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("No server session") })
  );
  // Never even reaches the public-access confirm or a request.
  expect(mockedPost).not.toHaveBeenCalled();
});

it("warns (public-access confirm) BEFORE opening — no request until confirmed", async () => {
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  await screen.findByLabelText("RSS feed address");

  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  // A confirm dialog fires first; the open request has NOT been made yet.
  const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
  expect(dialog.title).toBe("Open a public RSS feed?");
  expect(dialog.message).toContain("public");
  expect(mockedPost).not.toHaveBeenCalled();

  await confirmOpen();
  expect(mockedPost).toHaveBeenCalledWith("/api/feeds/item/item1/open", {
    serverAddress: "https://abs.test",
    slug: "the-wheel-of-time",
  });
});

it("on success shows the public feed URL with Copy + a snackbar", async () => {
  mockedPost.mockResolvedValue({
    data: { feed: { id: "the-wheel-of-time", slug: "the-wheel-of-time", feedUrl: "https://abs.test/feed/the-wheel-of-time" } },
  });
  const clipSpy = jest.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  await screen.findByLabelText("RSS feed address");

  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  await confirmOpen();

  // The minted public URL renders, and success is announced.
  await screen.findByText("https://abs.test/feed/the-wheel-of-time");
  expect(showSnackbar).toHaveBeenCalledWith({ message: "RSS feed opened" });

  // Copy uses the clipboard + its own snackbar.
  await fireEvent.press(screen.getByText("Copy link"));
  expect(clipSpy).toHaveBeenCalledWith("https://abs.test/feed/the-wheel-of-time");
  expect(showSnackbar).toHaveBeenCalledWith({ message: "Link copied" });
  clipSpy.mockRestore();
});

it("a slug collision (400) gets its own copy, not the generic failure", async () => {
  mockedPost.mockRejectedValue({ response: { status: 400, data: "Slug already in use" } });
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  await screen.findByLabelText("RSS feed address");

  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  await confirmOpen();

  await waitFor(() =>
    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't open feed",
        message: "That address is already in use — pick a different one.",
      })
    )
  );
});

it("a NON-collision 400 surfaces the server's own reason, not the collision copy", async () => {
  // 400 is also used for bad-request cases like an invalid slug format — those
  // must show the server's message, not "already in use".
  mockedPost.mockRejectedValue({ response: { status: 400, data: "Invalid slug format" } });
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  await screen.findByLabelText("RSS feed address");

  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  await confirmOpen();

  await waitFor(() =>
    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't open feed", message: "Invalid slug format" })
    )
  );
  // Never mislabeled as a slug collision.
  expect(showAppDialog).not.toHaveBeenCalledWith(
    expect.objectContaining({ message: "That address is already in use — pick a different one." })
  );
});

it("a generic failure surfaces the normalized AbsError message", async () => {
  mockedPost.mockRejectedValue({ response: { status: 500 } });
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  await screen.findByLabelText("RSS feed address");

  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  await confirmOpen();

  await waitFor(() =>
    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't open feed",
        message: "The server hit an error handling this request.",
      })
    )
  );
});

it("a rapid double-confirm fires only ONE open request (synchronous re-entrancy guard)", async () => {
  // Never resolve — hold the first request in-flight so a second confirm tap
  // arrives before setBusy(true) has been applied. Only the busyRef guard, which
  // flips synchronously, can stop the second POST.
  mockedPost.mockReturnValue(new Promise(() => {}));
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  await screen.findByLabelText("RSS feed address");

  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  // Grab the confirm dialog once, then invoke its Open button twice in a single
  // act() — the two calls race before React flushes the setBusy(true) update.
  const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
  const openBtn = dialog.buttons.find((b: any) => b.text === "Open feed");
  await act(async () => {
    openBtn.onPress();
    openBtn.onPress();
  });

  expect(mockedPost).toHaveBeenCalledTimes(1);
});

it("routes to the SERIES open route for a series entity", async () => {
  await render(
    <OpenFeedSheet entity={{ kind: "series", id: "ser1", title: "Mistborn" }} onClose={() => {}} />
  );
  await screen.findByLabelText("RSS feed address");
  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  await confirmOpen();
  expect(mockedPost).toHaveBeenCalledWith(
    "/api/feeds/series/ser1/open",
    expect.objectContaining({ slug: "mistborn" })
  );
});

it("routes to the COLLECTION open route for a collection entity", async () => {
  await render(
    <OpenFeedSheet entity={{ kind: "collection", id: "col1", title: "Faves" }} onClose={() => {}} />
  );
  await screen.findByLabelText("RSS feed address");
  await fireEvent.press(screen.getByLabelText("Open RSS feed"));
  await confirmOpen();
  expect(mockedPost).toHaveBeenCalledWith(
    "/api/feeds/collection/col1/open",
    expect.objectContaining({ slug: "faves" })
  );
});

it("renders nothing for a non-admin (feed routes are admin-only)", async () => {
  useUserStore.setState({
    user: { id: "u2", username: "joe", type: "user", permissions: {} },
  } as any);
  await render(<OpenFeedSheet entity={itemEntity} onClose={() => {}} />);
  expect(screen.queryByLabelText("RSS feed address")).toBeNull();
  expect(screen.queryByText("Open RSS feed")).toBeNull();
});
