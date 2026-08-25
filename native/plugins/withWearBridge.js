const {
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Adds the PHONE side of the Wear OS bridge: a tiny native module (WearBridge)
// that mirrors the ABS credentials onto the paired watch over the Wearable Data
// Layer, so the watch app (native/wear/, same applicationId, no login of its
// own) can talk to the server. Everything this plugin does lives under
// android/, which `expo prebuild --clean` wipes and regenerates — the sources,
// the MainApplication registration and the play-services-wearable dependency
// are therefore committed AND re-injected here, so either path produces the
// same tree. Protocol contract: native/wear/ARCHITECTURE.md.
const PACKAGE = "com.tomesonic.app";

const MODULE_KT = `package ${PACKAGE}.wear

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable

// Mirrors the ABS credentials onto the paired Wear OS watch over the Wearable
// Data Layer. The watch app is a separate, pure-native APK (native/wear/) with
// the SAME applicationId, so the Data Layer pairs the two; it has no login of
// its own in v1 and gets everything from this one DataItem.
//
// Protocol (binding contract — native/wear/ARCHITECTURE.md):
// path /tomesonic/creds, keys server/token/userId/username/ts, setUrgent().
// The ACCESS token only — the refresh token never leaves the phone. Logout is a
// put of empty strings, NOT deleteDataItems (deletion events are less reliable
// across reconnects, so a stale-but-present item is the safer clear signal).
//
// Everything is best-effort: no Google Play services, no paired watch, or a
// Data Layer that rejects the put must never crash or reject into JS — the
// phone app works exactly the same without a watch. Failures resolve(false).
class WearBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "WearBridge"

    private fun put(
        server: String,
        token: String,
        userId: String,
        username: String,
        promise: Promise
    ) {
        try {
            val req = PutDataMapRequest.create(PATH)
            req.dataMap.putString(KEY_SERVER, server)
            req.dataMap.putString(KEY_TOKEN, token)
            req.dataMap.putString(KEY_USER_ID, userId)
            req.dataMap.putString(KEY_USERNAME, username)
            // Phone wall-clock millis. Identical DataItem content is a no-op for
            // the Data Layer, so re-putting the same creds (a token refresh that
            // returned the same token, a re-login) would never reach the watch
            // without this making every put distinct.
            req.dataMap.putLong(KEY_TS, System.currentTimeMillis())
            // setUrgent: creds gate EVERYTHING on the watch, so don't let the
            // Data Layer batch this into its lazy (up to ~30min) sync window.
            val request = req.asPutDataRequest().setUrgent()
            Wearable.getDataClient(reactApplicationContext.applicationContext)
                .putDataItem(request)
                // Fire-and-report: resolve off the listeners so JS never waits
                // on the (possibly disconnected) watch.
                .addOnSuccessListener { promise.resolve(true) }
                .addOnFailureListener { promise.resolve(false) }
        } catch (e: Throwable) {
            // Play services missing/too old, security exception, anything —
            // best-effort, never throw into JS.
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun putCreds(
        server: String,
        token: String,
        userId: String,
        username: String,
        promise: Promise
    ) {
        put(server, token, userId, username, promise)
    }

    // Logout: same path, empty strings (see the class comment — deliberately not
    // deleteDataItems). The watch reads empty server/token as "not configured".
    @ReactMethod
    fun clearCreds(promise: Promise) {
        put("", "", "", "", promise)
    }

    companion object {
        private const val PATH = "/tomesonic/creds"
        private const val KEY_SERVER = "server"
        private const val KEY_TOKEN = "token"
        private const val KEY_USER_ID = "userId"
        private const val KEY_USERNAME = "username"
        private const val KEY_TS = "ts"
    }
}
`;

const PACKAGE_KT = `package ${PACKAGE}.wear

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class WearBridgePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(WearBridgeModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`;

const REGISTER_LINE = `          add(${PACKAGE}.wear.WearBridgePackage())`;

const GRADLE_DEP = `    // Wearable Data Layer — WearBridgeModule mirrors creds to the watch app.
    implementation "com.google.android.gms:play-services-wearable:19.0.0"
`;

function writeFileSafe(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function withWearBridgeFiles(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const pkgDir = PACKAGE.replace(/\./g, "/");
      const j = (...p) => path.join(root, ...p);
      writeFileSafe(j("app/src/main/java", pkgDir, "wear/WearBridgeModule.kt"), MODULE_KT);
      writeFileSafe(j("app/src/main/java", pkgDir, "wear/WearBridgePackage.kt"), PACKAGE_KT);
      return cfg;
    },
  ]);
}

// Registers WearBridgePackage in MainApplication's manual package list. New
// Architecture is enabled, but a legacy ReactPackage still registers here and is
// bridged by the interop layer.
function withWearBridgeRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes("WearBridgePackage()")) return cfg; // idempotent
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

// The Data Layer client (Wearable/PutDataMapRequest/DataClient) lives in
// play-services-wearable; nothing else in the app pulls it in, so a regenerated
// build.gradle without this line fails WearBridgeModule's compile.
function withWearBridgeDependency(config) {
  return withAppBuildGradle(config, (cfg) => {
    let s = cfg.modResults.contents;
    // Already applied (idempotent — also true for the committed android/ tree).
    if (s.includes("play-services-wearable")) return cfg;

    s = s.replace(/dependencies\s*\{\n/, (m) => m + GRADLE_DEP);

    if (!s.includes("play-services-wearable")) {
      throw new Error(
        "withWearBridge: failed to inject play-services-wearable into app/build.gradle — template shape changed?"
      );
    }

    cfg.modResults.contents = s;
    return cfg;
  });
}

module.exports = (config) =>
  withWearBridgeDependency(withWearBridgeRegistration(withWearBridgeFiles(config)));
