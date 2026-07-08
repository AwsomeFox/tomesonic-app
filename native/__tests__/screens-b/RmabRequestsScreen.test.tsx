jest.mock("../../utils/audible", () => ({
  audibleBookDetails: jest.fn().mockResolvedValue(null),
}));
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";

jest.mock("../../utils/rmab", () => ({
  listMyRequests: jest.fn(),
  deleteRequest: jest.fn(),
  cancelRequest: jest.fn(),
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
import { useDialogStore } from "../../store/useDialogStore";
import { storage } from "../../utils/storage";
import { listMyRequests, deleteRequest, cancelRequest, approveRequest } from "../../utils/rmab";

const initial = useRmabStore.getState();
const mockedList = listMyRequests as jest.Mock;

const REQUESTS = [
  { id: "r1", title: "Book A", author: "Author A", status: "awaiting_approval" },
  { id: "r2", title: "Book B", author: "Author B", status: "downloading" },
];

const navigation = { goBack: jest.fn() };

beforeEach(() => {
  useRmabStore.setState(initial, true);
  useDialogStore.setState({ current: null } as any);
  // Non-admin mount now polls refreshMyRequestStatuses, which diffs against this
  // persisted baseline — clear it so one test's snapshot can't bleed a spurious
  // fulfillment banner into the next.
  storage.remove("rmab_myRequestStatuses");
  jest.clearAllMocks();
  mockedList.mockResolvedValue(REQUESTS);
});

// The confirm dialog is the real themed store (its <AppDialog/> host isn't
// mounted here), so drive a themed button by invoking its onPress directly.
async function pressDialogButton(text: string) {
  const btn = useDialogStore.getState().current?.buttons.find((b) => b.text === text);
  // Don't dismiss afterward: the handler may replace `current` with a follow-up
  // (e.g. a "Couldn't cancel" error dialog) that tests need to read.
  await act(async () => {
    await btn?.onPress?.();
  });
}

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

  it("polls own request statuses on mount and on a genuine refocus for a non-admin", async () => {
    const spy = jest.fn();
    useRmabStore.setState({ isAdmin: false, authMode: "jwt", refreshMyRequestStatuses: spy } as any);
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
    // Mount poll.
    expect(spy).toHaveBeenCalledTimes(1);

    // First focus event (the mount's own) is skipped, mirroring the list load.
    await act(async () => {
      await focusCb!();
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // A real refocus re-polls so a since-fulfilled request can surface.
    await act(async () => {
      await focusCb!();
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it("does NOT poll fulfillment status for an admin (they use the approval badge)", async () => {
    const spy = jest.fn();
    useRmabStore.setState({ isAdmin: true, authMode: "jwt", refreshMyRequestStatuses: spy } as any);
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
    await act(async () => {
      await focusCb!();
    });
    await act(async () => {
      await focusCb!();
    });
    expect(spy).not.toHaveBeenCalled();
    // And no fulfillment banner for the admin path.
    expect(screen.queryByText(/ready to read/)).toBeNull();
  });

  it("renders a fulfillment banner from myRequestUpdates and clears the store counter once shown", async () => {
    useRmabStore.setState({ isAdmin: false, authMode: "jwt", myRequestUpdates: { fulfilled: 1, failed: 0 } } as any);
    await render(<RmabRequestsScreen navigation={navigation} />);
    expect(await screen.findByText("1 request is ready to read")).toBeTruthy();
    // Snapshotted into the local banner, so the store counter is reset (won't
    // re-surface on a later poll).
    await waitFor(() =>
      expect(useRmabStore.getState().myRequestUpdates).toEqual({ fulfilled: 0, failed: 0 })
    );
  });

  it("a failed update renders an error banner that can be dismissed", async () => {
    useRmabStore.setState({ isAdmin: false, authMode: "jwt", myRequestUpdates: { fulfilled: 0, failed: 1 } } as any);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("1 request failed");

    await fireEvent.press(screen.getByLabelText("Dismiss"));
    await waitFor(() => expect(screen.queryByText("1 request failed")).toBeNull());
  });

  it("offers requester Cancel on the user's own cancellable rows, but not on fulfilled ones", async () => {
    useRmabStore.setState({ isAdmin: false, authMode: "jwt" } as any);
    mockedList.mockResolvedValue([
      { id: "c1", title: "Pending Book", author: "A", status: "pending" },
      { id: "c2", title: "Done Book", author: "A", status: "available" },
    ]);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Pending Book");

    expect(screen.getByLabelText("Cancel Pending Book")).toBeTruthy();
    // Terminal/fulfilled requests aren't cancellable — no action offered.
    expect(screen.queryByLabelText("Cancel Done Book")).toBeNull();
  });

  it("does NOT show the requester Cancel action to admin managers (they use Delete)", async () => {
    useRmabStore.setState({ isAdmin: true, authMode: "jwt" } as any);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Book A");
    // Admin rows expose Delete, not the requester self-cancel.
    expect(screen.queryByLabelText("Cancel Book A")).toBeNull();
    expect(screen.getByLabelText("Delete Book A")).toBeTruthy();
  });

  it("confirming Cancel calls the store cancel and removes the row", async () => {
    useRmabStore.setState({ isAdmin: false, authMode: "jwt" } as any);
    (cancelRequest as jest.Mock).mockResolvedValue(undefined);
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Book A");

    await fireEvent.press(screen.getByLabelText("Cancel Book A"));
    // Nothing happens until the themed confirm is accepted.
    expect(cancelRequest).not.toHaveBeenCalled();
    await pressDialogButton("Cancel request");

    await waitFor(() => expect(cancelRequest).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(screen.queryByText("Book A")).toBeNull());
  });

  it("a 403 reverts the optimistic removal and surfaces the message", async () => {
    useRmabStore.setState({ isAdmin: false, authMode: "jwt" } as any);
    (cancelRequest as jest.Mock).mockRejectedValue({ response: { status: 403 } });
    await render(<RmabRequestsScreen navigation={navigation} />);
    await screen.findByText("Book A");

    await fireEvent.press(screen.getByLabelText("Cancel Book A"));
    await pressDialogButton("Cancel request");

    // Row comes back, and the failure explains why.
    await waitFor(() => expect(screen.getByText("Book A")).toBeTruthy());
    await waitFor(() =>
      expect(useDialogStore.getState().current?.title).toBe("Couldn't cancel")
    );
    expect(useDialogStore.getState().current?.message).toBe(
      "This server doesn't allow cancelling your own requests"
    );
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
