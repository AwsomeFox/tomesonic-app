import axios from "axios";
import { storageHelper } from "./storage";
import { writeAutoCreds, readAutoCreds, writeWidgetState, writeAutoDownloads } from "./autoCreds";
import { appLogger } from "./logger";

export const api = axios.create({
  headers: {
    "Content-Type": "application/json",
  },
  // Fail fast when the server is unreachable (offline / asleep NAS) instead of
  // hanging a screen on a request that will never resolve.
  timeout: 20000,
});

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: any) => void;
}> = [];

// Clears the stored session and resets the user store so the navigator swaps
// back to the Connect screen. Uses a lazy require to avoid a circular import
// (useUserStore imports this module).
const forceLogout = () => {
  try {
    // Flag WHY the user is suddenly on the Connect screen — a silent bounce
    // read as "the app randomly logged me out". ConnectScreen reads + clears.
    try {
      const { storage } = require("./storage");
      storage.set("logout_reason", "session_expired");
    } catch {}
    // Stop playback FIRST, the way logout() does. A live session keeps its 1s
    // tick + native progress samples running (they gate on currentSession,
    // still non-null here), so a bare forceLogout left the SIGNED-OUT account's
    // positions being written to the store/cache and its ~15s sync POSTing —
    // each POST 401s → refresh (no token) → forceLogout again, churning
    // indefinitely on the Connect screen. closePlayback nulls currentSession
    // (disarming the poll) and does the final sync/save cleanup.
    try {
      const { usePlaybackStore } = require("../store/usePlaybackStore");
      usePlaybackStore.getState().closePlayback().catch(() => {});
    } catch {}
    storageHelper.clearServerConfig();
    // Clear the native mirrors too (logout() does): otherwise the Android
    // Auto service keeps the dead token pair and fails noisily in the car
    // instead of showing signed-out, the resume widget keeps advertising a
    // book whose tap path can no longer play, and the downloads mirror keeps
    // the car browsing + playing the signed-out user's downloaded books.
    writeAutoCreds(null, null, null).catch(() => {});
    writeWidgetState(null).catch(() => {});
    writeAutoDownloads([]).catch(() => {});
    // Stop surfacing the signed-out account's downloads too (logout()/login()
    // both do this via deactivateDownloadsForSwitch). Without it the store keeps
    // the dead account's items, and a later mediaProgress write would repopulate
    // the Android Auto downloads file via the store's subscription. Files + DB
    // rows are left on disk for re-adoption on re-login (not deleted).
    try {
      const { useDownloadStore } = require("../store/useDownloadStore");
      useDownloadStore.getState().deactivateDownloadsForSwitch().catch(() => {});
    } catch {}
    const { useUserStore } = require("../store/useUserStore");
    const prevConfig = useUserStore.getState().serverConnectionConfig;
    // user === null drives the navigator back to the Connect screen. Keep only
    // the non-secret fields of the in-memory server config so the address can
    // prefill on re-login — the (dead) tokens must not stay reachable in state.
    useUserStore.setState({
      user: null,
      serverConnectionConfig: prevConfig
        ? { address: prevConfig.address, username: prevConfig.username, name: prevConfig.name }
        : null,
    });
  } catch (e) {
    // no-op
  }
};

