import React from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { SectionHeader, Divider, RowBase, ToggleRow } from "../components/SettingsRows";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import {
  getEmailSettings,
  updateEmailSettings,
  sendTestEmail,
  updateAdminEreaderDevices,
} from "../utils/abs/email";
import type { AbsEmailSettings, AbsEreaderDevice } from "../utils/abs/types";

/**
 * Admin Email screen (route "AdminEmail", entered from the Server Admin hub):
 * the ABS SMTP settings form (host/port/secure/user/pass/from/test address),
 * a "send test email" action, and CRUD over the SERVER-WIDE e-reader device
 * list (POST /api/emails/ereader-devices). Per-USER device management lives on
 * AccountScreen instead (PATCH-style /api/me/ereader-devices).
 *
 * SECURITY: the server's stored SMTP password is NEVER echoed back into the
 * form — the pass field always starts (and re-seeds after save) EMPTY, with
 * "leave blank to keep the current password" semantics: `pass` is included in
 * the PATCH only when the admin actually typed a replacement.
 */

// Module-level (NOT inside the screen component) so the TextInput isn't
// remounted on every keystroke re-render, which would drop focus/keyboard.
function LabeledTextField({
  label,
  value,
  onChangeText,
  colors,
  placeholder,
  helper,
  keyboardType,
  secureTextEntry,
  trailing,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  colors: any;
  placeholder?: string;
  helper?: string;
  keyboardType?: any;
  secureTextEntry?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 6 }}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.onSurfaceVariant}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={keyboardType}
          secureTextEntry={secureTextEntry}
          accessibilityLabel={label}
          style={{
            flex: 1,
            backgroundColor: colors.surfaceContainer || colors.surfaceVariant,
            color: colors.onSurface,
            borderRadius: 12,
            padding: 12,
            fontSize: 16,
            borderWidth: 1,
            borderColor: colors.outline,
          }}
        />
        {trailing}
      </View>
      {helper ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4 }}>{helper}</Text>
      ) : null}
    </View>
  );
}

