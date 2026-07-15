const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Adds a configurable "Home Row" home-screen widget: it shows ONE of the app's
// personalized home shelves (chosen in the widget's config screen when it is
// added) as a scrollable list. Tapping an item OPENS that book in the app
// WITHOUT auto-playing (a tomesonic://item/<id> deep link the JS launch bridge
// routes to the book's detail screen). Row data is written by JS to
// filesDir/home_rows_state.json (utils/autoCreds.ts writeHomeRowsState); the
// chosen row id per widget lives in SharedPreferences. Backed by a
// RemoteViewsService/factory; like the other widgets it refreshes on Android's
// periodic tick / re-add (live refresh is a follow-up).
const PACKAGE = "com.tomesonic.app";

const PROVIDER_KT = `package ${PACKAGE}.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import ${PACKAGE}.R

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
`;

const SERVICE_KT = `package ${PACKAGE}.widget

import android.content.Intent
import android.widget.RemoteViewsService

// Hosts the home-row widget's list factory.
class HomeRowWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory {
        return HomeRowRemoteViewsFactory(applicationContext, intent)
    }
}
`;

const FACTORY_KT = `package ${PACKAGE}.widget

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import ${PACKAGE}.R

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

        val bmp = loadCover(it.optString("coverUrl"))
        if (bmp != null) views.setImageViewBitmap(R.id.homerow_item_cover, bmp)
        else views.setImageViewResource(R.id.homerow_item_cover, R.mipmap.ic_launcher)

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
`;

const CONFIG_KT = `package ${PACKAGE}.widget

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
`;

const LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="12dp"
    android:background="@drawable/home_row_widget_bg">

    <TextView
        android:id="@+id/homerow_header"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:maxLines="1"
        android:ellipsize="end"
        android:textColor="#FFFFFF"
        android:textSize="14sp"
        android:textStyle="bold"
        android:paddingBottom="8dp"
        android:text="TomeSonic" />

    <ListView
        android:id="@+id/homerow_list"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:divider="@null"
        android:dividerHeight="0dp" />

    <TextView
        android:id="@+id/homerow_empty"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:gravity="center"
        android:textColor="#CFEDE4"
        android:textSize="13sp"
        android:text="No books to show yet — open TomeSonic to load your library" />
</LinearLayout>
`;

const ITEM_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/homerow_item_root"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:orientation="horizontal"
    android:gravity="center_vertical"
    android:paddingTop="6dp"
    android:paddingBottom="6dp">

    <ImageView
        android:id="@+id/homerow_item_cover"
        android:layout_width="44dp"
        android:layout_height="44dp"
        android:layout_marginEnd="12dp"
        android:scaleType="centerCrop"
        android:src="@mipmap/ic_launcher" />

    <LinearLayout
        android:layout_width="0dp"
        android:layout_height="wrap_content"
        android:layout_weight="1"
        android:orientation="vertical">

        <TextView
            android:id="@+id/homerow_item_title"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:maxLines="1"
            android:ellipsize="end"
            android:textColor="#FFFFFF"
            android:textSize="14sp" />

        <TextView
            android:id="@+id/homerow_item_author"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:maxLines="1"
            android:ellipsize="end"
            android:textColor="#CFEDE4"
            android:textSize="12sp" />
    </LinearLayout>
</LinearLayout>
`;

const BG_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#0D6B58" />
    <corners android:radius="20dp" />
</shape>
`;

const INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="180dp"
    android:minHeight="180dp"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/home_row_widget"
    android:previewImage="@mipmap/ic_launcher"
    android:resizeMode="horizontal|vertical"
    android:configure="${PACKAGE}.widget.HomeRowWidgetConfigActivity"
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
      writeFileSafe(j("app/src/main/java", pkgDir, "widget/HomeRowWidgetProvider.kt"), PROVIDER_KT);
      writeFileSafe(j("app/src/main/java", pkgDir, "widget/HomeRowWidgetService.kt"), SERVICE_KT);
      writeFileSafe(j("app/src/main/java", pkgDir, "widget/HomeRowRemoteViewsFactory.kt"), FACTORY_KT);
      writeFileSafe(j("app/src/main/java", pkgDir, "widget/HomeRowWidgetConfigActivity.kt"), CONFIG_KT);
      writeFileSafe(j("app/src/main/res/layout/home_row_widget.xml"), LAYOUT_XML);
      writeFileSafe(j("app/src/main/res/layout/home_row_widget_item.xml"), ITEM_XML);
      writeFileSafe(j("app/src/main/res/drawable/home_row_widget_bg.xml"), BG_XML);
      writeFileSafe(j("app/src/main/res/xml/home_row_widget_info.xml"), INFO_XML);
      return cfg;
    },
  ]);
}

function withWidgetComponents(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (!app) return cfg;

    // Receiver (the widget provider).
    app.receiver = app.receiver || [];
    const receiverName = PACKAGE + ".widget.HomeRowWidgetProvider";
    if (!app.receiver.some((r) => r.$ && r.$["android:name"] === receiverName)) {
      app.receiver.push({
        $: { "android:name": receiverName, "android:exported": "true" },
        "intent-filter": [
          { action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] },
        ],
        "meta-data": [
          {
            $: {
              "android:name": "android.appwidget.provider",
              "android:resource": "@xml/home_row_widget_info",
            },
          },
        ],
      });
    }

    // Service (RemoteViewsService backing the list) — must require BIND_REMOTEVIEWS.
    app.service = app.service || [];
    const serviceName = PACKAGE + ".widget.HomeRowWidgetService";
    if (!app.service.some((s) => s.$ && s.$["android:name"] === serviceName)) {
      app.service.push({
        $: {
          "android:name": serviceName,
          "android:permission": "android.permission.BIND_REMOTEVIEWS",
          "android:exported": "false",
        },
      });
    }

    // Config activity (the row picker shown on placement).
    app.activity = app.activity || [];
    const activityName = PACKAGE + ".widget.HomeRowWidgetConfigActivity";
    if (!app.activity.some((a) => a.$ && a.$["android:name"] === activityName)) {
      app.activity.push({
        $: { "android:name": activityName, "android:exported": "true" },
        "intent-filter": [
          { action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_CONFIGURE" } }] },
        ],
      });
    }

    return cfg;
  });
}

module.exports = (config) => withWidgetComponents(withWidgetFiles(config));
