/**
 * EmptyState — shared "no content yet" treatment (filled circle icon + title +
 * optional message + optional action). Icons render as text glyphs in the test
 * environment (see jest.setup): clock → "schedule".
 */
import React from "react";
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import EmptyState from "../../components/EmptyState";

describe("EmptyState", () => {
  it("renders the icon glyph, title, and message", async () => {
    await render(
      <EmptyState icon="clock" title="No listening history yet" message="Sessions appear here as you listen." />
    );
    expect(screen.getByText("No listening history yet")).toBeTruthy();
    expect(screen.getByText("Sessions appear here as you listen.")).toBeTruthy();
    // clock → MaterialIcons "schedule"
    expect(screen.getByText("schedule")).toBeTruthy();
  });

  it("omits the message line when none is given", async () => {
    await render(<EmptyState icon="clock" title="No listening sessions yet" />);
    expect(screen.getByText("No listening sessions yet")).toBeTruthy();
    expect(screen.queryByText("Sessions appear here as you listen.")).toBeNull();
  });

  it("renders an optional action node", async () => {
    await render(
      <EmptyState icon="download" title="Nothing here" action={<Text>Retry</Text>} />
    );
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
