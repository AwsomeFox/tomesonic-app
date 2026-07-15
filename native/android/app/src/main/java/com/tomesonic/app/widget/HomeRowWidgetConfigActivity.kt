package com.tomesonic.app.widget

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import org.json.JSONObject
import java.io.File

// Widget configuration screen, shown when the home-row widget is added. Lists the
// available home rows (from filesDir/home_rows_state.json) and stores the chosen
// row id per widget id in SharedPreferences, then completes the placement.
class HomeRowWidgetConfigActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Default result: if the user backs out, the placement is cancelled.
        setResult(Activity.RESULT_CANCELED)

        val appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }

        val ids = ArrayList<String>()
        val labels = ArrayList<String>()
        try {
            var f = File(filesDir, "home_rows_state.json")
            if (!f.exists()) f = File(filesDir, "home_rows_state.json.tmp")
            if (f.exists()) {
                val rows = JSONObject(f.readText()).optJSONArray("rows")
                if (rows != null) {
                    for (i in 0 until rows.length()) {
                        val r = rows.optJSONObject(i) ?: continue
                        val l = r.optString("label")
                        if (l.isNotEmpty()) {
                            ids.add(r.optString("id"))
                            labels.add(l)
                        }
                    }
                }
            }
        } catch (e: Exception) {
        }

        // No rows yet (signed out / home not loaded): still let the widget be
        // placed — it renders the first available row once data arrives.
        if (labels.isEmpty()) {
            save(appWidgetId, "")
            complete(appWidgetId)
            return
        }

        AlertDialog.Builder(this)
            .setTitle("Show which row?")
            .setItems(labels.toTypedArray()) { _, which ->
                save(appWidgetId, ids[which])
                complete(appWidgetId)
            }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun save(appWidgetId: Int, rowId: String) {
        getSharedPreferences(HomeRowWidgetProvider.PREFS, Context.MODE_PRIVATE)
            .edit().putString(HomeRowWidgetProvider.KEY_PREFIX + appWidgetId, rowId).apply()
    }

    private fun complete(appWidgetId: Int) {
        val mgr = AppWidgetManager.getInstance(this)
        HomeRowWidgetProvider().onUpdate(this, mgr, intArrayOf(appWidgetId))
        val result = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        setResult(Activity.RESULT_OK, result)
        finish()
    }
}
