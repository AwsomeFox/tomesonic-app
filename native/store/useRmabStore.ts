import { create } from "zustand";
import {
  exchangeLoginToken,
  readRmabConfig,
  writeRmabConfig,
  rmabAuthMode,
  getMe,
  createRequest,
  cancelRequest,
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
  // PO4: for NON-admins, how many of the user's OWN requests newly became
  // available (fulfilled) or newly failed since the last poll — the non-admin
  // analogue of pendingApprovalCount. Accumulates across polls until a screen
  // consumes it via clearMyRequestUpdates().
  // Surfaced by RmabRequestsScreen: a focus/foreground trigger drives
  // refreshMyRequestStatuses() (see below), and the screen renders a live-region
  // banner from these counts, then calls clearMyRequestUpdates() once shown.
  myRequestUpdates: { fulfilled: number; failed: number };
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
  clearConnectError: () => void;
  disconnect: () => void;
  requestBook: (book: RmabBook) => Promise<{ ok: boolean; message?: string }>;
  // Requester self-cancel: withdraw one of the user's OWN pending requests
  // (PATCH /api/requests/:id {action:"cancel"}). Clears the optimistic chip for
  // `asin` so discovery re-shows "Request", and pre-records the cancellation in
  // the fulfillment-poll baseline so it isn't later surfaced as a "failed"
  // request. Returns { ok:false, message } for graceful UI handling (403 = the
  // server doesn't allow it; 400 = no longer cancellable).
  cancelMyRequest: (requestId: string, asin?: string) => Promise<{ ok: boolean; message?: string }>;
  noteRequestStatus: (asin: string, status: string) => void;
  reconcileRequestedAsins: () => Promise<void>;
  refreshPendingCount: () => Promise<void>;
  // PO4: non-admin fulfillment awareness. Polls listMyRequests(), diffs against
  // a persisted status snapshot, and accumulates newly-fulfilled/newly-failed
  // counts into myRequestUpdates. No-op for admins (they use pendingApprovalCount).
  refreshMyRequestStatuses: () => Promise<void>;
  // Reset the myRequestUpdates counters once a screen has surfaced them.
  clearMyRequestUpdates: () => void;
}

// A fresh-session reset (connect / reconnect / disconnect) must also drop the
// PERSISTED requested-chip map, or initialize() reloads it on the next launch
// and resurrects stale "Requested" chips for the new account.
function clearPersistedRequestedAsins() {
  try {
    const { storage } = require("../utils/storage");
    storage.remove("rmab_requestedAsins");
  } catch {}
}

// --- PO4: fulfillment awareness for NON-admins --------------------------
// Admins learn of activity through the pending-approval badge; non-admins get
// nothing (refreshPendingCount 403s / returns 0 for them), so a request quietly
// finishing (or failing) is invisible. refreshMyRequestStatuses diffs each poll
// of listMyRequests() against a persisted per-request status snapshot and
// surfaces how many of MY requests newly became available or newly failed.
const MY_REQUEST_STATUS_KEY = "rmab_myRequestStatuses";
const FULFILLED_STATUSES = new Set([
  "available",
  "completed",
  "fulfilled",
  "downloaded",
  "imported",
  "done",
]);
const FAILED_STATUSES = new Set(["failed", "error", "denied", "rejected", "cancelled"]);
const normStatus = (s?: unknown) => (typeof s === "string" ? s.toLowerCase().trim() : "");
const isFulfilled = (s?: unknown) => FULFILLED_STATUSES.has(normStatus(s));
const isFailed = (s?: unknown) => FAILED_STATUSES.has(normStatus(s));

// A fresh session must not diff a new account's requests against the previous
// one's snapshot (nor keep a stale updates count) — drop the baseline on
// connect / reconnect / disconnect.
function clearPersistedMyRequestStatuses() {
  try {
    const { storage } = require("../utils/storage");
    storage.remove(MY_REQUEST_STATUS_KEY);
  } catch {}
}

// Debounce guard: focus/foreground triggers can fire refreshMyRequestStatuses in
// quick succession (tab switch + resume). Two concurrent polls would each diff
// the SAME baseline and double-count a single transition, so collapse overlap to
// one in-flight poll. Module-level (not store state) — it's plumbing, not UI.
let myRequestStatusInFlight = false;

