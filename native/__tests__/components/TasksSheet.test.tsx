/**
 * TasksSheet — the full server-activity bottom sheet behind TaskActivityCard's
 * "View all" (issue #64). Purely presentational and strictly read-only: ABS
 * v2.35.1 exposes no task-cancel REST endpoint, so the suite pins the ABSENCE
 * of any cancel affordance alongside the unfiltered task list (finished tasks
 * included), the description line, and the empty state.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import TasksSheet from "../../components/TasksSheet";

const makeTask = (overrides: Record<string, any> = {}) => ({
  id: "t1",
  action: "library-scan",
  data: {},
  title: "Scanning 'Audiobooks'",
  description: undefined,
  error: null,
  isFailed: false,
  isFinished: false,
  startedAt: Date.now() - 5_000,
  finishedAt: null,
  ...overrides,
});

const TASKS: any[] = [
  makeTask({ id: "run1", title: "Running scan", description: "Scanning 42 folders" }),
  makeTask({
    id: "fail1",
    action: "encode-m4b",
    title: "Failed encode",
    isFinished: true,
    isFailed: true,
    error: "ffmpeg exited",
  }),
  makeTask({
    id: "done1",
    action: "embed-metadata",
    title: "Finished embed",
    isFinished: true,
    finishedAt: Date.now(),
  }),
];

it("renders EVERY task unfiltered — running, failed, AND successfully finished", async () => {
  await render(<TasksSheet visible tasks={TASKS} onClose={() => {}} />);

  expect(await screen.findByText("Server activity")).toBeTruthy();
  expect(screen.getByText("Running scan")).toBeTruthy();
  expect(screen.getByText("Failed encode")).toBeTruthy();
  // Unlike TaskActivityCard, a successfully finished task still shows here
  // (until ABS drops it from the snapshot — there is no durable history).
  expect(screen.getByText("Finished embed")).toBeTruthy();
  // Header summary: 1 running · 1 failed.
  expect(screen.getByText("1 running · 1 failed")).toBeTruthy();
  // Failed row carries its error copy.
  expect(screen.getByText("ffmpeg exited")).toBeTruthy();
});

it("shows the task description as a secondary line (showDescription rows)", async () => {
  await render(<TasksSheet visible tasks={TASKS} onClose={() => {}} />);
  expect(await screen.findByText("Scanning 42 folders")).toBeTruthy();
});

it("offers NO cancel affordance — ABS has no task-cancel endpoint", async () => {
  await render(<TasksSheet visible tasks={TASKS} onClose={() => {}} />);
  await screen.findByText("Server activity");

  expect(screen.queryByText(/cancel/i)).toBeNull();
  expect(screen.queryByLabelText(/cancel/i)).toBeNull();
});

it("renders the empty state when the snapshot has no tasks", async () => {
  await render(<TasksSheet visible tasks={[]} onClose={() => {}} />);

  expect(await screen.findByText("No server activity right now.")).toBeTruthy();
  // No summary chatter next to the header when nothing is running/failed.
  expect(screen.queryByText(/running/)).toBeNull();
});

it("renders nothing while hidden and calls onClose from the backdrop", async () => {
  const onClose = jest.fn();
  const { rerender } = await render(<TasksSheet visible={false} tasks={TASKS} onClose={onClose} />);
  expect(screen.queryByText("Server activity")).toBeNull();

  await rerender(<TasksSheet visible tasks={TASKS} onClose={onClose} />);
  expect(await screen.findByText("Server activity")).toBeTruthy();

  await fireEvent.press(screen.getByTestId("sheet-backdrop", { includeHiddenElements: true }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
