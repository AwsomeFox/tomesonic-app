/**
 * Library filter-value encoding, shared by UI (FilterModal) and non-UI code
 * (utils/shelfLayout's see-all destinations). Lives in utils so utility
 * modules never import UI-layer components (bundling/cycle hygiene).
 */

// Mirrors the original app's $encode: base64 then URI-encode the value.
export function encodeFilterValue(value: string): string {
  // Lone surrogates (legal in JSON strings) make encodeURIComponent throw
  // URIError — in the try body AND in a naive catch fallback. Scrub them to
  // U+FFFD first so the function is total. Array.from iterates code points:
  // paired surrogates arrive as length-2 strings, lone ones as length-1 with
  // a code point in the surrogate range.
  const safe = Array.from(String(value ?? ""))
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return ch.length === 1 && cp >= 0xd800 && cp <= 0xdfff ? "�" : ch;
    })
    .join("");
  try {
    const b64 =
      typeof btoa === "function"
        ? btoa(unescape(encodeURIComponent(safe)))
        : (globalThis as any).Buffer?.from(safe, "utf8").toString("base64") ||
          safe;
    return encodeURIComponent(b64);
  } catch {
    return encodeURIComponent(safe);
  }
}
