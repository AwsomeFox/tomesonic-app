import { NativeModules, Platform } from "react-native";

// Mirrors the ABS credentials onto the paired Wear OS watch through the native
// WearBridge module (Wearable Data Layer, path /tomesonic/creds — the binding
// contract is native/wear/ARCHITECTURE.md). The ACCESS token only: the refresh
// token never leaves the phone, so a lost/unpaired watch can't hold a
// self-renewing session.
//
// Best-effort by design — the module is Android-only and simply absent on iOS,
// under jest, and on any build without it, so every call here is a guarded
// no-op. The native side already resolves(false) instead of rejecting; this
// wrapper additionally swallows a missing module, a missing method and a
// rejected promise so no caller ever has to care.
type WearBridge = {
  putCreds?: (server: string, token: string, userId: string, username: string) => Promise<boolean>;
  clearCreds?: () => Promise<boolean>;
};

function bridge(): WearBridge | null {
  if (Platform.OS !== "android") return null;
  return ((NativeModules as any)?.WearBridge as WearBridge) || null;
}

// The native promise resolves true/false; a rejection would be a bug, but an
// unhandled one still surfaces as a red-box warning, so absorb it here.
function absorb(result: unknown): void {
  const p = result as Promise<unknown> | undefined;
  if (p && typeof (p as any).catch === "function") {
    p.catch((e: unknown) => console.warn("[WearCreds] bridge call failed", e));
  }
}

export function pushWearCreds(creds: {
  server: string;
  token: string;
  userId?: string;
  username?: string;
}): void {
  try {
    const mod = bridge();
    if (!mod || typeof mod.putCreds !== "function") return;
    // Empty strings, never null/undefined: the native signature is non-null
    // Kotlin Strings, and the contract allows "" for userId/username.
    absorb(
      mod.putCreds(
        creds?.server || "",
        creds?.token || "",
        creds?.userId || "",
        creds?.username || ""
      )
    );
  } catch (e) {
    console.warn("[WearCreds] push failed", e);
  }
}

// Logout. Natively this is a put of empty strings on the same path (NOT a
// delete) — see the contract; the watch reads empty server/token as
// "not configured" and shows its connect screen.
export function clearWearCreds(): void {
  try {
    const mod = bridge();
    if (!mod || typeof mod.clearCreds !== "function") return;
    absorb(mod.clearCreds());
  } catch (e) {
    console.warn("[WearCreds] clear failed", e);
  }
}
