const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Vector drawables for the Android Auto browse categories (referenced from
// the native MusicService via android.resource:// URIs). Standard Material
// Symbols path data (Apache-2.0), white fill for AA's dark templates.
const ICONS = {
  aa_continue:
    "M12,3a9,9 0 0,0 -9,9v7c0,1.1 0.9,2 2,2h4v-8H5v-1c0,-3.87 3.13,-7 7,-7s7,3.13 7,7v1h-4v8h4c1.1,0 2,-0.9 2,-2v-7a9,9 0 0,0 -9,-9z",
  aa_series:
    "M4,6H2v14c0,1.1 0.9,2 2,2h14v-2H4V6zm16,-4H8c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h12c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zm-1,9H9V9h10v2zm-4,4H9v-2h6v2zm4,-8H9V5h10v2z",
  aa_downloads:
    "M5,20h14v-2H5v2zM19,9h-4V3H9v6H5l7,7 7,-7z",
  aa_library:
    "M21,5c-1.11,-0.35 -2.33,-0.5 -3.5,-0.5 -1.95,0 -4.05,0.4 -5.5,1.5 -1.45,-1.1 -3.55,-1.5 -5.5,-1.5S2.45,4.9 1,6v14.65c0,0.25 0.25,0.5 0.5,0.5 0.1,0 0.15,-0.05 0.25,-0.05C3.1,20.45 5.05,20 6.5,20c1.95,0 4.05,0.4 5.5,1.5 1.35,-0.85 3.8,-1.5 5.5,-1.5 1.65,0 3.35,0.3 4.75,1.05 0.1,0.05 0.15,0.05 0.25,0.05 0.25,0 0.5,-0.25 0.5,-0.5V6c-0.6,-0.45 -1.25,-0.75 -2,-1zm0,13.5c-1.1,-0.35 -2.3,-0.5 -3.5,-0.5 -1.7,0 -4.15,0.65 -5.5,1.5V8c1.35,-0.85 3.8,-1.5 5.5,-1.5 1.2,0 2.4,0.15 3.5,0.5v11.5z",
  aa_recent:
    "M11.99,2C6.47,2 2,6.48 2,12s4.47,10 9.99,10C17.52,22 22,17.52 22,12S17.52,2 11.99,2zM12,20c-4.42,0 -8,-3.58 -8,-8s3.58,-8 8,-8 8,3.58 8,8 -3.58,8 -8,8zm0.5,-13H11v6l5.25,3.15 0.75,-1.23 -4.5,-2.67z",
  aa_author:
    "M12,12c2.21,0 4,-1.79 4,-4s-1.79,-4 -4,-4 -4,1.79 -4,4 1.79,4 4,4zm0,2c-2.67,0 -8,1.34 -8,4v2h16v-2c0,-2.66 -5.33,-4 -8,-4z",
  aa_collections:
    "M3,3h8v8H3V3zm10,0h8v8h-8V3zM3,13h8v8H3v-8zm10,0h8v8h-8v-8z",
  aa_books:
    "M18,2H6c-1.1,0 -2,0.9 -2,2v16c0,1.1 0.9,2 2,2h12c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM6,4h5v8l-2.5,-1.5L6,12V4z",
  aa_replay:
    "M12,5V1L7,6l5,5V7c3.31,0 6,2.69 6,6s-2.69,6 -6,6 -6,-2.69 -6,-6H4c0,4.42 3.58,8 8,8s8,-3.58 8,-8 -3.58,-8 -8,-8z",
};

function iconXml(pathData) {
  return `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="${pathData}"/>
</vector>
`;
}

/** Writes the browse-category vector drawables so `expo prebuild` can't drop
 *  them (they're referenced at runtime by name, invisible to resource tools). */
module.exports = function withAutoBrowseIcons(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const dir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/res/drawable"
      );
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, pathData] of Object.entries(ICONS)) {
        fs.writeFileSync(path.join(dir, `${name}.xml`), iconXml(pathData));
      }
      return cfg;
    },
  ]);
};
