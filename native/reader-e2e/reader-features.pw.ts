// Real-DOM tests for the reader's in-book SEARCH, HIGHLIGHTS, and
// SELECTION→CFI features (screens/ReaderScreen.tsx injected JS ~L322-556) —
// the last reader batch. Everything is asserted against what actually
// renders/posts, using the shared harness (real ebookHtml output, real
// vendored foliate, generated fixture EPUB):
//
//   1. window.search posts searchResult messages with valid CFIs and
//      trimmed, slice-sized excerpts; readerHasSearch reflects capability
//   2. goToSearchResult(cfi) really relocates to the match's position
//   3. search matches paint overlay outlines; clearReaderSearch removes them
//   4. addHighlight paints the EXACT range rect; re-adding the same CFI
//      replaces (no duplicate); removeHighlight clears; omitted color falls
//      back to the default rgba(255,213,0,.4)
//   5. a programmatic selection posts {type:'selection', text, cfi} and that
//      cfi round-trips into a highlight painted over the same text; a
//      collapsed selection posts nothing
//
// Observability notes (probed against the real bundle): foliate's search
// adds each match as an annotation drawn with the Overlayer's default
// OUTLINE style (g[fill="none"][stroke]), while app highlights go through
// the injected draw-annotation painter (g[fill=<color>] > rect). The
// overlayer SVG lives OUTSIDE the section doc (closed-shadow container over
// the iframe) but is reachable as getContents()[0].overlayer.element, and
// its rect coordinates are in the section document's coordinate space —
// directly comparable to Range.getBoundingClientRect() in the section doc.

import { test, expect, Page } from "@playwright/test";
import type http from "node:http";
import { startReaderServer, stopReaderServer, openReader, locationMessages } from "./harness";

let server: http.Server;
let baseURL: string;

test.beforeAll(async () => {
  ({ server, baseURL } = await startReaderServer());
});

test.afterAll(async () => {
  await stopReaderServer(server);
});

test.beforeEach(async ({ page }) => {
  await openReader(page, baseURL);
});

// ---------------------------------------------------------------------------
// In-page helpers
// ---------------------------------------------------------------------------

type SearchResult = { type: "searchResult"; cfi: string; excerpt: string; label: string };

/**
 * Run window.search(query) and wait — event-driven — for its terminating
 * searchDone message; returns only the searchResult messages this run posted.
 */
async function runSearch(page: Page, query: string): Promise<SearchResult[]> {
  const before = await page.evaluate(() => ({
    done: (window as any).__rn.filter((m: any) => m.type === "searchDone").length,
    results: (window as any).__rn.filter((m: any) => m.type === "searchResult").length,
  }));
  await page.evaluate((q) => (window as any).search(q), query);
  await page.waitForFunction(
    (prev) => (window as any).__rn.filter((m: any) => m.type === "searchDone").length > prev,
    before.done
  );
  const all: SearchResult[] = await page.evaluate(() =>
    (window as any).__rn.filter((m: any) => m.type === "searchResult")
  );
  return all.slice(before.results);
}

/** All overlay groups currently painted for the visible section. */
function overlayGroups(page: Page) {
  return page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    const c = view.renderer.getContents()[0];
    if (!c || !c.overlayer) return [];
    const groups = Array.from(c.overlayer.element.querySelectorAll("g")) as Element[];
    return groups.map((g) => ({
      fill: g.getAttribute("fill"),
      stroke: g.getAttribute("stroke"),
      rects: (Array.from(g.querySelectorAll("rect")) as Element[]).map((r) => ({
        x: parseFloat(r.getAttribute("x") || "0"),
        y: parseFloat(r.getAttribute("y") || "0"),
        width: parseFloat(r.getAttribute("width") || "0"),
        height: parseFloat(r.getAttribute("height") || "0"),
      })),
    }));
  });
}

/** Wait until the overlay group count satisfies a predicate-by-count. */
function waitForOverlayCount(page: Page, op: ">" | "==", n: number) {
  return page.waitForFunction(
    ({ op, n }) => {
      const view = document.querySelector("foliate-view") as any;
      const c = view.renderer.getContents()[0];
      const count = c && c.overlayer ? c.overlayer.element.querySelectorAll("g").length : 0;
      return op === ">" ? count > n : count === n;
    },
    { op, n }
  );
}

/**
 * Build a DOM Range over the given marker text in the visible section and
 * return its CFI (via view.getCFI, exactly how the app derives selection
 * CFIs) plus its bounding rect in section-document coordinates.
 */
