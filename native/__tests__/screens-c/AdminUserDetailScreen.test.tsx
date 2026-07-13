/**
 * AdminUserDetailScreen — create/edit a server user. Pins the POST/PATCH
 * payload shapes (including tag restrictions echoed back UNCHANGED), the
 * password-reset semantics (blank = unchanged), the root-account guard
 * (non-root sees read-only), the self-delete / self-demote / self-disable
 * blocks, the Tier-3 typed-confirm delete, the beforeRemove dirty guard, the
 * inline required-field + 409 duplicate-username errors, and the offline vs
 * 403 load states.
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
jest.mock("../../utils/abs/server", () => ({
  getTags: jest.fn(),
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import AdminUserDetailScreen from "../../screens/AdminUserDetailScreen";
import { api } from "../../utils/api";
import { getUser, createUser, updateUser, deleteUser, getUserListeningStats } from "../../utils/abs/users";
import { getTags } from "../../utils/abs/server";
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
  itemTagsSelected: [],
};

// Captures navigation listeners (beforeRemove) — the ChapterEditor test idiom.
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

async function renderScreen(params: any = {}) {
  const { navigation, listeners } = makeNavigation();
  await render(<AdminUserDetailScreen navigation={navigation} route={{ params }} />);
  return Object.assign(navigation, { listeners });
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
  (getTags as jest.Mock).mockResolvedValue(["kids", "teen", "adult"]);
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
        itemTagsSelected: [],
      })
    );
    expect(showSnackbar).toHaveBeenCalledWith({ message: "User created" });
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("hides the Tag access section in create mode (per-tag restriction is edit-only)", async () => {
    await renderScreen({});
    await screen.findByText("New user");
    // The "All tags" toggle and the tag checklist never render during create,
    // so the create payload's forced accessAllTags:true can't be contradicted.
    expect(screen.queryByText("Tag access")).toBeNull();
    expect(screen.queryByLabelText("All tags")).toBeNull();
    // Library access (which IS editable in create) still renders.
    expect(screen.getByText("Library access")).toBeTruthy();
    // ...and no tag vocabulary is fetched for a section that never renders.
    expect(getTags).not.toHaveBeenCalled();
  });

  it("blocks create without a password — INLINE field error, no dialog, no POST", async () => {
    await renderScreen({});
    await screen.findByText("New user");

    await setField("Username", "newbie");
    fireEvent.press(screen.getByLabelText("Create user"));

    expect(await screen.findByText("Password required")).toBeTruthy();
    expect(showAppDialog).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();

    // Typing into the field clears the inline error.
    await setField("Password", "p");
    expect(screen.queryByText("Password required")).toBeNull();
  });

  it("blocks create without a username — INLINE field error, no dialog, no POST", async () => {
    await renderScreen({});
    await screen.findByText("New user");

    await setField("Password", "pw123");
    fireEvent.press(screen.getByLabelText("Create user"));

    expect(await screen.findByText("Username required")).toBeTruthy();
    expect(showAppDialog).not.toHaveBeenCalled();
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
    // `username` names the filter chip on the sessions screen (FROZEN param name).
    expect(navigation.navigate).toHaveBeenCalledWith("AdminSessions", {
      userId: "u2",
      username: "joe",
    });
  });

  it("echoes a tag-restricted user's tag fields back UNCHANGED on an unrelated edit", async () => {
    // Regression: buildPayload used to send accessAllTags:true unconditionally
    // and drop itemTagsSelected — any edit silently un-restricted the user.
    (getUser as jest.Mock).mockResolvedValue({
      ...JOE,
      permissions: { ...JOE.permissions, accessAllTags: false },
      itemTagsSelected: ["kids", "teen"],
      itemTagsAccessible: ["kids"],
    });
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    // Toggle an UNRELATED permission, then save.
    fireEvent.press(screen.getByLabelText("Can upload"));
    await waitFor(() =>
      expect(screen.getByLabelText("Can upload").props.accessibilityState.checked).toBe(true)
    );
    fireEvent.press(screen.getByLabelText("Save user"));

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    const payload = (updateUser as jest.Mock).mock.calls[0][1];
    expect(payload.permissions.upload).toBe(true); // the actual edit
    // Tag restriction preserved EXACTLY.
    expect(payload.permissions.accessAllTags).toBe(false);
    expect(payload.itemTagsSelected).toEqual(["kids", "teen"]);
    expect(payload.itemTagsAccessible).toEqual(["kids"]);
  });

  it("renders Tag access read-only for a BLOCK-LIST user and echoes their tag fields", async () => {
    // selectedTagsNotAccessible inverts the list to a block-list — the allow-list
    // checklist can't represent it, so the section is read-only and the tag
    // fields must round-trip unchanged through an unrelated edit.
    (getUser as jest.Mock).mockResolvedValue({
      ...JOE,
      permissions: { ...JOE.permissions, accessAllTags: false, selectedTagsNotAccessible: true },
      itemTagsSelected: ["spicy"],
    });
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    // No editable tag controls — a read-only note instead.
    expect(screen.queryByLabelText("All tags")).toBeNull();
    expect(screen.queryByLabelText(/^Tag access:/)).toBeNull();
    expect(screen.getByText(/block-list on the server/)).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Can upload"));
    await waitFor(() =>
      expect(screen.getByLabelText("Can upload").props.accessibilityState.checked).toBe(true)
    );
    fireEvent.press(screen.getByLabelText("Save user"));

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    const payload = (updateUser as jest.Mock).mock.calls[0][1];
    expect(payload.permissions.upload).toBe(true); // the actual edit
    // Block-list semantics preserved verbatim.
    expect(payload.permissions.selectedTagsNotAccessible).toBe(true);
    expect(payload.permissions.accessAllTags).toBe(false);
    expect(payload.itemTagsSelected).toEqual(["spicy"]);
  });

  it("preserves an unmodeled server permission key (createEreader) on an unrelated edit", async () => {
    // buildPayload seeds permissions from the LOADED object, so a newer-server
    // key we don't surface in the form must round-trip untouched rather than be
    // dropped (which, on a replace-semantics server, would revoke it).
    (getUser as jest.Mock).mockResolvedValue({
      ...JOE,
      permissions: { ...JOE.permissions, createEreader: true },
    });
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText("Can upload"));
    await waitFor(() =>
      expect(screen.getByLabelText("Can upload").props.accessibilityState.checked).toBe(true)
    );
    fireEvent.press(screen.getByLabelText("Save user"));

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    const payload = (updateUser as jest.Mock).mock.calls[0][1];
    expect(payload.permissions.upload).toBe(true); // the actual edit
    expect(payload.permissions.createEreader).toBe(true); // untouched key survives
  });

  it("the header Save button stays disabled until the form is dirty", async () => {
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    expect(screen.getByLabelText("Save user").props.accessibilityState.disabled).toBe(true);

    await setField("Username", "joe2");
    expect(screen.getByLabelText("Save user").props.accessibilityState.disabled).toBe(false);
  });

  it("username field is no-caps with next-key chaining; password submits with done", async () => {
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    const usernameInput = screen.getByLabelText("Username");
    expect(usernameInput.props.autoCapitalize).toBe("none");
    expect(usernameInput.props.returnKeyType).toBe("next");
    expect(screen.getByLabelText("New password").props.returnKeyType).toBe("done");
  });

  it("a stats failure never blocks editing", async () => {
    (getUserListeningStats as jest.Mock).mockRejectedValue(new AbsError("server", "boom", 500));
    await renderScreen({ userId: "u2" });

    expect(await screen.findByText("joe")).toBeTruthy();
    expect(screen.getByLabelText("Save user")).toBeTruthy();
    expect(screen.queryByText(/Total listening time/)).toBeNull();
  });
});

describe("AdminUserDetailScreen — tag access", () => {
  // A tag-restricted user: allow-list of ["kids"], block-list flag + old-server
  // top-level accessible-tags list present, to prove both are preserved.
  const RESTRICTED = {
    ...JOE,
    permissions: {
      ...JOE.permissions,
      accessAllTags: false,
      selectedTagsNotAccessible: false,
    },
    itemTagsSelected: ["kids"],
    itemTagsAccessible: ["kids"],
  };

  it("renders the tag checklist with the user's tags checked and All-tags off", async () => {
    (getUser as jest.Mock).mockResolvedValue(RESTRICTED);
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    // "All tags" toggle is OFF for a restricted user.
    expect(screen.getByLabelText("All tags").props.accessibilityState.checked).toBe(false);
    // Checklist reflects the loaded selection.
    const kids = await screen.findByLabelText("Tag access: kids");
    expect(kids.props.accessibilityState.checked).toBe(true);
    expect(screen.getByLabelText("Tag access: teen").props.accessibilityState.checked).toBe(false);
    expect(screen.getByLabelText("Tag access: adult").props.accessibilityState.checked).toBe(false);
  });

  it("checking another tag and saving sends the updated itemTagsSelected, preserving the block-list flag + old-server echo", async () => {
    (getUser as jest.Mock).mockResolvedValue(RESTRICTED);
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    fireEvent.press(await screen.findByLabelText("Tag access: teen"));
    await waitFor(() =>
      expect(screen.getByLabelText("Tag access: teen").props.accessibilityState.checked).toBe(true)
    );
    fireEvent.press(screen.getByLabelText("Save user"));

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    const payload = (updateUser as jest.Mock).mock.calls[0][1];
    expect(payload.permissions.accessAllTags).toBe(false);
    expect([...payload.itemTagsSelected].sort()).toEqual(["kids", "teen"]);
    // The no-UI block-list flag is echoed back UNCHANGED.
    expect(payload.permissions.selectedTagsNotAccessible).toBe(false);
    // Old-server top-level accessible-tags list still echoed.
    expect(payload.itemTagsAccessible).toEqual(["kids"]);
  });

  it("flipping All-tags ON clears the selection (accessAllTags:true + itemTagsSelected:[])", async () => {
    (getUser as jest.Mock).mockResolvedValue(RESTRICTED);
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText("All tags"));
    await waitFor(() =>
      expect(screen.getByLabelText("All tags").props.accessibilityState.checked).toBe(true)
    );
    // Checklist disappears once "All tags" is on.
    expect(screen.queryByLabelText("Tag access: kids")).toBeNull();

    fireEvent.press(screen.getByLabelText("Save user"));
    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    const payload = (updateUser as jest.Mock).mock.calls[0][1];
    expect(payload.permissions.accessAllTags).toBe(true);
    expect(payload.itemTagsSelected).toEqual([]);
    // Block-list flag still preserved even when granting all tags.
    expect(payload.permissions.selectedTagsNotAccessible).toBe(false);
  });

  it("a getTags failure never blocks saving — the checklist just shows a helper", async () => {
    (getTags as jest.Mock).mockRejectedValue(new AbsError("server", "boom", 500));
    (getUser as jest.Mock).mockResolvedValue({
      ...JOE,
      permissions: { ...JOE.permissions, accessAllTags: false },
      itemTagsSelected: [],
    });
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    // The fetch FAILED ⇒ a distinct "couldn't load" helper (not the misleading
    // "no tags defined" empty-server copy), and no rows.
    expect(await screen.findByText(/Couldn't load the server's tags/)).toBeTruthy();
    expect(screen.queryByText("No tags are defined on this server yet.")).toBeNull();
    expect(screen.queryByLabelText(/^Tag access:/)).toBeNull();

    // Saving still works (an unrelated edit).
    await setField("Username", "joe2");
    fireEvent.press(screen.getByLabelText("Save user"));
    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    const payload = (updateUser as jest.Mock).mock.calls[0][1];
    expect(payload.permissions.accessAllTags).toBe(false);
    expect(payload.itemTagsSelected).toEqual([]);
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

  it("blocks disabling your own account with an explaining dialog (toggle stays on)", async () => {
    useUserStore.setState({ user: { id: "u2", username: "joe", type: "admin" } } as any);
    await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText(/^Account enabled/));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "You can't disable your own account" })
      )
    );
    // The toggle never flips — the doomed PATCH can't even be staged.
    expect(screen.getByLabelText(/^Account enabled/).props.accessibilityState.checked).toBe(true);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("disabling SOMEONE ELSE'S account is not blocked", async () => {
    await renderScreen({ userId: "u2" }); // me = admin1, target = u2
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText(/^Account enabled/));

    await waitFor(() =>
      expect(screen.getByLabelText(/^Account enabled/).props.accessibilityState.checked).toBe(false)
    );
    expect(showAppDialog).not.toHaveBeenCalled();
  });
});

describe("AdminUserDetailScreen — dirty-form guard (beforeRemove)", () => {
  const goBackEvent = () => ({
    preventDefault: jest.fn(),
    data: { action: { type: "GO_BACK" } },
  });

  it("a DIRTY form blocks navigation until Discard is confirmed", async () => {
    const navigation = await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    await setField("Username", "joe2");

    const event = goBackEvent();
    await act(async () => navigation.listeners["beforeRemove"](event));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Discard changes?" })
    );
    expect(navigation.dispatch).not.toHaveBeenCalled();

    const discard = lastDialog().buttons.find((b: any) => b.text === "Discard");
    expect(discard.style).toBe("destructive");
    await act(async () => discard.onPress());
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
  });

  it("a CLEAN form lets navigation proceed silently", async () => {
    const navigation = await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    const event = goBackEvent();
    await act(async () => navigation.listeners["beforeRemove"](event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(showAppDialog).not.toHaveBeenCalled();
  });

  it("an untouched CREATE form lets navigation proceed silently", async () => {
    const navigation = await renderScreen({});
    await screen.findByText("New user");

    const event = goBackEvent();
    await act(async () => navigation.listeners["beforeRemove"](event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(showAppDialog).not.toHaveBeenCalled();
  });

  it("a CREATE form with typed input arms the guard", async () => {
    const navigation = await renderScreen({});
    await screen.findByText("New user");

    await setField("Username", "half-finished");

    const event = goBackEvent();
    await act(async () => navigation.listeners["beforeRemove"](event));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Discard changes?" })
    );
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

  it("a delete failure surfaces the exact dialog, keeps the form, and does NOT pop back", async () => {
    (deleteUser as jest.Mock).mockRejectedValue(
      new AbsError("server", "The server hit an error handling this request.", 500)
    );
    const navigation = await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    fireEvent.press(screen.getByLabelText("Delete user"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    lastDialog().buttons.find((b: any) => b.text === "Delete").onPress();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't delete user",
          message: "The server hit an error handling this request.",
        })
      )
    );
    // Screen stays put with the form intact — nothing was deleted.
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(showSnackbar).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Username").props.value).toBe("joe");
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

  it("a 409 (duplicate username) becomes an INLINE username error, not a dialog", async () => {
    (updateUser as jest.Mock).mockRejectedValue(
      new AbsError("unknown", "Username already in use", 409)
    );
    const navigation = await renderScreen({ userId: "u2" });
    await screen.findByText("joe");

    await setField("Username", "marc");
    fireEvent.press(screen.getByLabelText("Save user"));

    expect(await screen.findByText("Username already taken")).toBeTruthy();
    expect(showAppDialog).not.toHaveBeenCalled();
    expect(navigation.goBack).not.toHaveBeenCalled();
    // Retyping clears it.
    await setField("Username", "marc2");
    expect(screen.queryByText("Username already taken")).toBeNull();
  });
});
