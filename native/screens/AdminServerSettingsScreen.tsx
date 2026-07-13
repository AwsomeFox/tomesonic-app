import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon, { IconName } from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { SectionHeader, ToggleRow, RowBase, Divider } from "../components/SettingsRows";
import { useUserStore } from "../store/useUserStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { refreshCapabilities } from "../utils/abs/capabilities";
import { updateServerSettings } from "../utils/abs/server";

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
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const inFlight = useRef<Record<string, boolean>>({});

  const seed = useCallback(async () => {
    await refreshCapabilities(); // never throws; store stays as-is on failure
    setSeeding(false);
  }, []);

  // Seed on mount AND on every re-focus (staleness mitigation: another admin
  // may have changed settings on the web dashboard while we were away).
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
      setOverrides((o) => {
        const { [t.key]: _drop, ...rest } = o;
        return rest;
      });
    }
  };

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
        <ErrorState
          style={{ flex: 1 }}
          icon="settings"
          title="Couldn't load server settings"
          message="Loading these needs a connection and an admin account. Check both, then retry."
          onRetry={retry}
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
                </View>
              ))}
            </View>
          ))}

          <SectionHeader label="About" colors={colors} />
          <RowBase icon="info" title="Server version" subtitle={version} colors={colors} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
