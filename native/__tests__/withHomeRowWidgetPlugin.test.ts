/**
 * Drift guard for the home-row widget. The withHomeRowWidget config plugin
 * regenerates the widget's native files (provider + service + factory + config
 * activity + layouts + manifest components) on every prebuild from inline
 * templates. If those templates drift from the committed android/ files, the
 * next prebuild silently reverts hand edits — so this pins the load-bearing
 * lines in BOTH the plugin and the committed files.
 *
 * (Lives at the __tests__ root, not __tests__/plugins, because jest.config.js
 * ignores any test path containing "/plugins/".)
 */
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const PLUGIN = join(ROOT, "plugins", "withHomeRowWidget.js");
const KJAVA = "android/app/src/main/java/com/tomesonic/app/widget";
const PROVIDER = join(ROOT, KJAVA, "HomeRowWidgetProvider.kt");
const SERVICE = join(ROOT, KJAVA, "HomeRowWidgetService.kt");
const FACTORY = join(ROOT, KJAVA, "HomeRowRemoteViewsFactory.kt");
const CONFIG = join(ROOT, KJAVA, "HomeRowWidgetConfigActivity.kt");
const LAYOUT = join(ROOT, "android/app/src/main/res/layout/home_row_widget.xml");
const ITEM_LAYOUT = join(ROOT, "android/app/src/main/res/layout/home_row_widget_item.xml");
const MANIFEST = join(ROOT, "android/app/src/main/AndroidManifest.xml");

const norm = (s: string) => s.replace(/\s+/g, " ");
const read = (p: string) => norm(readFileSync(p, "utf8"));

const READS_STATE_FILE = `File(context.filesDir, "home_rows_state.json")`;
const TMP_FALLBACK = `home_rows_state.json.tmp"`;

describe("withHomeRowWidget plugin ↔ committed provider stay in sync", () => {
  const plugin = read(PLUGIN);
  const provider = read(PROVIDER);

  it("both read home_rows_state.json with the .tmp mid-swap fallback", () => {
    for (const src of [plugin, provider]) {
      expect(src).toContain(READS_STATE_FILE);
      expect(src).toContain(TMP_FALLBACK);
    }
  });

  it("both bind the list to the RemoteViewsService and set an item-tap template", () => {
    for (const src of [plugin, provider]) {
      expect(src).toContain(`setRemoteAdapter(R.id.homerow_list`);
      expect(src).toContain(`setEmptyView(R.id.homerow_list, R.id.homerow_empty)`);
      expect(src).toContain(`setPendingIntentTemplate(R.id.homerow_list`);
      // Fill-in data merges into the template → the template must be MUTABLE.
      expect(src).toContain(`PendingIntent.FLAG_MUTABLE`);
    }
  });

  it("both persist the chosen row per widget id in SharedPreferences", () => {
    for (const src of [plugin, provider]) {
      expect(src).toContain(`HomeRowWidgetPrefs`);
      expect(src).toContain(`EXTRA_ROW_ID`);
    }
  });
});

describe("withHomeRowWidget plugin ↔ committed service/factory stay in sync", () => {
  const plugin = read(PLUGIN);
  const service = read(SERVICE);
  const factory = read(FACTORY);

  it("the service returns the home-row factory", () => {
    for (const src of [plugin, service]) {
      expect(src).toContain(`RemoteViewsService()`);
      expect(src).toContain(`HomeRowRemoteViewsFactory(applicationContext, intent)`);
    }
  });

  it("the factory renders items and sets a tomesonic://item/<id> fill-in intent", () => {
    for (const src of [plugin, factory]) {
      expect(src).toContain(READS_STATE_FILE);
      expect(src).toContain(`setOnClickFillInIntent(R.id.homerow_item_root`);
      expect(src).toContain(`Uri.parse("tomesonic://item/" + id)`);
      // Cover is fetched + downsampled on the binder thread.
      expect(src).toContain(`inSampleSize`);
    }
  });
});

