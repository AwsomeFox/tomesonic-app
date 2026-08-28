const { withSettingsGradle } = require("@expo/config-plugins");

// Keeps the native Android Automotive OS module (native/automotive) wired into
// the Android build. The module deliberately sits OUTSIDE native/android, which
// `expo prebuild --clean` deletes and regenerates — this plugin puts the edit
// back afterwards. It is ALSO committed in native/android/settings.gradle, so a
// build works without a prebuild; the edit is marker-guarded and therefore
// idempotent.
//
// Unlike withWearApp there is no root-buildscript half: :automotive applies no
// Compose compiler plugin (the car's Media Center draws the UI), so
// settings.gradle is the only file it needs to touch.

// settings.gradle: include the sibling module.
const SETTINGS_MARKER = "project(':automotive').projectDir";
const SETTINGS_SNIPPET = `
// Native Android Automotive OS app — lives outside this regenerated directory;
// committed AND re-injected by plugins/withAutomotiveApp.js.
include ':automotive'
project(':automotive').projectDir = new File(rootDir, '../automotive')
`;

// The snippet is Groovy — refuse to write it into a .kts template.
function assertGroovy(cfg, file) {
  if (cfg.modResults.language !== "groovy") {
    throw new Error(`withAutomotiveApp: ${file} is ${cfg.modResults.language}, not groovy — template changed?`);
  }
}

function withAutomotiveSettingsGradle(config) {
  return withSettingsGradle(config, (cfg) => {
    assertGroovy(cfg, "settings.gradle");
    if (cfg.modResults.contents.includes(SETTINGS_MARKER)) return cfg; // idempotent
    cfg.modResults.contents = cfg.modResults.contents.replace(/\s*$/, "\n") + SETTINGS_SNIPPET;
    return cfg;
  });
}

module.exports = (config) => withAutomotiveSettingsGradle(config);
