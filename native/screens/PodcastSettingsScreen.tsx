import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { showAppDialog } from "../store/useDialogStore";

/**
 * PodcastSettingsScreen — surfaces a single podcast's SERVER-managed
 * auto-download settings (podcasts are server-managed; the auto-download runs on
 * a server cron, so this screen just reads/writes the podcast media fields).
 *
 * Route: "PodcastSettings"
 * Params: { libraryItemId: string; item?: any; podcastTitle?: string }
 *
 * Reads `item.media.{autoDownloadEpisodes,autoDownloadSchedule,maxEpisodesToKeep,
 * maxNewEpisodesToDownload,lastEpisodeCheck}` and writes them back via
 * `PATCH /api/items/{id}/media`. All write endpoints are admin-gated on the
 * server, so a non-admin sees the settings read-only with a note.
 */

// Friendly cron presets (label → 5-field cron). The raw value stays visible and
// editable so an admin can enter any custom schedule.
const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily", cron: "0 3 * * *" },
  { label: "Weekly", cron: "0 3 * * 0" },
];

// Admin-or-up decides whether the write controls are enabled. ABS marks these
// endpoints admin-only; a full user object carries `type` ("root"/"admin") and a
// `permissions.update` flag. On a restored (cold-start) session the store user
// may only hold {id, username}, so we also read the authoritative /api/me below.
function isAdminUser(u: any): boolean {
  return (
    !!u &&
    (u.type === "admin" || u.type === "root" || !!(u.permissions && u.permissions.update))
  );
}

// A cron string is "shaped" when it has exactly 5 whitespace-separated fields.
// We don't fully validate each field (the server does) — just guard obvious
// garbage before a PATCH.
function isCronShaped(s: string): boolean {
  return s.trim().split(/\s+/).filter(Boolean).length === 5;
}

// Parse a non-negative integer field, returning null when it isn't one.
function parseCount(s: string): number | null {
  const trimmed = (s ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Module-scope so their identity is stable across the screen's re-renders —
// an inline (per-render) component would remount its TextInput on every
// keystroke, dropping the controlled value.
function Toggle({
  value,
  onValueChange,
  disabled,
  label,
  colors,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  colors: any;
}) {
  const TRACK_W = 52;
  const TRACK_H = 32;
  const knob = value ? 24 : 16;
  const pad = (TRACK_H - knob) / 2;
  return (
    <Pressable
      onPress={() => !disabled && onValueChange(!value)}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={label}
      style={{
        width: TRACK_W,
        height: TRACK_H,
        borderRadius: TRACK_H / 2,
        backgroundColor: value ? colors.primary : colors.surfaceContainerHighest,
        borderWidth: value ? 0 : 2,
        borderColor: colors.outline,
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        style={{
          position: "absolute",
          left: value ? TRACK_W - knob - pad : pad,
          width: knob,
          height: knob,
          borderRadius: knob / 2,
          backgroundColor: value ? colors.onPrimary : colors.outline,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value ? <Icon name="check" size={16} color={colors.primary} /> : null}
      </View>
    </Pressable>
  );
}

function NumberField({
  label,
  helper,
  value,
  onChangeText,
  accessibilityLabel,
  editable,
  colors,
}: {
  label: string;
  helper?: string;
  value: string;
  onChangeText: (t: string) => void;
  accessibilityLabel: string;
  editable: boolean;
  colors: any;
}) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
      <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>{label}</Text>
      {helper ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2, marginBottom: 8 }}>
          {helper}
        </Text>
      ) : (
        <View style={{ height: 8 }} />
      )}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        keyboardType="number-pad"
        accessibilityLabel={accessibilityLabel}
        placeholderTextColor={colors.onSurfaceVariant}
        style={{
          backgroundColor: colors.surfaceContainer,
          color: colors.onSurface,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          fontSize: 15,
          opacity: editable ? 1 : 0.6,
          maxWidth: 140,
        }}
      />
    </View>
  );
}

