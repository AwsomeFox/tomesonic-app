import React, { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, Linking, ActivityIndicator, FlatList, Animated, TextInput, Share, ScrollView, useWindowDimensions } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { storageHelper, storage } from "../utils/storage";
import { useThemeColors } from "../theme/useThemeColors";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { showAppDialog } from "../store/useDialogStore";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { api } from "../utils/api";
import { queueEbookProgressPatch, reconcileLinkedProgress } from "../utils/progressSync";
import { useUserStore } from "../store/useUserStore";
import { useDownloadStore } from "../store/useDownloadStore";
import { FOLIATE_BUNDLE } from "../utils/foliateBundle";
import BottomSheet from "../components/BottomSheet";
import Pressable from "../components/HintPressable";
import { resolveAudioTarget, audioPositionForReadingFraction, approximateClock } from "../utils/formatSwitch";

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
// TTS is optional: expo-speech is NOT a project dependency, so the read-aloud
// control degrades to a "not available" state rather than adding a native dep.
// TTS via expo-speech (a project dependency). Kept behind a defensive require so
// a stripped/misconfigured build degrades to a "read-aloud unavailable" state
// instead of crashing the reader.
let Speech: any = null;
try { Speech = require("expo-speech"); } catch (e) { Speech = null; }

// Cap for inlining the ebook as base64 into the WebView. Most ebooks are 1–5MB;
// beyond this the bridge transfer gets heavy, so we offer "open externally".
const MAX_EBOOK_INLINE_BYTES = 12 * 1024 * 1024;

// Text-size stepper bounds (percent of the publisher's base size).
const FONT_SIZE_MIN = 80;
const FONT_SIZE_MAX = 180;

// Read-aloud (TTS) rate stepper bounds — expo-speech treats 1.0 as normal
// speed. Clamped to a sane band so a corrupted persisted value can't hand the
// native TextToSpeech an unusable rate.
const TTS_RATE_MIN = 0.5;
const TTS_RATE_MAX = 2.0;
const TTS_RATE_STEP = 0.1;

// Reader-scoped color themes. "auto" (the default) follows the app surface so
// nothing regresses when the preference is unset. Each named theme overrides
// the foliate view's background/foreground independently of the app theme.
const READER_THEMES: Record<string, { bg: string; fg: string; label: string }> = {
  light: { bg: "#ffffff", fg: "#111111", label: "Light" },
  sepia: { bg: "#f4ecd8", fg: "#5b4636", label: "Sepia" },
  dark: { bg: "#1a1a1a", fg: "#cfcfcf", label: "Dark" },
  black: { bg: "#000000", fg: "#bbbbbb", label: "Black" },
};

// Margin stepper presets (px) fed to the foliate margin attribute + head/foot.
const READER_MARGINS: { label: string; val: number }[] = [
  { label: "Narrow", val: 8 },
  { label: "Medium", val: 16 },
  { label: "Wide", val: 32 },
];

// Reading-rate clamps for the "time left" estimate. The chapter estimate is
// driven by a PAGES/min rate; a couple of fast early page-flips would otherwise
// inflate it and collapse the estimate to a few minutes forever. Clamp the
// per-page rate to a sane band so one flip can't poison the smoothed average.
const READ_RATE_MIN = 0.2; // pages/min (slow, ~5 min/page)
const READ_RATE_MAX = 8; // pages/min (fast skim)
// The BOOK estimate uses a fraction/min "book speed"; clamp it so the implied
// whole-book time (1/bookSpeed) stays within a believable band — this is what
// prevents the absurd "~2 min left in book" at 5% read.
const BOOK_MIN_MINUTES = 30;
const BOOK_MAX_MINUTES = 3000;

// Clamp a pages/min rate into the sane band. 0 (no sample yet) stays 0 so the
// estimate can be hidden until a real reading sample exists.
function clampReaderRate(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(READ_RATE_MAX, Math.max(READ_RATE_MIN, v));
}
// Clamp a fraction/min book speed so 1/bookSpeed ∈ [BOOK_MIN, BOOK_MAX] minutes.
// 0 (no sample / poisoned) stays 0. Applied on READ too, so a previously
// persisted absurd value recovers gracefully without a manual reset.
function clampBookSpeed(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(1 / BOOK_MIN_MINUTES, Math.max(1 / BOOK_MAX_MINUTES, v));
}

// Read-aloud: turn one page then re-request the section text so speech keeps
// flowing. The 400ms lets the relocate fire (updating the reported position)
// before we ask again.
const TTS_ADVANCE_JS =
  "window.goNext && window.goNext();setTimeout(function(){window.getReaderText && window.getReaderText();},400);true;";

// Android's TextToSpeech rejects input beyond ~4000 chars, so a full page must
// be split into smaller utterances. Break on sentence/word boundaries where
// possible so the speech doesn't clip mid-word.
const TTS_MAX_CHUNK = 3500;
function chunkTtsText(text: string, maxLen: number = TTS_MAX_CHUNK): string[] {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    // Prefer a sentence end, then any whitespace; fall back to a hard cut.
    let cut = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? ")
    );
    if (cut < maxLen * 0.5) cut = window.lastIndexOf(" ");
    cut = cut > 0 ? cut + 1 : maxLen;
    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut);
  }
  const tail = rest.trim();
  if (tail) chunks.push(tail);
  return chunks;
}

// foliate-js is VENDORED (utils/foliateBundle.ts, generated by
// scripts/build-foliate-bundle.mjs) and inlined into the reader HTML below, so
// the ebook reader renders fully OFFLINE — no jsdelivr CDN at read time.

// Builds the foliate-js reader HTML. The book bytes are passed in as base64
// so no CORS/auth request happens in the WebView. Themed to the app surface,
// paginated, with swipe + tap-to-turn gestures and animated page transitions;
// progress is reported back to RN via postMessage.
function ebookHtml(
  base64: string,
  bg: string,
  fg: string,
  accent: string,
  startCfi: string,
  mimeHint: string,
  fontSize: number,
  fontFamily: string,
  lineHeight: number,
  pageCurl: boolean,
  margin: number,
  flow: string
): string {
  // Compute the filename extension for foliate-js format detection
  const ext = mimeHint === "application/epub+zip" ? ".epub" : mimeHint === "application/x-mobipocket-ebook" ? ".mobi" : ".azw3";
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;padding:0;height:100%;background:${bg};overflow:hidden;}
  foliate-view{height:100%;width:100%;}
  #msg{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;
    color:${fg};font-family:sans-serif;padding:24px;text-align:center;z-index:10;}
</style>
<style id="reader-margins">
  foliate-view::part(head) {
    height: ${margin}px !important;
    min-height: ${margin}px !important;
  }
  foliate-view::part(foot) {
    height: ${margin}px !important;
    min-height: ${margin}px !important;
  }
</style>
</head><body>
<div id="msg">Loading…</div>
<script>
  // Polyfills for foliate-js on OLDER Android System WebViews. foliate-js
  // uses Object.groupBy / Map.groupBy (Chrome 117+, late 2023); many devices
  // run an older, non-auto-updating System WebView, where the reader would
  // otherwise fail with "Object.groupBy is not a function". Must run BEFORE
  // the foliate module below (classic script executes first).
  (function(){
    function groupByInto(make, get, set, items, cb){
      var res = make(), i = 0;
      for (var it of items){ var k = cb(it, i++); var a = get(res, k); if (a) a.push(it); else set(res, k, [it]); }
      return res;
    }
    if (typeof Object.groupBy !== 'function') {
      Object.groupBy = function(items, cb){
        return groupByInto(function(){return Object.create(null);},
          function(o,k){return o[k];}, function(o,k,v){o[k]=v;}, items, cb);
      };
    }
    if (typeof Map.groupBy !== 'function') {
      Map.groupBy = function(items, cb){
        return groupByInto(function(){return new Map();},
          function(m,k){return m.get(k);}, function(m,k,v){m.set(k,v);}, items, cb);
      };
    }
  })();
</script>
<script type="module">
  // Vendored foliate-js, inlined (no network). Registers the <foliate-view>
  // custom element as a side effect; inline module scripts avoid the file://
  // CORS wall that blocks external module imports in Android WebView.
