import React from "react";
import { Animated } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { useReducedMotion } from "react-native-reanimated";
import ResultBurst from "../../components/ResultBurst";

const mockUseReducedMotion = useReducedMotion as jest.Mock;

describe("ResultBurst", () => {
  afterEach(() => {
    mockUseReducedMotion.mockReturnValue(false);
  });

  it("runs the expressive burst when motion is allowed", async () => {
    const parallel = jest.spyOn(Animated, "parallel");
    try {
      await render(<ResultBurst ok title="Done" subtitle="All set" />);
      expect(screen.getByText("Done")).toBeTruthy();
      expect(screen.getByText("All set")).toBeTruthy();
      expect(parallel).toHaveBeenCalled();
    } finally {
      parallel.mockRestore();
    }
  });

  it("reduced motion: shows the final badge with no spring/halo/shake", async () => {
    mockUseReducedMotion.mockReturnValue(true);
    const parallel = jest.spyOn(Animated, "parallel");
    const spring = jest.spyOn(Animated, "spring");
    const sequence = jest.spyOn(Animated, "sequence");
    try {
      // Use the failure variant, which normally adds the head-shake sequence.
      await render(<ResultBurst ok={false} title="Nope" subtitle="Try again" />);
      expect(screen.getByText("Nope")).toBeTruthy();
      expect(parallel).not.toHaveBeenCalled();
      expect(spring).not.toHaveBeenCalled();
      expect(sequence).not.toHaveBeenCalled();
    } finally {
      parallel.mockRestore();
      spring.mockRestore();
      sequence.mockRestore();
    }
  });
});
