import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import HintPressable from "../components/HintPressable";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { ToggleRow, Divider, SectionHeader } from "../components/SettingsRows";
import { showSnackbar } from "../store/useSnackbarStore";
import { getNotificationSettings, updateNotification } from "../utils/abs/notifications";
import { absErrorToErrorStateProps, absErrorToActionMessage } from "../utils/abs/errors";
import type { AbsNotification, AbsNotificationSettings } from "../utils/abs/types";

/**
 * AdminNotificationsScreen — Apprise event notifications (admin-and-up: the
 * whole /api/notifications surface is admin-gated server-side).
 *
 * Route: "AdminNotifications" (no params)
 *
 * Scope (conservative v1): list + per-notification enabled toggle ONLY.
 * Creating/deleting notifications and editing the Apprise settings (API URL,
 * templates, retry limits) stay on the Audiobookshelf web dashboard — the
 * banner up top says so. The notification endpoints are verified at docs
 * level, not against the server source (see utils/abs/notifications.ts), so
 * this screen deliberately avoids any write beyond the enabled flip.
 */

// Map a normalized AbsError to full-screen ErrorState props via the shared
// engine (same pattern as AdminFeedsScreen).
function describeLoadError(e: any) {
  return absErrorToErrorStateProps(e, {
    subject: "notifications",
    overrides: {
      offline: { message: "Reconnect to manage notifications." },
      forbidden: { message: "Only server admins can manage notifications." },
      unsupported: {
        title: "Not available on this server",
        message: "This server doesn't offer notification management (it may need an update).",
      },
      auth: { title: "Couldn't load notifications" },
      server: { title: "Couldn't load notifications" },
    },
  });
}

const actionErrorMessage = (e: any) =>
  absErrorToActionMessage(e, { forbidden: "Only server admins can manage notifications." });

// Known ABS notification event names → human row titles. Unknown events fall
// back to the raw eventName so a new server-side event never renders blank.
const EVENT_LABELS: Record<string, string> = {
  onPodcastEpisodeDownloaded: "Podcast episode downloaded",
  onBackupCompleted: "Backup completed",
  onBackupFailed: "Backup failed",
  onTest: "Test",
};

function eventLabel(eventName?: string): string {
  return (eventName && EVENT_LABELS[eventName]) || eventName || "Notification";
}

function notificationSubtitle(n: AbsNotification): string | undefined {
  const url = Array.isArray(n.urls) ? n.urls[0] : undefined;
  const failed = n.lastAttemptFailed ? " · last attempt failed" : "";
  if (!url) return failed ? failed.replace(" · ", "") : undefined;
  return `${url}${failed}`;
}

export default function AdminNotificationsScreen({ navigation }: any) {
  const colors = useThemeColors();

  const [settings, setSettings] = useState<AbsNotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  const [retryTick, setRetryTick] = useState(0);
  // Notification id with an in-flight enabled write (guards double-toggles).
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getNotificationSettings();
        if (cancelled) return;
        setSettings(data);
      } catch (e) {
        if (cancelled) return;
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [retryTick]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setSettings(await getNotificationSettings());
      setError(null);
    } catch (e) {
      showSnackbar({ message: actionErrorMessage(e) });
    } finally {
      setRefreshing(false);
    }
  };

  // Flip one notification's enabled flag in local state (optimistic + revert).
  const applyEnabled = (id: string, enabled: boolean) =>
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            notifications: prev.notifications.map((x) => (x.id === id ? { ...x, enabled } : x)),
          }
        : prev
    );

  const handleToggle = async (n: AbsNotification, next: boolean) => {
    if (savingId === n.id) return;
    setSavingId(n.id);
    // Optimistic: flip at once, revert with a snackbar if the server rejects.
    applyEnabled(n.id, next);
    try {
      // Full object (not just { enabled }) — see updateNotification's
      // partial-vs-full note in utils/abs/notifications.ts.
      await updateNotification({ ...n, enabled: next });
    } catch (e) {
      applyEnabled(n.id, !next);
      showSnackbar({ message: actionErrorMessage(e) });
    } finally {
      setSavingId(null);
    }
  };

  const notifications = settings?.notifications ?? [];

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
        <HintPressable
          onPress={() => navigation.goBack()}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </HintPressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
          Notifications
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          {...describeLoadError(error)}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />
          }
        >
          {/* Apprise status + where creation/editing happens (web dashboard). */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginHorizontal: 16,
              marginTop: 16,
              padding: 12,
              borderRadius: 12,
              backgroundColor: colors.secondaryContainer,
            }}
          >
            <Icon name="info" size={18} color={colors.onSecondaryContainer} style={{ marginRight: 10 }} />
            <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, flex: 1 }}>
              {settings?.appriseApiUrl
                ? `Apprise API: ${settings.appriseApiUrl}`
                : "Apprise is not configured on this server."}
              {"\n"}
              Create and edit notifications from the Audiobookshelf web dashboard.
            </Text>
          </View>

          {notifications.length === 0 ? (
            <EmptyState
              icon="bell"
              title="No notifications"
              message="Notifications created from the Audiobookshelf web dashboard appear here, where you can enable or disable them."
            />
          ) : (
            <>
              <SectionHeader label={`Notifications (${notifications.length})`} colors={colors} />
              {notifications.map((n, index) => (
                <View key={n.id} style={{ opacity: savingId === n.id ? 0.5 : 1 }}>
                  {index > 0 ? <Divider colors={colors} /> : null}
                  <ToggleRow
                    icon="bell"
                    title={eventLabel(n.eventName)}
                    subtitle={notificationSubtitle(n)}
                    value={!!n.enabled}
                    onValueChange={(next) => handleToggle(n, next)}
                    colors={colors}
                  />
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
