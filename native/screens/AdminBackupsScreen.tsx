import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import HintPressable from "../components/HintPressable";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { SectionHeader, RowBase, Divider } from "../components/SettingsRows";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { getBackups, createBackup, deleteBackup } from "../utils/abs/server";
import { absErrorToErrorStateProps, absErrorToActionMessage } from "../utils/abs/errors";
import { formatBytes } from "../utils/format";
import type { AbsBackup } from "../utils/abs/types";

/**
 * AdminBackupsScreen — server backup management (admin-and-up).
 *
 * Route: "AdminBackups" (no params)
 *
 * Scope (deliberate): list, create ("Back up now"), delete. APPLYING/RESTORING
 * a backup is intentionally NOT offered from the app — a restore replaces all
 * server data and restarts the server, and shipping that button without the
 * full restart/re-login choreography reads as data loss or a crash. Tracked in
 * GitHub issue #60; until then the screen points restores at the web UI.
 *
 * All utils/abs calls THROW AbsError, so the catch blocks switch on `kind`
 * (offline / forbidden / unsupported / ...) instead of sniffing axios shapes.
 */

// Map a normalized AbsError to full-screen ErrorState props via the shared
// engine — including the mapper's SEMANTIC icon (offline → cloud-off, etc.),
// spread at the call site for cross-screen consistency. auth/server keep this
// screen's historical generic title.
function describeLoadError(e: any) {
  return absErrorToErrorStateProps(e, {
    subject: "backups",
    overrides: {
      offline: { message: "Reconnect to manage server backups." },
      forbidden: { message: "Only server admins can manage backups." },
      unsupported: {
        title: "Not available on this server",
        message: "This server doesn't offer backup management (it may need an update).",
      },
      auth: { title: "Couldn't load backups" },
      server: { title: "Couldn't load backups" },
    },
  });
}

// Human text for the server's backup cron ("30 1 * * *" → "daily at 1:30 AM").
// Only the common daily/weekly shapes are prettified; anything else falls back
// to showing the raw cron so the admin still sees SOMETHING accurate.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    if (dom === "*" && mon === "*" && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
      const d = new Date();
      d.setHours(Number(hour), Number(min), 0, 0);
      const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      if (dow === "*") return `daily at ${time}`;
      if (/^\d+$/.test(dow) && WEEKDAYS[Number(dow) % 7]) {
        return `weekly on ${WEEKDAYS[Number(dow) % 7]} at ${time}`;
      }
    }
  }
  return `on schedule ${cron}`;
}

// Action failures (create/delete) surface as dialogs so the list stays put.
const actionErrorMessage = (e: any) =>
  absErrorToActionMessage(e, { forbidden: "Only server admins can manage backups." });

