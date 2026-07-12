// Accessibility-lens tests for the foliate reader HTML built by
// screens/ReaderScreen.tsx `ebookHtml(...)` — all against the REAL rendered
// DOM (real vendored foliate bundle, real fixture EPUB) in Chromium:
//
//   1. the page-curl gesture SURVIVES prefers-reduced-motion (guards the
//      deliberate removal of the OS reduce-motion gate — ReaderScreen.tsx
//      ~L621-628: Android WebViews over-report reduce-motion under battery
//      saver etc., so the explicit "Page Turn: None" setting is the
//      accommodation; a well-meaning re-add of the media-query gate must
//      fail here)
//   2. every built-in READER_THEMES bg/fg pair renders with a WCAG AA
//      contrast ratio (>= 4.5:1) in the section document — which doubles as
//      proof each theme actually applies to the rendered book
//   3. the lineHeight setting really scales the rendered line box
//   4. the outer document's tap-zone geometry: left 30% = previous page,
//      right 30% = next page, middle 40% = neither
//
// Touch gestures are synthesized as real TouchEvents on the OUTER document
// (the injected handlers at ReaderScreen.tsx ~L985-1091 read
// changedTouches[0].clientX/Y and gate the tap path on
// e.currentTarget === document), matching what the Android WebView delivers
// for taps/drags over the margins.

import { test, expect, Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { loadReaderModule, ReaderModule } from "./reader-module";
import { HTML_PATH, READER_PARAMS } from "./global-setup";

let server: http.Server;
let baseURL: string;
let readerModule: ReaderModule;

// COPIED (not imported) from reader.pw.ts by design: specs must not import
// from each other, so the small server/ready-wait/section-iframe helpers are
// duplicated here verbatim-in-spirit. If reader.pw.ts's copies change shape,
// update these to match.
test.beforeAll(async () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  readerModule = await loadReaderModule();
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * Open the baked reader page with the RN WebView bridge shimmed (copied from
 * reader.pw.ts's beforeEach) and wait for BOTH 'ready' and the first
 * 'location' relocation. Explicit per-test (instead of a beforeEach) because
 * test 1 must emulate reduced motion BEFORE any page script runs.
 */
async function openReader(page: Page, opts: { reducedMotion?: boolean } = {}): Promise<void> {
  if (opts.reducedMotion) {
    await page.emulateMedia({ reducedMotion: "reduce" });
  }
  await page.addInitScript(() => {
    const w = window as any;
    w.__rn = [];
    w.ReactNativeWebView = {
      postMessage: (s: string) => {
        try {
          w.__rn.push(JSON.parse(s));
        } catch {
          w.__rn.push({ type: "unparseable", raw: s });
        }
      },
    };
  });
  await page.goto(`${baseURL}/reader.html`);
  await page.waitForFunction(
    () => {
      const msgs = (window as any).__rn;
      return msgs.some((m: any) => m.type === "ready") && msgs.some((m: any) => m.type === "location");
    },
    undefined,
    { timeout: 45_000 }
  );
}

// ---------------------------------------------------------------------------
// In-page measurement helpers (copied from reader.pw.ts — see note above)
// ---------------------------------------------------------------------------

/** Computed colors of the section document (what the eye actually sees). */
function sectionColors(page: Page) {
  return page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    const win = doc.defaultView;
    return {
      docBg: win.getComputedStyle(doc.documentElement).backgroundColor,
      bodyBg: win.getComputedStyle(doc.body).backgroundColor,
      bodyColor: win.getComputedStyle(doc.body).color,
    };
  });
}

function locationCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__rn.filter((m: any) => m.type === "location").length);
}

function lastLocationFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
    const locs = (window as any).__rn.filter((m: any) => m.type === "location");
    return locs.length ? locs[locs.length - 1].fraction : -1;
  });
}

/** Wait — event-driven — for a NEW 'location' bridge message beyond `prev`. */
async function waitForNewLocation(page: Page, prev: number): Promise<number> {
  await page.waitForFunction(
    (p) => (window as any).__rn.filter((m: any) => m.type === "location").length > p,
    prev
  );
  return lastLocationFraction(page);
}

// ---------------------------------------------------------------------------
// Touch synthesis on the OUTER document
// ---------------------------------------------------------------------------

type TouchStep = { type: "touchstart" | "touchmove" | "touchend"; x: number; y: number };

/**
 * Dispatch a sequence of real TouchEvents on the OUTER document — the exact
 * event shape the injected handlers consume (changedTouches[0].clientX/Y,
 * currentTarget === document for the tap path, cancelable moves so the curl
 * drag can preventDefault). Returns, per event, whether the page called
 * preventDefault on it (dispatchEvent returns false when prevented) — the
 * one closure-free signal that the curl drag path actually engaged.
 */