export default function AdminEmailScreen({ navigation }: any) {
  const colors = useThemeColors();

  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<any>(null);
  // Last-loaded server snapshot — the dirty compare + patch diff baseline.
  const [settings, setSettings] = React.useState<AbsEmailSettings | null>(null);

  // SMTP form fields (strings so the inputs stay controlled; port parsed on save).
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState("");
  const [secure, setSecure] = React.useState(true);
  const [smtpUser, setSmtpUser] = React.useState("");
  const [pass, setPass] = React.useState("");
  const [showPass, setShowPass] = React.useState(false);
  const [fromAddress, setFromAddress] = React.useState("");
  const [testAddress, setTestAddress] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [sendingTest, setSendingTest] = React.useState(false);

  // Server-wide e-reader devices.
  const [devices, setDevices] = React.useState<AbsEreaderDevice[]>([]);
  const [showDeviceModal, setShowDeviceModal] = React.useState(false);
  // null = adding; a number = index into `devices` being edited.
  const [editingDeviceIndex, setEditingDeviceIndex] = React.useState<number | null>(null);
  const [deviceName, setDeviceName] = React.useState("");
  const [deviceEmail, setDeviceEmail] = React.useState("");
  const [savingDevice, setSavingDevice] = React.useState(false);

  // Seed the form from a server settings blob. The pass field is ALWAYS reset
  // to empty — even if the server echoed a stored/masked password, it must
  // never appear (or round-trip) through the form.
  const applySettings = React.useCallback((s: AbsEmailSettings) => {
    setSettings(s);
    setHost(s.host ?? "");
    setPort(s.port != null ? String(s.port) : "");
    setSecure(!!s.secure);
    setSmtpUser(s.user ?? "");
    setFromAddress(s.fromAddress ?? "");
    setTestAddress(s.testAddress ?? "");
    setPass("");
    setDevices(Array.isArray(s.ereaderDevices) ? s.ereaderDevices : []);
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await getEmailSettings();
      applySettings(s);
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  React.useEffect(() => {
    load();
  }, [load]);

  // Minimal-diff PATCH body: only fields that differ from the loaded snapshot,
  // plus `pass` only when a replacement was typed (blank keeps the existing
  // server-side password).
  const buildPatch = React.useCallback((): Record<string, any> => {
    if (!settings) return {};
    const patch: Record<string, any> = {};
    if (host.trim() !== (settings.host ?? "")) patch.host = host.trim() || null;
    if (port.trim() !== (settings.port != null ? String(settings.port) : "")) {
      patch.port = Number(port.trim());
    }
    if (secure !== !!settings.secure) patch.secure = secure;
    if (smtpUser.trim() !== (settings.user ?? "")) patch.user = smtpUser.trim() || null;
    if (fromAddress.trim() !== (settings.fromAddress ?? "")) {
      patch.fromAddress = fromAddress.trim() || null;
    }
    if (testAddress.trim() !== (settings.testAddress ?? "")) {
      patch.testAddress = testAddress.trim() || null;
    }
    if (pass !== "") patch.pass = pass;
    return patch;
  }, [settings, host, port, secure, smtpUser, fromAddress, testAddress, pass]);

  const dirty = React.useMemo(() => Object.keys(buildPatch()).length > 0, [buildPatch]);

  const handleSave = async () => {
    if (!dirty || saving || !settings) return;
    const patch = buildPatch();
    if (patch.port !== undefined && (!/^\d+$/.test(port.trim()) || !Number.isFinite(patch.port))) {
      showAppDialog({ title: "Invalid port", message: "The SMTP port must be a number (e.g. 465 or 587)." });
      return;
    }
    setSaving(true);
    try {
      const updated = await updateEmailSettings(patch);
      // Re-seed from the server's echo — applySettings clears the pass field,
      // so a just-typed password never lingers in the form after saving.
      applySettings(updated);
      showSnackbar({ message: "Email settings saved" });
    } catch (e: any) {
      showAppDialog({
        title: "Couldn't save email settings",
        message: e?.message || "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSendTest = async () => {
    if (sendingTest) return;
    if (dirty) {
      // The test route uses the SAVED settings — sending with unsaved edits
      // would test the wrong config and read as a false failure/success.
      showAppDialog({
        title: "Save your changes first",
        message: "The test email uses the saved settings. Save your edits, then send the test.",
      });
      return;
    }
    setSendingTest(true);
    try {
      await sendTestEmail();
      showSnackbar({ message: "Test email sent" });
    } catch (e: any) {
      showAppDialog({ title: "Test email failed", message: e?.message || "Please try again." });
    } finally {
      setSendingTest(false);
    }
  };

  const openAddDevice = () => {
    setEditingDeviceIndex(null);
    setDeviceName("");
    setDeviceEmail("");
    setShowDeviceModal(true);
  };

  const openEditDevice = (index: number) => {
    const d = devices[index];
    if (!d) return;
    setEditingDeviceIndex(index);
    setDeviceName(d.name || "");
    setDeviceEmail(d.email || "");
    setShowDeviceModal(true);
  };

  const closeDeviceModal = () => {
    setShowDeviceModal(false);
    setDeviceName("");
    setDeviceEmail("");
    setEditingDeviceIndex(null);
  };

  const handleSaveDevice = async () => {
    if (savingDevice) return;
    const name = deviceName.trim();
    const email = deviceEmail.trim();
    if (!name || !email || !email.includes("@")) {
      showAppDialog({ title: "Error", message: "Enter a device name and a valid email address." });
      return;
    }
    // ABS requires device names to be unique — catch it before the server 400s.
    const clash = devices.some(
      (d, i) => i !== editingDeviceIndex && (d.name || "").toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      showAppDialog({ title: "Error", message: "A device with that name already exists." });
      return;
    }
    const next =
      editingDeviceIndex == null
        ? [...devices, { name, email, availabilityOption: "adminAndUp" }]
        : devices.map((d, i) => (i === editingDeviceIndex ? { ...d, name, email } : d));
    setSavingDevice(true);
    try {
      const list = await updateAdminEreaderDevices(next);
      setDevices(list);
      const added = editingDeviceIndex == null;
      closeDeviceModal();
      showSnackbar({ message: added ? "Device added" : "Device saved" });
    } catch (e: any) {
      showAppDialog({ title: "Couldn't save device", message: e?.message || "Please try again." });
    } finally {
      setSavingDevice(false);
    }
  };

  const handleRemoveDevice = (index: number) => {
    const d = devices[index];
    if (!d) return;
    showAppDialog({
      title: `Remove "${d.name}"?`,
      message: "Users will no longer be able to send ebooks to this device.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              const list = await updateAdminEreaderDevices(devices.filter((_, i) => i !== index));
              setDevices(list);
              showSnackbar({ message: "Device removed" });
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't remove device",
                message: e?.message || "Please try again.",
              });
            }
          },
        },
      ],
    });
  };

  const renderBody = () => {
    if (loading) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading email settings" />
        </View>
      );
    }
    if (loadError) {
      const kind = loadError?.kind;
      return (
        <ErrorState
          icon={kind === "offline" ? "cloud-off" : "warning"}
          title={
            kind === "offline"
              ? "You're offline"
              : kind === "forbidden"
                ? "Admin access required"
                : "Couldn't load email settings"
          }
          message={
            kind === "offline"
              ? "Server administration needs a connection."
              : loadError?.message || undefined
          }
          onRetry={load}
          style={{ flex: 1 }}
        />
      );
    }
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 32 }}>
        <SectionHeader label="SMTP" colors={colors} />
        <View style={{ paddingHorizontal: 20 }}>
          <LabeledTextField
            label="SMTP host"
            value={host}
            onChangeText={setHost}
            colors={colors}
            placeholder="smtp.example.com"
          />
          <LabeledTextField
            label="SMTP port"
            value={port}
            onChangeText={setPort}
            colors={colors}
            placeholder="465"
            keyboardType="number-pad"
          />
        </View>
        <ToggleRow
          icon="lock"
          title="Secure (SSL/TLS)"
          subtitle="Use an encrypted connection"
          value={secure}
          onValueChange={setSecure}
          colors={colors}
        />
        <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
          <LabeledTextField
            label="SMTP username"
            value={smtpUser}
            onChangeText={setSmtpUser}
            colors={colors}
          />
          {/* The stored password is never echoed here — blank means "keep". */}
          <LabeledTextField
            label="SMTP password"
            value={pass}
            onChangeText={setPass}
            colors={colors}
            secureTextEntry={!showPass}
            placeholder="Leave blank to keep the current password"
            helper="Only sent when you type a new one."
            trailing={
              <Pressable
                onPress={() => setShowPass((v) => !v)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={showPass ? "Hide password" : "Show password"}
                style={{ paddingHorizontal: 12, paddingVertical: 12 }}
              >
                <Icon name={showPass ? "eye-off" : "eye"} size={22} color={colors.onSurfaceVariant} />
              </Pressable>
            }
          />
          <LabeledTextField
            label="From address"
            value={fromAddress}
            onChangeText={setFromAddress}
            colors={colors}
            placeholder="audiobookshelf@example.com"
            keyboardType="email-address"
          />
          <LabeledTextField
            label="Test address"
            value={testAddress}
            onChangeText={setTestAddress}
            colors={colors}
            placeholder="you@example.com"
            helper="Where the test email below is sent."
            keyboardType="email-address"
          />
        </View>

        <SectionHeader label="Test" colors={colors} />
        <RowBase
          icon="send"
          title={sendingTest ? "Sending test email…" : "Send test email"}
          subtitle="Uses the saved settings above"
          onPress={handleSendTest}
          colors={colors}
        />

        <SectionHeader label="E-reader devices (server-wide)" colors={colors} />
        {devices.length === 0 ? (
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 14,
              paddingHorizontal: 20,
              paddingBottom: 8,
            }}
          >
            No devices yet. Add one so users can send ebooks to a Kindle or other e-reader.
          </Text>
        ) : null}
        {devices.map((d, i) => (
          <RowBase
            key={`${d.name}-${i}`}
            icon="auto-stories"
            title={d.name}
            subtitle={d.email}
            onPress={() => openEditDevice(i)}
            colors={colors}
            trailing={
              <Pressable
                onPress={() => handleRemoveDevice(i)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${d.name}`}
                style={{ padding: 8 }}
              >
                <Icon name="trash" size={22} color={colors.error} />
              </Pressable>
            }
          />
        ))}
        <Divider colors={colors} />
        <RowBase icon="add" title="Add device" onPress={openAddDevice} colors={colors} />
      </ScrollView>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Settings-family header: back + title + trailing Save */}
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
        <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600", flex: 1 }}>
          Email
        </Text>
        {settings ? (
          <Pressable
            onPress={handleSave}
            disabled={!dirty || saving}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Save email settings"
            accessibilityState={{ disabled: !dirty || saving, busy: saving }}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 8 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 8 }} />
            ) : null}
            <Text
              style={{
                color: colors.primary,
                fontSize: 16,
                fontWeight: "700",
                opacity: !dirty || saving ? 0.5 : 1,
              }}
            >
              Save
            </Text>
          </Pressable>
        ) : null}
      </View>

      {renderBody()}

      {/* Add / edit server-wide device modal */}
      <Modal
        visible={showDeviceModal}
        animationType="fade"
        transparent
        onRequestClose={closeDeviceModal}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 }}>
          <View
            style={{
              backgroundColor: colors.surfaceContainer || colors.surfaceVariant,
              borderRadius: 28,
              padding: 24,
              elevation: 5,
            }}
          >
            <Text style={{ color: colors.onSurface, fontSize: 24, fontWeight: "600", marginBottom: 8 }}>
              {editingDeviceIndex == null ? "Add device" : "Edit device"}
            </Text>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginBottom: 20 }}>
              Server-wide device — available to users per its availability setting.
            </Text>

            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "500", marginBottom: 6 }}>
              Device name
            </Text>
            <TextInput
              value={deviceName}
              onChangeText={setDeviceName}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Kindle"
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

            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
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
