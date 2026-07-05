const { withMainActivity } = require("@expo/config-plugins");

// Makes Android use ROTATION_ANIMATION_CROSSFADE for this window: on rotation
// the OS fades from a snapshot of the old orientation into the new window,
// instead of instantly revealing it. React Native needs a few frames to reflow
// after a rotation; without this the user glimpses the old layout "popping"
// at the new size before our in-app RotationCurtain can cover it. The OS
// crossfade hides exactly those frames.
const MARKER = "ROTATION_ANIMATION_CROSSFADE";
const SNIPPET = `
    // Crossfade the OS rotation reveal so RN's post-rotation reflow is hidden.
    window.attributes = window.attributes.apply {
      rotationAnimation = android.view.WindowManager.LayoutParams.ROTATION_ANIMATION_CROSSFADE
    }
`;

module.exports = (config) =>
  withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes(MARKER)) {
      const anchor = "super.onCreate(null)";
      const idx = src.indexOf(anchor);
      if (idx !== -1) {
        const insertAt = idx + anchor.length;
        src = src.slice(0, insertAt) + "\n" + SNIPPET + src.slice(insertAt);
        cfg.modResults.contents = src;
      }
    }
    return cfg;
  });
