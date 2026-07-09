/**
 * REGRESSION: bottom-sheet backdrop must fade IN PLACE, not ride up with the
 * sheet. The old sheets used RN Modal animationType="slide", which slides the
 * entire content view — dim scrim included. BottomSheet keeps the Modal
 * unanimated and splits the layers: scrim fades, only the sheet translates.
 */
import React from "react";
import { Animated, Text } from "react-native";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import { useReducedMotion } from "react-native-reanimated";
import BottomSheet, { shouldClaimDrag, shouldDismissOnRelease } from "../../components/BottomSheet";

const mockUseReducedMotion = useReducedMotion as jest.Mock;

describe("BottomSheet", () => {
  afterEach(() => {
    mockUseReducedMotion.mockReturnValue(false);
  });

  it("renders children when visible", async () => {
    await render(
      <BottomSheet visible onClose={() => {}}>
        <Text>Sheet content</Text>
      </BottomSheet>
    );
    expect(screen.getByText("Sheet content")).toBeTruthy();
  });

  it("renders nothing when never shown", async () => {
    await render(
      <BottomSheet visible={false} onClose={() => {}}>
        <Text>Sheet content</Text>
      </BottomSheet>
    );
    expect(screen.queryByText("Sheet content")).toBeNull();
  });

  it("uses an unanimated Modal (no built-in slide that would move the scrim)", async () => {
    await render(
      <BottomSheet visible onClose={() => {}} testID="sheet-modal">
        <Text>Sheet content</Text>
      </BottomSheet>
    );
    const modal = screen.getByTestId("sheet-modal");
    expect(modal.props.animationType).toBe("none");
    expect(modal.props.transparent).toBe(true);
  });

  it("backdrop and sheet animate independently: scrim never translates", async () => {
    await render(
      <BottomSheet visible onClose={() => {}} testID="sheet-modal">
        <Text>Sheet content</Text>
      </BottomSheet>
    );
    // The backdrop is intentionally out of the a11y tree now (it used to be
    // the first "Dismiss" element TalkBack focused) — target it by testID.
    const dismiss = screen.getByTestId("sheet-backdrop", { includeHiddenElements: true });
    // Walk up from the scrim pressable: no ancestor may carry a translateY
    // transform (that was the bug — the dim lived inside the sliding view).
    let node: any = dismiss.parent;
    while (node) {
      const style = node.props?.style;
      const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style || {};
      const transforms = flat.transform || [];
      const hasTranslate = (Array.isArray(transforms) ? transforms : []).some(
        (t: any) => t && Object.prototype.hasOwnProperty.call(t, "translateY")
      );
      expect(hasTranslate).toBe(false);
      node = node.parent;
    }
  });

  it("tapping the scrim calls onClose", async () => {
    const onClose = jest.fn();
    await render(
      <BottomSheet visible onClose={onClose}>
        <Text>Sheet content</Text>
      </BottomSheet>
    );
    await fireEvent.press(screen.getByTestId("sheet-backdrop", { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalled();
  });

  describe("drag-to-dismiss thresholds", () => {
    it("dismisses past the distance threshold (dy > 80)", () => {
      expect(shouldDismissOnRelease(120, 0.1)).toBe(true);
      expect(shouldDismissOnRelease(81, 0)).toBe(true);
    });

    it("dismisses on a fast downward flick (vy > 0.5) even below the distance threshold", () => {
      expect(shouldDismissOnRelease(30, 0.9)).toBe(true);
    });

    it("springs back (no dismiss) on a short, slow drag", () => {
      expect(shouldDismissOnRelease(20, 0.1)).toBe(false);
      expect(shouldDismissOnRelease(80, 0.5)).toBe(false); // exactly at bounds -> keep open
    });

    it("claims the gesture only for a deliberate downward drag", () => {
      expect(shouldClaimDrag(20, 3)).toBe(true); // clear downward
      expect(shouldClaimDrag(6, 40)).toBe(false); // horizontal swipe dominates
      expect(shouldClaimDrag(2, 0)).toBe(false); // tiny jitter
      expect(shouldClaimDrag(-30, 0)).toBe(false); // upward drag
    });
  });

  it("a close animation completing during a fast reopen does not tear down the sheet", async () => {
    // Capture animation completion callbacks so the close animation's
    // finished=true can be delivered LATE — after the reopen effect has run.
    // Interruption (finished=false) was already handled; this is the race
    // where the close genuinely completes as `visible` flips back true.
    const startCallbacks: Array<(r: { finished: boolean }) => void> = [];
    const spy = jest.spyOn(Animated, "parallel").mockImplementation(
      (() => ({
        start: (cb?: (r: { finished: boolean }) => void) => {
          if (cb) startCallbacks.push(cb);
        },
        stop: () => {},
        reset: () => {},
      })) as any
    );
    try {
      const view = await render(
        <BottomSheet visible onClose={() => {}}>
          <Text>Sheet content</Text>
        </BottomSheet>
      );
      await view.rerender(
        <BottomSheet visible={false} onClose={() => {}}>
          <Text>Sheet content</Text>
        </BottomSheet>
      );
      const closeCompleted = startCallbacks[startCallbacks.length - 1];
      await view.rerender(
        <BottomSheet visible onClose={() => {}}>
          <Text>Sheet content</Text>
        </BottomSheet>
      );
      await act(async () => closeCompleted({ finished: true }));
      expect(screen.getByText("Sheet content")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("reduced motion: snaps open without running the slide/fade animation", async () => {
    mockUseReducedMotion.mockReturnValue(true);
    const parallel = jest.spyOn(Animated, "parallel");
    try {
      await render(
        <BottomSheet visible onClose={() => {}}>
          <Text>Sheet content</Text>
        </BottomSheet>
      );
      // Sheet is present and mounted, but no animation was started.
      expect(screen.getByText("Sheet content")).toBeTruthy();
      expect(parallel).not.toHaveBeenCalled();
    } finally {
      parallel.mockRestore();
    }
  });

  it("reduced motion: snaps closed and unmounts without animation", async () => {
    mockUseReducedMotion.mockReturnValue(true);
    const parallel = jest.spyOn(Animated, "parallel");
    try {
      const view = await render(
        <BottomSheet visible onClose={() => {}}>
          <Text>Sheet content</Text>
        </BottomSheet>
      );
      expect(screen.getByText("Sheet content")).toBeTruthy();
      await act(async () => {
        view.rerender(
          <BottomSheet visible={false} onClose={() => {}}>
            <Text>Sheet content</Text>
          </BottomSheet>
        );
      });
      // Unmounts immediately (close callback still fires), no animation run.
      await waitFor(() => expect(screen.queryByText("Sheet content")).toBeNull());
      expect(parallel).not.toHaveBeenCalled();
    } finally {
      parallel.mockRestore();
    }
  });

  it("hides the drag handle when showHandle is false", async () => {
    await render(
      <BottomSheet visible onClose={() => {}} showHandle={false} testID="sheet-modal">
        <Text>Sheet content</Text>
      </BottomSheet>
    );
    expect(screen.getByText("Sheet content")).toBeTruthy();
  });
});
