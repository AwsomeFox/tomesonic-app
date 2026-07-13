// Shared display formatters. Consolidated from duplicated copies across the
// admin/library screens — behavior matches those originals exactly so existing
// callers are unaffected if migrated later.

/** Human-readable byte size, switching from MB to GB at 1024MB. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  // Branch on the ROUNDED MB value, not the raw one: a size in [1023.5, 1024)
  // MB rounds to "1024" at the 0-decimal display precision, so a raw `mb >= 1024`
  // check would render "1024 MB" instead of promoting it to "1.00 GB".
  if (Math.round(mb) >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * "45s" / "12m" / "3h 5m" — compact listening-time totals for admin stats.
 * Moved verbatim from the identical copies AdminSessionsScreen and
 * AdminUserDetailScreen used to carry (both import it from here now).
 * Sub-minute shows seconds; sub-hour shows whole minutes only.
 *
 * NOT the same contract as two nearby per-screen duration formatters, kept
 * separate on purpose (different UX): ItemHistoryScreen.formatListened is
 * compact but floors at "0m" (never shows "0s"), and
 * LibraryStatsScreen.durationPretty is verbose ("1 hr 5 min"). Do not merge.
 */
export function formatListeningTime(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Full-ladder byte size, B → KB → MB → GB → TB with a "0 B" floor — for sizes
 * that can be tiny (log files, backups) OR huge (library disk usage), unlike
 * formatBytes above, which is deliberately MB/GB-only to match its original
 * call sites (do NOT merge them; the two have different display contracts).
 * One decimal below 100, whole numbers from 100 up.
 */
export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/**
 * Short calendar date ("Mar 5, 2024") from an epoch-ms number or a date string.
 * Consolidates AdminSessionsScreen.formatWhen (en-US locale, "Unknown"
 * fallback) and ItemHistoryScreen.formatDate (device-default locale, ""
 * fallback) — pass the matching opts to reproduce either exactly:
 *   formatDateTime(ts, { locale: "en-US", fallback: "Unknown" })  // formatWhen
 *   formatDateTime(ts)                                            // formatDate
 * Falsy or unparseable input returns the fallback (default "").
 */
export function formatDateTime(
  ts: number | string | undefined,
  opts?: { locale?: string; fallback?: string }
): string {
  const fallback = opts?.fallback ?? "";
  if (!ts) return fallback;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString(opts?.locale, { month: "short", day: "numeric", year: "numeric" });
}
