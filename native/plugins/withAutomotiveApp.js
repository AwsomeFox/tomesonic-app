const { withSettingsGradle, withGradleProperties } = require("@expo/config-plugins");

// Keeps the native Android Automotive OS module (native/automotive) wired into
// the Android build. The module deliberately sits OUTSIDE native/android, which
// `expo prebuild --clean` deletes and regenerates — this plugin puts the edit
// back afterwards. It is ALSO committed in native/android/settings.gradle, so a
// build works without a prebuild; the edit is marker-guarded and therefore
// idempotent.
//
// Unlike withWearApp there is no root-buildscript half: :automotive applies no
// Compose compiler plugin (the car's Media Center draws the UI). Two files get
// touched: settings.gradle (the include) and gradle.properties (the daemon
// heap — see JVM_ARGS below).

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

// gradle.properties: the daemon heap. The template regenerates 2048m, which
// D8 OOMed the first time the unscoped release jobs merged the THIRD module's
// dex alongside the phone's (`:automotive:mergeDexRelease`, e2e-build). The
// value is committed in android/gradle.properties AND re-asserted here so a
// `--clean` prebuild can't quietly bring the OOM back.
const JVM_ARGS = {
  type: "property",
  key: "org.gradle.jvmargs",
  value: "-Xmx4096m -XX:MaxMetaspaceSize=512m",
};

function withAutomotiveGradleProperties(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === "property" && item.key === JVM_ARGS.key)
    );
    cfg.modResults.push(JVM_ARGS);
    return cfg;
  });
}

module.exports = (config) =>
  withAutomotiveGradleProperties(withAutomotiveSettingsGradle(config));
