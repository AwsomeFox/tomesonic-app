import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Modal, ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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
    const url: string = nav?.url || "";
    // Only probe for the token once we're back on the RMAB origin — never run
    // the capture on IdP pages, so their cookies/URLs are never read.
    if (origin && url.indexOf(origin) === 0) {
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
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
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
            android_ripple={{ color: withAlpha(colors.onSurface, 0.13), borderless: true }}
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "600" }}>Cancel</Text>
          </Pressable>
        </View>

        {WebView && loginUrl ? (
          <View style={{ flex: 1 }}>
            <WebView
              ref={webRef}
              source={{ uri: loginUrl }}
              onNavigationStateChange={onNavigationStateChange}
              onMessage={onMessage}
              injectedJavaScript={CAPTURE_JS}
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              onLoadEnd={() => setLoading(false)}
              style={{ flex: 1, backgroundColor: colors.surface }}
            />
            {loading ? (
              <View
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
      </SafeAreaView>
    </Modal>
  );
}
