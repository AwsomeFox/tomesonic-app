import { create } from "zustand";

// A themed, in-app replacement for React Native's native Alert.alert. The OS
// alert ignores the app's Material 3 dynamic theme (grey surface, teal buttons);
// showAppDialog() drives the themed <AppDialog/> host mounted once in AppShell.
// The API deliberately mirrors Alert.alert so migrating call sites is mechanical.

export type AppDialogButtonStyle = "default" | "cancel" | "destructive";

export interface AppDialogButton {
  text: string;
  onPress?: () => void;
  style?: AppDialogButtonStyle;
}

/**
 * Typed-confirm gate for high-stakes destructive dialogs: when present,
 * AppDialog renders a TextInput between the message and the buttons, and the
 * LAST button (the destructive/confirm action by convention) stays disabled
 * until the input matches requiredText.
 */
export interface AppDialogConfirmInput {
  placeholder: string;
  requiredText: string;
  /** Defaults to false — matching is case-insensitive unless set. */
  caseSensitive?: boolean;
}

export interface AppDialogOptions {
  title?: string;
  message?: string;
  /** Defaults to a single "OK" button, matching Alert.alert. */
  buttons?: AppDialogButton[];
  /** When false, the scrim/back-button can't dismiss without choosing a button. */
  cancelable?: boolean;
  /** Require typing requiredText before the last (confirm) button enables. */
  confirmInput?: AppDialogConfirmInput;
}

interface DialogState {
  current: (AppDialogOptions & { buttons: AppDialogButton[] }) | null;
  show: (opts: AppDialogOptions) => void;
  dismiss: () => void;
}

export const useDialogStore = create<DialogState>((set) => ({
  current: null,
  show: (opts) =>
    set({
      current: {
        ...opts,
        buttons: opts.buttons && opts.buttons.length ? opts.buttons : [{ text: "OK" }],
      },
    }),
  dismiss: () => set({ current: null }),
}));

/**
 * Themed drop-in for `Alert.alert(title, message, buttons)`:
 *   Alert.alert("Delete?", "Are you sure?", [{text:"Cancel",style:"cancel"},{text:"Delete",style:"destructive",onPress}])
 *   → showAppDialog({ title:"Delete?", message:"Are you sure?", buttons:[...] })
 */
export function showAppDialog(opts: AppDialogOptions) {
  useDialogStore.getState().show(opts);
}
