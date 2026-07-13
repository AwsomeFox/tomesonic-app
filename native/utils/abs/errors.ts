/**
 * Error normalization for the ABS admin API surface (utils/abs/*).
 *
 * DESIGN: every async function in utils/abs THROWS a normalized AbsError.
 * This is the OPPOSITE of utils/upNext.ts, which swallows every error — and
 * deliberately so: upNext is a best-effort background mirror of a local queue
 * that must keep working offline, so a failure there is invisible by design.
 * Admin actions (delete a user, purge a cache, rename a tag) are explicit,
 * user-initiated, and must SURFACE their failure — the caller needs to know
 * whether to show "you're offline", "you don't have permission", or "the
 * server rejected this" — so these modules never swallow.
 *
 * The offline test is the ItemDetailScreen.tsx idiom: an axios error with NO
 * `response` never reached the server (offline / DNS / timeout), while any
 * error WITH a response is a server-side rejection.
 */

// Type-only import: no runtime dependency from utils/abs onto components.
import type { IconName } from "../../components/Icon";

export type AbsErrorKind = "offline" | "auth" | "forbidden" | "unsupported" | "server" | "unknown";

export class AbsError extends Error {
  kind: AbsErrorKind;
  /** HTTP status when the server answered; undefined when offline/unknown. */
  status?: number;
  /** The original (axios) error, for logging. */
  cause?: any;

