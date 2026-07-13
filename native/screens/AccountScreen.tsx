import React from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Linking,
  TextInput,
  Modal,
  ActivityIndicator,
  Platform,
  AccessibilityInfo,
  findNodeHandle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { api } from "../utils/api";
import { updateMyEreaderDevices } from "../utils/abs/me";
import { useServerCapabilities } from "../utils/abs/capabilities";
import type { AbsEreaderDevice } from "../utils/abs/types";
import Icon from "../components/Icon";

const GITHUB_URL = "https://github.com/AwsomeFox/tomesonic-app";

/**
 * On-open focus + announce for this screen's bespoke RN Modals, mirroring
 * AppDialog: accessibilityViewIsModal is iOS-only, so on Android nothing would
 * grab TalkBack focus or announce the modal otherwise. Returns the ref to put
 * on the modal's title <Text> (which also carries accessibilityRole="header").
 */
function useModalA11y(visible: boolean, announcement: string) {
  const titleRef = React.useRef<Text>(null);
  React.useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      if (Platform.OS === "android") {
        const node = findNodeHandle(titleRef.current);
        if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
      }
      if (announcement) AccessibilityInfo.announceForAccessibility(announcement);
    }, 50);
    return () => clearTimeout(t);
  }, [visible, announcement]);
  return titleRef;
}

/**
 * Account screen mirroring the original tomesonic pages/account.vue and
 * reference screenshot 12: read-only Host + Username fields, "Server version:
 * vX", a "Switch Server/User" link (logout), and a GitHub footer.
 */
