package com.tomesonic.app.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.tomesonic.app.R

// Pushes an immediate redraw of the home-screen widgets instead of waiting for
// Android's ~30-min tick. Split into two paths: the player widgets (which just
// re-read the local widget_state.json) can refresh on the ~2s playback cadence,
// while the home-row widget — whose list factory does NETWORK cover fetches — is
// refreshed separately, only when its data (home_rows_state.json) changes, so a
// live playback refresh never triggers repeated home-row list I/O.
class WidgetRefreshModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "WidgetRefresh"

    private fun broadcast(cls: Class<*>) {
        val ctx = reactApplicationContext.applicationContext
        val mgr = AppWidgetManager.getInstance(ctx) ?: return
        val ids = mgr.getAppWidgetIds(ComponentName(ctx, cls))
        if (ids.isEmpty()) return
        val intent = Intent(ctx, cls)
        intent.action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
        ctx.sendBroadcast(intent)
    }

    // Player widgets only — safe on the ~2s live cadence (local file re-read).
    @ReactMethod
    fun refreshPlayers() {
        try {
            broadcast(MiniPlayerWidgetProvider::class.java)
            broadcast(FullPlayerWidgetProvider::class.java)
            broadcast(ResumeWidgetProvider::class.java)
        } catch (e: Exception) {
            // Best-effort — never throw into JS.
        }
    }

    // Home-row widget only — call when home_rows_state.json changes. Its list
    // factory fetches covers over the network, so this must NOT run on the live
    // playback cadence.
    @ReactMethod
    fun refreshHomeRows() {
        try {
            val ctx = reactApplicationContext.applicationContext
            val mgr = AppWidgetManager.getInstance(ctx) ?: return
            broadcast(HomeRowWidgetProvider::class.java)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, HomeRowWidgetProvider::class.java))
            if (ids.isNotEmpty()) {
                mgr.notifyAppWidgetViewDataChanged(ids, R.id.homerow_list)
            }
        } catch (e: Exception) {
            // Best-effort — never throw into JS.
        }
    }
}