// Applies a refreshed token pair everywhere the app reads credentials from:
// 1. the secure store — the request interceptor reads it per-request;
// 2. the user store — every screen/component builds cover/stream `?token=`
//    URLs from serverConnectionConfig state, so without this ALL images and
//    any new track URLs keep 401ing with the stale token until app restart;
// 3. the Android Auto creds mirror — the native browse service reads it.
// Lazy require for the same circular-import reason as forceLogout.
const applyRefreshedConfig = (config: any) => {
  // The refresh can take up to 20s; the user may have logged out (stored
  // config gone) or switched accounts/servers meanwhile. Unconditionally
  // persisting would RESURRECT the logged-out account's credentials (secure
  // store + auto_creds, silently re-logging them in on next launch) or
  // clobber the new account's config with the old one's. Only apply when the
  // refresh still belongs to the currently stored session.
  const cur = storageHelper.getServerConfig();
  // Two accounts on one server share `address`, so userId is the real
  // discriminator — and it is the ONLY one. Discard when the ids differ, OR
  // when the STORED config has a userId the refresh lacks — that means the
  // refresh came from an older/different session and must not clobber the
  // modern one. (A normal refresh builds its config by spreading the stored
  // one, so their userIds always match; and when the stored config itself
  // lacks a userId we can't discriminate, so we keep the old behavior rather
  // than discarding every legitimate refresh for that account.)
  //
  // We deliberately DON'T gate on address: an in-place updateServerAddress
  // (same account, moved DNS/IP/proxy/scheme) can land while this refresh is
  // in flight, so the captured config's address no longer matches the current
  // one. Discarding then would throw away the freshly-rotated (and, because
  // ABS rotates refresh tokens, soon-ONLY-valid) pair and strand the session.
  const idMismatch =
    (cur?.userId && config?.userId && cur.userId !== config.userId) ||
    (cur?.userId && !config?.userId);
  if (!cur?.token || idMismatch) {
    appLogger.warn("Refreshed config no longer matches the stored session — discarding", "API");
    return;
  }
  // Apply the rotated token pair onto the CURRENT stored config, not the
  // captured one: if the address changed mid-refresh, the captured config
  // carries the stale address and blindly persisting it would revert the move.
  const applied = { ...cur, token: config.token, refreshToken: config.refreshToken };
  storageHelper.setServerConfig(applied);
  try {
    const { useUserStore } = require("../store/useUserStore");
    useUserStore.setState({ serverConnectionConfig: applied });
  } catch (e) {
    // no-op
  }
  // The live notification's album-art URL may embed the rotated-out token —
  // Media3 fetches it natively (no interceptor), so refresh it in place.
  try {
    const { refreshNowPlayingArtwork } = require("../store/usePlaybackStore");
    refreshNowPlayingArtwork();
  } catch (e) {
    // no-op
  }
  // trustTokens: this pair was JUST rotated by the server — it is the freshest.
  writeAutoCreds(applied.address, applied.token, undefined, applied.refreshToken, true).catch(() => {});
};

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else {
      resolve(token!);
    }
  });
  failedQueue = [];
};

