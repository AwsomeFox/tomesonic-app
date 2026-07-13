import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { SectionHeader, Divider, SelectRow, M3Switch } from "../components/SettingsRows";
import SettingSelectModal from "../components/SettingSelectModal";
import { useUserStore } from "../store/useUserStore";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { useServerCapabilities, MIN_VERSION_API_KEYS } from "../utils/abs/capabilities";
import { getApiKeys, createApiKey, updateApiKey, deleteApiKey } from "../utils/abs/server";
import { getUsers } from "../utils/abs/users";
import { AbsError, absErrorToErrorStateProps } from "../utils/abs/errors";
import type { AbsApiKey, AbsUser } from "../utils/abs/types";

/**
 * AdminApiKeysScreen — list / create / delete server API keys.
 *
 * Route: "AdminApiKeys" (the hub hides its row unless supportsApiKeys, but
 * this screen guards independently: a capability gate on version AND a 404 →
 * "unsupported" branch, since version gating is advisory).
 *
 * ONE-TIME KEY REVEAL: POST /api/api-keys is the only place the actual token
 * ever exists — the server never returns it again. It is shown once in a
 * reveal dialog (with a copy action) and deliberately kept OUT of any store,
 * MMKV, log, or component state: the token lives only in the dialog closure.
 */

const EXPIRY_PRESETS: { label: string; seconds: number | null }[] = [
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
  { label: "90 days", seconds: 90 * 24 * 60 * 60 },
  { label: "1 year", seconds: 365 * 24 * 60 * 60 },
  { label: "Never", seconds: null },
];

