package com.tomesonic.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import com.tomesonic.app.R

// Simple resume widget. onUpdate reads the current book from
// filesDir/widget_state.json and wires a tap to launch the app.
class ResumeWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) updateWidget(context, mgr, id)
    }

    private fun updateWidget(context: Context, mgr: AppWidgetManager, id: Int) {
        val views = RemoteViews(context.packageName, R.layout.resume_widget)
        var title = "TomeSonic"
        var subtitle = "Tap to resume listening"
        try {
            val f = File(context.filesDir, "widget_state.json")
            if (f.exists()) {
                val o = JSONObject(f.readText())
                val t = o.optString("title")
                if (t.isNotEmpty()) title = t
                val a = o.optString("author")
                if (a.isNotEmpty()) subtitle = a
            }
        } catch (e: Exception) {
            // Fall back to defaults.
        }
        views.setTextViewText(R.id.widget_title, title)
        views.setTextViewText(R.id.widget_subtitle, subtitle)

        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pi = PendingIntent.getActivity(context, 0, launch, flags)
            views.setOnClickPendingIntent(R.id.widget_root, pi)
        }
        mgr.updateAppWidget(id, views)
    }
}