function markerRangeCfi(page: Page, marker: string) {
  return page.evaluate((mk) => {
    const view = document.querySelector("foliate-view") as any;
    const c = view.renderer.getContents()[0];
    const doc = c.doc;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const i = node.data.indexOf(mk);
      if (i !== -1) {
        const r = doc.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + mk.length);
        const rect = r.getBoundingClientRect();
        return {
          cfi: String(view.getCFI(c.index, r) || ""),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }
    }
    throw new Error("marker text not found in visible section: " + mk);
  }, marker);
}

function expectRectsMatch(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
) {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(1.5);
}

const DEFAULT_HIGHLIGHT = "rgba(255,213,0,.4)"; // injected addHighlight/painter fallback

// ---------------------------------------------------------------------------
// 1. Search: results, CFIs, excerpts, capability flag
// ---------------------------------------------------------------------------

test("search finds a unique marker with a valid CFI and a trimmed excerpt slice", async ({ page }) => {
  // Capability: the bundle has view.search, and the ready message told RN so
  // (this is what gates the search UI in the app).
  expect(await page.evaluate(() => (window as any).readerHasSearch)).toBe(true);
  const ready = await page.evaluate(() => (window as any).__rn.find((m: any) => m.type === "ready"));
  expect(ready.search).toBe(true);

  // Each fixture marker is unique book-wide → exactly one match.
  const results = await runSearch(page, "Marker c1p003");
  expect(results.length).toBe(1);
  const r = results[0];
  expect(r.cfi.startsWith("epubcfi(")).toBe(true);
  expect(r.label).toBe("Chapter 1");
  // The excerpt is a normalized slice AROUND the match — contains it, is
  // trimmed, and is nowhere near a whole section (~15k chars).
  expect(r.excerpt).toContain("Marker c1p003");
  expect(r.excerpt).toBe(r.excerpt.trim());
  expect(r.excerpt.length).toBeGreaterThan("Marker c1p003".length);
  expect(r.excerpt.length).toBeLessThan(400);
});

// ---------------------------------------------------------------------------
// 2. goToSearchResult relocates to the match
// ---------------------------------------------------------------------------

test("goToSearchResult(cfi) relocates the reader to the match's position", async ({ page }) => {
  const startLocs = await locationMessages(page);
  const startFraction = startLocs[startLocs.length - 1].fraction;
  expect(startFraction).toBeLessThan(0.2); // at the beginning

  // A marker in chapter 3 — roughly halfway through the 4-chapter book.
  const results = await runSearch(page, "Marker c3p001");
  expect(results.length).toBe(1);
  expect(results[0].label).toBe("Chapter 3");

  const before = startLocs.length;
  await page.evaluate((cfi) => (window as any).goToSearchResult(cfi), results[0].cfi);
  await page.waitForFunction(
    (prev) => (window as any).__rn.filter((m: any) => m.type === "location").length > prev,
    before
  );
  const locs = await locationMessages(page);
  const arrived = locs[locs.length - 1];
  expect(arrived.fraction).toBeGreaterThan(0.4); // moved to ~the match
  expect(arrived.fraction).toBeLessThan(0.75);
  expect(arrived.fraction).toBeGreaterThan(startFraction);
  expect(arrived.tocItem?.label).toBe("Chapter 3");
});

// ---------------------------------------------------------------------------
// 3. Search overlays paint and clearReaderSearch removes them
// ---------------------------------------------------------------------------

