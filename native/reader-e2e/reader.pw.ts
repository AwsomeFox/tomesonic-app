// Real-DOM behavior tests for the foliate reader HTML built by
// screens/ReaderScreen.tsx `ebookHtml(...)`. The recurring bug class here is
// "injected-JS behavior inside the WebView that Jest can only string-assert";
// these tests load the REAL generated HTML (real vendored foliate bundle,
// real fixture EPUB) in Chromium and assert actual rendered behavior:
//
//   1. margin applies live AND survives a theme switch (the twice-fixed
//      collapsed-inset regression)
//   2. setReaderStyles really changes the rendered font size (settings flush)
//   3. getReaderText returns a PAGE-bounded chunk and goNext continues where
//      the previous chunk ended (the TTS re-read regression)
//   4. the page-curl touch handlers are attached to the section document
//   5. seekForwardToFraction moves forward and never backward
//   6. the compound on-ready flush (styles→theme→margin→flow→curl in one
//      injection, ReaderScreen.tsx ~L1791) lands fully and coherently
//   7. a paginated→scrolled→paginated flow round-trip keeps the margin
//   8. goNext posts a well-formed, monotonic location payload
//   9. TTS extraction crosses the chapter boundary without re-reading
//
// foliate's shadow roots are CLOSED, so geometry is measured through the
// section iframe (reachable via view.renderer.getContents()[0].doc), whose
// bounding rect is in top-window coordinates.

import { test, expect, Page } from "@playwright/test";
import type http from "node:http";
import { loadReaderModule, ReaderModule } from "./reader-module";
import { READER_PARAMS } from "./global-setup";
import {
  startReaderServer,
  stopReaderServer,
  openReader,
  locationMessages,
  advanceOnePage,
  markerNumbers,
} from "./harness";

let server: http.Server;
let baseURL: string;
let readerModule: ReaderModule;

test.beforeAll(async () => {
  ({ server, baseURL } = await startReaderServer());
  readerModule = await loadReaderModule();
});

test.afterAll(async () => {
  await stopReaderServer(server);
});

test.beforeEach(async ({ page }) => {
  await openReader(page, baseURL);
});

// ---------------------------------------------------------------------------
// In-page measurement helpers
// ---------------------------------------------------------------------------

/** Rendered geometry of the section iframe (top-window coordinates). */
function sectionGeometry(page: Page) {
  return page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    const contents = view.renderer.getContents();
    const doc = contents[0].doc;
    const frame = doc.defaultView.frameElement as HTMLElement;
    const r = frame.getBoundingClientRect();
    // foliate writes the column layout (the in-page margin) as INLINE props
    // on the section documentElement — exactly what the old theme-switch bug
    // wiped. Capture both the outer inset (paginator grid) and those props.
    const de = doc.documentElement as HTMLElement;
    const cs = doc.defaultView.getComputedStyle(de);
    return {
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      winH: window.innerHeight,
      insetTop: r.top,
      insetBottom: window.innerHeight - r.bottom,
      inlineColumnWidth: de.style.columnWidth || "",
      inlineHeight: de.style.height || "",
      docHeight: parseFloat(cs.height),
      docColumnWidth: cs.columnWidth,
    };
  });
}

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

function sectionFontSize(page: Page): Promise<number> {
  return page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    return parseFloat(doc.defaultView.getComputedStyle(doc.body).fontSize);
  });
}

/** Call window.getReaderText() and return the ttsText message it posts. */
function extractTtsText(page: Page): Promise<{ text: string; pos: number }> {
  return page.evaluate(async () => {
    const w = window as any;
    const before = w.__rn.filter((m: any) => m.type === "ttsText").length;
    w.getReaderText();
    for (let i = 0; i < 150; i++) {
      const msgs = w.__rn.filter((m: any) => m.type === "ttsText");
      if (msgs.length > before) return msgs[msgs.length - 1];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("getReaderText never posted a ttsText message");
  });
}

function currentFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    return view.lastLocation ? view.lastLocation.fraction : -1;
  });
}

// ---------------------------------------------------------------------------
// 1. Margin applies live, and a theme switch must NOT collapse it
// ---------------------------------------------------------------------------

