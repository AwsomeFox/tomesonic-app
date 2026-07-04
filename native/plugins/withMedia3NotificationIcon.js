const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// RNTP 5's media notification is built by Media3's
// DefaultMediaNotificationProvider, which hard-defaults the small (status bar)
// icon to the LIBRARY drawable `media3_notification_small_icon` — the generic
// media glyph. RNTP 5.0.0-alpha0 ignores the JS `icon`/`notificationIcon`
// options entirely, so the only reliable fix is Android resource overriding:
// an app-level drawable with the same name wins the resource merge.
//
// expo-notifications already renders our ./assets/notification-icon.png into
// res/drawable-*dpi as `notification_icon`, so this just aliases that icon
// under the name Media3 looks up.
const ALIAS_XML = `<?xml version="1.0" encoding="utf-8"?>
<bitmap xmlns:android="http://schemas.android.com/apk/res/android"
    android:src="@drawable/notification_icon" />
`;

module.exports = function withMedia3NotificationIcon(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const drawableDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/res/drawable"
      );
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.writeFileSync(
        path.join(drawableDir, "media3_notification_small_icon.xml"),
        ALIAS_XML
      );
      return cfg;
    },
  ]);
};