export const useRmabStore = create<RmabState>((set, get) => ({
  configured: false,
  serverUrl: null,
  username: null,
  authMode: null,
  isAdmin: false,
  authProvider: null,
  sessionExpired: false,
  pendingApprovalCount: 0,
  myRequestUpdates: { fulfilled: 0, failed: 0 },
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
      // Non-admin analogue of the pending badge: seed/diff the request-status
      // snapshot so fulfilled/failed requests surface (no-op for admins).
      get().refreshMyRequestStatuses();
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
      clearPersistedRequestedAsins();
      // Fresh session — don't diff a new account's requests against the old
      // baseline, and drop any un-consumed updates count.
      clearPersistedMyRequestStatuses();
      set({
        configured: true,
        serverUrl: cfg.url,
        username: cfg.user?.username || null,
        authMode: rmabAuthMode(cfg),
        isAdmin: cfg.user?.role === "admin",
        authProvider: provider,
        sessionExpired: false,
        connecting: false,
        myRequestUpdates: { fulfilled: 0, failed: 0 },
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
        myRequestUpdates: { fulfilled: 0, failed: 0 },
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
      clearPersistedRequestedAsins();
      clearPersistedMyRequestStatuses();
      set({
        configured: true,
        serverUrl: full.url,
        username: full.user?.username || null,
        authMode: rmabAuthMode(full), // always "jwt" for SSO — full API access
        isAdmin: full.user?.role === "admin",
        authProvider: "oidc",
        sessionExpired: false,
        connecting: false,
        myRequestUpdates: { fulfilled: 0, failed: 0 },
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
        myRequestUpdates: { fulfilled: 0, failed: 0 },
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

  // Clear a stale connect error so a freshly-reopened connect sheet doesn't
  // show the previous attempt's failure banner.
  clearConnectError: () => {
    if (get().connectError !== null) set({ connectError: null });
  },

  disconnect: () => {
    clearRmabCaches();
    writeRmabConfig(null);
    clearPersistedRequestedAsins();
    clearPersistedMyRequestStatuses();
    set({
      configured: false,
      serverUrl: null,
      username: null,
      authMode: null,
      authProvider: null,
      isAdmin: false,
      sessionExpired: false,
      pendingApprovalCount: 0,
      myRequestUpdates: { fulfilled: 0, failed: 0 },
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

  refreshMyRequestStatuses: async () => {
    const { configured, isAdmin } = get();
    // Admins already see activity via pendingApprovalCount; this is the
    // non-admin gap-filler. (Any authMode works — listMyRequests is allowlisted
    // for API tokens too.)
    if (!configured || isAdmin) return;
    // Collapse overlapping focus/foreground triggers to a single poll so two
    // diffs can't both fire against the same baseline and double-count.
    if (myRequestStatusInFlight) return;
    myRequestStatusInFlight = true;
    try {
      const { listMyRequests } = require("../utils/rmab");
      const requests = await listMyRequests();
      // Key by request id (stable across status changes), falling back to the
      // book asin when the server omits an id.
      const current: Record<string, string> = {};
      for (const r of requests || []) {
        const key =
          r?.id != null ? String(r.id) : r?.audiobook?.asin || r?.asin || null;
        if (key) current[key] = normStatus(r?.status);
      }
      const { storage } = require("../utils/storage");
      const rawPrev = storage.getString(MY_REQUEST_STATUS_KEY);
      // First observation just seeds the baseline — without this every
      // pre-existing fulfilled/failed request would surface as "new" on the
      // first poll after connecting.
      if (rawPrev == null) {
        storage.set(MY_REQUEST_STATUS_KEY, JSON.stringify(current));
        return;
      }
      let prev: Record<string, string> = {};
      try {
        const p = JSON.parse(rawPrev);
        if (p && typeof p === "object" && !Array.isArray(p)) prev = p;
      } catch {}
      let fulfilled = 0;
      let failed = 0;
      for (const [key, status] of Object.entries(current)) {
        const before = prev[key];
        if (before === status) continue; // unchanged since last poll
        // Only count a genuine TRANSITION into the state, so a request already
        // fulfilled/failed at the last snapshot isn't recounted.
        if (isFulfilled(status) && !isFulfilled(before)) fulfilled++;
        else if (isFailed(status) && !isFailed(before)) failed++;
      }
      // Persist the new baseline even when nothing was newly countable, so a
      // pending→approved move is recorded and can't re-trigger later.
      storage.set(MY_REQUEST_STATUS_KEY, JSON.stringify(current));
      if (fulfilled || failed) {
        set((s) => ({
          myRequestUpdates: {
            fulfilled: s.myRequestUpdates.fulfilled + fulfilled,
            failed: s.myRequestUpdates.failed + failed,
          },
        }));
      }
    } catch {
      // Offline / server error — leave the last baseline and counts intact;
      // the next successful poll picks up from there.
    } finally {
      myRequestStatusInFlight = false;
    }
  },

  clearMyRequestUpdates: () => {
    const u = get().myRequestUpdates;
    if (u.fulfilled || u.failed) set({ myRequestUpdates: { fulfilled: 0, failed: 0 } });
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

  cancelMyRequest: async (requestId, asin) => {
    try {
      await cancelRequest(requestId);
    } catch (e: any) {
      const status = e?.response?.status;
      if (!e?.response) {
        return { ok: false, message: "You're offline — try again when connected" };
      }
      // The DELETE route is admin-only; if THIS server also gates the cancel
      // route (or the request isn't the caller's), it 403s — say so plainly.
      if (status === 403) {
        return { ok: false, message: "This server doesn't allow cancelling your own requests" };
      }
      // Status moved past the cancellable window between render and tap.
      if (status === 400) {
        const detail = e?.response?.data?.message;
        return { ok: false, message: detail || "This request can no longer be cancelled" };
      }
      if (status === 401) {
        return { ok: false, message: "Session expired — reconnect ReadMeABook in Settings" };
      }
      const detail = e?.response?.data?.message || e?.response?.data?.error || e?.message;
      return { ok: false, message: detail ? `Couldn't cancel: ${detail}` : "Couldn't cancel the request" };
    }
    // Success: drop the optimistic "Requested" chip for this book so the
    // Discover/search UI re-shows a "Request" button. Functional set + persist,
    // mirroring noteRequestStatus; a no-op (asin not present) returns the same
    // state ref so subscribers don't needlessly re-render.
    if (asin && typeof asin === "string") {
      let merged: Record<string, string> | null = null;
      set((state) => {
        if (!Object.prototype.hasOwnProperty.call(state.requestedAsins, asin)) return state;
        const next = { ...state.requestedAsins };
        delete next[asin];
        merged = next;
        return { requestedAsins: next };
      });
      if (merged) {
        try {
          const { storage } = require("../utils/storage");
          storage.set("rmab_requestedAsins", JSON.stringify(merged));
        } catch {}
      }
    }
    // Pre-empt the non-admin fulfillment poller: a cancelled request reads as a
    // FAILED_STATUS, so without recording it in the baseline the next
    // refreshMyRequestStatuses() would diff (pending → cancelled) and wrongly
    // nag the user that their OWN just-cancelled request "failed".
    //
    // The baseline keys each entry by `r.id ?? asin` (see refreshMyRequestStatuses),
    // so when the server omits `id` for this request the baseline entry is keyed
    // by ASIN, not requestId. Writing the cancellation unconditionally under
    // requestId would then miss the asin-keyed entry, and the next poll would
    // still diff (pending → cancelled) and surface a bogus "failed". Record the
    // cancellation under the SAME key the baseline already uses.
    try {
      const { storage } = require("../utils/storage");
      const raw = storage.getString(MY_REQUEST_STATUS_KEY);
      if (raw != null) {
        const snap = JSON.parse(raw);
        if (snap && typeof snap === "object" && !Array.isArray(snap)) {
          const idKey = String(requestId);
          const asinKey = asin && typeof asin === "string" && asin !== "__proto__" ? asin : null;
          const hasId = Object.prototype.hasOwnProperty.call(snap, idKey);
          const hasAsin = asinKey != null && Object.prototype.hasOwnProperty.call(snap, asinKey);
          if (hasId) {
            snap[idKey] = "cancelled";
          } else if (hasAsin) {
            snap[asinKey as string] = "cancelled";
          } else {
            // Neither key is in the baseline yet (e.g. the request was created
            // after the last poll seeded it). Record under BOTH so whichever key
            // the next poll derives (`r.id ?? asin`) is already marked cancelled.
            snap[idKey] = "cancelled";
            if (asinKey != null) snap[asinKey] = "cancelled";
          }
          storage.set(MY_REQUEST_STATUS_KEY, JSON.stringify(snap));
        }
      }
    } catch {}
    return { ok: true };
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