export default function AdminBackupsScreen({ navigation }: any) {
  const colors = useThemeColors();

  const [backups, setBackups] = useState<AbsBackup[]>([]);
  const [backupLocation, setBackupLocation] = useState<string>("");
  // Automatic-backup config from GET /api/backups: the cron (or false when
  // disabled) and the rotation count. Read-only here — editing the schedule
  // stays on the web dashboard.
  const [backupSchedule, setBackupSchedule] = useState<string | false | null>(null);
  const [backupsToKeep, setBackupsToKeep] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [creating, setCreating] = useState(false);
  // Backup id currently being deleted (dims its row, guards double-taps).
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Seed list + automatic-backup summary from a GET /api/backups payload. The
  // schedule fields ride along on the same response (typed loosely because the
  // utils return type only declares the list fields).
  const applySnapshot = (data: any) => {
    setBackups(Array.isArray(data?.backups) ? data.backups : []);
    setBackupLocation(data?.backupLocation || "");
    setBackupSchedule(
      typeof data?.backupSchedule === "string" || data?.backupSchedule === false
        ? data.backupSchedule
        : null
    );
    setBackupsToKeep(typeof data?.backupsToKeep === "number" ? data.backupsToKeep : null);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getBackups();
        if (cancelled) return;
        applySnapshot(data);
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
      const data = await getBackups();
      applySnapshot(data);
      setError(null);
    } catch (e) {
      // Pull-to-refresh failure on an already-rendered list: keep the stale
      // list (better than nuking it) and mention the failure quietly.
      showSnackbar({ message: actionErrorMessage(e) });
    } finally {
      setRefreshing(false);
    }
  };

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      // POST /api/backups is synchronous server-side and answers with the
      // refreshed list — no follow-up GET needed.
      const data = await createBackup();
      if (Array.isArray(data?.backups)) setBackups(data.backups);
      showSnackbar({ message: "Backup created" });
    } catch (e) {
      showAppDialog({ title: "Couldn't create backup", message: actionErrorMessage(e) });
    } finally {
      setCreating(false);
    }
  };

  const doDelete = async (backup: AbsBackup) => {
    setDeletingId(backup.id);
    try {
      const data = await deleteBackup(backup.id);
      if (Array.isArray(data?.backups)) {
        setBackups(data.backups);
      } else {
        setBackups((prev) => prev.filter((b) => b.id !== backup.id));
      }
      showSnackbar({ message: "Backup deleted" });
    } catch (e) {
      showAppDialog({ title: "Couldn't delete backup", message: actionErrorMessage(e) });
    } finally {
      setDeletingId(null);
    }
  };

  const confirmDelete = (backup: AbsBackup) => {
    showAppDialog({
      title: "Delete backup?",
      message: `Delete the backup from ${backup.datePretty}? This can't be undone.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => doDelete(backup) },
      ],
    });
  };

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
          Backups
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
          {/* Back up now */}
          <HintPressable
            onPress={handleCreate}
            disabled={creating}
            accessibilityRole="button"
            accessibilityLabel="Back up now"
            accessibilityState={{ disabled: creating, busy: creating }}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              marginHorizontal: 16,
              marginTop: 16,
              height: 48,
              borderRadius: 24,
              overflow: "hidden",
              backgroundColor: colors.primary,
              opacity: creating ? 0.7 : 1,
            }}
          >
            {creating ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <>
                <Icon name="database" size={18} color={colors.onPrimary} />
                <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700", marginLeft: 8 }}>
                  Back up now
                </Text>
              </>
            )}
          </HintPressable>

          {/* Restore-from-web note — Apply/Restore is deliberately not offered
              in the app (see header comment / issue #60). */}
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
          >
            <Icon name="info" size={18} color={colors.onSecondaryContainer} style={{ marginRight: 10 }} />
            <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, flex: 1 }}>
              Restoring a backup isn't available in the app — restoring replaces all server data and
              restarts the server. Use the web dashboard to restore.
            </Text>
          </View>

          {/* Automatic-backup summary (read-only): the server's cron schedule,
              rotation count, and target location — so an admin can tell at a
              glance that scheduled backups are configured. Editing the
              schedule stays on the web dashboard. */}
          {backupSchedule != null || backupsToKeep != null || backupLocation ? (
            <View
              style={{
                marginHorizontal: 16,
                marginTop: 12,
                padding: 12,
                borderRadius: 12,
                backgroundColor: colors.surfaceContainer,
              }}
            >
              <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600", marginBottom: 4 }}>
                Automatic backups
              </Text>
              {typeof backupSchedule === "string" && backupSchedule ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
                  Runs {describeCron(backupSchedule)}
                </Text>
              ) : backupSchedule === false ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
                  Off — backups only run when you create one
                </Text>
              ) : null}
              {backupsToKeep != null ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
                  Keeps the {backupsToKeep} most recent {backupsToKeep === 1 ? "backup" : "backups"}
                </Text>
              ) : null}
              {backupLocation ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
                  Backup location: {backupLocation}
                </Text>
              ) : null}
            </View>
          ) : null}

          {backups.length === 0 ? (
            <EmptyState
              icon="database"
              title="No backups yet"
              message="Create one now to protect your library data."
            />
          ) : (
            <>
              <SectionHeader
                label={`Backups (${backups.length})`}
                colors={colors}
              />
              {backups.map((backup, index) => (
                <View key={backup.id} style={{ opacity: deletingId === backup.id ? 0.5 : 1 }}>
                  {index > 0 ? <Divider colors={colors} /> : null}
                  <RowBase
                    icon="database"
                    title={backup.datePretty || backup.filename || backup.id}
                    subtitle={`${formatBytes(backup.fileSize)}${
                      backup.serverVersion ? ` · v${backup.serverVersion}` : ""
                    }`}
                    colors={colors}
                    trailing={
                      <HintPressable
                        onPress={() => confirmDelete(backup)}
                        disabled={deletingId === backup.id}
                        style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete backup ${backup.datePretty || backup.id}`}
                        android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
                      >
                        <Icon name="trash" size={22} color={colors.error} />
                      </HintPressable>
                    }
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
