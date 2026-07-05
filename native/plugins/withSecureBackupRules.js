const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// The Android Auto browse service needs the access/refresh token in a plain
// file at filesDir/auto_creds.json (native Media3 can't read the JS-side
// encrypted MMKV store). That file is fine on-device (app-private sandbox) but
// must never be swept into Android cloud auto-backup or device-to-device
// transfer, or the token would leave the device in plaintext. These rules
// exclude it from both, while leaving everything else (settings, widget state)
// backed up as normal.
//
// Two files because the attribute is version-split: fullBackupContent is used
// on Android 11 and below, dataExtractionRules on Android 12+ (API 31+).

const CREDS_FILE = "auto_creds.json";

const BACKUP_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <exclude domain="file" path="${CREDS_FILE}"/>
</full-backup-content>
`;

const DATA_EXTRACTION_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="file" path="${CREDS_FILE}"/>
    </cloud-backup>
    <device-transfer>
        <exclude domain="file" path="${CREDS_FILE}"/>
    </device-transfer>
</data-extraction-rules>
`;

function withBackupRuleFiles(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const xmlDir = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, "backup_rules.xml"), BACKUP_RULES_XML);
      fs.writeFileSync(path.join(xmlDir, "data_extraction_rules.xml"), DATA_EXTRACTION_RULES_XML);
      return cfg;
    },
  ]);
}

function withBackupManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (!app) return cfg;
    app.$["android:fullBackupContent"] = "@xml/backup_rules";
    app.$["android:dataExtractionRules"] = "@xml/data_extraction_rules";
    return cfg;
  });
}

module.exports = function withSecureBackupRules(config) {
  config = withBackupRuleFiles(config);
  config = withBackupManifest(config);
  return config;
};
