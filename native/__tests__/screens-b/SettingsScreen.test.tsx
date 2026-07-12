/**
 * SettingsScreen — every toggle flips + persists to useUserStore settings
 * (and through storageHelper into MMKV), pickers select values, nav rows
 * navigate, GitHub row opens the browser.
 */
// The setup-file safe-area mock returns the module record instead of its
// default export, leaving SafeAreaView undefined — unwrap it here.
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);
// See theme.test.tsx: the setup-file reanimated mock is broken under
// reanimated v4, so screens-b files override it locally.
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

// Real utils/rmab except getRmabAuthProviders — the SSO probe must be
// controllable while rmabOrigin (which drives the gating) stays genuine.
jest.mock("../../utils/rmab", () => {
  const actual = jest.requireActual("../../utils/rmab");
  return { ...actual, getRmabAuthProviders: jest.fn() };
});

import React from "react";
import { Linking } from "react-native";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import SettingsScreen from "../../screens/SettingsScreen";
import { getRmabAuthProviders } from "../../utils/rmab";
import { useUserStore } from "../../store/useUserStore";
import { useThemeStore } from "../../store/useThemeStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useRmabStore } from "../../store/useRmabStore";
import { storage, storageHelper } from "../../utils/storage";

// The screen shows the INSTALLED package version (expo-application), falling
// back to app.json — mirror that here.
const APP_VERSION =
  require("expo-application").nativeApplicationVersion ||
  require("../../app.json").expo.version;

const initialUser = useUserStore.getState();
const initialTheme = useThemeStore.getState();
const initialPlayback = usePlaybackStore.getState();

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderSettings() {
  const navigation = makeNavigation();
  await render(<SettingsScreen navigation={navigation} />);
  return navigation;
}

const initialRmab = useRmabStore.getState();

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useRmabStore.setState(initialRmab, true);
  useThemeStore.setState(initialTheme, true);
  usePlaybackStore.setState(initialPlayback, true);
  storage.remove("userSettings");
  storage.remove("themeMode");
  storage.remove("useDynamicColors");
});

