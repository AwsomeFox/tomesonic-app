import { useEffect, useState } from "react";

interface NetworkStatus {
  isConnected: boolean;
  isInternetReachable: boolean;
}

const DEFAULT_STATUS: NetworkStatus = { isConnected: true, isInternetReachable: true };
const LAST_STATUS_KEY = "lastNetworkStatus";

// Reads the last connectivity state persisted by the NetInfo listener so a
// cold start while offline renders the offline UI immediately instead of
// flashing "online" until the first NetInfo event arrives.
function initialStatus(): NetworkStatus {
  try {
    const { storage } = require("../utils/storage");
    const raw = storage.getString(LAST_STATUS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.isConnected === "boolean") {
        return {
          isConnected: parsed.isConnected,
          isInternetReachable:
            typeof parsed.isInternetReachable === "boolean" ? parsed.isInternetReachable : parsed.isConnected,
        };
      }
    }
  } catch (e) {
    // Storage unavailable or corrupt entry — fall back to online defaults.
  }
  return DEFAULT_STATUS;
}

function persistStatus(status: NetworkStatus) {
  try {
    const { storage } = require("../utils/storage");
    storage.set(LAST_STATUS_KEY, JSON.stringify(status));
  } catch (e) {
    // no-op — persistence is a best-effort optimization
  }
}

/**
 * Subscribes to @react-native-community/netinfo for live connectivity status.
 * Wrapped defensively — NetInfo is a native module, so if it's unavailable
 * (e.g. not linked, or running in an environment without it) we fall back to
 * "online" defaults instead of crashing the app.
 */
export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(initialStatus);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      // Lazy require so a missing/broken native module can't crash import time.
      const NetInfo = require("@react-native-community/netinfo").default;
      unsubscribe = NetInfo.addEventListener((state: any) => {
        const isConnected = state?.isConnected ?? true;
        const next = {
          isConnected,
          // NetInfo reports null while reachability is UNKNOWN — falling back
          // to `true` there persisted {isConnected:false, reachable:true},
          // which a later cold start would trust. Unknown inherits the
          // connection state instead.
          isInternetReachable: state?.isInternetReachable ?? isConnected,
        };
        persistStatus(next);
        setStatus(next);
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