${FOLIATE_BUNDLE}

  // Reader-scoped theme colors — mutable so a live theme switch (window
  // .setReaderTheme) can re-apply to already-loaded sections without a reload.
  let bg = ${JSON.stringify(bg)};
  let fg = ${JSON.stringify(fg)};
  const accent = ${JSON.stringify(accent)};

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
      while (window.innerWidth === 0 || window.innerHeight === 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      var file = base64ToFile("${base64}", "book${ext}");
      var view = document.createElement('foliate-view');
      document.body.append(view);

      // Apply reading styles — theme colors and typography. fontFamily is
      // JSON.stringify'd and the numerics coerced with Number() so a corrupted
      // persisted setting can't break out of this generated script (#10).
      var fontValue = ${JSON.stringify(fontFamily)} === "serif" ? "Georgia, serif" : "system-ui, sans-serif";
      var readerCSS = \`
        @namespace epub "http://www.idpf.org/2007/ops";
        html { color-scheme: light dark; }
        body {
          background: \${bg} !important;
          color: \${fg} !important;
          font-size: ${Number(fontSize)}% !important;
          text-align: start;
          -webkit-hyphens: auto;
          hyphens: auto;
        }
        body, p, li, blockquote, dd, div, span, a {
          font-family: \${fontValue} !important;
          line-height: ${Number(lineHeight)} !important;
        }
        pre { white-space: pre-wrap !important; }
      \`;
      view.addEventListener('load', e => {
        var d = e.detail || {};
        var doc = d.doc;
        var index = d.index;
        if (doc && doc.documentElement) {
          doc.documentElement.setAttribute('style',
            'background:' + bg + ' !important; color:' + fg + ' !important;');
        }
        // Text-selection reporting (dictionary look-up / highlight / share).
        // Runs inside the book's own document; the selected text + its CFI are
        // posted to RN, which shows the selection action sheet.
        if (doc) {
          var report = function(){
            try {
              var sel = doc.getSelection && doc.getSelection();
              if (!sel || sel.isCollapsed) return;
              var text = String(sel.toString() || '').trim();
              if (!text) return;
              var cfi = '';
              try { cfi = view.getCFI(index, sel.getRangeAt(0)); } catch(err){}
              post({ type: 'selection', text: text, cfi: cfi || '' });
            } catch(err){}
          };
          doc.addEventListener('pointerup', function(){ setTimeout(report, 10); });
          doc.addEventListener('contextmenu', function(){ setTimeout(report, 10); });
        }
      });

      // Draw highlight annotations. foliate asks us to paint a range; we build
      // an SVG group of rects ourselves so no internal Overlayer class needs to
      // be exposed by the vendored bundle. Degrades to no-op on any failure.
      view.addEventListener('draw-annotation', function(e){
        try {
          var d = e.detail || {};
          var doc = d.doc || document;
          var color = (d.annotation && d.annotation.color) || 'rgba(255,213,0,.4)';
          d.draw(function(rects){
            var NS = 'http://www.w3.org/2000/svg';
            var g = doc.createElementNS(NS, 'g');
            g.setAttribute('fill', color);
            g.style.opacity = 'var(--overlayer-highlight-opacity, .4)';
            for (var i = 0; i < rects.length; i++) {
              var rc = rects[i];
              var r = doc.createElementNS(NS, 'rect');
              r.setAttribute('x', rc.left); r.setAttribute('y', rc.top);
              r.setAttribute('width', rc.width); r.setAttribute('height', rc.height);
              g.append(r);
            }
            return g;
          }, { color: color });
        } catch(err){}
      });

      // Track relocations — report progress back to React Native. lastFraction
      // is mirrored here so getReaderText can hand RN the current reading
      // position; RN uses it to detect end-of-book (goNext() no-op → fraction
      // unchanged) and stop read-aloud instead of looping (#1).
      var lastFraction = 0;
      view.addEventListener('relocate', e => {
        var detail = e.detail;
        if (detail) {
          lastFraction = detail.fraction || 0;
          post({
            type: 'location',
            cfi: detail.cfi || '',
            fraction: detail.fraction || 0,
            section: detail.section || 0,
            page: (view.renderer.page || 0) + 1,
            pages: view.renderer.pages || 1,
            tocItem: detail.tocItem ? { label: detail.tocItem.label || '' } : null,
          });
        }
      });

      await view.open(file);
      document.getElementById('msg').style.display = 'none';

      // Send TOC back to React Native
      post({
        type: 'toc',
        toc: view.book.toc || []
      });

      // Apply styles after opening
      view.renderer.setStyles?.(readerCSS);

      // Flow mode: paginated (default) vs continuous scrolled. The renderer
      // observes the 'flow' attribute and re-lays-out on change.
      try { view.renderer.setAttribute('flow', ${JSON.stringify(flow)} === 'scrolled' ? 'scrolled' : 'paginated'); } catch(e) {}

      // Initial margin. Like 'flow', the margin is observed on view.renderer —
      // NOT on the <foliate-view> element — so it must be set here (after open,
      // when the renderer exists) to actually drive the layout.
      try { view.renderer.setAttribute('margin', ${JSON.stringify(String(margin) + "px")}); } catch(e) {}

      // Restore saved position. JSON.stringify escapes the CFI — a stored or
      // server value containing a quote/backslash/newline would otherwise
      // break (or inject into) this generated script.
      var startCfi = ${startCfi ? JSON.stringify(String(startCfi)) : "null"};
      if (startCfi) {
        try { await view.goTo(startCfi); } catch(e) {}
      } else {
        try { await view.goTo(0); } catch(e) {}
      }

      // Expose navigation functions for RN injection and gesture handling
      window.goNext = () => { try { view.goRight(); } catch(e) {} };
      window.goPrev = () => { try { view.goLeft(); } catch(e) {} };
      window.goToHref = (href) => { try { view.goTo(href); } catch(e) {} };
      // Fraction navigation for the player's "Read from here" jump (percent
      // format switching) — called from RN via injectJavaScript after 'ready'.
      window.goToFraction = (f) => { try { view.goToFraction(f); } catch(e) {} };
      window.setReaderStyles = (css) => { try { view.renderer.setStyles(css); } catch(e) {} };

      // Live reader-theme switch: update the closure bg/fg (used by future
      // section loads) and re-apply to every currently-rendered section.
      window.setReaderTheme = function(nbg, nfg){
        try {
          bg = nbg; fg = nfg;
          document.body.style.background = bg;
          document.documentElement.style.background = bg;
          var contents = view.renderer.getContents ? view.renderer.getContents() : [];
          for (var i = 0; i < contents.length; i++) {
            try {
              contents[i].doc.documentElement.setAttribute('style',
                'background:' + bg + ' !important; color:' + fg + ' !important;');
            } catch(e) {}
          }
        } catch(e) {}
      };
      // Live margin (Narrow/Medium/Wide): drives both the foliate margin
      // attribute and the head/foot part heights.
      window.setReaderMargin = function(px){
        try {
          view.renderer.setAttribute('margin', px + 'px');
          var s = document.getElementById('reader-margins');
          if (s) s.textContent =
            'foliate-view::part(head){height:' + px + 'px !important;min-height:' + px + 'px !important;}' +
            'foliate-view::part(foot){height:' + px + 'px !important;min-height:' + px + 'px !important;}';
        } catch(e) {}
      };
      // Live flow toggle (paginated vs scrolled).
      window.setReaderFlow = function(flow){
        try { view.renderer.setAttribute('flow', flow === 'scrolled' ? 'scrolled' : 'paginated'); } catch(e) {}
      };

      // ---- In-book full-text search ----
      // Runs foliate's async-generator search and streams each match back to RN
      // as a 'searchResult' message, ending with 'searchDone'. Gated in the UI
      // only when view.search exists on this bundle.
      window.readerHasSearch = typeof view.search === 'function';
      window.search = function(query){
        try {
          if (typeof view.search !== 'function') { post({ type: 'searchDone' }); return; }
          try { view.clearSearch && view.clearSearch(); } catch(e) {}
          (async function(){
            try {
              var count = 0;
              for await (var res of view.search({ query: String(query) })) {
                if (res === 'done') break;
                if (res && res.subitems) {
                  for (var j = 0; j < res.subitems.length; j++) {
                    var it = res.subitems[j];
                    post({ type: 'searchResult', cfi: it.cfi || '', excerpt: excerptText(it.excerpt), label: res.label || '' });
                    if (++count >= 200) break;
                  }
                } else if (res && res.cfi) {
                  post({ type: 'searchResult', cfi: res.cfi, excerpt: excerptText(res.excerpt), label: '' });
                  if (++count >= 200) break;
                }
                if (count >= 200) break;
              }
            } catch(e) {}
            post({ type: 'searchDone' });
          })();
        } catch(e) { post({ type: 'searchDone' }); }
      };
      function excerptText(x){
        try {
          if (!x) return '';
          if (typeof x === 'string') return x;
          return String((x.pre || '') + (x.match || '') + (x.post || '')).trim();
        } catch(e) { return ''; }
      }
      window.goToSearchResult = function(cfi){ try { view.goTo(cfi); } catch(e) {} };
      window.clearReaderSearch = function(){ try { view.clearSearch && view.clearSearch(); } catch(e) {} };

      // ---- Highlights (foliate annotations, re-applied on open) ----
      window.addHighlight = function(cfi, color){
        try { view.addAnnotation({ value: cfi, color: color || 'rgba(255,213,0,.4)' }); } catch(e) {}
      };
      window.removeHighlight = function(cfi){
        try { view.deleteAnnotation({ value: cfi }); } catch(e) {}
      };

      // ---- TTS: hand the text from the CURRENT reading position to RN. ----
      // Read-aloud must start at the page you're on, not the top of the chapter
      // (#5). foliate tracks the current visible location as view.lastLocation,
      // whose .range is a DOM Range in the current section document; we take its
      // start and read to the end of the section body. If that can't be
      // resolved we fall back to the whole-section text (prior behavior) rather
      // than breaking read-aloud.
      window.getReaderText = function(){
        try {
          var c = view.renderer.getContents ? view.renderer.getContents()[0] : null;
          var doc = c && c.doc ? c.doc : null;
          var body = doc ? doc.body : null;
          var t = '';
          if (body) {
            var loc = null;
            try { loc = view.lastLocation; } catch(e0) { loc = null; }
            var range = loc && loc.range ? loc.range : null;
            if (range && range.startContainer && doc.createRange) {
              try {
                var r = doc.createRange();
                r.selectNodeContents(body);
                // Clamp the start into the body — a range from another section
                // would throw; the catch below falls back to whole-section text.
                r.setStart(range.startContainer, range.startOffset || 0);
                t = r.toString() || '';
              } catch(e1) { t = ''; }
            }
            if (!t) t = body.innerText || body.textContent || '';
          }
          // RN chunks the text under Android's ~4000-char TextToSpeech limit
          // (#2) and uses the pos field to detect a stalled/finished book (#1).
          post({ type: 'ttsText', text: String(t || '').replace(/\\s+/g, ' ').trim().slice(0, 20000), pos: lastFraction });
        } catch(e) { post({ type: 'ttsText', text: '', pos: lastFraction }); }
      };

      // ---- Page-turn gestures: finger-follow curl + tap/swipe fallback ----
      // When the curl is enabled the page tracks your finger and peels with a
      // soft fold shadow, completing (or snapping back) on release. When it's
      // off we keep the original discrete tap-zone / swipe behavior. The curl is
      // a CSS transform on the foliate host + a gradient overlay at the fold; no
      // snapshotting, so it can't get out of sync with the rendered content.
      // The user's explicit "Page Turn: None" setting IS the motion
      // accommodation, so honor it directly. We deliberately do NOT AND-in the
      // OS reduced-motion preference: many Android WebViews report reduce-motion
      // (battery saver, "remove animations", some WebView defaults), which
      // silently disabled the curl even when the user picked "Curl" (#3).
      var curlEnabled = ${pageCurl ? "true" : "false"};
      // Let RN flip it live (settings toggle) without reloading the book.
      window.setPageCurl = function(v){ curlEnabled = !!v; };

      var W = function(){ return window.innerWidth || 360; };
      var TURN_MS = 200;
      var drag = { active:false, decided:false, dir:0, sx:0, sy:0, st:0, animating:false };

      // Fold shadow that tracks the lifting page edge.
      var curlEl = document.createElement('div');
      curlEl.id = 'pagecurl';
      curlEl.style.cssText = 'position:fixed;top:0;bottom:0;width:56px;pointer-events:none;z-index:9;opacity:0;transition:opacity .12s;';
      document.body.appendChild(curlEl);

      function setPageX(px){ view.style.transform = px ? 'translateX(' + px + 'px)' : ''; }
      function showCurl(px, progress){
        var w = W();
        var a = Math.min(0.38, 0.12 + progress * 0.32);
        if (drag.dir < 0) {
          var fold = w + px; // page moved left; fold at its right edge
          curlEl.style.left = Math.max(-56, fold - 8) + 'px';
          curlEl.style.background = 'linear-gradient(to right, rgba(0,0,0,' + a + '), rgba(0,0,0,0) 70%)';
        } else {
          curlEl.style.left = Math.min(w, px - 48) + 'px';
          curlEl.style.background = 'linear-gradient(to left, rgba(0,0,0,' + a + '), rgba(0,0,0,0) 70%)';
        }
        curlEl.style.opacity = '1';
      }
      function hideCurl(){ curlEl.style.opacity = '0'; }

      // Slide the current page fully off in the turn direction, then swap to the
      // neighbor and reset. The uncovered strip is the page-colored background,
      // reading as the blank margin of a turning leaf.
      function finishTurn(dir){
        if (drag.animating) return;
        drag.animating = true;
        var w = W();
        view.style.transition = 'transform ' + TURN_MS + 'ms ease-out';
        setPageX(dir < 0 ? -w : w);
        hideCurl();
        setTimeout(function(){
          view.style.transition = '';
          setPageX(0);
          try { if (dir < 0) window.goNext(); else window.goPrev(); } catch(e) {}
          drag.animating = false;
        }, TURN_MS);
      }
      function snapBack(){
        drag.animating = true;
        view.style.transition = 'transform 160ms ease-out';
        setPageX(0);
        hideCurl();
        setTimeout(function(){ view.style.transition = ''; drag.animating = false; }, 170);
      }
      // Discrete turn honoring the current mode (animated when the curl is on).
      function turn(dir){ if (curlEnabled) finishTurn(dir); else if (dir < 0) window.goNext(); else window.goPrev(); }

      document.addEventListener('touchstart', function(e){
        if (drag.animating) return;
        var t = e.changedTouches[0];
        drag.active = true; drag.decided = false; drag.dir = 0;
        drag.sx = t.clientX; drag.sy = t.clientY; drag.st = Date.now();
      }, { passive: true });

      document.addEventListener('touchmove', function(e){
        if (!drag.active || drag.animating || !curlEnabled) return;
        var t = e.changedTouches[0];
        var dx = t.clientX - drag.sx, dy = t.clientY - drag.sy;
        if (!drag.decided) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          // Vertical / long-press-drag (text selection) → not a page turn.
          if (Math.abs(dx) <= Math.abs(dy) * 1.2) { drag.active = false; return; }
          drag.decided = true; drag.dir = dx < 0 ? -1 : 1;
        }
        setPageX(dx);
        showCurl(dx, Math.min(1, Math.abs(dx) / W()));
        if (e.cancelable) e.preventDefault();
      }, { passive: false });

      document.addEventListener('touchend', function(e){
        var t = e.changedTouches[0];
        var dx = t.clientX - drag.sx, dy = t.clientY - drag.sy, dt = Date.now() - drag.st;
        var wasDrag = drag.decided;
        drag.active = false; drag.decided = false;
        if (drag.animating) return;
        if (wasDrag) {
          var progress = Math.abs(dx) / W();
          var fast = dt < 250 && Math.abs(dx) > 60;
          if (progress > 0.25 || fast) finishTurn(drag.dir); else snapBack();
          return;
        }
        var w = W();
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 700) {
          turn(dx < 0 ? -1 : 1);
        } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 300) {
          if (t.clientX < w * 0.3) turn(1);
          else if (t.clientX > w * 0.7) turn(-1);
        }
      }, { passive: true });

      // Keyboard navigation
      document.addEventListener('keyup', function(e) {
        if (e.key === 'ArrowRight') window.goNext();
        else if (e.key === 'ArrowLeft') window.goPrev();
      });

      post({ type: 'ready', search: !!window.readerHasSearch });
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
  // Reading is a long touch-free activity — keep the screen awake, but only
  // while the reader is actually the FOCUSED screen. useKeepAwake() held the
  // lock for as long as the reader stayed mounted, so navigating forward from
  // it (leaving it in the stack) kept the screen on off-screen, draining the
  // battery. Activate on focus, release on blur AND unmount.
  const KEEP_AWAKE_TAG = "reader";
  useEffect(() => {
    let held = false;
    const activate = () => {
      if (held) return;
      held = true;
      // Wrapped: the async activator may return void in some environments.
      Promise.resolve(activateKeepAwakeAsync(KEEP_AWAKE_TAG)).catch(() => {});
    };
    const release = () => {
      if (!held) return;
      held = false;
      try {
        deactivateKeepAwake(KEEP_AWAKE_TAG);
      } catch {}
    };
    activate(); // focused on mount
    const unsubFocus = navigation?.addListener?.("focus", activate);
    const unsubBlur = navigation?.addListener?.("blur", release);
    return () => {
      release();
      unsubFocus?.();
      unsubBlur?.();
    };
  }, [navigation]);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const { itemId, ebookFormat, title, initialFraction } = route.params || {};
  // One-shot "jump to fraction" from the player's Read-from-here handoff —
  // consumed on the WebView's 'ready' message, then cleared.
  const pendingJumpRef = useRef<number | null>(
    typeof initialFraction === "number" && Number.isFinite(initialFraction)
      ? Math.max(0, Math.min(1, initialFraction))
      : null
  );
  const [pdfError, setPdfError] = useState(false);
  // PDF page tracking: restore the last-read page and show a footer indicator,
  // mirroring what the epub path gets from foliate relocations. Controlled
  // page state so the footer prev/next buttons (a11y: PDF page turns are
  // otherwise scroll-only) can drive it and an in-place book change re-seeds it.
  const pdfPageKey = `pdfPage_${itemId}`;
  const [pdfPage, setPdfPage] = useState<number>(() => Math.max(1, storage.getNumber(pdfPageKey) || 1));
  const [pdfProgress, setPdfProgress] = useState<{ page: number; pages: number } | null>(null);
  // The last PDF position, flushed on unmount like latestProgressRef does for
  // epub — the debounced onPageChanged sync alone is cancelled by the cleanup
  // clearing syncTimeoutRef, losing a page turn made within ~2s of leaving.
  const latestPdfProgressRef = useRef<{ page: number; fraction: number } | null>(null);
  // In-place itemId changes update route params WITHOUT unmounting, so these
  // mount-seeded values must be re-seeded for the new book — the reseed lives in
  // an effect (see below, keyed on itemId) rather than during render, so the
  // previous book's flush effect can run its cleanup FIRST.
  // Bumped by the error-state Retry button to re-run the ebook load effect.
  const [reloadKey, setReloadKey] = useState(0);

  // Bottom reserve spacing matches exactly what the floating mini-player consumes.
  // When no session exists, the mini-player slides completely down (height = 0),
  // so we fall back to standard bottom safe inset for spacing.
  const bottomReserve = hasSession ? MINIPLAYER_HEIGHT + insets.bottom : insets.bottom;

  const serverConfig = storageHelper.getServerConfig();
  const serverAddress = serverConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConfig?.token || "";
  const ebookUri = itemId && serverAddress ? `${serverAddress}/api/items/${itemId}/ebook?token=${token}` : "";

  const format = String(ebookFormat || "").replace(/^\./, "").toLowerCase();
  const isPdf = format === "pdf" || (!format && !!ebookUri);
  // foliate-js supports epub, mobi, azw3, azw, kf8
  const isFoliateFormat = ["epub", "mobi", "azw3", "azw", "kf8"].includes(format);
  const isShareOnly = !isPdf && !isFoliateFormat;

  // --- Ebook settings & state (EPUB / MOBI / AZW3) ---
  const [ebookFileUri, setEbookFileUri] = useState<string | null>(null);
  const [ebookStatus, setEbookStatus] = useState<"idle" | "loading" | "ready" | "error" | "toobig">("idle");
  // Why the ebook failed (download vs foliate parse) — shown small on the
  // error screen so a failure is actionable instead of a generic "try again".
  const [ebookError, setEbookError] = useState<string>("");
  const webRef = useRef<any>(null);
  const progressKey = `ebookCfi_${itemId}`;
  const syncTimeoutRef = useRef<any>(null);
  const latestProgressRef = useRef<{ cfi: string; fraction: number } | null>(null);

  // Pulsing animation for loading state
  const pulseAnim = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    let anim: Animated.CompositeAnimation | null = null;
    if (ebookStatus === "loading" || ebookStatus === "idle") {
      anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.0,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0.6,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      anim.start();
    } else {
      pulseAnim.setValue(0.6);
    }
    return () => {
      if (anim) anim.stop();
    };
  }, [ebookStatus, pulseAnim]);

  // Style Settings States
  const [fontSize, setFontSize] = useState(() => storage.getNumber("reader_font_size") || 100);
  const [fontFamily, setFontFamily] = useState<"serif" | "sans-serif">(() => (storage.getString("reader_font_family") as any) || "serif");
  const [lineHeight, setLineHeight] = useState(() => storage.getNumber("reader_line_height") || 1.5);
  // Finger-follow page-curl turn animation. Defaults on; persisted so it's a
  // one-time choice. `getBoolean` returns undefined until first set, so treat
  // undefined as the default (true).
  const [pageCurl, setPageCurl] = useState<boolean>(() => {
    const v = storage.getBoolean("reader_page_curl");
    return v === undefined ? true : v;
  });
  // Reader-scoped color theme ("auto" follows the app surface — the prior
  // behavior — so an unset preference doesn't regress anything).
  const [readerTheme, setReaderTheme] = useState<string>(() => storage.getString("reader_theme") || "auto");
  // Page margin (px). Default 16 matches the previously hard-coded value.
  const [readerMargin, setReaderMargin] = useState<number>(() => storage.getNumber("reader_margin") || 16);
  // Flow: paginated (default) vs continuous scrolled.
  const [readerFlow, setReaderFlow] = useState<"paginated" | "scrolled">(
    () => (storage.getString("reader_flow") as any) || "paginated"
  );

  // TOC and Progress Info States
  const [toc, setToc] = useState<any[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pageProgress, setPageProgress] = useState<{
    page: number;
    pages: number;
    fraction: number;
    tocItem: { label: string } | null;
  } | null>(null);

  // In-book search sheet state.
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ cfi: string; excerpt: string; label: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchAvailable, setSearchAvailable] = useState(true);

  // Text-selection action sheet (dictionary look-up / highlight / share).
  const [selection, setSelection] = useState<{ text: string; cfi: string } | null>(null);

  // Local highlights, persisted per item + CFI in MMKV.
  type Highlight = { cfi: string; text: string; color: string; at: number };
  const highlightsKey = `reader_highlights_${itemId}`;
  const [highlights, setHighlights] = useState<Highlight[]>(() => {
    try {
      const raw = storage.getString(highlightsKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [showHighlights, setShowHighlights] = useState(false);

  // Read-aloud (TTS). expo-speech is optional (see the defensive import) — when
  // absent, the control is shown but reports "not available".
  const ttsAvailable = !!Speech;
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const ttsPlayingRef = useRef(false);
  // Read-aloud speed. Persisted per-device and clamped to [TTS_RATE_MIN,
  // TTS_RATE_MAX]; mirrored into a ref so an in-progress read-aloud picks up a
  // rate change on its NEXT chunk without restarting.
  const [ttsRate, setTtsRate] = useState<number>(() => {
    const r = storage.getNumber("reader_tts_rate");
    return r && r >= TTS_RATE_MIN && r <= TTS_RATE_MAX ? r : 1.0;
  });
  const ttsRateRef = useRef(ttsRate);
  useEffect(() => {
    ttsRateRef.current = ttsRate;
    storage.set("reader_tts_rate", ttsRate);
  }, [ttsRate]);
  // Last reading position spoken by read-aloud. Used to detect that a page turn
  // didn't actually advance (end of book / stuck section) so playback ends
  // cleanly instead of re-speaking the same text forever (#1).
  const ttsLastPosRef = useRef<number>(-1);

  // Rolling reading-rate estimate. Two smoothed, CLAMPED samples are kept per
  // item so a "~N min left" estimate survives across sessions:
  //  - readingRateRef: PAGES/min from the section page counter → chapter estimate.
  //  - bookSpeedRef:   fraction/min → book estimate (clamped to a sane whole-
  //    book time so a fast early flip can't collapse it to "~2 min", #1).
  const readingRateRef = useRef<number>(0);
  const bookSpeedRef = useRef<number>(0);
  const readingSampleRef = useRef<{ page: number; pages: number; section: number; fraction: number; t: number } | null>(null);
  // Estimate scope: "chapter" (default) shows time left in the current chapter,
  // "book" shows time left in the whole book. Only changes the footer text, so
  // it's applied live with no reload.
  const [readerEstimateScope, setReaderEstimateScope] = useState<"chapter" | "book">(
    () => ((storage.getString("reader_estimate_scope") as any) === "book" ? "book" : "chapter")
  );

  // Resolve the reader-scoped theme. "auto" (or an unknown value) falls back to
  // the app surface colors so the reader keeps its original app-themed look.
  const readerThemeColors =
    readerTheme !== "auto" && READER_THEMES[readerTheme]
      ? READER_THEMES[readerTheme]
      : { bg: colors.surface, fg: colors.onSurface };
  const bg = readerThemeColors.bg;
  const fg = readerThemeColors.fg;
  const accent = colors.primary;

  // When a named reader theme is active, the WHOLE reader screen (chrome, not
  // just the book text) adopts it — otherwise the header/footer/background kept
  // the app surface color and only the middle text rectangle was themed (#2).
  // "auto" keeps the app colors (the prior behavior). Dim/border shades are
  // derived from fg with an alpha suffix (6-digit hex + "99"/"22").
  const isThemedChrome = readerTheme !== "auto" && !!READER_THEMES[readerTheme];
  const chromeBg = isThemedChrome ? bg : colors.surface;
  const chromeFg = isThemedChrome ? fg : colors.onSurface;
  const chromeFgDim = isThemedChrome ? `${fg}99` : colors.onSurfaceVariant;
  const chromeBorder = isThemedChrome ? `${fg}22` : colors.outlineVariant;

  // Time-left estimate, DERIVED from the smoothed rate refs + active scope so it
  // updates live when the scope toggles (no relocate needed). Hidden until a
  // real sample exists (rate/bookSpeed > 0) or near the end (fraction ≥ 0.99).
  const readingEstimate: number | null = (() => {
    if (!pageProgress) return null;
    const page = Math.max(1, pageProgress.page || 1);
    const pages = Math.max(1, pageProgress.pages || 1);
    const frac = pageProgress.fraction || 0;
    if (readerEstimateScope === "book") {
      const bookSpeed = clampBookSpeed(bookSpeedRef.current);
      if (bookSpeed <= 0) return null;
      const m = Math.ceil(Math.max(0, 1 - frac) / bookSpeed);
      return Number.isFinite(m) ? m : null;
    }
    const rate = readingRateRef.current;
    if (rate <= 0) return null;
    const m = Math.ceil(Math.max(0, pages - page) / rate);
    return Number.isFinite(m) ? m : null;
  })();

  const { height: windowHeight } = useWindowDimensions();

  // Dynamically push styles to the reader WebView when text settings change
  useEffect(() => {
    storage.set("reader_font_size", fontSize);
    storage.set("reader_font_family", fontFamily);
    storage.set("reader_line_height", lineHeight);

    if (ebookStatus === "ready" && webRef.current) {
      const fontValue = fontFamily === "serif" ? "Georgia, serif" : "system-ui, sans-serif";
      const css = `
        @namespace epub "http://www.idpf.org/2007/ops";
        html { color-scheme: light dark; }
        body {
          background: ${bg} !important;
          color: ${fg} !important;
          font-size: ${Number(fontSize)}% !important;
          text-align: start;
          -webkit-hyphens: auto;
          hyphens: auto;
        }
        body, p, li, blockquote, dd, div, span, a {
          font-family: ${fontValue} !important;
          line-height: ${Number(lineHeight)} !important;
        }
        pre { white-space: pre-wrap !important; }
      `;
      // Clean script to inject
      const cleanCSS = css.replace(/`/g, "\\`").replace(/\n/g, "");
      webRef.current.injectJavaScript(`window.setReaderStyles && window.setReaderStyles(\`${cleanCSS}\`);true;`);
    }
  }, [fontSize, fontFamily, lineHeight, ebookStatus, bg, fg, accent]);

  // Persist the page-curl preference and flip it live in the WebView (no reload).
  useEffect(() => {
    storage.set("reader_page_curl", pageCurl);
    if (ebookStatus === "ready" && webRef.current) {
      webRef.current.injectJavaScript(
        `window.setPageCurl && window.setPageCurl(${pageCurl ? "true" : "false"});true;`
      );
    }
  }, [pageCurl, ebookStatus]);

  // Persist the reader theme and push it live (updates the closure bg/fg used
  // by future section loads + re-applies to already-rendered sections).
  useEffect(() => {
    storage.set("reader_theme", readerTheme);
    if (ebookStatus === "ready" && webRef.current) {
      webRef.current.injectJavaScript(
        `window.setReaderTheme && window.setReaderTheme(${JSON.stringify(bg)}, ${JSON.stringify(fg)});true;`
      );
    }
  }, [readerTheme, bg, fg, ebookStatus]);

  // Persist the margin and push it live (no reload).
  useEffect(() => {
    storage.set("reader_margin", readerMargin);
    if (ebookStatus === "ready" && webRef.current) {
      webRef.current.injectJavaScript(
        `window.setReaderMargin && window.setReaderMargin(${Number(readerMargin)});true;`
      );
    }
  }, [readerMargin, ebookStatus]);

  // Persist the flow mode and push it live (paginated <-> scrolled).
  useEffect(() => {
    storage.set("reader_flow", readerFlow);
    if (ebookStatus === "ready" && webRef.current) {
      webRef.current.injectJavaScript(
        `window.setReaderFlow && window.setReaderFlow(${JSON.stringify(readerFlow)});true;`
      );
    }
  }, [readerFlow, ebookStatus]);

  // Persist the time-left scope. No WebView injection needed — it only changes
  // the footer text, which re-derives from state on the next render.
  useEffect(() => {
    storage.set("reader_estimate_scope", readerEstimateScope);
  }, [readerEstimateScope]);

  useEffect(() => {
    if (itemId) {
      storage.set(`last_interaction_${itemId}`, "read");
    }
  }, [itemId]);

  // Re-seed per-item reading speed + highlights when the itemId changes in
  // place (route params swap without an unmount). The mount-time initializers
  // already seed the first book, so guard against clobbering it.
  const perItemReseededRef = useRef(false);
  useEffect(() => {
    // Clamp on read so a previously persisted, poisoned value recovers — and
    // write the clamped value straight back so MMKV is actually healed now,
    // not only after the next valid sample.
    const rawRate = storage.getNumber(`reader_rate_${itemId}`) || 0;
    const clampedRate = clampReaderRate(rawRate);
    readingRateRef.current = clampedRate;
    if (clampedRate !== rawRate && clampedRate > 0) storage.set(`reader_rate_${itemId}`, clampedRate);
    const rawBookSpeed = storage.getNumber(`reader_speed_${itemId}`) || 0;
    const clampedBookSpeed = clampBookSpeed(rawBookSpeed);
    bookSpeedRef.current = clampedBookSpeed;
    if (clampedBookSpeed !== rawBookSpeed && clampedBookSpeed > 0) storage.set(`reader_speed_${itemId}`, clampedBookSpeed);
    readingSampleRef.current = null;
    if (!perItemReseededRef.current) {
      perItemReseededRef.current = true;
      return;
    }
    try {
      const raw = storage.getString(`reader_highlights_${itemId}`);
      const parsed = raw ? JSON.parse(raw) : [];
      setHighlights(Array.isArray(parsed) ? parsed : []);
    } catch {
      setHighlights([]);
    }
  }, [itemId]);

  // Stop any in-flight speech when leaving the reader OR when the book changes
  // in place (route params swap without an unmount). Keyed on itemId so an
  // in-place navigation to another book halts read-aloud — without this the
  // onDone chain would keep paging the NEW book (#4).
  useEffect(() => {
    return () => {
      ttsPlayingRef.current = false;
      ttsLastPosRef.current = -1;
      setTtsPlaying(false);
      try {
        if (Speech && Speech.stop) Speech.stop();
      } catch {}
    };
  }, [itemId]);

  // True once the screen is torn down — late WebView messages must not
  // re-arm the sync debounce (the cleanup below already ran).
  const unmountedRef = useRef(false);

  // Sync pending ebook progress to server on unmount/screen change
  useEffect(() => {
    // Re-arm on an IN-PLACE itemId change: navigate("Reader", {itemId: B})
    // from inside the reader updates params without unmounting, so the
    // previous run's cleanup set unmountedRef true — without this reset,
    // every message for the NEW book was dropped (no saves at all).
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      if (latestProgressRef.current) {
        const { cfi, fraction } = latestProgressRef.current;
        console.log("[Reader] Unmounting, flushing ebook progress to server:", itemId, cfi, fraction);
        // ONLY the ebook fields (matches the ABS web reader). Sending
        // `progress`/`isFinished` here would clobber the AUDIO progress on
        // both-format items — e.g. opening the ebook of a book you finished
        // in audio would un-finish it.
        api.patch(`/api/me/progress/${itemId}`, {
          ebookLocation: cfi,
          ebookProgress: fraction,
          // One-way: mark finished when the book is done reading, but never
          // send isFinished:false (that would un-finish audio-finished items).
          ...(fraction >= 0.99 ? { isFinished: true } : {}),
        }).catch((e) => {
          console.warn("[Reader] Failed to sync ebook progress on unmount:", e);
          // Offline (downloaded ebook) — queue so the cfi still reaches the
          // server (and Storyteller/other devices) when connectivity returns.
          queueEbookProgressPatch(itemId, cfi, fraction, fraction >= 0.99);
        });
        // LOCK: the reader for this item just flushed its final reading
        // position — if the user linked its progresses, pull the AUDIO up to
        // this reading fraction (furthest-wins, fraction-only; see
        // reconcileLinkedProgress). No-op unless locked.
        try {
          reconcileLinkedProgress(itemId, { ebookFraction: fraction });
        } catch {}
        // The snapshot belongs to THIS itemId. Clearing it stops an in-place
        // book change from flushing book A's cfi onto book B's server record
        // (which could even one-way auto-finish B).
        latestProgressRef.current = null;
      }
      // PDF equivalent of the epub flush above: the debounced onPageChanged
      // sync is cancelled by clearing syncTimeoutRef, so flush the last page.
      if (latestPdfProgressRef.current) {
        const { page, fraction } = latestPdfProgressRef.current;
        api
          .patch(`/api/me/progress/${itemId}`, {
            ebookLocation: String(page),
            ebookProgress: fraction,
            ...(fraction >= 0.99 ? { isFinished: true } : {}),
          })
          .catch(() => queueEbookProgressPatch(itemId, String(page), fraction, fraction >= 0.99));
        // LOCK: reconcile the audio up to this reading fraction when linked
        // (fraction-only, furthest-wins). No-op unless locked.
        try {
          reconcileLinkedProgress(itemId, { ebookFraction: fraction });
        } catch {}
        latestPdfProgressRef.current = null;
      }
    };
  }, [itemId]);

  // Re-seed the per-book PDF state when the itemId changes IN PLACE (route
  // params swap without an unmount). Keyed on [itemId] and defined AFTER the
  // flush effect above so, on a change, React runs that effect's cleanup FIRST
  // (flushing book A's last page) before this clears latestPdfProgressRef and
  // seeds book B — moving it out of the render body also removes the
  // setState-during-render anti-pattern. Skips the mount run: the useState/
  // useRef initializers already seed the first book.
  const readerReseededRef = useRef(false);
  useEffect(() => {
    if (!readerReseededRef.current) {
      readerReseededRef.current = true;
      return;
    }
    setPdfPage(Math.max(1, storage.getNumber(pdfPageKey) || 1));
    latestPdfProgressRef.current = null;
    pendingJumpRef.current =
      typeof initialFraction === "number" && Number.isFinite(initialFraction)
        ? Math.max(0, Math.min(1, initialFraction))
        : null;
  }, [itemId]);

  // Load ebook contents and generate the HTML wrapper
  useEffect(() => {
    if (!isFoliateFormat || !WebView || !ebookUri) return;
    setEbookFileUri(null);
    setEbookStatus("loading");
    let cancelled = false;
    (async () => {
      try {
        const localDownload = useDownloadStore.getState().completedDownloads[itemId];
        const ebookPart = localDownload?.parts?.find(p => p.id === "ebook");
        
        let fileUri = "";
        if (ebookPart?.localFilePath) {
          fileUri = ebookPart.localFilePath;
          console.log("[Reader] Loading ebook from offline download:", fileUri);
        } else {
          const ext = getExtForFormat(format);
          const localPath = `${FileSystem.cacheDirectory}reader_${itemId}${ext}`;
          const dl = await FileSystem.downloadAsync(ebookUri, localPath, {
            headers: { Authorization: `Bearer ${token}` },
          });
          fileUri = dl.uri;
        }

        const info = await FileSystem.getInfoAsync(fileUri);
        if ((info as any).size && (info as any).size > MAX_EBOOK_INLINE_BYTES) {
          if (!ebookPart?.localFilePath) {
            FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
          }
          if (!cancelled) setEbookStatus("toobig");
          return;
        }
        const base64 = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (!ebookPart?.localFilePath) {
          FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
        }
        if (cancelled) return;
        // Restore position: local (MMKV) vs server ebookLocation — prefer the
        // FRESHER one, so reading ahead on another device isn't lost to a stale
        // local cfi. The local save timestamp is written alongside every cfi in
        // onWebMessage; the server side uses the progress entry's lastUpdate.
        // Caveat (accepted): lastUpdate also bumps on audio-only syncs, but the
        // reader mirrors every cfi to the server too, so when nobody else read
        // further the two cfis match and the choice is moot.
        const localCfi = storage.getString(progressKey) || "";
        const localCfiAt = storage.getNumber(`${progressKey}_at`) || 0;
        const serverProgress = useUserStore.getState().mediaProgress[itemId];
        const serverCfi = serverProgress?.ebookLocation || "";
        const serverCfiAt = Number(serverProgress?.lastUpdate || serverProgress?.updatedAt || 0);
        const savedCfi =
          serverCfi && serverCfi !== localCfi && serverCfiAt > localCfiAt
            ? serverCfi
            : localCfi || serverCfi;

        const mime = getMimeForFormat(format);
        const htmlContent = ebookHtml(base64, bg, fg, accent, savedCfi, mime, fontSize, fontFamily, lineHeight, pageCurl, readerMargin, readerFlow);
        const htmlPath = `${FileSystem.cacheDirectory}reader_${itemId}.html`;
        await FileSystem.writeAsStringAsync(htmlPath, htmlContent, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        if (cancelled) return;
        setEbookFileUri(htmlPath);
        setEbookStatus("ready");
      } catch (e: any) {
        console.warn("[Reader] ebook load failed", e);
        if (!cancelled) {
          setEbookError(`load: ${e?.message || String(e)}`);
          setEbookStatus("error");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isFoliateFormat, ebookUri, reloadKey]);

  const onWebMessage = useCallback((event: any) => {
    try {
      if (unmountedRef.current) return;
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "location") {
        // Sanitize at the trust boundary: foliate/webview payloads can carry
        // out-of-range fractions (a fraction of 2 would ONE-WAY auto-finish
        // the book server-side) and non-string cfis (unrecoverable MMKV
        // writes).
        const rawFraction = Number(data.fraction);
        data.fraction = Number.isFinite(rawFraction) ? Math.min(1, Math.max(0, rawFraction)) : 0;
        if (typeof data.cfi !== "string") data.cfi = "";
        if (data.cfi) {
          storage.set(progressKey, data.cfi);
          // Save-time timestamp so the restore logic can compare local vs
          // server freshness (see the load effect above).
          storage.set(`${progressKey}_at`, Date.now());
          latestProgressRef.current = { cfi: data.cfi, fraction: data.fraction || 0 };
        }
        setPageProgress({
          page: data.page || 1,
          pages: data.pages || 1,
          fraction: data.fraction || 0,
          tocItem: data.tocItem || null,
        });

        // Rolling reading-rate samples for the "time left" estimate. Two rates
        // are smoothed (EMA) and persisted per item, both CLAMPED so a couple of
        // fast early page-flips can't poison the average and collapse the
        // estimate (#1). The footer text itself is DERIVED at render time from
        // these refs + the active scope, so it stays live when the scope toggles.
        {
          const now = Date.now();
          const prevSample = readingSampleRef.current;
          const frac = data.fraction || 0;
          const page = Math.max(1, Number(data.page) || 1);
          const pages = Math.max(1, Number(data.pages) || 1);
          const section = Number(data.section) || 0;
          if (prevSample) {
            const dtMin = (now - prevSample.t) / 60000;
            // Ignore implausible gaps (idle/backgrounded) and instantaneous
            // jumps (TOC navigation) so they don't poison the average.
            if (dtMin > 0.03 && dtMin < 15) {
              // Chapter: pages/min. Only sample forward page turns WITHIN the
              // same section — the page counter resets across sections.
              if (prevSample.section === section && page > prevSample.page) {
                const instRate = (page - prevSample.page) / dtMin;
                const clampedInst = clampReaderRate(instRate);
                if (clampedInst > 0) {
                  const prevRate = readingRateRef.current;
                  const nextRate = prevRate > 0 ? prevRate * 0.7 + clampedInst * 0.3 : clampedInst;
                  readingRateRef.current = clampReaderRate(nextRate);
                  storage.set(`reader_rate_${itemId}`, readingRateRef.current);
                }
              }
              // Book: fraction/min, sampled over any forward movement.
              if (frac > prevSample.fraction) {
                const instBook = (frac - prevSample.fraction) / dtMin;
                if (Number.isFinite(instBook) && instBook > 0) {
                  const prevBook = bookSpeedRef.current;
                  const nextBook = prevBook > 0 ? prevBook * 0.7 + instBook * 0.3 : instBook;
                  bookSpeedRef.current = clampBookSpeed(nextBook);
                  storage.set(`reader_speed_${itemId}`, bookSpeedRef.current);
                }
              }
            }
          }
          readingSampleRef.current = { page, pages, section, fraction: frac, t: now };
        }

        // Update local store progress state instantly — EBOOK fields only.
        // Touching `progress`/`isFinished` here would clobber the audio
        // progress on both-format items (and un-finish finished audiobooks).
        const updatedProgress = {
          libraryItemId: itemId,
          ebookLocation: data.cfi || "",
          ebookProgress: data.fraction || 0,
          updatedAt: Date.now(),
        };
        useUserStore.setState({
          mediaProgress: {
            ...useUserStore.getState().mediaProgress,
            [itemId]: {
              ...useUserStore.getState().mediaProgress[itemId],
              ...updatedProgress,
            },
          },
        });

        // Debounce progress PATCH to server (ebook fields only, matching the
        // ABS web reader).
        if (syncTimeoutRef.current) {
          clearTimeout(syncTimeoutRef.current);
        }
        syncTimeoutRef.current = setTimeout(async () => {
          try {
            await api.patch(`/api/me/progress/${itemId}`, {
              ebookLocation: data.cfi || "",
              ebookProgress: data.fraction || 0,
              ...((data.fraction || 0) >= 0.99 ? { isFinished: true } : {}),
            });
          } catch (e) {
            console.warn("[Reader] Failed to sync ebook progress:", e);
            // Offline — queue (ebook fields only) instead of dropping it.
            queueEbookProgressPatch(
              itemId,
              data.cfi || "",
              data.fraction || 0,
              (data.fraction || 0) >= 0.99
            );
          }
        }, 2000);
      } else if (data.type === "toc") {
        setToc(data.toc || []);
      } else if (data.type === "ready") {
        // Gate the search UI off when the vendored bundle lacks the search API.
        if (typeof data.search === "boolean") setSearchAvailable(data.search);
        // Player → reader handoff: jump to the mapped fraction once the book
        // is actually rendered (overrides the startCfi restore).
        const f = pendingJumpRef.current;
        if (f != null && webRef.current) {
          pendingJumpRef.current = null;
          webRef.current.injectJavaScript(
            `window.goToFraction && window.goToFraction(${Number(f)});true;`
          );
        }
        // Re-apply any stored highlights via the foliate annotation API. The
        // CFI is escaped (JSON.stringify) since it came from a prior selection.
        if (webRef.current) {
          try {
            const stored: Highlight[] = (() => {
              try {
                const raw = storage.getString(highlightsKey);
                const parsed = raw ? JSON.parse(raw) : [];
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })();
            for (const h of stored) {
              if (h && typeof h.cfi === "string" && h.cfi) {
                webRef.current.injectJavaScript(
                  `window.addHighlight && window.addHighlight(${JSON.stringify(h.cfi)}, ${JSON.stringify(h.color || "rgba(255,213,0,.4)")});true;`
                );
              }
            }
          } catch {}
        }
      } else if (data.type === "selection") {
        // Text selected inside the book — surface the dictionary/highlight/
        // share action sheet. Both fields are untrusted strings.
        const text = typeof data.text === "string" ? data.text.trim() : "";
        const cfi = typeof data.cfi === "string" ? data.cfi : "";
        if (text) setSelection({ text, cfi });
      } else if (data.type === "searchResult") {
        const cfi = typeof data.cfi === "string" ? data.cfi : "";
        const excerpt = typeof data.excerpt === "string" ? data.excerpt : "";
        const label = typeof data.label === "string" ? data.label : "";
        if (cfi) setSearchResults((prev) => (prev.length >= 200 ? prev : [...prev, { cfi, excerpt, label }]));
      } else if (data.type === "searchDone") {
        setSearching(false);
      } else if (data.type === "ttsText") {
        const text = typeof data.text === "string" ? data.text : "";
        const rawPos = Number(data.pos);
        const pos = Number.isFinite(rawPos) ? rawPos : -1;
        // Race guard (#4): if read-aloud was stopped (or expo-speech is gone)
        // between the getReaderText request and this async reply, do NOT start
        // speaking — a quick play→stop must stay stopped.
        if (!Speech || !ttsPlayingRef.current) {
          ttsPlayingRef.current = false;
          setTtsPlaying(false);
          return;
        }
        const stopTts = () => {
          ttsPlayingRef.current = false;
          setTtsPlaying(false);
          try {
            Speech.stop && Speech.stop();
          } catch {}
        };
        const advanceTts = () => {
          if (ttsPlayingRef.current && webRef.current) {
            webRef.current.injectJavaScript(TTS_ADVANCE_JS);
          }
        };
        // Did the reader actually move since the last spoken page? goNext() is a
        // no-op at the last page, so an unchanged position means we hit the end
        // (or a stuck section) — end cleanly rather than looping (#1). pos < 0
        // means the position is unknown (e.g. the initial kick-off) — allow it.
        const advanced = pos < 0 || pos > ttsLastPosRef.current + 1e-6;
        if (!text) {
          // Blank/image section (#3): skip ahead a page and retry while reading,
          // but only if we actually advanced — otherwise we'd loop forever on a
          // trailing empty page (guarded by the #1 advance check).
          if (advanced) {
            ttsLastPosRef.current = pos;
            advanceTts();
          } else {
            stopTts();
          }
          return;
        }
        if (!advanced) {
          stopTts();
          return;
        }
        ttsLastPosRef.current = pos;
        // Chunk long pages under Android's TextToSpeech limit (#2) and speak the
        // chunks in sequence, only advancing the page after the LAST chunk.
        const chunks = chunkTtsText(text);
        const speakFrom = (i: number) => {
          if (!ttsPlayingRef.current || !Speech) return;
          if (i >= chunks.length) {
            advanceTts();
            return;
          }
          try {
            Speech.speak(chunks[i], {
              // Read at the user-selected rate (1.0 = normal). Read from the ref
              // so a mid-read speed change applies to the next chunk.
              rate: ttsRateRef.current,
              onDone: () => {
                if (ttsPlayingRef.current) speakFrom(i + 1);
              },
              onStopped: () => {
                ttsPlayingRef.current = false;
                setTtsPlaying(false);
              },
              onError: () => {
                ttsPlayingRef.current = false;
                setTtsPlaying(false);
              },
            });
          } catch {
            ttsPlayingRef.current = false;
            setTtsPlaying(false);
          }
        };
        speakFrom(0);
      } else if (data.type === "error") {
        setEbookError(`render: ${data.message || "unknown"}`);
        setEbookStatus("error");
      }
    } catch {}
  }, [progressKey, itemId, highlightsKey]);

  const openExternally = async () => {
    try {
      if (Sharing && (await Sharing.isAvailableAsync())) {
        // Downloaded book: share the local file directly — re-downloading
        // fails exactly when downloads matter (offline / "too large" books).
        const localEbook = useDownloadStore
          .getState()
          .completedDownloads[itemId]?.parts?.find((p: any) => p.id === "ebook")?.localFilePath;
        if (localEbook) {
          // localFilePath may be a bare absolute path (older/cached download
          // rows) — expo-sharing wants a URI (same normalization as the
          // playback store's local track resolution).
          const uri =
            localEbook.startsWith("file://") || localEbook.startsWith("content://")
              ? localEbook
              : `file://${localEbook}`;
          await Sharing.shareAsync(uri, { dialogTitle: title || "Open ebook" });
          return;
        }
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

  // "Listen from here": start the audiobook edition at (approximately) the
  // current reading position — the reader-side Whispersync entry point
  // (player-side lives in PlayerBottomSheet's Read-from-here).
  const listenFromHere = () => {
    (async () => {
      const target = await resolveAudioTarget(itemId);
      if (!target) {
        showAppDialog({ title: "No audiobook available", message: "This book doesn't have an audio edition in your library." });
        return;
      }
      const fraction = isPdf
        ? (pdfProgress ? pdfProgress.page / Math.max(1, pdfProgress.pages) : 0)
        : latestProgressRef.current?.fraction ?? pageProgress?.fraction ?? 0;
      const estimate = target.duration
        ? ` at about ${approximateClock(audioPositionForReadingFraction(fraction, target.duration))}`
        : "";
      showAppDialog({
        title: "Listen from here?",
        message: `Start the audiobook${estimate}? Position matching is approximate.`,
        buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Listen",
          onPress: () => {
            (async () => {
              try {
                const ok = await usePlaybackStore.getState().startPlayback(target.itemId);
                if (!ok) throw new Error("start failed");
                // Seek against the LIVE duration — the resolver's metadata
                // duration is display-grade only.
                const live = usePlaybackStore.getState();
                const dur = live.duration || target.duration || 0;
                if (dur > 0) await live.seek(audioPositionForReadingFraction(fraction, dur));
                navigation.goBack();
              } catch (e) {
                console.warn("[Reader] listen-from-here failed", e);
                showAppDialog({ title: "Couldn't start playback", message: "Check your connection to the server and try again." });
              }
            })();
          },
        },
      ],
      });
    })();
  };

  const selectTocItem = (href: string) => {
    // href comes from the EBOOK's own TOC via the bridge — untrusted. Escape
    // like startCfi (JSON.stringify): raw interpolation both broke navigation
    // for titles with quotes AND let a crafted epub execute arbitrary JS in
    // the reader WebView, which holds the native bridge.
    if (typeof href !== "string" || !href) return;
    if (webRef.current) {
      webRef.current.injectJavaScript(
        `window.goToHref && window.goToHref(${JSON.stringify(String(href))});true;`
      );
      setShowToc(false);
    }
  };

  // Run an in-book full-text search. The query is JSON-escaped into the
  // injected script so quotes/backslashes can't break out of the string.
  const runSearch = (q: string) => {
    const query = String(q || "").trim();
    if (!query || !webRef.current) return;
    setSearchResults([]);
    setSearching(true);
    webRef.current.injectJavaScript(
      `window.clearReaderSearch && window.clearReaderSearch();window.search && window.search(${JSON.stringify(query)});true;`
    );
  };

  const goToSearchResult = (cfi: string) => {
    if (typeof cfi !== "string" || !cfi || !webRef.current) return;
    webRef.current.injectJavaScript(
      `window.goToSearchResult && window.goToSearchResult(${JSON.stringify(cfi)});true;`
    );
    setShowSearch(false);
  };

  const persistHighlights = (list: Highlight[]) => {
    setHighlights(list);
    try {
      storage.set(highlightsKey, JSON.stringify(list));
    } catch {}
  };

  // Add a highlight from the current selection: draw it via the foliate
  // annotation API and persist it locally.
  const addHighlightFromSelection = () => {
    const sel = selection;
    if (!sel || !sel.cfi) {
      setSelection(null);
      return;
    }
    const color = "rgba(255,213,0,.4)";
    if (webRef.current) {
      webRef.current.injectJavaScript(
        `window.addHighlight && window.addHighlight(${JSON.stringify(sel.cfi)}, ${JSON.stringify(color)});true;`
      );
    }
    const next = [
      ...highlights.filter((h) => h.cfi !== sel.cfi),
      { cfi: sel.cfi, text: sel.text, color, at: Date.now() },
    ];
    persistHighlights(next);
    setSelection(null);
  };

  const removeHighlight = (cfi: string) => {
    // Deleting a highlight is destructive and irreversible, so confirm first
    // via the themed dialog (mirrors the app's other destructive actions).
    showAppDialog({
      title: "Delete highlight?",
      message: "This highlight is saved on this device and will be removed.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            if (webRef.current) {
              webRef.current.injectJavaScript(
                `window.removeHighlight && window.removeHighlight(${JSON.stringify(String(cfi))});true;`
              );
            }
            persistHighlights(highlights.filter((h) => h.cfi !== cfi));
          },
        },
      ],
    });
  };

  // Share the selected text as a quote (text-only share — no native deps).
  const shareQuote = async (text: string) => {
    const quote = String(text || "").trim();
    if (!quote) return;
    const message = title ? `"${quote}"\n\n— ${title}` : `"${quote}"`;
    try {
      await Share.share({ message });
    } catch {}
    setSelection(null);
  };

  // Look up the selected word via the OS. Prefer a web search intent through
  // Linking; degrade gracefully if it can't be opened.
  const lookUpWord = async (text: string) => {
    const term = String(text || "").trim();
    if (!term) return;
    const url = `https://www.google.com/search?q=${encodeURIComponent("define " + term)}`;
    try {
      await Linking.openURL(url);
    } catch {
      showAppDialog({ title: "Couldn't look that up", message: "No app is available to handle the lookup." });
    }
    setSelection(null);
  };

  // Toggle read-aloud. expo-speech is optional; when it's missing we surface a
  // "not available" message rather than a silent no-op.
  const toggleTts = () => {
    if (!ttsAvailable) {
      showAppDialog({
        title: "Read-aloud unavailable",
        message: "Text-to-speech isn't available in this build.",
      });
      return;
    }
    if (ttsPlayingRef.current) {
      ttsPlayingRef.current = false;
      ttsLastPosRef.current = -1;
      setTtsPlaying(false);
      try {
        Speech.stop();
      } catch {}
      return;
    }
    // Kick off: mark the intent immediately (#4) so a late ttsText reply from a
    // previous stop can't sneak through, then ask the WebView for the current
    // section's text; the ttsText handler starts speaking and advances
    // page-by-page.
    ttsPlayingRef.current = true;
    ttsLastPosRef.current = -1;
    setTtsPlaying(true);
    if (webRef.current) {
      webRef.current.injectJavaScript("window.getReaderText && window.getReaderText();true;");
    }
  };

  const canRenderPdf = Pdf !== null && isPdf && !pdfError && !!ebookUri;
  const canRenderEbook = WebView !== null && isFoliateFormat && ebookStatus === "ready" && !!ebookFileUri;

  const formatLabel = format ? format.toUpperCase() : "ebook";

  const Header = (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, backgroundColor: chromeBg }}>
      <Pressable
        onPress={() => navigation.goBack()}
        style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close reader"
      >
        <Icon name="back" size={24} color={chromeFg} />
      </Pressable>
      <Text numberOfLines={1} style={{ color: chromeFg, fontSize: 18, fontWeight: "700", marginLeft: 4, flex: 1 }}>
        {title || "Reader"}
      </Text>
      {(isFoliateFormat && canRenderEbook) || canRenderPdf ? (
        <Pressable
          onPress={listenFromHere}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Listen from here"
        >
          <Icon name="headphones" size={24} color={chromeFg} />
        </Pressable>
      ) : null}
      {isFoliateFormat && canRenderEbook ? (
        // Header keeps only the primary reading controls — Listen (above),
        // Read-aloud, TOC, Settings. Search + Highlights moved into the reading
        // settings sheet so the title isn't squeezed by six buttons (#6).
        <View style={{ flexDirection: "row", alignItems: "center", columnGap: 4 }}>
          <Pressable
            onPress={toggleTts}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={ttsPlaying ? "Stop read-aloud" : "Read aloud"}
            accessibilityState={{ selected: ttsPlaying }}
          >
            {/* Distinct voice/mic glyph so read-aloud (TTS) doesn't read as the
                same "play audio" affordance as the headphones "Listen from
                here" control next to it (#7). */}
            <Icon name={ttsPlaying ? "pause" : "podcast"} size={24} color={ttsPlaying ? accent : chromeFg} />
          </Pressable>
          <Pressable
            onPress={() => setShowToc(true)}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Table of contents"
          >
            <Icon name="list" size={24} color={chromeFg} />
          </Pressable>
          <Pressable
            onPress={() => setShowSettings(true)}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Reading settings"
          >
            <Icon name="settings" size={24} color={chromeFg} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  const Fallback = ({
    message,
    showShare = true,
    onRetry,
  }: {
    message: string;
    showShare?: boolean;
    onRetry?: () => void;
  }) => (
    // Shared ErrorState treatment, but this is a book-open failure so it keeps
    // the "book" glyph and its dual Try-again / Open-externally actions.
    <ErrorState
      style={{ flex: 1 }}
      icon="book"
      title="Can't open this book"
      message={message}
      action={
        <View style={{ alignItems: "center" }}>
          {onRetry ? (
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              style={{
                backgroundColor: colors.primary, paddingHorizontal: 24, height: 48, borderRadius: 24,
                alignItems: "center", justifyContent: "center", flexDirection: "row", marginBottom: 12,
              }}
            >
              <Icon name="refresh" size={20} color={colors.onPrimary} />
              <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600", marginLeft: 8 }}>
                Try again
              </Text>
            </Pressable>
          ) : null}
          {showShare ? (
            <Pressable
              onPress={openExternally}
              accessibilityRole="button"
              style={{
                // Secondary action when Retry is present, primary otherwise.
                backgroundColor: onRetry ? colors.secondaryContainer : colors.primary,
                paddingHorizontal: 24, height: 48, borderRadius: 24,
                alignItems: "center", justifyContent: "center", flexDirection: "row",
              }}
            >
              <Icon name="share" size={20} color={onRetry ? colors.onSecondaryContainer : colors.onPrimary} />
              <Text
                style={{
                  color: onRetry ? colors.onSecondaryContainer : colors.onPrimary,
                  fontSize: 15, fontWeight: "600", marginLeft: 8,
                }}
              >
                Open in another app
              </Text>
            </Pressable>
          ) : null}
        </View>
      }
    />
  );

  // Recursive rendering helper for TOC hierarchical lists (subitems).
  // The section currently being read (foliate reports it on every relocate)
  // is tinted primary so long TOCs are scannable for "where am I".
  const currentTocLabel = pageProgress?.tocItem?.label || null;
  const renderTocItem = ({ item }: { item: any }) => {
    // Trust boundary: a malformed TOC (object label, string subitems) came
    // straight from the WebView and hard-crashed this renderer.
    const label = typeof item?.label === "string" && item.label ? item.label : "Untitled Section";
    const subitems = Array.isArray(item?.subitems) ? item.subitems : [];
    const isCurrent = !!currentTocLabel && label === currentTocLabel;
    return (
      <View style={{ marginLeft: 8 }}>
        <Pressable
          onPress={() => selectTocItem(item.href)}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected: isCurrent }}
          style={{
            paddingVertical: 14,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.outlineVariant,
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              flex: 1,
              color: isCurrent ? colors.primary : colors.onSurface,
              fontSize: 16,
              fontWeight: isCurrent ? "700" : "500",
            }}
          >
            {label}
          </Text>
          {isCurrent ? <Icon name="bookmark" size={18} color={colors.primary} /> : null}
        </Pressable>
        {subitems.length > 0 && (
          <View style={{ paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: colors.outlineVariant }}>
            {subitems.map((sub: any, idx: number) => (
              <View key={idx}>
                {renderTocItem({ item: sub })}
              </View>
            ))}
          </View>
        )}
      </View>
    );
  };

  let body: React.ReactNode;
  if (canRenderPdf) {
    // Prefer the downloaded PDF file — the remote URL is dead exactly when
    // downloads matter (offline), which previously dead-ended a downloaded
    // PDF at the generic "can't be viewed" fallback.
    const localPdf = useDownloadStore
      .getState()
      .completedDownloads[itemId]?.parts?.find((p: any) => p.id === "ebook")?.localFilePath;
    body = (
      <Pdf
        // Remount for a new book so the controlled page starts fresh.
        key={itemId}
        source={
          localPdf
            ? { uri: localPdf }
            : { uri: ebookUri, headers: { Authorization: `Bearer ${token}` } }
        }
        style={{ flex: 1, backgroundColor: colors.surface }}
        page={pdfPage}
        onLoadComplete={(numberOfPages: number) => {
          // Player → reader handoff for PDFs: the pending "Read from here"
          // fraction is only mappable to a page once the page count is known.
          // Mirror the epub goToFraction jump — honor it, then clear it so it
          // doesn't override the user's later scrolling. (Previously the pending
          // jump was set for PDFs but never consumed, so it silently no-oped.)
          const f = pendingJumpRef.current;
          if (f != null && numberOfPages > 0) {
            pendingJumpRef.current = null;
            const target = Math.max(1, Math.min(numberOfPages, Math.round(f * numberOfPages)));
            setPdfPage(target);
          }
        }}
        onPageChanged={(page: number, numberOfPages: number) => {
          setPdfProgress({ page, pages: numberOfPages });
          // Keep the controlled page in sync with scroll (no-op jump when the
          // prop already equals the current page).
          setPdfPage((prev) => (prev !== page ? page : prev));
          // Remember where the user left off so reopening resumes here.
          storage.set(pdfPageKey, page);
          // PDFs get the SAME server sync the epub path has (ebook fields
          // only, matching the ABS web PDF reader: ebookLocation = page
          // number) — without it PDF progress never left the device: no
          // cross-device resume, no "Reading" row, no finish.
          const fraction = numberOfPages > 0 ? Math.min(1, page / numberOfPages) : 0;
          // Snapshot for the unmount flush (mirrors the epub latestProgressRef)
          // so a page turn within the debounce window still reaches the server.
          latestPdfProgressRef.current = { page, fraction };
          useUserStore.setState({
            mediaProgress: {
              ...useUserStore.getState().mediaProgress,
              [itemId]: {
                ...useUserStore.getState().mediaProgress[itemId],
                libraryItemId: itemId,
                ebookLocation: String(page),
                ebookProgress: fraction,
                updatedAt: Date.now(),
              },
            },
          });
          if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
          syncTimeoutRef.current = setTimeout(async () => {
            try {
              await api.patch(`/api/me/progress/${itemId}`, {
                ebookLocation: String(page),
                ebookProgress: fraction,
                ...(fraction >= 0.99 ? { isFinished: true } : {}),
              });
            } catch (e) {
              console.warn("[Reader] Failed to sync PDF progress:", e);
              queueEbookProgressPatch(itemId, String(page), fraction, fraction >= 0.99);
            }
          }, 2000);
        }}
        onError={() => setPdfError(true)}
      />
    );
  } else if (isFoliateFormat) {
    if (!WebView) {
      // Native WebView module missing from this build — without this branch
      // the screen would sit on the loading state forever.
      body = <Fallback message="The in-app reader isn't available in this build. Open the ebook in another app instead." />;
    } else if (ebookStatus === "loading" || ebookStatus === "idle") {
      body = (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface }}>
          <Animated.View style={{ opacity: pulseAnim, transform: [{ scale: pulseAnim }], marginBottom: 20 }}>
            <View style={{
              width: 72, height: 72, borderRadius: 36, backgroundColor: colors.secondaryContainer,
              alignItems: "center", justifyContent: "center"
            }}>
              <Icon name="book" size={36} color={colors.primary} />
            </View>
          </Animated.View>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600", marginTop: 16 }}>
            Preparing your book…
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4 }}>
            Setting up typography and layout
          </Text>
        </View>
      );
    } else if (canRenderEbook) {
      body = (
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          source={{ uri: ebookFileUri as string }}
          style={{ flex: 1, backgroundColor: chromeBg }}
          onMessage={onWebMessage}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          allowUniversalAccessFromFileURLs
          mixedContentMode="always"
        />
      );
    } else if (ebookStatus === "toobig") {
      body = <Fallback message="This ebook is too large to display in-app — open it in a dedicated reader app for the best experience." />;
    } else {
      body = (
        <Fallback
          message={`Couldn't open this ${formatLabel} in-app. Check your connection and try again, or open it in another app.${ebookError ? `\n\n${ebookError}` : ""}`}
          onRetry={() => { setEbookError(""); setReloadKey((k) => k + 1); }}
        />
      );
    }
  } else if (isPdf && pdfError) {
    // A PDF LOAD failure is not a format problem — the old fallthrough told
    // the user the format was unsupported and offered no way back.
    body = (
      <Fallback
        message="Couldn't open this PDF. Check your connection and try again, or open it in another app."
        onRetry={() => setPdfError(false)}
      />
    );
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
    <SafeAreaView style={{ flex: 1, backgroundColor: chromeBg }} edges={["top", "left", "right"]}>
      {Header}
      <View style={{ flex: 1 }}>{body}</View>

      {/* PDF footer — page indicator + focusable prev/next (a11y: PDF page
          turns are otherwise scroll-only, unreachable under TalkBack), mirroring
          the epub footer's buttons below. */}
      {canRenderPdf && pdfProgress && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 6,
            paddingHorizontal: 12,
            backgroundColor: colors.surface,
            borderTopWidth: 1,
            borderTopColor: colors.outlineVariant,
          }}
        >
          <Pressable
            onPress={() => setPdfPage((p) => Math.max(1, p - 1))}
            disabled={pdfProgress.page <= 1}
            accessibilityRole="button"
            accessibilityLabel="Previous page"
            accessibilityState={{ disabled: pdfProgress.page <= 1 }}
            hitSlop={8}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", opacity: pdfProgress.page <= 1 ? 0.4 : 1 }}
          >
            <Icon name="chevron-left" size={22} color={colors.onSurfaceVariant} />
          </Pressable>
          <Text
            accessibilityLiveRegion="polite"
            style={{ flex: 1, textAlign: "center", color: colors.onSurfaceVariant, fontSize: 12 }}
          >
            Page {pdfProgress.page} of {pdfProgress.pages}
          </Text>
          <Pressable
            onPress={() => setPdfPage((p) => Math.min(pdfProgress.pages || p + 1, p + 1))}
            disabled={pdfProgress.page >= pdfProgress.pages}
            accessibilityRole="button"
            accessibilityLabel="Next page"
            accessibilityState={{ disabled: pdfProgress.page >= pdfProgress.pages }}
            hitSlop={8}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", opacity: pdfProgress.page >= pdfProgress.pages ? 0.4 : 1 }}
          >
            <Icon name="chevron-right" size={22} color={colors.onSurfaceVariant} />
          </Pressable>
        </View>
      )}

      {/* Footer Progress Indicators */}
      {isFoliateFormat && canRenderEbook && pageProgress && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 6,
            paddingHorizontal: 12,
            backgroundColor: chromeBg,
            borderTopWidth: 1,
            borderTopColor: chromeBorder,
          }}
        >
          {/* Page turning is otherwise gesture-only inside the WebView (tap
              zones/swipes on document listeners) — with TalkBack running
              there is no focusable way to turn a page without these. */}
          <Pressable
            onPress={() => webRef.current?.injectJavaScript("window.goPrev && window.goPrev();true;")}
            accessibilityRole="button"
            accessibilityLabel="Previous page"
            hitSlop={8}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="chevron-left" size={22} color={chromeFgDim} />
          </Pressable>
          <View
            testID="reader-progress-footer"
            accessibilityLiveRegion="polite"
            style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
          >
            {pageProgress.tocItem?.label ? (
              <Text numberOfLines={1} style={{ color: chromeFgDim, fontSize: 13, fontWeight: "600", marginBottom: 2 }}>
                {pageProgress.tocItem.label}
              </Text>
            ) : null}
            <Text style={{ color: chromeFgDim, fontSize: 12 }}>
              {/* Percent clamped to 1–99 while mid-book: never "0%" right after
                  starting, and "100%" only at the finished threshold (>=0.99,
                  matching the isFinished sync cutoff). */}
              Page {pageProgress.page} of {pageProgress.pages} (
              {pageProgress.fraction >= 0.99
                ? 100
                : Math.max(pageProgress.fraction > 0 ? 1 : 0, Math.min(99, Math.round(pageProgress.fraction * 100)))}
              %)
            </Text>
            {/* Time-left estimate from the rolling reading-speed sample —
                hidden until an estimate is available. */}
            {readingEstimate != null && readingEstimate > 0 && pageProgress.fraction < 0.99 ? (
              <Text style={{ color: chromeFgDim, fontSize: 11, marginTop: 1 }}>
                ~{readingEstimate} min left in {readerEstimateScope === "book" ? "book" : "chapter"}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={() => webRef.current?.injectJavaScript("window.goNext && window.goNext();true;")}
            accessibilityRole="button"
            accessibilityLabel="Next page"
            hitSlop={8}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="chevron-right" size={22} color={chromeFgDim} />
          </Pressable>
        </View>
      )}

      {/* Spacer to clear bottom miniplayer or safe navigation bar */}
      <View style={{ height: bottomReserve, backgroundColor: chromeBg }} />

      {/* Table of Contents Slide-up Modal */}
      <BottomSheet visible={showToc} onClose={() => setShowToc(false)} showHandle={false}>
        <View style={{ paddingBottom: 16 }}>
            {/* Modal Header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                padding: 16,
                borderBottomWidth: 1,
                borderBottomColor: colors.outlineVariant,
              }}
            >
              <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700" }}>Table of Contents</Text>
              <Pressable
                onPress={() => setShowToc(false)}
                hitSlop={8}
                style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" }}
                accessibilityRole="button"
                accessibilityLabel="Close table of contents"
              >
                <Icon name="close" size={24} color={colors.onSurface} />
              </Pressable>
            </View>

            {/* List */}
            {toc.length > 0 ? (
              <FlatList
                data={toc}
                renderItem={renderTocItem}
                keyExtractor={(_, index) => String(index)}
                contentContainerStyle={{ paddingVertical: 8 }}
              />
            ) : (
              <View style={{ padding: 48, alignItems: "center" }}>
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 15 }}>No table of contents available.</Text>
              </View>
            )}
        </View>
      </BottomSheet>

      {/* Text Settings Slide-up Modal */}
      <BottomSheet visible={showSettings} onClose={() => setShowSettings(false)} showHandle={false}>
        {/* Fixed header — the sections below scroll so nothing (Margins, Layout,
            Time Left) is clipped off the bottom on shorter screens (#4). */}
        <View style={{ paddingTop: 20, paddingHorizontal: 20 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700" }}>Reading Settings</Text>
              <Pressable
                onPress={() => setShowSettings(false)}
                hitSlop={8}
                style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" }}
                accessibilityRole="button"
                accessibilityLabel="Close reading settings"
              >
                <Icon name="close" size={24} color={colors.onSurface} />
              </Pressable>
            </View>
        </View>
        <ScrollView
          testID="reader-settings-scroll"
          style={{ maxHeight: windowHeight * 0.75 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
          showsVerticalScrollIndicator
        >
            {/* Tools — Search + Highlights live here (rather than crowding the
                header) so the reader chrome stays uncluttered (#6). Each opens
                its own sheet and closes this one. */}
            <View style={{ marginBottom: 24 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Tools</Text>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                <Pressable
                  onPress={() => { setShowSettings(false); setShowSearch(true); }}
                  accessibilityRole="button"
                  accessibilityLabel="Search in book"
                  style={{
                    flex: 1, height: 48, borderRadius: 12, backgroundColor: colors.secondaryContainer,
                    alignItems: "center", justifyContent: "center", flexDirection: "row", columnGap: 8,
                  }}
                >
                  <Icon name="search" size={20} color={colors.onSecondaryContainer} />
                  <Text style={{ color: colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>Search</Text>
                </Pressable>
                <Pressable
                  onPress={() => { setShowSettings(false); setShowHighlights(true); }}
                  accessibilityRole="button"
                  accessibilityLabel="Highlights"
                  style={{
                    flex: 1, height: 48, borderRadius: 12, backgroundColor: colors.secondaryContainer,
                    alignItems: "center", justifyContent: "center", flexDirection: "row", columnGap: 8,
                  }}
                >
                  <Icon name="edit" size={20} color={colors.onSecondaryContainer} />
                  <Text style={{ color: colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>Highlights</Text>
                </Pressable>
              </View>
            </View>

            {/* Text Size Control */}
            <View style={{ marginBottom: 24 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Text Size</Text>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Pressable
                  onPress={() => setFontSize(prev => Math.max(FONT_SIZE_MIN, prev - 10))}
                  disabled={fontSize <= FONT_SIZE_MIN}
                  accessibilityRole="button"
                  accessibilityLabel="Decrease text size"
                  accessibilityState={{ disabled: fontSize <= FONT_SIZE_MIN }}
                  style={{
                    width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer,
                    alignItems: "center", justifyContent: "center",
                    opacity: fontSize <= FONT_SIZE_MIN ? 0.4 : 1,
                  }}
                >
                  <Text style={{ color: colors.onSecondaryContainer, fontSize: 20, fontWeight: "700" }}>-</Text>
                </Pressable>
                {/* Live region: each +/- step announces the new value. */}
                <Text
                  accessibilityLiveRegion="polite"
                  style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600" }}
                >
                  {fontSize}%
                </Text>
                <Pressable
                  onPress={() => setFontSize(prev => Math.min(FONT_SIZE_MAX, prev + 10))}
                  disabled={fontSize >= FONT_SIZE_MAX}
                  accessibilityRole="button"
                  accessibilityLabel="Increase text size"
                  accessibilityState={{ disabled: fontSize >= FONT_SIZE_MAX }}
                  style={{
                    width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer,
                    alignItems: "center", justifyContent: "center",
                    opacity: fontSize >= FONT_SIZE_MAX ? 0.4 : 1,
                  }}
                >
                  <Text style={{ color: colors.onSecondaryContainer, fontSize: 20, fontWeight: "700" }}>+</Text>
                </Pressable>
              </View>
            </View>

            {/* Font Family Control */}
            <View style={{ marginBottom: 24 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Font Family</Text>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                <Pressable
                  onPress={() => setFontFamily("serif")}
                  accessibilityRole="button"
                  accessibilityState={{ selected: fontFamily === "serif" }}
                  style={{
                    flex: 1, height: 48, borderRadius: 12,
                    backgroundColor: fontFamily === "serif" ? colors.primary : colors.secondaryContainer,
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Text style={{ color: fontFamily === "serif" ? colors.onPrimary : colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>Serif</Text>
                </Pressable>
                <Pressable
                  onPress={() => setFontFamily("sans-serif")}
                  accessibilityRole="button"
                  accessibilityState={{ selected: fontFamily === "sans-serif" }}
                  style={{
                    flex: 1, height: 48, borderRadius: 12,
                    backgroundColor: fontFamily === "sans-serif" ? colors.primary : colors.secondaryContainer,
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Text style={{ color: fontFamily === "sans-serif" ? colors.onPrimary : colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>Sans-Serif</Text>
                </Pressable>
              </View>
            </View>

            {/* Line Spacing Control */}
            <View style={{ marginBottom: 12 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Line Spacing</Text>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                {[
                  { label: "Narrow", val: 1.2 },
                  { label: "Medium", val: 1.5 },
                  { label: "Wide", val: 1.8 },
                ].map(item => (
                  <Pressable
                    key={item.label}
                    onPress={() => setLineHeight(item.val)}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.label} line spacing`}
                    accessibilityState={{ selected: lineHeight === item.val }}
                    style={{
                      flex: 1, height: 48, borderRadius: 12,
                      backgroundColor: lineHeight === item.val ? colors.primary : colors.secondaryContainer,
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: lineHeight === item.val ? colors.onPrimary : colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Page-turn animation (finger-follow curl) */}
            <View style={{ marginTop: 12, marginBottom: 12 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Page Turn</Text>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                {[
                  { label: "Curl", val: true },
                  { label: "None", val: false },
                ].map(item => (
                  <Pressable
                    key={item.label}
                    onPress={() => setPageCurl(item.val)}
                    accessibilityRole="button"
                    accessibilityLabel={item.val ? "Page-turn curl animation" : "No page-turn animation"}
                    accessibilityState={{ selected: pageCurl === item.val }}
                    style={{
                      flex: 1, height: 48, borderRadius: 12,
                      backgroundColor: pageCurl === item.val ? colors.primary : colors.secondaryContainer,
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: pageCurl === item.val ? colors.onPrimary : colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Reader Theme Control */}
            <View style={{ marginTop: 12, marginBottom: 12 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Reader Theme</Text>
              <View style={{ flexDirection: "row", columnGap: 8 }}>
                {[
                  { key: "auto", label: "Auto" },
                  { key: "light", label: "Light" },
                  { key: "sepia", label: "Sepia" },
                  { key: "dark", label: "Dark" },
                  { key: "black", label: "Black" },
                ].map((item) => {
                  const selected = readerTheme === item.key;
                  const swatch =
                    item.key === "auto" ? colors.surface : (READER_THEMES[item.key]?.bg || colors.surface);
                  const swatchFg =
                    item.key === "auto" ? colors.onSurface : (READER_THEMES[item.key]?.fg || colors.onSurface);
                  return (
                    <Pressable
                      key={item.key}
                      onPress={() => setReaderTheme(item.key)}
                      accessibilityRole="button"
                      accessibilityLabel={`${item.label} theme`}
                      accessibilityState={{ selected }}
                      style={{
                        flex: 1, height: 48, borderRadius: 12,
                        backgroundColor: swatch,
                        borderWidth: selected ? 2 : 1,
                        borderColor: selected ? colors.primary : colors.outlineVariant,
                        alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <Text style={{ color: swatchFg, fontSize: 12, fontWeight: "600" }}>{item.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Margin Control */}
            <View style={{ marginTop: 12, marginBottom: 12 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Margins</Text>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                {READER_MARGINS.map((item) => (
                  <Pressable
                    key={item.label}
                    onPress={() => setReaderMargin(item.val)}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.label} margins`}
                    accessibilityState={{ selected: readerMargin === item.val }}
                    style={{
                      flex: 1, height: 48, borderRadius: 12,
                      backgroundColor: readerMargin === item.val ? colors.primary : colors.secondaryContainer,
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: readerMargin === item.val ? colors.onPrimary : colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Flow Control (paginated vs scrolled) */}
            <View style={{ marginTop: 12, marginBottom: 12 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Layout</Text>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                {[
                  { label: "Paginated", val: "paginated" as const },
                  { label: "Scrolled", val: "scrolled" as const },
                ].map((item) => (
                  <Pressable
                    key={item.label}
                    onPress={() => setReaderFlow(item.val)}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.label} layout`}
                    accessibilityState={{ selected: readerFlow === item.val }}
                    style={{
                      flex: 1, height: 48, borderRadius: 12,
                      backgroundColor: readerFlow === item.val ? colors.primary : colors.secondaryContainer,
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: readerFlow === item.val ? colors.onPrimary : colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Time Left — chapter vs whole-book estimate scope (#1). Only
                changes the footer text, so it applies live with no reload. */}
            <View style={{ marginTop: 12, marginBottom: 12 }}>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Time Left</Text>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                {[
                  { label: "Chapter", val: "chapter" as const },
                  { label: "Book", val: "book" as const },
                ].map((item) => (
                  <Pressable
                    key={item.label}
                    onPress={() => setReaderEstimateScope(item.val)}
                    accessibilityRole="button"
                    accessibilityLabel={`Time left in ${item.label.toLowerCase()}`}
                    accessibilityState={{ selected: readerEstimateScope === item.val }}
                    style={{
                      flex: 1, height: 48, borderRadius: 12,
                      backgroundColor: readerEstimateScope === item.val ? colors.primary : colors.secondaryContainer,
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: readerEstimateScope === item.val ? colors.onPrimary : colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Read-aloud Speed — stepper mirroring the Text Size idiom. Applies
                to the expo-speech `rate` on the next spoken chunk. Only shown
                when TTS is available in this build. */}
            {ttsAvailable ? (
              <View style={{ marginTop: 12, marginBottom: 12 }}>
                <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 12 }}>Read-aloud Speed</Text>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Pressable
                    onPress={() => setTtsRate((prev) => Math.max(TTS_RATE_MIN, Math.round((prev - TTS_RATE_STEP) * 10) / 10))}
                    disabled={ttsRate <= TTS_RATE_MIN}
                    accessibilityRole="button"
                    accessibilityLabel="Decrease read-aloud speed"
                    accessibilityState={{ disabled: ttsRate <= TTS_RATE_MIN }}
                    style={{
                      width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer,
                      alignItems: "center", justifyContent: "center",
                      opacity: ttsRate <= TTS_RATE_MIN ? 0.4 : 1,
                    }}
                  >
                    <Text style={{ color: colors.onSecondaryContainer, fontSize: 20, fontWeight: "700" }}>-</Text>
                  </Pressable>
                  {/* Live region: each +/- step announces the new speed. */}
                  <Text
                    accessibilityLiveRegion="polite"
                    style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600" }}
                  >
                    {ttsRate.toFixed(1)}x
                  </Text>
                  <Pressable
                    onPress={() => setTtsRate((prev) => Math.min(TTS_RATE_MAX, Math.round((prev + TTS_RATE_STEP) * 10) / 10))}
                    disabled={ttsRate >= TTS_RATE_MAX}
                    accessibilityRole="button"
                    accessibilityLabel="Increase read-aloud speed"
                    accessibilityState={{ disabled: ttsRate >= TTS_RATE_MAX }}
                    style={{
                      width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer,
                      alignItems: "center", justifyContent: "center",
                      opacity: ttsRate >= TTS_RATE_MAX ? 0.4 : 1,
                    }}
                  >
                    <Text style={{ color: colors.onSecondaryContainer, fontSize: 20, fontWeight: "700" }}>+</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
        </ScrollView>
      </BottomSheet>

      {/* In-book Search */}
      <BottomSheet visible={showSearch} onClose={() => setShowSearch(false)} showHandle={false}>
        <View style={{ padding: 16, paddingBottom: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700" }}>Search in Book</Text>
            <Pressable
              onPress={() => setShowSearch(false)}
              hitSlop={8}
              style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" }}
              accessibilityRole="button"
              accessibilityLabel="Close search"
            >
              <Icon name="close" size={24} color={colors.onSurface} />
            </Pressable>
          </View>
          {searchAvailable ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", columnGap: 8, marginBottom: 12 }}>
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  onSubmitEditing={() => runSearch(searchQuery)}
                  placeholder="Search text…"
                  placeholderTextColor={colors.onSurfaceVariant}
                  returnKeyType="search"
                  accessibilityLabel="Search query"
                  style={{
                    flex: 1, height: 44, borderRadius: 12, paddingHorizontal: 12,
                    backgroundColor: colors.secondaryContainer, color: colors.onSurface, fontSize: 15,
                  }}
                />
                <Pressable
                  onPress={() => runSearch(searchQuery)}
                  accessibilityRole="button"
                  accessibilityLabel="Run search"
                  style={{
                    height: 44, paddingHorizontal: 16, borderRadius: 12, backgroundColor: colors.primary,
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Icon name="search" size={20} color={colors.onPrimary} />
                </Pressable>
              </View>
              {searching ? (
                <View style={{ paddingVertical: 24, alignItems: "center" }}>
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
              ) : searchResults.length > 0 ? (
                <FlatList
                  data={searchResults}
                  keyExtractor={(_, index) => String(index)}
                  style={{ maxHeight: 320 }}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => (
                    <Pressable
                      onPress={() => goToSearchResult(item.cfi)}
                      accessibilityRole="button"
                      accessibilityLabel={item.excerpt || "Search result"}
                      style={{
                        paddingVertical: 12, paddingHorizontal: 4,
                        borderBottomWidth: 1, borderBottomColor: colors.outlineVariant,
                      }}
                    >
                      {item.label ? (
                        <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginBottom: 2 }}>{item.label}</Text>
                      ) : null}
                      <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 14 }}>
                        {item.excerpt || item.cfi}
                      </Text>
                    </Pressable>
                  )}
                />
              ) : (
                <View style={{ paddingVertical: 24, alignItems: "center" }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>
                    {searchQuery ? "No matches." : "Type a word or phrase to search."}
                  </Text>
                </View>
              )}
            </>
          ) : (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>Search isn't available for this book.</Text>
            </View>
          )}
        </View>
      </BottomSheet>

      {/* Highlights list */}
      <BottomSheet visible={showHighlights} onClose={() => setShowHighlights(false)} showHandle={false}>
        <View style={{ paddingBottom: 16 }}>
          <View
            style={{
              flexDirection: "row", alignItems: "center", justifyContent: "space-between",
              padding: 16, borderBottomWidth: 1, borderBottomColor: colors.outlineVariant,
            }}
          >
            <View>
              <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700" }}>Highlights</Text>
              {/* Highlights live only on this device — nothing syncs them to the
                  server, so say so plainly instead of implying cross-device. */}
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>Saved on this device</Text>
            </View>
            <Pressable
              onPress={() => setShowHighlights(false)}
              hitSlop={8}
              style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" }}
              accessibilityRole="button"
              accessibilityLabel="Close highlights"
            >
              <Icon name="close" size={24} color={colors.onSurface} />
            </Pressable>
          </View>
          {highlights.length > 0 ? (
            <FlatList
              data={[...highlights].sort((a, b) => b.at - a.at)}
              keyExtractor={(item) => item.cfi}
              style={{ maxHeight: 360 }}
              contentContainerStyle={{ paddingVertical: 8 }}
              renderItem={({ item }) => (
                <View
                  style={{
                    flexDirection: "row", alignItems: "center",
                    paddingVertical: 12, paddingHorizontal: 16,
                    borderBottomWidth: 1, borderBottomColor: colors.outlineVariant,
                  }}
                >
                  <Pressable
                    onPress={() => {
                      goToSearchResult(item.cfi);
                      setShowHighlights(false);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={item.text}
                    style={{ flex: 1 }}
                  >
                    <Text numberOfLines={3} style={{ color: colors.onSurface, fontSize: 14 }}>{item.text}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => removeHighlight(item.cfi)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Delete highlight"
                    style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", marginLeft: 8 }}
                  >
                    <Icon name="trash" size={20} color={colors.onSurfaceVariant} />
                  </Pressable>
                </View>
              )}
            />
          ) : (
            <View style={{ padding: 48, alignItems: "center" }}>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 15 }}>No highlights yet.</Text>
            </View>
          )}
        </View>
      </BottomSheet>

      {/* Text-selection action sheet (dictionary / highlight / share) */}
      <BottomSheet visible={!!selection} onClose={() => setSelection(null)} showHandle={false}>
        <View style={{ padding: 20, paddingBottom: 20 }}>
          <Text numberOfLines={4} style={{ color: colors.onSurface, fontSize: 15, fontStyle: "italic", marginBottom: 16 }}>
            {selection ? `"${selection.text}"` : ""}
          </Text>
          <View style={{ flexDirection: "row", columnGap: 12 }}>
            <Pressable
              onPress={() => selection && lookUpWord(selection.text)}
              accessibilityRole="button"
              accessibilityLabel="Search the web"
              style={{
                flex: 1, height: 48, borderRadius: 12, backgroundColor: colors.secondaryContainer,
                alignItems: "center", justifyContent: "center", flexDirection: "row", columnGap: 6,
              }}
            >
              {/* This opens a Google web search via Linking — not an on-device
                  dictionary — so it's labelled honestly (#9). */}
              <Icon name="globe" size={18} color={colors.onSecondaryContainer} />
              <Text style={{ color: colors.onSecondaryContainer, fontSize: 14, fontWeight: "600" }}>Search the web</Text>
            </Pressable>
            <Pressable
              onPress={addHighlightFromSelection}
              accessibilityRole="button"
              accessibilityLabel="Highlight"
              style={{
                flex: 1, height: 48, borderRadius: 12, backgroundColor: colors.secondaryContainer,
                alignItems: "center", justifyContent: "center", flexDirection: "row", columnGap: 6,
              }}
            >
              {/* Marker/edit glyph — distinct from the `bookmark` used for audio
                  bookmarks and the TOC "you are here" marker (#8). */}
              <Icon name="edit" size={18} color={colors.onSecondaryContainer} />
              <Text style={{ color: colors.onSecondaryContainer, fontSize: 14, fontWeight: "600" }}>Highlight</Text>
            </Pressable>
            <Pressable
              onPress={() => selection && shareQuote(selection.text)}
              accessibilityRole="button"
              accessibilityLabel="Share quote"
              style={{
                flex: 1, height: 48, borderRadius: 12, backgroundColor: colors.secondaryContainer,
                alignItems: "center", justifyContent: "center", flexDirection: "row", columnGap: 6,
              }}
            >
              <Icon name="share" size={18} color={colors.onSecondaryContainer} />
              <Text style={{ color: colors.onSecondaryContainer, fontSize: 14, fontWeight: "600" }}>Share</Text>
            </Pressable>
          </View>
        </View>
      </BottomSheet>
    </SafeAreaView>
  );
}
