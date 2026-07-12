// Playwright config for the ebook-reader DOM-behavior suite.
//
// Test files are named *.pw.ts (NOT *.test.ts / *.spec.ts) so the Jest
// preset's default testMatch never picks them up — `npm test` and
// `npm run test:reader` stay fully independent.

import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.pw\.ts$/,
  globalSetup: "./global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // One worker: every test navigates the same baked reader page and the
  // suite is small; parallel Chromium instances just add flake surface.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  outputDir: path.join(__dirname, ".artifacts", "test-results"),
  use: {
    browserName: "chromium",
    // A CI failure artifact without a trace is near-useless for a WebView
    // behavior suite — keep the trace when a CI run fails.
    trace: process.env.CI ? "retain-on-failure" : "off",
    // ~600px width paginates each fixture chapter into several pages, which
    // the TTS page-bounding test depends on.
    viewport: { width: 600, height: 800 },
    // The injected page-curl code binds touch handlers; emulate a touch
    // device like the Android WebView the reader really runs in.
    hasTouch: true,
  },
});
