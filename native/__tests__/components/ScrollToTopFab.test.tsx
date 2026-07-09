import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import ScrollToTopFab from "../../components/ScrollToTopFab";

describe("ScrollToTopFab", () => {
  it("is not mounted while hidden", async () => {
    await render(<ScrollToTopFab visible={false} onPress={jest.fn()} bottom={16} />);
    expect(screen.queryByLabelText("Scroll to top")).toBeNull();
  });

  it("springs in when it becomes visible and fires onPress", async () => {
    const onPress = jest.fn();
    const { rerender } = await render(
      <ScrollToTopFab visible={false} onPress={onPress} bottom={16} />
    );
    expect(screen.queryByLabelText("Scroll to top")).toBeNull();

    await act(async () => {
      rerender(<ScrollToTopFab visible={true} onPress={onPress} bottom={16} />);
    });
    const fab = screen.getByLabelText("Scroll to top");
    expect(fab).toBeTruthy();

    await fireEvent.press(fab);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("stays mounted through the collapse animation, then unmounts", async () => {
    const { rerender } = await render(
      <ScrollToTopFab visible={true} onPress={jest.fn()} bottom={16} />
    );
    expect(screen.getByLabelText("Scroll to top")).toBeTruthy();

    // Hiding it runs the collapse timing; its completion callback unmounts.
    await act(async () => {
      rerender(<ScrollToTopFab visible={false} onPress={jest.fn()} bottom={16} />);
    });
    await waitFor(() => expect(screen.queryByLabelText("Scroll to top")).toBeNull());
  });

  it("clips its ripple to the rounded shape (overflow hidden on the pressable)", async () => {
    await render(
      <ScrollToTopFab visible={true} onPress={jest.fn()} bottom={16} testID="fab-btn" />
    );
    const pressable = screen.getByTestId("fab-btn");
    const flat = Array.isArray(pressable.props.style)
      ? Object.assign({}, ...pressable.props.style)
      : pressable.props.style;
    expect(flat.overflow).toBe("hidden");
    expect(flat.borderRadius).toBe(16);
  });
});
