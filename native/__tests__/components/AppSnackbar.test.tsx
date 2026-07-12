/**
 * AppSnackbar — the M3 transient-feedback host mounted once in AppShell.
 * showSnackbar() shows the message (announced to the screen reader),
 * auto-dismisses after durationMs, fires the optional action, replaces the
 * current snackbar on a new show, and floats above the mini-player whenever a
 * playback session exists.
 */
import React from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import AppSnackbar from "../../components/AppSnackbar";
import { showSnackbar, useSnackbarStore } from "../../store/useSnackbarStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";

const initialPlayback = usePlaybackStore.getState();

beforeEach(() => {
  usePlaybackStore.setState(initialPlayback, true);
  useSnackbarStore.setState({ current: null });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const show = async (opts: Parameters<typeof showSnackbar>[0]) => {
  await act(async () => {
    showSnackbar(opts);
  });
};

describe("AppSnackbar", () => {
  it("renders nothing until showSnackbar is called", async () => {
    await render(<AppSnackbar />);
    expect(screen.queryByTestId("app-snackbar")).toBeNull();
  });

  it("shows the message and announces it to the screen reader", async () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await render(<AppSnackbar />);
    await show({ message: "Backup started" });

    expect(screen.getByText("Backup started")).toBeTruthy();
    expect(announce).toHaveBeenCalledWith("Backup started");
    announce.mockRestore();
  });

  it("auto-dismisses after the default 3000ms", async () => {
    await render(<AppSnackbar />);
    await show({ message: "Saved" });
    expect(screen.getByText("Saved")).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(2999);
    });
    expect(useSnackbarStore.getState().current).not.toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(useSnackbarStore.getState().current).toBeNull();
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("respects a custom durationMs", async () => {
    await render(<AppSnackbar />);
    await show({ message: "Long one", durationMs: 8000 });

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText("Long one")).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(useSnackbarStore.getState().current).toBeNull();
  });

  it("pressing the action fires onPress and dismisses", async () => {
    const onPress = jest.fn();
    await render(<AppSnackbar />);
    await show({ message: "Item deleted", action: { label: "Undo", onPress } });

    await fireEvent.press(screen.getByText("Undo"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(useSnackbarStore.getState().current).toBeNull();
  });

  it("a new show replaces the current snackbar and restarts the countdown", async () => {
    await render(<AppSnackbar />);
    await show({ message: "First" });
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await show({ message: "Second" });

    // Single instance: only the replacement is visible.
    expect(screen.queryByText("First")).toBeNull();
    expect(screen.getByText("Second")).toBeTruthy();

    // The countdown restarted with the replacement: 2000ms in, still visible…
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Second")).toBeTruthy();
    // …and gone once ITS 3000ms elapse.
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(useSnackbarStore.getState().current).toBeNull();
  });

  it("floats above the mini-player when a playback session exists", async () => {
    await render(<AppSnackbar />);
    await show({ message: "No session" });
    const without = StyleSheet.flatten(screen.getByTestId("app-snackbar").props.style).bottom;

    await act(async () => {
      usePlaybackStore.setState({ currentSession: { id: "s1" } } as any);
    });
    const withSession = StyleSheet.flatten(screen.getByTestId("app-snackbar").props.style).bottom;

    // Mini-player is 68dp tall — the snackbar shifts up by exactly that.
    expect(withSession - without).toBe(68);
  });
});
