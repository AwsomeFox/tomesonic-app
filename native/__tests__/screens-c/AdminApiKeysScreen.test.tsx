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
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));
jest.mock("../../store/useSnackbarStore", () => ({
  showSnackbar: jest.fn(),
}));

import React from "react";
import { Clipboard } from "react-native";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import AdminApiKeysScreen from "../../screens/AdminApiKeysScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
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

function mockKeysList(apiKeys: any[] = KEYS) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/api-keys") return Promise.resolve({ data: { apiKeys } });
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
  mockKeysList();
  (api.delete as jest.Mock).mockResolvedValue({ data: {} });
  setStringSpy = jest.spyOn(Clipboard, "setString").mockImplementation(() => {});
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
      expect.objectContaining({ message: "API key deleted." })
    );
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
});
