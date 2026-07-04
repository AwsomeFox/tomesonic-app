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
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** "H hr M min remaining" / "M min remaining" / "S sec remaining" / "" when <=0. */
export function remainingPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min remaining`;
  if (m > 0) return `${m} min remaining`;
  return `${Math.floor(seconds)} sec remaining`;
}
