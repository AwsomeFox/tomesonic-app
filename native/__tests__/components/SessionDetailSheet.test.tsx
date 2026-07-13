/**
 * SessionDetailSheet — the read-only detail sheet opened from a session row.
 * Pins the metadata rows (user/device/client/play-method/times/progress/id),
 * the play-method int→label mapping, and the Open-chip-only-when-isOpen branch.
 */
import React from "react";
import { render, screen } from "@testing-library/react-native";
import SessionDetailSheet from "../../components/SessionDetailSheet";

const SESSION: any = {
  id: "s1",
  userId: "u2",
  libraryItemId: "li-abc",
  displayTitle: "Book One",
  displayAuthor: "Jane Author",
  duration: 3600,
  playMethod: 2,
  mediaPlayer: "TomeSonic",
  deviceInfo: { deviceName: "Pixel 8", clientName: "TomeSonic App", clientVersion: "1.4.0" },
  timeListening: 1800,
  startTime: 0,
  currentTime: 900,
  startedAt: 1750000000000,
  updatedAt: 1750000360000,
  user: { id: "u2", username: "joe" },
};

it("renders the session metadata rows", async () => {
  await render(<SessionDetailSheet session={SESSION} onClose={() => {}} />);

  // Title + author header.
  expect(await screen.findByText("Book One")).toBeTruthy();
  expect(screen.getByText("Jane Author")).toBeTruthy();

  // Labelled metadata rows.
  expect(screen.getByText("User")).toBeTruthy();
  expect(screen.getByText("joe")).toBeTruthy();
  expect(screen.getByText("Device")).toBeTruthy();
  expect(screen.getByText("TomeSonic")).toBeTruthy();
  // Client + version folded into one line.
  expect(screen.getByText("TomeSonic App 1.4.0")).toBeTruthy();
  // Play method int → label.
  expect(screen.getByText("Play method")).toBeTruthy();
  expect(screen.getByText("Transcode")).toBeTruthy();
  // Times + progress.
  expect(screen.getByText("Listening time")).toBeTruthy();
  expect(screen.getByText("30m")).toBeTruthy();
  expect(screen.getByText("15m of 1h 0m")).toBeTruthy();
  // Library item id.
  expect(screen.getByText("li-abc")).toBeTruthy();
});

it("shows the Open chip only when isOpen is true", async () => {
  const { rerender } = await render(<SessionDetailSheet session={SESSION} isOpen={false} onClose={() => {}} />);
  await screen.findByText("Book One");
  expect(screen.queryByText("Open")).toBeNull();

  await rerender(<SessionDetailSheet session={SESSION} isOpen onClose={() => {}} />);
  expect(await screen.findByText("Open")).toBeTruthy();
});

it("falls back to deviceInfo when mediaPlayer is absent, and hides play-method when unset", async () => {
  const noPlayer: any = {
    ...SESSION,
    mediaPlayer: undefined,
    playMethod: undefined,
    deviceInfo: { deviceName: "Fire HD" },
  };
  await render(<SessionDetailSheet session={noPlayer} onClose={() => {}} />);

  expect(await screen.findByText("Fire HD")).toBeTruthy();
  expect(screen.queryByText("Play method")).toBeNull();
});
