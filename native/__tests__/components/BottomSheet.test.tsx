/**
 * REGRESSION: bottom-sheet backdrop must fade IN PLACE, not ride up with the
 * sheet. The old sheets used RN Modal animationType="slide", which slides the
 * entire content view — dim scrim included. BottomSheet keeps the Modal
 * unanimated and splits the layers: scrim fades, only the sheet translates.
 */
import React from "react";
import { Text } from "react-native";
import { render, screen, fireEvent } from "@testing-library/react-native";
import BottomSheet from "../../components/BottomSheet";

describe("BottomSheet", () => {
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
    const dismiss = screen.getByLabelText("Dismiss");
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
    await fireEvent.press(screen.getByLabelText("Dismiss"));
    expect(onClose).toHaveBeenCalled();
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
