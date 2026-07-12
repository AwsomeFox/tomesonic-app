/**
 * AppDialog — the themed Material 3 host that replaces native Alert.alert. It
 * renders nothing until showAppDialog() sets a dialog, then shows the title,
 * message, and a row of buttons; pressing a button fires its onPress and
 * dismisses the dialog, and destructive buttons render in the error color.
 */
import React from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
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

  // ── Typed-confirm (confirmInput) — high-stakes destructive dialogs ──

  const showTypedConfirm = async (opts: Partial<Parameters<typeof showAppDialog>[0]> = {}, onDelete = jest.fn()) => {
    await act(async () => {
      showAppDialog({
        title: "Delete library?",
        message: "This cannot be undone.",
        confirmInput: { placeholder: "Library name", requiredText: "Main Library" },
        buttons: [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: onDelete },
        ],
        ...opts,
      });
    });
    await screen.findByText("Delete library?");
    return onDelete;
  };

  it("renders the confirm input with placeholder and 'Type … to confirm' label", async () => {
    await render(<AppDialog />);
    await showTypedConfirm();

    const input = screen.getByTestId("app-dialog-confirm-input");
    expect(input.props.placeholder).toBe("Library name");
    expect(screen.getByLabelText("Type Main Library to confirm")).toBeTruthy();
  });

  it("keeps the LAST button disabled until the input matches requiredText", async () => {
    await render(<AppDialog />);
    const onDelete = await showTypedConfirm();

    // Untouched input: Delete is disabled (state + 50% visual), press is inert.
    let del = screen.getByLabelText("Delete");
    expect(del.props.accessibilityState.disabled).toBe(true);
    expect(StyleSheet.flatten(del.props.style).opacity).toBe(0.5);
    await fireEvent.press(del);
    expect(onDelete).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).not.toBeNull();

    // Wrong text: still disabled.
    await fireEvent.changeText(screen.getByTestId("app-dialog-confirm-input"), "Other Library");
    expect(screen.getByLabelText("Delete").props.accessibilityState.disabled).toBe(true);

    // Exact match: enabled, and pressing confirms + dismisses.
    await fireEvent.changeText(screen.getByTestId("app-dialog-confirm-input"), "Main Library");
    del = screen.getByLabelText("Delete");
    expect(del.props.accessibilityState.disabled).toBe(false);
    expect(StyleSheet.flatten(del.props.style).opacity).toBe(1);
    await fireEvent.press(del);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(useDialogStore.getState().current).toBeNull();
  });

  it("matches case-insensitively when caseSensitive is off (default)", async () => {
    await render(<AppDialog />);
    const onDelete = await showTypedConfirm();

    await fireEvent.changeText(screen.getByTestId("app-dialog-confirm-input"), "main library");
    const del = screen.getByLabelText("Delete");
    expect(del.props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(del);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("requires the exact casing when caseSensitive is true", async () => {
    await render(<AppDialog />);
    await showTypedConfirm({
      confirmInput: { placeholder: "Library name", requiredText: "Main Library", caseSensitive: true },
    });

    await fireEvent.changeText(screen.getByTestId("app-dialog-confirm-input"), "main library");
    expect(screen.getByLabelText("Delete").props.accessibilityState.disabled).toBe(true);

    await fireEvent.changeText(screen.getByTestId("app-dialog-confirm-input"), "Main Library");
    expect(screen.getByLabelText("Delete").props.accessibilityState.disabled).toBe(false);
  });

  it("leaves non-last buttons usable while the confirm is unmatched", async () => {
    await render(<AppDialog />);
    const onDelete = await showTypedConfirm();

    const cancel = screen.getByLabelText("Cancel");
    expect(cancel.props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(cancel);
    expect(useDialogStore.getState().current).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("renders no input and no disabled buttons for dialogs without confirmInput", async () => {
    await render(<AppDialog />);
    await act(async () => {
      showAppDialog({ title: "Plain", buttons: [{ text: "OK" }] });
    });
    await screen.findByText("Plain");

    expect(screen.queryByTestId("app-dialog-confirm-input")).toBeNull();
    expect(screen.getByLabelText("OK").props.accessibilityState.disabled).toBe(false);
  });

  it("resets the typed text when a new dialog is shown", async () => {
    await render(<AppDialog />);
    await showTypedConfirm();
    await fireEvent.changeText(screen.getByTestId("app-dialog-confirm-input"), "Main Library");
    await fireEvent.press(screen.getByLabelText("Cancel"));

    // Re-open: previous input must not pre-satisfy the new confirmation.
    await showTypedConfirm();
    expect(screen.getByTestId("app-dialog-confirm-input").props.value).toBe("");
    expect(screen.getByLabelText("Delete").props.accessibilityState.disabled).toBe(true);
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
