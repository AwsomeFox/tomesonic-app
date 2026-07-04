// Helpers for detecting what media a library item has (audio vs ebook) and for
// fuzzily matching a separate ebook item to its audiobook counterpart (or vice
// versa) by title + author — Audiobookshelf often stores the ebook and the
// audiobook as two distinct library items.

const EBOOK_FORMATS = ["epub", "mobi", "azw3", "azw", "pdf", "cbr", "cbz", "fb2", "txt"];

/** True when the item has playable audio (tracks / duration). */
export function hasAudio(item: any): boolean {
  const m = item?.media || {};
  const numAudio = m.numAudioFiles ?? (Array.isArray(m.audioFiles) ? m.audioFiles.length : 0);
  const numTracks = m.numTracks ?? (Array.isArray(m.tracks) ? m.tracks.length : 0);
  return numAudio > 0 || numTracks > 0;
}

/** True when the item has an ebook file (any recognized format). */
export function hasEbook(item: any): boolean {
  const m = item?.media || {};
  return !!(m.ebookFile || m.ebookFormat);
}

/** The ebook format string (e.g. "epub", "pdf", "mobi") if any. */
export function getEbookFormat(item: any): string | null {
  const m = item?.media || {};
  const fmt =
    m.ebookFile?.ebookFormat ||
    m.ebookFile?.metadata?.ext ||
    m.ebookFormat ||
    null;
  if (!fmt) return null;
  return String(fmt).replace(/^\./, "").toLowerCase();
}

export function isKnownEbookFormat(fmt: string | null): boolean {
  return !!fmt && EBOOK_FORMATS.includes(fmt.toLowerCase());
}

// --- Fuzzy title / author matching ------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "of", "unabridged", "abridged", "audiobook",
  "novel", "book", "vol", "volume", "edition",
]);

/** Normalize a title for comparison: strip subtitle, parens, punctuation,
 *  diacritics and filler words, collapse whitespace. */
export function normalizeTitle(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  // Drop anything after a colon (subtitle) or in parentheses/brackets.
  s = s.split(":")[0];
  s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  // Strip diacritics.
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Non-alphanumerics → space.
  s = s.replace(/[^a-z0-9]+/g, " ");
  const tokens = s.split(/\s+/).filter((t) => t && !STOPWORDS.has(t));
  return tokens.join(" ").trim();
}

function titleTokens(raw: string): Set<string> {
  return new Set(normalizeTitle(raw).split(" ").filter(Boolean));
}

/** Jaccard similarity of the two normalized title token sets (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  ta.forEach((t) => {
    if (tb.has(t)) inter++;
  });
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function normalizeAuthor(raw: string): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Authors match if either full-name matches, or they share a surname token. */
export function authorsMatch(a: string, b: string): boolean {
  const na = normalizeAuthor(a);
  const nb = normalizeAuthor(b);
  if (!na || !nb) return true; // if one side lacks author info, don't block on it
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const surnameA = na.split(" ").pop() || "";
  const surnameB = nb.split(" ").pop() || "";
  return surnameA.length > 2 && surnameA === surnameB;
}

function itemTitle(item: any): string {
  return item?.media?.metadata?.title || item?.title || "";
}
function itemAuthor(item: any): string {
  const md = item?.media?.metadata;
  return md?.authorName || md?.author || item?.author || "";
}

/**
 * Whether two library items are likely the same book (different media).
 * Requires a strong title overlap AND compatible authors.
 */
export function isLikelySameBook(a: any, b: any): boolean {
  if (!a || !b || a.id === b.id) return false;
  const sim = titleSimilarity(itemTitle(a), itemTitle(b));
  const normA = normalizeTitle(itemTitle(a));
  const normB = normalizeTitle(itemTitle(b));
  // Containment (one title contains the other — subtitle variants) only counts
  // when the token counts are close. Otherwise "Dune" would match "Dune
  // Messiah" (sim exactly 0.5) — different books in the same series.
  const tokensA = normA.split(" ").filter(Boolean).length;
  const tokensB = normB.split(" ").filter(Boolean).length;
  const tokenRatio =
    Math.max(tokensA, tokensB) > 0 ? Math.min(tokensA, tokensB) / Math.max(tokensA, tokensB) : 0;
  const containment =
    normA.length > 0 && normB.length > 0 && (normA.includes(normB) || normB.includes(normA));
  const titleOk = sim >= 0.8 || (containment && sim >= 0.5 && tokenRatio >= 0.7);
  return titleOk && authorsMatch(itemAuthor(a), itemAuthor(b));
}

/** From a list of candidate items, pick the best same-book match to `base`. */
export function bestCounterpart(base: any, candidates: any[]): any | null {
  let best: any = null;
  let bestScore = 0;
  for (const c of candidates || []) {
    if (!isLikelySameBook(base, c)) continue;
    const score = titleSimilarity(itemTitle(base), itemTitle(c));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
