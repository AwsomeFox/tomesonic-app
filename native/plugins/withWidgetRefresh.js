const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Adds a tiny native module (WidgetRefresh) that lets JS push an IMMEDIATE
// redraw of the home-screen widgets — the mini/full player widgets' progress bar
// and play/pause glyph then update in near-real-time while the app runs, instead
// of only on Android's ~30-minute widget tick. JS (usePlaybackStore) writes the
// fresh widget_state.json and calls WidgetRefresh.refresh(), which broadcasts
// APPWIDGET_UPDATE to each widget provider (and pokes the home-row list). It is
// deliberately isolated from the media/track-player service.
const PACKAGE = "com.tomesonic.app";

const MODULE_KT = `package ${PACKAGE}.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import ${PACKAGE}.R

// Pushes an immediate redraw of the home-screen widgets (near-real-time progress
// + play/pause) instead of waiting for Android's ~30-min widget tick. JS writes
// the fresh widget_state.json, then calls refresh(); this re-runs each provider's
// onUpdate (which re-reads the file) and refreshes the home-row list's data.
class WidgetRefreshModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "WidgetRefresh"

    @ReactMethod
    fun refresh() {
        try {
            val ctx = reactApplicationContext.applicationContext
            val mgr = AppWidgetManager.getInstance(ctx) ?: return
            val providers = listOf(
                MiniPlayerWidgetProvider::class.java,
                FullPlayerWidgetProvider::class.java,
                ResumeWidgetProvider::class.java,
                HomeRowWidgetProvider::class.java
            )
            for (cls in providers) {
                val ids = mgr.getAppWidgetIds(ComponentName(ctx, cls))
                if (ids.isEmpty()) continue
                val intent = Intent(ctx, cls)
                intent.action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
                intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
                ctx.sendBroadcast(intent)
            }
            // The home-row list is served by a RemoteViewsService — poke its data.
            val homeIds = mgr.getAppWidgetIds(ComponentName(ctx, HomeRowWidgetProvider::class.java))
            if (homeIds.isNotEmpty()) {
                mgr.notifyAppWidgetViewDataChanged(homeIds, R.id.homerow_list)
            }
        } catch (e: Exception) {
            // Best-effort — never throw into JS.
        }
    }
}
`;

const PACKAGE_KT = `package ${PACKAGE}.widget

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class WidgetRefreshPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(WidgetRefreshModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`;

const REGISTER_LINE = `          add(${PACKAGE}.widget.WidgetRefreshPackage())`;

function writeFileSafe(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function withWidgetRefreshFiles(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const pkgDir = PACKAGE.replace(/\./g, "/");
      const j = (...p) => path.join(root, ...p);
      writeFileSafe(j("app/src/main/java", pkgDir, "widget/WidgetRefreshModule.kt"), MODULE_KT);
      writeFileSafe(j("app/src/main/java", pkgDir, "widget/WidgetRefreshPackage.kt"), PACKAGE_KT);
      return cfg;
    },
  ]);
}

// Registers WidgetRefreshPackage in MainApplication's manual package list. New
// Architecture is enabled, but a legacy ReactPackage still registers here and is
// bridged by the interop layer.
function withWidgetRefreshRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes("WidgetRefreshPackage()")) return cfg; // idempotent
    const marker = "// add(MyReactNativePackage())";
    if (src.includes(marker)) {
      src = src.replace(marker, `${marker}\n${REGISTER_LINE}`);
    } else {
      // Fallback: inject just inside the packages.apply { ... } block.
      src = src.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{)/,
        `$1\n${REGISTER_LINE}`
      );
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

// Touch the manifest mod chain too (no-op) so the plugin composes uniformly.
function withNoopManifest(config) {
  return withAndroidManifest(config, (cfg) => cfg);
}

module.exports = (config) =>
  withNoopManifest(withWidgetRefreshRegistration(withWidgetRefreshFiles(config)));
