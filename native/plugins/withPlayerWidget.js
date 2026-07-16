const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Adds a home-screen "Mini Player" widget styled like the in-app mini player:
// a compact card with the current book's cover, title, and a working
// play/pause button, that opens the app when tapped. It reads the SAME
// `filesDir/widget_state.json` the resume widget uses (written by JS —
// utils/autoCreds.ts writeWidgetState), which now also carries `isPlaying` and
// `coverPath`. The play/pause button fires a WIDGET_PLAY_PAUSE service action
// that MusicService routes straight to the Media3 player (works with the app
// backgrounded, and on Android 13+ where media-button intents don't). It refreshes
// on Android's periodic tick / re-add (live cross-surface refresh is a
// follow-up); tapping it opens the app which shows the live player.
const PACKAGE = "com.tomesonic.app";

const PROVIDER_KT = `package ${PACKAGE}.widget

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
import ${PACKAGE}.R

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
        val ppIntent = Intent("\${context.packageName}.WIDGET_PLAY_PAUSE").apply {
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
`;

const LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/mini_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:gravity="center_vertical"
    android:padding="10dp"
    android:background="@drawable/mini_player_widget_bg">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical">

        <ImageView
            android:id="@+id/mini_cover"
            android:layout_width="48dp"
            android:layout_height="48dp"
            android:layout_marginEnd="12dp"
            android:scaleType="centerCrop"
            android:src="@mipmap/ic_launcher" />

        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:orientation="vertical">

            <TextView
                android:id="@+id/mini_title"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:maxLines="1"
                android:ellipsize="end"
                android:textColor="#FFFFFF"
                android:textSize="14sp"
                android:textStyle="bold"
                android:text="TomeSonic" />

            <TextView
                android:id="@+id/mini_author"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:maxLines="1"
                android:ellipsize="end"
                android:textColor="#CFEDE4"
                android:textSize="12sp"
                android:text="Tap to resume listening" />
        </LinearLayout>

        <ImageView
            android:id="@+id/mini_play_pause"
            android:layout_width="40dp"
            android:layout_height="40dp"
            android:layout_marginStart="8dp"
            android:padding="6dp"
            android:src="@drawable/ic_widget_play" />
    </LinearLayout>

    <ProgressBar
        android:id="@+id/mini_progress"
        style="?android:attr/progressBarStyleHorizontal"
        android:layout_width="match_parent"
        android:layout_height="3dp"
        android:layout_marginTop="8dp"
        android:max="100"
        android:progress="0"
        android:progressTint="#86D6BF"
        android:progressBackgroundTint="#4CFFFFFF" />
</LinearLayout>
`;

const BG_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#334C44" />
    <corners android:radius="20dp" />
</shape>
`;

// Transport glyphs are extracted from the SAME MaterialCommunityIcons font the
// in-app player renders (rewind-10 / fast-forward-10 / play / pause /
// skip-previous / skip-next), so the widget's controls match the app pixel-for-
// pixel. viewport is the font's 512-unit em; the y-axis is flipped (font is
// y-up, VectorDrawable is y-down) about A=438 to keep the glyph centered.
const IC_PLAY_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="512" android:viewportHeight="512" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M171 100V398L405 249Z" />
</vector>
`;

const IC_PAUSE_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="512" android:viewportHeight="512" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M299 395H384V97H299ZM128 395H213V97H128Z" />
</vector>
`;

const INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="180dp"
    android:minHeight="48dp"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/mini_player_widget"
    android:previewLayout="@layout/mini_player_widget"
    android:previewImage="@mipmap/ic_launcher"
    android:resizeMode="horizontal"
    android:widgetCategory="home_screen" />
