/**
 * Server + role capability detection for admin features.
 *
 * The store's `user` object is seeded at login with the FULL login payload
 * (type + permissions), but a restored session only seeds `{ id, username }`
 * from the saved config — so admin screens call refreshCapabilities() (POST
 * /api/authorize) to (re)hydrate the full user, the serverSettings blob, and
 * with it the server version. Until that lands, getCapabilities() degrades
 * safely: unknown role → non-admin, unknown version → feature unsupported.
 *
 * Version-gated features:
 *  - API keys (GET/POST /api/api-keys ...) shipped in server v2.26.0
 *  - Media-item share links (POST /api/share/mediaitem) shipped in v2.10.0
 * The bundled ABS source snapshot (v2.35.1) has both routes but carries no
 * per-feature introduction metadata, so these constants are pinned from the
 * upstream release history. TODO: revisit if a dependent screen sees a 404 on
 * a version we claim supports the feature (isUnsupportedError already maps
 * that case for graceful fallback).
 */
import { useMemo } from "react";
import { api } from "../api";
import { useUserStore } from "../../store/useUserStore";

export interface ServerCapabilities {
  /** Semver string when known ("2.26.3"), else null (treated as "too old"). */
  serverVersion: string | null;
  isAdmin: boolean;
  isRoot: boolean;
  /** Edit item metadata/chapters, rename narrators/tags/genres. */
  canEditMetadata: boolean;
  /** Change covers — the server's cover upload route requires the `upload` permission, not `update`. */
  canUploadCover: boolean;
  canDelete: boolean;
  canDownload: boolean;
  canUpload: boolean;
  /**
   * Add personal e-reader devices (Account screen). ONLY an explicit
   * `permissions.createEreader === false` denies — the server defaults the
   * flag on, and a thin cold-restored user object (`{ id, username }`, no
   * permissions at all) must not lose the button before refreshCapabilities()
   * hydrates, so absent/undefined counts as allowed.
   */
  canCreateEreader: boolean;
  supportsApiKeys: boolean;
  supportsShareLinks: boolean;
  /** True once refreshCapabilities() has hydrated this session (serverSettings present). */
  refreshed: boolean;
}

/** First server version with the /api/api-keys routes. */
export const MIN_VERSION_API_KEYS = "2.26.0";
/** First server version with media-item share links (/api/share/mediaitem). */
export const MIN_VERSION_SHARE_LINKS = "2.10.0";

/**
 * Semver-ish comparison: does `version` satisfy `min`? Tolerates a leading
 * "v", ignores prerelease/build suffixes ("2.26.0-beta.1" → 2.26.0), and
 * missing segments count as 0 ("2.26" → 2.26.0). Unknown/garbage → false
 * (an unknown server is treated as NOT supporting a gated feature).
 */
export function meetsVersion(min: string, version?: string | null): boolean {
  const parse = (v: string): number[] | null => {
    const core = v.trim().replace(/^v/i, "").split(/[-+]/)[0];
    if (!core) return null;
    const parts = core.split(".");
    const nums: number[] = [];
    for (let i = 0; i < 3; i++) {
      const seg = parts[i];
      if (seg === undefined) {
        nums.push(0);
        continue;
      }
      if (!/^\d+$/.test(seg)) return null;
      nums.push(parseInt(seg, 10));
    }
    return nums;
  };
  if (typeof version !== "string") return false;
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true; // equal
}

function compute(user: any, serverSettings: any, config: any): ServerCapabilities {
  const type = user?.type;
  const isRoot = type === "root";
  const isAdmin = isRoot || type === "admin";
  const perms = user?.permissions || {};
  const canEditMetadata = isAdmin || !!perms.update;
  const canUpload = isAdmin || !!perms.upload;
  // serverSettings.version is the authoritative version (written by the
  // server on every settings save); the connect-time /status probe stashes a
  // fallback on the connection config.
  const serverVersion: string | null =
    (typeof serverSettings?.version === "string" && serverSettings.version) ||
    (typeof config?.version === "string" && config.version) ||
    null;
  return {
    serverVersion,
    isAdmin,
    isRoot,
    canEditMetadata,
    // The cover routes gate on canUpload server-side (see
    // LibraryItemController.uploadCover) — but changing a cover is a metadata
    // edit in the UI, so require both.
    canUploadCover: canEditMetadata && canUpload,
    canDelete: isAdmin || !!perms.delete,
    canDownload: isAdmin || !!perms.download,
    canUpload,
    // Only-explicit-false-denies (see the interface doc): the server enables
    // createEreader by default, so unknown/missing permissions stay allowed.
    canCreateEreader: perms.createEreader !== false,
    supportsApiKeys: meetsVersion(MIN_VERSION_API_KEYS, serverVersion),
    supportsShareLinks: meetsVersion(MIN_VERSION_SHARE_LINKS, serverVersion),
    refreshed: !!serverSettings,
  };
}

