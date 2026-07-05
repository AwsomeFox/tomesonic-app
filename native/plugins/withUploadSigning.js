const { withAppBuildGradle } = require("@expo/config-plugins");

// Wires the Play upload-key signing into app/build.gradle so `expo prebuild`
// can't regress it back to the template's debug-signed release builds (which
// Play rejects). The deploy workflow passes the key via -PMYAPP_UPLOAD_*
// properties; without them (local / e2e builds) release falls back to debug
// signing so no keystore is needed.
const RELEASE_SIGNING_CONFIG = `        release {
            // Play upload key — provided by the deploy workflow via -P props.
            // Absent props (local / e2e builds) leave this config empty and the
            // buildType below falls back to debug signing.
            if (project.hasProperty('MYAPP_UPLOAD_STORE_FILE')) {
                storeFile file(MYAPP_UPLOAD_STORE_FILE)
                storePassword MYAPP_UPLOAD_STORE_PASSWORD
                keyAlias MYAPP_UPLOAD_KEY_ALIAS
                keyPassword MYAPP_UPLOAD_KEY_PASSWORD
            }
        }
`;

const CONDITIONAL_ASSIGNMENT =
  "signingConfig project.hasProperty('MYAPP_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug";

module.exports = function withUploadSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let s = cfg.modResults.contents;

    // Already applied (idempotent — also true for the committed android/ tree).
    if (s.includes("MYAPP_UPLOAD_STORE_FILE")) return cfg;

    // 1. Insert the release signing config right after `signingConfigs {`.
    s = s.replace(/signingConfigs\s*\{\n/, (m) => m + RELEASE_SIGNING_CONFIG);

    // 2. Swap the RELEASE buildType's `signingConfig signingConfigs.debug`
    //    for the conditional assignment (anchored inside the release block so
    //    the debug buildType's identical line is untouched).
    s = s.replace(
      /(release\s*\{[^{}]*?)signingConfig signingConfigs\.debug/,
      (_m, prefix) => prefix + CONDITIONAL_ASSIGNMENT
    );

    if (!s.includes("MYAPP_UPLOAD_STORE_FILE")) {
      throw new Error(
        "withUploadSigning: failed to inject release signing into app/build.gradle — template shape changed?"
      );
    }

    cfg.modResults.contents = s;
    return cfg;
  });
};