`;

// ---------------------------------------------------------------------------
// FULL-SIZE player widget: cover + title/author + progress bar + full transport
// (chapter prev, jump back, play/pause, jump fwd, chapter next), styled like the
// in-app full player. Reads the same widget_state.json (position/duration drive
// the progress bar). Chapter prev/next send explicit WIDGET_CHAPTER_* service
// actions (the media-button next/prev keys are remapped to jump), which
// MusicService routes to JS chapter navigation.
// ---------------------------------------------------------------------------
const FULL_PROVIDER_KT = `package ${PACKAGE}.widget

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
import ${PACKAGE}.R

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
        views.setOnClickPendingIntent(R.id.full_play_pause, actionPI(context, 1, "\${context.packageName}.WIDGET_PLAY_PAUSE"))
        views.setOnClickPendingIntent(R.id.full_jump_back, actionPI(context, 2, "\${context.packageName}.WIDGET_JUMP_BACK"))
        views.setOnClickPendingIntent(R.id.full_jump_fwd, actionPI(context, 3, "\${context.packageName}.WIDGET_JUMP_FORWARD"))
        views.setOnClickPendingIntent(R.id.full_chapter_prev, actionPI(context, 4, "\${context.packageName}.WIDGET_CHAPTER_PREV"))
        views.setOnClickPendingIntent(R.id.full_chapter_next, actionPI(context, 5, "\${context.packageName}.WIDGET_CHAPTER_NEXT"))

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
`;

const FULL_LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/full_open"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="14dp"
    android:background="@drawable/mini_player_widget_bg">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:orientation="horizontal"
        android:gravity="center_vertical">

        <ImageView
            android:id="@+id/full_cover"
            android:layout_width="56dp"
            android:layout_height="56dp"
            android:layout_marginEnd="14dp"
            android:scaleType="centerCrop"
            android:src="@mipmap/ic_launcher" />

        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:orientation="vertical">

            <TextView android:id="@+id/full_title"
                android:layout_width="match_parent" android:layout_height="wrap_content"
                android:maxLines="1" android:ellipsize="end"
                android:textColor="#FFFFFF" android:textSize="15sp" android:textStyle="bold"
                android:text="TomeSonic" />

            <TextView android:id="@+id/full_author"
                android:layout_width="match_parent" android:layout_height="wrap_content"
                android:maxLines="1" android:ellipsize="end"
                android:textColor="#CFEDE4" android:textSize="12sp"
                android:text="Tap to resume listening" />
        </LinearLayout>
    </LinearLayout>

    <ProgressBar
        android:id="@+id/full_progress"
        style="?android:attr/progressBarStyleHorizontal"
        android:layout_width="match_parent"
        android:layout_height="4dp"
        android:layout_marginTop="8dp"
        android:layout_marginBottom="2dp"
        android:max="100"
        android:progress="0"
        android:progressTint="#86D6BF"
        android:progressBackgroundTint="#4CFFFFFF" />

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="4dp">

        <TextView android:id="@+id/full_elapsed"
            android:layout_width="0dp" android:layout_height="wrap_content" android:layout_weight="1"
            android:maxLines="1"
            android:textColor="#CFEDE4" android:textSize="11sp"
            android:text="0:00" />

        <TextView android:id="@+id/full_remaining"
            android:layout_width="0dp" android:layout_height="wrap_content" android:layout_weight="1"
            android:maxLines="1" android:gravity="end"
            android:textColor="#CFEDE4" android:textSize="11sp"
            android:text="" />
    </LinearLayout>

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center">

        <ImageView android:id="@+id/full_chapter_prev"
            android:layout_width="40dp" android:layout_height="40dp" android:padding="8dp"
            android:contentDescription="Previous chapter" android:src="@drawable/ic_widget_prev" />
        <ImageView android:id="@+id/full_jump_back"
            android:layout_width="40dp" android:layout_height="40dp" android:padding="8dp"
            android:layout_marginStart="10dp"
            android:contentDescription="Jump back" android:src="@drawable/ic_widget_rewind" />
        <ImageView android:id="@+id/full_play_pause"
            android:layout_width="48dp" android:layout_height="48dp" android:padding="8dp"
            android:layout_marginStart="10dp" android:layout_marginEnd="10dp"
            android:src="@drawable/ic_widget_play" />
        <ImageView android:id="@+id/full_jump_fwd"
            android:layout_width="40dp" android:layout_height="40dp" android:padding="8dp"
            android:contentDescription="Jump forward" android:src="@drawable/ic_widget_forward" />
        <ImageView android:id="@+id/full_chapter_next"
            android:layout_width="40dp" android:layout_height="40dp" android:padding="8dp"
            android:layout_marginStart="10dp"
            android:contentDescription="Next chapter" android:src="@drawable/ic_widget_next" />
    </LinearLayout>
</LinearLayout>
`;

