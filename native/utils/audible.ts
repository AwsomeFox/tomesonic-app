import axios from "axios";
import { authorsMatch } from "./bookMatch";

/**
 * Audible's public catalog API — keyless, fast (~1-2s), and the same data
 * RMAB slowly scrapes out of Audible's HTML. Used for DISCOVERY only (what
 * books exist for an author/series); requesting stays on RMAB.
 */

const BASE = "https://api.audible.com/1.0";
// product_desc is requested for completeness, but unauthenticated catalog
// calls never actually return publisher_summary — descriptions come from
// Audnexus (see audibleBookDetails). Don't rely on it appearing here.
const GROUPS = "media,contributors,product_attrs,product_desc,series";
const TIMEOUT = 15000;

export interface AudibleBook {
  asin: string;
  title: string;
  author?: string;
  narrator?: string;
  description?: string;
  coverArtUrl?: string;
  releaseDate?: string;
  sequence?: string;
  seriesTitle?: string;
  language?: string;
  isAvailable?: boolean;
}

// The app is English-only today — foreign-language editions of an author's
// or series' books read as noise in the missing lists. Products with NO
// language attribute are kept (dropping unknowns hides real books).
// startsWith, not equality: catalog rows come back with variants like
// "English (US)" and strict comparison silently dropped real books.
const APP_LANGUAGE = "english";
function inAppLanguage(b: AudibleBook): boolean {
  return !b.language || b.language.toLowerCase().startsWith(APP_LANGUAGE);
}

function mapProduct(p: any): AudibleBook | null {
  if (!p?.asin || !p?.title) return null;
  const images = p.product_images || {};
  return {
    asin: p.asin,
    title: p.title,
    author: (p.authors || []).map((a: any) => a.name).filter(Boolean).join(", ") || undefined,
    narrator: (p.narrators || []).map((n: any) => n.name).filter(Boolean).join(", ") || undefined,
    description: p.publisher_summary || undefined,
    coverArtUrl: images["500"] || images["256"] || Object.values(images)[0] as string | undefined,
    releaseDate: p.release_date || undefined,
    sequence: p.series?.[0]?.sequence || undefined,
    seriesTitle: p.series?.[0]?.title || undefined,
    language: p.language || undefined,
  };
}

/** Loose title identity: lowercase, drop subtitles/punctuation/articles.
 *  LOSSY on purpose — "Mistborn: The Final Empire" and "Mistborn: The Well of
 *  Ascension" both collapse to "mistborn". NEVER use this alone to decide two
 *  titles are the same book (see titlesLikelySame); it exists for matching a
 *  title against a bare series/main-title string. */