// Request Interceptor to dynamically set baseURL and inject Authorization token
api.interceptors.request.use(
  async (config) => {
    const configData = storageHelper.getServerConfig();
    
    // Set dynamically
    if (configData?.address) {
      config.baseURL = configData.address.replace(/\/$/, "");
    }
    
    if (configData?.token) {
      config.headers.Authorization = `Bearer ${configData.token}`;
    }
    
    appLogger.info(`Request ${config.method?.toUpperCase()} ${config.url}`, "API");
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// ---- Session refresh -------------------------------------------------------
//
// ABS (≥ 2.26) access tokens expire after an HOUR; the refresh token renews
// them. Three ways a live session used to end at the Connect screen when the
// server got flaky:
//  1. No refresh token at all: /login only puts it in the response body when
//     asked (`x-return-tokens: true` — ConnectScreen sends it now); without it
//     ABS sets it as an httpOnly `refresh_token` COOKIE instead, so every
//     session from before that fix holds no refresh token and the first 401
//     after an hour "logged out". RN's cookie jar kept that cookie, so a
//     header-less /auth/refresh still renews those sessions (cookie mode).
//  2. A 401/403 that was never ABS's verdict: a captive portal, a firewall
//     block page, a Cloudflare challenge or an auth proxy in front of an
//     unreachable server answers /auth/refresh too. A rejection only ends the
//     session when ABS itself demonstrably answers (/ping, below).
//  3. A rotation whose answer was lost: the refresh reached the server (which
//     rotated the pair) but the response never made it back. ABS keeps the
//     previous refresh token valid for a GRACE window (10 min default,
//     REFRESH_TOKEN_GRACE_PERIOD) and answers it with the current pair — so a
//     round that ends without a verdict is retried inside that window
//     (scheduleRefreshRecovery) instead of waiting for a 401 that, with the
//     app idle, comes long after the old token died.

const REFRESH_TIMEOUT_MS = 20000;

// GET /ping is unauthenticated and answers a static `{ success: true }` without
// touching the database. Seeing exactly that from the SAME address proves an
// auth verdict we just got came from ABS — a proxy/portal page can't fake it
// (same probe as utils/serverLiveness).
async function absAnswersPing(host: string): Promise<boolean> {
  try {
    const res = await axios.get(`${host}/ping`, { timeout: 8000 });
    return res?.data?.success === true;
  } catch {
    return false;
  }
}

type RefreshOutcome =
  | { kind: "ok"; token: string }
  // `tried`: the refresh tokens the round sent (empty in cookie mode).
  | { kind: "definitive"; error: any; tried: string[] }
  | { kind: "transient"; error: any };

// One refresh ROUND for the stored session: try every known refresh token
// (cookie mode when there is none), apply a success everywhere, and classify
// a failure. Logging out is the CALLER's call (refreshAndClassify).
async function refreshRound(serverConfig: any): Promise<RefreshOutcome> {
  // The native Android Auto service refreshes the token itself while JS is
  // backgrounded, and ABS ROTATES refresh tokens on every /auth/refresh
  // (the previous one only survives the grace window) — so after a drive,
  // auto_creds.json can hold the ONLY valid refresh token. Both sides write
  // that file on refresh, so it is always at least as new as the secure
  // store: try its refresh token first, then fall back to the stored one
  // (covers a failed/partial file write).
  const host = serverConfig.address.replace(/\/$/, "");
  const fileCreds = await readAutoCreds();
  const refreshCandidates: string[] = [];
  if (fileCreds && fileCreds.server === host && fileCreds.refreshToken) {
    refreshCandidates.push(fileCreds.refreshToken);
  }
  if (serverConfig.refreshToken && !refreshCandidates.includes(serverConfig.refreshToken)) {
    refreshCandidates.push(serverConfig.refreshToken);
  }
  // No refresh token anywhere → cookie mode (null = no x-refresh-token
  // header; the `refresh_token` cookie ABS set at login rides along).
  const cookieMode = refreshCandidates.length === 0;
  const attempts: Array<string | null> = cookieMode ? [null] : refreshCandidates;

  appLogger.info(`Attempting token refresh${cookieMode ? " (cookie)" : ""}...`, "API");
  let response: any = null;
  let definitiveError: any = null;
  // A candidate that was never DEFINITIVELY REJECTED — a timeout or
  // connection reset (no answer at all) or a 5xx (an answer, but some
  // proxy or server fault, not a verdict on the token) — may be the
  // LIVE token: after the
  // native Android Auto service rotates the pair, auto_creds holds the
  // only valid refresh token while the stored one is already dead. Under
  // poor reception the fresh candidate's POST can vanish into the void
  // while the stale one reaches the server and draws a REAL 401 — and
  // classifying the round by whichever error came last logged the user
  // out of a live session ("drove the car, came home to bad signal,
  // suddenly signed out"). Track transient failures separately: the
  // round is definitive only when EVERY candidate got a 401/403 answer.
  let transientError: any = null;
  // Remember WHICH candidate actually produced the successful refresh —
  // it may be the file token rather than the stored one. When the server
  // doesn't rotate (omits a new refreshToken), we must persist the token
  // we just used, not blindly fall back to the (possibly stale) stored
  // one, which would overwrite a working file token → forced logout.
  let usedRefreshToken: string | null = null;
  for (const refreshToken of attempts) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (refreshToken) headers["x-refresh-token"] = refreshToken;
      response = await axios.post(
        `${host}/auth/refresh`,
        {},
        {
          headers,
          // Cookie mode needs the jar's `refresh_token` cookie on this call.
          ...(refreshToken ? {} : { withCredentials: true }),
          // This is a raw axios call, so the `api` instance's timeout
          // doesn't apply. Without one, a hung server would leave
          // isRefreshing stuck true and every later 401 queueing forever.
          timeout: REFRESH_TIMEOUT_MS,
        }
      );
      usedRefreshToken = refreshToken;
      break;
    } catch (err: any) {
      const s = err?.response?.status;
      // Cookie mode against a server WITHOUT /auth/refresh (pre-2.26 — its
      // tokens never expire): a 404 there means the 401'd token is simply
      // dead, the same verdict as a rejection (ping-verified below).
      if (s === 401 || s === 403 || (cookieMode && s === 404)) definitiveError = err;
      else transientError = err;
      response = null;
    }
  }
  if (!response) {
    // TRANSIENT wins when the round had one: with an unheard candidate the
    // session's life is unknown — the next 401 (or the recovery ladder)
    // retries with the same (or a fresher auto_creds) pair instead of
    // stranding a possibly-live session at the Connect screen.
    if (transientError) return { kind: "transient", error: transientError };
    return {
      kind: "definitive",
      error: definitiveError || new Error("Token refresh failed"),
      tried: refreshCandidates,
    };
  }

  const user = response?.data?.user;
  if (response.status !== 200 || !user?.accessToken) {
    // A 200 without the envelope (proxy/portal page) is not a verdict either.
    return { kind: "transient", error: new Error("Invalid token refresh response structure") };
  }
  const newToken = user.accessToken;
  const newRefreshToken = user.refreshToken || usedRefreshToken || serverConfig.refreshToken || null;
  // Persist + push into the user store (cover/stream URL builders) +
  // mirror to the Android Auto creds file, otherwise the car's native
  // browse service keeps using the now-expired token and every ABS
  // fetch 401s (empty categories).
  applyRefreshedConfig({ ...serverConfig, token: newToken, refreshToken: newRefreshToken });
  appLogger.info("Token refresh succeeded.", "API");
  return { kind: "ok", token: newToken };
}

