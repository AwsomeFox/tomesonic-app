// "Whispersync-style" format switching (Phase 1): jump between the ebook
// reader and the audiobook player at the "same" spot in the book.
//
// Phase 1 maps positions by PERCENT — reading fraction ↔ audio position is a
// simple linear scale over the whole book. That is APPROXIMATE by nature:
// front matter, narration pace, and per-chapter length differences mean the
// landing spot can be off by a few minutes / pages. Every UI entry point must
// confirm with the user before jumping (see ReaderScreen / PlayerBottomSheet).
//
// ─── SMIL SWAP POINT ─────────────────────────────────────────────────────────
// The two mapping functions below are the ONLY place position translation
// happens. The Storyteller-style exact-sync engine (SMIL media overlays,
// built in a parallel workstream) replaces these bodies — same signatures,
// likely made async and keyed by item — and every caller keeps working.
// Keep ALL mapping + target-resolution logic in this file so that swap stays
// a one-file change.
// ─────────────────────────────────────────────────────────────────────────────

import { api } from "./api";
import { hasAudio, hasEbook, getEbookFormat, bestCounterpart } from "./bookMatch";

/**
 * Reading fraction (0..1) → absolute audio position (seconds).
 * Phase 1: linear percent mapping. APPROXIMATE — see header. SMIL swap point.
 */
export function audioPositionForReadingFraction(fraction: number, duration: number): number {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const d = Math.max(0, Number(duration) || 0);
  return f * d;
}

/**
 * Absolute audio position (seconds) → reading fraction (0..1).
 * Phase 1: linear percent mapping. APPROXIMATE — see header. SMIL swap point.
 */
export function readingFractionForAudioPosition(position: number, duration: number): number {
  const d = Math.max(0, Number(duration) || 0);
  if (d <= 0) return 0;
  return Math.max(0, Math.min(1, (Number(position) || 0) / d));
}

// --- Target resolution -------------------------------------------------------
// ABS often stores the ebook and the audiobook as two distinct library items,
// so "the audio for this ebook" is either the SAME item (it has tracks) or a
// fuzzy title+author sibling found via library search (the same pattern as
// ItemDetailScreen's counterpart effect / utils/bookMatch).

export interface AudioTarget {
  itemId: string;
  /** Whole-book audio duration (seconds) when known. For DISPLAY/estimates
   *  only — the live playback-store duration wins for the actual seek. */
  duration?: number;
  title?: string;
}

export interface EbookTarget {
  itemId: string;
  /** Normalized ebook format, e.g. "epub" / "pdf" (see getEbookFormat). */
  ebookFormat: string;
  title?: string;
}

/** Formats the in-app reader can open at an arbitrary fraction (foliate-js).
 *  PDFs restore by page number instead, so a percent jump isn't possible. */
const FRACTION_JUMP_FORMATS = ["epub", "mobi", "azw3", "azw", "kf8"];
export function canJumpToFraction(ebookFormat: string | null | undefined): boolean {
  return !!ebookFormat && FRACTION_JUMP_FORMATS.includes(String(ebookFormat).toLowerCase());
}

async function fetchItem(itemId: string): Promise<any | null> {
  const r = await api.get(`/api/items/${itemId}?expanded=1`);
  return r.data || null;
}

/** The downloaded copy of `itemId`, if any (offline resolution source). */
function downloadedItem(itemId: string): any | null {
  try {
    const { useDownloadStore } = require("../store/useDownloadStore");
    return useDownloadStore.getState().completedDownloads[itemId] || null;
  } catch {
    return null;
  }
}

/** Same-book sibling in the other format, via library search + bestCounterpart
 *  (mirrors ItemDetailScreen's counterpart effect). */
async function findCounterpart(item: any): Promise<any | null> {
  const libraryId = item?.libraryId;
  const title = item?.media?.metadata?.title;
  if (!libraryId || !title) return null;
  const r = await api.get(
    `/api/libraries/${libraryId}/search?q=${encodeURIComponent(String(title).slice(0, 60))}&limit=10`
  );
  const books = (r.data?.book || []).map((b: any) => b.libraryItem).filter(Boolean);
  return bestCounterpart(item, books);
}

/**
 * Where to LISTEN to the book `itemId` is the ebook of: the same item when it
 * has audio tracks, else the fuzzy-matched audiobook sibling. Null when there
 * is no audio anywhere (or the item is a podcast — format switching is a
 * book-only feature). Never throws; resolution failures resolve to null.
 */
export async function resolveAudioTarget(itemId: string): Promise<AudioTarget | null> {
  try {
    // Offline-first: a downloaded book plays fully from local files (no /play
    // session), so a network failure here must not report "no audiobook
    // available" when the audio is already on the device.
    const dl = downloadedItem(itemId);
    if (dl && Array.isArray(dl?.meta?.tracks) && dl.meta.tracks.length > 0) {
      return { itemId, duration: Number(dl?.meta?.duration) || undefined, title: dl.title };
    }
    const item = await fetchItem(itemId);
    if (!item || item.mediaType === "podcast") return null;
    const title = item?.media?.metadata?.title || undefined;
    if (hasAudio(item)) {
      return { itemId: item.id || itemId, duration: Number(item?.media?.duration) || undefined, title };
    }
    const match = await findCounterpart(item);
    if (match && hasAudio(match)) {
      return {
        itemId: match.id,
        duration: Number(match?.media?.duration) || undefined,
        title: match?.media?.metadata?.title || title,
      };
    }
    return null;
  } catch (e) {
    console.warn("[formatSwitch] resolveAudioTarget failed:", e);
    return null;
  }
}

/**
 * Where to READ the book `itemId` is the audio of: the same item when it has
 * an ebook file, else the fuzzy-matched ebook sibling. Null when there is no
 * ebook anywhere (or the item is a podcast). Never throws.
 */
export async function resolveEbookTarget(itemId: string): Promise<EbookTarget | null> {
  try {
    // Offline-first (see resolveAudioTarget): a downloaded ebook opens from
    // its local file, so resolve it without the network when present.
    const dl = downloadedItem(itemId);
    const ebookPart = dl?.parts?.find((p: any) => p?.id === "ebook");
    if (ebookPart?.filename) {
      const fmt = String(ebookPart.filename.split(".").pop() || "").toLowerCase();
      if (fmt) return { itemId, ebookFormat: fmt, title: dl.title };
    }
    const item = await fetchItem(itemId);
    if (!item || item.mediaType === "podcast") return null;
    const title = item?.media?.metadata?.title || undefined;
    if (hasEbook(item)) {
      const fmt = getEbookFormat(item);
      if (fmt) return { itemId: item.id || itemId, ebookFormat: fmt, title };
    }
    const match = await findCounterpart(item);
    if (match && hasEbook(match)) {
      const fmt = getEbookFormat(match);
      if (fmt) return { itemId: match.id, ebookFormat: fmt, title: match?.media?.metadata?.title || title };
    }
    return null;
  } catch (e) {
    console.warn("[formatSwitch] resolveEbookTarget failed:", e);
    return null;
  }
}

/** "~h:mm"-style clock for the confirmation dialogs (e.g. "1:23", "0:47").
 *  Deliberately minute-grained — a percent-mapped jump is approximate, and a
 *  seconds-precise timestamp would overpromise. */
export function approximateClock(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}
