import React, { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, Pressable, Linking, ActivityIndicator } from "react-native";
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

// Cap for inlining the epub as base64 into the WebView. Most epubs are 1–5MB;
// beyond this the bridge transfer gets heavy, so we offer "open externally".
const MAX_EPUB_INLINE_BYTES = 12 * 1024 * 1024;

// Builds the epub.js reader HTML. epub.js + jszip are loaded from a CDN; the
// book bytes are passed in as base64 so no CORS/auth request happens in the
// WebView. Themed to the app surface, paginated, with swipe + tap-to-turn
// gestures and an animated page transition; progress is reported back to RN via
// postMessage. Colors are the palette's `rgb(...)` strings, valid CSS as-is.
function epubHtml(base64: string, bg: string, fg: string, accent: string, startCfi: string): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  html,body{margin:0;padding:0;height:100%;background:${bg};overflow:hidden;}
  #viewer{height:100vh;width:100vw;will-change:transform,opacity;}
  #msg{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;
    color:${fg};font-family:sans-serif;padding:24px;text-align:center;}
</style>
<script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js"></script>
</head><body>
<div id="msg">Loading…</div>
<div id="viewer"></div>
<script>
  function post(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  try {
    var book = ePub("${base64}", { encoding: "base64" });
    var rendition = book.renderTo("viewer", { width:"100%", height:"100%", flow:"paginated", spread:"none" });
    rendition.themes.default({
      body:{ background:"${bg}", color:"${fg}", "padding":"0 8px" },
      a:{ color:"${accent}" }
    });
    var viewer = document.getElementById("viewer");
    var turning = false;

    // Animated page turn: slide+fade the current page out in the travel
    // direction, swap content, then slide the new page in from the far side.
    function turn(dir, fn){
      if (turning) return;
      turning = true;
      var W = window.innerWidth || 360;
      var out = Math.round(W * 0.28) * (dir > 0 ? -1 : 1);
      viewer.style.transition = "transform 140ms ease-in, opacity 140ms ease-in";
      viewer.style.transform = "translateX(" + out + "px)";
      viewer.style.opacity = "0";
      setTimeout(function(){
        Promise.resolve(fn()).then(function(){
          viewer.style.transition = "none";
          viewer.style.transform = "translateX(" + (-out) + "px)";
          void viewer.offsetHeight; // reflow
          viewer.style.transition = "transform 160ms ease-out, opacity 160ms ease-out";
          viewer.style.transform = "translateX(0)";
          viewer.style.opacity = "1";
          setTimeout(function(){ turning = false; }, 170);
        }).catch(function(){ turning = false; });
      }, 145);
    }
    window.goNext = function(){ turn(1, function(){ return rendition.next(); }); };
    window.goPrev = function(){ turn(-1, function(){ return rendition.prev(); }); };

    var startCfi = ${startCfi ? `"${startCfi}"` : "undefined"};
    rendition.display(startCfi).then(function(){ document.getElementById("msg").style.display="none"; })
      .catch(function(e){ post({type:"error", message:String(e)}); });
    book.ready.then(function(){ return book.locations.generate(1600); }).then(function(){
      rendition.on("relocated", function(loc){
        post({ type:"location", cfi: loc.start.cfi, percentage: (loc.start.percentage||0) });
      });
    });

    // Gestures live INSIDE each rendered chapter iframe (that's what fills the
    // screen), registered via epub.js's content hook: swipe left/right to turn,
    // and tap the left/right third to turn (middle third ignored).
    rendition.hooks.content.register(function(contents){
      var doc = contents.document, sx=0, sy=0, st=0;
      doc.addEventListener("touchstart", function(e){
        var t = e.changedTouches[0]; sx=t.clientX; sy=t.clientY; st=Date.now();
      }, {passive:true});
      doc.addEventListener("touchend", function(e){
        var t = e.changedTouches[0];
        var dx = t.clientX-sx, dy = t.clientY-sy, dt = Date.now()-st;
        var w = (contents.window && contents.window.innerWidth) || 360;
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 300) {
          if (t.clientX < w*0.3) window.goPrev();
          else if (t.clientX > w*0.7) window.goNext();
        } else if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)*1.2 && dt < 700) {
          if (dx < 0) window.goNext(); else window.goPrev();
        }
      }, {passive:true});
    });
    // Also allow keyboard/RN-injected arrow turns.
    document.addEventListener("keyup", function(e){
      if (e.key === "ArrowRight") window.goNext();
      else if (e.key === "ArrowLeft") window.goPrev();
    });
  } catch (e) {
    document.getElementById("msg").innerText = "Could not open this ebook.";
    post({ type:"error", message:String(e) });
  }
</script>
</body></html>`;
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
  const isEpub = format === "epub";
  const isShareOnly = !isPdf && !isEpub; // mobi / azw3 / others

  // --- EPUB state ---
  const [epubHtmlDoc, setEpubHtmlDoc] = useState<string | null>(null);
  const [epubStatus, setEpubStatus] = useState<"idle" | "loading" | "ready" | "error" | "toobig">("idle");
  const webRef = useRef<any>(null);
  const progressKey = `ebookCfi_${itemId}`;

  const bg = colors.surface;
  const fg = colors.onSurface;
  const accent = colors.primary;

  useEffect(() => {
    if (!isEpub || !WebView || !ebookUri) return;
    // Reset synchronously so a previous book's rendered doc can't linger while
    // (or after, on failure) the new one loads.
    setEpubHtmlDoc(null);
    setEpubStatus("loading");
    let cancelled = false;
    (async () => {
      try {
        const localPath = `${FileSystem.cacheDirectory}reader_${itemId}.epub`;
        const dl = await FileSystem.downloadAsync(ebookUri, localPath, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const info = await FileSystem.getInfoAsync(dl.uri);
        if ((info as any).size && (info as any).size > MAX_EPUB_INLINE_BYTES) {
          FileSystem.deleteAsync(dl.uri, { idempotent: true }).catch(() => {});
          if (!cancelled) setEpubStatus("toobig");
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
        setEpubHtmlDoc(epubHtml(base64, bg, fg, accent, savedCfi));
        setEpubStatus("ready");
      } catch (e) {
        console.warn("[Reader] epub load failed", e);
        if (!cancelled) setEpubStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [isEpub, ebookUri]);

  const onWebMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "location" && data.cfi) {
        storage.set(progressKey, data.cfi);
      } else if (data.type === "error") {
        setEpubStatus("error");
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
  const canRenderEpub = WebView !== null && isEpub && epubStatus === "ready" && !!epubHtmlDoc;

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
      {isEpub && canRenderEpub ? (
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
  } else if (isEpub) {
    if (epubStatus === "loading" || epubStatus === "idle") {
      body = (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ color: colors.onSurfaceVariant, marginTop: 12 }}>Preparing your book…</Text>
        </View>
      );
    } else if (canRenderEpub) {
      body = (
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          source={{ html: epubHtmlDoc as string }}
          style={{ flex: 1, backgroundColor: colors.surface }}
          onMessage={onWebMessage}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          mixedContentMode="always"
        />
      );
    } else if (epubStatus === "toobig") {
      body = <Fallback message="This ebook is large — open it in a dedicated reader app for the best experience." />;
    } else {
      body = <Fallback message="Couldn't open this EPUB in-app." />;
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
      {/* Keep the page above the mini player + system nav bar. */}
      {bottomReserve > 0 ? (
        <View style={{ height: bottomReserve, backgroundColor: colors.surface }} />
      ) : null}
    </SafeAreaView>
  );
}
