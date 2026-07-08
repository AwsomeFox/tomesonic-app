import React, { useState } from "react";
import { View, Text } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "./Icon";
import Pressable from "./HintPressable";
import RmabSsoLoginModal from "./RmabSsoLoginModal";
import { useRmabStore } from "../store/useRmabStore";

/**
 * Shown across the RMAB surfaces once a session's refresh token is rejected
 * (`sessionExpired`). Without it a dead session looks connected while every
 * call silently fails. For OIDC sessions the "Sign in again" button relaunches
 * the SSO WebView in place — likely one tap through a live IdP session — and
 * finishes via connectWithOidc. Token/API-key sessions can't re-auth silently,
 * so they defer to `onManualReconnect` (the host opens the connect sheet or
 * routes to Settings).
 */
export default function RmabSessionExpiredBanner({
  onManualReconnect,
}: {
  onManualReconnect?: () => void;
}) {
  const colors = useThemeColors();
  const sessionExpired = useRmabStore((s) => s.sessionExpired);
  const serverUrl = useRmabStore((s) => s.serverUrl);
  const authProvider = useRmabStore((s) => s.authProvider);
  const connectWithOidc = useRmabStore((s) => s.connectWithOidc);
  const [ssoOpen, setSsoOpen] = useState(false);

  if (!sessionExpired) return null;

  const canSso = authProvider === "oidc" && !!serverUrl;
  const onPress = () => {
    if (canSso) setSsoOpen(true);
    else onManualReconnect?.();
  };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: colors.secondaryContainer,
        borderRadius: 14,
        paddingVertical: 12,
        paddingHorizontal: 14,
        marginHorizontal: 16,
        marginTop: 12,
      }}
    >
      <Icon name="warning" size={20} color={colors.onSecondaryContainer} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ color: colors.onSecondaryContainer, fontSize: 14, fontWeight: "600" }}>
          Session expired
        </Text>
        <Text style={{ color: colors.onSecondaryContainer, fontSize: 12, marginTop: 1 }}>
          Sign in again to keep requesting books.
        </Text>
      </View>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Sign in again to ReadMeABook"
        android_ripple={{ color: withAlpha(colors.onPrimary, 0.13) }}
        style={{
          backgroundColor: colors.primary,
          borderRadius: 20,
          height: 36,
          paddingHorizontal: 16,
          alignItems: "center",
          justifyContent: "center",
          marginLeft: 8,
        }}
      >
        <Text style={{ color: colors.onPrimary, fontSize: 13, fontWeight: "600" }}>Sign in</Text>
      </Pressable>

      {canSso ? (
        <RmabSsoLoginModal
          visible={ssoOpen}
          serverUrl={serverUrl as string}
          onClose={() => setSsoOpen(false)}
          onSuccess={async (cfg) => {
            setSsoOpen(false);
            // If the OIDC connect fails, the banner would otherwise linger (or
            // the session gets wiped) with no feedback — fall back to the manual
            // reconnect path so the user gets a visible error and a retry.
            const ok = await connectWithOidc(cfg);
            if (!ok) onManualReconnect?.();
          }}
          onError={() => {
            // Parse failure: same fallback so it isn't a silent dead end.
            setSsoOpen(false);
            onManualReconnect?.();
          }}
        />
      ) : null}
    </View>
  );
}
