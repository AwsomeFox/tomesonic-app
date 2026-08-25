const { withProjectBuildGradle, withSettingsGradle } = require("@expo/config-plugins");

// Keeps the native Wear OS module (native/wear) wired into the Android build.
// The module deliberately sits OUTSIDE native/android, which
// `expo prebuild --clean` deletes and regenerates — this plugin puts the two
// build-file edits back afterwards. Both are ALSO committed in
// native/android/{settings,build}.gradle, so a build works without a prebuild;
// each edit is marker-guarded and therefore idempotent.

// settings.gradle: include the sibling module.
const SETTINGS_MARKER = "project(':wear').projectDir";
const SETTINGS_SNIPPET = `
// Native Wear OS app. It lives OUTSIDE this directory because
// \`expo prebuild --clean\` deletes and regenerates native/android; these two
// lines are committed AND re-injected by plugins/withWearApp.js, so either
// survives a prebuild.
include ':wear'
project(':wear').projectDir = new File(rootDir, '../wear')
`;

// build.gradle (root buildscript): the compose compiler plugin :wear applies.
// The version MUST track RN's kotlin pin — see the comment it injects.
const COMPOSE_COMPILER_MARKER = "compose-compiler-gradle-plugin";
const KOTLIN_CLASSPATH_LINE = /^([ \t]*)classpath\((['"])org\.jetbrains\.kotlin:kotlin-gradle-plugin\2\)[ \t]*$/m;

// Both snippets are Groovy — refuse to write them into a .kts template.
function assertGroovy(cfg, file) {
  if (cfg.modResults.language !== "groovy") {
    throw new Error(`withWearApp: ${file} is ${cfg.modResults.language}, not groovy — template changed?`);
  }
}

function withWearSettingsGradle(config) {
  return withSettingsGradle(config, (cfg) => {
    assertGroovy(cfg, "settings.gradle");
    if (cfg.modResults.contents.includes(SETTINGS_MARKER)) return cfg; // idempotent
    cfg.modResults.contents = cfg.modResults.contents.replace(/\s*$/, "\n") + SETTINGS_SNIPPET;
    return cfg;
  });
}

function withComposeCompilerClasspath(config) {
  return withProjectBuildGradle(config, (cfg) => {
    assertGroovy(cfg, "build.gradle");
    const src = cfg.modResults.contents;
    if (src.includes(COMPOSE_COMPILER_MARKER)) return cfg; // idempotent
    if (!KOTLIN_CLASSPATH_LINE.test(src)) {
      throw new Error(
        "withWearApp: no kotlin-gradle-plugin classpath line in android/build.gradle — template shape changed?"
      );
    }
    cfg.modResults.contents = src.replace(
      KOTLIN_CLASSPATH_LINE,
      (line, indent) =>
        `${line}\n` +
        `${indent}// :wear applies org.jetbrains.kotlin.plugin.compose — the version MUST\n` +
        `${indent}// track RN's kotlin pin (node_modules/react-native/gradle/libs.versions.toml).\n` +
        `${indent}classpath('org.jetbrains.kotlin:compose-compiler-gradle-plugin:2.1.20')`
    );
    return cfg;
  });
}

module.exports = (config) => withComposeCompilerClasspath(withWearSettingsGradle(config));
