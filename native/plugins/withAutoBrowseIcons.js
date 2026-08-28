const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Vector drawables for the Android Auto browse categories (referenced from
// the native MusicService via android.resource:// URIs). Standard Material
// Symbols path data (Apache-2.0), white fill for AA's dark templates.
// This map must cover EVERY name MusicService resolves at runtime — the
// category icons below AND the aa_lib_* set absLibraryIconRes maps ABS
// library icons onto. A name missing here still compiles (the committed
// drawable satisfies the build) but silently vanishes on the next
// `expo prebuild --clean`, and the head unit then drops that library's icon.
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
  // ABS library icons (absLibraryIconRes in the patched MusicService).
  aa_lib_database:
    "M2,20h20v-4H2v4zM4,17h2v2H4v-2zM2,4v4h20V4H2zM6,7H4V5h2v2zM2,14h20v-4H2v4zM4,11h2v2H4v-2z",
  aa_lib_headphones:
    "M12,3c-4.97,0 -9,4.03 -9,9v7c0,1.1 0.9,2 2,2h4v-8H5v-1c0,-3.87 3.13,-7 7,-7s7,3.13 7,7v1h-4v8h4c1.1,0 2,-0.9 2,-2v-7c0,-4.97 -4.03,-9 -9,-9z",
  aa_lib_heart:
    "M12,21.35l-1.45,-1.32C5.4,15.36 2,12.28 2,8.5 2,5.42 4.42,3 7.5,3c1.74,0 3.41,0.81 4.5,2.09C13.09,3.81 14.76,3 16.5,3 19.58,3 22,5.42 22,8.5c0,3.78 -3.4,6.86 -8.55,11.54L12,21.35z",
  aa_lib_image:
    "M21,19V5c0,-1.1 -0.9,-2 -2,-2H5c-1.1,0 -2,0.9 -2,2v14c0,1.1 0.9,2 2,2h14c1.1,0 2,-0.9 2,-2zM8.5,13.5l2.5,3.01L14.5,12l4.5,6H5l3.5,-4.5z",
  aa_lib_mic:
    "M12,14c1.66,0 2.99,-1.34 2.99,-3L15,5c0,-1.66 -1.34,-3 -3,-3S9,3.34 9,5v6c0,1.66 1.34,3 3,3zM17.3,11c0,3 -2.54,5.1 -5.3,5.1S6.7,14 6.7,11L5,11c0,3.41 2.72,6.23 6,6.72L11,21h2v-3.28c3.28,-0.48 6,-3.3 6,-6.72h-1.7z",
  aa_lib_music:
    "M12,3v10.55c-0.59,-0.34 -1.27,-0.55 -2,-0.55 -2.21,0 -4,1.79 -4,4s1.79,4 4,4 4,-1.79 4,-4V7h4V3h-6z",
  aa_lib_power:
    "M13,3h-2v10h2V3zM17.83,5.17l-1.42,1.42C17.99,7.86 19,9.81 19,12c0,3.87 -3.13,7 -7,7s-7,-3.13 -7,-7c0,-2.19 1.01,-4.14 2.58,-5.42L6.17,5.17C4.23,6.82 3,9.26 3,12c0,4.97 4.03,9 9,9s9,-4.03 9,-9c0,-2.74 -1.23,-5.18 -3.17,-6.83z",
  aa_lib_radio:
    "M3.24,6.15C2.51,6.43 2,7.17 2,8v12c0,1.1 0.89,2 2,2h16c1.11,0 2,-0.9 2,-2V8c0,-1.11 -0.89,-2 -2,-2H8.3l8.26,-3.34L15.88,1 3.24,6.15zM7,20c-1.66,0 -3,-1.34 -3,-3s1.34,-3 3,-3 3,1.34 3,3 -1.34,3 -3,3zM20,12h-2v-2h-2v2H4V8h16v4z",
  aa_lib_rocket:
    "M9.19,6.35c-2.04,2.29 -3.44,5.58 -3.57,5.89L2,10.69l4.05,-4.05c0.47,-0.47 1.15,-0.68 1.81,-0.55l1.33,0.26zM11.17,17c0,0 3.74,-1.55 5.89,-3.7 5.4,-5.4 4.5,-9.62 4.21,-10.57 -0.95,-0.3 -5.17,-1.19 -10.57,4.21C8.55,9.09 7,12.83 7,12.83L11.17,17zM17.65,14.81c-2.29,2.04 -5.58,3.44 -5.89,3.57L13.31,22l4.05,-4.05c0.47,-0.47 0.68,-1.15 0.55,-1.81l-0.26,-1.33zM9,18c0,0.83 -0.34,1.58 -0.88,2.12C6.94,21.3 2,22 2,22s0.7,-4.94 1.88,-6.12C4.42,15.34 5.17,15 6,15c1.66,0 3,1.34 3,3zM13,9c0,-1.1 0.9,-2 2,-2s2,0.9 2,2 -0.9,2 -2,2 -2,-0.9 -2,-2z",
  aa_lib_rss:
    "M6.18,17.82m-2.18,0a2.18,2.18 0,1 1,4.36 0a2.18,2.18 0,1 1,-4.36 0M4,4.44v2.83c7.03,0 12.73,5.7 12.73,12.73h2.83c0,-8.59 -6.97,-15.56 -15.56,-15.56zM4,10.1v2.83c3.9,0 7.07,3.17 7.07,7.07h2.83c0,-5.47 -4.43,-9.9 -9.9,-9.9z",
  aa_lib_star:
    "M12,17.27L18.18,21l-1.64,-7.03L22,9.24l-7.19,-0.61L12,2 9.19,8.63 2,9.24l5.46,4.73L5.82,21z",
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