function dispatchOuterTouches(page: Page, steps: TouchStep[]): Promise<boolean[]> {
  return page.evaluate((seq) => {
    return seq.map((s: any) => {
      const t = new Touch({ identifier: 1, target: document.body, clientX: s.x, clientY: s.y });
      const live = s.type === "touchend" ? [] : [t];
      const ev = new TouchEvent(s.type, {
        changedTouches: [t],
        touches: live,
        targetTouches: live,
        bubbles: true,
        cancelable: true,
      });
      const notPrevented = document.dispatchEvent(ev);
      return !notPrevented; // true ⇒ a handler called preventDefault
    });
  }, steps as any);
}

/** A quick tap (dt≈0ms < 300, zero movement < 10px) at x fraction of width. */
async function tapOuterAt(page: Page, widthFraction: number): Promise<void> {
  const x = Math.round(600 * widthFraction); // viewport width fixed at 600 in the config
  await dispatchOuterTouches(page, [
    { type: "touchstart", x, y: 400 },
    { type: "touchend", x, y: 400 },
  ]);
}

/**
 * Wait for any in-flight page-turn animation to fully release. All three
 * commit paths (snapshot curl, slide+flap fallback, finishTurn) clear their
 * visible state in the same tick they clear drag.animating, so these DOM
 * signals are the observable equivalent of "the tap handler will accept the
 * next gesture". Event-driven — no fixed sleep.
 */
function waitForTurnQuiescence(page: Page): Promise<unknown> {
  return page.waitForFunction(() => {
    const overlayBusy = Array.from(document.querySelectorAll("canvas")).some(
      (c) => (c as HTMLElement).style.zIndex === "20" && (c as HTMLElement).style.display !== "none"
    );
    const view = document.querySelector("foliate-view") as HTMLElement | null;
    const curlEl = document.getElementById("pagecurl");
    return !overlayBusy && !!view && !view.style.transform && (!curlEl || curlEl.style.opacity !== "1");
  });
}

// ---------------------------------------------------------------------------
// WCAG relative luminance / contrast (computed IN the test, per WCAG 2.x)
// ---------------------------------------------------------------------------

