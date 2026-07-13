// Shared display formatters. Consolidated from duplicated copies in
// PlayerScreen (secondsToTimestamp), LocalMediaScreen (formatBytes), and
// BookCard (remainingPretty) — behavior matches those originals exactly so
// existing callers are unaffected if migrated later.

/** H:MM:SS when hours>0, else M:SS. Mirrors the original app's $secondsToTimestamp. */
export function secondsToTimestamp(seconds: number): string {
  let s = seconds;
  if (!s || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  }
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

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

/** "H hr M min remaining" / "M min remaining" / "S sec remaining" / "" when <=0. */
export function remainingPretty(seconds: number): string {
  // < 1s rounds to "0 sec remaining" — treat sub-second remainders as done.
  if (!seconds || seconds < 1) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min remaining`;
  if (m > 0) return `${m} min remaining`;
  return `${Math.floor(seconds)} sec remaining`;
}