  constructor(kind: AbsErrorKind, message: string, status?: number, cause?: any) {
    super(message);
    this.name = "AbsError";
    this.kind = kind;
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Per-status overrides for normalizeAbsError. A bare kind re-classifies the
 * status; an object can also replace the message. Example:
 *   normalizeAbsError(e, { 404: "unknown" })            // 404 is a real miss here
 *   normalizeAbsError(e, { 403: { kind: "forbidden", message: "Admins only" } })
 */
export type AbsErrorStatusOverrides = Record<
  number,
  AbsErrorKind | { kind?: AbsErrorKind; message?: string }
>;

const DEFAULT_MESSAGES: Record<AbsErrorKind, string> = {
  offline: "Can't reach the server. Check your connection.",
  auth: "Your session has expired. Please log in again.",
  forbidden: "You don't have permission to do that.",
  // 404s on admin routes almost always mean the SERVER doesn't have the
  // feature (older version) rather than a missing record — hence "unsupported".
  unsupported: "The server doesn't support this (it may need an update).",
  server: "The server hit an error handling this request.",
  unknown: "Something went wrong. Please try again.",
};

function kindForStatus(status: number): AbsErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "unsupported";
  if (status >= 500) return "server";
  return "unknown";
}

/**
 * Normalize any thrown value into an AbsError. Already-normalized errors pass
 * through untouched (so nested helpers can re-throw safely).
 */
export function normalizeAbsError(e: any, overrides?: AbsErrorStatusOverrides): AbsError {
  if (e instanceof AbsError) return e;

  // The ItemDetailScreen.tsx idiom: no response object means the request never
  // reached the server — offline, DNS failure, or timeout.
  if (!e?.response) {
    return new AbsError("offline", DEFAULT_MESSAGES.offline, undefined, e);
  }

  const status: number = e.response.status;
  let kind = kindForStatus(status);
  // The server often sends a plain-text reason body (res.status(400).send(...)).
  let message: string =
    typeof e.response.data === "string" && e.response.data.length > 0 && e.response.data.length < 300
      ? e.response.data
      : DEFAULT_MESSAGES[kind];

  const override = overrides?.[status];
  if (typeof override === "string") {
    kind = override;
    message = DEFAULT_MESSAGES[kind];
  } else if (override && typeof override === "object") {
    if (override.kind) {
      kind = override.kind;
      message = DEFAULT_MESSAGES[kind];
    }
    if (override.message) message = override.message;
  }

  return new AbsError(kind, message, status, e);
}

/** True when the error means the request never reached the server. */
export function isOfflineError(e: any): boolean {
  if (e instanceof AbsError) return e.kind === "offline";
  return !e?.response;
}

/** True for a permission rejection (403). */
export function isForbiddenError(e: any): boolean {
  if (e instanceof AbsError) return e.kind === "forbidden";
  return e?.response?.status === 403;
}

/** True when the route doesn't exist on this server (404 → likely too old). */
export function isUnsupportedError(e: any): boolean {
  if (e instanceof AbsError) return e.kind === "unsupported";
  return e?.response?.status === 404;
}

// ---------------------------------------------------------------------------
// AbsError → <ErrorState/> props
// ---------------------------------------------------------------------------

export interface AbsErrorStateProps {
  icon: IconName;
  title: string;
  message: string;
  onRetry?: () => void;
}

export interface AbsErrorStateOptions {
  /**
   * Short lowercase noun phrase for what failed to load — "users", "email
   * settings". Feeds the generic titles ("Couldn't load users"). Omitted →
   * "Couldn't load this".
   */
  subject?: string;
  /** Passed through onto the returned props (ErrorState renders the retry pill). */
  onRetry?: () => void;
  /**
   * Per-kind copy overrides for screen-specific context, e.g.
   *   { forbidden: { message: "Only server admins can manage backups." },
   *     offline: { message: "Reconnect to manage server backups." } }
   * Unspecified fields keep the canonical defaults below.
   */
  overrides?: Partial<Record<AbsErrorKind, Partial<Omit<AbsErrorStateProps, "onRetry">>>>;
}

/**
 * THE canonical AbsError → ErrorState-props mapping. Admin screens previously
 * hand-rolled four divergent idioms of this (errorViewProps / errorStateProps
 * / describeLoadError / inline ternaries) — new call sites should use this
 * helper, and existing ones migrate in a consolidation pass. Accepts any
 * thrown value (raw axios errors are normalized first).
 */
export function absErrorToErrorStateProps(
  e: any,
  opts?: AbsErrorStateOptions
): AbsErrorStateProps {
  const err = normalizeAbsError(e);
  const subject = opts?.subject || "this";

  let props: AbsErrorStateProps;
  switch (err.kind) {
    case "offline":
      props = {
        icon: "cloud-off",
        title: "You're offline",
        message: "Server administration needs a connection.",
      };
      break;
    case "forbidden":
      props = {
        icon: "lock",
        title: "Admin access required",
        message: err.message || DEFAULT_MESSAGES.forbidden,
      };
      break;
    case "unsupported":
      props = {
        icon: "info",
        title: "Not supported by this server",
        message: err.message || DEFAULT_MESSAGES.unsupported,
      };
      break;
    case "auth":
      props = {
        icon: "lock",
        title: "Session expired",
        message: err.message || DEFAULT_MESSAGES.auth,
      };
      break;
    case "server":
      props = {
        icon: "warning",
        title: "The server hit an error",
        message: err.message || DEFAULT_MESSAGES.server,
      };
      break;
    default:
      props = {
        icon: "warning",
        title: `Couldn't load ${subject}`,
        message: err.message || DEFAULT_MESSAGES.unknown,
      };
  }

  const override = opts?.overrides?.[err.kind];
  if (override) props = { ...props, ...override };
  if (opts?.onRetry) props.onRetry = opts.onRetry;
  return props;
}

/**
 * AbsError → a single-line message string for a mutation-FAILURE dialog or
 * snackbar (as opposed to absErrorToErrorStateProps, which drives a full-screen
 * <ErrorState/>). Reproduces the identical hand-rolled ladder AdminBackupsScreen
 * and AdminFeedsScreen carry:
 *   offline   → "You're offline. Reconnect and try again."
 *   forbidden → opts.forbidden (a screen-specific "Only server admins…" line)
 *   else      → the (possibly server-provided) error message.
 * Accepts any thrown value; raw axios errors are normalized first.
 */
export function absErrorToActionMessage(err: any, opts?: { forbidden?: string }): string {
  const e = normalizeAbsError(err);
  if (e.kind === "offline") return "You're offline. Reconnect and try again.";
  if (e.kind === "forbidden") return opts?.forbidden ?? DEFAULT_MESSAGES.forbidden;
  return e.message || DEFAULT_MESSAGES.server;
}

/**
 * Shared request wrapper for the utils/abs domain modules: unwraps `.data`
 * and rethrows everything as AbsError. (Internal convenience — dependents
 * should call the named domain functions, not this.)
 */
export async function absRequest<T = any>(
  fn: () => Promise<{ data: T }>,
  overrides?: AbsErrorStatusOverrides
): Promise<T> {
  try {
    const res = await fn();
    return res.data;
  } catch (e) {
    throw normalizeAbsError(e, overrides);
  }
}
