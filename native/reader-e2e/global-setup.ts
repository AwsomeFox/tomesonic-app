// Playwright global setup: generate the fixture EPUB and bake the REAL
// reader HTML (screens/ReaderScreen.tsx `ebookHtml`) once for all tests.
//
// This mirrors what the RN loader effect does (ReaderScreen.tsx ~L1590-1652):
// the app downloads the book, base64s the bytes, calls ebookHtml(base64, ...)
// and writes the result to a cache .html file that the WebView loads. Here
// the "download" is the generated fixture and the "WebView" is Chromium
// pointed at a local http server serving the same baked HTML.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadReaderModule, loadFoliateBundle, ARTIFACTS_DIR } from "./reader-module";

// The exact arguments the RN loader passes for a default-settings EPUB:
// theme colors, no saved CFI, 100% font, serif, 1.5 line-height, page-curl
// ON, 16px margin, paginated flow.
export const READER_PARAMS = {
  bg: "#ffffff",
  fg: "#111111",
  accent: "#4a90d9",
  startCfi: "",
  mime: "application/epub+zip",
  fontSize: 100,
  fontFamily: "serif",
  lineHeight: 1.5,
  pageCurl: true,
  margin: 16,
  flow: "paginated",
} as const;

export const EPUB_PATH = path.join(ARTIFACTS_DIR, "fixture.epub");
export const HTML_PATH = path.join(ARTIFACTS_DIR, "reader.html");

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  // Generate the fixture EPUB. Run the .mjs builder as a child process so no
  // ESM/CJS transpilation mismatch can bite the (CJS-transpiled) setup file.
  execFileSync(process.execPath, [path.join(__dirname, "fixtures", "build-epub.mjs"), EPUB_PATH], {
    stdio: "inherit",
  });

  const base64 = fs.readFileSync(EPUB_PATH).toString("base64");
  const { ebookHtml } = await loadReaderModule();

  // Coercion tripwire (see reader-module STUB_SOURCE): reset, bake, assert.
  (globalThis as any).__stubCoercions = [];
  const p = READER_PARAMS;
  const html = ebookHtml(
    base64,
    p.bg,
    p.fg,
    p.accent,
    p.startCfi,
    p.mime,
    p.fontSize,
    p.fontFamily,
    p.lineHeight,
    p.pageCurl,
    p.margin,
    p.flow
  );
  const coercions: { kind: string; stack?: string }[] = (globalThis as any).__stubCoercions;
  if (coercions.length > 0) {
    throw new Error(
      `ebookHtml() coerced ${coercions.length} stubbed module value(s) — a stub leaked into ` +
        `the baked reader page (it would silently interpolate as ""):\n` +
        coercions.map((c) => c.stack).join("\n---\n")
    );
  }

  assertBakedHtml(html, base64, await loadFoliateBundle());
  fs.writeFileSync(HTML_PATH, html);
}

/**
 * Sentinel checks on the baked HTML so a silently-degenerate bake (stubbed
 * value, refactored template, dropped payload) fails loudly here instead of
 * cascading into confusing in-browser test failures.
 */
function assertBakedHtml(html: string, base64: string, foliateBundle: string): void {
  const required = ["foliate-view", "setReaderMargin", "getReaderText", "__pgCurlBound", base64];
  for (const needle of required) {
    if (!html.includes(needle)) {
      const label = needle === base64 ? "<base64 epub payload>" : needle;
      throw new Error(`baked reader HTML is missing required content: ${label}`);
    }
  }

  // Length sanity: bundle + payload + a nontrivial amount of injected JS.
  const minLen = foliateBundle.length + base64.length + 5_000;
  if (html.length < minLen) {
    throw new Error(`baked reader HTML is suspiciously small: ${html.length} < ${minLen} bytes`);
  }

  // Forbidden tokens anywhere OUTSIDE the vendored bundle and the base64
  // payload (both may legitimately contain them): a bad interpolation bakes
  // "undefined" / "[object Object]" / NaN into the page. Verified: the
  // ebookHtml template itself contains none of these tokens.
  const scan = html.replace(foliateBundle, "").split(base64).join("");
  for (const bad of ["undefined", "[object Object]", "NaN"]) {
    const idx = scan.indexOf(bad);
    if (idx !== -1) {
      throw new Error(
        `baked reader HTML contains forbidden token ${JSON.stringify(bad)} outside the ` +
          `foliate bundle/base64 payload — context: ...${scan.slice(Math.max(0, idx - 120), idx + 120)}...`
      );
    }
  }
}