describe("withHomeRowWidget plugin ↔ committed config activity stay in sync", () => {
  const plugin = read(PLUGIN);
  const config = read(CONFIG);

  it("the config activity picks a row and saves it against the widget id", () => {
    for (const src of [plugin, config]) {
      expect(src).toContain(`AlertDialog.Builder`);
      expect(src).toContain(`EXTRA_APPWIDGET_ID`);
      expect(src).toContain(`RESULT_OK`);
      // Backing out (no selection) leaves the placement cancelled.
      expect(src).toContain(`RESULT_CANCELED`);
    }
  });
});

describe("committed home-row layouts have every view the providers reference", () => {
  const provider = read(PROVIDER);
  const factory = read(FACTORY);
  const layout = read(LAYOUT);
  const item = read(ITEM_LAYOUT);

  it("the row layout has header/list/empty views", () => {
    for (const id of ["homerow_header", "homerow_list", "homerow_empty"]) {
      expect(layout).toContain(`@+id/${id}`);
      expect(provider).toContain(`R.id.${id}`);
    }
  });

  it("the item layout has root/cover/title/author views", () => {
    for (const id of ["homerow_item_root", "homerow_item_cover", "homerow_item_title", "homerow_item_author"]) {
      expect(item).toContain(`@+id/${id}`);
      expect(factory).toContain(`R.id.${id}`);
    }
  });
});

describe("committed manifest + plugin register all three home-row components", () => {
  const plugin = read(PLUGIN);
  const manifest = read(MANIFEST);

  it("registers the widget receiver", () => {
    expect(manifest).toContain(`com.tomesonic.app.widget.HomeRowWidgetProvider`);
    expect(manifest).toContain(`@xml/home_row_widget_info`);
    expect(plugin).toContain(`HomeRowWidgetProvider`);
    expect(plugin).toContain(`@xml/home_row_widget_info`);
  });

  it("registers the RemoteViewsService requiring BIND_REMOTEVIEWS", () => {
    expect(manifest).toContain(`com.tomesonic.app.widget.HomeRowWidgetService`);
    expect(manifest).toContain(`android.permission.BIND_REMOTEVIEWS`);
    expect(plugin).toContain(`HomeRowWidgetService`);
    expect(plugin).toContain(`android.permission.BIND_REMOTEVIEWS`);
  });

  it("registers the config activity with the APPWIDGET_CONFIGURE filter", () => {
    expect(manifest).toContain(`com.tomesonic.app.widget.HomeRowWidgetConfigActivity`);
    expect(manifest).toContain(`android.appwidget.action.APPWIDGET_CONFIGURE`);
    expect(plugin).toContain(`HomeRowWidgetConfigActivity`);
    expect(plugin).toContain(`android.appwidget.action.APPWIDGET_CONFIGURE`);
  });

  it("the widget-info xml wires the config activity", () => {
    const info = read(join(ROOT, "android/app/src/main/res/xml/home_row_widget_info.xml"));
    expect(info).toContain(`android:configure="com.tomesonic.app.widget.HomeRowWidgetConfigActivity"`);
  });

  it("the picker shows a real preview and covers are rounded to match the app", () => {
    const info = read(join(ROOT, "android/app/src/main/res/xml/home_row_widget_info.xml"));
    const pluginSrc = read(PLUGIN);
    // Assert in BOTH the plugin template (source of truth on prebuild) and the
    // committed resources, so a template regression is caught without prebuild.
    expect(info).toContain(`android:previewLayout="@layout/home_row_widget"`);
    expect(pluginSrc).toContain(`android:previewLayout="@layout/home_row_widget"`);
    // Rounded item covers (API 31+) — in both the plugin template and the factory.
    // Rounding only clips when clipToOutline is enabled — pin that too.
    expect(pluginSrc).toContain(`setViewOutlinePreferredRadius(R.id.homerow_item_cover`);
    expect(read(FACTORY)).toContain(`setViewOutlinePreferredRadius(R.id.homerow_item_cover`);
    expect(pluginSrc).toContain(`setBoolean(R.id.homerow_item_cover, "setClipToOutline", true)`);
    expect(read(FACTORY)).toContain(`setBoolean(R.id.homerow_item_cover, "setClipToOutline", true)`);
    // App player-card teal background — plugin template + committed drawable.
    expect(pluginSrc).toContain(`#334C44`);
    expect(read(join(ROOT, "android/app/src/main/res/drawable/home_row_widget_bg.xml"))).toContain(`#334C44`);
  });
});