// A refresh round plus the session-ending decision. Only a rejection that ABS
// itself demonstrably issued signs the user out; everything else keeps the
// session and arms the in-grace recovery ladder.
async function refreshAndClassify(serverConfig: any): Promise<RefreshOutcome> {
  let outcome: RefreshOutcome;
  try {
    outcome = await refreshRound(serverConfig);
  } catch (e) {
    outcome = { kind: "transient", error: e };
  }
  if (outcome.kind === "ok") {
    cancelRefreshRecovery();
    return outcome;
  }
  appLogger.error(`Token refresh failed: ${outcome.error}`, "API");
  if (outcome.kind === "transient") {
    scheduleRefreshRecovery();
    return outcome;
  }

  // DEFINITIVE rejection. LAST RESORT before logging out: the native Android
  // Auto service refreshes in a separate process and can rotate the pair
  // between our candidate snapshot and this rejection. If auto_creds.json now
  // holds a refresh token we did NOT try, the session may still be alive —
  // leave it un-logged-out and let the next 401 retry with the fresh pair.
  const host = serverConfig.address.replace(/\/$/, "");
  try {
    const latestFile = await readAutoCreds();
    const latestHost = storageHelper.getServerConfig()?.address?.replace(/\/$/, "");
    if (
      latestFile &&
      latestFile.server === latestHost &&
      latestFile.refreshToken &&
      !outcome.tried.includes(latestFile.refreshToken)
    ) {
      appLogger.warn("Refresh rejected but auto_creds has a newer pair — skipping logout", "API");
      return { kind: "transient", error: outcome.error };
    }
  } catch {}
  // Was that ABS talking? A portal/firewall/challenge page answers 401/403
  // for any path; ABS's /ping answer can't be faked by one.
  if (!(await absAnswersPing(host))) {
    appLogger.warn(
      "Refresh rejected, but the server isn't answering as ABS — keeping the session",
      "API"
    );
    scheduleRefreshRecovery();
    return { kind: "transient", error: outcome.error };
  }
  cancelRefreshRecovery();
  forceLogout();
  return outcome;
}

