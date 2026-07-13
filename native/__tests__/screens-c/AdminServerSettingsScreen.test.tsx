/**
 * AdminServerSettingsScreen — immediate-save server-settings toggles seeded
 * from useUserStore.serverSettings, re-seeded via POST /api/authorize on every
 * focus (staleness mitigation), PATCHing exactly one key per flip with an
 * optimistic flip that ROLLS BACK (plus a failure snackbar) when the PATCH is
 * rejected.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useSnackbarStore", () => ({
  showSnackbar: jest.fn(),
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));

import React from "react";
import { useReducedMotion } from "react-native-reanimated";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import AdminServerSettingsScreen from "../../screens/AdminServerSettingsScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { useUserStore } from "../../store/useUserStore";

const initialUserState = useUserStore.getState();

const ADMIN = { id: "u1", username: "root", type: "root", permissions: {} };
const CONFIG = {
  address: "https://abs.example.com",
  token: "tok",
  userId: "u1",
  username: "root",
  version: "2.35.1",
};
// The server settings blob as /api/authorize (and the PATCH echo) return it.
const SETTINGS = {
  id: "server-settings",
  scannerParseSubtitle: false,
  scannerFindCovers: false,
  scannerPreferMatchedMetadata: false,
  scannerDisableWatcher: true, // watcher OFF → "Watch for file changes" renders unchecked
  storeCoverWithItem: true,
  storeMetadataWithItem: false,
  sortingIgnorePrefix: true,
  chromecastEnabled: false,
  version: "2.35.1",
};

function mockAuthorize(serverSettings: any = { ...SETTINGS }) {
  (api.post as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/authorize")
      return Promise.resolve({ data: { user: ADMIN, serverSettings } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminServerSettingsScreen navigation={navigation} route={{ params: {} }} />);
  // Settle the mount seed (refreshCapabilities + optional error re-probe) inside
  // act so its trailing setState (setSeeding(false), etc.) lands during the test
  // rather than as a floating update that fires during the next test's cleanup.
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
  return navigation;
}

beforeEach(() => {
  // Snap the picker sheets open/closed (BottomSheet honors reduced motion):
  // their 160–280ms close-animation end-callbacks otherwise setState mid-way
  // through the NEXT test and corrupt its act queue.
  (useReducedMotion as jest.Mock).mockReturnValue(true);
  useUserStore.setState(initialUserState, true);
  useUserStore.setState({
    user: ADMIN,
    serverConnectionConfig: CONFIG,
    serverSettings: { ...SETTINGS },
  } as any);
  mockAuthorize();
  // PATCH /api/settings echoes the FULL updated blob (server behavior).
  (api.patch as jest.Mock).mockImplementation((url: string, body: any) => {
    if (url === "/api/settings")
      return Promise.resolve({ data: { serverSettings: { ...SETTINGS, ...body } } });
    return Promise.resolve({ data: {} });
  });
});

// Settle trailing async continuations (PATCH echoes) INSIDE act before RNTL
// cleanup unmounts — a leaked update otherwise corrupts the async act queue
// for the next test.
afterEach(async () => {
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
});

describe("AdminServerSettingsScreen", () => {
  it("seeds toggles + version from the store settings and refreshes capabilities on mount", async () => {
    await renderScreen();

    const findCovers = await screen.findByLabelText(/^Find covers/);
    expect(findCovers.props.accessibilityRole).toBe("switch");
    expect(findCovers.props.accessibilityState.checked).toBe(false);
    expect(
      screen.getByLabelText(/^Store covers with item/).props.accessibilityState.checked
    ).toBe(true);
    expect(
      screen.getByLabelText(/^Ignore prefixes when sorting/).props.accessibilityState.checked
    ).toBe(true);
    // Inverted mapping: scannerDisableWatcher=true means the watcher is OFF.
    expect(
      screen.getByLabelText(/^Watch for file changes/).props.accessibilityState.checked
    ).toBe(false);
    // Version row from the settings blob.
    expect(screen.getByText("Server version")).toBeTruthy();
    expect(screen.getByText("2.35.1")).toBeTruthy();
    // Staleness mitigation: a capabilities refresh fired on mount.
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/authorize"));
  });

  it("re-seeds from the server when the screen regains focus (risk 2: settings staleness)", async () => {
    const navigation = await renderScreen();
    await screen.findByLabelText(/^Find covers/);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));

    // Another admin flipped scannerFindCovers on the web dashboard meanwhile.
    mockAuthorize({ ...SETTINGS, scannerFindCovers: true });
    const focusCall = (navigation.addListener as jest.Mock).mock.calls.find(
      (c: any[]) => c[0] === "focus"
    );
    expect(focusCall).toBeTruthy();
    await act(async () => {
      await focusCall[1]();
    });

    expect(api.post).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.getByLabelText(/^Find covers/).props.accessibilityState.checked).toBe(true)
    );
  });

  // Load-error states run before the mutation tests: those hold pending PATCH
  // promises whose late settlement can otherwise destabilize a subsequent
  // error-state mount in this suite.
  it("shows the OFFLINE error state (distinguished by kind) with a working retry", async () => {
    useUserStore.setState({ serverSettings: null } as any);
    (api.post as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response
    await renderScreen();

    // The kind-aware mapper reads offline as offline, not a generic "couldn't load".
    expect(await screen.findByText("You're offline")).toBeTruthy();

    // Connectivity returns → retry hydrates and renders the toggles.
    mockAuthorize();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByLabelText(/^Find covers/)).toBeTruthy();
    // Settle the retry seed's trailing setState before the test unmounts.
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  });

  it("distinguishes a 403 as the admin-access error state (not the offline copy)", async () => {
    useUserStore.setState({ serverSettings: null } as any);
    (api.post as jest.Mock).mockRejectedValue(
      Object.assign(new Error("nope"), { response: { status: 403 } })
    );
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it("flipping a toggle PATCHes exactly that key and keeps the flip on success", async () => {
    await renderScreen();
    fireEvent.press(await screen.findByLabelText(/^Find covers/));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/settings", { scannerFindCovers: true })
    );
    expect(api.patch).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByLabelText(/^Find covers/).props.accessibilityState.checked).toBe(true)
    );
    // The PATCH echo landed in the store (the single source of truth).
    expect(useUserStore.getState().serverSettings.scannerFindCovers).toBe(true);
  });

  it("the inverted watcher toggle PATCHes the NEGATED stored key", async () => {
    await renderScreen();
    // Displayed OFF (scannerDisableWatcher: true) → turning it ON must send
    // scannerDisableWatcher: false.
    fireEvent.press(await screen.findByLabelText(/^Watch for file changes/));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/settings", { scannerDisableWatcher: false })
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText(/^Watch for file changes/).props.accessibilityState.checked
      ).toBe(true)
    );
  });

  it("rolls the toggle back and snackbars on a 403 PATCH rejection", async () => {
    (api.patch as jest.Mock).mockRejectedValue(
      Object.assign(new Error("nope"), { response: { status: 403 } })
    );
    await renderScreen();
    fireEvent.press(await screen.findByLabelText(/^Find covers/));

    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("permission") })
      )
    );
    // Rolled back to the seeded value; nothing leaked into the store.
    expect(screen.getByLabelText(/^Find covers/).props.accessibilityState.checked).toBe(false);
    expect(useUserStore.getState().serverSettings.scannerFindCovers).toBe(false);
  });

  it("rolls back and shows the offline snackbar when the PATCH never reaches the server", async () => {
    (api.patch as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response
    await renderScreen();
    fireEvent.press(await screen.findByLabelText(/^Find covers/));

    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Can't reach the server") })
      )
    );
    expect(screen.getByLabelText(/^Find covers/).props.accessibilityState.checked).toBe(false);
  });

  it("ignores a second tap while that key's PATCH is still in flight", async () => {
    let resolvePatch: (v: any) => void = () => {};
    (api.patch as jest.Mock).mockImplementation(
      () => new Promise((res) => (resolvePatch = res))
    );
    await renderScreen();
    const row = await screen.findByLabelText(/^Find covers/);

    // Both presses act-wrapped: the first returns handleToggle's PENDING
    // promise (fireEvent would hand React an async act nobody awaits), the
    // second is guard-swallowed with no re-render — either leak corrupts the
    // async act queue for the tests that now run after this one.
    await act(async () => {
      fireEvent.press(row);
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText(/^Find covers/));
    });
    expect(api.patch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePatch({ data: { serverSettings: { ...SETTINGS, scannerFindCovers: true } } });
    });
  });

  describe("localization selects", () => {
    it("selecting a date format PATCHes EXACTLY that single key and the echo updates the subtitle", async () => {
      await renderScreen();

      // Blob predates the key → the server-default subtitle renders.
      await fireEvent.press(await screen.findByLabelText("Date format, MM/dd/yyyy"));
      // Selecting fires handleSelect as a FLOATING async continuation —
      // act-wrapped so the bare fireEvent can't corrupt the act queue.
      const option = await screen.findByLabelText("yyyy-MM-dd");
      await act(async () => {
        fireEvent.press(option);
        // Drain the PATCH continuation (a multi-tick promise chain ending in
        // a zustand store write) INSIDE act — setImmediate runs after all
        // pending microtasks.
        await new Promise((r) => setImmediate(r));
      });

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith("/api/settings", { dateFormat: "yyyy-MM-dd" })
      );
      // Single-key clobber tripwire: nothing else may ride along.
      expect(api.patch).toHaveBeenCalledTimes(1);
      expect(Object.keys((api.patch as jest.Mock).mock.calls[0][1])).toEqual(["dateFormat"]);

      // The PATCH echo landed in the store and re-rendered the subtitle.
      await waitFor(() => expect(screen.getByLabelText("Date format, yyyy-MM-dd")).toBeTruthy());
      expect(useUserStore.getState().serverSettings.dateFormat).toBe("yyyy-MM-dd");
    });

    it("renders time format / language subtitles as labels, not raw values", async () => {
      useUserStore.setState({
        serverSettings: { ...SETTINGS, timeFormat: "h:mma", language: "de" },
      } as any);
      mockAuthorize({ ...SETTINGS, timeFormat: "h:mma", language: "de" });
      await renderScreen();

      expect(await screen.findByLabelText("Time format, 12-hour")).toBeTruthy();
      expect(screen.getByLabelText("Language, Deutsch")).toBeTruthy();
    });

    it("a rejected select rolls the subtitle back and snackbars", async () => {
      (api.patch as jest.Mock).mockRejectedValue(
        Object.assign(new Error("nope"), { response: { status: 403 } })
      );
      await renderScreen();

      await fireEvent.press(await screen.findByLabelText("Date format, MM/dd/yyyy"));
      const option = await screen.findByLabelText("yyyy-MM-dd");
      await act(async () => {
        fireEvent.press(option);
      });

      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("permission") })
        )
      );
      // Rolled back to the store value; nothing leaked into the store.
      expect(screen.getByLabelText("Date format, MM/dd/yyyy")).toBeTruthy();
      expect(useUserStore.getState().serverSettings.dateFormat).toBeUndefined();
    });
  });

  describe("sorting-prefixes editor", () => {
    it("add/remove chips then Save PATCHes exactly the trimmed/lowercased/deduped list", async () => {
      useUserStore.setState({
        serverSettings: { ...SETTINGS, sortingPrefixes: ["the", "a"] },
      } as any);
      // The focus/mount re-seed must not clobber the prefixes away.
      mockAuthorize({ ...SETTINGS, sortingPrefixes: ["the", "a"] });
      (api.patch as jest.Mock).mockImplementation((url: string, body: any) => {
        if (url === "/api/settings")
          return Promise.resolve({
            data: { serverSettings: { ...SETTINGS, sortingPrefixes: ["the", "a"], ...body } },
          });
        return Promise.resolve({ data: {} });
      });
      await renderScreen();

      await fireEvent.press(await screen.findByLabelText("Sorting prefixes, the, a"));
      await screen.findByLabelText("New sorting prefix");

      // "The " → trimmed + lowercased → dupe of "the" → NOT added twice.
      await fireEvent.changeText(screen.getByLabelText("New sorting prefix"), "The ");
      await waitFor(() =>
        expect(screen.getByLabelText("New sorting prefix").props.value).toBe("The ")
      );
      await fireEvent.press(screen.getByLabelText("Add prefix"));
      // "El" → lowercased new entry.
      await fireEvent.changeText(screen.getByLabelText("New sorting prefix"), "El");
      await waitFor(() =>
        expect(screen.getByLabelText("New sorting prefix").props.value).toBe("El")
      );
      await fireEvent.press(screen.getByLabelText("Add prefix"));
      await screen.findByLabelText("Remove prefix el");
      // Chip tap removes.
      await fireEvent.press(screen.getByLabelText("Remove prefix a"));
      await waitFor(() => expect(screen.queryByLabelText("Remove prefix a")).toBeNull());

      await act(async () => {
        fireEvent.press(screen.getByLabelText("Save sorting prefixes"));
      });

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith("/api/settings", {
          sortingPrefixes: ["the", "el"],
        })
      );
      expect(api.patch).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith({ message: "Sorting prefixes saved" })
      );
      // Echo re-rendered the row subtitle and the modal closed.
      await waitFor(() =>
        expect(screen.getByLabelText("Sorting prefixes, the, el")).toBeTruthy()
      );
      await waitFor(() => expect(screen.queryByLabelText("Save sorting prefixes")).toBeNull());
    });

    it("blocks saving an EMPTY prefix list with a dialog before any PATCH (server ignores [])", async () => {
      useUserStore.setState({
        serverSettings: { ...SETTINGS, sortingPrefixes: ["the"] },
      } as any);
      mockAuthorize({ ...SETTINGS, sortingPrefixes: ["the"] });
      await renderScreen();

      await fireEvent.press(await screen.findByLabelText("Sorting prefixes, the"));
      await screen.findByLabelText("Remove prefix the");
      await fireEvent.press(screen.getByLabelText("Remove prefix the"));
      await waitFor(() => expect(screen.queryByLabelText("Remove prefix the")).toBeNull());

      // A BLOCKED save shows only a dialog (no re-render) — act-wrapped.
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Save sorting prefixes"));
      });

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "At least one prefix required" })
        )
      );
      expect(api.patch).not.toHaveBeenCalled();
      // The editor stays open so the admin can add a prefix instead.
      expect(screen.getByLabelText("Save sorting prefixes")).toBeTruthy();
    });
  });
});