test("setReaderMargin(48) changes the rendered inset and setReaderTheme keeps it", async ({ page }) => {
  const initial = await sectionGeometry(page);
  // Baked with margin: 16 — the rendered inset above/below the section
  // iframe is the margin row of foliate's grid.
  expect(initial.insetTop).toBeGreaterThanOrEqual(READER_PARAMS.margin - 2);
  expect(initial.insetTop).toBeLessThanOrEqual(READER_PARAMS.margin + 2);

  await page.evaluate(() => (window as any).setReaderMargin(48));
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    const r = (doc.defaultView.frameElement as HTMLElement).getBoundingClientRect();
    return r.top >= 46 && r.top <= 50;
  });

  const withMargin = await sectionGeometry(page);
  expect(withMargin.insetTop).toBeGreaterThanOrEqual(46);
  expect(withMargin.insetTop).toBeLessThanOrEqual(50);
  expect(withMargin.insetBottom).toBeGreaterThanOrEqual(46);
  expect(withMargin.height).toBeLessThan(initial.height); // layout truly changed

  // Now the regression we fixed twice: switch the theme with NO page turn in
  // between — the colors must apply AND the inset must not collapse.
  await page.evaluate(() => (window as any).setReaderTheme("#000000", "#ffffff"));
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    return doc.defaultView.getComputedStyle(doc.documentElement).backgroundColor === "rgb(0, 0, 0)";
  });

  const colors = await sectionColors(page);
  expect(colors.docBg).toBe("rgb(0, 0, 0)");
  expect(colors.bodyBg).toBe("rgb(0, 0, 0)");
  expect(colors.bodyColor).toBe("rgb(255, 255, 255)");

  // Give any theme-triggered relayout a beat to settle, then re-measure.
  await page.waitForTimeout(250);
  const afterTheme = await sectionGeometry(page);
  expect(Math.abs(afterTheme.insetTop - withMargin.insetTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterTheme.insetBottom - withMargin.insetBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterTheme.height - withMargin.height)).toBeLessThanOrEqual(1);
  // The in-document column layout (foliate's inline props on the section
  // documentElement) must survive the theme push — wiping the inline style
  // attribute here was the original collapse.
  expect(afterTheme.inlineColumnWidth).not.toBe("");
  expect(afterTheme.inlineHeight).not.toBe("");
  expect(Math.abs(afterTheme.docHeight - withMargin.docHeight)).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// 2. Settings flush: setReaderStyles really changes the rendered font size
// ---------------------------------------------------------------------------

