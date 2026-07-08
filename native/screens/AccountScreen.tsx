import React from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Linking,
  Alert,
  TextInput,
  Modal,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { api } from "../utils/api";
import Icon from "../components/Icon";

const GITHUB_URL = "https://github.com/AwsomeFox/tomesonic-app";

/**
 * Account screen mirroring the original tomesonic pages/account.vue and
 * reference screenshot 12: read-only Host + Username fields, "Server version:
 * vX", a "Switch Server/User" link (logout), and a GitHub footer.
 */
export default function AccountScreen({ navigation }: any) {
  const colors = useThemeColors();
  const { user, serverConnectionConfig, logout, updateServerAddress } = useUserStore();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);

  const serverAddress = serverConnectionConfig?.address || "";
  const username =
    user?.username || serverConnectionConfig?.username || "";
  const serverVersion = serverConnectionConfig?.version
    ? String(serverConnectionConfig.version).replace(/^v/, "")
    : "";

  // OpenID/SSO accounts have no local password to change — the "Change
  // Password" row would just 400. Gate on any openid signal persisted into the
  // session config at login time. (No such field is written today; see the
  // report note — until the login flow persists `authMethod`, this stays a
  // no-op for local accounts, which is the safe default: the row keeps showing.)
  const isOpenIdSession =
    serverConnectionConfig?.authMethod === "openid" ||
    serverConnectionConfig?.authMethod === "oauth" ||
    serverConnectionConfig?.openid === true ||
    serverConnectionConfig?.isOpenid === true;

  const handleSwitch = () => {
    Alert.alert(
      "Switch Server / User",
      // Name the real consequence: logout wipes every downloaded book and the
      // cached progress on this device (via removeAllDownloads), not just the
      // session. Without this, "you'll need to log in again" hid a data-loss trap.
      "Logging out deletes all downloaded books and cached progress on this device. You'll need to sign in again and re-download them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Log Out", style: "destructive", onPress: () => logout() }
      ]
    );
  };

  const [showAddressModal, setShowAddressModal] = React.useState(false);
  const [newAddress, setNewAddress] = React.useState("");
  const [savingAddress, setSavingAddress] = React.useState(false);

  const openAddressModal = () => {
    setNewAddress(serverAddress);
    setShowAddressModal(true);
  };

  const handleSaveAddress = async () => {
    if (savingAddress) return;
    setSavingAddress(true);
    try {
      const res = await updateServerAddress(newAddress);
      if (res.ok) {
        setShowAddressModal(false);
        Alert.alert("Server updated", "Your server address was updated. Your downloads and progress are unchanged.");
      } else {
        Alert.alert("Couldn't update server", res.error || "Please check the address and try again.");
      }
    } finally {
      setSavingAddress(false);
    }
  };

  const [showPasswordModal, setShowPasswordModal] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [changingPassword, setChangingPassword] = React.useState(false);

  // Always drop typed passwords when the sheet closes (Cancel/back included) —
  // they must never sit in state longer than the change attempt itself.
  const closePasswordModal = () => {
    setShowPasswordModal(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      Alert.alert("Error", "Please fill in all fields.");
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert("Error", "New passwords do not match.");
      return;
    }
    try {
      setChangingPassword(true);
      await api.patch("/api/me/password", {
        password: currentPassword,
        newPassword: newPassword,
      });
      Alert.alert("Success", "Password changed successfully!");
      closePasswordModal();
    } catch (err: any) {
      console.warn("[Account] Change password failed:", err);
      const msg = err?.response?.data || err?.message || "Failed to update password.";
      Alert.alert("Error", typeof msg === "string" ? msg : "Failed to change password. Make sure your current password is correct.");
    } finally {
      setChangingPassword(false);
    }
  };

  // Read-only field with a label above (matches ui-text-input-with-label)
  const LabeledField = ({ label, value }: { label: string; value: string }) => (
    <View
      style={{ marginBottom: 16 }}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
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
          accessibilityRole="button"
          accessibilityLabel="Go back"
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
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: hasSession ? 100 : 24 }}
      >
        <LabeledField label="Host" value={serverAddress} />
        <LabeledField label="Username" value={username} />

        {serverVersion ? (
          <Text style={{ color: colors.onSurface, fontSize: 15 }}>
            Server version: v{serverVersion}
          </Text>
        ) : null}

        {/* Change Password row — hidden for OpenID/SSO sessions, which have no
            local password (the row would just fail against /api/me/password). */}
        {isOpenIdSession ? null : (
          <Pressable
            onPress={() => setShowPasswordModal(true)}
            accessibilityRole="button"
            accessibilityLabel="Change Password"
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginTop: 20,
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderRadius: 16,
              backgroundColor: colors.surfaceContainer || colors.surfaceVariant,
              borderWidth: 1,
              borderColor: colors.outlineVariant || colors.outline,
            }}
          >
            <Icon name="lock" size={22} color={colors.primary} style={{ marginRight: 12 }} />
            <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600", flex: 1 }}>
              Change Password
            </Text>
            <Icon name="chevron-right" size={20} color={colors.onSurfaceVariant} />
          </Pressable>
        )}

        {/* Edit server address — same account moved (DNS/IP/proxy/scheme). This
            updates the address in place, keeping downloads + progress (unlike
            Switch Server, which logs out and wipes them). */}
        <Pressable
          onPress={openAddressModal}
          accessibilityRole="button"
          accessibilityLabel="Edit server address"
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginTop: 12,
            paddingVertical: 14,
            paddingHorizontal: 16,
            borderRadius: 16,
            backgroundColor: colors.surfaceContainer || colors.surfaceVariant,
            borderWidth: 1,
            borderColor: colors.outlineVariant || colors.outline,
          }}
        >
          <Icon name="globe" size={22} color={colors.primary} style={{ marginRight: 12 }} />
          <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600", flex: 1 }}>
            Edit server address
          </Text>
          <Icon name="chevron-right" size={20} color={colors.onSurfaceVariant} />
        </Pressable>

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
            accessibilityRole="button"
            accessibilityLabel="User Stats"
            style={{
              flexDirection: "row",
              alignItems: "center",
              // Reach the 48dp minimum touch target (icon+text is only ~20dp tall).
              minHeight: 48,
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
            accessibilityRole="button"
            accessibilityLabel="Switch server or user"
            style={{
              flexDirection: "row",
              alignItems: "center",
              minHeight: 48,
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
        accessibilityRole="link"
        accessibilityLabel="Report bugs, request features, and contribute on GitHub"
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
      {/* Edit Server Address Modal */}
      <Modal
        visible={showAddressModal}
        animationType="fade"
        transparent
        onRequestClose={() => setShowAddressModal(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 }}>
          <View style={{ backgroundColor: colors.surfaceContainer || colors.surfaceVariant, borderRadius: 28, padding: 24, elevation: 5 }}>
            <Text style={{ color: colors.onSurface, fontSize: 24, fontWeight: "600", marginBottom: 8 }}>
              Edit server address
            </Text>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginBottom: 20 }}>
              Use this when your server moved (new domain, IP, or port) but it's the same
              account. Your downloads and progress are kept. To sign into a different
              server or account, use Switch Server instead.
            </Text>

            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "500", marginBottom: 6 }}>
              Server address
            </Text>
            <TextInput
              value={newAddress}
              onChangeText={setNewAddress}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://abs.example.com"
              placeholderTextColor={colors.onSurfaceVariant}
              accessibilityLabel="Server address"
              style={{
                backgroundColor: colors.surface,
                color: colors.onSurface,
                borderRadius: 12,
                padding: 12,
                fontSize: 16,
                borderWidth: 1,
                borderColor: colors.outline,
                marginBottom: 24,
              }}
            />

            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <Pressable
                onPress={() => setShowAddressModal(false)}
                accessibilityRole="button"
                style={{ paddingHorizontal: 20, paddingVertical: 12, marginRight: 8 }}
              >
                <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "600" }}>Cancel</Text>
              </Pressable>

              <Pressable
                onPress={handleSaveAddress}
                disabled={savingAddress}
                accessibilityRole="button"
                accessibilityLabel="Save server address"
                accessibilityState={{ disabled: savingAddress, busy: savingAddress }}
                style={{
                  backgroundColor: colors.primary,
                  paddingHorizontal: 20,
                  paddingVertical: 12,
                  borderRadius: 24,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                {savingAddress ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} style={{ marginRight: 8 }} />
                ) : null}
                <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600" }}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Change Password Modal */}
      <Modal
        visible={showPasswordModal}
        animationType="fade"
        transparent
        onRequestClose={closePasswordModal}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 }}>
          <View style={{ backgroundColor: colors.surfaceContainer || colors.surfaceVariant, borderRadius: 28, padding: 24, elevation: 5 }}>
            <Text style={{ color: colors.onSurface, fontSize: 24, fontWeight: "600", marginBottom: 20 }}>
              Change Password
            </Text>

            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "500", marginBottom: 6 }}>
              Current Password
            </Text>
            <TextInput
              secureTextEntry
              value={currentPassword}
              onChangeText={setCurrentPassword}
              accessibilityLabel="Current Password"
              style={{
                backgroundColor: colors.surface,
                color: colors.onSurface,
                borderRadius: 12,
                padding: 12,
                fontSize: 16,
                borderWidth: 1,
                borderColor: colors.outline,
                marginBottom: 16,
              }}
            />

            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "500", marginBottom: 6 }}>
              New Password
            </Text>
            <TextInput
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
              accessibilityLabel="New Password"
              style={{
                backgroundColor: colors.surface,
                color: colors.onSurface,
                borderRadius: 12,
                padding: 12,
                fontSize: 16,
                borderWidth: 1,
                borderColor: colors.outline,
                marginBottom: 16,
              }}
            />

            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "500", marginBottom: 6 }}>
              Confirm New Password
            </Text>
            <TextInput
              secureTextEntry
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              accessibilityLabel="Confirm New Password"
              style={{
                backgroundColor: colors.surface,
                color: colors.onSurface,
                borderRadius: 12,
                padding: 12,
                fontSize: 16,
                borderWidth: 1,
                borderColor: colors.outline,
                marginBottom: 24,
              }}
            />

            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <Pressable
                onPress={closePasswordModal}
                accessibilityRole="button"
                style={{ paddingHorizontal: 20, paddingVertical: 12, marginRight: 8 }}
              >
                <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "600" }}>Cancel</Text>
              </Pressable>

              <Pressable
                onPress={handleChangePassword}
                disabled={changingPassword}
                accessibilityRole="button"
                accessibilityLabel="Save"
                accessibilityState={{ disabled: changingPassword, busy: changingPassword }}
                style={{
                  backgroundColor: colors.primary,
                  paddingHorizontal: 20,
                  paddingVertical: 12,
                  borderRadius: 24,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                {changingPassword ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} style={{ marginRight: 8 }} />
                ) : null}
                <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600" }}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
