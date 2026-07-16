package com.tomesonic.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.util.TypedValue
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import com.tomesonic.app.R

// Full-size player home-screen widget.
class FullPlayerWidgetProvider : AppWidgetProvider() {
    private val SERVICE = "com.doublesymmetry.trackplayer.service.MusicService"

    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) updateWidget(context, mgr, id)
    }

    private fun updateWidget(context: Context, mgr: AppWidgetManager, id: Int) {
        val views = RemoteViews(context.packageName, R.layout.full_player_widget)
        var title = "TomeSonic"
        var author = "Tap to resume listening"
        var isPlaying = false
        var coverPath = ""
        var position = 0
        var duration = 0
        try {
            var f = File(context.filesDir, "widget_state.json")
            if (!f.exists()) f = File(context.filesDir, "widget_state.json.tmp")
            if (f.exists()) {
                val o = JSONObject(f.readText())
                val t = o.optString("title"); if (t.isNotEmpty()) title = t
                val a = o.optString("author"); if (a.isNotEmpty()) author = a
                isPlaying = o.optBoolean("isPlaying", false)
                coverPath = o.optString("coverPath")
                position = o.optInt("position", 0)
                duration = o.optInt("duration", 0)
            }
        } catch (e: Exception) {
            // Fall back to defaults.
        }
        views.setTextViewText(R.id.full_title, title)
        views.setTextViewText(R.id.full_author, author)

        // Downsampled cover (see decodeSampledCover), placeholder otherwise.
        var coverSet = false
        if (coverPath.isNotEmpty()) {
            try {
                val p = if (coverPath.startsWith("file://")) coverPath.substring(7) else coverPath
                val bmp = decodeSampledCover(p, 256)
                if (bmp != null) { views.setImageViewBitmap(R.id.full_cover, bmp); coverSet = true }
            } catch (e: Exception) {}
        }
        if (!coverSet) views.setImageViewResource(R.id.full_cover, R.mipmap.ic_launcher)
        // Rounded cover corners to match the app's book art (API 31+). clipToOutline
        // must be enabled or the preferred radius doesn't actually clip the bitmap.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            views.setBoolean(R.id.full_cover, "setClipToOutline", true)
            views.setViewOutlinePreferredRadius(R.id.full_cover, 12f, TypedValue.COMPLEX_UNIT_DIP)
        }

        // Progress bar (whole seconds); clamp so a position past/without a known
        // duration can't render an out-of-range bar.
        val progMax = if (duration > 0) duration else 100
        views.setProgressBar(R.id.full_progress, progMax, position.coerceIn(0, progMax), false)

        // Elapsed (left) / -remaining (right) time labels, matching the in-app
        // player's scrubber labels. Remaining is blank until a duration is known.
        views.setTextViewText(R.id.full_elapsed, formatClock(position))
        views.setTextViewText(
            R.id.full_remaining,
            if (duration > 0) "-" + formatClock((duration - position).coerceAtLeast(0)) else ""
        )

        views.setImageViewResource(
            R.id.full_play_pause,
            if (isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play
        )
        views.setContentDescription(R.id.full_play_pause, if (isPlaying) "Pause" else "Play")

        // All transport → explicit WIDGET_* service actions, which MusicService
        // routes straight to the Media3 player in onStartCommand. (MEDIA_BUTTON
        // intents to a background service are ignored on Android 13+ and blocked
        // by FGS-start rules, which is why the old buttons did nothing.)
        views.setOnClickPendingIntent(R.id.full_play_pause, actionPI(context, 1, "${context.packageName}.WIDGET_PLAY_PAUSE"))
        views.setOnClickPendingIntent(R.id.full_jump_back, actionPI(context, 2, "${context.packageName}.WIDGET_JUMP_BACK"))
        views.setOnClickPendingIntent(R.id.full_jump_fwd, actionPI(context, 3, "${context.packageName}.WIDGET_JUMP_FORWARD"))
        views.setOnClickPendingIntent(R.id.full_chapter_prev, actionPI(context, 4, "${context.packageName}.WIDGET_CHAPTER_PREV"))
        views.setOnClickPendingIntent(R.id.full_chapter_next, actionPI(context, 5, "${context.packageName}.WIDGET_CHAPTER_NEXT"))

        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            views.setOnClickPendingIntent(R.id.full_open, PendingIntent.getActivity(context, 0, launch, flags))
        }
        mgr.updateAppWidget(id, views)
    }

    private fun actionPI(context: Context, req: Int, action: String): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val intent = Intent(action).apply { component = ComponentName(context.packageName, SERVICE) }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            PendingIntent.getForegroundService(context, req, intent, flags)
        else PendingIntent.getService(context, req, intent, flags)
    }

    // Seconds -> H:MM:SS (or M:SS under an hour), matching the in-app player's
    // secondsToTimestamp so the widget's clock reads identically.
    private fun formatClock(totalSeconds: Int): String {
        val s = if (totalSeconds < 0) 0 else totalSeconds
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, sec)
        else String.format("%d:%02d", m, sec)
    }

    private fun decodeSampledCover(path: String, reqPx: Int): android.graphics.Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        val larger = maxOf(bounds.outWidth, bounds.outHeight)
        while (larger / sample > reqPx) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeFile(path, opts)
    }
}
