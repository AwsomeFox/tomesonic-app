const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Declares the app as an Android Auto MEDIA app. RNTP 5's MusicService already
// registers the browsable MediaLibraryService; this adds the app-level
// automotive descriptor + meta-data Auto looks for. Browse content is served by
// the patched RNTP MediaLibrarySession (reads filesDir/auto_creds.json).
const AUTOMOTIVE_DESC = `<?xml version="1.0" encoding="utf-8"?>
<automotiveApp>
    <uses name="media"/>
</automotiveApp>
`;

function withAutoDescriptor(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const xmlDir = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, "automotive_app_desc.xml"), AUTOMOTIVE_DESC);
      return cfg;
    },
  ]);
}

function withAutoManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (!app) return cfg;
    app["meta-data"] = app["meta-data"] || [];
    const has = app["meta-data"].some(
      (m) => m.$ && m.$["android:name"] === "com.google.android.gms.car.application"
    );
    if (!has) {
      app["meta-data"].push({
        $: {
          "android:name": "com.google.android.gms.car.application",
          "android:resource": "@xml/automotive_app_desc",
        },
      });
    }
    return cfg;
  });
}

module.exports = (config) => withAutoManifest(withAutoDescriptor(config));
