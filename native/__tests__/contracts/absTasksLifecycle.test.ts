/**
 * TASK-POLLER LIFECYCLE CONTRACT.
 *
 * The tasks poller (utils/abs/tasks) is the app's ONLY view of server-side
 * background work (scans, encodes, embeds) — the web client gets socket
 * pushes, this app polls GET /api/tasks. Because it's a global, ref-counted
 * singleton driven by screen mounts, TWO invariants keep it from becoming a
 * battery/server drain, and both live at module seams no unit owns end-to-end:
 *
 *   1. ZERO SUBSCRIBERS ⇒ ZERO REQUESTS. Every subscribe returns an
 *      unsubscribe; when the LAST one runs, the poll loop must fully stop.
 *      A leaked timer here polls the server forever from a closed screen —
 *      invisible in the UI, visible in the server logs.
 *   2. BACKGROUND ⇒ PAUSED. AppState leaving "active" must halt scheduling
 *      even with live subscribers (mounted screens keep their subscriptions
 *      while backgrounded); returning to "active" resumes with an immediate
 *      refresh.
 *
 * These are pinned here, separate from the behavioral unit tests, as the
 * tripwire: a refactor of tasks.ts may reorganize anything else, but a change
 * that breaks either invariant must fail THIS file. Update it only with a
 * deliberate lifecycle redesign, never to make a refactor pass.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { AppState } from "react-native";
import { api } from "../../utils/api";
import { subscribeTasks, _resetTasksForTest } from "../../utils/abs/tasks";

const RUNNING = {
  id: "t1",
  action: "library-scan",
  data: {},
  title: "Scan",
  error: null,
  isFailed: false,
  isFinished: false,
  startedAt: 1,
  finishedAt: null,
};

let appStateHandlers: Array<(s: string) => void>;

beforeEach(() => {
  jest.useFakeTimers();
  _resetTasksForTest();
  appStateHandlers = [];
  (AppState as any).currentState = "active";
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, handler: any) => {
    appStateHandlers.push(handler);
    return { remove: jest.fn() };
  }) as any);
  jest.mocked(api.get).mockReset().mockResolvedValue({ data: { tasks: [RUNNING] } } as any);
});

afterEach(() => {
  _resetTasksForTest();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

it("INVARIANT 1: zero subscribers ⇒ zero requests (stop on last unsubscribe, restart on next subscribe)", async () => {
  // No subscribers yet: nothing may poll, ever.
  await jest.advanceTimersByTimeAsync(120000);
  expect(api.get).not.toHaveBeenCalled();

  const unA = subscribeTasks(jest.fn());
  const unB = subscribeTasks(jest.fn());
  await flush();
  expect(api.get).toHaveBeenCalledTimes(1); // one loop for both subscribers

  unA();
  await jest.advanceTimersByTimeAsync(3000);
  expect(api.get).toHaveBeenCalledTimes(2); // one subscriber left → still polling

  unB();
  const callsAtStop = jest.mocked(api.get).mock.calls.length;
  await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(jest.mocked(api.get).mock.calls.length).toBe(callsAtStop); // FULLY stopped

  // And the stop must not be sticky: a new subscriber restarts the loop.
  subscribeTasks(jest.fn());
  await flush();
  expect(jest.mocked(api.get).mock.calls.length).toBe(callsAtStop + 1);
});

it("INVARIANT 2: AppState !== active ⇒ paused; active resumes with an immediate refresh", async () => {
  subscribeTasks(jest.fn());
  await flush();
  expect(api.get).toHaveBeenCalledTimes(1);

  // Background with a LIVE subscriber: scheduling must halt completely.
  (AppState as any).currentState = "background";
  appStateHandlers.forEach((h) => h("background"));
  await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(api.get).toHaveBeenCalledTimes(1);

  // Foreground: immediate refresh, then the cadence resumes.
  (AppState as any).currentState = "active";
  appStateHandlers.forEach((h) => h("active"));
  await flush();
  expect(api.get).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(3000);
  expect(api.get).toHaveBeenCalledTimes(3);
});
