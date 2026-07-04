import React, { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, Pressable, Linking, ActivityIndicator, Platform } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as FileSystem from "expo-file-system/legacy";
import { storageHelper, storage } from "../utils/storage";
import { useThemeColors } from "../theme/useThemeColors";
import { usePlaybackStore } from "../store/usePlaybackStore";
import Icon from "../components/Icon";

// Height of the collapsed mini player (mirrors PlayerBottomSheet MINIPLAYER_HEIGHT)
// so reader content can reserve space and not sit underneath it.
const MINIPLAYER_HEIGHT = 68;

// Defensive native-module imports so a build without them can't crash the app.
let Pdf: any = null;
try { Pdf = require("react-native-pdf").default; } catch (e) { Pdf = null; }
let WebView: any = null;
try { WebView = require("react-native-webview").WebView; } catch (e) { WebView = null; }
let Sharing: any = null;
try { Sharing = require("expo-sharing"); } catch (e) { Sharing = null; }

// Cap for inlining the ebook as base64 into the WebView. Most ebooks are 1–5MB;
// beyond this the bridge transfer gets heavy, so we offer "open externally".
const MAX_EBOOK_INLINE_BYTES = 12 * 1024 * 1024;

// CDN base for foliate-js — all ES module imports use absolute URLs.
const FOLIATE_CDN = "https://cdn.jsdelivr.net/npm/foliate-js@1.0.1";

// Builds the foliate-js reader HTML. The book bytes are passed in as base64
// so no CORS/auth request happens in the WebView. Themed to the app surface,
// paginated, with swipe + tap-to-turn gestures and animated page transitions;
// progress is reported back to RN via postMessage.
function ebookHtml(base64: string, bg: string, fg: string, accent: string, startCfi: string, mimeHint: string): string {
  // Compute the filename extension for foliate-js format detection
  const ext = mimeHint === "application/epub+zip" ? ".epub" : mimeHint === "application/x-mobipocket-ebook" ? ".mobi" : ".azw3";
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  html,body{margin:0;padding:0;height:100%;background:${bg};overflow:hidden;}
  foliate-view{height:100%;width:100%;}
  #msg{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;
    color:${fg};font-family:sans-serif;padding:24px;text-align:center;z-index:10;}
</style>
<style id="reader-margins">
  foliate-view::part(head) {
    height: 20px !important;
    min-height: 20px !important;
  }
  foliate-view::part(foot) {
    height: 40px !important;
    min-height: 40px !important;
  }
