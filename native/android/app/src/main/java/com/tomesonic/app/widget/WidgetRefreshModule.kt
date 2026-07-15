package com.tomesonic.app.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.tomesonic.app.R

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