test("setReaderStyles with a larger font-size changes the rendered text size", async ({ page }) => {
  const before = await sectionFontSize(page); // 100% ≈ 16px
  expect(before).toBeGreaterThan(10);

  const geomBefore = await sectionGeometry(page);

  // The exact CSS the app pushes on a font-size change (buildLiveReaderCSS
  // is the shared snapshot used by the per-setting effect and the on-ready
  // flush) at 160%.
  const css = readerModule.buildLiveReaderCSS(
    160,
    READER_PARAMS.fontFamily,
    READER_PARAMS.lineHeight,
    READER_PARAMS.bg,
    READER_PARAMS.fg
  );
  await page.evaluate((c) => (window as any).setReaderStyles(c), css);

  await page.waitForFunction(
    (prev) => {
      const view = document.querySelector("foliate-view") as any;
      const doc = view.renderer.getContents()[0].doc;
      return parseFloat(doc.defaultView.getComputedStyle(doc.body).fontSize) > prev * 1.4;
    },
    before
  );
  const after = await sectionFontSize(page);
  expect(after).toBeGreaterThan(before * 1.4);
  expect(after).toBeLessThan(before * 1.8); // ~1.6x, not something wild

  // setStyles relayouts can drop the margin — the injected code re-asserts
  // it, so the inset must be unchanged after the flush.
  await page.waitForTimeout(250);
  const geomAfter = await sectionGeometry(page);
  expect(Math.abs(geomAfter.insetTop - geomBefore.insetTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geomAfter.insetBottom - geomBefore.insetBottom)).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// 3. TTS page-bounding: page-sized chunks, no re-read after goNext
// ---------------------------------------------------------------------------

test("getReaderText returns a page-bounded chunk and goNext continues without re-reading", async ({ page }) => {
  // Whole-section text length for comparison (chapter 1, ~15k chars).
  const fullLen = await page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    return String(doc.body.textContent || "").replace(/\s+/g, " ").trim().length;
  });
  expect(fullLen).toBeGreaterThan(5000); // fixture sanity: multi-page chapter

  const first = await extractTtsText(page);
  expect(first.text.length).toBeGreaterThan(200); // a real page of text
  // Page-sized, NOT the whole section (the old cursor→end-of-section bug
  // returned nearly fullLen here).
  expect(first.text.length).toBeLessThan(fullLen * 0.6);

  const m1 = markerNumbers(first.text);
  expect(m1.length).toBeGreaterThan(0);

  // Advance one page like the app's TTS_ADVANCE_JS does — but wait for the
  // relocate's `location` bridge message instead of sleeping.
  await advanceOnePage(page);

  const second = await extractTtsText(page);
  expect(second.text.length).toBeGreaterThan(200);
  expect(second.text.length).toBeLessThan(fullLen * 0.6);

  const m2 = markerNumbers(second.text);
  expect(m2.length).toBeGreaterThan(0);

  const maxM1 = Math.max(...m1);
  const minM2 = Math.min(...m2);
  // The next extraction starts where the previous ended: its first paragraph
  // marker is at (or just after) the previous chunk's last one — NOT back at
  // the top of the chapter (the giant-overlap re-read regression).
  expect(minM2).toBeGreaterThanOrEqual(maxM1);
  expect(Math.max(...m2)).toBeGreaterThan(maxM1); // it truly progressed
  // At most the boundary paragraph may be shared between the two chunks.
  const shared = m1.filter((m) => m2.includes(m));
  expect(shared.length).toBeLessThanOrEqual(1);
  // And the second chunk must not re-read the first chunk's opening text.
  expect(second.text.includes(first.text.slice(0, 80))).toBe(false);
});

// ---------------------------------------------------------------------------
// 4. Page-curl handlers attached to the section document
// ---------------------------------------------------------------------------

test("page-curl touch handlers are bound to the section document on load", async ({ page }) => {
  // The HTML is baked with pageCurl: true; attachPageTurn marks each section
  // document it binds (capture-phase touch handlers) with __pgCurlBound.
  const bound = await page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    return doc.__pgCurlBound === true;
  });
  expect(bound).toBe(true);
});

// ---------------------------------------------------------------------------
// 5. Forward-only linked seek
// ---------------------------------------------------------------------------

test("seekForwardToFraction advances forward but never backward", async ({ page }) => {
  const start = await currentFraction(page);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(start).toBeLessThan(0.2); // opened at the beginning

  await page.evaluate(() => (window as any).seekForwardToFraction(0.6));
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as any;
    return view.lastLocation && view.lastLocation.fraction > 0.45;
  });
  const forward = await currentFraction(page);
  expect(forward).toBeGreaterThan(0.45); // advanced to ~0.6
  expect(forward).toBeLessThan(0.8);

  // A stale/behind audio position must NOT drag the reader backward.
  await page.evaluate(() => (window as any).seekForwardToFraction(0.2));
  await page.waitForTimeout(800); // would have relocated by now if it moved
  const after = await currentFraction(page);
  expect(after).toBeGreaterThanOrEqual(forward - 0.005);
});

// ---------------------------------------------------------------------------
// 6. Compound on-ready settings flush (the R2 injection, replayed exactly)
// ---------------------------------------------------------------------------

