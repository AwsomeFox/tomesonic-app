/**
 * Drift guard for the withWidgetRefresh config plugin. It generates the native
 * WidgetRefresh module + package (which push an immediate widget redraw) and
 * registers the package in MainApplication on prebuild. Pins the load-bearing
 * lines in the plugin and the committed native files so a prebuild can't
 * silently revert them.
 */
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const PLUGIN = join(ROOT, "plugins", "withWidgetRefresh.js");
const KJAVA = "android/app/src/main/java/com/tomesonic/app/widget";
const MODULE = join(ROOT, KJAVA, "WidgetRefreshModule.kt");
const PACKAGE = join(ROOT, KJAVA, "WidgetRefreshPackage.kt");
const MAIN_APP = join(ROOT, "android/app/src/main/java/com/tomesonic/app/MainApplication.kt");

const read = (p: string) => readFileSync(p, "utf8");

describe("withWidgetRefresh plugin ↔ committed native module stay in sync", () => {
  const plugin = read(PLUGIN);

  it("the module exposes a 'WidgetRefresh' native module with a refresh() method", () => {
    for (const src of [plugin, read(MODULE)]) {
      expect(src).toContain(`class WidgetRefreshModule`);
      expect(src).toContain(`override fun getName(): String = "WidgetRefresh"`);
      expect(src).toContain(`fun refresh()`);
      // Broadcasts an APPWIDGET_UPDATE to each provider so it re-reads the file.
      expect(src).toContain(`AppWidgetManager.ACTION_APPWIDGET_UPDATE`);
      expect(src).toContain(`notifyAppWidgetViewDataChanged`);
    }
  });

  it("the ReactPackage exposes the module", () => {
    for (const src of [plugin, read(PACKAGE)]) {
      expect(src).toContain(`class WidgetRefreshPackage : ReactPackage`);
      expect(src).toContain(`WidgetRefreshModule(reactContext)`);
    }
  });

  it("the committed MainApplication registers the package (and the plugin injects it)", () => {
    expect(read(MAIN_APP)).toContain(`add(com.tomesonic.app.widget.WidgetRefreshPackage())`);
    // The plugin's MainApplication mutator inserts the same registration.
    expect(plugin).toContain(`WidgetRefreshPackage()`);
    expect(plugin).toContain(`withMainApplication`);
  });

  it("app.json registers the plugin", () => {
    const appJson = read(join(ROOT, "app.json"));
    expect(appJson).toContain(`./plugins/withWidgetRefresh`);
  });
});