export function titleKey(title?: string | null): string {
  return String(title || "")
    .toLowerCase()
    .split(":")[0]
    .replace(/\b(unabridged|abridged|a novel)\b/g, "")
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Strict title identity: like titleKey but KEEPS subtitle text, so distinct
 *  series volumes ("Series: Book One" vs "Series: Book Two") stay distinct. */
export function titleKeyFull(title?: string | null): string {
  return String(title || "")
    .toLowerCase()
    .replace(/\b(unabridged|abridged|a novel)\b/g, "")
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Whether two titles plausibly name the SAME book. Full normalized titles
 *  must match — except when exactly one side carries a subtitle, where the
 *  bare side may equal the other's pre-colon main title ("Oathbringer" vs
 *  "Oathbringer: Book Three of the Stormlight Archive"). Two subtitle-bearing
 *  titles with different subtitles are DIFFERENT books even when their main
 *  titles match — the old pre-colon-only comparison hid every other volume of
 *  a series-prefixed set once you owned one. */
export function titlesLikelySame(a?: string | null, b?: string | null): boolean {
  const fullA = titleKeyFull(a);
  const fullB = titleKeyFull(b);
  if (!fullA || !fullB) return false;
  if (fullA === fullB) return true;
  return titleKey(a) === fullB || fullA === titleKey(b);
}

/** Fast owned-title matcher for the missing-book diffs: precomputed key sets
 *  (linear instead of owned×candidates), full-title equality plus the
 *  one-sided-subtitle rule — with one crucial guard titlesLikelySame lacks:
 *  a bare owned title that IS the candidate's series name must not match
 *  ("Series: Volume" candidates all share that pre-colon prefix, so owning a
 *  bare "Mistborn" would hide every other Mistborn volume). */
export function buildOwnedTitleMatcher(
  ownedTitles: (string | null | undefined)[],
  seriesName?: string
): (candidate: { title?: string; seriesTitle?: string }) => boolean {
  const haveFull = new Set<string>();
  const haveBase = new Set<string>();
  for (const t of ownedTitles) {
    const full = titleKeyFull(t);
    if (!full) continue;
    haveFull.add(full);
    const base = titleKey(t);
    if (base) haveBase.add(base);
  }
  const fallbackSeriesKey = titleKey(seriesName || "");
  return (candidate) => {
    const full = titleKeyFull(candidate.title);
    if (!full) return false;
    // Same full normalized title.
    if (haveFull.has(full)) return true;
    // Owned subtitled ("Oathbringer: Book Three…") ↔ bare candidate title.
    if (haveBase.has(full)) return true;
    // Owned bare title ↔ candidate's pre-colon main title — allowed ONLY
    // when that prefix is affirmatively NOT the candidate's series name.
    // Fail CLOSED without a series signal (candidate without seriesTitle on
    // a screen with no fallback, e.g. the author page): hiding a real
    // missing volume is worse than showing an owned one.
    const base = titleKey(candidate.title);
    if (base && base !== full && haveFull.has(base)) {
      const seriesKey = titleKey(candidate.seriesTitle || "") || fallbackSeriesKey;
      if (!seriesKey) return false;
      return base !== seriesKey;
    }
    return false;
  };
}

export async function audibleAuthorBooks(name: string): Promise<AudibleBook[]> {
  // Paginate: a single 50-result page silently truncated prolific authors'
  // backlists out of the missing list. Stop on a short page; later pages are
  // best-effort (keep what already loaded on a transient failure).
  const out: AudibleBook[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 4; page++) {
    let products: any[] = [];
    try {
      const res = await axios.get(`${BASE}/catalog/products`, {
        params: {
          author: name,
          num_results: 50,
          page,
          products_sort_by: "-ReleaseDate",
          response_groups: GROUPS,
        },
        timeout: TIMEOUT,
      });
      products = res.data?.products || [];
    } catch (e) {
      if (page === 1) throw e;
      // Signal partiality so the missing-list UI can say "may be incomplete"
      // instead of presenting a truncated backlist as the whole catalog.
      (out as any).partial = true;
      break;
    }
    for (const p of products) {
      const mapped = mapProduct(p);
      if (mapped && inAppLanguage(mapped) && !seen.has(mapped.asin)) {
        seen.add(mapped.asin);
        out.push(mapped);
      }
    }
    if (products.length < 50) break;
    // Hard page cap hit on a FULL page — more almost certainly exists, so
    // the list must not present itself as the complete backlist.
    if (page === 4) (out as any).partial = true;
  }
  // The `author=` text filter is brittle: multi-author credits, "Last, First"
  // ordering, or a name-format drift between the library and Audible's catalog
  // can all yield zero products for an author who plainly has books. When that
  // happens, fall back to a plain keyword search over the name and keep only
  // rows that actually credit this author (authorsMatch). Best-effort — a
  // fallback failure leaves the (empty) primary result untouched.
  if (out.length === 0) {
    try {
      const res = await axios.get(`${BASE}/catalog/products`, {
        params: {
          keywords: name,
          num_results: 50,
          products_sort_by: "-ReleaseDate",
          response_groups: GROUPS,
        },
        timeout: TIMEOUT,
      });
      for (const p of res.data?.products || []) {
        const names = (p.authors || []).map((a: any) => a?.name).filter(Boolean);
        // A keyword hit with no author overlap (or no listed authors) is noise.
        if (!names.some((n: string) => authorsMatch(n, name))) continue;
        const mapped = mapProduct(p);
        if (mapped && inAppLanguage(mapped) && !seen.has(mapped.asin)) {
          seen.add(mapped.asin);
          out.push(mapped);
        }
      }
    } catch {
      // Keep the empty primary result on a fallback failure.
    }
  }
  return out;
}

/** Full details for one book via AUDNEXUS — the unauthenticated Audible
 *  catalog API never returns publisher_summary (verified live: title yes,
 *  summary always empty), so descriptions must come from Audnexus, which
 *  serves the same Audible metadata with summaries, keyless. */
export async function audibleBookDetails(asin: string): Promise<AudibleBook | null> {
  const res = await axios.get(`https://api.audnex.us/books/${asin}`, { timeout: TIMEOUT });
  const d = res.data;
  if (!d?.asin || !d?.title) return null;
  return {
    asin: d.asin,
    title: d.title,
    author: (d.authors || []).map((a: any) => a.name).filter(Boolean).join(", ") || undefined,
    narrator: (d.narrators || []).map((n: any) => n.name).filter(Boolean).join(", ") || undefined,
    description: d.summary ? String(d.summary).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined,
    coverArtUrl: d.image || undefined,
    releaseDate: d.releaseDate || undefined,
    sequence: d.seriesPrimary?.position || undefined,
    language: d.language || undefined,
  };
}

/** Colon-delimited title segments, each normalized like titleKeyFull —
 *  "Mistborn: The Final Empire" → ["mistborn", "finalempire"]. Lets the
 *  matcher accept a series-prefix mismatch ONLY on a real segment boundary:
 *  raw substring containment matched "Dune" inside "Dune Messiah" and
 *  silently requested the wrong book. */
function titleSegmentKeys(title?: string | null): string[] {
  return String(title || "")
    .split(":")
    .map((s) =>
      s
        .toLowerCase()
        .replace(/\b(unabridged|abridged|a novel)\b/g, "")
        .replace(/^\s*(the|a|an)\s+/, "")
        .replace(/[^a-z0-9]/g, "")
    )
    .filter(Boolean);
}

/** Best-match ASIN for a title/author — for ABS items without one. */
export async function audibleFindBookAsin(title: string, author?: string): Promise<string | null> {
  const res = await axios.get(`${BASE}/catalog/products`, {
    params: {
      keywords: [title, author].filter(Boolean).join(" "),
      num_results: 10,
      response_groups: "product_attrs",
    },
    timeout: TIMEOUT,
  });
  // Score candidates rather than demanding exact pre-colon equality: library
  // titles routinely omit (or add) the series prefix/subtitle relative to the
  // catalog ("The Final Empire" vs "Mistborn: The Final Empire"), which used
  // to fail the whole request with "Couldn't match this book on Audible".
  const wantFull = titleKeyFull(title);
  const wantBase = titleKey(title);
  const wantSegments = titleSegmentKeys(title);
  let best: any = null;
  let bestScore = 0;
  for (const p of res.data?.products || []) {
    const full = titleKeyFull(p.title);
    const base = titleKey(p.title);
    let score = 0;
    if (full && full === wantFull) score = 4;
    else if (titlesLikelySame(p.title, title)) score = 3;
    // Series-prefix mismatch BOTH ways, but only on a real segment boundary:
    // the catalog may add a prefix the library lacks ("Mistborn: The Final
    // Empire" vs "The Final Empire") or vice versa. Raw substring containment
    // scored "Dune" for the query "Dune Messiah" — a DIFFERENT book — and a
    // wrong ASIN here silently requests the wrong title.
    else if (
      wantFull &&
      full &&
      (titleSegmentKeys(p.title).includes(wantFull) || wantSegments.includes(full))
    )
      score = 2;
    else if (wantBase && base === wantBase) score = 1;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best?.asin || null;
}

/** The series a book belongs to, via the book's catalog relationships. */
export async function audibleSeriesAsinFromBook(bookAsin: string): Promise<string | null> {
  const res = await axios.get(`${BASE}/catalog/products/${bookAsin}`, {
    params: { response_groups: "relationships" },
    timeout: TIMEOUT,
  });
  const rel = (res.data?.product?.relationships || []).find(
    (r: any) => r.relationship_type === "series" && r.relationship_to_product === "parent"
  );
  return rel?.asin || null;
}

/** Series ASIN by name via keyword search (fallback when no library ASINs). */
export async function audibleFindSeriesAsin(seriesName: string): Promise<string | null> {
  const res = await axios.get(`${BASE}/catalog/products`, {
    params: { keywords: seriesName, num_results: 10, response_groups: "series" },
    timeout: TIMEOUT,
  });
  const want = titleKey(seriesName);
  for (const p of res.data?.products || []) {
    const s = (p.series || []).find((x: any) => titleKey(x.title) === want);
    if (s?.asin) return s.asin;
  }
  // No exact name match — accept a series whose normalized name merely
  // CONTAINS the query (punctuation/subtitle drift), but never an unrelated
  // arbitrary series: the old any-top-hit fallback rendered a DIFFERENT
  // series' books as "missing from this series", request buttons and all.
  if (want) {
    for (const p of res.data?.products || []) {
      for (const s of p.series || []) {
        const got = titleKey(s.title);
        if (s.asin && got && (got.includes(want) || want.includes(got))) return s.asin;
      }
    }
  }
  return null;
}

/** Every book in a series, in series order. */
export async function audibleSeriesBooks(seriesAsin: string): Promise<AudibleBook[]> {
  const res = await axios.get(`${BASE}/catalog/products/${seriesAsin}`, {
    params: { response_groups: "relationships" },
    timeout: TIMEOUT,
  });
  const children = (res.data?.product?.relationships || [])
    .filter((r: any) => r.relationship_to_product === "child")
    .sort((a: any, b: any) => Number(a.sort || 0) - Number(b.sort || 0));
  const asins: string[] = children.map((c: any) => c.asin).filter(Boolean);
  if (asins.length === 0) return [];

  // Batch product details (API caps ~50 asins per call). Later chunks are
  // best-effort: one transient failure used to reject the whole lookup and
  // silently erase every already-fetched book from the missing list.
  const out: AudibleBook[] = [];
  for (let i = 0; i < asins.length; i += 40) {
    const chunk = asins.slice(i, i + 40);
    try {
      const details = await axios.get(`${BASE}/catalog/products`, {
        params: { asins: chunk.join(","), response_groups: GROUPS },
        timeout: TIMEOUT,
      });
      for (const p of details.data?.products || []) {
        const mapped = mapProduct(p);
        if (mapped && inAppLanguage(mapped)) out.push(mapped);
      }
    } catch (e) {
      if (i === 0) throw e;
      console.warn("[Audible] series detail chunk failed — returning partial list", e);
      // Signal partiality so the missing-list UI can say "may be incomplete".
      (out as any).partial = true;
      break;
    }
  }
  // Preserve series order.
  const order = new Map(asins.map((a, i) => [a, i]));
  out.sort((a, b) => (order.get(a.asin) ?? 999) - (order.get(b.asin) ?? 999));
  return out;
}
