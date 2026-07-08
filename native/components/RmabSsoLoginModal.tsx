import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Modal, ActivityIndicator, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Pressable from "./HintPressable";
import { RmabConfig, parseRmabAuthData, rmabOidcLoginUrl, rmabOrigin } from "../utils/rmab";

// Loaded lazily so a build without the native module still bundles (mirrors
// ReaderScreen). Null → we render a "use a token instead" fallback.
let WebView: any = null;
try {
  WebView = require("react-native-webview").WebView;
} catch (e) {
  WebView = null;
}

// Google's OAuth screens reject the default Android WebView user-agent with
// "Error 403: disallowed_useragent" (their "Use secure browsers" policy),
// which breaks sign-in for any IdP that federates to Google (e.g. a
// TrueNAS/Authentik provider configured with "Sign in with Google"). The
// default Android WebView UA is flagged by its "; wv" marker; presenting a
// standard Chrome mobile UA (no "wv") lets those federated flows proceed.
// This is a pragmatic workaround — the fully robust path is the system
// browser (Custom Tabs) with an app redirect, which needs RMAB server support.
const SSO_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

// Reads the JWT bundle RMAB leaves in the URL hash
// (`#authData=<uri-encoded JSON>`) after a successful OIDC round-trip and posts
// it back to RN. Injected ONLY on the RMAB origin (never on the IdP), and re-run
// on every navigation. Returns true so the WebView doesn't warn about the value.
const CAPTURE_JS = `(function(){try{
  var h = window.location.hash || "";
  var m = h.match(/authData=([^&]+)/);
  if (m && window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ authData: m[1] }));
  }
}catch(e){} true;})();`;

/**
 * Full-screen OIDC sign-in for ReadMeABook. A user who can log into the shared
 * IdP (e.g. Authentik) gets a working JWT session without an admin handing them
 * a one-time login URL — and it's the same flow used to re-authenticate when a
 * session expires. Drives the server's browser-oriented `/api/auth/oidc/login`
 * in a WebView and captures the JWT pair the callback exposes in the URL hash.
 */
export default function RmabSsoLoginModal({
  visible,
  serverUrl,
  onClose,
  onSuccess,
  onError,
}: {
  visible: boolean;
  serverUrl: string;
  onClose: () => void;
  onSuccess: (cfg: RmabConfig) => void;
  onError?: (message: string) => void;
}) {
  const colors = useThemeColors();
  // Root-provider insets via the hook — a native SafeAreaView inside a
  // statusBarTranslucent Modal computes its OWN window and comes back 0 on
  // Android edge-to-edge, clipping the header/content under the system bars
  // (same reason BottomSheet avoids SafeAreaView-in-Modal).
  const insets = useSafeAreaInsets();
  const webRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  // Guard so the one-shot success fires exactly once per open (the capture JS
  // re-runs on every navigation and could post the same hash twice).
  const doneRef = useRef(false);

  const origin = useMemo(() => rmabOrigin(serverUrl), [serverUrl]);
  const loginUrl = useMemo(() => rmabOidcLoginUrl(serverUrl), [serverUrl]);

  useEffect(() => {
    if (visible) {
      doneRef.current = false;
      setLoading(true);
    }
  }, [visible]);

  const onNavigationStateChange = (nav: any) => {
    // Compare EXACT origins — a prefix check (indexOf === 0) would also match a
    // look-alike host like `https://rmab.test.evil.com`, injecting on the wrong
    // origin. Parse the nav URL's origin and require an exact match, so the
    // capture only ever runs once we're genuinely back on the RMAB server (never
    // on the IdP). This is also the ONLY place we inject — there's no blanket
    // injectedJavaScript that would run on every IdP page in the redirect chain.
    let navOrigin: string | null = null;
    try {
      navOrigin = new URL(nav?.url || "").origin;
    } catch {}
    if (origin && navOrigin === origin) {
      webRef.current?.injectJavaScript(CAPTURE_JS);
    }
  };

  const onMessage = (e: any) => {
    if (doneRef.current) return;
    let raw: string | undefined;
    try {
      raw = JSON.parse(e?.nativeEvent?.data)?.authData;
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const cfg = parseRmabAuthData(serverUrl, raw);
      doneRef.current = true;
      onSuccess(cfg);
    } catch {
      doneRef.current = true;
      onError?.("Could not read the sign-in response.");
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.outlineVariant,
          }}
        >
          <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600" }}>Sign in</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel sign-in"
            // Small text button (paddingVertical 4) — grow the touch target so
            // cancelling doesn't demand a precise tap on the label.
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            android_ripple={{ color: withAlpha(colors.onSurface, 0.13), borderless: true }}
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "600" }}>Cancel</Text>
          </Pressable>
        </View>

        {!visible ? null : WebView && loginUrl ? (
          // Gated on `visible` so the WebView UNMOUNTS on close — otherwise a
          // hidden Modal keeps the finished /login#authData page alive and a
          // reopen could re-post the stale token. Remounting reloads a fresh
          // OIDC flow every time.
          <View style={{ flex: 1 }}>
            <WebView
              ref={webRef}
              source={{ uri: loginUrl }}
              // Present a real Chrome UA so Google-federated IdP sign-in isn't
              // blocked as "disallowed_useragent" (see SSO_USER_AGENT above).
              userAgent={SSO_USER_AGENT}
              applicationNameForUserAgent="Chrome/125.0.0.0"
              onNavigationStateChange={onNavigationStateChange}
              onMessage={onMessage}
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              onLoadEnd={() => setLoading(false)}
              style={{ flex: 1, backgroundColor: colors.surface }}
            />
            {loading ? (
              <View
                // A bare ActivityIndicator is invisible to assistive tech —
                // announce it as a live progress indicator so a screen-reader
                // user knows sign-in is loading rather than facing silence.
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel="Loading sign-in"
                accessibilityLiveRegion="polite"
                style={[
                  StyleSheet.absoluteFill,
                  { alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
                ]}
              >
                <ActivityIndicator size="large" color={colors.primary} />
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>
              {loginUrl
                ? "In-app sign-in isn't available in this build. Connect with a login token or API token instead."
                : "Enter your ReadMeABook server address first."}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
