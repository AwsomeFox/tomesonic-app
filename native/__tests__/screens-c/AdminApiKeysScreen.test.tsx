/**
 * AdminApiKeysScreen — server API key list/create/delete. The actual token is
 * returned ONLY by the create call: the screen reveals it once in a dialog
 * (with a copy action) and must never persist it (no store, no MMKV, not even
 * re-rendered on screen). The screen also degrades: a capability gate
 * (supportsApiKeys, server >= 2.26.0) or a live 404 both render the
 * unsupported state, and offline vs 403 fetch failures render distinct error
 * states.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
// Spy WRAPPING the real store (not a stub): most tests assert on the
// showAppDialog calls, but the one-time-reveal test renders the real
// <AppDialog/> host to prove the Copy button keeps the dialog open.
jest.mock("../../store/useDialogStore", () => {
  const actual = jest.requireActual("../../store/useDialogStore");
  return {
    ...actual,
    showAppDialog: jest.fn((opts: any) => actual.showAppDialog(opts)),
  };
});
jest.mock("../../store/useSnackbarStore", () => ({
  showSnackbar: jest.fn(),
}));

import React from "react";
import { Clipboard } from "react-native";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import AdminApiKeysScreen from "../../screens/AdminApiKeysScreen";
import AppDialog from "../../components/AppDialog";
import { api } from "../../utils/api";
import { showAppDialog, useDialogStore } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { useUserStore } from "../../store/useUserStore";

const initialUserState = useUserStore.getState();

const ROOT = { id: "u1", username: "root", type: "root", permissions: {} };
const CONFIG = {
  address: "https://abs.example.com",
  token: "tok",
  userId: "u1",
  username: "root",
  version: "2.35.1", // >= 2.26.0 → supportsApiKeys
};

const KEYS = [
  {
    id: "k1",
    name: "CI key",
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    isActive: true,
    userId: "u1",
    user: { id: "u1", username: "root", type: "root" },
  },
  {
    id: "k2",
    name: "Old key",
    expiresAt: "2026-09-01T12:00:00.000Z",
    createdAt: "2026-01-02T00:00:00.000Z",
    isActive: false,
    userId: "u1",
  },
];

// Server users for the act-as picker (GET /api/users): a root, a plain user,
// and a non-root admin.
const USERS = [
  { id: "u1", username: "root", type: "root", isActive: true },
  { id: "u2", username: "bob", type: "user", isActive: true },
  { id: "u3", username: "adminA", type: "admin", isActive: true },
];

function mockKeysList(apiKeys: any[] = KEYS, users: any[] = USERS) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/api-keys") return Promise.resolve({ data: { apiKeys } });
    if (url === "/api/users") return Promise.resolve({ data: { users } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminApiKeysScreen navigation={navigation} route={{ params: {} }} />);
  return navigation;
}

let setStringSpy: jest.SpyInstance;

beforeEach(() => {
  useUserStore.setState(initialUserState, true);
  useUserStore.setState({ user: ROOT, serverConnectionConfig: CONFIG } as any);
  // The dialog spy drives the REAL store — clear any dialog left by a test.
  useDialogStore.setState({ current: null } as any);
  mockKeysList();
  (api.delete as jest.Mock).mockResolvedValue({ data: {} });
  setStringSpy = jest.spyOn(Clipboard, "setString").mockImplementation(() => {});
});

// Settle any trailing async continuations (sheet close animations, create
// refreshes) INSIDE act before RNTL cleanup unmounts — a leaked update
// otherwise corrupts the async act queue for the next test (see the Copy-key
// test's comment for the same failure mode).
afterEach(async () => {
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
});

describe("AdminApiKeysScreen", () => {
  it("lists the server's API keys with expiry/status subtitles", async () => {
    await renderScreen();

    expect(await screen.findByText("CI key")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/api-keys");
    expect(screen.getByText(/Never expires · Acts as root/)).toBeTruthy();
    // Inactive key folds its state and expiry into the subtitle.
    expect(screen.getByText("Old key")).toBeTruthy();
    expect(screen.getByText(/Inactive · Expires/)).toBeTruthy();
  });

  it("creates a key (exact POST body) and reveals the one-time key in a dialog without persisting it", async () => {
    const RAW = "abs_supersecret_token_12345";
    (api.post as jest.Mock).mockImplementation((url: string) => {
      if (url === "/api/api-keys")
        return Promise.resolve({
          data: {
            apiKey: {
              id: "k9",
              name: "Phone",
              expiresAt: null,
              isActive: true,
              userId: "u1",
              apiKey: RAW,
            },
          },
        });
      return Promise.resolve({ data: {} });
    });
    await renderScreen();
    await screen.findByText("CI key");

    fireEvent.changeText(screen.getByLabelText("API key name"), "Phone");
    await waitFor(() =>
      expect(screen.getByLabelText("API key name").props.value).toBe("Phone")
    );
    fireEvent.press(screen.getByLabelText("Key expires: Never"));
    await waitFor(() =>
      expect(
        screen.getByLabelText("Key expires: Never").props.accessibilityState.selected
      ).toBe(true)
    );
    fireEvent.press(screen.getByLabelText("Create API key"));

    // "Never" expiry → NO expiresIn in the body.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/api-keys", { name: "Phone", userId: "u1" })
    );

    // One-time reveal dialog carries the raw key + a copy action.
    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "API key created",
          message: expect.stringContaining(RAW),
        })
      )
    );
    const dialog = (showAppDialog as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((d) => d.title === "API key created");
    dialog.buttons.find((b: any) => b.text === "Copy key").onPress();
    expect(setStringSpy).toHaveBeenCalledWith(RAW);

    // NEVER persisted: not in the user store snapshot, not rendered anywhere
    // on the screen; the name field reset for the next key.
    expect(JSON.stringify(useUserStore.getState())).not.toContain(RAW);
    expect(screen.queryByText(new RegExp(RAW))).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("API key name").props.value).toBe(""));
  });

  it("Copy key keeps the one-time reveal dialog open (only Done closes it) and snackbars", async () => {
    const RAW = "abs_supersecret_token_12345";
    (api.post as jest.Mock).mockResolvedValue({
      data: { apiKey: { id: "k9", name: "Phone", apiKey: RAW } },
    });
    // Render the REAL dialog host next to the screen: this test is about the
    // dialog staying visible after Copy, so the store spy alone isn't enough.
    const navigation = makeNavigation();
    await render(
      <>
        <AdminApiKeysScreen navigation={navigation} route={{ params: {} }} />
        <AppDialog />
      </>
    );
    await screen.findByText("CI key");

    fireEvent.changeText(screen.getByLabelText("API key name"), "Phone");
    await waitFor(() =>
      expect(screen.getByLabelText("API key name").props.value).toBe("Phone")
    );
    fireEvent.press(screen.getByLabelText("Create API key"));

    // The reveal dialog renders for real…
    expect(await screen.findByTestId("app-dialog-modal")).toBeTruthy();
    expect(screen.getByText("API key created")).toBeTruthy();

    // …and Copy does NOT dismiss it: the token exists only in this dialog.
    // (act-wrapped: a keep-open press causes no re-render, and the bare
    // fireEvent + follow-up dismiss press otherwise corrupts the async act
    // queue for later tests.)
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Copy key"));
    });

    expect(screen.getByTestId("app-dialog-modal")).toBeTruthy();
    expect(useDialogStore.getState().current).not.toBeNull();
    expect(setStringSpy).toHaveBeenCalledWith(RAW);
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Key copied" });

    // The explicit Done closes it.
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Done"));
    });
    expect(useDialogStore.getState().current).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("app-dialog-modal")).toBeNull());
  });

  it("sends the selected expiry preset as expiresIn seconds (default 30 days)", async () => {
    (api.post as jest.Mock).mockResolvedValue({
      data: { apiKey: { id: "k9", name: "Phone", apiKey: "raw" } },
    });
    await renderScreen();
    await screen.findByText("CI key");

    // Default chip is "30 days" — no chip press needed.
    fireEvent.changeText(screen.getByLabelText("API key name"), "Phone");
    await waitFor(() =>
      expect(screen.getByLabelText("API key name").props.value).toBe("Phone")
    );
    fireEvent.press(screen.getByLabelText("Create API key"));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/api-keys", {
        name: "Phone",
        userId: "u1",
        expiresIn: 30 * 24 * 60 * 60,
      })
    );
  });

  it("a create failure surfaces the server's reason in a dialog (no reveal)", async () => {
    (api.post as jest.Mock).mockRejectedValue(
      Object.assign(new Error("bad"), { response: { status: 500, data: "Invalid user" } })
    );
    await renderScreen();
    await screen.findByText("CI key");

    fireEvent.changeText(screen.getByLabelText("API key name"), "Phone");
    await waitFor(() =>
      expect(screen.getByLabelText("API key name").props.value).toBe("Phone")
    );
    fireEvent.press(screen.getByLabelText("Create API key"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't create the API key",
          message: "Invalid user",
        })
      )
    );
  });

  it("deletes a key only after the confirm dialog, then removes the row and snackbars", async () => {
    await renderScreen();
    await screen.findByText("CI key");

    fireEvent.press(screen.getByLabelText("Delete API key CI key"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled(); // nothing before the confirm

    const dialog = (showAppDialog as jest.Mock).mock.calls[0][0];
    expect(dialog.title).toBe("Delete API key");
    dialog.buttons.find((b: any) => b.text === "Delete").onPress();

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/api-keys/k1"));
    await waitFor(() => expect(screen.queryByText("CI key")).toBeNull());
    expect(showSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({ message: "API key deleted" })
    );
  });

  it("surfaces a delete failure as a dialog (not a snackbar) and keeps the row", async () => {
    (api.delete as jest.Mock).mockRejectedValue(
      Object.assign(new Error("nope"), { response: { status: 500, data: "Key in use" } })
    );
    await renderScreen();
    await screen.findByText("CI key");

    fireEvent.press(screen.getByLabelText("Delete API key CI key"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    (showAppDialog as jest.Mock).mock.calls[0][0].buttons
      .find((b: any) => b.text === "Delete")
      .onPress();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't delete the API key",
          message: "Key in use",
        })
      )
    );
    // Row stays; no success/failure snackbar for the failed delete.
    expect(screen.getByText("CI key")).toBeTruthy();
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it("renders the unsupported state (and never fetches) when the capability gate says the server is too old", async () => {
    useUserStore.setState({ serverConnectionConfig: { ...CONFIG, version: "2.20.0" } } as any);
    await renderScreen();

    expect(await screen.findByText("API keys aren't available")).toBeTruthy();
    expect(screen.getByText(/2\.26\.0 or newer — this server reports v2\.20\.0/)).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("renders the unsupported state when the route 404s despite the version claiming support", async () => {
    (api.get as jest.Mock).mockRejectedValue(
      Object.assign(new Error("missing"), { response: { status: 404 } })
    );
    await renderScreen();

    expect(await screen.findByText("API keys aren't available")).toBeTruthy();
  });

  it("offline fetch failure shows the offline error state and retry refetches", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();

    mockKeysList();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("CI key")).toBeTruthy();
  });

  it("a 403 shows the admin-access-required error state", async () => {
    (api.get as jest.Mock).mockRejectedValue(
      Object.assign(new Error("forbidden"), { response: { status: 403 } })
    );
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
  });

  it("shows the empty state when the server has no keys", async () => {
    mockKeysList([]);
    await renderScreen();

    expect(await screen.findByText("No API keys yet")).toBeTruthy();
  });

  describe("per-key enable/disable switch", () => {
    it("toggling PATCHes /api/api-keys/:id, syncs the Inactive subtitle, and keeps the joined user", async () => {
      // The PATCH echo has NO joined `user` object (only the list join does) —
      // the screen must merge it onto the previous row, not replace the row.
      (api.patch as jest.Mock).mockResolvedValue({
        data: {
          apiKey: { id: "k1", name: "CI key", expiresAt: null, isActive: false, userId: "u1" },
        },
      });
      await renderScreen();
      await screen.findByText("CI key");

      const sw = screen.getByLabelText("CI key active");
      expect(sw.props.accessibilityRole).toBe("switch");
      expect(sw.props.accessibilityState.checked).toBe(true);
      fireEvent.press(sw);

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith("/api/api-keys/k1", { isActive: false })
      );
      // Subtitle gains "Inactive" AND keeps "Acts as root" from the join.
      await waitFor(() =>
        expect(screen.getByText(/Inactive · Never expires · Acts as root/)).toBeTruthy()
      );
      expect(screen.getByLabelText("CI key active").props.accessibilityState.checked).toBe(false);
      expect(showSnackbar).toHaveBeenCalledWith({ message: "API key disabled" });
    });

    it("rolls the switch back with a failure dialog when the PATCH 500s", async () => {
      (api.patch as jest.Mock).mockRejectedValue(
        Object.assign(new Error("bad"), { response: { status: 500, data: "DB locked" } })
      );
      await renderScreen();
      await screen.findByText("CI key");

      fireEvent.press(screen.getByLabelText("CI key active"));

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Couldn't update the API key", message: "DB locked" })
        )
      );
      // Rolled back: still checked, no "Inactive" prefix on the CI key row.
      expect(screen.getByLabelText("CI key active").props.accessibilityState.checked).toBe(true);
      expect(screen.getByText(/^Never expires · Acts as root/)).toBeTruthy();
      expect(showSnackbar).not.toHaveBeenCalled();
    });

    it("ignores a second press while that key's PATCH is still in flight", async () => {
      let resolvePatch: (v: any) => void = () => {};
      (api.patch as jest.Mock).mockImplementation(
        () => new Promise((res) => (resolvePatch = res))
      );
      await renderScreen();
      await screen.findByText("CI key");

      fireEvent.press(screen.getByLabelText("CI key active"));
      await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
      // Second press while in flight: the guard swallows it, so it causes NO
      // re-render — act-wrapped, or the bare fireEvent corrupts the async act
      // queue for later tests (same failure mode as the Copy-key test).
      await act(async () => {
        fireEvent.press(screen.getByLabelText("CI key active"));
      });
      expect(api.patch).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolvePatch({ data: { apiKey: { id: "k1", isActive: false } } });
      });
      // The settled PATCH landed: the switch reflects the new value.
      await waitFor(() =>
        expect(screen.getByLabelText("CI key active").props.accessibilityState.checked).toBe(
          false
        )
      );
    });
  });

  describe("act-as-user picker", () => {
    it("loads users lazily (once) and the create POST carries the chosen userId", async () => {
      (api.post as jest.Mock).mockResolvedValue({
        data: { apiKey: { id: "k9", name: "Phone", apiKey: "raw" } },
      });
      await renderScreen();
      await screen.findByText("CI key");

      // Defaults to yourself.
      const row = screen.getByLabelText("Acts as, You");
      fireEvent.press(row);
      // Options come from GET /api/users; root users are tagged.
      expect(await screen.findByLabelText("bob")).toBeTruthy();
      expect(screen.getByLabelText("root (root)")).toBeTruthy();
      fireEvent.press(screen.getByLabelText("bob"));
      await waitFor(() => expect(screen.getByLabelText("Acts as, bob")).toBeTruthy());

      // Reopening does NOT refetch — the list is cached for the screen.
      fireEvent.press(screen.getByLabelText("Acts as, bob"));
      await screen.findByLabelText("root (root)");
      const userGets = (api.get as jest.Mock).mock.calls.filter((c) => c[0] === "/api/users");
      expect(userGets.length).toBe(1);
      // Reselecting the SAME user changes no state on select (only the close
      // does) — act-wrapped so the bare fireEvent can't corrupt the act queue.
      await act(async () => {
        fireEvent.press(screen.getByLabelText("bob")); // close via reselect
      });

      fireEvent.changeText(screen.getByLabelText("API key name"), "Phone");
      await waitFor(() =>
        expect(screen.getByLabelText("API key name").props.value).toBe("Phone")
      );
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Create API key"));
      });

      // Exact body: the CHOSEN user, default 30-day preset.
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith("/api/api-keys", {
          name: "Phone",
          userId: "u2",
          expiresIn: 30 * 24 * 60 * 60,
        })
      );
      // Settle the create continuation (list refresh + reveal dialog) inside
      // act so its trailing setStates don't corrupt the next test's queue.
      await act(async () => {
        await new Promise((r) => setImmediate(r));
      });
    });

    it("a non-root admin does not see OTHER root users in the picker (self stays)", async () => {
      useUserStore.setState({
        user: { id: "u3", username: "adminA", type: "admin", permissions: {} },
      } as any);
      await renderScreen();
      await screen.findByText("CI key");

      fireEvent.press(screen.getByLabelText("Acts as, You"));
      expect(await screen.findByLabelText("bob")).toBeTruthy();
      expect(screen.getByLabelText("adminA")).toBeTruthy();
      // The root user u1 is filtered out — no privilege escalation via keys.
      expect(screen.queryByLabelText("root (root)")).toBeNull();
    });

    it("a users fetch failure keeps the default (You) and shows a dialog", async () => {
      (api.get as jest.Mock).mockImplementation((url: string) => {
        if (url === "/api/api-keys") return Promise.resolve({ data: { apiKeys: KEYS } });
        if (url === "/api/users")
          return Promise.reject(
            Object.assign(new Error("bad"), { response: { status: 500, data: "boom" } })
          );
        return Promise.resolve({ data: {} });
      });
      await renderScreen();
      await screen.findByText("CI key");

      // The failed fetch leaves the screen unchanged (dialog only, and the
      // spy drives the real store with no host mounted) — act-wrapped press.
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Acts as, You"));
      });

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Couldn't load users" })
        )
      );
      expect(screen.getByLabelText("Acts as, You")).toBeTruthy();
    });
  });

  describe("custom expiry", () => {
    it("the Custom chip reveals the days input and 14 days POSTs expiresIn 1209600", async () => {
      (api.post as jest.Mock).mockResolvedValue({
        data: { apiKey: { id: "k9", name: "Phone", apiKey: "raw" } },
      });
      await renderScreen();
      await screen.findByText("CI key");

      // No days input until the Custom chip is active.
      expect(screen.queryByLabelText("Custom expiry in days")).toBeNull();
      fireEvent.press(screen.getByLabelText("Key expires: Custom…"));
      const daysInput = await screen.findByLabelText("Custom expiry in days");
      fireEvent.changeText(daysInput, "14");
      await waitFor(() =>
        expect(screen.getByLabelText("Custom expiry in days").props.value).toBe("14")
      );

      fireEvent.changeText(screen.getByLabelText("API key name"), "Phone");
      await waitFor(() =>
        expect(screen.getByLabelText("API key name").props.value).toBe("Phone")
      );
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Create API key"));
      });

      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith("/api/api-keys", {
          name: "Phone",
          userId: "u1",
          expiresIn: 14 * 86400, // 1209600
        })
      );
    });

    it("blocks invalid, zero, and empty custom expiries with a dialog and NO POST", async () => {
      await renderScreen();
      await screen.findByText("CI key");

      fireEvent.press(screen.getByLabelText("Key expires: Custom…"));
      await screen.findByLabelText("Custom expiry in days");
      fireEvent.changeText(screen.getByLabelText("API key name"), "Phone");
      await waitFor(() =>
        expect(screen.getByLabelText("API key name").props.value).toBe("Phone")
      );

      for (const bad of ["", "0", "abc", "1.5"]) {
        // act-wrapped: "" → "" changes nothing, and a BLOCKED create only
        // shows a dialog (no re-render) — bare fireEvents here poison the
        // async act queue for the rest of the suite.
        await act(async () => {
          fireEvent.changeText(screen.getByLabelText("Custom expiry in days"), bad);
        });
        await act(async () => {
          fireEvent.press(screen.getByLabelText("Create API key"));
        });
        await waitFor(() =>
          expect(showAppDialog).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Invalid expiry" })
          )
        );
        (showAppDialog as jest.Mock).mockClear();
      }
      expect(api.post).not.toHaveBeenCalled();
    });
  });
});
