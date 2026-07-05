import * as Haptics from "expo-haptics";
import { useUserStore } from "../store/useUserStore";

// Fires a haptic tap at the intensity configured in Settings ("Haptic
// feedback"). No-op when set to "off". Safe to call from anywhere.
export function haptic() {
  const level = useUserStore.getState().settings?.hapticFeedback || "medium";
  if (level === "off") return;
  const style =
    level === "light"
      ? Haptics.ImpactFeedbackStyle.Light
      : level === "heavy"
      ? Haptics.ImpactFeedbackStyle.Heavy
      : Haptics.ImpactFeedbackStyle.Medium;
  Haptics.impactAsync(style).catch(() => {});
}