test("the on-ready compound flush (styles→theme→margin→flow→curl) lands fully and coherently", async ({ page }) => {
  // ReaderScreen.tsx's 'ready' handler (~L1791-1799) injects ALL five setters
  // back-to-back in ONE script. The historical regression class was the
  // SEQUENCE (a later call clobbering an earlier one's layout), not any
  // single setter — so replay the exact same back-to-back calls in one
  // evaluate and assert the combined end state.
  const fontBefore = await sectionFontSize(page);
  const css = readerModule.buildLiveReaderCSS(160, "serif", 1.5, "#1a1a1a", "#cfcfcf");

  await page.evaluate((cleanCSS) => {
    const w = window as any;
    // Mirrors webRef.current.injectJavaScript(...) verbatim, with the app's
    // "dark" reader theme, Wide margin, paginated flow, curl on.
    w.setReaderStyles && w.setReaderStyles(cleanCSS);
    w.setReaderTheme && w.setReaderTheme("#1a1a1a", "#cfcfcf");
    w.setReaderMargin && w.setReaderMargin(32);
    w.setReaderFlow && w.setReaderFlow("paginated");
    w.setPageCurl && w.setPageCurl(true);
  }, css);

  // Wait until ALL THREE visible effects have landed (font, colors, inset).
  await page.waitForFunction(
    (prevFont) => {
      const view = document.querySelector("foliate-view") as any;
      const doc = view.renderer.getContents()[0].doc;
      const win = doc.defaultView;
      const font = parseFloat(win.getComputedStyle(doc.body).fontSize);
      const bgOk = win.getComputedStyle(doc.documentElement).backgroundColor === "rgb(26, 26, 26)";
      const r = (win.frameElement as HTMLElement).getBoundingClientRect();
      return font > prevFont * 1.4 && bgOk && r.top >= 30 && r.top <= 34;
    },
    fontBefore
  );

  // Let any trailing relayout settle, then assert the FINAL combined state —
  // nothing later in the sequence may have clobbered anything earlier.
  await page.waitForTimeout(250);
  const font = await sectionFontSize(page);
  expect(font).toBeGreaterThan(fontBefore * 1.4);
  expect(font).toBeLessThan(fontBefore * 1.8);

  const colors = await sectionColors(page);
  expect(colors.docBg).toBe("rgb(26, 26, 26)");
  expect(colors.bodyBg).toBe("rgb(26, 26, 26)");
  expect(colors.bodyColor).toBe("rgb(207, 207, 207)");

  const geom = await sectionGeometry(page);
  expect(geom.insetTop).toBeGreaterThanOrEqual(30);
  expect(geom.insetTop).toBeLessThanOrEqual(34);
  expect(geom.insetBottom).toBeGreaterThanOrEqual(30);
  expect(geom.inlineColumnWidth).not.toBe(""); // column layout intact
  expect(geom.inlineHeight).not.toBe("");

  const flow = await page.evaluate(
    () => (document.querySelector("foliate-view") as any).renderer.getAttribute("flow")
  );
  expect(flow).toBe("paginated");
});

// ---------------------------------------------------------------------------
// 7. Flow round-trip must not lose the margin/column layout
// ---------------------------------------------------------------------------

