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
  reconcileRequestedAsins: () => Promise<void>;
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
      // Requested-state is persisted: Audible-sourced series/author rows carry
      // no server requestStatus, so without this every "Requested" chip on
      // those surfaces reset to a fresh Request button on app restart.
      let requestedAsins: Record<string, string> = {};
      try {
        const { storage } = require("../utils/storage");
        const parsed = JSON.parse(storage.getString("rmab_requestedAsins") || "null");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) requestedAsins = parsed;
      } catch {}
      set({
        configured: true,
        serverUrl: cfg.url,
        username: cfg.user?.username || null,
        authMode: rmabAuthMode(cfg),
        isAdmin: cfg.user?.role === "admin",
        requestedAsins,
      });
      get().refreshPendingCount();
      // Drop chips for requests the server has since cleared (best-effort).
      get().reconcileRequestedAsins();
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
        // Fresh session — optimistic "Requested" chips from a previous
        // server/user don't apply here.
        requestedAsins: {},
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
        requestedAsins: {},
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
    try {
      const { storage } = require("../utils/storage");
      storage.remove("rmab_requestedAsins");
    } catch {}
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
      // Everything else used to collapse to a bare "Request failed" — the
      // server's actionable detail (offline, expired session, validation
      // reason) was thrown away, making failures undiagnosable.
      const status = e?.response?.status;
      if (!e?.response) {
        return { ok: false, message: "You're offline — try again when connected" };
      }
      if (status === 401 || status === 403) {
        return { ok: false, message: "Session expired — reconnect ReadMeABook in Settings" };
      }
      const detail = err || e?.response?.data?.message || e?.message;
      return { ok: false, message: detail ? `Request failed: ${detail}` : "Request failed" };
    }
  },

  // Functional set: concurrent requestBook calls each merge into the latest
  // map instead of overwriting each other's status. Mirrored to disk so
  // requested-state survives restarts (see initialize) — persisting the exact
  // merged map computed in the updater, not a post-set re-read.
  noteRequestStatus: (asin, status) => {
    let merged: Record<string, string> = {};
    set((state) => {
      merged = { ...state.requestedAsins, [asin]: status };
      return { requestedAsins: merged };
    });
    try {
      const { storage } = require("../utils/storage");
      storage.set("rmab_requestedAsins", JSON.stringify(merged));
    } catch {}
  },

  // Audible-sourced rows (series/author/Discover) have no server-enriched
  // requestStatus, so their "Requested" chips come solely from the persisted
  // map — without reconciliation a request deleted/rejected server-side kept
  // its chip forever with no way to re-request. Best-effort: drop local
  // entries the server no longer knows about.
  reconcileRequestedAsins: async () => {
    if (!get().configured) return;
    try {
      const { listMyRequests } = require("../utils/rmab");
      const requests = await listMyRequests();
      const serverAsins = new Set(
        (requests || [])
          .map((r: any) => r?.audiobook?.asin || r?.asin)
          .filter(Boolean)
      );
      const current = get().requestedAsins;
      const next: Record<string, string> = {};
      for (const [asin, status] of Object.entries(current)) {
        if (serverAsins.has(asin)) next[asin] = status;
      }
      if (Object.keys(next).length !== Object.keys(current).length) {
        set({ requestedAsins: next });
        try {
          const { storage } = require("../utils/storage");
          storage.set("rmab_requestedAsins", JSON.stringify(next));
        } catch {}
      }
    } catch {
      // Offline / server error — keep the local overlay; it self-corrects on
      // a later successful reconcile.
    }
  },
}));
