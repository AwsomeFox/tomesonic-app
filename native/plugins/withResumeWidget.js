const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Adds a home-screen "Resume" widget: a one-tap tile that opens the app (which
// auto-restores the last playback session) and shows the current book's title/
// author. Native `ResumeWidgetProvider` reads `filesDir/widget_state.json`,
// written by JS (utils/autoCreds.ts writeWidgetState) whenever a book loads.
const PACKAGE = "com.tomesonic.app";

const PROVIDER_KT = `package ${PACKAGE}.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import ${PACKAGE}.R

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
`;

const LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="horizontal"
    android:gravity="center_vertical"
    android:padding="14dp"
    android:background="@drawable/resume_widget_bg">

    <ImageView
        android:layout_width="40dp"
        android:layout_height="40dp"
        android:layout_marginEnd="14dp"
        android:src="@mipmap/ic_launcher" />

    <LinearLayout
        android:layout_width="0dp"
        android:layout_height="wrap_content"
        android:layout_weight="1"
        android:orientation="vertical">

        <TextView
            android:id="@+id/widget_title"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:maxLines="1"
            android:ellipsize="end"
            android:textColor="#FFFFFF"
            android:textSize="15sp"
            android:textStyle="bold"
            android:text="TomeSonic" />

        <TextView
            android:id="@+id/widget_subtitle"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:maxLines="1"
            android:ellipsize="end"
            android:textColor="#CFEDE4"
            android:textSize="12sp"
            android:text="Tap to resume listening" />
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
    android:minHeight="72dp"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/resume_widget"
    android:previewImage="@mipmap/ic_launcher"
    android:resizeMode="horizontal"
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
      writeFileSafe(
        path.join(root, "app/src/main/java", pkgDir, "widget/ResumeWidgetProvider.kt"),
        PROVIDER_KT
      );
      writeFileSafe(path.join(root, "app/src/main/res/layout/resume_widget.xml"), LAYOUT_XML);
      writeFileSafe(path.join(root, "app/src/main/res/drawable/resume_widget_bg.xml"), BG_XML);
      writeFileSafe(path.join(root, "app/src/main/res/xml/resume_widget_info.xml"), INFO_XML);
      return cfg;
    },
  ]);
}

function withWidgetReceiver(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (!app) return cfg;
    app.receiver = app.receiver || [];
    const name = `${PACKAGE}.widget.ResumeWidgetProvider`;
    const exists = app.receiver.some((r) => r.$ && r.$["android:name"] === name);
    if (!exists) {
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
              "android:resource": "@xml/resume_widget_info",
            },
          },
        ],
      });
    }
    return cfg;
  });
}

module.exports = (config) => withWidgetReceiver(withWidgetFiles(config));
