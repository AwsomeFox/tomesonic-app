const { withAndroidManifest } = require("@expo/config-plugins");

// android:largeHeap="true" — headroom for very long single-file audiobooks.
// media3 parses an m4b's whole moov sample table into Java arrays whose size
// scales with runtime (~4.4M samples for a 28.5h book: a single ~34MB long[]
// per parse). The field OOM this defends against: hours into a long book the
// default 256MB heap creeps toward its cap and the next boundary's table
// allocation throws OutOfMemoryError ("Source error", playback dead at a
// chapter end). The chapter-queue duration cap in usePlaybackStore removes
// the per-chapter re-parse storm for such books; largeHeap covers the rest —
// one full-file table plus the RN runtime, bitmap caches and everything else
// an hours-long background session accretes.
module.exports = function withLargeHeap(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (app) {
      app.$["android:largeHeap"] = "true";
    }
    return config;
  });
};
