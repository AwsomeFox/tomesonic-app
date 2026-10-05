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

    const shake = screen.getByLabelText("Shake to add time");
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
    expect(screen.queryByLabelText("Shake to add time")).toBeNull();
  });

  it("marks the title as a header for screen readers", async () => {
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
    expect(screen.getByText("Sleep Timer").props.accessibilityRole).toBe("header");
  });
  describe("stop after chapter…", () => {
    const CHAPTERS = [
      { title: "Prologue", start: 0, end: 100 },
      { title: "The Road", start: 100, end: 400 },
      { title: "", start: 400, end: 1000 },
    ];
    const renderPicker = async (over: Record<string, any> = {}) => {
      const onSetUntilChapter = jest.fn();
      const onClose = jest.fn();
      await render(
        <SleepTimerModal
          visible
          onClose={onClose}
          timer={null}
          hasChapter
          onSet={() => {}}
          onCancel={() => {}}
          chapters={CHAPTERS}
          currentChapterIndex={0}
          getPosition={() => 40}
          playbackSpeed={2}
          onSetUntilChapter={onSetUntilChapter}
          {...over}
        />
      );
      return { onSetUntilChapter, onClose };
    };

    it("lists the current chapter onward with the listening time until each ends", async () => {
      await renderPicker();
      await fireEvent.press(screen.getByText("Stop after chapter…"));
      // (end − position) / speed: (100−40)/2 = 30s, (400−40)/2 = 180s, (1000−40)/2 = 480s.
      expect(screen.getByLabelText("Stop after Prologue, ends in 0:30")).toBeTruthy();
      expect(screen.getByText("Playing now")).toBeTruthy();
      expect(screen.getByLabelText("Stop after The Road, ends in 3:00")).toBeTruthy();
      // Untitled chapters get a numbered fallback.
      expect(screen.getByLabelText("Stop after Chapter 3, ends in 8:00")).toBeTruthy();
    });

    it("arms the picked chapter and closes", async () => {
      const { onSetUntilChapter, onClose } = await renderPicker();
      await fireEvent.press(screen.getByText("Stop after chapter…"));
      await fireEvent.press(screen.getByLabelText(/Stop after The Road/));
      expect(onSetUntilChapter).toHaveBeenCalledWith(1);
      expect(onClose).toHaveBeenCalled();
    });

    it("starts the list at the current chapter (earlier ones are already behind)", async () => {
      await renderPicker({ currentChapterIndex: 1, getPosition: () => 200 });
      await fireEvent.press(screen.getByText("Stop after chapter…"));
      expect(screen.queryByLabelText(/Stop after Prologue/)).toBeNull();
      expect(screen.getByLabelText("Stop after The Road, ends in 1:40")).toBeTruthy();
    });

    it("is hidden in the last chapter (nothing later to pick)", async () => {
      await renderPicker({ currentChapterIndex: 2 });
      expect(screen.queryByText("Stop after chapter…")).toBeNull();
    });

    it("is hidden without a handler", async () => {
      await renderPicker({ onSetUntilChapter: undefined });
      expect(screen.queryByText("Stop after chapter…")).toBeNull();
    });

    it("back returns to the presets", async () => {
      await renderPicker();
      await fireEvent.press(screen.getByText("Stop after chapter…"));
      await fireEvent.press(screen.getByLabelText("Back to presets"));
      expect(screen.getByText("30 min")).toBeTruthy();
    });

    it("an armed stop-after-chapter timer names its chapter", async () => {
      await render(
        <SleepTimerModal
          visible
          onClose={() => {}}
          timer={{ endOfChapter: true, untilChapter: true, chapterIdx: 1, remaining: 360 }}
          hasChapter
          onSet={() => {}}
          onCancel={() => {}}
          chapters={CHAPTERS}
          currentChapterIndex={0}
        />
      );
      expect(screen.getByText("End of The Road")).toBeTruthy();
    });

    it("a plain end-of-chapter timer still reads 'End of chapter'", async () => {
      await render(
        <SleepTimerModal
          visible
          onClose={() => {}}
          timer={{ endOfChapter: true, chapterIdx: 0, remaining: 60 }}
          hasChapter
          onSet={() => {}}
          onCancel={() => {}}
          chapters={CHAPTERS}
          currentChapterIndex={0}
        />
      );
      expect(screen.getByText("End of chapter")).toBeTruthy();
    });
  });
});
