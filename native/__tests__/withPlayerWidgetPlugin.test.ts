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
    expect(plugin).toContain(`MiniPlayerWidgetProvider`);
    expect(plugin).toContain(`@xml/mini_player_widget_info`);
  });
});

describe("withPlayerWidget plugin ↔ committed FULL-player provider stay in sync", () => {
  const FULL_PROVIDER = join(
    ROOT,
    "android/app/src/main/java/com/tomesonic/app/widget/FullPlayerWidgetProvider.kt"
  );
  const FULL_LAYOUT = join(ROOT, "android/app/src/main/res/layout/full_player_widget.xml");
  const plugin = norm(readFileSync(PLUGIN, "utf8"));
  const provider = norm(readFileSync(FULL_PROVIDER, "utf8"));
  const layout = norm(readFileSync(FULL_LAYOUT, "utf8"));

  it("reads widget_state.json with the .tmp fallback and renders a progress bar from position/duration", () => {
    for (const src of [plugin, provider]) {
      expect(src).toContain(READS_STATE_FILE);
      expect(src).toContain(TMP_FALLBACK);
      expect(src).toContain(`setProgressBar(R.id.full_progress`);
    }
  });

  it("wires play/pause + jumps via MEDIA_BUTTON and chapter prev/next via WIDGET_CHAPTER_* service actions", () => {
    // The plugin template uses ${PACKAGE}.WIDGET_CHAPTER_*, the committed
    // provider the resolved com.tomesonic.app.WIDGET_CHAPTER_* — check the
    // package-independent suffix so both match.
    for (const src of [plugin, provider]) {
      expect(src).toContain(MEDIA_BUTTON);
      expect(src).toContain(`KeyEvent.KEYCODE_MEDIA_REWIND`);
      expect(src).toContain(`KeyEvent.KEYCODE_MEDIA_FAST_FORWARD`);
      expect(src).toContain(`WIDGET_CHAPTER_PREV`);
      expect(src).toContain(`WIDGET_CHAPTER_NEXT`);
    }
  });

  it("the committed full-player layout has every transport view the provider references", () => {
    for (const id of [
      "full_open",
      "full_cover",
      "full_title",
      "full_author",
      "full_progress",
      "full_chapter_prev",
      "full_jump_back",
      "full_play_pause",
      "full_jump_fwd",
      "full_chapter_next",
    ]) {
      expect(layout).toContain(`@+id/${id}`);
      expect(provider).toContain(`R.id.${id}`);
    }
  });

  it("the committed manifest + plugin register the full-player receiver", () => {
    const manifest = norm(readFileSync(MANIFEST, "utf8"));
    expect(manifest).toContain(`com.tomesonic.app.widget.FullPlayerWidgetProvider`);
    expect(manifest).toContain(`@xml/full_player_widget_info`);
    expect(plugin).toContain(`FullPlayerWidgetProvider`);
    expect(plugin).toContain(`@xml/full_player_widget_info`);
  });

  it("both widgets show a real preview, rounded covers, and the app accent progress", () => {
    const ROOT2 = join(__dirname, "..");
    const miniInfo = norm(readFileSync(join(ROOT2, "android/app/src/main/res/xml/mini_player_widget_info.xml"), "utf8"));
    const fullInfo = norm(readFileSync(join(ROOT2, "android/app/src/main/res/xml/full_player_widget_info.xml"), "utf8"));
    const fullLayout = norm(readFileSync(join(ROOT2, "android/app/src/main/res/layout/full_player_widget.xml"), "utf8"));
    // Pin the styling in BOTH the committed resources and the plugin template
    // (the source of truth on prebuild), so a template regression is caught
    // without running prebuild.
    expect(miniInfo).toContain(`android:previewLayout="@layout/mini_player_widget"`);
    expect(fullInfo).toContain(`android:previewLayout="@layout/full_player_widget"`);
    expect(plugin).toContain(`android:previewLayout="@layout/mini_player_widget"`);
    expect(plugin).toContain(`android:previewLayout="@layout/full_player_widget"`);
    // Rounded covers (API 31+) — in the plugin templates AND the committed
    // providers that actually ship (they can drift until the next prebuild).
    const miniProvider = norm(readFileSync(PROVIDER, "utf8"));
    const fullProvider = norm(
      readFileSync(join(ROOT2, "android/app/src/main/java/com/tomesonic/app/widget/FullPlayerWidgetProvider.kt"), "utf8")
    );
    expect(plugin).toContain(`setViewOutlinePreferredRadius(R.id.mini_cover`);
    expect(plugin).toContain(`setViewOutlinePreferredRadius(R.id.full_cover`);
    expect(miniProvider).toContain(`setViewOutlinePreferredRadius(R.id.mini_cover`);
    expect(fullProvider).toContain(`setViewOutlinePreferredRadius(R.id.full_cover`);
    // Full-player progress tinted to the app accent (primary teal) — committed + template.
    expect(fullLayout).toContain(`android:progressTint="#86D6BF"`);
    expect(plugin).toContain(`android:progressTint="#86D6BF"`);
  });

  it("the RNTP patch routes the WIDGET_CHAPTER_* actions to chapter navigation events (by applicationId-agnostic suffix)", () => {
    const patch = readFileSync(
      join(ROOT, "patches/react-native-track-player+5.0.0-alpha0.patch"),
      "utf8"
    );
    // Suffix match so the action works under any applicationIdSuffix.
    expect(patch).toContain(`endsWith(".WIDGET_CHAPTER_NEXT")`);
    expect(patch).toContain(`endsWith(".WIDGET_CHAPTER_PREV")`);
    expect(patch).toContain(`BUTTON_SKIP_NEXT`);
    expect(patch).toContain(`BUTTON_SKIP_PREVIOUS`);
  });
});