export default function AccountScreen({ navigation }: any) {
  const colors = useThemeColors();
  const { user, serverConnectionConfig, logout, updateServerAddress, ereaderDevices } =
    useUserStore();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);

  const serverAddress = serverConnectionConfig?.address || "";
  const username =
    user?.username || serverConnectionConfig?.username || "";
  const serverVersion = serverConnectionConfig?.version
    ? String(serverConnectionConfig.version).replace(/^v/, "")
    : "";

  // OpenID/SSO accounts have no local password to change — the "Change
  // Password" row would just 400. ConnectScreen.finishLogin persists
  // `authMethod` ("local" | "openid") into the session config at login, so we
  // gate on that (plus a couple of tolerant fallbacks). Absent any openid
  // signal we default to showing the row (the safe local-account default).
  const isOpenIdSession =
    serverConnectionConfig?.authMethod === "openid" ||
    serverConnectionConfig?.authMethod === "oauth" ||
    serverConnectionConfig?.openid === true ||
    serverConnectionConfig?.isOpenid === true;

  const handleSwitch = () => {
    showAppDialog({
      title: "Switch Server / User",
      // Downloads are now namespaced per account and RETAINED on logout/switch
      // (re-adopted when you sign back into the same server + user), so this is
      // no longer a data-loss action — just a session change.
      message: "You'll be signed out and can connect to a different server or account. Your downloaded books stay on this device and reappear when you sign back into this account.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Log Out", onPress: () => logout() }
      ]
    });
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
        showAppDialog({ title: "Server updated", message: "Your server address was updated. Your downloads and progress are unchanged." });
      } else {
        showAppDialog({ title: "Couldn't update server", message: res.error || "Please check the address and try again." });
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
      showAppDialog({ title: "Error", message: "Please fill in all fields." });
      return;
    }
    if (newPassword !== confirmPassword) {
      showAppDialog({ title: "Error", message: "New passwords do not match." });
      return;
    }
    try {
      setChangingPassword(true);
      await api.patch("/api/me/password", {
        password: currentPassword,
        newPassword: newPassword,
      });
      showAppDialog({ title: "Success", message: "Password changed successfully!" });
      closePasswordModal();
    } catch (err: any) {
      console.warn("[Account] Change password failed:", err);
      const msg = err?.response?.data || err?.message || "Failed to update password.";
      showAppDialog({ title: "Error", message: typeof msg === "string" ? msg : "Failed to change password. Make sure your current password is correct." });
    } finally {
      setChangingPassword(false);
    }
  };

  // ---------------------------------------------------------------------
  // Per-user e-reader devices (Send-to-Kindle etc.), managed via
  // POST /api/me/ereader-devices. The store's ereaderDevices (from
  // /api/authorize) mixes MY self-managed devices with server-wide ones an
  // admin configured; only the former are editable here. A "mine" device is
  // exactly what the server will accept back: availabilityOption
  // "specificUsers" with only my user id.
  // ---------------------------------------------------------------------
  const myUserId = user?.id || serverConnectionConfig?.userId || "";
  const isMyDevice = React.useCallback(
    (d: any) =>
      d?.availabilityOption === "specificUsers" &&
      Array.isArray(d?.users) &&
      d.users.length === 1 &&
      d.users[0] === myUserId,
    [myUserId]
  );
  const allDevices: any[] = Array.isArray(ereaderDevices) ? ereaderDevices : [];
  const myDevices = allDevices.filter(isMyDevice);
  const sharedDevices = allDevices.filter((d) => !isMyDevice(d));
  // permissions.createEreader gates self-managed devices server-side —
  // consumed through the shared capabilities module (canCreateEreader is true
  // unless the permission is EXPLICITLY false, so the cold-restore thin user
  // still sees the section; a wrong guess just surfaces as a 403 on save).
  const capabilities = useServerCapabilities();
  const canManageDevices = !!myUserId && capabilities.canCreateEreader;

  const [showDeviceModal, setShowDeviceModal] = React.useState(false);
  // null = adding a new device; a number = index into myDevices being edited.
  const [editingDeviceIndex, setEditingDeviceIndex] = React.useState<number | null>(null);
  const [deviceName, setDeviceName] = React.useState("");
  const [deviceEmail, setDeviceEmail] = React.useState("");
  const [savingDevice, setSavingDevice] = React.useState(false);

  const openAddDevice = () => {
    setEditingDeviceIndex(null);
    setDeviceName("");
    setDeviceEmail("");
    setShowDeviceModal(true);
  };

  const openEditDevice = (index: number) => {
    const d = myDevices[index];
    if (!d) return;
    setEditingDeviceIndex(index);
    setDeviceName(d.name || "");
    setDeviceEmail(d.email || "");
    setShowDeviceModal(true);
  };

  const closeDeviceModal = () => {
    setShowDeviceModal(false);
    setEditingDeviceIndex(null);
    setDeviceName("");
    setDeviceEmail("");
  };

  // The server requires every self-managed device to be scoped to exactly me;
  // normalize on the way out so an edit of a partially-shaped row can't 400.
  const normalizeMine = (list: any[]): AbsEreaderDevice[] =>
    list.map((d) => ({ ...d, availabilityOption: "specificUsers", users: [myUserId] }));

  const handleSaveDevice = async () => {
    if (savingDevice) return;
    const name = deviceName.trim();
    const email = deviceEmail.trim();
    if (!name || !email || !email.includes("@")) {
      showAppDialog({ title: "Error", message: "Enter a device name and a valid email address." });
      return;
    }
    // Device names are unique server-wide (including admin-managed ones).
    const clash = allDevices.some(
      (d) =>
        (d.name || "").toLowerCase() === name.toLowerCase() &&
        !(editingDeviceIndex != null && d === myDevices[editingDeviceIndex])
    );
    if (clash) {
      showAppDialog({ title: "Error", message: "A device with that name already exists." });
      return;
    }
    const next =
      editingDeviceIndex == null
        ? [...myDevices, { name, email }]
        : myDevices.map((d, i) => (i === editingDeviceIndex ? { ...d, name, email } : d));
    setSavingDevice(true);
    try {
      // updateMyEreaderDevices re-fetches the store's ereaderDevices on
      // success, so the list below (and "Send to device" pickers) refresh.
      await updateMyEreaderDevices(normalizeMine(next));
      const added = editingDeviceIndex == null;
      closeDeviceModal();
      showSnackbar({ message: added ? "Device added" : "Device saved" });
    } catch (err: any) {
      showAppDialog({ title: "Couldn't save device", message: err?.message || "Please try again." });
    } finally {
      setSavingDevice(false);
    }
  };

  const handleRemoveDevice = () => {
    if (editingDeviceIndex == null) return;
    const d = myDevices[editingDeviceIndex];
    if (!d) return;
    const remaining = myDevices.filter((_, i) => i !== editingDeviceIndex);
    showAppDialog({
      title: `Remove "${d.name}"?`,
      message: "You'll no longer be able to send ebooks to this device.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await updateMyEreaderDevices(normalizeMine(remaining));
              closeDeviceModal();
              showSnackbar({ message: "Device removed" });
            } catch (err: any) {
              showAppDialog({
                title: "Couldn't remove device",
                message: err?.message || "Please try again.",
              });
            }
          },
        },
      ],
    });
  };

  // On-open focus/announce for each bespoke modal (see useModalA11y above).
  const deviceModalTitle =
    editingDeviceIndex == null ? "Add e-reader device" : "Edit e-reader device";
  const addressTitleRef = useModalA11y(showAddressModal, "Edit server address");
  const passwordTitleRef = useModalA11y(showPasswordModal, "Change Password");
  const deviceTitleRef = useModalA11y(showDeviceModal, deviceModalTitle);

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

        {/* Per-user e-reader devices (Send-to-Kindle etc.). Server-managed
            devices are listed read-only; devices scoped to just this user are
            editable via POST /api/me/ereader-devices. */}
        {canManageDevices ? (
          <View style={{ marginTop: 28 }}>
            <Text
              style={{
                color: colors.onSurface,
                fontSize: 16,
                fontWeight: "700",
                marginBottom: 4,
              }}
            >
              E-reader devices
            </Text>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginBottom: 12 }}>
              Send ebooks to a Kindle or other e-reader by email.
            </Text>

            {sharedDevices.map((d, i) => (
              <View
                key={`shared-${d.name}-${i}`}
                accessible
                accessibilityLabel={`${d.name}, ${d.email}, managed by server admin`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  marginBottom: 8,
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  borderRadius: 16,
                  backgroundColor: colors.surfaceContainer || colors.surfaceVariant,
                  borderWidth: 1,
                  borderColor: colors.outlineVariant || colors.outline,
                  opacity: 0.85,
                }}
              >
                <Icon name="send" size={22} color={colors.onSurfaceVariant} style={{ marginRight: 12 }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600" }}>
                    {d.name}
                  </Text>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {d.email} · Managed by server admin
                  </Text>
                </View>
                <Icon name="lock" size={18} color={colors.onSurfaceVariant} />
              </View>
            ))}

            {myDevices.map((d, i) => (
              <Pressable
                key={`mine-${d.name}-${i}`}
                onPress={() => openEditDevice(i)}
                accessibilityRole="button"
                accessibilityLabel={`Edit device ${d.name}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  marginBottom: 8,
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  borderRadius: 16,
                  backgroundColor: colors.surfaceContainer || colors.surfaceVariant,
                  borderWidth: 1,
                  borderColor: colors.outlineVariant || colors.outline,
                }}
              >
                <Icon name="send" size={22} color={colors.primary} style={{ marginRight: 12 }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600" }}>
                    {d.name}
                  </Text>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {d.email}
                  </Text>
                </View>
                <Icon name="chevron-right" size={20} color={colors.onSurfaceVariant} />
              </Pressable>
            ))}

            <Pressable
              onPress={openAddDevice}
              accessibilityRole="button"
              accessibilityLabel="Add e-reader device"
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 14,
                paddingHorizontal: 16,
                borderRadius: 16,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: colors.outline,
              }}
            >
              <Icon name="add" size={22} color={colors.primary} style={{ marginRight: 12 }} />
              <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "600" }}>
                Add e-reader device
              </Text>
            </Pressable>
          </View>
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
            <Text
              ref={addressTitleRef}
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontSize: 24, fontWeight: "600", marginBottom: 8 }}
            >
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
            <Text
              ref={passwordTitleRef}
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontSize: 24, fontWeight: "600", marginBottom: 20 }}
            >
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

      {/* Add / edit e-reader device modal (per-user devices only) */}
      <Modal
        visible={showDeviceModal}
        animationType="fade"
        transparent
        onRequestClose={closeDeviceModal}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 }}>
          <View style={{ backgroundColor: colors.surfaceContainer || colors.surfaceVariant, borderRadius: 28, padding: 24, elevation: 5 }}>
            <Text
              ref={deviceTitleRef}
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontSize: 24, fontWeight: "600", marginBottom: 8 }}
            >
              {deviceModalTitle}
            </Text>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginBottom: 20 }}>
              For Kindle, use the device's @kindle.com address and make sure the server's
              sending address is approved in your Amazon settings.
            </Text>

            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "500", marginBottom: 6 }}>
              Device name
            </Text>
            <TextInput
              value={deviceName}
              onChangeText={setDeviceName}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="My Kindle"
              placeholderTextColor={colors.onSurfaceVariant}
              accessibilityLabel="Device name"
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
              Device email
            </Text>
            <TextInput
              value={deviceEmail}
              onChangeText={setDeviceEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="name@kindle.com"
              placeholderTextColor={colors.onSurfaceVariant}
              accessibilityLabel="Device email"
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

            <View style={{ flexDirection: "row", alignItems: "center" }}>
              {editingDeviceIndex != null ? (
                <Pressable
                  onPress={handleRemoveDevice}
                  accessibilityRole="button"
                  accessibilityLabel="Remove device"
                  style={{ paddingVertical: 12, paddingRight: 12 }}
                >
                  <Text style={{ color: colors.error, fontSize: 16, fontWeight: "600" }}>Remove</Text>
                </Pressable>
              ) : null}
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={closeDeviceModal}
                accessibilityRole="button"
                style={{ paddingHorizontal: 20, paddingVertical: 12, marginRight: 8 }}
              >
                <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "600" }}>Cancel</Text>
              </Pressable>

              <Pressable
                onPress={handleSaveDevice}
                disabled={savingDevice}
                accessibilityRole="button"
                accessibilityLabel="Save device"
                accessibilityState={{ disabled: savingDevice, busy: savingDevice }}
                style={{
                  backgroundColor: colors.primary,
                  paddingHorizontal: 20,
                  paddingVertical: 12,
                  borderRadius: 24,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                {savingDevice ? (
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
