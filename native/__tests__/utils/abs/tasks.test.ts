/**
 * utils/abs/tasks — ref-counted poller lifecycle with fake timers:
 * start-on-first/stop-on-last subscriber, AppState pause, in-flight guard,
 * adaptive cadence, failure backoff, snapshot retention, watch helper.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { AppState } from "react-native";
import { api } from "../../../utils/api";
import {
  subscribeTasks,
  getTasksSnapshot,
  fetchTasksOnce,
  startTaskWatch,
  _resetTasksForTest,
} from "../../../utils/abs/tasks";
import { AbsError } from "../../../utils/abs/errors";

const runningTask = (id = "t1") => ({
  id,
  action: "library-scan",
  data: {},
  title: "Scan",
  error: null,
  isFailed: false,
  isFinished: false,
  startedAt: 1,
  finishedAt: null,
});
const finishedTask = (id = "t1") => ({ ...runningTask(id), isFinished: true, finishedAt: 2 });

let appStateHandlers: Array<(s: string) => void>;

beforeEach(() => {
  jest.useFakeTimers();
  _resetTasksForTest();
  jest.mocked(api.get).mockReset();
  appStateHandlers = [];
  (AppState as any).currentState = "active";
  jest.spyOn(AppState, "addEventListener").mockImplementation(((event: string, handler: any) => {
    appStateHandlers.push(handler);
    return { remove: jest.fn() };
  }) as any);
});

afterEach(() => {
  _resetTasksForTest();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const flush = async () => {
  // Drain the microtask queue so awaited api.get results propagate.
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("subscribe lifecycle", () => {
  it("starts polling on the first subscriber (immediate tick) and notifies listeners", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [runningTask()] } } as any);
    const listener = jest.fn();
    subscribeTasks(listener);
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith("/api/tasks");
    expect(listener).toHaveBeenCalledWith([runningTask()]);
    expect(getTasksSnapshot()).toEqual([runningTask()]);
  });

  it("a second subscriber does NOT start a second poll loop", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [] } } as any);
    subscribeTasks(jest.fn());
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
    subscribeTasks(jest.fn());
    await flush();
    // No extra immediate tick for subscriber #2.
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the LAST subscriber unsubscribes (but not before)", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [runningTask()] } } as any);
    const un1 = subscribeTasks(jest.fn());
    const un2 = subscribeTasks(jest.fn());
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);

    un1();
    await jest.advanceTimersByTimeAsync(3000); // running task → 3s cadence
    expect(api.get).toHaveBeenCalledTimes(2); // still polling for subscriber 2

    un2();
    await jest.advanceTimersByTimeAsync(60000);
    expect(api.get).toHaveBeenCalledTimes(2); // fully stopped
  });

  it("unsubscribe is idempotent — a double call can't tear down a live poller", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [runningTask()] } } as any);
    const un1 = subscribeTasks(jest.fn());
    await flush();
    un1();
    subscribeTasks(jest.fn()); // new subscriber restarts the poller
    await flush();
    const callsAfterRestart = jest.mocked(api.get).mock.calls.length;
    un1(); // stale double-unsubscribe
    await jest.advanceTimersByTimeAsync(3000);
    expect(jest.mocked(api.get).mock.calls.length).toBeGreaterThan(callsAfterRestart);
  });
});

describe("adaptive cadence", () => {
  it("polls every 3s while a task is unfinished, 10s when idle", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [runningTask()] } } as any);
    subscribeTasks(jest.fn());
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(3000);
    expect(api.get).toHaveBeenCalledTimes(2);

    // All tasks finish → cadence relaxes to 10s.
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [finishedTask()] } } as any);
    await jest.advanceTimersByTimeAsync(3000);
    expect(api.get).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(3000); // only 3s — no tick yet at idle cadence
    expect(api.get).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(7000); // 10s total
    expect(api.get).toHaveBeenCalledTimes(4);
  });
});

describe("AppState pause", () => {
  it("pauses while backgrounded and ticks immediately on foreground", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [runningTask()] } } as any);
    subscribeTasks(jest.fn());
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);

    (AppState as any).currentState = "background";
    appStateHandlers.forEach((h) => h("background"));
    await jest.advanceTimersByTimeAsync(60000);
    expect(api.get).toHaveBeenCalledTimes(1); // fully paused

    (AppState as any).currentState = "active";
    appStateHandlers.forEach((h) => h("active"));
    await flush();
    expect(api.get).toHaveBeenCalledTimes(2); // immediate foreground refresh
    await jest.advanceTimersByTimeAsync(3000);
    expect(api.get).toHaveBeenCalledTimes(3); // cadence resumed
  });

  it("does not start ticking when subscribed while backgrounded", async () => {
    (AppState as any).currentState = "background";
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [] } } as any);
    subscribeTasks(jest.fn());
    await flush();
    await jest.advanceTimersByTimeAsync(60000);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe("in-flight guard", () => {
  it("skips a tick while a fetch is still in flight (no stacked requests)", async () => {
    let resolveFirst: (v: any) => void;
    jest
      .mocked(api.get)
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)) as any)
      .mockResolvedValue({ data: { tasks: [] } } as any);

    subscribeTasks(jest.fn());
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1); // slow request in flight

    // A foreground event tries to tick while in flight — guard skips it.
    appStateHandlers.forEach((h) => h("active"));
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);

    resolveFirst!({ data: { tasks: [runningTask()] } });
    await flush();
    await jest.advanceTimersByTimeAsync(3000);
    expect(api.get).toHaveBeenCalledTimes(2); // normal cadence resumed after it landed
  });
});

describe("failure handling", () => {
  it("swallows poll errors, keeps the last snapshot, and backs off to 30s after 3 consecutive failures", async () => {
    jest.mocked(api.get).mockResolvedValueOnce({ data: { tasks: [finishedTask()] } } as any);
    const listener = jest.fn();
    subscribeTasks(listener);
    await flush();
    expect(getTasksSnapshot()).toEqual([finishedTask()]);

    jest.mocked(api.get).mockRejectedValue({ message: "net down" });
    await jest.advanceTimersByTimeAsync(10000); // failure 1 (idle cadence)
    await jest.advanceTimersByTimeAsync(10000); // failure 2
    await jest.advanceTimersByTimeAsync(10000); // failure 3 → backoff engaged
    expect(api.get).toHaveBeenCalledTimes(4);
    expect(getTasksSnapshot()).toEqual([finishedTask()]); // snapshot retained
    expect(listener).toHaveBeenCalledTimes(1); // listeners not spammed on failure

    await jest.advanceTimersByTimeAsync(10000); // inside backoff window — no tick
    expect(api.get).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(20000); // 30s total
    expect(api.get).toHaveBeenCalledTimes(5);

    // A success resets the failure count → normal cadence again.
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [finishedTask()] } } as any);
    await jest.advanceTimersByTimeAsync(30000);
    expect(api.get).toHaveBeenCalledTimes(6);
    await jest.advanceTimersByTimeAsync(10000); // back at idle 10s cadence
    expect(api.get).toHaveBeenCalledTimes(7);
  });

  it("a degenerate 200 without a tasks array counts as a failure and keeps the snapshot", async () => {
    jest.mocked(api.get).mockResolvedValueOnce({ data: { tasks: [finishedTask()] } } as any);
    subscribeTasks(jest.fn());
    await flush();
    jest.mocked(api.get).mockResolvedValue({ data: "<html>proxy</html>" } as any);
    await jest.advanceTimersByTimeAsync(10000);
    expect(getTasksSnapshot()).toEqual([finishedTask()]);
  });
});

describe("fetchTasksOnce", () => {
  it("returns the tasks, updates the shared snapshot, and notifies subscribers", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [runningTask("x")] } } as any);
    const listener = jest.fn();
    subscribeTasks(listener);
    await flush();
    listener.mockClear();
    await expect(fetchTasksOnce()).resolves.toEqual([runningTask("x")]);
    expect(getTasksSnapshot()).toEqual([runningTask("x")]);
    expect(listener).toHaveBeenCalledWith([runningTask("x")]);
  });

  it("THROWS AbsError on failure (unlike the swallow-by-design poll loop)", async () => {
    jest.mocked(api.get).mockRejectedValue({ response: { status: 403 } });
    const err = await fetchTasksOnce().catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("forbidden");
  });
});

describe("startTaskWatch", () => {
  // Upstream ABS removes a task from GET /api/tasks the moment it completes
  // (failures too) — the watch's PRIMARY completion signal is disappearance.
  const failedTask = (id = "t1") => ({
    ...runningTask(id),
    isFailed: true,
    isFinished: true,
    error: "Folder not found",
    finishedAt: 2,
  });

  it("resolves with inferredCompletion when a tracked unfinished task VANISHES from a later snapshot", async () => {
    jest
      .mocked(api.get)
      .mockResolvedValueOnce({ data: { tasks: [runningTask("scan1")] } } as any)
      .mockResolvedValue({ data: { tasks: [] } } as any); // server removed it on completion

    let resolved: any = "pending";
    startTaskWatch((t) => t.id === "scan1").then((r) => (resolved = r));
    await flush();
    expect(resolved).toBe("pending"); // seen unfinished → tracked

    await jest.advanceTimersByTimeAsync(3000); // next poll: task gone
    await flush();
    expect(resolved).toEqual({ ...runningTask("scan1"), inferredCompletion: true });
    // No exit status when inferred — isFinished stays as last seen.
    expect(resolved.isFinished).toBe(false);
    expect(resolved.isFailed).toBe(false);
    // Watch unsubscribed itself → poller stopped (no other subscribers).
    const calls = jest.mocked(api.get).mock.calls.length;
    await jest.advanceTimersByTimeAsync(60000);
    expect(jest.mocked(api.get).mock.calls.length).toBe(calls);
  });

  it("still resolves normally when a later snapshot shows the task FINISHED (retaining servers)", async () => {
    jest
      .mocked(api.get)
      .mockResolvedValueOnce({ data: { tasks: [runningTask("scan1")] } } as any)
      .mockResolvedValue({ data: { tasks: [finishedTask("scan1")] } } as any);

    let resolved: any = "pending";
    startTaskWatch((t) => t.id === "scan1").then((r) => (resolved = r));
    await flush();
    expect(resolved).toBe("pending"); // still running

    await jest.advanceTimersByTimeAsync(3000); // active cadence poll finds it finished
    await flush();
    expect(resolved).toEqual(finishedTask("scan1"));
    expect(resolved.inferredCompletion).toBeUndefined();
  });

  it("a FAILURE snapshot caught before removal resolves with isFailed/error intact", async () => {
    jest
      .mocked(api.get)
      .mockResolvedValueOnce({ data: { tasks: [runningTask("scan1")] } } as any)
      .mockResolvedValue({ data: { tasks: [failedTask("scan1")] } } as any);

    let resolved: any = "pending";
    startTaskWatch((t) => t.id === "scan1").then((r) => (resolved = r));
    await flush();
    await jest.advanceTimersByTimeAsync(3000);
    await flush();
    expect(resolved.isFailed).toBe(true);
    expect(resolved.error).toBe("Folder not found");
    expect(resolved.inferredCompletion).toBeUndefined();
  });

  it("does NOT resolve from a task already finished in the INITIAL snapshot (stale completion)", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [finishedTask("done")] } } as any);
    await fetchTasksOnce(); // module snapshot now already holds the finished task

    let resolved: any = "pending";
    startTaskWatch((t) => t.id === "done", 30000).then((r) => (resolved = r));
    await flush();
    expect(resolved).toBe("pending"); // gated: finished-at-start can't satisfy a new watch

    // Even later polls that STILL show it finished can't satisfy the watch…
    await jest.advanceTimersByTimeAsync(10000); // idle cadence tick
    await flush();
    expect(resolved).toBe("pending");

    // …only the timeout ends it.
    await jest.advanceTimersByTimeAsync(20001);
    await flush();
    expect(resolved).toBeNull();
  });

  it("resolves null on timeout", async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { tasks: [runningTask("other")] } } as any);
    let resolved: any = "pending";
    startTaskWatch((t) => t.id === "never", 5000).then((r) => (resolved = r));
    await jest.advanceTimersByTimeAsync(5001);
    await flush();
    expect(resolved).toBeNull();
  });
});
