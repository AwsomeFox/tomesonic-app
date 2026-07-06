import axios from "axios";

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
  language?: string;
  isAvailable?: boolean;
}

// The app is English-only today — foreign-language editions of an author's
// or series' books read as noise in the missing lists. Products with NO
// language attribute are kept (dropping unknowns hides real books).
const APP_LANGUAGE = "english";
function inAppLanguage(b: AudibleBook): boolean {
  return !b.language || b.language.toLowerCase() === APP_LANGUAGE;
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
    language: p.language || undefined,
  };
}

/** Loose title identity: lowercase, drop subtitles/punctuation/articles. */
export function titleKey(title?: string | null): string {
  return String(title || "")
    .toLowerCase()
    .split(":")[0]
    .replace(/\b(unabridged|abridged|a novel)\b/g, "")
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

export async function audibleAuthorBooks(name: string): Promise<AudibleBook[]> {
  const res = await axios.get(`${BASE}/catalog/products`, {
    params: {
      author: name,
      num_results: 50,
      products_sort_by: "-ReleaseDate",
      response_groups: GROUPS,
    },
    timeout: TIMEOUT,
  });
  return ((res.data?.products || [])
    .map(mapProduct)
    .filter(Boolean) as AudibleBook[]).filter(inAppLanguage);
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
  const want = titleKey(title);
  const hit = (res.data?.products || []).find((p: any) => titleKey(p.title) === want);
  return hit?.asin || null;
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
  // No exact name match — take any series from the top hit as a last resort.
  return res.data?.products?.[0]?.series?.[0]?.asin || null;
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

  // Batch product details (API caps ~50 asins per call).
  const out: AudibleBook[] = [];
  for (let i = 0; i < asins.length; i += 40) {
    const chunk = asins.slice(i, i + 40);
    const details = await axios.get(`${BASE}/catalog/products`, {
      params: { asins: chunk.join(","), response_groups: GROUPS },
      timeout: TIMEOUT,
    });
    for (const p of details.data?.products || []) {
      const mapped = mapProduct(p);
      if (mapped && inAppLanguage(mapped)) out.push(mapped);
    }
  }
  // Preserve series order.
  const order = new Map(asins.map((a, i) => [a, i]));
  out.sort((a, b) => (order.get(a.asin) ?? 999) - (order.get(b.asin) ?? 999));
  return out;
}
