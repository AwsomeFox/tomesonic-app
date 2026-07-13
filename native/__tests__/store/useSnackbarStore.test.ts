/**
 * useSnackbarStore — transient-feedback state behind <AppSnackbar/>.
 * showSnackbar() replaces the current entry (single-instance, M3 snackbars
 * never stack), defaults durationMs to 3000, and stamps each show with a
 * unique key so the host can restart timers/animations on replacement.
 */
import { showSnackbar, useSnackbarStore } from "../../store/useSnackbarStore";

beforeEach(() => {
  useSnackbarStore.setState({ current: null });
});

describe("useSnackbarStore", () => {
  it("showSnackbar stores the message with the 3000ms default duration", () => {
    showSnackbar({ message: "Saved" });
    const cur = useSnackbarStore.getState().current;
    expect(cur?.message).toBe("Saved");
    expect(cur?.durationMs).toBe(3000);
    expect(cur?.action).toBeUndefined();
  });

  it("preserves a custom duration and action", () => {
    const onPress = jest.fn();
    showSnackbar({ message: "Deleted", durationMs: 5000, action: { label: "Undo", onPress } });
    const cur = useSnackbarStore.getState().current;
    expect(cur?.durationMs).toBe(5000);
    expect(cur?.action?.label).toBe("Undo");
    cur?.action?.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("a new show REPLACES the current entry with a fresh key (single-instance)", () => {
    showSnackbar({ message: "First" });
    const first = useSnackbarStore.getState().current;
    showSnackbar({ message: "First" }); // identical message, still a new entry
    const second = useSnackbarStore.getState().current;
    expect(second?.message).toBe("First");
    expect(second?.key).not.toBe(first?.key);
  });

  it("dismiss() clears the current snackbar", () => {
    showSnackbar({ message: "Saved" });
    expect(useSnackbarStore.getState().current).not.toBeNull();
    useSnackbarStore.getState().dismiss();
    expect(useSnackbarStore.getState().current).toBeNull();
  });
});
