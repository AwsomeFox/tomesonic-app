import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Clipboard,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { SectionHeader, Divider } from "../components/SettingsRows";
import { useUserStore } from "../store/useUserStore";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { useServerCapabilities, MIN_VERSION_API_KEYS } from "../utils/abs/capabilities";
import { getApiKeys, createApiKey, deleteApiKey } from "../utils/abs/server";
import { AbsError, absErrorToErrorStateProps } from "../utils/abs/errors";
import type { AbsApiKey } from "../utils/abs/types";

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
  const [expiry, setExpiry] = useState<number | null>(EXPIRY_PRESETS[0].seconds);
  const [creating, setCreating] = useState(false);

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

  const handleCreate = async () => {
    const trimmed = name.trim();
    const userId = user?.id;
    if (!trimmed || !userId || creating) return;
    setCreating(true);
    try {
      const created = await createApiKey({
        name: trimmed,
        userId,
        ...(expiry != null ? { expiresIn: expiry } : {}),
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
                Clipboard.setString(token);
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
              {EXPIRY_PRESETS.map((preset) => {
                const active = expiry === preset.seconds;
                return (
                  <Pressable
                    key={preset.label}
                    onPress={() => setExpiry(preset.seconds)}
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
              The key is shown once, right after it's created — copy it then. It acts with your
              account's permissions.
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
    </SafeAreaView>
  );
}
