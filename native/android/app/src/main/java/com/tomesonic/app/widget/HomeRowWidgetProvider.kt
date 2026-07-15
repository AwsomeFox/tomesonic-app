package com.tomesonic.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import com.tomesonic.app.R

// Home-row home-screen widget: shows one personalized home shelf (chosen in the
// widget's config screen) as a scrollable list. Each item opens that book in the
// app WITHOUT auto-playing. Row data is written by JS to
// filesDir/home_rows_state.json; the chosen row id per widget is stored in
// SharedPreferences under HomeRowWidgetPrefs. Like the other widgets it refreshes
// on Android's periodic tick / re-add (live refresh is a follow-up).
class HomeRowWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) updateWidget(context, mgr, id)
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        val e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        for (id in ids) e.remove(KEY_PREFIX + id)
        e.apply()
    }

    private fun updateWidget(context: Context, mgr: AppWidgetManager, id: Int) {
        val views = RemoteViews(context.packageName, R.layout.home_row_widget)

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val chosen = prefs.getString(KEY_PREFIX + id, "") ?: ""
        views.setTextViewText(R.id.homerow_header, headerLabel(context, chosen))

        // Bind the list to HomeRowWidgetService, tagging the intent uniquely per
        // widget + row so each widget gets its own factory (not a shared/stale one).
        val svc = Intent(context, HomeRowWidgetService::class.java)
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
        svc.putExtra(EXTRA_ROW_ID, chosen)
        svc.data = Uri.parse("homerow://widget/" + id + "/" + chosen)
        views.setRemoteAdapter(R.id.homerow_list, svc)
        views.setEmptyView(R.id.homerow_list, R.id.homerow_empty)

        // Item-tap template: each item fills in a tomesonic://item/<id> data URI
        // so tapping opens that book (no auto-play). The JS launch bridge routes
        // it. FLAG_MUTABLE lets the per-item fill-in data merge into the template.
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            launch.action = Intent.ACTION_VIEW
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            val pi = PendingIntent.getActivity(context, id, launch, flags)
            views.setPendingIntentTemplate(R.id.homerow_list, pi)
        }

        mgr.updateAppWidget(id, views)
        mgr.notifyAppWidgetViewDataChanged(id, R.id.homerow_list)
    }

    private fun headerLabel(context: Context, rowId: String): String {
        try {
            var f = File(context.filesDir, "home_rows_state.json")
            if (!f.exists()) f = File(context.filesDir, "home_rows_state.json.tmp")
            if (f.exists()) {
                val rows = JSONObject(f.readText()).optJSONArray("rows")
                if (rows != null) {
                    for (i in 0 until rows.length()) {
                        val r = rows.optJSONObject(i) ?: continue
                        if (rowId.isEmpty() || r.optString("id") == rowId) {
                            val l = r.optString("label")
                            if (l.isNotEmpty()) return l
                        }
                    }
                }
            }
        } catch (e: Exception) {
        }
        return "TomeSonic"
    }

    companion object {
        const val PREFS = "HomeRowWidgetPrefs"
        const val KEY_PREFIX = "row_"
        const val EXTRA_ROW_ID = "rowId"
    }
}
