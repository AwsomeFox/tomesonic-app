/**
 * Server liveness polling for disruptive maintenance operations — currently
 * the backup restore flow (GitHub issue #60), where the ABS server swaps its
 * whole database out from under every open connection.
 *
 * WHY RAW AXIOS AND NOT THE `api` SINGLETON: the shared api instance attaches
 * the session auth header and carries a 401-refresh interceptor whose failure
 * path ends in forceLogout(). Mid-restore the server can transiently reject
 * any token (the restored database may not even contain our user yet), and a
 * forceLogout fired from a background poll would tear the navigator down
 * under the "waiting for the server" screen. So each probe is a bare
 * axios.get with no auth attached.
 *
 * WHY /ping AND NOT /status: GET /ping is unauthenticated and answers a
 * static `{ success: true }` without touching the database; /status reads
 * server state and can 500 while the database is still being swapped. /ping
 * answering is exactly the signal we want: "the HTTP layer is back".
 */
import axios from "axios";

export interface WaitForServerUpOptions {
  /** First retry delay in ms; grows 1.5x per failed probe. Default 3000. */
  baseIntervalMs?: number;
  /** Ceiling for the growing delay (before jitter). Default 10000. */
  maxIntervalMs?: number;
  /** Random 0..jitterMs added to every delay (de-syncs clients). Default 1000. */
  jitterMs?: number;
  /** ABSOLUTE epoch-ms deadline — polling stops once Date.now() passes it. */
  deadlineAt: number;
  /** Per-probe axios timeout. Default 5000. */
  probeTimeoutMs?: number;
  /** Checked before every probe and every sleep; true stops polling silently. */
  isCancelled: () => boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `<address>/ping` until the server answers, the absolute deadline
 * passes, or the caller cancels.
 *
 * A probe only counts as "up" when axios resolves (2xx) AND the body is the
 * literal `{ success: true }` — a reverse proxy's 502/504 HTML error page (or
 * a captive portal) served with a 200 must not read as "the server is back".
 */
export async function waitForServerUp(
  address: string,
  opts: WaitForServerUpOptions
): Promise<"up" | "timeout" | "cancelled"> {
  const base = opts.baseIntervalMs ?? 3000;
  const max = opts.maxIntervalMs ?? 10000;
  const jitter = opts.jitterMs ?? 1000;
  const probeTimeout = opts.probeTimeoutMs ?? 5000;
  const url = `${address.replace(/\/$/, "")}/ping`;

  for (let attempt = 0; ; attempt++) {
    if (opts.isCancelled()) return "cancelled";
    if (Date.now() >= opts.deadlineAt) return "timeout";
    try {
      const res = await axios.get(url, { timeout: probeTimeout });
      if (res?.data?.success === true) return "up";
      // 2xx without the expected body: a proxy answered for a dead upstream —
      // fall through and keep polling.
    } catch {
      // Refused / DNS / timeout / non-2xx — the server isn't back yet.
    }
    if (opts.isCancelled()) return "cancelled";
    const delay = Math.min(base * Math.pow(1.5, attempt), max) + Math.random() * jitter;
    await sleep(delay);
  }
}
