import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import SleepTimerModal from "../../components/SleepTimerModal";

describe("SleepTimerModal", () => {
  it("arms a preset timer", async () => {
    const onSet = jest.fn();
    await render(
      <SleepTimerModal
        visible
        onClose={() => {}}
        timer={null}
        hasChapter={false}
        onSet={onSet}
        onCancel={() => {}}
      />
    );
    await fireEvent.press(screen.getByText("30 min"));
    expect(onSet).toHaveBeenCalledWith(1800, false);
  });

  it("shows the rewind-on-wake and shake toggles and forwards changes", async () => {
    const onRewind = jest.fn();
    const onShake = jest.fn();
    await render(
      <SleepTimerModal
        visible
        onClose={() => {}}
        timer={null}
        hasChapter={false}
        onSet={() => {}}
        onCancel={() => {}}
        rewindOnWake={true}
        onToggleRewindOnWake={onRewind}
        shakeToExtend={false}
        onToggleShakeToExtend={onShake}
      />
    );
    const rewind = screen.getByLabelText("Rewind on wake");
    expect(rewind.props.accessibilityState?.checked).toBe(true);
    await fireEvent.press(rewind);
    expect(onRewind).toHaveBeenCalledWith(false);

    const shake = screen.getByLabelText("Shake to add time (screen on)");
    expect(shake.props.accessibilityState?.checked).toBe(false);
    await fireEvent.press(shake);
    expect(onShake).toHaveBeenCalledWith(true);
  });

  it("hides the extra toggles when no handlers are provided", async () => {
    await render(
      <SleepTimerModal
        visible
        onClose={() => {}}
        timer={null}
        hasChapter={false}
        onSet={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.queryByLabelText("Rewind on wake")).toBeNull();
    expect(screen.queryByLabelText("Shake to add time (screen on)")).toBeNull();
  });
});
