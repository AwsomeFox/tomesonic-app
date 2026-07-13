import { create } from "zustand";

// A themed, in-app Material 3 snackbar host state — the transient-feedback
// sibling of useDialogStore (which owns blocking alerts). showSnackbar() drives
// the single <AppSnackbar/> mounted once in AppShell. Snackbars are
// single-instance: a new show REPLACES whatever is currently visible (M3
// behavior — snackbars never stack), and each show carries a monotonically
// increasing key so the host can restart its auto-dismiss timer / enter
// animation even when two consecutive messages are identical.

export interface SnackbarAction {
  label: string;
  onPress: () => void;
}

export interface SnackbarOptions {
  message: string;
  /** Optional single action button (M3 snackbars have at most one). */
  action?: SnackbarAction;
  /** Auto-dismiss delay. Defaults to 3000ms. */
  durationMs?: number;
}

export interface SnackbarEntry {
  message: string;
  action?: SnackbarAction;
  durationMs: number;
  /** Unique per show() call — lets the host distinguish replacements. */
  key: number;
}

interface SnackbarState {
  current: SnackbarEntry | null;
  show: (opts: SnackbarOptions) => void;
  dismiss: () => void;
}

let nextKey = 1;

export const useSnackbarStore = create<SnackbarState>((set) => ({
  current: null,
  show: (opts) =>
    set({
      current: {
        message: opts.message,
        action: opts.action,
        durationMs: opts.durationMs ?? 3000,
        key: nextKey++,
      },
    }),
  dismiss: () => set({ current: null }),
}));

/** Imperative helper, mirroring showAppDialog(). */
export function showSnackbar(opts: SnackbarOptions) {
  useSnackbarStore.getState().show(opts);
}
