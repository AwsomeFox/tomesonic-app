/**
 * LogsScreen — renders appLogger entries, level filtering, server-address
 * masking, copy/share/clear actions, and live listener updates.
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

import React from "react";
import { Clipboard, Share } from "react-native";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import LogsScreen from "../../screens/LogsScreen";
import { appLogger } from "../../utils/logger";

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderLogs() {
  const navigation = makeNavigation();
  await render(<LogsScreen navigation={navigation} />);
  return navigation;
}

let setStringSpy: jest.SpyInstance;
let shareSpy: jest.SpyInstance;

beforeEach(() => {
  appLogger.clearLogs();
  setStringSpy = jest.spyOn(Clipboard, "setString").mockImplementation(() => {});
  shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" } as any);
});

afterEach(() => {
  setStringSpy.mockRestore();
  shareSpy.mockRestore();
  appLogger.clearLogs();
});

describe("LogsScreen", () => {
  it("shows the empty state when there are no logs", async () => {
    await renderLogs();
    expect(screen.getByText("No logs to display")).toBeTruthy();
  });

  it("renders existing entries with level, tag, and masked server address", async () => {
    appLogger.info("connected to https://abs.example.com/api ok", "Api");
    appLogger.error("something exploded", "Player");
    await renderLogs();

    // Server addresses are masked by default.
    expect(
      screen.getByText("connected to https://[SERVER_ADDRESS] ok")
    ).toBeTruthy();
    expect(screen.queryByText(/abs\.example\.com/)).toBeNull();
    expect(screen.getByText("something exploded")).toBeTruthy();
    expect(screen.getByText("INFO")).toBeTruthy();
    expect(screen.getByText("ERROR")).toBeTruthy();
    expect(screen.getByText("Api")).toBeTruthy();
    expect(screen.getByText("Player")).toBeTruthy();
  });

  it("unmasking via the overflow menu reveals the full URL", async () => {
    appLogger.info("connected to https://abs.example.com/api ok");
    await renderLogs();

    await fireEvent.press(screen.getByLabelText("More options"));
    await fireEvent.press(screen.getByText("Unmask server address"));

    expect(
      screen.getByText("connected to https://abs.example.com/api ok")
    ).toBeTruthy();
  });

  it("level filter chips narrow the visible entries", async () => {
    appLogger.info("info entry");
    appLogger.error("error entry");
    await renderLogs();

    await fireEvent.press(screen.getByLabelText("Show error logs"));
    expect(screen.getByText("error entry")).toBeTruthy();
    expect(screen.queryByText("info entry")).toBeNull();

    // Filter with no matches shows a targeted empty state.
    await fireEvent.press(screen.getByLabelText("Show warn logs"));
    expect(screen.getByText("No warn logs")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Show all logs"));
    expect(screen.getByText("info entry")).toBeTruthy();
    expect(screen.getByText("error entry")).toBeTruthy();
  });

  it("copies the visible (filtered + masked) logs to the clipboard", async () => {
    // Fake timers: the "copied" confirmation resets after 2s and would
    // otherwise leave a dangling real timer past the end of the test.
    jest.useFakeTimers();
    try {
      appLogger.info("info at https://abs.example.com/x", "Api");
      appLogger.error("bad thing");
      await renderLogs();

      await fireEvent.press(screen.getByLabelText("Show error logs"));
      await fireEvent.press(screen.getByLabelText("Copy logs to clipboard"));

      expect(setStringSpy).toHaveBeenCalledTimes(1);
      const copied = setStringSpy.mock.calls[0][0];
      expect(copied).toContain("[ERROR] bad thing");
      // Filtered-out and unmasked content must not leak into the export.
      expect(copied).not.toContain("info at");
      expect(copied).not.toContain("abs.example.com");
      // Copy affordance flips to the confirmation state, then resets.
      expect(screen.getByLabelText("Logs copied")).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(2100);
      });
      expect(screen.getByLabelText("Copy logs to clipboard")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("shares the formatted logs", async () => {
    appLogger.warn("watch out", "Sync");
    await renderLogs();

    await fireEvent.press(screen.getByLabelText("Share logs"));
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(shareSpy.mock.calls[0][0].message).toContain("[WARN] [Sync] watch out");
  });

  it("clear logs wipes the logger and shows the empty state", async () => {
    appLogger.info("to be cleared");
    await renderLogs();

    await fireEvent.press(screen.getByLabelText("More options"));
    await fireEvent.press(screen.getByText("Clear logs"));

    expect(appLogger.getLogs()).toHaveLength(0);
    expect(screen.getByText("No logs to display")).toBeTruthy();
  });

  it("live entries stream in through the logger listener", async () => {
    await renderLogs();
    expect(screen.getByText("No logs to display")).toBeTruthy();

    await act(async () => {
      appLogger.info("late arrival");
    });
    expect(screen.getByText("late arrival")).toBeTruthy();
  });

  it("back button goes back", async () => {
    const navigation = await renderLogs();
    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
