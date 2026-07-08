/**
 * AppDialog — the themed Material 3 host that replaces native Alert.alert. It
 * renders nothing until showAppDialog() sets a dialog, then shows the title,
 * message, and a row of buttons; pressing a button fires its onPress and
 * dismisses the dialog, and destructive buttons render in the error color.
 */
import React from "react";
import { AccessibilityInfo } from "react-native";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import AppDialog from "../../components/AppDialog";
import { showAppDialog, useDialogStore } from "../../store/useDialogStore";
import { useThemeColors } from "../../theme/useThemeColors";

// Capture the live theme so color assertions don't hardcode a palette (the
// active palette depends on the render environment's color scheme).
let colors: any;
function ThemeProbe() {
  colors = useThemeColors();
  return null;
}

beforeEach(() => {
  useDialogStore.setState({ current: null });
});

describe("AppDialog", () => {
  it("renders nothing until showAppDialog sets a dialog", async () => {
    await render(<AppDialog />);
    expect(screen.queryByText("Delete?")).toBeNull();
  });

  it("renders the title, message, and buttons from showAppDialog", async () => {
    await render(<AppDialog />);
    await act(async () => {
      showAppDialog({
        title: "Delete?",
        message: "Are you sure?",
        buttons: [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive" },
        ],
      });
    });
    expect(await screen.findByText("Delete?")).toBeTruthy();
    expect(screen.getByText("Are you sure?")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("pressing a button fires its onPress and dismisses the dialog", async () => {
    const onPress = jest.fn();
    await render(<AppDialog />);
    await act(async () => {
      showAppDialog({ title: "Confirm", buttons: [{ text: "OK", onPress }] });
    });
    await screen.findByText("Confirm");

    fireEvent.press(screen.getByText("OK"));

    expect(onPress).toHaveBeenCalledTimes(1);
    // The dialog is dismissed — its store state is cleared and nothing renders.
    expect(useDialogStore.getState().current).toBeNull();
    await waitFor(() => expect(screen.queryByText("Confirm")).toBeNull());
  });

  it("renders destructive buttons in the error color and others in primary", async () => {
    await render(
      <>
        <ThemeProbe />
        <AppDialog />
      </>
    );
    await act(async () => {
      showAppDialog({
        title: "Delete?",
        buttons: [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive" },
        ],
      });
    });
    await screen.findByText("Delete?");

    expect(screen.getByText("Delete").props.style.color).toBe(colors.error);
    expect(screen.getByText("Cancel").props.style.color).toBe(colors.primary);
    // Sanity: the two roles are visually distinct.
    expect(colors.error).not.toBe(colors.primary);
  });

  // ── Cancelable / dismissal semantics (QA finding: previously untested) ──

  it("scrim tap dismisses the dialog when cancelable is not false", async () => {
    await render(<AppDialog />);
    await act(async () => {
      showAppDialog({ title: "Confirm", message: "Body", buttons: [{ text: "OK" }] });
    });
    await screen.findByText("Confirm");

    fireEvent.press(screen.getByTestId("app-dialog-scrim", { includeHiddenElements: true }));

    expect(useDialogStore.getState().current).toBeNull();
    await waitFor(() => expect(screen.queryByText("Confirm")).toBeNull());
  });

  it("scrim tap is a no-op when cancelable is false", async () => {
    await render(<AppDialog />);
    await act(async () => {
      showAppDialog({
        title: "Confirm",
        message: "Body",
        cancelable: false,
        buttons: [{ text: "OK" }],
      });
    });
    await screen.findByText("Confirm");

    fireEvent.press(screen.getByTestId("app-dialog-scrim", { includeHiddenElements: true }));

    // Non-cancelable dialog must survive an outside tap.
    expect(useDialogStore.getState().current).not.toBeNull();
    expect(screen.getByText("Confirm")).toBeTruthy();
  });

  it("hardware back (onRequestClose) dismisses when cancelable is not false", async () => {
    await render(<AppDialog />);
    await act(async () => {
      showAppDialog({ title: "Confirm", buttons: [{ text: "OK" }] });
    });
    await screen.findByText("Confirm");

    fireEvent(screen.getByTestId("app-dialog-modal"), "requestClose");

    expect(useDialogStore.getState().current).toBeNull();
    await waitFor(() => expect(screen.queryByText("Confirm")).toBeNull());
  });

  it("hardware back (onRequestClose) is swallowed when cancelable is false", async () => {
    await render(<AppDialog />);
    await act(async () => {
      showAppDialog({ title: "Confirm", cancelable: false, buttons: [{ text: "OK" }] });
    });
    await screen.findByText("Confirm");

    fireEvent(screen.getByTestId("app-dialog-modal"), "requestClose");

    // Back is swallowed — the dialog stays up.
    expect(useDialogStore.getState().current).not.toBeNull();
    expect(screen.getByText("Confirm")).toBeTruthy();
  });

  it("announces the dialog to the screen reader when it opens", async () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    announce.mockClear();
    await render(<AppDialog />);
    await act(async () => {
      showAppDialog({ title: "Delete?", message: "Are you sure?", buttons: [{ text: "OK" }] });
    });
    await screen.findByText("Delete?");

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith("Delete?. Are you sure?")
    );
    announce.mockRestore();
  });
});
