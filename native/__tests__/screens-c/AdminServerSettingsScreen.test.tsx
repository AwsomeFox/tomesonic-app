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

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import AdminServerSettingsScreen from "../../screens/AdminServerSettingsScreen";
import { api } from "../../utils/api";
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
  return navigation;
}

beforeEach(() => {
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

    fireEvent.press(row);
    fireEvent.press(row);
    expect(api.patch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePatch({ data: { serverSettings: { ...SETTINGS, scannerFindCovers: true } } });
    });
  });

  it("shows an error state with a working retry when no settings can be loaded", async () => {
    useUserStore.setState({ serverSettings: null } as any);
    (api.post as jest.Mock).mockRejectedValue(new Error("Network Error"));
    await renderScreen();

    expect(await screen.findByText("Couldn't load server settings")).toBeTruthy();

    // Connectivity returns → retry hydrates and renders the toggles.
    mockAuthorize();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByLabelText(/^Find covers/)).toBeTruthy();
  });
});
