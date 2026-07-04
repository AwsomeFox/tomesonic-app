import { useEffect, useState } from "react";

interface NetworkStatus {
  isConnected: boolean;
  isInternetReachable: boolean;
}

const DEFAULT_STATUS: NetworkStatus = { isConnected: true, isInternetReachable: true };

/**
 * Subscribes to @react-native-community/netinfo for live connectivity status.
 * Wrapped defensively — NetInfo is a native module, so if it's unavailable
 * (e.g. not linked, or running in an environment without it) we fall back to
 * "online" defaults instead of crashing the app.
 */
export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(DEFAULT_STATUS);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      // Lazy require so a missing/broken native module can't crash import time.
      const NetInfo = require("@react-native-community/netinfo").default;
      unsubscribe = NetInfo.addEventListener((state: any) => {
        setStatus({
          isConnected: state?.isConnected ?? true,
          isInternetReachable: state?.isInternetReachable ?? true,
        });
      });
    } catch (e) {
      // NetInfo unavailable — keep default "online" status so the rest of the
      // app behaves as if connectivity is fine.
      setStatus(DEFAULT_STATUS);
    }

    return () => {
      try {
        unsubscribe?.();
      } catch (e) {
        // no-op
      }
    };
  }, []);

  return status;
}

export default useNetworkStatus;
