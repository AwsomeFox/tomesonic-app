/**
 * Drift guard: the withPlayerWidget config plugin regenerates the mini-player
 * widget's native files (provider + layout + manifest receiver) on every
 * prebuild from inline templates. If those templates drift from the committed
 * android/ files, the next prebuild silently reverts hand edits — so this test
 * pins the load-bearing lines in BOTH the plugin and the committed provider.
 *
 * (Lives at the __tests__ root, not __tests__/plugins, because jest.config.js
 * ignores any test path containing "/plugins/".)
 */
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const PLUGIN = join(ROOT, "plugins", "withPlayerWidget.js");
const PROVIDER = join(
  ROOT,
  "android/app/src/main/java/com/tomesonic/app/widget/MiniPlayerWidgetProvider.kt"
);
const LAYOUT = join(ROOT, "android/app/src/main/res/layout/mini_player_widget.xml");
const MANIFEST = join(ROOT, "android/app/src/main/AndroidManifest.xml");

const norm = (s: string) => s.replace(/\s+/g, " ");

// Load-bearing lines the widget's behavior depends on.
const READS_STATE_FILE = `File(context.filesDir, "widget_state.json")`;
const TMP_FALLBACK = `if (!f.exists()) f = File(context.filesDir, "widget_state.json.tmp")`;
const MEDIA_BUTTON = `Intent(Intent.ACTION_MEDIA_BUTTON)`;
const PLAY_PAUSE_KEY = `KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE`;
const MUSIC_SERVICE = `com.doublesymmetry.trackplayer.service.MusicService`;

describe("withPlayerWidget plugin ↔ committed mini-player provider stay in sync", () => {
  const plugin = norm(readFileSync(PLUGIN, "utf8"));
  const provider = norm(readFileSync(PROVIDER, "utf8"));
  const layout = norm(readFileSync(LAYOUT, "utf8"));

  it("both read widget_state.json with the .tmp mid-swap fallback", () => {
    for (const src of [plugin, provider]) {
      expect(src).toContain(READS_STATE_FILE);
      expect(src).toContain(TMP_FALLBACK);
    }
  });

  it("both wire the play/pause button to a MEDIA_BUTTON intent for the MusicService", () => {
    for (const src of [plugin, provider]) {
      expect(src).toContain(MEDIA_BUTTON);
      expect(src).toContain(PLAY_PAUSE_KEY);
      expect(src).toContain(MUSIC_SERVICE);
    }
  });

  it("the layout referenced by the provider is committed and has the cover/title/play-pause views", () => {
    for (const id of ["mini_root", "mini_cover", "mini_title", "mini_author", "mini_play_pause"]) {
      expect(layout).toContain(`@+id/${id}`);
      expect(provider).toContain(`R.id.${id}`);
    }
  });

  it("the committed manifest registers the provider as a widget receiver (and the plugin adds it)", () => {
    const manifest = norm(readFileSync(MANIFEST, "utf8"));
    expect(manifest).toContain(
      `com.tomesonic.app.widget.MiniPlayerWidgetProvider`
    );
    expect(manifest).toContain(`@xml/mini_player_widget_info`);
    // The plugin's manifest mutator wires the same receiver name + info resource.
    expect(plugin).toContain(`widget.MiniPlayerWidgetProvider`);
    expect(plugin).toContain(`@xml/mini_player_widget_info`);
  });
});