export default function PodcastSettingsScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const params = route?.params || {};
  const libraryItemId: string | undefined = params.libraryItemId || params.item?.id;

  const storeUser = useUserStore((s) => s.user);

  const [item, setItem] = useState<any>(params.item || null);
  const [serverUser, setServerUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  // Editable form state (strings for the number inputs so partial edits don't
  // fight the controlled input).
  const [autoDownload, setAutoDownload] = useState(false);
  const [schedule, setSchedule] = useState("");
  const [maxNew, setMaxNew] = useState("3");
  const [maxKeep, setMaxKeep] = useState("0");

  // The authoritative user (server first, store fallback) drives admin gating.
  const isAdmin = isAdminUser(serverUser) || isAdminUser(storeUser);

  const seedFromItem = (it: any) => {
    const media = it?.media || {};
    setAutoDownload(!!media.autoDownloadEpisodes);
    setSchedule(media.autoDownloadSchedule ? String(media.autoDownloadSchedule) : "");
    // maxNewEpisodesToDownload defaults to 3 on the server.
    setMaxNew(
      media.maxNewEpisodesToDownload === undefined || media.maxNewEpisodesToDownload === null
        ? "3"
        : String(media.maxNewEpisodesToDownload)
    );
    setMaxKeep(
      media.maxEpisodesToKeep === undefined || media.maxEpisodesToKeep === null
        ? "0"
        : String(media.maxEpisodesToKeep)
    );
  };

  useEffect(() => {
    if (!libraryItemId) {
      setError("No podcast provided.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      // Fetch the item (authoritative media fields) and the current user (admin
      // status) in parallel. The /api/me failure is non-fatal — we fall back to
      // the store user for gating.
      try {
        const [itemRes, meRes] = await Promise.allSettled([
          api.get(`/api/items/${libraryItemId}`),
          api.get("/api/me"),
        ]);
        if (cancelled) return;
        if (itemRes.status === "rejected") throw itemRes.reason;
        const it = itemRes.value?.data;
        setItem(it);
        seedFromItem(it);
        if (meRes.status === "fulfilled") setServerUser(meRes.value?.data || null);
      } catch (err: any) {
        if (cancelled) return;
        console.error("[PodcastSettings] Failed to load podcast:", err);
        // No HTTP response means the request never reached the server (offline).
        setError(
          err?.response
            ? "Failed to load podcast settings."
            : "You're offline. Reconnect to view or change this podcast's settings."
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [libraryItemId, retryTick]);

  const podcastTitle =
    item?.media?.metadata?.title || params.podcastTitle || "Podcast";
  const lastCheck = item?.media?.lastEpisodeCheck;

  const formatDateTime = (value: any): string => {
    if (!value) return "Never";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "Never";
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  // Whether the current form differs from the loaded item (drives Save enabled).
  const dirty = useMemo(() => {
    const media = item?.media || {};
    const curSchedule = media.autoDownloadSchedule ? String(media.autoDownloadSchedule) : "";
    const curMaxNew =
      media.maxNewEpisodesToDownload === undefined || media.maxNewEpisodesToDownload === null
        ? "3"
        : String(media.maxNewEpisodesToDownload);
    const curMaxKeep =
      media.maxEpisodesToKeep === undefined || media.maxEpisodesToKeep === null
        ? "0"
        : String(media.maxEpisodesToKeep);
    return (
      autoDownload !== !!media.autoDownloadEpisodes ||
      schedule.trim() !== curSchedule.trim() ||
      maxNew.trim() !== curMaxNew.trim() ||
      maxKeep.trim() !== curMaxKeep.trim()
    );
  }, [item, autoDownload, schedule, maxNew, maxKeep]);

  const doSave = async (payload: {
    autoDownloadEpisodes: boolean;
    autoDownloadSchedule: string | null;
    maxEpisodesToKeep: number;
    maxNewEpisodesToDownload: number;
  }) => {
    if (!libraryItemId) return;
    setSaving(true);
    try {
      const res = await api.patch(`/api/items/${libraryItemId}/media`, payload);
      // Reflect the saved values locally so `dirty` resets and the fields keep
      // showing what the server now holds. The PATCH may echo the updated item;
      // fall back to merging the payload into the current media.
      const updated =
        res?.data && res.data.media
          ? res.data
          : { ...item, media: { ...(item?.media || {}), ...payload, autoDownloadSchedule: payload.autoDownloadSchedule } };
      setItem(updated);
      seedFromItem(updated);
      showAppDialog({ title: "Saved", message: "Podcast settings updated." });
    } catch (err: any) {
      console.warn("[PodcastSettings] save failed", err);
      showAppDialog({
        title: "Couldn't save",
        message: err?.response
          ? "The server rejected the change. You may not have permission to edit this podcast."
          : "You're offline. Reconnect and try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (!isAdmin || saving) return;
    const parsedMaxNew = parseCount(maxNew);
    if (parsedMaxNew === null) {
      showAppDialog({
        title: "Invalid input",
        message: "Max new episodes to download must be a whole number (0 or more).",
      });
      return;
    }
    const parsedMaxKeep = parseCount(maxKeep);
    if (parsedMaxKeep === null) {
      showAppDialog({
        title: "Invalid input",
        message: "Max episodes to keep must be a whole number (0 or more).",
      });
      return;
    }
    const trimmedSchedule = schedule.trim();
    // A schedule only matters when auto-download is on; if on, it must be a
    // 5-field cron string.
    if (autoDownload && (!trimmedSchedule || !isCronShaped(trimmedSchedule))) {
      showAppDialog({
        title: "Invalid schedule",
        message:
          "Enter a valid cron schedule (5 fields), or pick one of the presets, before turning on auto-download.",
      });
      return;
    }
    showAppDialog({
      title: "Save podcast settings",
      message: "Update the server's auto-download settings for this podcast?",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          onPress: () =>
            doSave({
              autoDownloadEpisodes: autoDownload,
              autoDownloadSchedule: trimmedSchedule || null,
              maxEpisodesToKeep: parsedMaxKeep,
              maxNewEpisodesToDownload: parsedMaxNew,
            }),
        },
      ],
    });
  };

  const handleCheckNew = async () => {
    if (!libraryItemId || checking) return;
    setChecking(true);
    try {
      const res = await api.get(`/api/podcasts/${libraryItemId}/checknew?limit=3`);
      const data = res?.data;
      const eps: any[] = Array.isArray(data?.episodes)
        ? data.episodes
        : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data)
        ? data
        : [];
      if (!eps.length) {
        showAppDialog({
          title: "No new episodes",
          message: "The feed has no new episodes right now.",
        });
        return;
      }
      const titles = eps
        .slice(0, 5)
        .map((e) => `• ${e?.title || e?.episode?.title || "Untitled episode"}`)
        .join("\n");
      const more = eps.length > 5 ? `\n…and ${eps.length - 5} more` : "";
      showAppDialog({
        title: `Found ${eps.length} new episode${eps.length === 1 ? "" : "s"}`,
        message: `${titles}${more}`,
      });
    } catch (err: any) {
      console.warn("[PodcastSettings] checknew failed", err);
      showAppDialog({
        title: "Couldn't check the feed",
        message: err?.response
          ? "The server couldn't check this podcast's feed right now."
          : "You're offline. Reconnect and try again.",
      });
    } finally {
      setChecking(false);
    }
  };

  const sectionLabel = (text: string) => (
    <Text
      style={{
        color: colors.onSurfaceVariant,
        fontSize: 12,
        fontWeight: "700",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 4,
      }}
    >
      {text}
    </Text>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Header */}
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
          Podcast Settings
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          icon="podcast"
          title="Couldn't load settings"
          message={error}
          onRetry={libraryItemId ? () => setRetryTick((t) => t + 1) : undefined}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Podcast title */}
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <Text
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700" }}
            >
              {podcastTitle}
            </Text>
          </View>

          {/* Non-admin read-only note */}
          {!isAdmin ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginHorizontal: 16,
                marginTop: 12,
                padding: 12,
                borderRadius: 12,
                backgroundColor: colors.secondaryContainer,
              }}
              accessibilityRole="alert"
            >
              <Icon name="lock" size={18} color={colors.onSecondaryContainer} style={{ marginRight: 10 }} />
              <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, flex: 1 }}>
                Only server admins can change these settings. Showing the current values.
              </Text>
            </View>
          ) : null}

          {sectionLabel("Auto-download")}

          {/* Auto-download toggle */}
          <Pressable
            onPress={() => isAdmin && setAutoDownload((v) => !v)}
            disabled={!isAdmin}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 16,
              paddingVertical: 14,
            }}
          >
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
                Auto-download episodes
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                The server downloads new episodes on the schedule below.
              </Text>
            </View>
            <Toggle
              value={autoDownload}
              onValueChange={setAutoDownload}
              disabled={!isAdmin}
              label="Auto-download episodes"
              colors={colors}
            />
          </Pressable>

          {/* Schedule presets */}
          <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", paddingHorizontal: 16, marginTop: 6 }}>
            Schedule
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, alignItems: "center" }}
          >
            {CRON_PRESETS.map((preset) => {
              const active = schedule.trim() === preset.cron;
              return (
                <Pressable
                  key={preset.cron}
                  onPress={() => isAdmin && setSchedule(preset.cron)}
                  disabled={!isAdmin}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: !isAdmin }}
                  accessibilityLabel={`Schedule: ${preset.label}`}
                  android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
                  style={{
                    paddingHorizontal: 14,
                    height: 34,
                    borderRadius: 17,
                    overflow: "hidden",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 8,
                    opacity: isAdmin ? 1 : 0.6,
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
          </ScrollView>

          {/* Raw cron value */}
          <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginBottom: 6 }}>
              Cron schedule (raw)
            </Text>
            <TextInput
              value={schedule}
              onChangeText={setSchedule}
              editable={isAdmin}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="0 3 * * *"
              placeholderTextColor={colors.onSurfaceVariant}
              accessibilityLabel="Auto-download schedule (cron)"
              style={{
                backgroundColor: colors.surfaceContainer,
                color: colors.onSurface,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 15,
                opacity: isAdmin ? 1 : 0.6,
              }}
            />
          </View>

          {sectionLabel("Limits")}

          <NumberField
            label="Max new episodes to download"
            helper="Newest episodes fetched each time the feed is checked."
            value={maxNew}
            onChangeText={setMaxNew}
            accessibilityLabel="Max new episodes to download"
            editable={isAdmin}
            colors={colors}
          />
          <NumberField
            label="Max episodes to keep"
            helper="Older downloads are removed beyond this count. 0 keeps them all."
            value={maxKeep}
            onChangeText={setMaxKeep}
            accessibilityLabel="Max episodes to keep"
            editable={isAdmin}
            colors={colors}
          />

          {sectionLabel("Feed")}

          <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
              Last checked: {formatDateTime(lastCheck)}
            </Text>
          </View>

          {/* Check for new episodes now */}
          <Pressable
            onPress={handleCheckNew}
            disabled={checking}
            accessibilityRole="button"
            accessibilityLabel="Check for new episodes now"
            android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.14) }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              marginHorizontal: 16,
              marginTop: 6,
              height: 48,
              borderRadius: 24,
              overflow: "hidden",
              backgroundColor: colors.secondaryContainer,
              opacity: checking ? 0.7 : 1,
            }}
          >
            {checking ? (
              <ActivityIndicator size="small" color={colors.onSecondaryContainer} />
            ) : (
              <>
                <Icon name="refresh" size={18} color={colors.onSecondaryContainer} />
                <Text style={{ color: colors.onSecondaryContainer, fontSize: 15, fontWeight: "600", marginLeft: 8 }}>
                  Check for new episodes now
                </Text>
              </>
            )}
          </Pressable>

          {/* Save (admin only) */}
          {isAdmin ? (
            <Pressable
              onPress={handleSave}
              disabled={saving || !dirty}
              accessibilityRole="button"
              accessibilityLabel="Save podcast settings"
              accessibilityState={{ disabled: saving || !dirty }}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                marginHorizontal: 16,
                marginTop: 12,
                height: 48,
                borderRadius: 24,
                overflow: "hidden",
                backgroundColor: colors.primary,
                opacity: saving || !dirty ? 0.5 : 1,
              }}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700" }}>
                  Save changes
                </Text>
              )}
            </Pressable>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
