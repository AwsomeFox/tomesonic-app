// Shared Playwright harness for the reader suites: serves the baked reader
// HTML, shims the RN WebView bridge, and provides the event-driven bridge
// message helpers. Used by reader.pw.ts and reader-features.pw.ts.

import type { Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { HTML_PATH } from "./global-setup";

export type LocationMsg = {
  type: "location";
  cfi: string;
  fraction: number;
  section: number | { current: number; total: number };
  page: number;
  pages: number;
  tocItem: { label: string } | null;
};

/** Serve the baked reader HTML on an ephemeral local port. */
export async function startReaderServer(): Promise<{ server: http.Server; baseURL: string }> {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, baseURL };
}

export function stopReaderServer(server: http.Server): Promise<unknown> {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Shim the RN WebView bridge BEFORE any page script runs (captures every
 * postMessage into window.__rn), load the reader, and wait for 'ready' AND
 * the first 'location' relocation.
 */
export async function openReader(page: Page, baseURL: string): Promise<void> {
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

export function messagesOfType<T = any>(page: Page, type: string): Promise<T[]> {
  return page.evaluate((t) => (window as any).__rn.filter((m: any) => m.type === t), type);
}

export function locationMessages(page: Page): Promise<LocationMsg[]> {
  return messagesOfType<LocationMsg>(page, "location");
}

/**
 * Turn one page and wait — event-driven, no bare sleeps guarding asserts —
 * for the NEW `location` message the resulting relocate posts to the bridge.
 *
 * Retries the goNext: foliate SILENTLY DROPS a goRight() issued while its
 * page-turn animation is still in flight (verified: the relocate's location
 * message posts ~4ms after the turn starts, well before the animation lock
 * releases, and a goNext issued in that window never lands nor queues). The
 * app never hits this — TTS advance waits 400ms and user taps are spaced —
 * so it's harness timing, not a product bug. A dropped call is a pure no-op,
 * so re-calling until a new location message arrives cannot double-turn: we
 * stop the moment one relocate lands.
 */
export async function advanceOnePage(page: Page): Promise<LocationMsg> {
  const before = await page.evaluate(
    () => (window as any).__rn.filter((m: any) => m.type === "location").length
  );
  let landed = false;
  for (let attempt = 0; attempt < 8 && !landed; attempt++) {
    await page.evaluate(() => (window as any).goNext());
    landed = await page
      .waitForFunction(
        (prev) => (window as any).__rn.filter((m: any) => m.type === "location").length > prev,
        before,
        { timeout: 1_500 }
      )
      .then(
        () => true,
        () => false // dropped while animating — retry
      );
  }
  if (!landed) throw new Error("goNext never produced a new location message (8 attempts)");
  const locs = await locationMessages(page);
  return locs[locs.length - 1];
}

/** Paragraph markers ("c2p013") as sortable numbers: chapter*1000 + para. */
export function markerNumbers(text: string): number[] {
  return [...text.matchAll(/c(\d+)p(\d+)/g)].map((m) => Number(m[1]) * 1000 + Number(m[2]));
}
