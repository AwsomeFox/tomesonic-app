/**
 * AccountScreen — read-only host/username/server-version fields, Stats link,
 * Switch Server/User (logout) flow, and the change-password modal.
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
import { Alert, Linking } from "react-native";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import AccountScreen from "../../screens/AccountScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { storage, storageHelper } from "../../utils/storage";

const initialUser = useUserStore.getState();
const initialPlayback = usePlaybackStore.getState();

const CONFIG = {
  address: "https://abs.example.com",
  username: "tony",
  userId: "u1",
  token: "tok",
  version: "v2.19.0",
};

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderAccount() {
  const navigation = makeNavigation();
  await render(<AccountScreen navigation={navigation} />);
  return navigation;
}

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUserStore.setState({
    user: { id: "u1", username: "tony" },
    serverConnectionConfig: CONFIG,
  } as any);
  storageHelper.setServerConfig(CONFIG);
  alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  (api.post as jest.Mock).mockResolvedValue({ data: {} });
  (api.patch as jest.Mock).mockResolvedValue({ data: {} });
});

afterEach(() => {
  alertSpy.mockRestore();
  storage.getAllKeys().forEach((k) => storage.remove(k));
});

describe("AccountScreen", () => {
  it("renders host, username and server version", async () => {
    await renderAccount();

    expect(screen.getByText("Host")).toBeTruthy();
    expect(screen.getByText("https://abs.example.com")).toBeTruthy();
    expect(screen.getByText("Username")).toBeTruthy();
    expect(screen.getByText("tony")).toBeTruthy();
    // "v" prefix is normalized: config carries "v2.19.0", the field re-adds it once.
    expect(screen.getByText("Server version: v2.19.0")).toBeTruthy();
  });

  it("navigates to Stats and back", async () => {
    const navigation = await renderAccount();

    await fireEvent.press(screen.getByText("User Stats"));
    expect(navigation.navigate).toHaveBeenCalledWith("Stats");

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("opens the GitHub footer link", async () => {
    const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as any);
    await renderAccount();

    await fireEvent.press(screen.getByText(/Report bugs, request features/));
    expect(openSpy).toHaveBeenCalledWith("https://github.com/AwsomeFox/tomesonic-app");
  });

  it("Switch Server/User confirms, then logout clears the user store and stored config", async () => {
    await renderAccount();

    await fireEvent.press(screen.getByText("Switch Server/User"));
    expect(alertSpy).toHaveBeenCalledWith(
      "Switch Server / User",
      // The body must name the real data-loss consequence: logout wipes all
      // downloaded books, not just the session.
      expect.stringMatching(/deletes all downloaded books/i),
      expect.any(Array)
    );
    expect(alertSpy.mock.calls[0][1]).toMatch(/re-download/i);

    const buttons = alertSpy.mock.calls[0][2];
    const logOutBtn = buttons.find((b: any) => b.text === "Log Out");
    expect(logOutBtn).toBeTruthy();
    // Cancel button must not log out.
    expect(buttons.find((b: any) => b.text === "Cancel")).toBeTruthy();

    await act(async () => {
      logOutBtn.onPress();
    });

    expect(api.post).toHaveBeenCalledWith("/logout");
    expect(useUserStore.getState().user).toBeNull();
    expect(useUserStore.getState().serverConnectionConfig).toBeNull();
    expect(useUserStore.getState().mediaProgress).toEqual({});
    expect(storageHelper.getServerConfig()).toBeNull();
  });

  it("shows the Change Password row for a local (password) account", async () => {
    // Default CONFIG carries no openid signal → treated as a local account.
    await renderAccount();
    expect(screen.getByLabelText("Change Password")).toBeTruthy();
  });

  it("hides the Change Password row for an OpenID/SSO session", async () => {
    useUserStore.setState({
      serverConnectionConfig: { ...CONFIG, authMethod: "openid" },
    } as any);
    await renderAccount();
    expect(screen.queryByLabelText("Change Password")).toBeNull();
  });

  it("change password validates empty and mismatched fields", async () => {
    await renderAccount();

    await fireEvent.press(screen.getByText("Change Password"));
    // Modal is open now: three blank secure inputs in tree order
    // (current / new / confirm).
    const inputs = screen.getAllByDisplayValue("");
    expect(inputs).toHaveLength(3);

    // All empty -> error.
    await fireEvent.press(screen.getByText("Save"));
    expect(alertSpy).toHaveBeenCalledWith("Error", "Please fill in all fields.");

    // Mismatch -> error, no PATCH.
    await fireEvent.changeText(inputs[0], "oldpass");
    await fireEvent.changeText(inputs[1], "newpass");
    await fireEvent.changeText(inputs[2], "different");
    await fireEvent.press(screen.getByText("Save"));
    expect(alertSpy).toHaveBeenCalledWith("Error", "New passwords do not match.");
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("change password PATCHes the server and clears fields on success", async () => {
    await renderAccount();

    await fireEvent.press(screen.getByText("Change Password"));
    const inputs = screen.getAllByDisplayValue("");
    await fireEvent.changeText(inputs[0], "oldpass");
    await fireEvent.changeText(inputs[1], "newpass");
    await fireEvent.changeText(inputs[2], "newpass");

    await fireEvent.press(screen.getByText("Save"));
    await act(async () => {});

    expect(api.patch).toHaveBeenCalledWith("/api/me/password", {
      password: "oldpass",
      newPassword: "newpass",
    });
    expect(alertSpy).toHaveBeenCalledWith("Success", "Password changed successfully!");
    // Modal closed -> inputs are gone (typed passwords not retained).
    expect(screen.queryByDisplayValue("oldpass")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("change password surfaces a server error message", async () => {
    (api.patch as jest.Mock).mockRejectedValue({
      response: { status: 401, data: "Invalid password" },
    });
    await renderAccount();

    await fireEvent.press(screen.getByText("Change Password"));
    const inputs = screen.getAllByDisplayValue("");
    await fireEvent.changeText(inputs[0], "wrong");
    await fireEvent.changeText(inputs[1], "newpass");
    await fireEvent.changeText(inputs[2], "newpass");

    await fireEvent.press(screen.getByText("Save"));
    await act(async () => {});

    expect(alertSpy).toHaveBeenCalledWith("Error", "Invalid password");
    // Modal stays open for another attempt.
    expect(screen.getByDisplayValue("wrong")).toBeTruthy();
    expect(screen.getByText("Save")).toBeTruthy();
  });

  it("exposes accessible roles and grouped labels for TalkBack", async () => {
    await renderAccount();

    // Read-only fields are grouped so the label and value read as one item.
    expect(screen.getByLabelText("Host: https://abs.example.com")).toBeTruthy();
    expect(screen.getByLabelText("Username: tony")).toBeTruthy();

    // Interactive rows carry button/link roles with explicit labels.
    const changePw = screen.getByLabelText("Change Password");
    expect(changePw.props.accessibilityRole).toBe("button");
    const stats = screen.getByLabelText("User Stats");
    expect(stats.props.accessibilityRole).toBe("button");
    const switchUser = screen.getByLabelText("Switch server or user");
    expect(switchUser.props.accessibilityRole).toBe("button");
    const github = screen.getByLabelText(/contribute on GitHub/);
    expect(github.props.accessibilityRole).toBe("link");
  });

  it("edits the server address in place via updateServerAddress", async () => {
    const updateServerAddress = jest.fn().mockResolvedValue({ ok: true });
    useUserStore.setState({ updateServerAddress } as any);
    await renderAccount();

    await fireEvent.press(screen.getByLabelText("Edit server address"));
    // The field seeds with the current address; change it and save.
    const input = screen.getByLabelText("Server address");
    await fireEvent.changeText(input, "https://moved.example.com");
    await fireEvent.press(screen.getByLabelText("Save server address"));

    await waitFor(() =>
      expect(updateServerAddress).toHaveBeenCalledWith("https://moved.example.com")
    );
    // Success closes the modal and reassures the user their data is kept.
    expect(alertSpy).toHaveBeenCalledWith("Server updated", expect.stringContaining("unchanged"));
  });

  it("surfaces an error when the in-place address change fails", async () => {
    const updateServerAddress = jest.fn().mockResolvedValue({ ok: false, error: "Couldn't reach that server." });
    useUserStore.setState({ updateServerAddress } as any);
    await renderAccount();

    await fireEvent.press(screen.getByLabelText("Edit server address"));
    await fireEvent.changeText(screen.getByLabelText("Server address"), "https://bad.example.com");
    await fireEvent.press(screen.getByLabelText("Save server address"));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("Couldn't update server", "Couldn't reach that server.")
    );
  });

  it("labels the change-password inputs for screen readers", async () => {
    await renderAccount();
    await fireEvent.press(screen.getByLabelText("Change Password"));

    expect(screen.getByLabelText("Current Password")).toBeTruthy();
    expect(screen.getByLabelText("New Password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm New Password")).toBeTruthy();
  });

  it("cancel closes the modal and drops typed passwords", async () => {
    await renderAccount();

    await fireEvent.press(screen.getByText("Change Password"));
    const inputs = screen.getAllByDisplayValue("");
    await fireEvent.changeText(inputs[0], "secret");
    expect(screen.getByDisplayValue("secret")).toBeTruthy();

    await fireEvent.press(screen.getByText("Cancel"));
    expect(screen.queryByDisplayValue("secret")).toBeNull();

    // Re-open: fields start blank again.
    await fireEvent.press(screen.getByText("Change Password"));
    expect(screen.getAllByDisplayValue("")).toHaveLength(3);
    expect(screen.queryByDisplayValue("secret")).toBeNull();
  });
});
