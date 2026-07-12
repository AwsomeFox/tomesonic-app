// Loads the REAL `ebookHtml(...)` / `buildLiveReaderCSS(...)` out of
// screens/ReaderScreen.tsx into this Node (Playwright) process.
//
// ReaderScreen.tsx imports react-native / expo modules at the top, which do
// not load under plain Node — but ebookHtml itself is a pure module-level
// function whose only real dependency is the vendored FOLIATE_BUNDLE string.
// So we esbuild-bundle the screen to CJS with EVERY import stubbed except
// ../utils/foliateBundle: evaluating the bundle then only defines module
// constants and functions (the React component is exported but never run).

import { build } from "esbuild";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(__filename);

export type EbookHtmlFn = (
  base64: string,
  bg: string,
  fg: string,
  accent: string,
  startCfi: string,
  mimeHint: string,
  fontSize: number,
  fontFamily: string,
  lineHeight: number,
  pageCurl: boolean,
  margin: number,
  flow: string
) => string;

export type BuildLiveReaderCSSFn = (
  fontSize: number,
  fontFamily: string,
  lineHeight: number,
  bg: string,
  fg: string
) => string;

export interface ReaderModule {
  ebookHtml: EbookHtmlFn;
  buildLiveReaderCSS: BuildLiveReaderCSSFn;
}

// Deep no-op proxy handed out for every stubbed module: any property access,
// call, or construction yields another stub, so module-level defensive code
// like `require("react-native-pdf").default` evaluates harmlessly.
//
// COERCION TRIPWIRE: if a stub ever gets string/number-coerced — i.e. a
// stubbed value leaked into the generated reader HTML, where it would
// silently interpolate as "" and keep the suite green — it records the event
// on globalThis.__stubCoercions with a stack, and global-setup asserts that
// list is EMPTY after ebookHtml() returns.
const STUB_SOURCE = `
function recordCoercion(kind) {
  const g = globalThis;
  if (!g.__stubCoercions) g.__stubCoercions = [];
  g.__stubCoercions.push({ kind, stack: new Error("stub coerced via " + kind).stack });
  return "";
}
function makeStub() {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, p) {
      if (p === "__esModule") return true;
      if (p === Symbol.toPrimitive) return () => recordCoercion("Symbol.toPrimitive");
      if (p === "toString") return () => recordCoercion("toString");
      if (p === "valueOf") return () => recordCoercion("valueOf");
      if (p === "then") return undefined; // never thenable
      return makeStub();
    },
    apply() { return makeStub(); },
    construct() { return makeStub(); },
  });
}
module.exports = makeStub();
`;

export const ARTIFACTS_DIR = path.join(__dirname, ".artifacts");

export async function loadReaderModule(): Promise<ReaderModule> {
  const entry = path.join(__dirname, "..", "screens", "ReaderScreen.tsx");
  const outfile = path.join(ARTIFACTS_DIR, "reader-screen.cjs");
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    logLevel: "silent",
    plugins: [
      {
        name: "stub-everything-but-foliate",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return null;
            // The vendored foliate bundle is the ONE real dependency the
            // generated reader HTML embeds — let esbuild resolve it normally.
            if (/foliateBundle/.test(args.path)) return null;
            return { path: args.path, namespace: "rn-stub" };
          });
          build.onLoad({ filter: /.*/, namespace: "rn-stub" }, () => ({
            contents: STUB_SOURCE,
            loader: "js",
          }));
        },
      },
    ],
  });

  // Bust require cache so repeated global-setups in one process stay fresh.
  delete require.cache[outfile];
  const mod = require(outfile);
  if (typeof mod.ebookHtml !== "function" || typeof mod.buildLiveReaderCSS !== "function") {
    throw new Error(
      "ReaderScreen.tsx did not export ebookHtml/buildLiveReaderCSS — did the export change get reverted?"
    );
  }
  return { ebookHtml: mod.ebookHtml, buildLiveReaderCSS: mod.buildLiveReaderCSS };
}

/**
 * The exact vendored FOLIATE_BUNDLE string that ebookHtml embeds — used by
 * the global-setup sentinel scan to exclude the (minified, legitimately
 * "undefined"-containing) bundle from the forbidden-token check on the baked
 * HTML. utils/foliateBundle.ts is dependency-free, so no stubbing is needed.
 */
export async function loadFoliateBundle(): Promise<string> {
  const entry = path.join(__dirname, "..", "utils", "foliateBundle.ts");
  const outfile = path.join(ARTIFACTS_DIR, "foliate-bundle.cjs");
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });
  delete require.cache[outfile];
  const mod = require(outfile);
  if (typeof mod.FOLIATE_BUNDLE !== "string" || mod.FOLIATE_BUNDLE.length < 10_000) {
    throw new Error("utils/foliateBundle.ts did not yield the FOLIATE_BUNDLE string");
  }
  return mod.FOLIATE_BUNDLE;
}
