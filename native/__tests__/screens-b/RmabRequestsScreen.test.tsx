import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

jest.mock("../../utils/rmab", () => ({
  listMyRequests: jest.fn(),
  deleteRequest: jest.fn(),
  approveRequest: jest.fn(),
  exchangeLoginToken: jest.fn(),
  readRmabConfig: jest.fn(() => null),
  writeRmabConfig: jest.fn(),
  rmabAuthMode: (cfg: any) => (cfg ? (cfg.apiToken ? "apiToken" : "jwt") : null),
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