test("setReaderFlow paginated→scrolled→paginated keeps the margin layout", async ({ page }) => {
  // Same attributeChangedCallback→render() relayout class as both fixed
  // margin bugs — a flow flip re-runs the layout from the observed
  // attributes, so the margin must survive the round trip.
  await page.evaluate(() => (window as any).setReaderMargin(48));
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    const r = (doc.defaultView.frameElement as HTMLElement).getBoundingClientRect();
    return r.top >= 46 && r.top <= 50;
  });
  const paginated = await sectionGeometry(page);
  // Paginated layout: real px column width and the iframe laid out as a wide
  // horizontal column strip, 800 - 2*48 = 704px tall.
  expect(paginated.inlineColumnWidth).toMatch(/px$/);
  expect(paginated.inlineHeight).toMatch(/px$/);

  await page.evaluate(() => (window as any).setReaderFlow("scrolled"));
  // Scrolled mode really relaid out: the section iframe grows into one TALL
  // vertical flow (height >> viewport) and the columns are released
  // (column-width: auto). Measured: 600x6800-ish vs paginated's 6138x704.
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as any;
    if (view.renderer.getAttribute("flow") !== "scrolled") return false;
    const contents = view.renderer.getContents();
    if (!contents.length || !contents[0].doc) return false;
    const doc = contents[0].doc;
    const de = doc.documentElement as HTMLElement;
    const r = (doc.defaultView.frameElement as HTMLElement).getBoundingClientRect();
    return de.style.columnWidth === "auto" && r.height > window.innerHeight * 1.5;
  });

  await page.evaluate(() => (window as any).setReaderFlow("paginated"));
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as any;
    if (view.renderer.getAttribute("flow") !== "paginated") return false;
    const contents = view.renderer.getContents();
    if (!contents.length || !contents[0].doc) return false;
    const doc = contents[0].doc;
    const de = doc.documentElement as HTMLElement;
    const r = (doc.defaultView.frameElement as HTMLElement).getBoundingClientRect();
    // Column layout re-established AND the 48px margin survived the trip.
    return /px$/.test(de.style.columnWidth) && r.top >= 46 && r.top <= 50;
  });
  const roundTripped = await sectionGeometry(page);
  expect(roundTripped.inlineColumnWidth).toMatch(/px$/);
  expect(roundTripped.inlineHeight).toMatch(/px$/);
  expect(Math.abs(roundTripped.insetTop - paginated.insetTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(roundTripped.insetBottom - paginated.insetBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(roundTripped.height - paginated.height)).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// 8. Location payload shape (what RN's onWebMessage consumes)
// ---------------------------------------------------------------------------

test("goNext posts a well-formed, monotonic location payload", async ({ page }) => {
  const initialLocs = await locationMessages(page);
  expect(initialLocs.length).toBeGreaterThan(0);
  const start = initialLocs[initialLocs.length - 1];

  const next = await advanceOnePage(page);
  expect(next.cfi.startsWith("epubcfi(")).toBe(true);
  expect(next.fraction).toBeGreaterThan(0);
  expect(next.fraction).toBeLessThan(1);
  expect(next.fraction).toBeGreaterThan(start.fraction); // monotonic forward
  expect(next.pages).toBeGreaterThanOrEqual(2); // multi-page chapter
  expect(next.page).toBeGreaterThanOrEqual(1);
  expect(next.page).toBeLessThanOrEqual(next.pages);

  const again = await advanceOnePage(page);
  expect(again.cfi.startsWith("epubcfi(")).toBe(true);
  expect(again.fraction).toBeGreaterThan(next.fraction);
});

// ---------------------------------------------------------------------------
// 9. TTS across a section boundary: chapter 2 starts clean, no chapter 1 re-read
// ---------------------------------------------------------------------------

test("TTS extraction crosses the chapter boundary without re-reading chapter 1", async ({ page }) => {
  // Page forward until the extraction reports chapter 2 markers (each
  // advance waits for its relocate's location message — no sleeps).
  let text = "";
  let markers: number[] = [];
  let lastCh1Max = 0;
  for (let turn = 0; turn < 30; turn++) {
    await advanceOnePage(page);
    ({ text } = await extractTtsText(page));
    markers = markerNumbers(text);
    if (markers.some((m) => m >= 2000)) break;
    if (markers.length) lastCh1Max = Math.max(lastCh1Max, ...markers);
  }

  // We reached chapter 2 and had walked deep into chapter 1 first.
  expect(markers.some((m) => m >= 2000)).toBe(true);
  expect(lastCh1Max).toBeGreaterThan(1010); // walked well past c1p010
  // The first chapter-2 extraction contains NO chapter-1 markers (sections
  // are separate documents; leaking c1 text here would be the re-read bug
  // across the boundary) and starts at the very top of the chapter.
  expect(markers.some((m) => m < 2000)).toBe(false);
  expect(Math.min(...markers)).toBe(2001); // c2p001 — the chapter's first paragraph
  expect(text.includes("Marker c1p")).toBe(false);
});

// TODO(optional, deliberately skipped): a real touchscreen swipe test for the
// page-curl path (single swipe → exactly one relocate + the curl overlay
// engaging). Playwright has no high-level swipe; driving CDP
// Input.dispatchTouchEvent against the curl's snapshot/raster timing was
// judged too flaky for CI. The handler-attachment test above (__pgCurlBound)
// covers the regression that actually recurred (handlers not bound to the
// section doc).
