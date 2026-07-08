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
  setRmabSessionExpiredHandler,
  RmabBook,
  RmabConfig,
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
  // How the session was established — routes the re-login prompt (SSO vs token).
  authProvider: "oidc" | "loginToken" | "apiToken" | null;
  // True once the refresh token is rejected — the session can't self-recover,
  // so the UI shows a re-login banner instead of silently failing every call.
  sessionExpired: boolean;
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
  // Finish an SSO/OIDC sign-in: the WebView flow already produced a JWT config
  // (accessToken/refreshToken/user) from the IdP round-trip; validate + persist.
  connectWithOidc: (cfg: RmabConfig) => Promise<boolean>;
  // Flag the current session as expired (fired from rmab.ts when the refresh
  // token is rejected). Keeps serverUrl/authProvider so re-login is one tap.
  markSessionExpired: () => void;
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
  authProvider: null,
  sessionExpired: false,
  pendingApprovalCount: 0,
  connecting: false,
  connectError: null,
  requestedAsins: {},

  initialize: () => {
    // Arm the session-expiry signal exactly once, regardless of whether we're
    // connected yet — a connect established later still needs it wired.
    setRmabSessionExpiredHandler(() => useRmabStore.getState().markSessionExpired());
    const cfg = readRmabConfig();
    if (cfg) {
      // Requested-state is persisted: Audible-sourced series/author rows carry
      // no server requestStatus, so without this every "Requested" chip on
      // those surfaces reset to a fresh Request button on app restart.
      let requestedAsins: Record<string, string> = {};
      try {
        const { storage } = require("../utils/storage");
        const parsed = JSON.parse(storage.getString("rmab_requestedAsins") || "null");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // Copy into a null-proto object with only own string entries — a
          // corrupt/hostile persisted map (e.g. a "__proto__" key) must not
          // pollute the prototype or poison later spreads/"in" checks.
          const clean: Record<string, string> = Object.create(null);
          for (const [k, v] of Object.entries(parsed)) {
            if (k !== "__proto__" && typeof v === "string") clean[k] = v;
          }
          requestedAsins = clean;
        }
      } catch {}
      set({
        configured: true,
        serverUrl: cfg.url,
        username: cfg.user?.username || null,
        authMode: rmabAuthMode(cfg),
        isAdmin: cfg.user?.role === "admin",
        // Older configs predate authProvider — infer so re-login still routes.
        authProvider: cfg.authProvider ?? (cfg.apiToken ? "apiToken" : "loginToken"),
        sessionExpired: false,
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
      const exchanged = await exchangeLoginToken(effUrl, effToken, { preferApiToken: !urlish });
      // Record how we authenticated so a later expiry routes re-login correctly.
      const provider: RmabConfig["authProvider"] = exchanged.apiToken ? "apiToken" : "loginToken";
      const cfg: RmabConfig = { ...exchanged, authProvider: provider };
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
        authProvider: provider,
        sessionExpired: false,
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
        authProvider: null,
        sessionExpired: false,
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

  connectWithOidc: async (cfg) => {
    // Snapshot any existing connection so a transient failure during an
    // in-place re-login (session-expired banner) or account switch can be
    // rolled back instead of disconnecting the user.
    const prevCfg = readRmabConfig();
    set({ connecting: true, connectError: null });
    try {
      clearRmabCaches();
      const withProvider: RmabConfig = { ...cfg, authProvider: "oidc" };
      writeRmabConfig(withProvider);
      // Round-trip /auth/me to prove the JWT works AND get the authoritative
      // role/username (the OIDC payload's role can lag a just-changed claim).
      const me = await getMe();
      const user = me?.user || me || withProvider.user || null;
      const full: RmabConfig = { ...withProvider, user };
      writeRmabConfig(full);
      set({
        configured: true,
        serverUrl: full.url,
        username: full.user?.username || null,
        authMode: rmabAuthMode(full), // always "jwt" for SSO — full API access
        isAdmin: full.user?.role === "admin",
        authProvider: "oidc",
        sessionExpired: false,
        connecting: false,
        requestedAsins: {},
      });
      get().refreshPendingCount();
      return true;
    } catch (e: any) {
      const status = e?.response?.status;
      const authRejected = status === 401 || status === 403;
      // A transient failure (network / 5xx) on an in-place re-login must NOT
      // disconnect an existing session — restore the prior config and leave the
      // store as it was (still connected, still flagged expired for a retry).
      // Only a first-time connect (no prior config) or a confirmed auth
      // rejection wipes everything.
      if (prevCfg && !authRejected) {
        writeRmabConfig(prevCfg);
        set({ connecting: false, connectError: "Couldn't reach the server — try again." });
        return false;
      }
      // A token that can't authenticate must leave no trace of a connection.
      writeRmabConfig(null);
      set({
        connecting: false,
        configured: false,
        serverUrl: null,
        username: null,
        authMode: null,
        isAdmin: false,
        authProvider: null,
        sessionExpired: false,
        pendingApprovalCount: 0,
        requestedAsins: {},
        connectError: "SSO sign-in failed — please try again.",
      });
      return false;
    }
  },

  markSessionExpired: () => {
    // Idempotent, and only meaningful for a live connection: never flip a
    // fresh/disconnected store into an expired state, and don't re-notify.
    if (!get().configured || get().sessionExpired) return;
    set({ sessionExpired: true, pendingApprovalCount: 0 });
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
      authProvider: null,
      sessionExpired: false,
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
    // asin comes from network-derived book objects — reject a special key
    // ("__proto__" etc.) before it lands in the map and gets persisted.
    if (!asin || typeof asin !== "string" || asin === "__proto__") return;
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
      // Snapshot BEFORE the fetch: an entry added while the server list is
      // in flight is absent from BOTH the snapshot and the (already-stale)
      // server list — it must be kept by provenance, not presence.
      const snapshot = get().requestedAsins;
      const requests = await listMyRequests();
      const serverAsins = new Set(
        (requests || [])
          .map((r: any) => r?.audiobook?.asin || r?.asin)
          .filter(Boolean)
      );
      let applied: Record<string, string> | null = null;
      // Replace-mode functional set: a true no-op returns the SAME state ref so
      // Zustand skips the notify (returning {} would still mint a new state
      // object and re-render every subscriber).
      set((state) => {
        const next: Record<string, string> = {};
        for (const [asin, status] of Object.entries(state.requestedAsins)) {
          // Keep entries the server confirms, plus any added mid-reconcile
          // (a just-tapped Request must not lose its chip to a stale list).
          // Own-property check, not `in` — `in` walks the prototype so a plain
          // (non-null-proto) snapshot would treat "toString" etc. as present.
          if (serverAsins.has(asin) || !Object.prototype.hasOwnProperty.call(snapshot, asin))
            next[asin] = status;
        }
        if (Object.keys(next).length === Object.keys(state.requestedAsins).length) {
          return state;
        }
        applied = next;
        return { ...state, requestedAsins: next };
      }, true);
      if (applied) {
        try {
          const { storage } = require("../utils/storage");
          storage.set("rmab_requestedAsins", JSON.stringify(applied));
        } catch {}
      }
    } catch {
      // Offline / server error — keep the local overlay; it self-corrects on
      // a later successful reconcile.
    }
  },
}));
