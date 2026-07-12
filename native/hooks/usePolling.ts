import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "@react-navigation/native";

const MAX_BACKOFF_MS = 60_000;

export interface UsePollingOptions {
  intervalMs: number;
  /** Gate polling on top of focus/app-state (e.g. only while an admin). */
  enabled?: boolean;
}

export interface UsePollingResult {
  /** Epoch ms of the last SUCCESSFUL fn() completion, null before the first. */
  lastUpdatedAt: number | null;
  /** True while an fn() call is in flight. */
  isPolling: boolean;
  /** Manual immediate poll (in-flight guarded); reschedules the next tick. */
  refresh: () => Promise<void>;
}

/**
 * Battery-conscious polling: runs `fn` every `intervalMs` ONLY while the
 * screen is focused (useFocusEffect) AND the app is foregrounded (AppState
 * "active") AND `enabled`. The timer chain is torn down on blur/background/
 * unmount — no timer ever survives those, which is the battery contract.
 *
 * - In-flight guard: a tick that lands while the previous fn() is still
 *   pending is skipped (rescheduled), so slow requests never pile up.
 * - Failure backoff: each consecutive rejection doubles the next delay
 *   (intervalMs × 2^failures), capped at 60s; one success resets it.
 * - Timeout chain (not setInterval) so the backoff can stretch per tick.
 */
export function usePolling(
  fn: () => Promise<void>,
  { intervalMs, enabled = true }: UsePollingOptions
): UsePollingResult {
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  // Everything the timer chain reads lives in refs so the focus callback and
  // AppState listener can stay stable across renders.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const enabledRef = useRef(enabled);
  const focusedRef = useRef(false);
  // Treat anything but an explicit background/inactive as active: on some
  // platforms (and under jest) currentState is missing or not a string yet.
  const appActiveRef = useRef(
    AppState.currentState !== "background" && AppState.currentState !== "inactive"
  );
  const inFlightRef = useRef(false);
  const failuresRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const canPoll = useCallback(
    () => mountedRef.current && focusedRef.current && appActiveRef.current && enabledRef.current,
    []
  );

  // Run fn once (in-flight guarded), then arm the next tick. `gated` ticks
  // bail when unfocused/backgrounded/disabled; refresh() passes gated=false so
  // an explicit user pull always fetches.
  const execute = useCallback(
    async (gated: boolean) => {
      if (gated && !canPoll()) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      if (mountedRef.current) setIsPolling(true);
      try {
        await fnRef.current();
        failuresRef.current = 0;
        if (mountedRef.current) setLastUpdatedAt(Date.now());
      } catch {
        failuresRef.current += 1;
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setIsPolling(false);
        schedule();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canPoll]
  );

  const schedule = useCallback(() => {
    clearTimer();
    if (!canPoll()) return;
    const delay = Math.min(intervalRef.current * 2 ** failuresRef.current, MAX_BACKOFF_MS);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!canPoll()) return;
      if (inFlightRef.current) {
        // Previous fn still pending — skip this tick, try again next interval.
        schedule();
        return;
      }
      void execute(true);
    }, delay);
  }, [canPoll, clearTimer, execute]);

  // Focus gate: poll immediately on focus, tear the chain down on blur.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (canPoll()) void execute(true);
      return () => {
        focusedRef.current = false;
        clearTimer();
      };
    }, [canPoll, clearTimer, execute])
  );

  // AppState gate: pause in background, resume (with a fresh poll) on return.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      const nowActive = state === "active";
      const wasActive = appActiveRef.current;
      appActiveRef.current = nowActive;
      if (!nowActive) {
        clearTimer();
      } else if (!wasActive && canPoll()) {
        void execute(true);
      }
    });
    return () => sub.remove();
  }, [canPoll, clearTimer, execute]);

  // `enabled` gate: flipping off kills the chain; flipping on restarts it.
  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      clearTimer();
    } else if (canPoll() && timerRef.current == null && !inFlightRef.current) {
      void execute(true);
    }
  }, [enabled, canPoll, clearTimer, execute]);

  // Unmount: nothing may keep ticking.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const refresh = useCallback(async () => {
    clearTimer();
    await execute(false);
  }, [clearTimer, execute]);

  return { lastUpdatedAt, isPolling, refresh };
}
