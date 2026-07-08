/**
 * OfflineBanner — renders only when the derived "effectively offline" signal
 * is true (not on device isConnected alone), so a captive portal /
 * server-down-but-Wi-Fi-up still surfaces the banner.
 */
import { render, screen } from "@testing-library/react-native";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Controllable connectivity per test.
jest.mock("../../hooks/useNetworkStatus", () => {
  const useNetworkStatus = jest.fn();
  return { useNetworkStatus, default: useNetworkStatus };
});

import OfflineBanner from "../../components/OfflineBanner";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";

const mockedNet = useNetworkStatus as jest.Mock;

describe("OfflineBanner", () => {
  it("renders nothing while effectively online", async () => {
    mockedNet.mockReturnValue({ isConnected: true, isInternetReachable: true, isOffline: false });
    await render(<OfflineBanner />);
    expect(screen.queryByText(/showing downloaded content/)).toBeNull();
  });

  it("shows the banner when effectively offline (isOffline true)", async () => {
    mockedNet.mockReturnValue({ isConnected: true, isInternetReachable: false, isOffline: true });
    await render(<OfflineBanner />);
    expect(screen.getByText(/showing downloaded content/)).toBeTruthy();
  });
});
