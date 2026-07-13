/**
 * LibraryIconPickerSheet — the glyph grid the library editor opens to pick the
 * ABS server icon. It offers every ABS_LIBRARY_ICONS key as a radio tile,
 * marks the current selection via accessibilityState.checked, and hands the
 * RAW ABS key (not the rendered glyph name) back to onSelect before closing.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import LibraryIconPickerSheet from "../../components/LibraryIconPickerSheet";
import { ABS_LIBRARY_ICONS } from "../../components/LibraryIcon";

describe("LibraryIconPickerSheet", () => {
  it("renders a radio tile for every ABS icon option", async () => {
    await render(
      <LibraryIconPickerSheet
        visible
        mediaType="book"
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    for (const key of ABS_LIBRARY_ICONS) {
      const tile = screen.getByLabelText(key);
      expect(tile).toBeTruthy();
      expect(tile.props.accessibilityRole).toBe("radio");
    }
  });

  it("fires onSelect with the raw ABS key and then closes", async () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    await render(
      <LibraryIconPickerSheet
        visible
        mediaType="book"
        onSelect={onSelect}
        onClose={onClose}
      />
    );
    await fireEvent.press(screen.getByLabelText("rocket"));
    expect(onSelect).toHaveBeenCalledWith("rocket");
    expect(onClose).toHaveBeenCalled();
  });

  it("marks the selected tile checked and the others unchecked", async () => {
    await render(
      <LibraryIconPickerSheet
        visible
        selected="podcast"
        mediaType="podcast"
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByLabelText("podcast").props.accessibilityState.checked).toBe(true);
    expect(screen.getByLabelText("database").props.accessibilityState.checked).toBe(false);
  });
});