describe("SettingsScreen", () => {
  it("shows account info, app version, and section headers", async () => {
    useUserStore.setState({
      user: { id: "u1", username: "tony" },
      serverConnectionConfig: { address: "https://abs.example.com", token: "t" },
    } as any);
    await renderSettings();

    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByText("https://abs.example.com")).toBeTruthy();
    expect(screen.getByText("tony")).toBeTruthy();
    expect(screen.getByText(APP_VERSION)).toBeTruthy();
    expect(screen.getByText("User Interface Settings")).toBeTruthy();
    expect(screen.getByText("Playback Settings")).toBeTruthy();
  });

  it.each([
    ["Lock orientation", "lockOrientation", true, false] as const,
    ["Hide non-audiobooks globally", "hideNonAudiobooksGlobal", false, true] as const,
    ["Show Discover tab before connecting", "showDiscoverWhenDisconnected", true, false] as const,
    ["Disable auto rewind", "disableAutoRewind", false, true] as const,
    ["Auto-download next in series", "autoDownloadNextInSeries", false, true] as const,
    ["Show book progress bar", "showPlayerBookProgress", true, false] as const,
    ["Show chapter progress bar", "showPlayerChapterProgress", true, false] as const,
  ])("toggle '%s' flips settings.%s and persists it", async (label, key, initial, flipped) => {
    await renderSettings();

    const row = screen.getByLabelText(new RegExp(`^${label}`));
    expect((useUserStore.getState().settings as any)[key]).toBe(initial);

    await fireEvent.press(row);
    expect((useUserStore.getState().settings as any)[key]).toBe(flipped);
    expect(JSON.parse(storage.getString("userSettings")!)[key]).toBe(flipped);

    await fireEvent.press(row);
    expect((useUserStore.getState().settings as any)[key]).toBe(initial);
    expect(JSON.parse(storage.getString("userSettings")!)[key]).toBe(initial);
  });

  it("jump forward picker persists the chosen interval", async () => {
    await renderSettings();

    await fireEvent.press(screen.getByLabelText(/^Jump forwards time/));
    // Picker sheet lists 5/10/15/30/45/60 second radios.
    await fireEvent.press(screen.getByLabelText("30s"));

    expect(useUserStore.getState().settings.jumpForwardTime).toBe(30);
    expect(JSON.parse(storage.getString("userSettings")!).jumpForwardTime).toBe(30);
    // Row subtitle reflects the new value.
    expect(screen.getByLabelText("Jump forwards time, 30s")).toBeTruthy();
  });

  it("jump backward picker persists the chosen interval", async () => {
    await renderSettings();

    await fireEvent.press(screen.getByLabelText(/^Jump backwards time/));
    await fireEvent.press(screen.getByLabelText("45s"));

    expect(useUserStore.getState().settings.jumpBackwardTime).toBe(45);
    expect(JSON.parse(storage.getString("userSettings")!).jumpBackwardTime).toBe(45);
  });

  it("haptic feedback picker persists the chosen level", async () => {
    await renderSettings();

    expect(screen.getByLabelText("Haptic feedback, Medium")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText(/^Haptic feedback/));
    await fireEvent.press(screen.getByLabelText("Heavy"));

    expect(useUserStore.getState().settings.hapticFeedback).toBe("heavy");
    expect(screen.getByLabelText("Haptic feedback, Heavy")).toBeTruthy();
  });

  it("theme picker updates the theme store and persists the mode", async () => {
    await renderSettings();

    await fireEvent.press(screen.getByLabelText(/^Theme/));
    await fireEvent.press(screen.getByLabelText("Dark"));

    expect(useThemeStore.getState().mode).toBe("dark");
    expect(storageHelper.getThemeMode()).toBe("dark");
  });

  it("dynamic colors toggle flips the theme store flag", async () => {
    await renderSettings();

    expect(useThemeStore.getState().useDynamicColors).toBe(true);
    await fireEvent.press(screen.getByLabelText(/^Use Dynamic Colors/));
    expect(useThemeStore.getState().useDynamicColors).toBe(false);
    expect(storageHelper.getUseDynamicColors()).toBe(false);
  });

  it("nav rows route to their screens and back button goes back", async () => {
    const navigation = await renderSettings();

    await fireEvent.press(screen.getByLabelText("Downloads"));
    expect(navigation.navigate).toHaveBeenCalledWith("Downloads");

    await fireEvent.press(screen.getByLabelText("Listening History"));
    expect(navigation.navigate).toHaveBeenCalledWith("ListeningHistory");

    await fireEvent.press(screen.getByLabelText("Logs"));
    expect(navigation.navigate).toHaveBeenCalledWith("Logs");

    await fireEvent.press(screen.getByLabelText(/^Server/));
    expect(navigation.navigate).toHaveBeenCalledWith("Account");

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("GitHub row opens the repo URL", async () => {
    const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as any);
    await renderSettings();

    await fireEvent.press(screen.getByLabelText(/^GitHub/));
    expect(openSpy).toHaveBeenCalledWith("https://github.com/AwsomeFox/tomesonic-app");
  });

  describe("ReadMeABook section", () => {
    it("offers Connect when unconfigured and hides request rows", async () => {
      await renderSettings();
      expect(screen.getByText("Connect ReadMeABook")).toBeTruthy();
      expect(screen.queryByText("My Requests")).toBeNull();
      expect(screen.queryByText("Disconnect")).toBeNull();
    });

    it("shows server/account/requests/disconnect once connected", async () => {
      useRmabStore.setState({
        configured: true,
        serverUrl: "https://rmab.test",
        username: "tony",
      } as any);
      await renderSettings();
      expect(screen.getByText("https://rmab.test")).toBeTruthy();
      expect(screen.getByText("tony")).toBeTruthy();
      expect(screen.getByText("My Requests")).toBeTruthy();
      expect(screen.getByText("Disconnect")).toBeTruthy();
      expect(screen.queryByText("Connect ReadMeABook")).toBeNull();
    });
  });

  describe("ReadMeABook SSO button gating", () => {
    // Open the connect sheet and type an address into the server field.
    async function openSheetWithUrl(url: string) {
      await renderSettings();
      await fireEvent.press(screen.getByLabelText(/^Connect ReadMeABook/));
      await fireEvent.changeText(
        screen.getByLabelText("ReadMeABook server address"),
        url
      );
    }

    it("shows SSO while providers are still UNKNOWN (null) — never hidden on a transient blip", async () => {
      // A null probe result must leave the button shown by default.
      (getRmabAuthProviders as jest.Mock).mockResolvedValue(null);
      await openSheetWithUrl("https://rmab.test");
      expect(await screen.findByLabelText("Sign in with SSO")).toBeTruthy();
      // Default label until a provider name is known.
      expect(screen.getByText("Sign in with SSO")).toBeTruthy();
    });

    it("shows SSO labeled with the provider name once OIDC is confirmed enabled", async () => {
      (getRmabAuthProviders as jest.Mock).mockResolvedValue({
        oidcEnabled: true,
        oidcProviderName: "Authentik",
      });
      await openSheetWithUrl("https://rmab.test");
      // The debounced probe resolves and interpolates the provider name.
      await waitFor(() => expect(screen.getByText("Sign in with Authentik")).toBeTruthy());
      expect(screen.getByLabelText("Sign in with SSO")).toBeTruthy();
    });

    it("hides SSO once OIDC is affirmatively OFF", async () => {
      (getRmabAuthProviders as jest.Mock).mockResolvedValue({
        oidcEnabled: false,
        oidcProviderName: null,
      });
      await openSheetWithUrl("https://rmab.test");
      await waitFor(() => expect(screen.queryByLabelText("Sign in with SSO")).toBeNull());
    });

    it("does NOT show SSO for a bare rmab_ API token that isn't an origin", async () => {
      (getRmabAuthProviders as jest.Mock).mockResolvedValue({ oidcEnabled: true });
      await renderSettings();
      await fireEvent.press(screen.getByLabelText(/^Connect ReadMeABook/));
      // Switch to the API-key tab and enter a raw token (server left empty):
      // no origin can be derived, so the SSO button must stay hidden and the
      // probe must not fire.
      await fireEvent.press(screen.getByText("API key"));
      await fireEvent.changeText(
        screen.getByLabelText("ReadMeABook API key"),
        "rmab_abc123"
      );
      expect(screen.queryByLabelText("Sign in with SSO")).toBeNull();
      expect(getRmabAuthProviders).not.toHaveBeenCalled();
    });

    it("token-kind toggle swaps the field and clears a stale value from the other mode", async () => {
      await renderSettings();
      await fireEvent.press(screen.getByLabelText(/^Connect ReadMeABook/));
      // Default tab: login URL.
      const urlField = screen.getByLabelText("ReadMeABook login URL");
      await fireEvent.changeText(urlField, "https://rmab.test/auth/token/login?token=SECRET");
      // Switch to API key: the field swaps and the stale login URL is cleared.
      await fireEvent.press(screen.getByText("API key"));
      const keyField = screen.getByLabelText("ReadMeABook API key");
      expect(keyField.props.value).toBe("");
      expect(screen.queryByLabelText("ReadMeABook login URL")).toBeNull();
    });
  });
});
