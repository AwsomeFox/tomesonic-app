/**
 * AdminUserDetailScreen — create/edit a server user. Pins the POST/PATCH
 * payload shapes, the password-reset semantics (blank = unchanged), the
 * root-account guard (non-root sees read-only), the self-delete and
 * self-demote blocks, the Tier-3 typed-confirm delete, and the offline vs 403
 * load states.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/abs/users", () => ({
  getUser: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  deleteUser: jest.fn(),
  getUserListeningStats: jest.fn(),
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import AdminUserDetailScreen from "../../screens/AdminUserDetailScreen";
import { api } from "../../utils/api";
import { getUser, createUser, updateUser, deleteUser, getUserListeningStats } from "../../utils/abs/users";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { AbsError } from "../../utils/abs/errors";

const initialUserState = useUserStore.getState();
const initialLibraryState = useLibraryStore.getState();

const ME_ADMIN = { id: "admin1", username: "marc", type: "admin" };

const JOE = {
  id: "u2",
  username: "joe",
  type: "user",
  isActive: true,
  lastSeen: 1,
  createdAt: 1,
  permissions: {
    download: true,
    update: false,
    delete: false,
    upload: false,
    accessAllLibraries: true,
    accessAllTags: true,
    accessExplicitContent: true,
  },
  librariesAccessible: [],
  itemTagsSelected: [],
};

const ROOT_USER = {
  ...JOE,
  id: "u0",
  username: "root",
  type: "root",
  permissions: {
    ...JOE.permissions,
    update: true,
    delete: true,
    upload: true,
  },
};

// The payload the form produces for JOE with no edits (minus password).
const JOE_BASE_PAYLOAD = {
  username: "joe",
  type: "user",
  isActive: true,
  permissions: {
    download: true,
    update: false,
    delete: false,
    upload: false,
    accessExplicitContent: true,
    accessAllLibraries: true,
    accessAllTags: true,
  },
  librariesAccessible: [],
};

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen(params: any = {}) {
  const navigation = makeNavigation();
  await render(<AdminUserDetailScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

function lastDialog() {
  const calls = (showAppDialog as jest.Mock).mock.calls;
  return calls[calls.length - 1][0];
}

async function setField(label: string, text: string) {
  fireEvent.changeText(screen.getByLabelText(label), text);
  await waitFor(() => expect(screen.getByLabelText(label).props.value).toBe(text));
}

beforeEach(() => {
  useUserStore.setState(initialUserState, true);
  useUserStore.setState({ user: ME_ADMIN } as any);
  useLibraryStore.setState(initialLibraryState, true);
  useLibraryStore.setState({
    libraries: [
      { id: "lib1", name: "Audiobooks", mediaType: "book", settings: {} },
      { id: "lib2", name: "Podcasts", mediaType: "podcast", settings: {} },
    ] as any,
    lastLoad: Date.now(),
  });
  (api.get as jest.Mock).mockResolvedValue({ data: {} });
  (getUser as jest.Mock).mockResolvedValue(JOE);
  (getUserListeningStats as jest.Mock).mockResolvedValue({ totalTime: 3661 });
  (createUser as jest.Mock).mockResolvedValue(JOE);
  (updateUser as jest.Mock).mockResolvedValue(JOE);
  (deleteUser as jest.Mock).mockResolvedValue(undefined);
});

describe("AdminUserDetailScreen — create mode", () => {
  it("POSTs the exact create payload (defaults + edits) and confirms with a snackbar", async () => {
    const navigation = await renderScreen({});
    expect(await screen.findByText("New user")).toBeTruthy();
    // Create mode never fetches a user.
    expect(getUser).not.toHaveBeenCalled();

    await setField("Username", "newbie");
    await setField("Password", "pw123");
    // Flip one permission on so the payload isn't all defaults.
    fireEvent.press(screen.getByLabelText("Can upload"));
    await waitFor(() =>
      expect(screen.getByLabelText("Can upload").props.accessibilityState.checked).toBe(true)
    );

    fireEvent.press(screen.getByLabelText("Create user"));

    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith({
        username: "newbie",
        password: "pw123",
        type: "user",
        isActive: true,
        permissions: {
          download: true,
          update: false,
          delete: false,
          upload: true,
          accessExplicitContent: true,
          accessAllLibraries: true,
          accessAllTags: true,
        },
        librariesAccessible: [],
      })
    );
    expect(showSnackbar).toHaveBeenCalledWith({ message: "User created" });
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("blocks create without a password (dialog, no POST)", async () => {
    await renderScreen({});
    await screen.findByText("New user");

    await setField("Username", "newbie");
    fireEvent.press(screen.getByLabelText("Create user"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Password required" })
      )
    );
    expect(createUser).not.toHaveBeenCalled();
  });

  it("selecting specific libraries sends accessAllLibraries=false + the chosen ids", async () => {
    await renderScreen({});
    await screen.findByText("New user");

    await setField("Username", "newbie");
    await setField("Password", "pw123");

    // Library rows only appear once "All libraries" is off.
    expect(screen.queryByLabelText("Library access: Audiobooks")).toBeNull();
    fireEvent.press(screen.getByLabelText("All libraries"));
    const libRow = await screen.findByLabelText("Library access: Audiobooks");
    fireEvent.press(libRow);
    await waitFor(() =>
      expect(
        screen.getByLabelText("Library access: Audiobooks").props.accessibilityState.checked
      ).toBe(true)
    );

    fireEvent.press(screen.getByLabelText("Create user"));

    await waitFor(() => expect(createUser).toHaveBeenCalled());
    const payload = (createUser as jest.Mock).mock.calls[0][0];
    expect(payload.permissions.accessAllLibraries).toBe(false);
    expect(payload.librariesAccessible).toEqual(["lib1"]);
  });
});

describe("AdminUserDetailScreen — edit mode", () => {
  it("loads the user, shows stats, and PATCHes WITHOUT a password when the field is blank", async () => {
    const navigation = await renderScreen({ userId: "u2" });
    expect(await screen.findByText("joe")).toBeTruthy();
    expect(getUser).toHaveBeenCalledWith("u2");
    // Best-effort stats rendered.
    expect(screen.getByText("Total listening time: 1h 1m")).toBeTruthy();

    await setField("Username", "joe2");
    fireEvent.press(screen.getByLabelText("Save user"));

    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith("u2", { ...JOE_BASE_PAYLOAD, username: "joe2" })
    );
    // Blank password NEVER rides along (blank = unchanged).
    expect((updateUser as jest.Mock).mock.calls[0][1]).not.toHaveProperty("password");
    expect(showSnackbar).toHaveBeenCalledWith({ message: "User saved" });
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("an entered New password is included in the PATCH (password reset)", async () => {
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    await setField("New password", "s3cret");
    fireEvent.press(screen.getByLabelText("Save user"));

    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith("u2", { ...JOE_BASE_PAYLOAD, password: "s3cret" })
    );
  });

  it("navigates to this user's pre-filtered sessions list", async () => {
    const navigation = await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    fireEvent.press(screen.getByText("Listening sessions"));
    expect(navigation.navigate).toHaveBeenCalledWith("AdminSessions", { userId: "u2" });
  });

  it("a stats failure never blocks editing", async () => {
    (getUserListeningStats as jest.Mock).mockRejectedValue(new AbsError("server", "boom", 500));
    await renderScreen({ userId: "u2" });

    expect(await screen.findByText("joe")).toBeTruthy();
    expect(screen.getByLabelText("Save user")).toBeTruthy();
    expect(screen.queryByText(/Total listening time/)).toBeNull();
  });
});

describe("AdminUserDetailScreen — root-account guard", () => {
  it("non-root editing the root account renders read-only (banner, no save, no delete, frozen fields)", async () => {
    (getUser as jest.Mock).mockResolvedValue(ROOT_USER);
    await renderScreen({ userId: "u0" });
    await screen.findByText("root");

    expect(
      screen.getByText("Only the root user can edit the root account. Showing the current values.")
    ).toBeTruthy();
    expect(screen.queryByLabelText("Save user")).toBeNull();
    expect(screen.queryByLabelText("Delete user")).toBeNull();
    expect(screen.getByLabelText("Username").props.editable).toBe(false);
    // Root's type is immutable — no type chips, just the explanation.
    expect(screen.queryByLabelText("Account type: Admin")).toBeNull();
    expect(screen.getByText(/root account's type can't be changed/)).toBeTruthy();
  });

  it("the root user CAN edit the root account, and only username/password are PATCHed", async () => {
    useUserStore.setState({ user: { id: "u0", username: "root", type: "root" } } as any);
    (getUser as jest.Mock).mockResolvedValue(ROOT_USER);
    await renderScreen({ userId: "u0" });
    await screen.findByText("root");

    expect(screen.queryByText(/Only the root user can edit/)).toBeNull();

    await setField("Username", "root2");
    fireEvent.press(screen.getByLabelText("Save user"));

    // Never synthesize permissions/type for root — username (+password) only.
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith("u0", { username: "root2" }));
  });
});

describe("AdminUserDetailScreen — self-account guards", () => {
  it("blocks deleting your own account with an explaining dialog (no DELETE)", async () => {
    useUserStore.setState({ user: { id: "u2", username: "joe", type: "admin" } } as any);
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText("Delete user"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "You can't delete your own account" })
      )
    );
    // The blocking dialog has no confirm gate and fires no delete.
    expect(lastDialog().confirmInput).toBeUndefined();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("blocks demoting your own admin account with an explaining dialog (no PATCH)", async () => {
    useUserStore.setState({ user: { id: "adm2", username: "meg", type: "admin" } } as any);
    (getUser as jest.Mock).mockResolvedValue({
      ...JOE,
      id: "adm2",
      username: "meg",
      type: "admin",
    });
    await renderScreen({ userId: "adm2" });
    await screen.findByText("meg");

    fireEvent.press(screen.getByLabelText("Account type: User"));
    await waitFor(() =>
      expect(
        screen.getByLabelText("Account type: User").props.accessibilityState.selected
      ).toBe(true)
    );
    fireEvent.press(screen.getByLabelText("Save user"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "You can't demote your own account" })
      )
    );
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe("AdminUserDetailScreen — delete (Tier-3 typed confirm)", () => {
  it("delete requires typing the username, then DELETEs and pops back", async () => {
    const navigation = await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText("Delete user"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());

    const dialog = lastDialog();
    expect(dialog.title).toBe("Delete joe?");
    // Typed-confirm gate: the confirm button stays disabled until "joe" is typed.
    expect(dialog.confirmInput).toEqual({ placeholder: "joe", requiredText: "joe" });
    expect(deleteUser).not.toHaveBeenCalled();

    const deleteBtn = dialog.buttons.find((b: any) => b.text === "Delete");
    expect(deleteBtn.style).toBe("destructive");
    deleteBtn.onPress();

    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith("u2"));
    await waitFor(() => expect(showSnackbar).toHaveBeenCalledWith({ message: "User deleted" }));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});

describe("AdminUserDetailScreen — load failures", () => {
  it("403 renders the admin-access-required state", async () => {
    (getUser as jest.Mock).mockRejectedValue(
      new AbsError("forbidden", "You don't have permission to do that.", 403)
    );
    await renderScreen({ userId: "u2" });

    expect(await screen.findByText("Admin access required")).toBeTruthy();
  });

  it("offline renders the offline state", async () => {
    (getUser as jest.Mock).mockRejectedValue(
      new AbsError("offline", "Can't reach the server. Check your connection.")
    );
    await renderScreen({ userId: "u2" });

    expect(await screen.findByText("You're offline")).toBeTruthy();
  });

  it("a save rejection surfaces a dialog and keeps the form", async () => {
    (updateUser as jest.Mock).mockRejectedValue(
      new AbsError("forbidden", "You don't have permission to do that.", 403)
    );
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    await setField("Username", "joe2");
    fireEvent.press(screen.getByLabelText("Save user"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't save user",
          message: "You don't have permission to do that.",
        })
      )
    );
    // Form state preserved (no goBack, edited value intact).
    expect(screen.getByLabelText("Username").props.value).toBe("joe2");
  });
});