/** Parse "rgb(r, g, b)" / "rgba(r, g, b, a)" into [r, g, b]. */
function parseRgb(color: string): [number, number, number] {
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) throw new Error(`unparseable computed color: ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const chan = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseRgb(a));
  const lb = relativeLuminance(parseRgb(b));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function hexToRgbString(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

// ---------------------------------------------------------------------------
// 1. Page curl survives prefers-reduced-motion (named past regression)
// ---------------------------------------------------------------------------

test("page curl stays bound and a drag still turns the page under prefers-reduced-motion", async ({ page }) => {
  // The app DELIBERATELY removed the OS reduce-motion gate on the curl
  // (ReaderScreen.tsx ~L621-628): many Android WebViews report
  // prefers-reduced-motion under battery saver / "remove animations" /
  // some WebView defaults, which silently disabled the curl even when the
  // user explicitly chose "Curl" (bug #3). The user-facing "Page Turn: None"
  // setting IS the motion accommodation. If anyone re-adds a
  // matchMedia('(prefers-reduced-motion: reduce)') gate, this test fails.
  await openReader(page, { reducedMotion: true });

  // Tripwire: the emulation really took — otherwise this test proves nothing.
  const reduced = await page.evaluate(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  expect(reduced).toBe(true);

  // The HTML is baked with pageCurl: true — attachPageTurn must still have
  // bound the capture-phase touch handlers to the section document.
  const bound = await page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    return doc.__pgCurlBound === true;
  });
  expect(bound).toBe(true);

  const countBefore = await locationCount(page);
  const fractionBefore = await lastLocationFraction(page);
  expect(fractionBefore).toBeGreaterThanOrEqual(0);

  // Synthesized horizontal drag, right-to-left (forward turn) on the OUTER
  // document: dx = -200px (progress 0.33 > 0.25 commit threshold, and also
  // "fast": dt < 250ms with |dx| > 60). The curl drag path preventDefaults
  // every decided touchmove (ReaderScreen.tsx onTouchMove) — a re-added
  // reduce-motion gate short-circuits that handler, so "no move was
  // prevented" is exactly the regression signature.
  const prevented = await dispatchOuterTouches(page, [
    { type: "touchstart", x: 450, y: 400 },
    { type: "touchmove", x: 430, y: 400 }, // > 8px, horizontal → drag decided
    { type: "touchmove", x: 390, y: 400 },
    { type: "touchmove", x: 330, y: 400 },
    { type: "touchmove", x: 270, y: 400 },
    { type: "touchmove", x: 250, y: 400 },
    { type: "touchend", x: 250, y: 400 },
  ]);
  expect(prevented.slice(1, 6).some(Boolean)).toBe(true); // curl drag engaged

  // The drag COMMITS a page turn: a new relocate posts and moves forward.
  const fractionAfter = await waitForNewLocation(page, countBefore);
  expect(fractionAfter).toBeGreaterThan(fractionBefore);
});

// ---------------------------------------------------------------------------
// 2. Every built-in reader theme applies AND meets WCAG AA in the rendered doc
// ---------------------------------------------------------------------------

test("every READER_THEMES bg/fg pair applies to the section document with WCAG AA contrast", async ({ page }) => {
  // Read the ACTUAL theme table out of screens/ReaderScreen.tsx (READER_THEMES,
  // ~L59-63) so this test always exercises the live values — if a theme is
  // added or a color tweaked, the new pair is tested automatically.
  const src = fs.readFileSync(path.join(__dirname, "..", "screens", "ReaderScreen.tsx"), "utf8");
  const block = src.match(/const READER_THEMES[^=]*=\s*\{([\s\S]*?)\n\};/);
  expect(block, "READER_THEMES table not found in ReaderScreen.tsx").not.toBeNull();
  const themes = [...block![1].matchAll(/(\w+):\s*\{\s*bg:\s*"(#[0-9a-fA-F]{3,8})",\s*fg:\s*"(#[0-9a-fA-F]{3,8})"/g)].map(
    (m) => ({ key: m[1], bg: m[2], fg: m[3] })
  );
  // Sanity: the four known built-ins (light/sepia/dark/black) are present.
  expect(themes.length).toBeGreaterThanOrEqual(4);
  for (const key of ["light", "sepia", "dark", "black"]) {
    expect(themes.map((t) => t.key)).toContain(key);
  }

  await openReader(page);

  for (const theme of themes) {
    const expectedBg = hexToRgbString(theme.bg);
    const expectedFg = hexToRgbString(theme.fg);

    await page.evaluate(
      ([bg, fg]) => (window as any).setReaderTheme(bg, fg),
      [theme.bg, theme.fg]
    );
    // Event-driven: wait until the section document's COMPUTED colors are the
    // theme's pair (for the baked default theme this is already true).
    await page.waitForFunction(
      ([bg, fg]) => {
        const view = document.querySelector("foliate-view") as any;
        const doc = view.renderer.getContents()[0].doc;
        const win = doc.defaultView;
        return (
          win.getComputedStyle(doc.documentElement).backgroundColor === bg &&
          win.getComputedStyle(doc.body).color === fg
        );
      },
      [expectedBg, expectedFg]
    );

    // Read what actually renders and compute the WCAG ratio from THAT.
    const colors = await sectionColors(page);
    expect(colors.docBg, `${theme.key}: doc background applied`).toBe(expectedBg);
    expect(colors.bodyBg, `${theme.key}: body background applied`).toBe(expectedBg);
    expect(colors.bodyColor, `${theme.key}: body color applied`).toBe(expectedFg);

    const ratio = contrastRatio(colors.bodyBg, colors.bodyColor);
    // The invariant, not pinned values (known: light≈18.9, sepia≈7.5,
    // dark≈11.2, black≈10.9 — all comfortably AA for body text).
    expect(ratio, `${theme.key} (${theme.bg}/${theme.fg}) contrast ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThanOrEqual(21); // formula sanity bound
  }
});

// ---------------------------------------------------------------------------
// 3. lineHeight setting really scales the rendered line box
// ---------------------------------------------------------------------------

