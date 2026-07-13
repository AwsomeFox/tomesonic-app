import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  AccessibilityInfo,
  findNodeHandle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon, { IconName } from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { SectionHeader, ToggleRow, RowBase, Divider, SelectRow } from "../components/SettingsRows";
import SettingSelectModal from "../components/SettingSelectModal";
import { useUserStore } from "../store/useUserStore";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { refreshCapabilities } from "../utils/abs/capabilities";
import { updateServerSettings } from "../utils/abs/server";
import { api } from "../utils/api";
import { absErrorToErrorStateProps } from "../utils/abs/errors";

/**
 * AdminServerSettingsScreen — a mobile subset of the ABS server settings as
 * immediate-save toggles.
 *
 * Route: "AdminServerSettings" (admin-gated by the ServerAdmin hub; the server
 * re-checks on every PATCH anyway, so a non-admin who lands here just gets a
 * 403 snackbar).
 *
 * Data model (the "no GET /api/settings" reality): values render from
 * `useUserStore.serverSettings`, which POST /api/authorize hydrates. To keep a
 * second admin's web-side edits from going stale here (risk 2 in the plan),
 * refreshCapabilities() re-seeds the blob on every screen focus. Each toggle
 * PATCHes ONLY its own key (never the whole seeded blob — clobber risk),
 * flipping optimistically and rolling back with a snackbar on failure; on
 * success updateServerSettings() writes the server's echoed settings blob back
 * into the store, so the store stays the single source of truth.
 */

interface ToggleSpec {
  /** serverSettings key — also the exact PATCH body key. */
  key: string;
  icon: IconName;
  title: string;
  subtitle: string;
  /** When true the stored value is the NEGATION of the displayed switch. */
  invert?: boolean;
}

const SECTIONS: { label: string; toggles: ToggleSpec[] }[] = [
  {
    label: "Scanner",
    toggles: [
      {
        key: "scannerDisableWatcher",
        invert: true,
        icon: "eye",
        title: "Watch for file changes",
        subtitle: "Pick up folder changes without a manual scan",
      },
      {
        key: "scannerParseSubtitle",
        icon: "edit",
        title: "Parse subtitles",
        subtitle: "Read subtitles from audiobook folder names",
      },
      {
        key: "scannerFindCovers",
        icon: "image",
        title: "Find covers",
        subtitle: "Look for a cover online when a scan finds none",
      },
      {
        key: "scannerPreferMatchedMetadata",
        icon: "check",
        title: "Prefer matched metadata",
        subtitle: "Quick-match results override item details",
      },
    ],
  },
  {
    label: "Metadata",
    toggles: [
      {
        key: "storeCoverWithItem",
        icon: "folder",
        title: "Store covers with item",
        subtitle: "Save cover images inside the item's folder",
      },
      {
        key: "storeMetadataWithItem",
        icon: "folder",
        title: "Store metadata with item",
        subtitle: "Save metadata files inside the item's folder",
      },
    ],
  },
  {
    label: "Display & playback",
    toggles: [
      {
        key: "sortingIgnorePrefix",
        icon: "sort",
        title: "Ignore prefixes when sorting",
        subtitle: 'Sort titles ignoring prefixes like "the"',
      },
      {
        key: "chromecastEnabled",
        icon: "cast",
        title: "Chromecast support",
        subtitle: "Allow casting from Audiobookshelf apps",
      },
    ],
  },
];

// --- Localization selects (single-key PATCHes, same as the toggles) ---------

// The date formats the ABS web client offers (server stores the raw pattern).
const DATE_FORMAT_OPTIONS = [
  "MM/dd/yyyy",
  "dd/MM/yyyy",
  "dd.MM.yyyy",
  "yyyy-MM-dd",
  "MMM do, yyyy",
  "MMMM do, yyyy",
  "dd MMM yyyy",
  "dd MMMM yyyy",
].map((v) => ({ label: v, value: v }));

const TIME_FORMAT_OPTIONS = [
  { label: "24-hour", value: "HH:mm" },
  { label: "12-hour", value: "h:mma" },
];

