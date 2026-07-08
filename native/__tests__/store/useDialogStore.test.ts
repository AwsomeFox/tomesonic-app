/**
 * useDialogStore — the themed Alert.alert replacement's state. showAppDialog()
 * sets the current dialog (defaulting to a single OK when no buttons are given,
 * matching Alert.alert), preserves cancelable, and dismiss() clears it.
 */
import { showAppDialog, useDialogStore } from "../../store/useDialogStore";

beforeEach(() => {
  useDialogStore.setState({ current: null });
});

describe("useDialogStore", () => {
  it("showAppDialog stores the given title, message, and buttons", () => {
    showAppDialog({
      title: "Delete?",
      message: "Are you sure?",
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive" },
      ],
    });
    const cur = useDialogStore.getState().current;
    expect(cur?.title).toBe("Delete?");
    expect(cur?.message).toBe("Are you sure?");
    expect(cur?.buttons).toEqual([
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive" },
    ]);
  });

  it("defaults to a single OK button when none are provided (matches Alert.alert)", () => {
    showAppDialog({ title: "Heads up" });
    expect(useDialogStore.getState().current?.buttons).toEqual([{ text: "OK" }]);
  });

  it("defaults to OK when an empty buttons array is passed", () => {
    showAppDialog({ title: "Heads up", buttons: [] });
    expect(useDialogStore.getState().current?.buttons).toEqual([{ text: "OK" }]);
  });

  it("preserves the cancelable flag", () => {
    showAppDialog({ title: "Locked", cancelable: false });
    expect(useDialogStore.getState().current?.cancelable).toBe(false);
  });

  it("dismiss() clears the current dialog", () => {
    showAppDialog({ title: "Heads up" });
    expect(useDialogStore.getState().current).not.toBeNull();
    useDialogStore.getState().dismiss();
    expect(useDialogStore.getState().current).toBeNull();
  });
});
