import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import PlaybackSpeedModal from "../../components/PlaybackSpeedModal";

describe("PlaybackSpeedModal", () => {
  it("forwards a quick-pick rate", async () => {
    const onChange = jest.fn();
    await render(
      <PlaybackSpeedModal visible onClose={() => {}} speed={1.0} onChange={onChange} />
    );
    await fireEvent.press(screen.getByText("1.5×"));
    expect(onChange).toHaveBeenCalledWith(1.5);
  });

  it("shows the per-book toggle and forwards its change", async () => {
    const onToggle = jest.fn();
    await render(
      <PlaybackSpeedModal
        visible
        onClose={() => {}}
        speed={1.0}
        onChange={() => {}}
        rememberPerBook={true}
        onToggleRememberPerBook={onToggle}
      />
    );
    const row = screen.getByLabelText("Remember speed per book");
    expect(row.props.accessibilityState?.checked).toBe(true);
    await fireEvent.press(row);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("hides the per-book toggle when no handler is provided", async () => {
    await render(
      <PlaybackSpeedModal visible onClose={() => {}} speed={1.0} onChange={() => {}} />
    );
    expect(screen.queryByLabelText("Remember speed per book")).toBeNull();
  });

  it("marks the title as a header for screen readers", async () => {
    await render(
      <PlaybackSpeedModal visible onClose={() => {}} speed={1.0} onChange={() => {}} />
    );
    expect(screen.getByText("Playback Speed").props.accessibilityRole).toBe("header");
  });
});
