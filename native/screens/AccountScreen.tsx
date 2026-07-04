import React from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { useUserStore } from "../store/useUserStore";
import Icon from "../components/Icon";

const GITHUB_URL = "https://github.com/AwsomeFox/tomesonic-app";

/**
 * Account screen mirroring the original tomesonic pages/account.vue and
 * reference screenshot 12: read-only Host + Username fields, "Server version:
 * vX", a "Switch Server/User" link (logout), and a GitHub footer.
 */
export default function AccountScreen({ navigation }: any) {
  const colors = useThemeColors();
  const { user, serverConnectionConfig, logout } = useUserStore();

  const serverAddress = serverConnectionConfig?.address || "";
  const username =
    user?.username || serverConnectionConfig?.username || "";
  const serverVersion = serverConnectionConfig?.version
    ? String(serverConnectionConfig.version).replace(/^v/, "")
    : "";

  const handleSwitch = () => {
    // logout flips useUserStore.user to null → navigator swaps to Connect
    logout();
  };

  // Read-only field with a label above (matches ui-text-input-with-label)
  const LabeledField = ({ label, value }: { label: string; value: string }) => (
    <View style={{ marginBottom: 16 }}>
      <Text
        style={{
          color: colors.onSurface,
          fontSize: 16,
          fontWeight: "700",
          marginBottom: 8,
        }}
      >
        {label}
      </Text>
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.outline,
          borderRadius: 16,
          paddingHorizontal: 20,
          paddingVertical: 18,
        }}
      >
        <Text
          style={{ color: colors.onSurface, fontSize: 20 }}
          numberOfLines={1}
        >
          {value}
        </Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Header with back arrow */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingTop: 8,
          paddingBottom: 12,
          paddingHorizontal: 16,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          style={{ paddingRight: 16, paddingVertical: 4 }}
        >
          <Icon name="back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text
          style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600", flex: 1 }}
        >
          Account
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 }}
      >
        <LabeledField label="Host" value={serverAddress} />
        <LabeledField label="Username" value={username} />

        {serverVersion ? (
          <Text style={{ color: colors.onSurface, fontSize: 15 }}>
            Server version: v{serverVersion}
          </Text>
        ) : null}

        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 28,
          }}
        >
          {/* User Stats link */}
          <Pressable
            onPress={() => navigation.navigate("Stats")}
            style={{
              flexDirection: "row",
              alignItems: "center",
            }}
            hitSlop={8}
          >
            <Icon name="stats" size={20} color={colors.primary} style={{ marginRight: 8 }} />
            <Text
              style={{ color: colors.primary, fontSize: 16, fontWeight: "700" }}
            >
              User Stats
            </Text>
          </Pressable>

          {/* Switch Server/User — logout icon */}
          <Pressable
            onPress={handleSwitch}
            style={{
              flexDirection: "row",
              alignItems: "center",
            }}
            hitSlop={8}
          >
            <Text
              style={{ color: colors.primary, fontSize: 16, fontWeight: "700", marginRight: 8 }}
            >
              Switch Server/User
            </Text>
            <Icon name="logout" size={20} color={colors.primary} />
          </Pressable>
        </View>
      </ScrollView>

      {/* Footer — report bugs on GitHub */}
      <Pressable
        onPress={() => Linking.openURL(GITHUB_URL)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 16,
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ color: colors.onSurface, fontSize: 14, textAlign: "center" }}>
          Report bugs, request features, and contribute on{" "}
          <Text style={{ textDecorationLine: "underline" }}>GitHub</Text>
        </Text>
        <View style={{ marginLeft: 10 }}>
          <Icon name="globe" size={22} color={colors.onSurface} />
        </View>
      </Pressable>
    </SafeAreaView>
  );
}