// Date-only with an "Expires …" prefix — related to but not a duplicate of
// the date formatters elsewhere; see utils/format.ts before adding another.
function formatExpiry(expiresAt: string | null | undefined): string {
  if (!expiresAt) return "Never expires";
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return "Expires";
  return `Expires ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

export default function AdminApiKeysScreen({ navigation }: any) {
  const colors = useThemeColors();
  const caps = useServerCapabilities();
  const user = useUserStore((s) => s.user);

  const [keys, setKeys] = useState<AbsApiKey[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AbsError | null>(null);
  const [name, setName] = useState("");
  // number = preset seconds, null = never expires, "custom" = the days input.
  const [expiry, setExpiry] = useState<number | null | "custom">(EXPIRY_PRESETS[0].seconds);
  const [customDays, setCustomDays] = useState("");
  const [creating, setCreating] = useState(false);
  // Act-as-user picker: keys run with the CHOSEN user's permissions; default
  // is the signed-in admin. The users list is fetched lazily on first open.
  const [actAsUserId, setActAsUserId] = useState<string | null>(user?.id ?? null);
  const [users, setUsers] = useState<AbsUser[] | null>(null);
  const [userPickerOpen, setUserPickerOpen] = useState(false);
  // Per-key PATCH in-flight guard for the enable/disable switches.
  const togglingIds = useRef<Set<string>>(new Set());

  const supports = caps.supportsApiKeys;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await getApiKeys());
    } catch (e) {
      setError(e as AbsError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!supports) {
      // Version gate says no — don't even hit the route; render the
      // unsupported state below.
      setLoading(false);
      return;
    }
    load();
    const unsub = navigation.addListener("focus", load);
    return unsub;
  }, [supports, load, navigation]);

  // Lazy users fetch for the act-as picker. On failure the picker stays shut
  // and the current default (yourself) remains selected.
  const openUserPicker = async () => {
    if (users) {
      setUserPickerOpen(true);
      return;
    }
    try {
      const all = await getUsers();
      // A non-root admin must not mint keys that act as OTHER root users —
      // that would be a privilege escalation. Root sees everyone; self is
      // always available regardless of type.
      const visible =
        user?.type === "root" ? all : all.filter((u) => u.type !== "root" || u.id === user?.id);
      setUsers(visible);
      setUserPickerOpen(true);
    } catch (e: any) {
      showAppDialog({
        title: "Couldn't load users",
        message: e?.message || "Something went wrong. Please try again.",
      });
    }
  };

  const actAsUser = users?.find((u) => u.id === actAsUserId);
  const actsAsSelf = actAsUserId === user?.id;

  const handleCreate = async () => {
    const trimmed = name.trim();
    const userId = actAsUserId || user?.id;
    if (!trimmed || !userId || creating) return;
    let expiresIn: number | undefined;
    if (expiry === "custom") {
      const raw = customDays.trim();
      // Whole positive days only — "0", "", "1.5" and garbage all block the POST.
      if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        showAppDialog({
          title: "Invalid expiry",
          message: "Enter a whole number of days greater than zero.",
        });
        return;
      }
      expiresIn = Number(raw) * 86400;
    } else if (expiry != null) {
      expiresIn = expiry;
    }
    setCreating(true);
    try {
      const created = await createApiKey({
        name: trimmed,
        userId,
        ...(expiresIn != null ? { expiresIn } : {}),
      });
      setName("");
      // Refresh the list so the new key row appears (best-effort — the reveal
      // dialog matters more than the row refresh).
      try {
        setKeys(await getApiKeys());
      } catch {}
      const token = created?.apiKey;
      if (token) {
        // The one-time reveal: the token exists ONLY in this dialog closure.
        // Copy must NOT dismiss the dialog — it's the only place the secret
        // ever exists, so the user closes it explicitly via Done.
        showAppDialog({
          title: "API key created",
          message: `Copy the key now — the server never shows it again.\n\n${token}`,
          cancelable: false,
          buttons: [
            {
              text: "Copy key",
              keepOpenOnPress: true,
              onPress: () => {
                Clipboard.setStringAsync(token).catch(() => {});
                showSnackbar({ message: "Key copied" });
              },
            },
            { text: "Done" },
          ],
        });
      } else {
        showSnackbar({ message: "API key created" });
      }
    } catch (e: any) {
      showAppDialog({
        title: "Couldn't create the API key",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setCreating(false);
    }
  };

  const doDelete = async (key: AbsApiKey) => {
    try {
      await deleteApiKey(key.id);
      setKeys((cur) => (cur || []).filter((k) => k.id !== key.id));
      showSnackbar({ message: "API key deleted" });
    } catch (e: any) {
      // Failure gets a dialog (matching every other op failure on this
      // screen) — a snackbar is too easy to miss for a failed delete.
      showAppDialog({
        title: "Couldn't delete the API key",
        message: e?.message || "Something went wrong. Please try again.",
      });
    }
  };

  const confirmDelete = (key: AbsApiKey) => {
    showAppDialog({
      title: "Delete API key",
      message: `Delete "${key.name}"? Anything still using this key loses access immediately.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => doDelete(key) },
      ],
    });
  };

  const handleToggleActive = async (key: AbsApiKey, next: boolean) => {
    if (togglingIds.current.has(key.id)) return; // one PATCH per key at a time
    togglingIds.current.add(key.id);
    // Optimistic flip (also keeps the "Inactive" subtitle in sync).
    setKeys((cur) => (cur || []).map((k) => (k.id === key.id ? { ...k, isActive: next } : k)));
    try {
      const updated = await updateApiKey(key.id, { isActive: next });
      // Merge the echo ONTO the previous row — the PATCH response has no
      // joined `user`, and replacing the row wholesale would drop the
      // "Acts as …" subtitle.
      setKeys((cur) => (cur || []).map((k) => (k.id === key.id ? { ...key, ...updated } : k)));
      showSnackbar({ message: next ? "API key enabled" : "API key disabled" });
    } catch (e: any) {
      // Roll back to the pre-toggle row; failure gets a dialog (screen convention).
      setKeys((cur) => (cur || []).map((k) => (k.id === key.id ? key : k)));
      showAppDialog({
        title: "Couldn't update the API key",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      togglingIds.current.delete(key.id);
    }
  };

  const unsupported = !supports || error?.kind === "unsupported";

  // Shared engine; offline keeps this screen's historical use of the error's
  // own message, and auth/server keep the generic "Couldn't load API keys"
  // fallback. (`unsupported` never reaches here — it renders the dedicated
  // unsupported view below instead.)
  const renderError = (err: AbsError) => (
    <ErrorState
      style={{ flex: 1 }}
      {...absErrorToErrorStateProps(err, {
        subject: "API keys",
        onRetry: load,
        overrides: {
          offline: { message: err.message },
          auth: { icon: "warning", title: "Couldn't load API keys" },
          server: { title: "Couldn't load API keys" },
        },
      })}
    />
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header */}
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
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
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
          API keys
        </Text>
      </View>

      {unsupported ? (
        <EmptyState
          style={{ flex: 1 }}
          icon="lock"
          title="API keys aren't available"
          message={`API keys need Audiobookshelf server ${MIN_VERSION_API_KEYS} or newer${
            caps.serverVersion ? ` — this server reports v${caps.serverVersion}` : ""
          }.`}
        />
      ) : error ? (
        renderError(error)
      ) : loading && keys === null ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Create */}
          <SectionHeader label="Create a key" colors={colors} />
          <View style={{ paddingHorizontal: 20 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              editable={!creating}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Key name (e.g. Home dashboard)"
              placeholderTextColor={colors.onSurfaceVariant}
              accessibilityLabel="API key name"
              style={{
                backgroundColor: colors.surfaceContainer,
                color: colors.onSurface,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 15,
              }}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 10 }}>
              {[
                ...EXPIRY_PRESETS.map((p) => ({ label: p.label, value: p.seconds })),
                // "Custom…" reveals the days input below instead of a fixed span.
                { label: "Custom…", value: "custom" as const },
              ].map((preset) => {
                const active = expiry === preset.value;
                return (
                  <Pressable
                    key={preset.label}
                    onPress={() => setExpiry(preset.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`Key expires: ${preset.label}`}
                    android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
                    hitSlop={{ top: 6, bottom: 6 }}
                    style={{
                      paddingHorizontal: 14,
                      height: 34,
                      borderRadius: 17,
                      overflow: "hidden",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 8,
                      marginBottom: 8,
                      backgroundColor: active ? colors.secondaryContainer : "transparent",
                      borderWidth: 1,
                      borderColor: active ? colors.secondaryContainer : colors.outlineVariant,
                    }}
                  >
                    <Text
                      style={{
                        color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                        fontSize: 13,
                        fontWeight: "600",
                      }}
                    >
                      {preset.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {expiry === "custom" ? (
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
                <TextInput
                  value={customDays}
                  onChangeText={setCustomDays}
                  editable={!creating}
                  keyboardType="number-pad"
                  placeholder="14"
                  placeholderTextColor={colors.onSurfaceVariant}
                  accessibilityLabel="Custom expiry in days"
                  style={{
                    backgroundColor: colors.surfaceContainer,
                    color: colors.onSurface,
                    borderRadius: 12,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    fontSize: 15,
                    minWidth: 96,
                  }}
                />
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginLeft: 10 }}>
                  days
                </Text>
              </View>
            ) : null}
          </View>
          {/* Whose permissions the key runs with; full-bleed row so it lines up
              with the settings-row family (options load lazily on first open). */}
          <SelectRow
            icon="person"
            title="Acts as"
            subtitle={actsAsSelf ? "You" : actAsUser?.username || "Selected user"}
            onPress={openUserPicker}
            colors={colors}
          />
          <View style={{ paddingHorizontal: 20 }}>
            <Pressable
              onPress={handleCreate}
              disabled={creating || !name.trim()}
              accessibilityRole="button"
              accessibilityLabel="Create API key"
              accessibilityState={{ disabled: creating || !name.trim() }}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                marginTop: 4,
                height: 48,
                borderRadius: 24,
                overflow: "hidden",
                backgroundColor: colors.primary,
                opacity: creating || !name.trim() ? 0.5 : 1,
              }}
            >
              {creating ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700" }}>
                  Create API key
                </Text>
              )}
            </Pressable>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 8 }}>
              The key is shown once, right after it's created — copy it then. It acts with{" "}
              {actsAsSelf
                ? "your account's"
                : `${actAsUser?.username ?? "the selected user"}'s`}{" "}
              permissions.
            </Text>
          </View>

          {/* Existing keys */}
          <SectionHeader
            label={keys && keys.length ? `Keys (${keys.length})` : "Keys"}
            colors={colors}
          />
          {!keys || keys.length === 0 ? (
            <EmptyState
              icon="lock"
              title="No API keys yet"
              message="Create one to let scripts and other apps talk to your server."
            />
          ) : (
            keys.map((k, i) => {
              const subtitleParts: string[] = [];
              if (!k.isActive) subtitleParts.push("Inactive");
              subtitleParts.push(formatExpiry(k.expiresAt));
              if (k.user?.username) subtitleParts.push(`Acts as ${k.user.username}`);
              return (
                <View key={k.id}>
                  {i > 0 ? <Divider colors={colors} /> : null}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingVertical: 14,
                      paddingHorizontal: 20,
                    }}
                  >
                    <Icon name="lock" size={24} color={colors.onSurface} style={{ marginRight: 18 }} />
                    <View style={{ flex: 1, marginRight: 12 }}>
                      <Text style={{ color: colors.onSurface, fontSize: 17 }} numberOfLines={1}>
                        {k.name}
                      </Text>
                      <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                        {subtitleParts.join(" · ")}
                      </Text>
                    </View>
                    {/* Enable/disable — the wrapper Pressable is the accessible
                        switch; the visual M3 knob is hidden from readers (the
                        ToggleRow pattern) and its own press is inert. */}
                    <Pressable
                      onPress={() => handleToggleActive(k, !k.isActive)}
                      hitSlop={8}
                      accessibilityRole="switch"
                      accessibilityLabel={`${k.name} active`}
                      accessibilityState={{ checked: k.isActive }}
                      style={{ marginRight: 8 }}
                    >
                      <View
                        pointerEvents="none"
                        importantForAccessibility="no-hide-descendants"
                        accessibilityElementsHidden
                      >
                        <M3Switch value={k.isActive} onValueChange={() => {}} colors={colors} />
                      </View>
                    </Pressable>
                    <Pressable
                      onPress={() => confirmDelete(k)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete API key ${k.name}`}
                      style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                    >
                      <Icon name="trash" size={22} color={colors.error} />
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      {/* Act-as user picker (options seeded by openUserPicker's lazy fetch). */}
      <SettingSelectModal
        visible={userPickerOpen}
        title="Acts as"
        options={(users || []).map((u) => ({
          label: u.username + (u.type === "root" ? " (root)" : ""),
          value: u.id,
        }))}
        selected={actAsUserId}
        onSelect={(v) => setActAsUserId(v)}
        onClose={() => setUserPickerOpen(false)}
      />
    </SafeAreaView>
  );
}