// ---- In-grace recovery ladder ----------------------------------------------
// Delays sum to ~11.25 min: the last rung is still inside ABS's default
// 10-minute grace when the first failure was a lost rotation answer (the
// first rung counts from the failure, not the rotation).
const REFRESH_RECOVERY_DELAYS_MS = [15_000, 60_000, 180_000, 420_000];
let _recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let _recoveryAttempt = 0;
let _recoveryPending = false;

function cancelRefreshRecovery() {
  if (_recoveryTimer) clearTimeout(_recoveryTimer);
  _recoveryTimer = null;
  _recoveryAttempt = 0;
  _recoveryPending = false;
}

function scheduleRefreshRecovery() {
  _recoveryPending = true;
  if (_recoveryTimer) return; // a rung is already queued
  if (_recoveryAttempt >= REFRESH_RECOVERY_DELAYS_MS.length) return; // ladder spent
  const delay = REFRESH_RECOVERY_DELAYS_MS[_recoveryAttempt++];
  _recoveryTimer = setTimeout(() => {
    _recoveryTimer = null;
    recoverSessionIfNeeded("timer").catch(() => {});
  }, delay);
}

/**
 * Re-runs a refresh that ended WITHOUT a verdict (timeout, reset, 5xx, a page
 * that wasn't ABS). Driven by the in-grace ladder above and — because JS
 * timers stall in the background — by the app returning to the foreground and
 * by connectivity coming back (App.tsx). No-op unless a recovery is pending,
 * a refresh is already in flight, or the user has since logged out.
 */
export async function recoverSessionIfNeeded(trigger = "manual"): Promise<boolean> {
  if (!_recoveryPending || isRefreshing) return false;
  const serverConfig = storageHelper.getServerConfig();
  if (!serverConfig?.address || !serverConfig?.token) {
    cancelRefreshRecovery();
    return false;
  }
  appLogger.info(`Retrying an unresolved token refresh (${trigger})`, "API");
  isRefreshing = true;
  let outcome: RefreshOutcome;
  try {
    outcome = await refreshAndClassify(serverConfig);
  } finally {
    isRefreshing = false;
  }
  if (outcome.kind === "ok") {
    processQueue(null, outcome.token);
    return true;
  }
  processQueue(outcome.error, null);
  return false;
}

// Response Interceptor to handle Token Refreshing on 401
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const status = error.response ? error.response.status : null;

    if (status === 401 && !originalRequest._retry) {
      // Avoid infinite loop on auth endpoints
      if (
        originalRequest.url?.endsWith("/auth/refresh") ||
        originalRequest.url?.endsWith("/login")
      ) {
        return Promise.reject(error);
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            // Replays are one-shot: without this, a replayed request that
            // 401s again (per-resource authz, post-rotation rejection)
            // re-entered the interceptor and kicked off a SECOND full
            // refresh, rotating tokens an extra time under churn.
            originalRequest._retry = true;
            return api(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const serverConfig = storageHelper.getServerConfig();
      if (!serverConfig?.address) {
        isRefreshing = false;
        processQueue(new Error("No server configured"), null);
        forceLogout();
        return Promise.reject(error);
      }

      let outcome: RefreshOutcome;
      try {
        outcome = await refreshAndClassify(serverConfig);
      } finally {
        isRefreshing = false;
      }
      if (outcome.kind === "ok") {
        processQueue(null, outcome.token);
        originalRequest.headers.Authorization = `Bearer ${outcome.token}`;
        return api(originalRequest);
      }
      processQueue(outcome.error, null);
      return Promise.reject(outcome.error);
    }

    return Promise.reject(error);
  }
);

// Test-only: drop any pending recovery rung / in-flight flag between tests
// (a queued ladder timer would otherwise outlive its test).
export function __resetSessionRecoveryForTests() {
  cancelRefreshRecovery();
  isRefreshing = false;
  failedQueue = [];
}
