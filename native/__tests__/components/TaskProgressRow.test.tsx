/**
 * TaskProgressRow — pure presentational row for one ABS server task. Icon
 * follows the task action, the sublabel shows elapsed time (or the error in
 * the error color when failed), and the right side is spinner / one-shot
 * check / error glyph for running / finished / failed.
 */
import React from "react";
import { StyleSheet } from "react-native";
import { render, screen, fireEvent } from "@testing-library/react-native";
import TaskProgressRow from "../../components/TaskProgressRow";
import { useThemeColors } from "../../theme/useThemeColors";

// Freeze the wall clock so relative-time fixtures ("started 5s ago") assert
// deterministically — real Date.now() drifts past the literal "Running for 5s"
// whenever render is slow.
beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-01-01T12:00:00Z") });
});

afterEach(() => {
  jest.useRealTimers();
});

// Minimal AbsTask shape per the frozen utils/abs contract — typed loosely here
// so this suite stays decoupled from the utils/abs module's types.
const makeTask = (overrides: Record<string, any> = {}) => ({
  id: "t1",
  action: "scan",
  title: "Library scan",
  description: undefined,
  error: null,
  isFailed: false,
  isFinished: false,
  startedAt: Date.now() - 5_000,
  finishedAt: null,
  ...overrides,
});

let colors: any;
function ThemeProbe() {
  colors = useThemeColors();
  return null;
}

const renderRow = async (task: any, onPress?: () => void) =>
  render(
    <>
      <ThemeProbe />
      <TaskProgressRow task={task} onPress={onPress} />
    </>
  );

describe("TaskProgressRow", () => {
  it("running: shows title, elapsed sublabel, and a spinner", async () => {
    await renderRow(makeTask());
    expect(screen.getByText("Library scan")).toBeTruthy();
    expect(screen.getByText("Running for 5s")).toBeTruthy();
    expect(screen.getByTestId("task-row-spinner")).toBeTruthy();
    // No terminal-state glyphs while running.
    expect(screen.queryByText("check")).toBeNull();
    expect(screen.queryByText("error-outline")).toBeNull();
  });

  it("finished: shows the check icon and the finish duration, no spinner", async () => {
    const started = Date.now() - 65_000;
    await renderRow(
      makeTask({ isFinished: true, startedAt: started, finishedAt: started + 62_000 })
    );
    expect(screen.getByText("Finished in 1m 2s")).toBeTruthy();
    expect(screen.getByText("check")).toBeTruthy();
    expect(screen.queryByTestId("task-row-spinner")).toBeNull();
  });

  it("failed: shows the error text in the error color and the error glyph", async () => {
    await renderRow(
      makeTask({ isFailed: true, isFinished: true, error: "Folder not found" })
    );
    const sublabel = screen.getByText("Folder not found");
    expect(StyleSheet.flatten(sublabel.props.style).color).toBe(colors.error);
    expect(screen.getByText("error-outline")).toBeTruthy();
    expect(screen.queryByTestId("task-row-spinner")).toBeNull();
    expect(screen.queryByText("check")).toBeNull();
  });

  it("falls back to 'Failed' when a failed task carries no error text", async () => {
    await renderRow(makeTask({ isFailed: true, isFinished: true, error: null }));
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("renders a dash (not 'NaNs') when a task from an older server omits startedAt", async () => {
    // task is `any` from older servers — startedAt may be absent or 0, and
    // Date.now() - undefined is NaN, which would render "Running for NaNs".
    await renderRow(makeTask({ startedAt: undefined }));
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
    // The right side still reflects the running state.
    expect(screen.getByTestId("task-row-spinner")).toBeTruthy();
  });

  it("renders a dash for a finished task whose startedAt is 0", async () => {
    await renderRow(makeTask({ isFinished: true, startedAt: 0, finishedAt: 62_000 }));
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it.each([
    ["library-scan", "refresh"], // real ABS action strings are compound
    ["encode-m4b", "music-note"],
    ["embed-metadata", "edit"],
    ["match", "search"],
    ["backup", "storage"],
    ["download-podcast-episode", "pulse"], // unknown → activity glyph
  ])("maps action %s to the %s glyph", async (action, glyph) => {
    await renderRow(makeTask({ action }));
    expect(screen.getByText(glyph)).toBeTruthy();
  });

  it("is pressable (button role) when onPress is provided", async () => {
    const onPress = jest.fn();
    await renderRow(makeTask(), onPress);
    await fireEvent.press(screen.getByTestId("task-progress-row"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("renders a plain accessible row (no button) without onPress", async () => {
    await renderRow(makeTask());
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("Library scan, Running for 5s")).toBeTruthy();
  });

  it("appends the rendered description to the a11y label when showDescription is on", async () => {
    await render(
      <TaskProgressRow task={makeTask({ description: "Merging 12 audio files" }) as any} showDescription />
    );
    // The description renders as its own line…
    expect(screen.getByText("Merging 12 audio files")).toBeTruthy();
    // …and the single accessible row speaks it too (text outside the label is
    // silent on an accessible container).
    expect(
      screen.getByLabelText("Library scan, Running for 5s, Merging 12 audio files")
    ).toBeTruthy();
  });

  it("pressable variant carries the description in its a11y label as well", async () => {
    const onPress = jest.fn();
    await render(
      <TaskProgressRow
        task={makeTask({ description: "Merging 12 audio files" }) as any}
        showDescription
        onPress={onPress}
      />
    );
    expect(
      screen.getByLabelText("Library scan, Running for 5s, Merging 12 audio files")
    ).toBeTruthy();
  });

  it("label stays unchanged when showDescription is on but the task has no description", async () => {
    await render(<TaskProgressRow task={makeTask() as any} showDescription />);
    expect(screen.getByLabelText("Library scan, Running for 5s")).toBeTruthy();
  });
});
