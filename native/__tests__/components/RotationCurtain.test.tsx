import React from "react";
import { Dimensions } from "react-native";
import { render, act } from "@testing-library/react-native";
import * as Reanimated from "react-native-reanimated";
import RotationCurtain from "../../components/RotationCurtain";

const mockUseReducedMotion = Reanimated.useReducedMotion as jest.Mock;

type DimHandler = (e: { window: { width: number; height: number } }) => void;

describe("RotationCurtain", () => {
  afterEach(() => {
    mockUseReducedMotion.mockReturnValue(false);
    jest.restoreAllMocks();
  });

  function mountAndCaptureHandler() {
    let handler: DimHandler | undefined;
    jest
      .spyOn(Dimensions, "addEventListener")
      .mockImplementation((_type: any, cb: any) => {
        handler = cb;
        return { remove: jest.fn() } as any;
      });
    // Seed as portrait so a landscape event is a real orientation change.
    jest.spyOn(Dimensions, "get").mockReturnValue({ width: 400, height: 800 } as any);
    return {
      handler: () => handler,
    };
  }

  it("runs the crossfade on rotation when motion is allowed", async () => {
    const withDelay = jest.spyOn(Reanimated, "withDelay");
    const { handler } = mountAndCaptureHandler();
    await render(<RotationCurtain />);
    await act(async () => {
      handler()?.({ window: { width: 800, height: 400 } });
    });
    expect(withDelay).toHaveBeenCalled();
  });

  it("reduced motion: skips the crossfade on rotation", async () => {
    mockUseReducedMotion.mockReturnValue(true);
    const withDelay = jest.spyOn(Reanimated, "withDelay");
    const { handler } = mountAndCaptureHandler();
    await render(<RotationCurtain />);
    await act(async () => {
      handler()?.({ window: { width: 800, height: 400 } });
    });
    expect(withDelay).not.toHaveBeenCalled();
  });
});
