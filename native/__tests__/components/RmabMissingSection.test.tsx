jest.mock("../../utils/audible", () => ({
  audibleBookDetails: jest.fn().mockResolvedValue(null),
}));
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import RmabMissingSection from "../../components/RmabMissingSection";
import RmabBookDetailSheet from "../../components/RmabBookDetailSheet";
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
  {
    asin: "B01",
    title: "Book One",
    author: "A. Author",
    isAvailable: false,
    sequence: "3",
    releaseDate: "2024-05-01",
  },
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
    // Series position + year lead the detail line.
    expect(screen.getByText("Book 3 • 2024 • A. Author")).toBeTruthy();
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

  it("detail sheet lazily fills a missing description from Audible and can expand it", async () => {
    const { audibleBookDetails } = require("../../utils/audible");
    (audibleBookDetails as jest.Mock).mockResolvedValue({
      description: "Lazy description. ".repeat(30),
      narrator: "Lazy Narrator",
    });
    useRmabStore.setState({ configured: true } as any);
    await render(
      <RmabMissingSection fetchMissing={jest.fn().mockResolvedValue([BOOKS[0]])} />
    );
    await screen.findByText("Book One");
    await fireEvent.press(screen.getByLabelText("Details for Book One"));

    await waitFor(() => expect(audibleBookDetails).toHaveBeenCalledWith("B01"));
    await screen.findByText("Read by Lazy Narrator");
    // Long description gets the expand affordance.
    const more = await screen.findByLabelText("Show more");
    await fireEvent.press(more);
    await screen.findByLabelText("Show less");
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

  it("a failed lookup shows 'Couldn't check' with Retry — never a silent vanish", async () => {
    useRmabStore.setState({ configured: true } as any);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMissing = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce([BOOKS[0]]);
    await render(<RmabMissingSection fetchMissing={fetchMissing} />);
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    // A failed check must be DISTINGUISHABLE from "nothing missing" — the old
    // silent null read as "no books to request" on any Audible timeout.
    await screen.findByText("Couldn't check for missing books.");

    await fireEvent.press(screen.getByLabelText("Retry missing-books check"));
    await screen.findByText("Book One");
    expect(screen.queryByText("Couldn't check for missing books.")).toBeNull();
    warnSpy.mockRestore();
  });

  it("caps long lists at maxItems with a 'Show N more' expander revealing the rest", async () => {
    useRmabStore.setState({ configured: true } as any);
    const many = Array.from({ length: 13 }, (_, i) => ({
      asin: `M${String(i + 1).padStart(2, "0")}`,
      title: `Volume ${i + 1}`,
      author: "A. Author",
      isAvailable: false,
    }));
    await render(<RmabMissingSection fetchMissing={jest.fn().mockResolvedValue(many)} />);
    await screen.findByText("Volume 1");

    // Default maxItems=10 → ten rows plus the expander for the hidden three.
    expect(screen.getAllByLabelText(/^Details for Volume/).length).toBe(10);
    expect(screen.queryByText("Volume 11")).toBeNull();
    expect(screen.getByText("Show 3 more")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Show 3 more missing books"));
    expect(screen.getAllByLabelText(/^Details for Volume/).length).toBe(13);
    expect(screen.getByText("Volume 13")).toBeTruthy();
    // Everything's visible — the expander goes away.
    expect(screen.queryByText(/^Show \d+ more$/)).toBeNull();
  });

  it("labels unreleased books as preorders; released books get a bare year", async () => {
    useRmabStore.setState({ configured: true } as any);
    await render(
      <RmabMissingSection
        fetchMissing={jest.fn().mockResolvedValue([
          { asin: "F1", title: "Future Book", author: "A. Author", releaseDate: "2099-03-01", isAvailable: false },
          { asin: "P1", title: "Past Book", author: "A. Author", releaseDate: "2020-06-15", isAvailable: false },
        ])}
      />
    );
    await screen.findByText("Future Book");
    // Requestable-but-unfulfillable preorders say so instead of a bare future year.
    expect(screen.getByText("Preorder · 2099 • A. Author")).toBeTruthy();
    // Released titles keep the plain year — no preorder label.
    expect(screen.getByText("2020 • A. Author")).toBeTruthy();
    expect(screen.queryByText(/Preorder · 2020/)).toBeNull();
  });

  it("a failed request's message renders INSIDE the still-open detail sheet", async () => {
    // The section's notice line paints UNDERNEATH the open sheet — the sheet
    // must show the outcome itself or a failed request looks like nothing
    // happened.
    const requestBook = jest
      .fn()
      .mockResolvedValue({ ok: false, message: "Request failed: quota exceeded" });
    useRmabStore.setState({ configured: true, requestBook } as any);
    await render(<RmabMissingSection fetchMissing={jest.fn().mockResolvedValue([BOOKS[0]])} />);
    await screen.findByText("Book One");

    await fireEvent.press(screen.getByLabelText("Details for Book One"));
    await waitFor(() => expect(screen.getAllByText("Book One").length).toBeGreaterThanOrEqual(2));

    const buttons = screen.getAllByLabelText("Request Book One");
    await fireEvent.press(buttons[buttons.length - 1]);
    await waitFor(() => expect(requestBook).toHaveBeenCalled());

    // The message renders twice: the section's notice line AND inside the sheet.
    const notices = await screen.findAllByText("Request failed: quota exceeded");
    expect(notices.length).toBe(2);
    // Sheet is still open (title present in row + sheet).
    expect(screen.getAllByText("Book One").length).toBeGreaterThanOrEqual(2);
  });
});

describe("RmabBookDetailSheet — notice prop", () => {
  const book = { asin: "B01", title: "Book One", author: "A. Author" } as any;

  it("renders the notice text when provided and drops it when null", async () => {
    const view = await render(
      <RmabBookDetailSheet book={book} onClose={jest.fn()} notice="Already requested" />
    );
    await screen.findByText("Already requested");

    await view.rerender(<RmabBookDetailSheet book={book} onClose={jest.fn()} notice={null} />);
    expect(screen.queryByText("Already requested")).toBeNull();
    // The rest of the sheet is unaffected.
    expect(screen.getByText("Book One")).toBeTruthy();
  });
});
