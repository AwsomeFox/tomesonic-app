/**
 * AdminUsersScreen — admin users list: loads GET /api/users, overlays a live
 * "Online" badge from the focus-gated /api/users/online poll, navigates to
 * AdminUserDetail (edit via row, create via the header add button), and maps
 * offline vs 403 failures to distinct error states.
 */

// Capture the useFocusEffect callback (usePolling's focus gate) so tests can
// drive "focus" explicitly — exactly what react-navigation does on focus.
let mockFocusCb: (() => void | (() => void)) | null = null;
jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (cb: any) => {
    mockFocusCb = cb;
  },
}));

jest.mock("../../utils/abs/users", () => ({
  getUsers: jest.fn(),
  getOnlineUsers: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import AdminUsersScreen from "../../screens/AdminUsersScreen";
import { getUsers, getOnlineUsers } from "../../utils/abs/users";
import { AbsError } from "../../utils/abs/errors";

const HOUR = 60 * 60 * 1000;

const USERS = [
  {
    id: "u0",
    username: "root",
    type: "root",
    isActive: true,
    lastSeen: Date.now() - 2 * HOUR,
    createdAt: 1,
    permissions: {},
    librariesAccessible: [],
    itemTagsSelected: [],
  },
  {
    id: "u1",
    username: "marc",
    type: "admin",
    isActive: true,
    lastSeen: Date.now() - 3 * HOUR,
    createdAt: 1,
    permissions: {},
    librariesAccessible: [],
    itemTagsSelected: [],
  },
  {
    id: "u2",
    username: "joe",
    type: "user",
    isActive: true,
    lastSeen: Date.now() - 5 * 60 * 1000,
    createdAt: 1,
    permissions: {},
    librariesAccessible: [],
    itemTagsSelected: [],
  },
  {
    id: "u3",
    username: "olduser",
    type: "user",
    isActive: false,
    lastSeen: null,
    createdAt: 1,
    permissions: {},
    librariesAccessible: [],
    itemTagsSelected: [],
  },
];

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminUsersScreen navigation={navigation} route={{ params: {} }} />);
  return navigation;
}

// Fire the captured focus callback so usePolling runs its first poll.
async function focusScreen() {
  await act(async () => {
    mockFocusCb?.();
  });
}

beforeEach(() => {
  mockFocusCb = null;
  (getUsers as jest.Mock).mockResolvedValue(USERS);
  (getOnlineUsers as jest.Mock).mockResolvedValue({ usersOnline: [], openSessions: [] });
});

describe("AdminUsersScreen", () => {
  it("lists every user with role chip and last-seen, via a parameterless getUsers call", async () => {
    await renderScreen();

    expect(await screen.findByText("joe")).toBeTruthy();
    expect(screen.getByText("marc")).toBeTruthy();
    expect(screen.getByText("olduser")).toBeTruthy();
    // Role chips render as text (never color-only) — "root" appears twice:
    // once as the username, once as the role chip.
    expect(screen.getAllByText("root")).toHaveLength(2);
    expect(screen.getByText("admin")).toBeTruthy();
    // Inactive account is labeled, not just dimmed.
    expect(screen.getByText("Disabled")).toBeTruthy();
    // Never-seen user renders "Never".
    expect(screen.getByText("Last seen Never")).toBeTruthy();
    expect(getUsers).toHaveBeenCalledWith();
  });

  it("row tap navigates to AdminUserDetail with the userId", async () => {
    const navigation = await renderScreen();
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText(/^joe, user/));
    expect(navigation.navigate).toHaveBeenCalledWith("AdminUserDetail", { userId: "u2" });
  });

  it("the header add button opens AdminUserDetail in create mode (no userId)", async () => {
    const navigation = await renderScreen();
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText("Add user"));
    expect(navigation.navigate).toHaveBeenCalledWith("AdminUserDetail", {});
  });

  it("shows the Online badge for polled-online users only, with a freshness caption", async () => {
    (getOnlineUsers as jest.Mock).mockResolvedValue({
      usersOnline: [{ id: "u2", username: "joe" }],
      openSessions: [],
    });
    await renderScreen();
    await screen.findByText("joe");

    // No badge before the poll has answered.
    expect(screen.queryByText("Online")).toBeNull();

    await focusScreen();

    await waitFor(() => expect(screen.getByText("Online")).toBeTruthy());
    // Exactly one user is online.
    expect(screen.getAllByText("Online")).toHaveLength(1);
    // Row label folds the status in for screen readers.
    expect(screen.getByLabelText(/^joe, user, online/)).toBeTruthy();
    // Staleness caption (no websocket — status is as-of the last poll).
    expect(screen.getByText(/Online status as of .* — pull to refresh/)).toBeTruthy();
  });

  it("polling failures never break the list — badges just stay absent", async () => {
    (getOnlineUsers as jest.Mock).mockRejectedValue(new AbsError("server", "boom", 500));
    await renderScreen();
    await screen.findByText("joe");

    await focusScreen();

    expect(screen.getByText("joe")).toBeTruthy();
    expect(screen.queryByText("Online")).toBeNull();
  });

  it("refetches SILENTLY on navigation focus so edits made in detail show on return", async () => {
    const navigation = await renderScreen();
    await screen.findByText("joe");
    expect(getUsers).toHaveBeenCalledTimes(1);

    // Simulate returning from AdminUserDetail: the server now knows joe as
    // "joe2". Keep the refetch pending at first to prove there's no
    // full-screen spinner while fresh data is on its way.
    let resolveRefetch: (v: any) => void;
    (getUsers as jest.Mock).mockImplementationOnce(
      () => new Promise((res) => (resolveRefetch = res))
    );
    const focusCall = (navigation.addListener as jest.Mock).mock.calls.find(
      (c: any[]) => c[0] === "focus"
    );
    expect(focusCall).toBeTruthy();
    await act(async () => {
      focusCall[1]();
    });

    // Silent: the already-rendered list stays visible mid-refetch.
    expect(getUsers).toHaveBeenCalledTimes(2);
    expect(screen.getByText("joe")).toBeTruthy();

    await act(async () => {
      resolveRefetch!([{ ...USERS[2], username: "joe2" }]);
    });
    expect(await screen.findByText("joe2")).toBeTruthy();
    expect(screen.queryByText("marc")).toBeNull();
  });

  it("a failed focus refetch keeps the already-rendered list (no error nuke)", async () => {
    const navigation = await renderScreen();
    await screen.findByText("joe");

    (getUsers as jest.Mock).mockRejectedValueOnce(new AbsError("server", "boom", 500));
    const focusCall = (navigation.addListener as jest.Mock).mock.calls.find(
      (c: any[]) => c[0] === "focus"
    );
    await act(async () => {
      focusCall[1]();
    });

    expect(screen.getByText("joe")).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("403 renders the admin-access-required error state with a working retry", async () => {
    (getUsers as jest.Mock).mockRejectedValueOnce(
      new AbsError("forbidden", "You don't have permission to do that.", 403)
    );
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();

    // Retry reloads and succeeds.
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("joe")).toBeTruthy();
    expect(getUsers).toHaveBeenCalledTimes(2);
  });

  it("offline renders the offline state (distinct from a server rejection)", async () => {
    (getUsers as jest.Mock).mockRejectedValue(
      new AbsError("offline", "Can't reach the server. Check your connection.")
    );
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(screen.getByText("Server administration needs a connection.")).toBeTruthy();
    expect(screen.queryByText("Admin access required")).toBeNull();
  });
});
