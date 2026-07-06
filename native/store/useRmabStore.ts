import { create } from "zustand";
import {
  exchangeLoginToken,
  readRmabConfig,
  writeRmabConfig,
  rmabAuthMode,
  getMe,
  createRequest,
  getPendingApprovalCount,
  clearRmabCaches,
  RmabBook,
} from "../utils/rmab";

/**
 * ReadMeABook connection state. `configured` gates EVERY RMAB feature in the
 * UI — nothing request-related renders unless the user has connected a server
 * in Settings.
 */
interface RmabState {
  configured: boolean;
  serverUrl: string | null;
  username: string | null;
  // "jwt" (login token — full API) or "apiToken" (static rmab_ token —
  // search + requests only; series/author discovery needs jwt).
  authMode: "jwt" | "apiToken" | null;
  // RMAB role of the connected account. Manage actions (approve/delete) are
  // server-enforced to admin JWT sessions.
  isAdmin: boolean;
  // Requests awaiting admin approval — drives the account-menu badge.
  pendingApprovalCount: number;
  connecting: boolean;
  connectError: string | null;
  // asin -> local request status ("pending" right after a request here, or
  // whatever the server reported). Lets every screen flip its button to
  // "Requested" without refetching.
  requestedAsins: Record<string, string>;

  initialize: () => void;
  connect: (url: string, loginToken: string) => Promise<boolean>;
  disconnect: () => void;
  requestBook: (book: RmabBook) => Promise<{ ok: boolean; message?: string }>;
  noteRequestStatus: (asin: string, status: string) => void;
  refreshPendingCount: () => Promise<void>;
}

export const useRmabStore = create<RmabState>((set, get) => ({
  configured: false,
  serverUrl: null,
  username: null,
  authMode: null,
  isAdmin: false,
  pendingApprovalCount: 0,
  connecting: false,
  connectError: null,
  requestedAsins: {},

  initialize: () => {
    const cfg = readRmabConfig();
    if (cfg) {
      set({
        configured: true,
        serverUrl: cfg.url,
        username: cfg.user?.username || null,
        authMode: rmabAuthMode(cfg),
        isAdmin: cfg.user?.role === "admin",
      });
      get().refreshPendingCount();
    }
  },

  connect: async (url, loginToken) => {
    set({ connecting: true, connectError: null });
    try {
      // RMAB's admin UI hands out a one-time LOGIN URL
      // (https://host/auth/token/login?token=...). Accept it pasted whole —
      // in either field — and pull the server + token out of it.
      let effUrl = (url || "").trim();
      let effToken = (loginToken || "").trim();
      const urlish = [effToken, effUrl].find((v) => v.includes("token="));
      if (urlish) {
        try {
          const parsed = new URL(urlish);
          const qToken = parsed.searchParams.get("token");
          if (qToken) {
            effToken = qToken;
            effUrl = parsed.origin;
          }
        } catch {}
      }
      if (!effUrl || !effToken) {
        set({
          connecting: false,
          configured: false,
          connectError: !effUrl
            ? "Enter your server's address"
            : "Paste a login URL, or add an API token",
        });
        return false;
      }
      // Token from the explicit API-token field (no token= URL): try the
      // static interpretation first; login URLs go JWT-first.
      const cfg = await exchangeLoginToken(effUrl, effToken, { preferApiToken: !urlish });
      clearRmabCaches();
      writeRmabConfig(cfg);
      // Round-trip an authed call so a pasted token that exchanged but can't
      // authenticate (clock skew, revoked session) fails HERE, not later.
      await getMe();
      set({
        configured: true,
        serverUrl: cfg.url,
        username: cfg.user?.username || null,
        authMode: rmabAuthMode(cfg),
        isAdmin: cfg.user?.role === "admin",
        connecting: false,
      });
      get().refreshPendingCount();
      return true;
    } catch (e: any) {
      writeRmabConfig(null);
      const status = e?.response?.status;
      // The persisted config is gone — a previous connection's identity
      // (server, user, admin role, badge count) must not survive in memory.
      set({
        connecting: false,
        configured: false,
        serverUrl: null,
        username: null,
        authMode: null,
        isAdmin: false,
        pendingApprovalCount: 0,
        connectError:
          status === 401 || status === 400 || status === 403
            ? "Token rejected. Paste a login token (admin: Users → Generate login token) or an rmab_ API token."
            : status === 404
            ? "No ReadMeABook API at that URL — check the address"
            : "Could not reach the server",
      });
      return false;
    }
  },

  disconnect: () => {
    clearRmabCaches();
    writeRmabConfig(null);
    set({
      configured: false,
      serverUrl: null,
      username: null,
      authMode: null,
      isAdmin: false,
      pendingApprovalCount: 0,
      connectError: null,
      requestedAsins: {},
    });
  },

  refreshPendingCount: async () => {
    const { configured, isAdmin, authMode } = get();
    // Admin JWT sessions only — the endpoint 403s everyone else. A session
    // that can't approve must not keep a stale badge from a previous one.
    if (!configured || !isAdmin || authMode !== "jwt") {
      if (get().pendingApprovalCount !== 0) set({ pendingApprovalCount: 0 });
      return;
    }
    try {
      const count = await getPendingApprovalCount();
      set({ pendingApprovalCount: count });
    } catch {
      // Badge is best-effort; keep the last known count.
    }
  },

  requestBook: async (book) => {
    try {
      await createRequest(book);
      get().noteRequestStatus(book.asin, "pending");
      return { ok: true };
    } catch (e: any) {
      const err = e?.response?.data?.error;
      // 409s carry a meaningful state: the book exists / is already requested.
      if (err === "AlreadyAvailable") return { ok: false, message: "Already in the library" };
      if (err === "DuplicateRequest" || err === "BeingProcessed") {
        get().noteRequestStatus(book.asin, "pending");
        return { ok: false, message: "Already requested" };
      }
      return { ok: false, message: "Request failed" };
    }
  },

  // Functional set: concurrent requestBook calls each merge into the latest
  // map instead of overwriting each other's status.
  noteRequestStatus: (asin, status) =>
    set((state) => ({ requestedAsins: { ...state.requestedAsins, [asin]: status } })),
}));
