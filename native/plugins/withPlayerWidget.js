const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Adds a home-screen "Mini Player" widget styled like the in-app mini player:
// a compact card with the current book's cover, title, and a working
// play/pause button, that opens the app when tapped. It reads the SAME
// `filesDir/widget_state.json` the resume widget uses (written by JS —
// utils/autoCreds.ts writeWidgetState), which now also carries `isPlaying` and
// `coverPath`. The play/pause button dispatches a MEDIA_BUTTON intent to the
// track-player MusicService (the exact surface hardware/BT keys use), so it
// works even with the app backgrounded. Like the resume widget, it refreshes
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
import android.view.KeyEvent
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import ${PACKAGE}.R

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
`;

const LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/mini_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="horizontal"
    android:gravity="center_vertical"
    android:padding="10dp"
    android:background="@drawable/mini_player_widget_bg">

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
`;

const BG_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#334C44" />
    <corners android:radius="20dp" />
</shape>
`;

const IC_PLAY_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24"
    android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M8,5v14l11,-7z" />
</vector>
`;

const IC_PAUSE_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24"
    android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M6,19h4V5H6v14zM14,5v14h4V5h-4z" />
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
import android.view.KeyEvent
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

        views.setImageViewResource(
            R.id.full_play_pause,
            if (isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play
        )
        views.setContentDescription(R.id.full_play_pause, if (isPlaying) "Pause" else "Play")

        // play/pause + jumps → MEDIA_BUTTON to the service (same surface hardware
        // keys use). Chapter prev/next → explicit WIDGET_CHAPTER_* service actions.
        views.setOnClickPendingIntent(R.id.full_play_pause, mediaKeyPI(context, 1, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        views.setOnClickPendingIntent(R.id.full_jump_back, mediaKeyPI(context, 2, KeyEvent.KEYCODE_MEDIA_REWIND))
        views.setOnClickPendingIntent(R.id.full_jump_fwd, mediaKeyPI(context, 3, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD))
        views.setOnClickPendingIntent(R.id.full_chapter_prev, actionPI(context, 4, "\${context.packageName}.WIDGET_CHAPTER_PREV"))
        views.setOnClickPendingIntent(R.id.full_chapter_next, actionPI(context, 5, "\${context.packageName}.WIDGET_CHAPTER_NEXT"))

        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            views.setOnClickPendingIntent(R.id.full_open, PendingIntent.getActivity(context, 0, launch, flags))
        }
        mgr.updateAppWidget(id, views)
    }

    private fun mediaKeyPI(context: Context, req: Int, keyCode: Int): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val intent = Intent(Intent.ACTION_MEDIA_BUTTON).apply {
            component = ComponentName(context.packageName, SERVICE)
            putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            PendingIntent.getForegroundService(context, req, intent, flags)
        else PendingIntent.getService(context, req, intent, flags)
    }

    private fun actionPI(context: Context, req: Int, action: String): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val intent = Intent(action).apply { component = ComponentName(context.packageName, SERVICE) }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            PendingIntent.getForegroundService(context, req, intent, flags)
        else PendingIntent.getService(context, req, intent, flags)
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
        android:layout_marginBottom="6dp"
        android:max="100"
        android:progress="0"
        android:progressTint="#86D6BF"
        android:progressBackgroundTint="#4CFFFFFF" />

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

const IC_REWIND_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M11,18V6l-8.5,6L11,18zM11.5,12l8.5,6V6L11.5,12z" />
</vector>
`;
const IC_FORWARD_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M4,18l8.5,-6L4,6v12zM13,6v12l8.5,-6L13,6z" />
</vector>
`;
const IC_PREV_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M6,6h2v12H6zM9.5,12l8.5,6V6z" />
</vector>
`;
const IC_NEXT_XML = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFF" android:pathData="M6,18l8.5,-6L6,6zM16,6v12h2V6z" />
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