/** Synchronous snapshot from the user store (for non-React callers). */
export function getCapabilities(): ServerCapabilities {
  const s = useUserStore.getState();
  return compute(s.user, s.serverSettings, s.serverConnectionConfig);
}

/** Reactive capabilities — re-renders when the user/serverSettings change. */
export function useServerCapabilities(): ServerCapabilities {
  const user = useUserStore((s) => s.user);
  const serverSettings = useUserStore((s) => s.serverSettings);
  const config = useUserStore((s) => s.serverConnectionConfig);
  return useMemo(() => compute(user, serverSettings, config), [user, serverSettings, config]);
}

/** The last serverSettings blob hydrated by refreshCapabilities()/updateServerSettings(). */
export function getServerSettings(): any | null {
  return useUserStore.getState().serverSettings ?? null;
}

/**
 * Monotonic sequence over serverSettings STORE WRITES, shared with
 * utils/abs/server.updateServerSettings (which bumps it when it stores the
 * blob echoed by a successful PATCH /api/settings). refreshCapabilities()
 * snapshots the counter before its request and, if it advanced while
 * /api/authorize was in flight, skips its own serverSettings write — a slow
 * authorize response must never clobber a fresher PATCH echo with the stale
 * pre-PATCH blob. (user/version hydration still applies either way.)
 */
let settingsWriteSeq = 0;

/** Called by updateServerSettings() right before it stores a fresh PATCH echo. */
export function bumpSettingsWriteSeq(): void {
  settingsWriteSeq++;
}

/**
 * (Re)hydrate the full user + serverSettings from POST /api/authorize.
 * NEVER throws — capabilities simply stay stale/degraded on failure. Uses the
 * same stale-session guard as useUserStore.loadMediaProgress: snapshot the
 * session userId first so a slow response can't write account A's role into
 * account B's (or a logged-out) store — but bail only on a LOGOUT or an ACCOUNT
 * switch, NOT on a bare token rotation. /api/authorize is exactly the request
 * whose 401 the interceptor refreshes+replays, rotating the token mid-flight
 * for the SAME account; a strict-token guard would then discard the valid admin
 * response and strand real admins in the degraded non-admin state. Additionally
 * guarded against the settings write race (see settingsWriteSeq above).
 */
export async function refreshCapabilities(): Promise<void> {
  const cfg = useUserStore.getState().serverConnectionConfig;
  const sessionToken = cfg?.token;
  const sessionUserId = cfg?.userId;
  if (!sessionToken) return;
  const seqAtRequest = settingsWriteSeq;
  try {
    const res = await api.post("/api/authorize");
    const user = res.data?.user;
    if (!user || typeof user !== "object" || !user.id) return;
    const now = useUserStore.getState().serverConnectionConfig;
    if ((sessionToken && !now?.token) || now?.userId !== sessionUserId) return;
    const patch: any = { user };
    // Skip the serverSettings write when a PATCH /api/settings echo landed
    // while this authorize was in flight — ours is the stale pre-PATCH blob.
    if (settingsWriteSeq === seqAtRequest) {
      patch.serverSettings = res.data?.serverSettings ?? null;
    }
    // /api/authorize also reports the user's e-reader devices — same source
    // loadEReaderDevices uses, so keep them fresh for free.
    if (Array.isArray(res.data?.ereaderDevices)) {
      patch.ereaderDevices = res.data.ereaderDevices;
    }
    useUserStore.setState(patch);
  } catch {
    // Offline / expired session — leave existing state; callers render from
    // the (possibly degraded) getCapabilities() snapshot.
  }
}
