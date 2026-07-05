#!/usr/bin/env node
/**
 * Sets the app version across every file that carries it:
 *   - native/android/app/build.gradle  (versionName + versionCode)
 *   - native/app.json                  (expo.version)
 *   - native/package.json              (version)
 *
 * Usage:
 *   node scripts/set-version.mjs <version> [versionCode]
 *
 *   version      e.g. 1.0.1 (or 1.0.1-beta.2)
 *   versionCode  optional integer. Defaults to current build.gradle value + 1.
 *                MUST exceed the highest code ever uploaded to Play — pass it
 *                explicitly for the first release after a store migration.
 *
 * Prints the resolved values and, when running in GitHub Actions, writes
 * versionName/versionCode to $GITHUB_OUTPUT.
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nativeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
const codeArg = process.argv[3];

if (!version || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Usage: set-version.mjs <version> [versionCode]\nGot version: ${JSON.stringify(version)}`);
  process.exit(1);
}
if (codeArg !== undefined && !/^\d+$/.test(codeArg)) {
  console.error(`versionCode must be an integer, got: ${JSON.stringify(codeArg)}`);
  process.exit(1);
}

// --- build.gradle: versionCode + versionName --------------------------------
const gradlePath = resolve(nativeRoot, "android/app/build.gradle");
let gradle = readFileSync(gradlePath, "utf8");

const codeMatch = gradle.match(/versionCode (\d+)/);
if (!codeMatch) {
  console.error("versionCode not found in android/app/build.gradle");
  process.exit(1);
}
const currentCode = parseInt(codeMatch[1], 10);
const versionCode = codeArg !== undefined ? parseInt(codeArg, 10) : currentCode + 1;
if (versionCode <= 0) {
  console.error(`Resolved versionCode ${versionCode} is not positive`);
  process.exit(1);
}
if (codeArg !== undefined && versionCode < currentCode) {
  console.error(
    `Refusing to DECREASE versionCode (${currentCode} -> ${versionCode}) — Play requires it to be monotonically increasing.`
  );
  process.exit(1);
}

gradle = gradle
  .replace(/versionCode \d+/, `versionCode ${versionCode}`)
  .replace(/versionName "[^"]*"/, `versionName "${version}"`);
writeFileSync(gradlePath, gradle);

// --- app.json: expo.version --------------------------------------------------
const appJsonPath = resolve(nativeRoot, "app.json");
const appJson = JSON.parse(readFileSync(appJsonPath, "utf8"));
appJson.expo.version = version;
writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + "\n");

// --- package.json: version ---------------------------------------------------
const pkgPath = resolve(nativeRoot, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`versionName ${version}`);
console.log(`versionCode ${versionCode} (was ${currentCode})`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `versionName=${version}\nversionCode=${versionCode}\n`
  );
}
