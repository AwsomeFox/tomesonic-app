/**
 * Ref-counted poller for the server task queue (GET /api/tasks — verified to
 * exist in the ABS ApiRouter; the web client gets pushes over its socket, but
 * this app has no socket connection, so we poll).
 *
 * Lifecycle:
 *  - The poller starts on the FIRST subscribeTasks() and stops on the LAST
 *    unsubscribe — screens simply subscribe on mount / unsubscribe on unmount.
 *  - AppState !== "active" pauses polling entirely (no background battery
 *    drain); returning to the foreground ticks immediately.
 *  - An in-flight guard skips overlapping ticks (a slow server never stacks
 *    requests).
 *  - Adaptive cadence: 3s while any task is unfinished (a scan/encode the
 *    user is watching), 10s when idle.
 *  - 3 consecutive failures back the poller off to 30s until a tick succeeds.
 *  - Poll errors are swallowed and the last good snapshot retained (the
 *    ONE deliberate error-swallow in utils/abs — a background poller has no
 *    caller to surface to; the explicit fetchTasksOnce() below throws).
 */
import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native";
import { api } from "../api";
import { normalizeAbsError } from "./errors";
import type { AbsTask } from "./types";

export type TasksListener = (tasks: AbsTask[]) => void;

const ACTIVE_INTERVAL_MS = 3000;
const IDLE_INTERVAL_MS = 10000;
const BACKOFF_INTERVAL_MS = 30000;
const BACKOFF_AFTER_FAILURES = 3;

let listeners = new Set<TasksListener>();
let snapshot: AbsTask[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let consecutiveFailures = 0;
let appStateSub: NativeEventSubscription | null = null;

function isAppActive(): boolean {
  // Jest's AppState mock can report null before any transition — treat
  // unknown as active so tests (and a cold start) poll.
  return AppState.currentState === "active" || AppState.currentState == null;
}

function currentIntervalMs(): number {
  if (consecutiveFailures >= BACKOFF_AFTER_FAILURES) return BACKOFF_INTERVAL_MS;
  const anyRunning = snapshot.some((t) => !t.isFinished);
  return anyRunning ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule() {
  clearTimer();
  if (!listeners.size || !isAppActive()) return;
  timer = setTimeout(tick, currentIntervalMs());
}

async function tick(): Promise<void> {
  // In-flight guard: a slow response must not stack a second request. The
  // finally block reschedules, so the skipped tick isn't lost.
  if (inFlight) {
    schedule();
    return;
  }
  if (!listeners.size || !isAppActive()) return;
  inFlight = true;
  try {
    const res = await api.get("/api/tasks");
    const tasks = res.data?.tasks;
    if (Array.isArray(tasks)) {
      snapshot = tasks;
      consecutiveFailures = 0;
      listeners.forEach((l) => {
        try {
          l(snapshot);
        } catch {
          // A misbehaving listener must not kill the poll loop.
        }
      });
    } else {
      // Degenerate 200 (proxy page) — treat as a failure, keep the snapshot.
      consecutiveFailures++;
    }
  } catch {
    // Swallowed by design (see header). Snapshot retained.
    consecutiveFailures++;
  } finally {
    inFlight = false;
    schedule();
  }
}

function onAppStateChange(state: AppStateStatus) {
  if (state === "active") {
    // Foregrounded: refresh immediately, then resume the cadence.
    if (listeners.size && !timer) void tick();
  } else {
    clearTimer();
  }
}

function start() {
  if (!appStateSub) {
    appStateSub = AppState.addEventListener("change", onAppStateChange);
  }
  if (isAppActive()) void tick();
}

function stop() {
  clearTimer();
  appStateSub?.remove();
  appStateSub = null;
}

/**
 * Subscribe to task-queue updates. The poller starts with the first
 * subscriber and stops with the last. The listener fires on every successful
 * poll (including the immediate one on subscribe/foreground).
 * Returns the unsubscribe function.
 */
export function subscribeTasks(listener: TasksListener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  let active = true;
  return () => {
    if (!active) return; // idempotent — double-unsubscribe must not stop a live poller
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** Last successfully fetched task list (empty until the first poll lands). */
export function getTasksSnapshot(): AbsTask[] {
  return snapshot;
}

/**
 * One explicit fetch, OUTSIDE the poller: throws AbsError on failure (unlike
 * the poll loop) so a user-initiated "refresh" can surface the problem.
 * A success also updates the shared snapshot + notifies subscribers.
 */
export async function fetchTasksOnce(): Promise<AbsTask[]> {
  try {
    const res = await api.get("/api/tasks");
    const tasks = res.data?.tasks;
    if (!Array.isArray(tasks)) return snapshot;
    snapshot = tasks;
    consecutiveFailures = 0;
    listeners.forEach((l) => {
      try {
        l(snapshot);
      } catch {}
    });
    return snapshot;
  } catch (e) {
    throw normalizeAbsError(e);
  }
}

/**
 * Watch for a task matching `match` to FINISH (isFinished true — check
 * task.isFailed/task.error yourself for the outcome). Resolves with the
 * finished task, or null when `timeoutMs` (default 5 minutes) elapses first.
 * Subscribes internally, so the poller runs (at its 3s "active" cadence,
 * since the watched task is unfinished) for the duration of the watch.
 */
export function startTaskWatch(
  match: (task: AbsTask) => boolean,
  timeoutMs: number = 5 * 60 * 1000
): Promise<AbsTask | null> {
  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: AbsTask | null) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      resolve(result);
    };
    const check = (tasks: AbsTask[]) => {
      const hit = tasks.find((t) => t.isFinished && match(t));
      if (hit) finish(hit);
    };
    const unsubscribe = subscribeTasks(check);
    timeout = setTimeout(() => finish(null), timeoutMs);
    // The current snapshot may already contain the finished task.
    check(snapshot);
  });
}

/** TEST ONLY: reset all module state (subscribers, snapshot, timers). */
export function _resetTasksForTest(): void {
  listeners = new Set();
  stop();
  snapshot = [];
  inFlight = false;
  consecutiveFailures = 0;
}
