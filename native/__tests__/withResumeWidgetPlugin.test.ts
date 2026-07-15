/**
 * REGRESSION: the withResumeWidget config plugin regenerates
 * ResumeWidgetProvider.kt on every prebuild from an inline template. If that
 * template drifts from the committed native file, the next prebuild silently
 * reverts hand-fixes to the provider.
 *
 * The specific fix guarded here: writeWidgetState() persists via an atomic
 * delete-then-rename (widget_state.json.tmp -> widget_state.json), leaving a
 * sub-tick window where the main file doesn't exist. The provider must fall
 * back to the .tmp file so a widget onUpdate landing in that gap doesn't render
 * generic defaults. Both the committed .kt AND the plugin template must carry
 * that fallback, or a prebuild reintroduces the bug.
 *
 * (Lives at the __tests__ root, not __tests__/plugins, because jest.config.js
 * ignores any test path containing "/plugins/".)
 */
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const PLUGIN = join(ROOT, "plugins", "withResumeWidget.js");
const PROVIDER = join(
  ROOT,
  "android/app/src/main/java/com/tomesonic/app/widget/ResumeWidgetProvider.kt"
);

// The exact fallback line both files must contain (whitespace-normalized).
const FALLBACK = `if (!f.exists()) f = File(context.filesDir, "widget_state.json.tmp")`;

const norm = (s: string) => s.replace(/\s+/g, " ");

describe("withResumeWidget plugin ↔ committed provider stay in sync", () => {
  it("the committed ResumeWidgetProvider.kt reads widget_state.json.tmp as a fallback", () => {
    expect(norm(readFileSync(PROVIDER, "utf8"))).toContain(FALLBACK);
  });

  it("the plugin's regenerated template ALSO carries the .tmp fallback (so a prebuild can't revert it)", () => {
    expect(norm(readFileSync(PLUGIN, "utf8"))).toContain(FALLBACK);
  });
});
