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

// Mini-player home-screen widget. onUpdate reads the current book from
// filesDir/widget_state.json (cover/title/isPlaying), renders the compact card,
// wires the play/pause button to a WIDGET_PLAY_PAUSE service action routed to
// the Media3 player, and a card tap to launch the app.
class MiniPlayerWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) updateWidget(context, mgr, id)
    }

    private fun updateWidget(context: Context, mgr: AppWidgetManager, id: Int) {
        val views = RemoteViews(context.packageName, R.layout.mini_player_widget)
        var title = "TomeSonic"
        var author = "Tap to resume listening"
        var isPlaying = false
        var coverPath = ""
        var position = 0
        var duration = 0
        try {
            // JS swaps this file via delete-then-rename — if a widget update
            // lands in that gap, the fully-written .tmp still holds the state.
            var f = File(context.filesDir, "widget_state.json")
            if (!f.exists()) f = File(context.filesDir, "widget_state.json.tmp")
            if (f.exists()) {
                val o = JSONObject(f.readText())
                val t = o.optString("title")
                if (t.isNotEmpty()) title = t
                val a = o.optString("author")
                if (a.isNotEmpty()) author = a
                isPlaying = o.optBoolean("isPlaying", false)
                coverPath = o.optString("coverPath")
                position = o.optInt("position", 0)
                duration = o.optInt("duration", 0)
            }
        } catch (e: Exception) {
            // Fall back to defaults.
        }
        views.setTextViewText(R.id.mini_title, title)
        views.setTextViewText(R.id.mini_author, author)

        // Thin progress line under the card (clamped like the full widget).
        val progMax = if (duration > 0) duration else 100
        views.setProgressBar(R.id.mini_progress, progMax, position.coerceIn(0, progMax), false)

        // Cover: decode the locally-cached cover file (app-private, same UID) to
        // a DOWNSAMPLED bitmap sized for the widget. Decoding the full-size
        // original (covers can be 800px+) risks a huge main-thread allocation
        // AND a RemoteViews TransactionTooLargeException when the bitmap is
        // serialized over Binder to the launcher.
        var coverSet = false
        if (coverPath.isNotEmpty()) {
            try {
                val p = if (coverPath.startsWith("file://")) coverPath.substring(7) else coverPath
                val bmp = decodeSampledCover(p, 256)
                if (bmp != null) {
                    views.setImageViewBitmap(R.id.mini_cover, bmp)
                    coverSet = true
                }
            } catch (e: Exception) {
                // Fall through to the placeholder.
            }
        }
        if (!coverSet) views.setImageViewResource(R.id.mini_cover, R.mipmap.ic_launcher)
        // Rounded cover corners to match the app's book art (API 31+). clipToOutline
        // must be enabled or the preferred radius doesn't actually clip the bitmap.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            views.setBoolean(R.id.mini_cover, "setClipToOutline", true)
            views.setViewOutlinePreferredRadius(R.id.mini_cover, 10f, TypedValue.COMPLEX_UNIT_DIP)
        }

        // Play/pause glyph reflects the last-known state; keep an accessible
        // label in sync so TalkBack announces the current action.
        views.setImageViewResource(
            R.id.mini_play_pause,
            if (isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play
        )
        views.setContentDescription(R.id.mini_play_pause, if (isPlaying) "Pause" else "Play")

        // Play/pause button → explicit WIDGET_PLAY_PAUSE service action, which
        // MusicService routes straight to the Media3 player in onStartCommand. A
        // MEDIA_BUTTON intent to a background service is ignored on Android 13+
        // (and blocked by FGS-start rules), which is why the old button was dead.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val ppIntent = Intent("${context.packageName}.WIDGET_PLAY_PAUSE").apply {
            component = ComponentName(
                context.packageName,
                "com.doublesymmetry.trackplayer.service.MusicService"
            )
        }
        val playPausePi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(context, 1, ppIntent, flags)
        } else {
            PendingIntent.getService(context, 1, ppIntent, flags)
        }
        views.setOnClickPendingIntent(R.id.mini_play_pause, playPausePi)

        // Card tap → open the app (which shows the live player).
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            val pi = PendingIntent.getActivity(context, 0, launch, flags)
            views.setOnClickPendingIntent(R.id.mini_root, pi)
        }
        mgr.updateAppWidget(id, views)
    }

    // Decode the cover downsampled so its longest side is ~reqPx — bounds-only
    // first to pick a power-of-two inSampleSize, then the real decode. Keeps the
    // bitmap small enough for RemoteViews' Binder transaction and cheap to alloc.
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