test("search paints match overlays in the section and clearReaderSearch removes them", async ({ page }) => {
  expect(await overlayGroups(page)).toHaveLength(0); // clean slate

  // Match on the VISIBLE first page so the annotation paints immediately.
  const results = await runSearch(page, "Marker c1p001");
  expect(results.length).toBe(1);

  // foliate adds each match as an annotation drawn with the overlayer's
  // default OUTLINE style — a real painted element, not just a message.
  await waitForOverlayCount(page, ">", 0);
  const groups = await overlayGroups(page);
  expect(groups.length).toBe(1);
  expect(groups[0].rects.length).toBeGreaterThan(0);
  expect(groups[0].rects[0].width).toBeGreaterThan(10); // covers real text

  await page.evaluate(() => (window as any).clearReaderSearch());
  await waitForOverlayCount(page, "==", 0);
  expect(await overlayGroups(page)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 4. Highlights: paint, replace-on-re-add, remove, default color
// ---------------------------------------------------------------------------

test("addHighlight paints the exact range, re-add replaces, removeHighlight clears, omitted color defaults", async ({ page }) => {
  // A valid CFI for a real range, derived the same way the app does
  // (view.getCFI over a constructed range).
  const target = await markerRangeCfi(page, "Marker c1p002");
  expect(target.cfi.startsWith("epubcfi(")).toBe(true);

  // Paint with an explicit color and assert the overlay rect IS the range
  // rect (the painter draws the range's client rects verbatim).
  const blue = "rgba(0, 128, 255, 0.5)";
  await page.evaluate(
    ([cfi, color]) => (window as any).addHighlight(cfi, color),
    [target.cfi, blue]
  );
  await page.waitForFunction(
    (color) => {
      const view = document.querySelector("foliate-view") as any;
      const c = view.renderer.getContents()[0];
      return !!c.overlayer && !!c.overlayer.element.querySelector(`g[fill="${color}"] rect`);
    },
    blue
  );
  let groups = await overlayGroups(page);
  expect(groups).toHaveLength(1);
  expect(groups[0].fill).toBe(blue);
  expect(groups[0].rects).toHaveLength(1);
  expectRectsMatch(groups[0].rects[0], target.rect);

  // Re-adding the SAME CFI must replace, not duplicate (foliate keys
  // annotations by value: remove-then-add). A different color makes the
  // replacement observable and completion waitable.
  const red = "rgba(255, 0, 0, 0.5)";
  await page.evaluate(
    ([cfi, color]) => (window as any).addHighlight(cfi, color),
    [target.cfi, red]
  );
  await page.waitForFunction(
    (color) => {
      const view = document.querySelector("foliate-view") as any;
      const c = view.renderer.getContents()[0];
      return !!c.overlayer.element.querySelector(`g[fill="${color}"]`);
    },
    red
  );
  groups = await overlayGroups(page);
  expect(groups).toHaveLength(1); // replaced — NOT stacked
  expect(groups[0].fill).toBe(red);
  expectRectsMatch(groups[0].rects[0], target.rect); // same range

  // Remove clears the painted overlay entirely.
  await page.evaluate((cfi) => (window as any).removeHighlight(cfi), target.cfi);
  await waitForOverlayCount(page, "==", 0);

  // Omitted color → the injected default yellow.
  await page.evaluate((cfi) => (window as any).addHighlight(cfi), target.cfi);
  await page.waitForFunction(
    (color) => {
      const view = document.querySelector("foliate-view") as any;
      const c = view.renderer.getContents()[0];
      return !!c.overlayer.element.querySelector(`g[fill="${color}"] rect`);
    },
    DEFAULT_HIGHLIGHT
  );
  groups = await overlayGroups(page);
  expect(groups).toHaveLength(1);
  expect(groups[0].fill).toBe(DEFAULT_HIGHLIGHT);
});

// ---------------------------------------------------------------------------
// 5. Selection → CFI → highlight round-trip
// ---------------------------------------------------------------------------

test("a real selection posts text+cfi and the cfi round-trips into a highlight over the same text", async ({ page }) => {
  const marker = "Marker c1p001";
  // Programmatic selection over known text + the pointerup the injected
  // reporter listens for (it reads the selection 10ms later).
  const selRect = await page.evaluate((mk) => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const i = node.data.indexOf(mk);
      if (i !== -1) {
        const r = doc.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + mk.length);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        doc.dispatchEvent(new Event("pointerup"));
        const rect = r.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    throw new Error("marker not found: " + mk);
  }, marker);

  await page.waitForFunction(() => (window as any).__rn.some((m: any) => m.type === "selection"));
  const selections = await page.evaluate(() =>
    (window as any).__rn.filter((m: any) => m.type === "selection")
  );
  expect(selections).toHaveLength(1);
  expect(selections[0].text).toBe(marker);
  expect(selections[0].cfi.startsWith("epubcfi(")).toBe(true);

  // Round-trip: the posted CFI must address the SAME text — highlighting it
  // paints exactly over the selected range.
  const green = "rgba(0, 200, 0, 0.5)";
  await page.evaluate(
    ([cfi, color]) => (window as any).addHighlight(cfi, color),
    [selections[0].cfi, green]
  );
  await page.waitForFunction(
    (color) => {
      const view = document.querySelector("foliate-view") as any;
      const c = view.renderer.getContents()[0];
      return !!c.overlayer && !!c.overlayer.element.querySelector(`g[fill="${color}"] rect`);
    },
    green
  );
  const groups = await overlayGroups(page);
  expect(groups).toHaveLength(1);
  expectRectsMatch(groups[0].rects[0], selRect);

  // A collapsed/empty selection must post nothing (negative wait).
  await page.evaluate(() => {
    const view = document.querySelector("foliate-view") as any;
    const doc = view.renderer.getContents()[0].doc;
    doc.getSelection().removeAllRanges();
    doc.dispatchEvent(new Event("pointerup"));
  });
  await page.waitForTimeout(400); // reporter fires at +10ms; generous margin
  const after = await page.evaluate(
    () => (window as any).__rn.filter((m: any) => m.type === "selection").length
  );
  expect(after).toBe(1); // still just the one real selection
});
