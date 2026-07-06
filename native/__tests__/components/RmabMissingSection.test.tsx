import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import RmabMissingSection from "../../components/RmabMissingSection";
import { useRmabStore } from "../../store/useRmabStore";

jest.mock("../../utils/rmab", () => ({
  exchangeLoginToken: jest.fn(),
  readRmabConfig: jest.fn(() => null),
  writeRmabConfig: jest.fn(),
  rmabAuthMode: (cfg: any) => (cfg ? (cfg.apiToken ? "apiToken" : "jwt") : null),
  resolveRmabUrl: (p: any) => p || undefined,
  getMe: jest.fn(),
  createRequest: jest.fn(),
}));
import { createRequest } from "../../utils/rmab";

const initial = useRmabStore.getState();

const BOOKS = [
  { asin: "B01", title: "Book One", author: "A. Author", isAvailable: false },
  { asin: "B02", title: "Book Two", author: "A. Author", isAvailable: true }, // in library — filtered
  { asin: "B03", title: "Book Three", narrator: "N. Narrator", isAvailable: false, requestStatus: "pending" },
];

beforeEach(() => {
  useRmabStore.setState(initial, true);
  jest.clearAllMocks();
});

describe("RmabMissingSection", () => {
  it("renders nothing when RMAB is not configured (features stay hidden)", async () => {
    const fetchMissing = jest.fn();
    await render(<RmabMissingSection fetchMissing={fetchMissing} />);
    expect(fetchMissing).not.toHaveBeenCalled();
    expect(screen.queryByText("Missing from your library")).toBeNull();
  });

  it("lists only books NOT in the library, with request state from the server", async () => {
    useRmabStore.setState({ configured: true } as any);
    await render(<RmabMissingSection fetchMissing={jest.fn().mockResolvedValue(BOOKS)} />);

    await screen.findByText("Book One");
    // isAvailable book is filtered out entirely.
    expect(screen.queryByText("Book Two")).toBeNull();
    // Server-known request renders as the status chip, not a Request button.
    expect(screen.getByText("Book Three")).toBeTruthy();
    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.getByLabelText("Request Book One")).toBeTruthy();
    expect(screen.queryByLabelText("Request Book Three")).toBeNull();
  });

  it("requesting a book posts it and flips the button to Requested", async () => {
    useRmabStore.setState({ configured: true } as any);
    (createRequest as jest.Mock).mockResolvedValue({ id: "req1" });
    await render(
      <RmabMissingSection fetchMissing={jest.fn().mockResolvedValue([BOOKS[0]])} />
    );
    await screen.findByText("Book One");

    await fireEvent.press(screen.getByLabelText("Request Book One"));

    await waitFor(() => expect(createRequest).toHaveBeenCalled());
    expect((createRequest as jest.Mock).mock.calls[0][0]).toMatchObject({ asin: "B01" });
    await screen.findByText("Requested");
  });

  it("surfaces duplicate-request notices from the server", async () => {
    useRmabStore.setState({ configured: true } as any);
    (createRequest as jest.Mock).mockRejectedValue({
      response: { data: { error: "DuplicateRequest" } },
    });
    await render(
      <RmabMissingSection fetchMissing={jest.fn().mockResolvedValue([BOOKS[0]])} />
    );
    await screen.findByText("Book One");
    await fireEvent.press(screen.getByLabelText("Request Book One"));
    await screen.findByText("Already requested");
    // Duplicate still means "the server has it pending" — chip flips too.
    await screen.findByText("Requested");
  });

  it("renders nothing when every catalog hit is already in the library", async () => {
    useRmabStore.setState({ configured: true } as any);
    await render(
      <RmabMissingSection
        fetchMissing={jest.fn().mockResolvedValue([BOOKS[1]])}
        title="Missing from this series"
      />
    );
    await waitFor(() => expect(screen.queryByText("Missing from this series")).toBeNull());
  });

  it("tapping a row opens the book detail sheet with a Request action", async () => {
    useRmabStore.setState({ configured: true } as any);
    (createRequest as jest.Mock).mockResolvedValue({ id: "req1" });
    await render(<RmabMissingSection fetchMissing={jest.fn().mockResolvedValue([BOOKS[0]])} />);
    await screen.findByText("Book One");

    await fireEvent.press(screen.getByLabelText("Details for Book One"));
    // Sheet shows the book's details (title appears twice: row + sheet).
    await waitFor(() => expect(screen.getAllByText("Book One").length).toBeGreaterThanOrEqual(2));
    // Sheet's Request button requests it too.
    const buttons = screen.getAllByLabelText("Request Book One");
    await fireEvent.press(buttons[buttons.length - 1]);
    await waitFor(() => expect(createRequest).toHaveBeenCalled());
  });

  it("requiresFullAuth surfaces stay hidden in apiToken mode (series/author endpoints reject static tokens)", async () => {
    useRmabStore.setState({ configured: true, authMode: "apiToken" } as any);
    const fetchMissing = jest.fn().mockResolvedValue(BOOKS);
    await render(<RmabMissingSection fetchMissing={fetchMissing} requiresFullAuth />);
    expect(fetchMissing).not.toHaveBeenCalled();
    expect(screen.queryByText("Missing from your library")).toBeNull();
  });

  it("requiresFullAuth surfaces render normally in jwt mode", async () => {
    useRmabStore.setState({ configured: true, authMode: "jwt" } as any);
    await render(
      <RmabMissingSection fetchMissing={jest.fn().mockResolvedValue([BOOKS[0]])} requiresFullAuth />
    );
    await screen.findByText("Book One");
  });

  it("a failed lookup logs and renders nothing (never blocks the host screen)", async () => {
    useRmabStore.setState({ configured: true } as any);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await render(
      <RmabMissingSection fetchMissing={jest.fn().mockRejectedValue(new Error("down"))} />
    );
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(screen.queryByText("Missing from your library")).toBeNull();
    warnSpy.mockRestore();
  });
});
