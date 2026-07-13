import React from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  AccessibilityInfo,
  findNodeHandle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { SectionHeader, Divider, RowBase, ToggleRow } from "../components/SettingsRows";
import SettingSelectModal from "../components/SettingSelectModal";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import {
  getEmailSettings,
  updateEmailSettings,
  sendTestEmail,
  updateAdminEreaderDevices,
} from "../utils/abs/email";
import { getUsers } from "../utils/abs/users";
import { absErrorToErrorStateProps } from "../utils/abs/errors";
import type { AbsEmailSettings, AbsEreaderDevice, AbsUser } from "../utils/abs/types";

type AvailabilityOption = NonNullable<AbsEreaderDevice["availabilityOption"]>;

// Picker options for a device's availability; the same labels (sans ellipsis)
// annotate each device row's subtitle.
const AVAILABILITY_OPTIONS: { label: string; value: AvailabilityOption }[] = [
  { label: "Admins", value: "adminAndUp" },
  { label: "All users", value: "userAndUp" },
  { label: "Everyone including guests", value: "guestAndUp" },
  { label: "Specific users…", value: "specificUsers" },
];

function availabilityLabel(option: AbsEreaderDevice["availabilityOption"]): string {
  if (option === "specificUsers") return "Specific users";
  return (
    AVAILABILITY_OPTIONS.find((o) => o.value === (option ?? "adminAndUp"))?.label ?? "Admins"
  );
}

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
  error,
  keyboardType,
  secureTextEntry,
  trailing,
  inputRef,
  returnKeyType,
  onSubmitEditing,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  colors: any;
  placeholder?: string;
  helper?: string;
  /** Inline validation error rendered under the field (error-colored). */
  error?: string | null;
  keyboardType?: any;
  secureTextEntry?: boolean;
  trailing?: React.ReactNode;
  inputRef?: React.RefObject<TextInput | null>;
  returnKeyType?: "next" | "done";
  onSubmitEditing?: () => void;
}) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 6 }}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        {/* Borderless skin shared with AdminUserDetail/EditMetadata's Field:
            surfaceContainer fill, fontSize 15, transparent border that turns
            error-colored when there's an inline error. */}
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.onSurfaceVariant}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={keyboardType}
          secureTextEntry={secureTextEntry}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          accessibilityLabel={label}
          style={{
            flex: 1,
            backgroundColor: colors.surfaceContainer,
            color: colors.onSurface,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 10,
            fontSize: 15,
            borderWidth: 1,
            borderColor: error ? colors.error : "transparent",
          }}
        />
        {trailing}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error, fontSize: 12, marginTop: 4 }}>
          {error}
        </Text>
      ) : helper ? (
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

  // returnKeyType="next" focus chain through the SMTP fields (host → port →
  // user → pass → from → test); the last field submits "done". The Secure
  // toggle sits visually between port and user but is a switch, so the chain
  // skips it.
  const portRef = React.useRef<TextInput>(null);
  const userRef = React.useRef<TextInput>(null);
  const passRef = React.useRef<TextInput>(null);
  const fromRef = React.useRef<TextInput>(null);
  const testRef = React.useRef<TextInput>(null);

  // Server-wide e-reader devices.
  const [devices, setDevices] = React.useState<AbsEreaderDevice[]>([]);
  const [showDeviceModal, setShowDeviceModal] = React.useState(false);
  // null = adding; a number = index into `devices` being edited.
  const [editingDeviceIndex, setEditingDeviceIndex] = React.useState<number | null>(null);
  const [deviceName, setDeviceName] = React.useState("");
  const [deviceEmail, setDeviceEmail] = React.useState("");
  const [deviceAvailability, setDeviceAvailability] =
    React.useState<AvailabilityOption>("adminAndUp");
  // User IDs a "specificUsers" device is restricted to.
  const [deviceUsers, setDeviceUsers] = React.useState<string[]>([]);
  const [availabilityPickerOpen, setAvailabilityPickerOpen] = React.useState(false);
  // Server users for the specific-users checklist — fetched lazily the first
  // time a device needs them, then cached for the screen's lifetime.
  const [allUsers, setAllUsers] = React.useState<AbsUser[] | null>(null);
  const [loadingUsers, setLoadingUsers] = React.useState(false);
  const [savingDevice, setSavingDevice] = React.useState(false);

  // Device-modal a11y (mirrors AppDialog's on-open pattern): RN Modal doesn't
  // move screen-reader focus or announce itself on Android, so on open we
  // focus the title and announce the dialog's purpose.
  const deviceModalTitleRef = React.useRef<Text>(null);
  React.useEffect(() => {
    if (!showDeviceModal) return;
    const title = editingDeviceIndex == null ? "Add device" : "Edit device";
    const t = setTimeout(() => {
      if (Platform.OS === "android") {
        const node = findNodeHandle(deviceModalTitleRef.current);
        if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
      }
      AccessibilityInfo.announceForAccessibility(
        `${title}. Server-wide e-reader device — enter a name, email, and who can use it.`
      );
    }, 50);
    return () => clearTimeout(t);
    // editingDeviceIndex is part of the title but only changes while the modal
    // is CLOSED (openAdd/openEdit set it before opening) — keying on the modal
    // visibility alone avoids re-announcing mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeviceModal]);

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

  // Unsaved-changes guard (ChapterEditor pattern): intercept ANY navigation
  // that would remove this screen — header back AND hardware back — while the
  // SMTP form is dirty. Refs keep the listener stable across re-renders.
  const dirtyRef = React.useRef(false);
  dirtyRef.current = dirty && !saving;
  React.useEffect(() => {
    if (!navigation?.addListener) return;
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      showAppDialog({
        title: "Discard email changes?",
        message: "You have unsaved SMTP settings edits. Nothing has been sent to the server yet.",
        buttons: [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => navigation.dispatch(e.data.action),
          },
        ],
      });
    });
    return unsub;
  }, [navigation]);

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

  // Fetch the user list for the specific-users checklist (once per screen).
  const ensureUsers = React.useCallback(async () => {
    if (allUsers || loadingUsers) return;
    setLoadingUsers(true);
    try {
      setAllUsers(await getUsers());
    } catch (e: any) {
      showAppDialog({ title: "Couldn't load users", message: e?.message || "Please try again." });
    } finally {
      setLoadingUsers(false);
    }
  }, [allUsers, loadingUsers]);

  const openAddDevice = () => {
    setEditingDeviceIndex(null);
    setDeviceName("");
    setDeviceEmail("");
    setDeviceAvailability("adminAndUp");
    setDeviceUsers([]);
    setShowDeviceModal(true);
  };

  const openEditDevice = (index: number) => {
    const d = devices[index];
    if (!d) return;
    setEditingDeviceIndex(index);
    setDeviceName(d.name || "");
    setDeviceEmail(d.email || "");
    const availability = d.availabilityOption ?? "adminAndUp";
    setDeviceAvailability(availability);
    setDeviceUsers(Array.isArray(d.users) ? d.users : []);
    if (availability === "specificUsers") ensureUsers();
    setShowDeviceModal(true);
  };

  const closeDeviceModal = () => {
    setShowDeviceModal(false);
    setDeviceName("");
    setDeviceEmail("");
    setDeviceAvailability("adminAndUp");
    setDeviceUsers([]);
    setAvailabilityPickerOpen(false);
    setEditingDeviceIndex(null);
  };

  const handleSelectAvailability = (value: AvailabilityOption) => {
    setDeviceAvailability(value);
    if (value === "specificUsers") ensureUsers();
  };

  const toggleDeviceUser = (userId: string) => {
    setDeviceUsers((cur) =>
      cur.includes(userId) ? cur.filter((id) => id !== userId) : [...cur, userId]
    );
  };

  const handleSaveDevice = async () => {
    if (savingDevice) return;
    const name = deviceName.trim();
    const email = deviceEmail.trim();
    // Specific validation titles (not a generic "Error") so the dialog itself
    // says what to fix.
    if (!name) {
      showAppDialog({ title: "Device name required", message: "Enter a name for the device." });
      return;
    }
    if (!email || !email.includes("@")) {
      showAppDialog({
        title: "Valid email required",
        message: "Enter a valid email address for the device.",
      });
      return;
    }
    // ABS requires device names to be unique — catch it before the server 400s.
    const clash = devices.some(
      (d, i) => i !== editingDeviceIndex && (d.name || "").toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      showAppDialog({
        title: "Device name already used",
        message: "A device with that name already exists.",
      });
      return;
    }
    // A device seeded from a stale server blob can carry ids of users that
    // were since deleted — once the real user list is loaded, ghosts must not
    // round-trip back to the server. (Unfiltered when allUsers never loaded:
    // better to keep unverifiable ids than silently drop live ones.)
    const effectiveUsers = allUsers
      ? deviceUsers.filter((id) => allUsers.some((u) => u.id === id))
      : deviceUsers;
    // A specific-users device with nobody (real) selected would be unusable by
    // everyone — block it before the POST.
    if (deviceAvailability === "specificUsers" && effectiveUsers.length === 0) {
      showAppDialog({
        title: "Select at least one user",
        message: "Pick who can send to this device, or choose a broader availability.",
      });
      return;
    }
    const next =
      editingDeviceIndex == null
        ? [
            ...devices,
            {
              name,
              email,
              availabilityOption: deviceAvailability,
              ...(deviceAvailability === "specificUsers" ? { users: effectiveUsers } : {}),
            },
          ]
        : devices.map((d, i) => {
            if (i !== editingDeviceIndex) return d;
            // Spread-merge keeps any server-side fields we don't edit, but the
            // availability fields are OVERRIDDEN — and a stale users array is
            // STRIPPED when the device no longer targets specific users.
            const merged: AbsEreaderDevice = {
              ...d,
              name,
              email,
              availabilityOption: deviceAvailability,
            };
            if (deviceAvailability === "specificUsers") {
              merged.users = effectiveUsers;
            } else {
              delete merged.users;
            }
            return merged;
          });
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
      // Shared engine; this screen historically used the warning icon for
      // every non-offline kind and the generic "Couldn't load email settings"
      // title for everything but offline/forbidden.
      const generic = { icon: "warning", title: "Couldn't load email settings" } as const;
      return (
        <ErrorState
          {...absErrorToErrorStateProps(loadError, {
            subject: "email settings",
            onRetry: load,
            overrides: {
              forbidden: { icon: "warning" },
              auth: generic,
              server: generic,
              unsupported: generic,
            },
          })}
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
            returnKeyType="next"
            onSubmitEditing={() => portRef.current?.focus()}
          />
          <LabeledTextField
            label="SMTP port"
            value={port}
            onChangeText={setPort}
            colors={colors}
            placeholder="465"
            keyboardType="number-pad"
            inputRef={portRef}
            returnKeyType="next"
            onSubmitEditing={() => userRef.current?.focus()}
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
            inputRef={userRef}
            returnKeyType="next"
            onSubmitEditing={() => passRef.current?.focus()}
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
            inputRef={passRef}
            returnKeyType="next"
            onSubmitEditing={() => fromRef.current?.focus()}
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
            inputRef={fromRef}
            returnKeyType="next"
            onSubmitEditing={() => testRef.current?.focus()}
          />
          <LabeledTextField
            label="Test address"
            value={testAddress}
            onChangeText={setTestAddress}
            colors={colors}
            placeholder="you@example.com"
            helper="Where the test email below is sent."
            keyboardType="email-address"
            inputRef={testRef}
            returnKeyType="done"
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
            subtitle={`${d.email} · ${availabilityLabel(d.availabilityOption)}`}
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
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header (20/700 + hairline, same spec as the other
          admin screens): back + title + trailing Save */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
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
        {/* KeyboardAvoidingView + ScrollView so the email field (and Save row)
            stay reachable while the keyboard is up on small screens. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <ScrollView
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 20 }}
            keyboardShouldPersistTaps="handled"
          >
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: colors.surfaceContainer || colors.surfaceVariant,
              borderRadius: 28,
              padding: 24,
              elevation: 5,
            }}
          >
            <Text
              ref={deviceModalTitleRef}
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontSize: 24, fontWeight: "600", marginBottom: 8 }}
            >
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
              autoCapitalize="words"
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
                marginBottom: 16,
              }}
            />

            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "500", marginBottom: 6 }}>
              Who can use it
            </Text>
            <Pressable
              onPress={() => setAvailabilityPickerOpen(true)}
              accessibilityRole="button"
              // The current value rides in the label — a screen reader must
              // hear the selection, not just the field's name.
              accessibilityLabel={`Who can use it: ${
                AVAILABILITY_OPTIONS.find((o) => o.value === deviceAvailability)?.label ??
                "Admins"
              }`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: colors.surface,
                borderRadius: 12,
                padding: 12,
                borderWidth: 1,
                borderColor: colors.outline,
                marginBottom: 16,
              }}
            >
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: 16 }}>
                {AVAILABILITY_OPTIONS.find((o) => o.value === deviceAvailability)?.label}
              </Text>
              <Icon name="chevron-down" size={22} color={colors.onSurfaceVariant} />
            </Pressable>

            {deviceAvailability === "specificUsers" ? (
              <View style={{ marginBottom: 8 }}>
                {loadingUsers ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primary}
                    accessibilityLabel="Loading users"
                    style={{ marginVertical: 12 }}
                  />
                ) : (
                  (allUsers || []).map((u) => {
                    const checked = deviceUsers.includes(u.id);
                    return (
                      <Pressable
                        key={u.id}
                        onPress={() => toggleDeviceUser(u.id)}
                        accessibilityRole="checkbox"
                        accessibilityLabel={u.username}
                        accessibilityState={{ checked }}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          paddingVertical: 10,
                          paddingHorizontal: 4,
                        }}
                      >
                        <Text style={{ flex: 1, color: colors.onSurface, fontSize: 16 }}>
                          {u.username}
                        </Text>
                        {checked ? <Icon name="check" size={20} color={colors.primary} /> : null}
                      </Pressable>
                    );
                  })
                )}
              </View>
            ) : null}

            <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 8 }}>
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
          </ScrollView>

          {/* Availability picker — rendered INSIDE the device Modal so it can
              layer above it on iOS (sibling modals don't stack there). */}
          <SettingSelectModal
            visible={availabilityPickerOpen}
            title="Who can use it"
            options={AVAILABILITY_OPTIONS}
            selected={deviceAvailability}
            onSelect={(v) => handleSelectAvailability(v)}
            onClose={() => setAvailabilityPickerOpen(false)}
          />
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
