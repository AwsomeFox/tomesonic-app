package com.tomesonic.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.view.KeyEvent
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import com.tomesonic.app.R

// Mini-player home-screen widget. onUpdate reads the current book from
// filesDir/widget_state.json (cover/title/isPlaying), renders the compact card,
// wires the play/pause button to a MEDIA_BUTTON intent for the MusicService,
// and a card tap to launch the app.
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
            }
        } catch (e: Exception) {
            // Fall back to defaults.
        }
        views.setTextViewText(R.id.mini_title, title)
        views.setTextViewText(R.id.mini_author, author)

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

        // Play/pause glyph reflects the last-known state.
        views.setImageViewResource(
            R.id.mini_play_pause,
            if (isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play
        )

        // Play/pause button → MEDIA_BUTTON to the MusicService (the same surface
        // hardware/BT play-pause keys use; headless-safe — resumes the last
        // session if nothing is loaded).
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val mediaIntent = Intent(Intent.ACTION_MEDIA_BUTTON).apply {
            component = ComponentName(
                context.packageName,
                "com.doublesymmetry.trackplayer.service.MusicService"
            )
            putExtra(
                Intent.EXTRA_KEY_EVENT,
                KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
            )
        }
        val playPausePi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(context, 1, mediaIntent, flags)
        } else {
            PendingIntent.getService(context, 1, mediaIntent, flags)
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
