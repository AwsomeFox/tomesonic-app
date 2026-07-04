import * as Haptics from "expo-haptics";
import { haptic } from "../../utils/haptics";
import { useUserStore } from "../../store/useUserStore";

const initialState = useUserStore.getState();

const setLevel = (level: any) =>
  useUserStore.setState({
    settings: { ...(initialState.settings as any), hapticFeedback: level },
  } as any);

beforeEach(() => {
  useUserStore.setState(initialState, true);
});

describe("haptic", () => {
  it("fires a medium impact by default", () => {
    setLevel(undefined);
    haptic();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it("fires the configured intensity", () => {
    setLevel("light");
    haptic();
    expect(Haptics.impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Light);

    setLevel("heavy");
    haptic();
    expect(Haptics.impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Heavy);

    setLevel("medium");
    haptic();
    expect(Haptics.impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it("is a no-op when set to off", () => {
    setLevel("off");
    haptic();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  it("swallows rejections from the native call", () => {
    (Haptics.impactAsync as jest.Mock).mockRejectedValueOnce(new Error("no motor"));
    setLevel("medium");
    expect(() => haptic()).not.toThrow();
  });
});