test("setReaderStyles lineHeight 1.2 → 2.0 measurably scales the rendered line box", async ({ page }) => {
  await openReader(page);

  // Push the EXACT CSS the app pushes on a line-height change
  // (buildLiveReaderCSS is shared by the per-setting effect and the on-ready
  // flush) — first at 1.2, then at 2.0, mirroring reader.pw.ts's font-size
  // test. Everything else stays at the baked defaults.
  const readParagraphMetrics = () =>
    page.evaluate(() => {
      const view = document.querySelector("foliate-view") as any;
      const doc = view.renderer.getContents()[0].doc;
      const p = doc.querySelector("p");
      if (!p) return null;
      const cs = doc.defaultView.getComputedStyle(p);
      return { lineHeight: parseFloat(cs.lineHeight), fontSize: parseFloat(cs.fontSize) };
    });

  const cssAt = (lineHeight: number) =>
    readerModule.buildLiveReaderCSS(
      READER_PARAMS.fontSize,
      READER_PARAMS.fontFamily,
      lineHeight,
      READER_PARAMS.bg,
      READER_PARAMS.fg
    );

  await page.evaluate((c) => (window as any).setReaderStyles(c), cssAt(1.2));
  // Event-driven: computed line-height converges on 1.2 × the font size.
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    const p = doc.querySelector("p");
    if (!p) return false;
    const cs = doc.defaultView.getComputedStyle(p);
    const lh = parseFloat(cs.lineHeight);
    const fs = parseFloat(cs.fontSize);
    return Number.isFinite(lh) && Number.isFinite(fs) && Math.abs(lh - fs * 1.2) < 1;
  });
  const small = await readParagraphMetrics();
  expect(small).not.toBeNull();
  expect(small!.lineHeight).toBeGreaterThan(0);

  await page.evaluate((c) => (window as any).setReaderStyles(c), cssAt(2.0));
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    const p = doc.querySelector("p");
    if (!p) return false;
    const cs = doc.defaultView.getComputedStyle(p);
    const lh = parseFloat(cs.lineHeight);
    const fs = parseFloat(cs.fontSize);
    return Number.isFinite(lh) && Number.isFinite(fs) && Math.abs(lh - fs * 2.0) < 1.5;
  });
  const large = await readParagraphMetrics();
  expect(large).not.toBeNull();

  // 2.0 / 1.2 ≈ 1.667 — assert a tolerant ratio band, not exact pixels, and
  // that the font size itself did NOT change (only the line box scaled).
  const ratio = large!.lineHeight / small!.lineHeight;
  expect(ratio).toBeGreaterThan(1.55);
  expect(ratio).toBeLessThan(1.8);
  expect(Math.abs(large!.fontSize - small!.fontSize)).toBeLessThanOrEqual(0.5);
});

// ---------------------------------------------------------------------------
// 4. Tap-zone geometry on the outer document: <0.3w prev, >0.7w next, middle none
// ---------------------------------------------------------------------------

test("outer-document tap zones: right 30% next, left 30% previous, middle 40% neither", async ({ page }) => {
  // Mirrors the injected tap handler (ReaderScreen.tsx ~L1057-1066): a quick
  // touchstart/touchend on the OUTER document (dt < 300ms, movement < 10px)
  // at clientX < 0.3*w → turn(1)=previous, > 0.7*w → turn(-1)=next, and the
  // middle 40% falls through to NOTHING (no chrome-toggle message exists in
  // the injected bridge vocabulary — ready/location/selection/search/ttsText/
  // error only — so "no page turn" is the full observable contract here).
  await openReader(page);

  const f0 = await lastLocationFraction(page);
  expect(f0).toBeGreaterThanOrEqual(0);

  // RIGHT zone (0.85w): fraction advances. This also puts us on page 2+ so
  // the later left tap has somewhere to go back to.
  let count = await locationCount(page);
  await tapOuterAt(page, 0.85);
  const fAfterRight = await waitForNewLocation(page, count);
  expect(fAfterRight).toBeGreaterThan(f0);
  await waitForTurnQuiescence(page); // let the turn animation release the handlers

  // CENTER (0.5w): NEITHER — no relocate, no turn animation engaging. A
  // negative assertion needs a time bound (same pattern as reader.pw.ts's
  // never-moves-backward test); no positive assertion hides behind it.
  const countBeforeCenter = await locationCount(page);
  await tapOuterAt(page, 0.5);
  await page.waitForTimeout(700); // a real turn posts its relocate well within this
  expect(await locationCount(page)).toBe(countBeforeCenter);
  expect(await lastLocationFraction(page)).toBe(fAfterRight);
  const centerEngagedTurn = await page.evaluate(() => {
    const overlayBusy = Array.from(document.querySelectorAll("canvas")).some(
      (c) => (c as HTMLElement).style.zIndex === "20" && (c as HTMLElement).style.display !== "none"
    );
    const view = document.querySelector("foliate-view") as HTMLElement;
    return overlayBusy || !!view.style.transform;
  });
  expect(centerEngagedTurn).toBe(false);

  // LEFT zone (0.15w) from page 2+: fraction decreases.
  count = await locationCount(page);
  await tapOuterAt(page, 0.15);
  const fAfterLeft = await waitForNewLocation(page, count);
  expect(fAfterLeft).toBeLessThan(fAfterRight);
});
