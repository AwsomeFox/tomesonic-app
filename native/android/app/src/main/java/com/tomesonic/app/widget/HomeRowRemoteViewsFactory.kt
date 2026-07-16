package com.tomesonic.app.widget

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.TypedValue
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import com.tomesonic.app.R

// Backs the home-row widget's list. Reads filesDir/home_rows_state.json, picks
// the row whose id matches the widget's configured selection (or the first row),
// and renders each item as cover + title + author. Covers are fetched from the
// item's cover URL (token embedded) on this binder thread and downsampled;
// failures fall back to the launcher icon. Item taps set a tomesonic://item/<id>
// fill-in intent that the JS launch bridge opens (no auto-play).
class HomeRowRemoteViewsFactory(
    private val context: Context,
    intent: Intent
) : RemoteViewsService.RemoteViewsFactory {
    private val rowId: String = intent.getStringExtra(HomeRowWidgetProvider.EXTRA_ROW_ID) ?: ""
    private val items = ArrayList<JSONObject>()

    override fun onCreate() {}

    override fun onDataSetChanged() {
        items.clear()
        try {
            var f = File(context.filesDir, "home_rows_state.json")
            if (!f.exists()) f = File(context.filesDir, "home_rows_state.json.tmp")
            if (!f.exists()) return
            val rows = JSONObject(f.readText()).optJSONArray("rows") ?: return
            var chosen: JSONArray? = null
            for (i in 0 until rows.length()) {
                val r = rows.optJSONObject(i) ?: continue
                if (rowId.isEmpty() || r.optString("id") == rowId) {
                    chosen = r.optJSONArray("items")
                    break
                }
            }
            // Configured row is gone (server/library changed) — fall back to the first.
            if (chosen == null && rows.length() > 0) {
                chosen = rows.optJSONObject(0)?.optJSONArray("items")
            }
            if (chosen != null) {
                for (i in 0 until chosen.length()) {
                    val it = chosen.optJSONObject(i) ?: continue
                    items.add(it)
                }
            }
        } catch (e: Exception) {
        }
    }

    override fun onDestroy() {
        items.clear()
    }

    override fun getCount(): Int = items.size

    override fun getViewAt(position: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.home_row_widget_item)
        if (position < 0 || position >= items.size) return views
        val it = items[position]
        val id = it.optString("id")
        val title = it.optString("title")
        val author = it.optString("author")
        views.setTextViewText(R.id.homerow_item_title, title)
        views.setTextViewText(R.id.homerow_item_author, author)
        views.setContentDescription(R.id.homerow_item_cover, title)

        // Progress + "Xh Ym left" for in-progress books (JS writes progress 1..99
        // and a preformatted label; both are absent/0 for unstarted or finished
        // items, which stay hidden — matching the app's Continue-listening rows).
        val progress = it.optInt("progress", 0)
        val timeLeft = it.optString("timeLeftLabel")
        // Contract: progress is 1..99 for in-progress books; 0/absent or a
        // finished (100) item hides the bar (JS clamps to 99, so 100 only
        // appears if a stale value slips in — defend against it here too).
        if (progress in 1..99) {
            views.setProgressBar(R.id.homerow_item_progress, 100, progress, false)
            views.setViewVisibility(R.id.homerow_item_progress, android.view.View.VISIBLE)
        } else {
            views.setViewVisibility(R.id.homerow_item_progress, android.view.View.GONE)
        }
        if (timeLeft.isNotEmpty()) {
            views.setTextViewText(R.id.homerow_item_timeleft, timeLeft)
            views.setViewVisibility(R.id.homerow_item_timeleft, android.view.View.VISIBLE)
        } else {
            views.setViewVisibility(R.id.homerow_item_timeleft, android.view.View.GONE)
        }

        val bmp = loadCover(it.optString("coverUrl"))
        if (bmp != null) views.setImageViewBitmap(R.id.homerow_item_cover, bmp)
        else views.setImageViewResource(R.id.homerow_item_cover, R.mipmap.ic_launcher)
        // Rounded cover corners to match the app's book art (API 31+; older
        // devices show square covers, a harmless degradation). clipToOutline must
        // be enabled or the preferred radius doesn't actually clip the bitmap.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            views.setBoolean(R.id.homerow_item_cover, "setClipToOutline", true)
            views.setViewOutlinePreferredRadius(R.id.homerow_item_cover, 8f, TypedValue.COMPLEX_UNIT_DIP)
        }

        val fill = Intent()
        fill.data = Uri.parse("tomesonic://item/" + id)
        views.setOnClickFillInIntent(R.id.homerow_item_root, fill)
        return views
    }

    override fun getLoadingView(): RemoteViews? = null
    override fun getViewTypeCount(): Int = 1
    override fun getItemId(position: Int): Long = position.toLong()
    override fun hasStableIds(): Boolean = false

    // Downsampled cover fetch with short timeouts + a small bounded in-memory
    // cache. Runs on the factory's binder thread (never main), so blocking I/O
    // is safe; any failure yields null and the caller shows the placeholder.
    private fun loadCover(url: String): Bitmap? {
        if (url.isEmpty()) return null
        synchronized(cache) { cache[url]?.let { return it } }
        var conn: HttpURLConnection? = null
        try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.instanceFollowRedirects = true
            val bytes = conn.inputStream.use { it.readBytes() }
            val bounds = BitmapFactory.Options()
            bounds.inJustDecodeBounds = true
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            val larger = maxOf(bounds.outWidth, bounds.outHeight)
            while (larger / sample > 128) sample *= 2
            val opts = BitmapFactory.Options()
            opts.inSampleSize = sample
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            if (bmp != null) synchronized(cache) { if (cache.size < 48) cache[url] = bmp }
            return bmp
        } catch (e: Exception) {
            return null
        } finally {
            conn?.disconnect()
        }
    }

    companion object {
        private val cache = HashMap<String, Bitmap>()
    }
}
