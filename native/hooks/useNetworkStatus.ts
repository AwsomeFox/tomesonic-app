import { useEffect, useState } from "react";

interface NetworkStatus {
  isConnected: boolean;
  isInternetReachable: boolean;
  /**
   * Derived "effectively offline" signal — true when the device has no
   * connection OR the OS has EXPLICITLY determined the internet is
   * unreachable (captive portal / server-down-but-Wi-Fi-up). Debounced so a
   * brief reachability blip doesn't flap the offline UI. Consumers should gate
   * on this instead of `isConnected` alone.
   */
  isOffline: boolean;
}

interface RawStatus {
  isConnected: boolean;
  isInternetReachable: boolean;
}

const DEFAULT_STATUS: RawStatus = { isConnected: true, isInternetReachable: true };
const LAST_STATUS_KEY = "lastNetworkStatus";
// How long a connectivity transition must hold before it flips `isOffline`.
// Guards against captive-portal / reachability probes toggling rapidly.
const OFFLINE_DEBOUNCE_MS = 500;

/**
 * "Effectively offline" = no device connection, OR the OS has EXPLICITLY
 * reported the internet unreachable. Crucially, isInternetReachable === null
 * (UNKNOWN) is NOT treated as offline — only an explicit `false` counts, so a
 * still-probing device isn't prematurely forced into the offline UI.
 */
export function isEffectivelyOffline(status: {
  isConnected: boolean;
  isInternetReachable?: boolean | null;
}): boolean {
  return !status.isConnected || status.isInternetReachable === false;
}

// Reads the last connectivity state persisted by the NetInfo listener so a
// cold start while offline renders the offline UI immediately instead of
// flashing "online" until the first NetInfo event arrives.
function initialStatus(): RawStatus {
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

function persistStatus(status: RawStatus) {
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
  const [status, setStatus] = useState<RawStatus>(initialStatus);
  // Seeded synchronously from the same persisted status so a cold offline
  // start renders offline on the very first frame (no debounce on mount).
  const [isOffline, setIsOffline] = useState<boolean>(() => isEffectivelyOffline(initialStatus()));

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

  // Debounce the offline transition so a brief reachability flap (captive
  // portal probe, momentary DNS blip) doesn't toggle the offline UI. The
  // target is committed only after it holds for OFFLINE_DEBOUNCE_MS.
  useEffect(() => {
    const target = isEffectivelyOffline(status);
    if (target === isOffline) return;
    const t = setTimeout(() => setIsOffline(target), OFFLINE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [status, isOffline]);

  return { ...status, isOffline };
}

export default useNetworkStatus;