// Curated subset of the server's language list, labeled with native names.
const LANGUAGE_OPTIONS = [
  { label: "English", value: "en-us" },
  { label: "Deutsch", value: "de" },
  { label: "Español", value: "es" },
  { label: "Français", value: "fr" },
  { label: "Italiano", value: "it" },
  { label: "Nederlands", value: "nl" },
  { label: "Polski", value: "pl" },
  { label: "Português (Brasil)", value: "pt-br" },
  { label: "简体中文", value: "zh-cn" },
];

interface SelectSpec {
  key: string;
  icon: IconName;
  title: string;
  options: { label: string; value: string }[];
  /** Server default, shown when the store blob predates the key. */
  fallback: string;
}

const LOCALIZATION_SELECTS: SelectSpec[] = [
  { key: "dateFormat", icon: "calendar", title: "Date format", options: DATE_FORMAT_OPTIONS, fallback: "MM/dd/yyyy" },
  { key: "timeFormat", icon: "clock", title: "Time format", options: TIME_FORMAT_OPTIONS, fallback: "HH:mm" },
  { key: "language", icon: "globe", title: "Language", options: LANGUAGE_OPTIONS, fallback: "en-us" },
];

export default function AdminServerSettingsScreen({ navigation }: any) {
  const colors = useThemeColors();
  const serverSettings = useUserStore((s) => s.serverSettings);

  // Spinner only while we have NOTHING to show; once a blob exists the screen
  // renders instantly and focus refreshes happen silently underneath.
  const [seeding, setSeeding] = useState(!serverSettings);
  // Optimistic DISPLAY values keyed by setting key: set on tap, cleared when
  // the PATCH settles. On success the store already holds the echoed new blob
  // (same value); on failure clearing falls back to the untouched store value,
  // which IS the rollback.
  const [overrides, setOverrides] = useState<Record<string, any>>({});
  const inFlight = useRef<Record<string, boolean>>({});
  // Which SettingSelectModal (if any) is open, by settings key.
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  // Sorting-prefixes editor modal.
  const [prefixModalOpen, setPrefixModalOpen] = useState(false);
  const [prefixDraft, setPrefixDraft] = useState<string[]>([]);
  const [prefixInput, setPrefixInput] = useState("");
  const [savingPrefixes, setSavingPrefixes] = useState(false);
  // The classified failure behind an empty settings blob, for the load-error
  // ErrorState (offline vs 403 vs 5xx). refreshCapabilities() swallows its
  // error, so on a failed seed we re-probe /api/authorize once to classify it.
  const [seedError, setSeedError] = useState<any>(null);
  // Guards post-await setStates from firing after unmount (the seed and the
  // per-toggle PATCH both settle asynchronously).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Dedupes the mount double-fire: React Navigation emits a "focus" the moment
  // this screen mounts, which lands in the same tick as the direct seed() call
  // below — without this guard refreshCapabilities() would run twice on entry.
  // Set synchronously before the first await so the concurrent second call bails;
  // cleared when the seed settles, so a LATER focus (a genuine revisit) re-seeds.
  const seedInFlight = useRef(false);
  const seed = useCallback(async () => {
    if (seedInFlight.current) return;
    seedInFlight.current = true;
    try {
      await refreshCapabilities(); // never throws; store stays as-is on failure
      if (!mountedRef.current) return;
      if (useUserStore.getState().serverSettings) {
        setSeedError(null);
      } else {
        // Hydration didn't land — re-probe once purely to classify the failure
        // (same conditions, so the kind is accurate) for the error state.
        try {
          await api.post("/api/authorize");
          if (mountedRef.current) setSeedError(null);
        } catch (e) {
          if (mountedRef.current) setSeedError(e);
        }
      }
    } finally {
      seedInFlight.current = false;
      if (mountedRef.current) setSeeding(false);
    }
  }, []);

  // Seed on mount AND on every re-focus (staleness mitigation: another admin
  // may have changed settings on the web dashboard while we were away). The
  // seedInFlight guard collapses the mount-coincident focus into one seed.
  useEffect(() => {
    seed();
    const unsub = navigation.addListener("focus", seed);
    return unsub;
  }, [navigation, seed]);

  const displayedValue = (t: ToggleSpec): boolean => {
    if (t.key in overrides) return overrides[t.key];
    const raw = !!serverSettings?.[t.key];
    return t.invert ? !raw : raw;
  };

  const handleToggle = async (t: ToggleSpec, next: boolean) => {
    if (inFlight.current[t.key]) return; // one PATCH per key at a time
    inFlight.current[t.key] = true;
    setOverrides((o) => ({ ...o, [t.key]: next }));
    try {
      // PATCH only this key. updateServerSettings writes the server's echoed
      // full settings blob into useUserStore on success.
      await updateServerSettings({ [t.key]: t.invert ? !next : next });
    } catch (e: any) {
      showSnackbar({ message: e?.message || "Couldn't update the setting." });
    } finally {
      inFlight.current[t.key] = false;
      // Drop the optimistic value either way: success → store already shows
      // the new value; failure → store still shows the old one (rollback).
      // Guarded: the PATCH may settle after the screen unmounts.
      if (mountedRef.current) {
        setOverrides((o) => {
          const { [t.key]: _drop, ...rest } = o;
          return rest;
        });
      }
    }
  };

  // handleToggle's sibling for non-boolean settings (selects, arrays): same
  // per-key in-flight guard, optimistic override, and clear-on-settle rollback.
  // Still ONE key per PATCH — never the whole blob. Returns success so modal
  // callers (the prefix editor) know whether to close.
  const handleSelect = async (key: string, value: any): Promise<boolean> => {
    if (inFlight.current[key]) return false;
    inFlight.current[key] = true;
    setOverrides((o) => ({ ...o, [key]: value }));
    try {
      await updateServerSettings({ [key]: value });
      return true;
    } catch (e: any) {
      showSnackbar({ message: e?.message || "Couldn't update the setting." });
      return false;
    } finally {
      inFlight.current[key] = false;
      if (mountedRef.current) {
        setOverrides((o) => {
          const { [key]: _drop, ...rest } = o;
          return rest;
        });
      }
    }
  };

  // Override-aware read for the select rows / prefix editor.
  const settingValue = (key: string) =>
    key in overrides ? overrides[key] : serverSettings?.[key];

  const selectSubtitle = (spec: SelectSpec): string => {
    const value = settingValue(spec.key) ?? spec.fallback;
    return spec.options.find((o) => o.value === value)?.label ?? String(value);
  };

  const currentPrefixes: string[] = Array.isArray(settingValue("sortingPrefixes"))
    ? settingValue("sortingPrefixes")
    : [];

  const openPrefixEditor = () => {
    // Normalize the server blob on seed (trim + lowercase + dedupe) — a blob
    // edited elsewhere can carry case-duplicates like ["The", "the"], which
    // would render as colliding chips (and `key={p}` collisions).
    setPrefixDraft(
      Array.from(
        new Set(currentPrefixes.map((p) => String(p).trim().toLowerCase()).filter(Boolean))
      )
    );
    setPrefixInput("");
    setPrefixModalOpen(true);
  };

  const addPrefix = () => {
    // Normalize like the server stores them: trimmed + lowercased, no dupes.
    const p = prefixInput.trim().toLowerCase();
    if (!p) return;
    setPrefixDraft((cur) => (cur.includes(p) ? cur : [...cur, p]));
    setPrefixInput("");
  };

  const savePrefixes = async () => {
    if (savingPrefixes) return;
    // Fold a typed-but-not-Added prefix into the draft (same normalization +
    // dedupe as addPrefix) — Save right after typing must not drop the input.
    const pending = prefixInput.trim().toLowerCase();
    const draft =
      pending && !prefixDraft.includes(pending) ? [...prefixDraft, pending] : prefixDraft;
    if (pending) {
      setPrefixDraft(draft);
      setPrefixInput("");
    }
    if (draft.length === 0) {
      // The ABS server SILENTLY IGNORES an empty sortingPrefixes array (the
      // PATCH "succeeds" but nothing changes) — surface that instead of
      // letting the save look like it worked.
      showAppDialog({
        title: "At least one prefix required",
        message:
          "The server ignores an empty prefix list. Keep at least one prefix, or turn off " +
          "“Ignore prefixes when sorting” instead.",
      });
      return;
    }
    setSavingPrefixes(true);
    const ok = await handleSelect("sortingPrefixes", draft);
    if (mountedRef.current) {
      setSavingPrefixes(false);
      if (ok) {
        setPrefixModalOpen(false);
        showSnackbar({ message: "Sorting prefixes saved" });
      }
    }
  };

  // Prefix-modal a11y (mirrors the AdminEmail device modal / AppDialog on-open
  // pattern): RN Modal doesn't move screen-reader focus or announce itself on
  // Android, so on open we focus the title and announce the editor's purpose.
  const prefixModalTitleRef = useRef<Text>(null);
  useEffect(() => {
    if (!prefixModalOpen) return;
    const t = setTimeout(() => {
      if (Platform.OS === "android") {
        const node = findNodeHandle(prefixModalTitleRef.current);
        if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
      }
      AccessibilityInfo.announceForAccessibility(
        "Sorting prefixes. Add or remove the prefixes ignored when sorting titles."
      );
    }, 50);
    return () => clearTimeout(t);
  }, [prefixModalOpen]);

  const retry = () => {
    setSeeding(true);
    seed();
  };

  const version =
    typeof serverSettings?.version === "string" && serverSettings.version
      ? serverSettings.version
      : "Unknown";

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
          Server settings
        </Text>
      </View>

      {seeding && !serverSettings ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : !serverSettings ? (
        // Distinguish offline / forbidden / server via the shared mapper (the
        // static one-message-fits-all copy hid whether this was a connection or
        // a permission problem). Admin-appropriate forbidden copy is kept.
        <ErrorState
          style={{ flex: 1 }}
          {...absErrorToErrorStateProps(seedError, {
            subject: "server settings",
            onRetry: retry,
            overrides: {
              forbidden: { message: "Only server admins can change server settings." },
            },
          })}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Staleness note — values re-seed on focus, saves are immediate. */}
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 13,
              paddingHorizontal: 20,
              paddingTop: 14,
            }}
          >
            Refreshed from the server each time you open this screen. Each switch saves immediately.
          </Text>

          {SECTIONS.map((section) => (
            <View key={section.label}>
              <SectionHeader label={section.label} colors={colors} />
              {section.toggles.map((t, i) => (
                <View key={t.key}>
                  {i > 0 ? <Divider colors={colors} /> : null}
                  <ToggleRow
                    icon={t.icon}
                    title={t.title}
                    subtitle={t.subtitle}
                    value={displayedValue(t)}
                    onValueChange={(v) => handleToggle(t, v)}
                    colors={colors}
                  />
                  {/* The prefix LIST rides directly under its master toggle. */}
                  {t.key === "sortingIgnorePrefix" ? (
                    <>
                      <Divider colors={colors} />
                      <SelectRow
                        icon="sort"
                        title="Sorting prefixes"
                        subtitle={currentPrefixes.length ? currentPrefixes.join(", ") : "None"}
                        onPress={openPrefixEditor}
                        colors={colors}
                      />
                    </>
                  ) : null}
                </View>
              ))}
            </View>
          ))}

          <SectionHeader label="Localization" colors={colors} />
          {LOCALIZATION_SELECTS.map((spec, i) => (
            <View key={spec.key}>
              {i > 0 ? <Divider colors={colors} /> : null}
              <SelectRow
                icon={spec.icon}
                title={spec.title}
                subtitle={selectSubtitle(spec)}
                onPress={() => setOpenPicker(spec.key)}
                colors={colors}
              />
            </View>
          ))}

          <SectionHeader label="About" colors={colors} />
          <RowBase icon="info" title="Server version" subtitle={version} colors={colors} />
        </ScrollView>
      )}

      {/* Localization pickers — selecting PATCHes that single key. */}
      {LOCALIZATION_SELECTS.map((spec) => (
        <SettingSelectModal
          key={spec.key}
          visible={openPicker === spec.key}
          title={spec.title}
          options={spec.options}
          selected={settingValue(spec.key) ?? spec.fallback}
          onSelect={(v) => handleSelect(spec.key, v)}
          onClose={() => setOpenPicker(null)}
        />
      ))}

      {/* Sorting-prefixes editor (RN Modal, AdminEmail device-modal skeleton). */}
      <Modal
        visible={prefixModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setPrefixModalOpen(false)}
      >
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
                ref={prefixModalTitleRef}
                accessibilityRole="header"
                style={{ color: colors.onSurface, fontSize: 24, fontWeight: "600", marginBottom: 8 }}
              >
                Sorting prefixes
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginBottom: 20 }}>
                Titles starting with these words sort as if the prefix weren't there. Tap a
                prefix to remove it.
              </Text>

              {/* Removable chips (expiry-chip styling from AdminApiKeys). */}
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 8 }}>
                {prefixDraft.map((p) => (
                  <Pressable
                    key={p}
                    onPress={() => setPrefixDraft((cur) => cur.filter((x) => x !== p))}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove prefix ${p}`}
                    android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
                    hitSlop={{ top: 6, bottom: 6 }}
                    style={{
                      flexDirection: "row",
                      paddingHorizontal: 14,
                      height: 34,
                      borderRadius: 17,
                      overflow: "hidden",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 8,
                      marginBottom: 8,
                      backgroundColor: colors.secondaryContainer,
                      borderWidth: 1,
                      borderColor: colors.secondaryContainer,
                    }}
                  >
                    <Text
                      style={{
                        color: colors.onSecondaryContainer,
                        fontSize: 13,
                        fontWeight: "600",
                        marginRight: 6,
                      }}
                    >
                      {p}
                    </Text>
                    <Icon name="close" size={14} color={colors.onSecondaryContainer} />
                  </Pressable>
                ))}
                {prefixDraft.length === 0 ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginBottom: 8 }}>
                    No prefixes yet — add one below.
                  </Text>
                ) : null}
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 24 }}>
                <TextInput
                  value={prefixInput}
                  onChangeText={setPrefixInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="the"
                  placeholderTextColor={colors.onSurfaceVariant}
                  accessibilityLabel="New sorting prefix"
                  onSubmitEditing={addPrefix}
                  returnKeyType="done"
                  style={{
                    flex: 1,
                    backgroundColor: colors.surface,
                    color: colors.onSurface,
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 16,
                    borderWidth: 1,
                    borderColor: colors.outline,
                    marginRight: 8,
                  }}
                />
                <Pressable
                  onPress={addPrefix}
                  accessibilityRole="button"
                  accessibilityLabel="Add prefix"
                  style={{ paddingHorizontal: 16, paddingVertical: 12 }}
                >
                  <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "600" }}>Add</Text>
                </Pressable>
              </View>

              <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                <Pressable
                  onPress={() => setPrefixModalOpen(false)}
                  accessibilityRole="button"
                  style={{ paddingHorizontal: 20, paddingVertical: 12, marginRight: 8 }}
                >
                  <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "600" }}>
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  onPress={savePrefixes}
                  disabled={savingPrefixes}
                  accessibilityRole="button"
                  accessibilityLabel="Save sorting prefixes"
                  accessibilityState={{ disabled: savingPrefixes, busy: savingPrefixes }}
                  style={{
                    backgroundColor: colors.primary,
                    paddingHorizontal: 20,
                    paddingVertical: 12,
                    borderRadius: 24,
                    flexDirection: "row",
                    alignItems: "center",
                  }}
                >
                  {savingPrefixes ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.onPrimary}
                      style={{ marginRight: 8 }}
                    />
                  ) : null}
                  <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600" }}>
                    Save
                  </Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