</style>
</head><body>
<div id="msg">Loading…</div>
<script type="module">
  import '${FOLIATE_CDN}/view.js';

  const bg = "${bg}";
  const fg = "${fg}";
  const accent = "${accent}";

  function post(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }

  // Decode base64 to a File/Blob for foliate-js
  function base64ToFile(b64, name) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: "${mimeHint}" });
  }

  async function init() {
    try {
      var file = base64ToFile("${base64}", "book${ext}");
      var view = document.createElement('foliate-view');
      view.setAttribute('margin', '20px');
      document.body.append(view);

      // Apply reading styles — theme colors and typography
      var readerCSS = \`
        @namespace epub "http://www.idpf.org/2007/ops";
        html { color-scheme: light dark; }
        body { background: \${bg} !important; color: \${fg} !important; }
        a:link, a:visited { color: \${accent}; }
        p, li, blockquote, dd {
          line-height: 1.5;
          text-align: start;
          -webkit-hyphens: auto;
          hyphens: auto;
        }
        pre { white-space: pre-wrap !important; }
      \`;
      view.addEventListener('load', e => {
        e.detail?.doc?.documentElement?.setAttribute?.('style',
          'background:' + bg + ' !important; color:' + fg + ' !important;');
      });

      // Track relocations — report progress back to React Native
      view.addEventListener('relocate', e => {
        var detail = e.detail;
        if (detail) {
          post({
            type: 'location',
            cfi: detail.cfi || '',
            fraction: detail.fraction || 0,
            section: detail.section || 0,
            tocItem: detail.tocItem ? { label: detail.tocItem.label || '' } : null,
          });
        }
      });

      await view.open(file);
      document.getElementById('msg').style.display = 'none';

      // Apply styles after opening
      view.renderer.setStyles?.(readerCSS);

      // Restore saved position
      var startCfi = ${startCfi ? `"${startCfi}"` : "null"};
      if (startCfi) {
        try { await view.goTo(startCfi); } catch(e) {}
      }

      // Expose navigation functions for RN injection and gesture handling
      window.goNext = () => { try { view.goRight(); } catch(e) {} };
      window.goPrev = () => { try { view.goLeft(); } catch(e) {} };

      // Touch gestures on the outer container — swipe and tap zones
      var sx = 0, sy = 0, st = 0;
      document.addEventListener('touchstart', function(e) {
        var t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; st = Date.now();
      }, { passive: true });
      document.addEventListener('touchend', function(e) {
        var t = e.changedTouches[0];
        var dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st;
        var w = window.innerWidth || 360;
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 300) {
          if (t.clientX < w * 0.3) window.goPrev();
          else if (t.clientX > w * 0.7) window.goNext();
        } else if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 700) {
          if (dx < 0) window.goNext(); else window.goPrev();
        }
      }, { passive: true });

      // Keyboard navigation
      document.addEventListener('keyup', function(e) {
        if (e.key === 'ArrowRight') window.goNext();
        else if (e.key === 'ArrowLeft') window.goPrev();
      });

      post({ type: 'ready' });
    } catch (e) {
      document.getElementById('msg').innerText = 'Could not open this ebook: ' + e.message;
      post({ type: 'error', message: String(e) });
    }
  }
  init();
</script>
</body></html>`;
}

// Map file extensions to MIME types for foliate-js File constructor
function getMimeForFormat(format: string): string {
  switch (format) {
    case "epub": return "application/epub+zip";
    case "mobi": return "application/x-mobipocket-ebook";
    case "azw3": case "azw": case "kf8": return "application/x-mobipocket-ebook";
    default: return "application/octet-stream";
  }
}

// Map file extensions to expected filename suffixes for foliate-js format detection
function getExtForFormat(format: string): string {
  switch (format) {
    case "epub": return ".epub";
    case "mobi": return ".mobi";
    case "azw3": case "kf8": return ".azw3";
    case "azw": return ".azw";
    default: return "." + format;
  }
}

export default function ReaderScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const { itemId, ebookFormat, title } = route.params || {};
  const [pdfError, setPdfError] = useState(false);

  // Reserve space at the bottom so the reader never sits under the mini player
  // (which floats above the system nav bar), and always clear the nav bar.
  const bottomReserve = insets.bottom + (hasSession ? MINIPLAYER_HEIGHT : 0);

  const serverConfig = storageHelper.getServerConfig();
  const serverAddress = serverConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConfig?.token || "";
  const ebookUri = itemId && serverAddress ? `${serverAddress}/api/items/${itemId}/ebook?token=${token}` : "";

  const format = String(ebookFormat || "").replace(/^\./, "").toLowerCase();
  const isPdf = format === "pdf" || (!format && !!ebookUri);
  // foliate-js supports epub, mobi, azw3, azw, kf8
  const isFoliateFormat = ["epub", "mobi", "azw3", "azw", "kf8"].includes(format);
  const isShareOnly = !isPdf && !isFoliateFormat;

  // --- Ebook state (EPUB / MOBI / AZW3) ---
  const [ebookFileUri, setEbookFileUri] = useState<string | null>(null);
  const [ebookStatus, setEbookStatus] = useState<"idle" | "loading" | "ready" | "error" | "toobig">("idle");
  const [webViewReady, setWebViewReady] = useState(false);
  const webRef = useRef<any>(null);
  const progressKey = `ebookCfi_${itemId}`;

  const bg = colors.surface;
  const fg = colors.onSurface;
  const accent = colors.primary;

  useEffect(() => {
    if (!isFoliateFormat || !WebView || !ebookUri) return;
    // Reset synchronously so a previous book's rendered doc can't linger while
    // (or after, on failure) the new one loads.
    setEbookFileUri(null);
    setWebViewReady(false);
    setEbookStatus("loading");
    let cancelled = false;
    (async () => {
      try {
        const ext = getExtForFormat(format);
        const localPath = `${FileSystem.cacheDirectory}reader_${itemId}${ext}`;
        const dl = await FileSystem.downloadAsync(ebookUri, localPath, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const info = await FileSystem.getInfoAsync(dl.uri);
        if ((info as any).size && (info as any).size > MAX_EBOOK_INLINE_BYTES) {
          FileSystem.deleteAsync(dl.uri, { idempotent: true }).catch(() => {});
          if (!cancelled) setEbookStatus("toobig");
          return;
        }
        const base64 = await FileSystem.readAsStringAsync(dl.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        // The bytes are inlined into the WebView now — drop the cache file so
        // the cache dir doesn't grow by one book per read.
        FileSystem.deleteAsync(dl.uri, { idempotent: true }).catch(() => {});
        if (cancelled) return;
        const savedCfi = storage.getString(progressKey) || "";
        const mime = getMimeForFormat(format);
        const htmlContent = ebookHtml(base64, bg, fg, accent, savedCfi, mime);
        // Write to a temp HTML file so the WebView loads from a real file URI.
        // This is required because foliate-js uses ES module import() with
        // relative paths — inline HTML (loadDataWithBaseURL) doesn't resolve
        // ES module specifiers correctly on Android WebView.
        const htmlPath = `${FileSystem.cacheDirectory}reader_${itemId}.html`;
        await FileSystem.writeAsStringAsync(htmlPath, htmlContent, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        if (cancelled) return;
        setEbookFileUri(htmlPath);
        setEbookStatus("ready");
      } catch (e) {
        console.warn("[Reader] ebook load failed", e);
        if (!cancelled) setEbookStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [isFoliateFormat, ebookUri]);

  // Inject exact margins to clear bottom miniplayer and safe area beautifully inside the WebView
  useEffect(() => {
    if (ebookStatus === "ready" && webViewReady && webRef.current) {
      const injectJS = `
        var style = document.getElementById('reader-margins');
        if (style) {
          style.innerHTML = 'foliate-view::part(head) { height: 20px !important; min-height: 20px !important; }' +
            'foliate-view::part(foot) { height: ${bottomReserve + 20}px !important; min-height: ${bottomReserve + 20}px !important; }';
        }
        true;
      `;
      webRef.current.injectJavaScript(injectJS);
    }
  }, [bottomReserve, ebookStatus, webViewReady]);

  const onWebMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "location" && data.cfi) {
        storage.set(progressKey, data.cfi);
      } else if (data.type === "ready") {
        setWebViewReady(true);
      } else if (data.type === "error") {
        setEbookStatus("error");
      }
    } catch {}
  }, [progressKey]);

  const openExternally = async () => {
    try {
      // Download then hand off to a system app that can read this format.
      if (Sharing && (await Sharing.isAvailableAsync())) {
        const localPath = `${FileSystem.cacheDirectory}book_${itemId}.${format || "bin"}`;
        const dl = await FileSystem.downloadAsync(ebookUri, localPath, {
          headers: { Authorization: `Bearer ${token}` },
        });
        await Sharing.shareAsync(dl.uri, { dialogTitle: title || "Open ebook" });
        return;
      }
    } catch (e) {
      console.warn("[Reader] share failed", e);
    }
    if (ebookUri) Linking.openURL(ebookUri).catch(() => {});
  };

  const canRenderPdf = Pdf !== null && isPdf && !pdfError && !!ebookUri;
  const canRenderEbook = WebView !== null && isFoliateFormat && ebookStatus === "ready" && !!ebookFileUri;

  const formatLabel = format ? format.toUpperCase() : "ebook";

  const Header = (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 }}>
      <Pressable
        onPress={() => navigation.goBack()}
        style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
        hitSlop={8}
      >
        <Icon name="back" size={24} color={colors.onSurface} />
      </Pressable>
      <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700", marginLeft: 4, flex: 1 }}>
        {title || "Reader"}
      </Text>
      {isFoliateFormat && canRenderEbook ? (
        <View style={{ flexDirection: "row" }}>
          <Pressable
            onPress={() => webRef.current?.injectJavaScript("window.goPrev&&window.goPrev();true;")}
            style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
          >
            <Icon name="chevron-left" size={26} color={colors.onSurface} />
          </Pressable>
          <Pressable
            onPress={() => webRef.current?.injectJavaScript("window.goNext&&window.goNext();true;")}
            style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
          >
            <Icon name="chevron-right" size={26} color={colors.onSurface} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  const Fallback = ({ message, showShare = true }: { message: string; showShare?: boolean }) => (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }}>
      <View
        style={{
          width: 72, height: 72, borderRadius: 36, backgroundColor: colors.secondaryContainer,
          alignItems: "center", justifyContent: "center", marginBottom: 16,
        }}
      >
        <Icon name="book" size={36} color={colors.onSecondaryContainer} />
      </View>
      <Text style={{ color: colors.onSurface, fontSize: 15, textAlign: "center", marginBottom: 20 }}>
        {message}
      </Text>
      {showShare ? (
        <Pressable
          onPress={openExternally}
          style={{
            backgroundColor: colors.primary, paddingHorizontal: 24, height: 48, borderRadius: 24,
            alignItems: "center", justifyContent: "center", flexDirection: "row",
          }}
        >
          <Icon name="share" size={20} color={colors.onPrimary} />
          <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600", marginLeft: 8 }}>
            Open in another app
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  let body: React.ReactNode;
  if (canRenderPdf) {
    body = (
      <Pdf
        source={{ uri: ebookUri, headers: { Authorization: `Bearer ${token}` } }}
        style={{ flex: 1, backgroundColor: colors.surface }}
        onError={() => setPdfError(true)}
      />
    );
  } else if (isFoliateFormat) {
    if (ebookStatus === "loading" || ebookStatus === "idle") {
      body = (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ color: colors.onSurfaceVariant, marginTop: 12 }}>Preparing your book…</Text>
        </View>
      );
    } else if (canRenderEbook) {
      body = (
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          source={{ uri: ebookFileUri as string }}
          style={{ flex: 1, backgroundColor: colors.surface }}
          onMessage={onWebMessage}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          allowUniversalAccessFromFileURLs
          mixedContentMode="always"
        />
      );
    } else if (ebookStatus === "toobig") {
      body = <Fallback message="This ebook is large — open it in a dedicated reader app for the best experience." />;
    } else {
      body = <Fallback message={`Couldn't open this ${formatLabel} in-app.`} />;
    }
  } else if (isShareOnly) {
    body = (
      <Fallback
        message={`${format ? format.toUpperCase() + " ebooks" : "This format"} can't be displayed in-app. Open it in a reader app that supports it.`}
      />
    );
  } else {
    body = <Fallback message="This ebook format can't be viewed in-app yet." />;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {Header}
      <View style={{ flex: 1 }}>{body}</View>
    </SafeAreaView>
  );
}