// rewind-10 / fast-forward-10: the circular-arrow "loop" glyphs with the 10s
// increment, matching the in-app player's jump buttons (MaterialCommunityIcons).
const IC_REWIND_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="512" android:viewportHeight="512" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M267 54Q340 54 398.5 97.0Q457 140 479 208L429 225Q412 173 367.5 140.0Q323 107 267 107Q205 107 157 147L213 203H64V54L119 109Q150 83 187.5 68.5Q225 54 267 54ZM213 246V459H171V289H128V246ZM384 289V417Q384 434 371.5 446.5Q359 459 341 459H299Q281 459 268.5 446.5Q256 434 256 417V289Q256 271 268.5 258.5Q281 246 299 246H341Q359 246 371.5 258.5Q384 271 384 289ZM299 289V417H341V289Z" />
</vector>
`;
const IC_FORWARD_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="512" android:viewportHeight="512" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M213 246V459H171V289H128V246ZM384 289V417Q384 434 371.5 446.5Q359 459 341 459H299Q281 459 268.5 446.5Q256 434 256 417V289Q256 271 268.5 258.5Q281 246 299 246H341Q359 246 371.5 258.5Q384 271 384 289ZM299 289V417H341V289ZM245 54Q287 54 324.5 68.5Q362 83 393 109L448 54V203H299L355 147Q307 107 245 107Q189 107 144.5 140.0Q100 173 83 225L33 208Q55 140 113.5 97.0Q172 54 245 54Z" />
</vector>
`;
const IC_PREV_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="512" android:viewportHeight="512" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M128 374V118H171V374ZM203 246 384 118V374Z" />
</vector>
`;
const IC_NEXT_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="512" android:viewportHeight="512" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M341 374H384V118H341ZM128 374 309 246 128 118Z" />
</vector>
`;

const FULL_INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="250dp"
    android:minHeight="110dp"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/full_player_widget"
    android:previewLayout="@layout/full_player_widget"
    android:previewImage="@mipmap/ic_launcher"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen" />
`;

function writeFileSafe(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function withWidgetFiles(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const pkgDir = PACKAGE.replace(/\./g, "/");
      const j = (...p) => path.join(root, ...p);
      writeFileSafe(
        j("app/src/main/java", pkgDir, "widget/MiniPlayerWidgetProvider.kt"),
        PROVIDER_KT
      );
      writeFileSafe(j("app/src/main/res/layout/mini_player_widget.xml"), LAYOUT_XML);
      writeFileSafe(j("app/src/main/res/drawable/mini_player_widget_bg.xml"), BG_XML);
      writeFileSafe(j("app/src/main/res/drawable/ic_widget_play.xml"), IC_PLAY_XML);
      writeFileSafe(j("app/src/main/res/drawable/ic_widget_pause.xml"), IC_PAUSE_XML);
      writeFileSafe(j("app/src/main/res/xml/mini_player_widget_info.xml"), INFO_XML);
      // Full-size player widget.
      writeFileSafe(
        j("app/src/main/java", pkgDir, "widget/FullPlayerWidgetProvider.kt"),
        FULL_PROVIDER_KT
      );
      writeFileSafe(j("app/src/main/res/layout/full_player_widget.xml"), FULL_LAYOUT_XML);
      writeFileSafe(j("app/src/main/res/drawable/ic_widget_rewind.xml"), IC_REWIND_XML);
      writeFileSafe(j("app/src/main/res/drawable/ic_widget_forward.xml"), IC_FORWARD_XML);
      writeFileSafe(j("app/src/main/res/drawable/ic_widget_prev.xml"), IC_PREV_XML);
      writeFileSafe(j("app/src/main/res/drawable/ic_widget_next.xml"), IC_NEXT_XML);
      writeFileSafe(j("app/src/main/res/xml/full_player_widget_info.xml"), FULL_INFO_XML);
      return cfg;
    },
  ]);
}

function addReceiver(app, providerName, infoResource) {
  app.receiver = app.receiver || [];
  const name = `${PACKAGE}.widget.${providerName}`;
  if (app.receiver.some((r) => r.$ && r.$["android:name"] === name)) return;
  app.receiver.push({
    $: { "android:name": name, "android:exported": "true" },
    "intent-filter": [
      {
        action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }],
      },
    ],
    "meta-data": [
      {
        $: {
          "android:name": "android.appwidget.provider",
          "android:resource": infoResource,
        },
      },
    ],
  });
}

function withWidgetReceiver(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (!app) return cfg;
    addReceiver(app, "MiniPlayerWidgetProvider", "@xml/mini_player_widget_info");
    addReceiver(app, "FullPlayerWidgetProvider", "@xml/full_player_widget_info");
    return cfg;
  });
}

module.exports = (config) => withWidgetReceiver(withWidgetFiles(config));
