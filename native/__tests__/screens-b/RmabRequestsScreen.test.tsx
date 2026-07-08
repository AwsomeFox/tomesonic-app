jest.mock("../../utils/audible", () => ({
  audibleBookDetails: jest.fn().mockResolvedValue(null),
}));
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";

jest.mock("../../utils/rmab", () => ({
  listMyRequests: jest.fn(),
  deleteRequest: jest.fn(),
  approveRequest: jest.fn(),
  exchangeLoginToken: jest.fn(),
  readRmabConfig: jest.fn(() => null),
  writeRmabConfig: jest.fn(),
  rmabAuthMode: (cfg: any) => (cfg ? (cfg.apiToken ? "apiToken" : "jwt") : null),
  resolveRmabUrl: (p: any) => p || undefined,
  getMe: jest.fn(),
  createRequest: jest.fn(),
}));

import RmabRequestsScreen from "../../screens/RmabRequestsScreen";
import { useRmabStore } from "../../store/useRmabStore";
import { listMyRequests, deleteRequest, approveRequest } from "../../utils/rmab";

const initial = useRmabStore.getState();
const mockedList = listMyRequests as jest.Mock;

const REQUESTS = [
  { id: "r1", title: "Book A", author: "Author A", status: "awaiting_approval" },
  { id: "r2", title: "Book B", author: "Author B", status: "downloading" },
];

const navigation = { goBack: jest.fn() };

beforeEach(() => {
  useRmabStore.setState(initial, true);
  jest.clearAllMocks();
  mockedList.mockResolvedValue(REQUESTS);
});

describe("RmabRequestsScreen", () => {
  it("lists requests with status chips", async () => {
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Book A");
    expect(screen.getByText("Awaiting approval")).toBeTruthy();
    expect(screen.getByText("Processing")).toBeTruthy();
  });

  it("hides manage actions for non-admins and API-token connections", async () => {
    useRmabStore.setState({ isAdmin: false, authMode: "jwt" } as any);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Book A");
    expect(screen.queryByLabelText("Approve Book A")).toBeNull();
    expect(screen.queryByLabelText("Delete Book A")).toBeNull();

    // Admin role but static API token: server would 403 — actions stay hidden.
    useRmabStore.setState({ isAdmin: true, authMode: "apiToken" } as any);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await waitFor(() => expect(screen.queryByLabelText("Approve Book A")).toBeNull());
  });

  it("admin JWT sessions can approve awaiting requests", async () => {
    useRmabStore.setState({ isAdmin: true, authMode: "jwt" } as any);
    (approveRequest as jest.Mock).mockResolvedValue(undefined);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Book A");

    // Approve/deny only on the awaiting row.
    expect(screen.queryByLabelText("Approve Book B")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Approve Book A"));
    await waitFor(() => expect(approveRequest).toHaveBeenCalledWith("r1", "approve"));
  });

  it("shows the shared empty state when there are no requests", async () => {
    mockedList.mockResolvedValue([]);
    await render(<RmabRequestsScreen navigation={navigation} />);

    expect(await screen.findByText("No requests yet")).toBeTruthy();
    expect(
      screen.getByText("Request missing books from search, series, or author pages.")
    ).toBeTruthy();
  });

  it("shows an empty error state when the requests load fails", async () => {
    mockedList.mockRejectedValueOnce(new Error("down"));
    await render(<RmabRequestsScreen navigation={navigation} />);

    expect(await screen.findByText("Couldn't load requests")).toBeTruthy();
  });

  it("maps terminal/negative statuses to error chips, never the neutral 'Requested' default", async () => {
    mockedList.mockResolvedValue([
      { id: "d1", title: "Denied Book", author: "A", status: "denied" },
      { id: "d2", title: "Rejected Book", author: "A", status: "rejected" },
      { id: "d3", title: "Cancelled Book", author: "A", status: "cancelled" },
      { id: "d4", title: "Failed Book", author: "A", status: "failed" },
    ]);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Denied Book");

    expect(screen.getByText("Denied")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    // The negative statuses must NOT fall through to the "Requested" default.
    expect(screen.queryByText("Requested")).toBeNull();
  });

  it("still shows 'Requested' for a genuinely unrecognized/pending status", async () => {
    mockedList.mockResolvedValue([{ id: "u1", title: "Odd Book", author: "A", status: "queued" }]);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Odd Book");
    expect(screen.getByText("Requested")).toBeTruthy();
  });

  it("re-fetches when the screen regains focus (skipping the initial focus event)", async () => {
    let focusCb: (() => void) | undefined;
    const focusNav = {
      goBack: jest.fn(),
      addListener: jest.fn((event: string, cb: () => void) => {
        if (event === "focus") focusCb = cb;
        return jest.fn();
      }),
    };
    await render(<RmabRequestsScreen navigation={focusNav} />);
    await screen.findByText("Book A");
    // Initial mount load only.
    expect(mockedList).toHaveBeenCalledTimes(1);

    // First focus event (initial mount) is skipped — no extra fetch.
    await act(async () => {
      await focusCb!();
    });
    expect(mockedList).toHaveBeenCalledTimes(1);

    // A subsequent focus refetches so fulfilled/denied statuses appear.
    await act(async () => {
      await focusCb!();
    });
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it("delete requires a second confirming tap", async () => {
    useRmabStore.setState({ isAdmin: true, authMode: "jwt" } as any);
    (deleteRequest as jest.Mock).mockResolvedValue(undefined);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Book B");

    await fireEvent.press(screen.getByLabelText("Delete Book B"));
    expect(deleteRequest).not.toHaveBeenCalled(); // armed, not deleted
    await fireEvent.press(screen.getByLabelText("Confirm delete Book B"));
    await waitFor(() => expect(deleteRequest).toHaveBeenCalledWith("r2"));
    // Row removed locally without a refetch.
    await waitFor(() => expect(screen.queryByText("Book B")).toBeNull());
  });
});
