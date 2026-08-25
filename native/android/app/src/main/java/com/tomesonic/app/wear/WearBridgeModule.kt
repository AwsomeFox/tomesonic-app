package com.tomesonic.app.wear

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
