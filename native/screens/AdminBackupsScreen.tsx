import React, { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Linking } from "react-native";
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
import {
  getBackups,
  createBackup,
  deleteBackup,
  applyBackup,
  buildBackupDownloadUrl,
} from "../utils/abs/server";
import { absErrorToErrorStateProps, absErrorToActionMessage } from "../utils/abs/errors";
import { refreshCapabilities, useServerCapabilities } from "../utils/abs/capabilities";
import { waitForServerUp } from "../utils/serverLiveness";
import { storageHelper } from "../utils/storage";
import { formatBytes } from "../utils/format";
import type { AbsBackup } from "../utils/abs/types";

/**
 * AdminBackupsScreen — server backup management (admin-and-up).
 *
 * Route: "AdminBackups" (no params)
 *
 * Scope: list, create ("Back up now"), download, delete, and RESTORE (apply)
 * — issue #60. Applying a backup replaces ALL server data and drops every
 * session (including ours), so the restore flow runs a small state machine
 * instead of a fire-and-forget call:
 *
 *   idle → applying → verifying ────────────────→ idle (success snackbar)
 *             │            │ (API up, DB not yet)
 *             │ (offline/  ▼
 *             │  auth)  reconnecting ── /ping up ─→ verifying
 *             │            │
 *             └────────────┴─ deadline passed ───→ timeout (guidance view)
 *
 * A REAL server refusal (403/404/5xx/unknown) from the apply call surfaces a
 * failure dialog and returns to idle — it is never auto-retried, because
 * /apply is a side-effecting GET.
 *
 * All utils/abs calls THROW AbsError, so the catch blocks switch on `kind`
 * (offline / forbidden / unsupported / ...) instead of sniffing axios shapes.
 */

/** How long each reconnect episode watches for the server (5 minutes). */
const RESTORE_WAIT_MS = 5 * 60_000;

type RestorePhase = "idle" | "applying" | "reconnecting" | "verifying" | "timeout";
interface RestoreState {
  phase: RestorePhase;
  backup?: AbsBackup;
  deadlineAt?: number;
}

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
  const caps = useServerCapabilities();

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

  // Restore (apply) state machine — see the header diagram.
  const [restore, setRestore] = useState<RestoreState>({ phase: "idle" });
  // Unmount guard for the long-running restore choreography: waitForServerUp
  // and the verify round-trip outlive any single render, so EVERY setRestore
  // goes through setRestoreSafe. restorePhaseRef mirrors the phase
  // synchronously — dialog onPress closures outlive the tap that created
  // them, so the re-entrancy checks can't trust the render-time state.
  const restoreCancelledRef = useRef(false);
  const restorePhaseRef = useRef<RestorePhase>("idle");
  const setRestoreSafe = (next: RestoreState) => {
    restorePhaseRef.current = next.phase;
    if (!restoreCancelledRef.current) setRestore(next);
  };
  useEffect(() => {
    return () => {
      restoreCancelledRef.current = true;
    };
  }, []);

  // Belt-and-braces for cold-restored thin sessions ({ id, username } only):
  // hydrate the full user so caps.isRoot below is accurate. refreshCapabilities
  // never throws, but the catch keeps a future refactor from surprising us.
  useEffect(() => {
    refreshCapabilities().catch(() => {});
  }, []);

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

  // Download-to-device (ItemDetail's handleZipDownload structure): tokened URL
  // for the OS download manager, since it can't send our auth header.
  const handleDownload = (backup: AbsBackup) => {
    const url = buildBackupDownloadUrl(backup.id);
    if (!url) {
      showAppDialog({
        title: "Can't download",
        message: "No server session available. Reconnect and try again.",
      });
      return;
    }
    // Same fallback chain as the row title, and the size only when the server
    // actually reported one (mirrors ItemDetail's zip-size guard).
    const label = backup.datePretty || backup.filename || backup.id;
    const size = backup.fileSize > 0 ? ` (${formatBytes(backup.fileSize)})` : "";
    showAppDialog({
      title: "Download backup",
      message:
        `Download the backup from ${label}${size}? ` +
        "The archive contains the full server database. It's handed to your browser's " +
        "download manager, so large files stream straight to storage. " +
        "The download link carries your admin session token.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Download",
          onPress: () => {
            // Deliberately NOT axios and NOT the in-app downloads store: the
            // archive must stream via the OS download manager, and it isn't a
            // playable in-app download. Success feedback only once the OS
            // actually took the URL — a device with no browser lands in the
            // catch, which must not claim the handoff happened.
            Linking.openURL(url)
              .then(() => {
                showSnackbar({ message: "Backup download handed to your browser" });
              })
              .catch(() => {
                showAppDialog({
                  title: "Couldn't download",
                  message: "Couldn't open a browser for the download.",
                });
              });
          },
        },
      ],
    });
  };

  const confirmDelete = (backup: AbsBackup) => {
    showAppDialog({
      title: "Delete backup?",
      message: `Delete the backup from ${
        backup.datePretty || backup.filename || backup.id
      }? This can't be undone.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => doDelete(backup) },
      ],
    });
  };

  // ---- Restore (apply) flow — issue #60 -----------------------------------

  // APPLYING: fire the one-and-only apply request for this episode.
  const startApply = async (backup: AbsBackup) => {
    // Re-entrancy: the dialog host holds onPress closures after the phase has
    // moved on — a second confirm press must NOT fire a second apply.
    if (restorePhaseRef.current !== "idle") return;
    setRestoreSafe({ phase: "applying", backup });
    try {
      await applyBackup(backup.id);
      if (restoreCancelledRef.current) return;
      // The server answered before dropping us — verify our session survived.
      runVerify(backup, Date.now() + RESTORE_WAIT_MS);
    } catch (e: any) {
      if (restoreCancelledRef.current) return;
      const kind = e?.kind;
      if (kind === "offline" || kind === "auth") {
        // EXPECTED failure modes while the server swaps its database under
        // us: the socket drops mid-restore (no response → "offline"), the api
        // singleton's 20s timeout fires, or the restored database invalidates
        // our token ("auth"). The restore is almost certainly RUNNING — start
        // watching for the server to come back. The deadline is set ONCE per
        // apply episode; verify→reconnect bounces reuse it.
        runReconnect(backup, Date.now() + RESTORE_WAIT_MS);
      } else {
        // forbidden / unsupported / server / unknown: the server REFUSED the
        // apply — a real failure. NEVER auto-retry: /apply is a side-effecting
        // GET, and a blind retry could kick off a second restore on top of a
        // half-finished one.
        showAppDialog({ title: "Couldn't restore backup", message: absErrorToActionMessage(e) });
        setRestoreSafe({ phase: "idle" });
      }
    }
  };

  // RECONNECTING: raw unauthenticated /ping polling (see utils/serverLiveness
  // for why NOT the api singleton) until the server answers or the deadline
  // passes.
  const runReconnect = async (backup: AbsBackup, deadlineAt: number) => {
    setRestoreSafe({ phase: "reconnecting", backup, deadlineAt });
    // Same server-config source the download-URL builder reads.
    const address = storageHelper.getServerConfig()?.address;
    if (!address) {
      // Nothing to probe (session config gone mid-restore) — show the
      // guidance view rather than spinning forever.
      setRestoreSafe({ phase: "timeout", backup, deadlineAt });
      return;
    }
    const result = await waitForServerUp(address, {
      deadlineAt,
      isCancelled: () => restoreCancelledRef.current,
    });
    if (result === "cancelled") return; // unmounted — stop watching silently
    if (result === "up") {
      runVerify(backup, deadlineAt);
    } else {
      setRestoreSafe({ phase: "timeout", backup, deadlineAt });
    }
  };

  // VERIFYING: one authenticated round-trip through the api singleton —
  // proves both that the API answers and that our session survived the
  // restored database, and refreshes the list in the same breath.
  const runVerify = async (backup: AbsBackup, deadlineAt: number) => {
    setRestoreSafe({ phase: "verifying", backup, deadlineAt });
    try {
      const data = await getBackups();
      if (restoreCancelledRef.current) return;
      applySnapshot(data);
      setError(null);
      showSnackbar({ message: "Server is back — backup restored" });
      setRestoreSafe({ phase: "idle" });
    } catch (e: any) {
      if (restoreCancelledRef.current) return;
      if (e?.kind === "auth") {
        // The restored database rejected our token — the api interceptor's
        // forceLogout path is already swapping the navigator to the connect
        // screen. Do nothing here beyond not touching state.
        return;
      }
      // offline / server / unknown: the HTTP layer is up but the database may
      // still be swapping — keep waiting on the SAME episode deadline.
      runReconnect(backup, deadlineAt);
    }
  };

  // Dialog 1 (typed confirm) → dialog 2 (last chance) → startApply.
  const confirmRestore = (backup: AbsBackup) => {
    // Ignore taps while a restore episode is running or this row is deleting.
    if (restorePhaseRef.current !== "idle" || deletingId === backup.id) return;
    const label = backup.datePretty || backup.filename || backup.id;
    showAppDialog({
      title: "Restore this backup?",
      message:
        `Restoring replaces ALL server data — users, listening progress, and libraries — ` +
        `with the backup from ${label}. Everyone is signed out, INCLUDING YOU — you may ` +
        `need to log in again. Any changes made since ${label} are lost.`,
      confirmInput: { placeholder: "RESTORE", requiredText: "RESTORE" },
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          style: "destructive",
          onPress: () => {
            showAppDialog({
              title: "Replace all server data?",
              message: "Last chance — this cannot be undone from the app.",
              buttons: [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Replace server data",
                  style: "destructive",
                  onPress: () => startApply(backup),
                },
              ],
            });
          },
        },
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

      {restore.phase === "applying" ||
      restore.phase === "reconnecting" ||
      restore.phase === "verifying" ? (
        // Restore in progress — a full-screen phase view in the loading/error
        // slot. "applying" is the brief request window; "reconnecting" and
        // "verifying" both read as "waiting for the server" to the admin.
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text
            style={{
              color: colors.onSurface,
              fontSize: 16,
              fontWeight: "600",
              marginTop: 16,
              textAlign: "center",
            }}
          >
            {restore.phase === "applying" ? "Restoring backup…" : "Waiting for the server…"}
          </Text>
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 13,
              marginTop: 8,
              textAlign: "center",
              lineHeight: 19,
            }}
          >
            {restore.phase === "applying"
              ? "Sending the restore request to the server."
              : "The restore is running; this can take a few minutes. Leaving this screen only " +
                "stops watching — the restore continues on the server."}
          </Text>
        </View>
      ) : restore.phase === "timeout" ? (
        // Deadline passed without the server answering — guidance, not panic.
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Icon name="warning" size={40} color={colors.onSurfaceVariant} />
          <Text
            style={{
              color: colors.onSurface,
              fontSize: 16,
              fontWeight: "600",
              marginTop: 16,
              textAlign: "center",
            }}
          >
            Still waiting on the server
          </Text>
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 13,
              marginTop: 8,
              textAlign: "center",
              lineHeight: 19,
            }}
          >
            The restore may still be running. Check the server console. Don't restore the same
            backup again until you've confirmed what happened.
          </Text>
          <HintPressable
            onPress={() => {
              // Re-arm a FRESH 5-minute watch window for the same episode.
              const backup = restore.backup;
              if (backup) runReconnect(backup, Date.now() + RESTORE_WAIT_MS);
            }}
            accessibilityRole="button"
            accessibilityLabel="Keep waiting"
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
            style={{
              marginTop: 20,
              height: 44,
              paddingHorizontal: 24,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              backgroundColor: colors.primary,
            }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 14, fontWeight: "700" }}>
              Keep waiting
            </Text>
          </HintPressable>
          <HintPressable
            onPress={() => {
              // Back to the list with one fresh load — the admin decides what
              // to do from there.
              setRestoreSafe({ phase: "idle" });
              setRetryTick((t) => t + 1);
            }}
            accessibilityRole="button"
            accessibilityLabel="Done"
            android_ripple={{ color: withAlpha(colors.onSurface, 0.12) }}
            style={{
              marginTop: 10,
              height: 44,
              paddingHorizontal: 24,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "700" }}>Done</Text>
          </HintPressable>
        </View>
      ) : loading ? (
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
                      <View style={{ flexDirection: "row", alignItems: "center" }}>
                        {/* Restore (apply) — issue #60. The server accepts
                            /apply from any admin, but the app deliberately
                            NARROWS this to root: replacing every user's data
                            from a phone is the most destructive action in the
                            product, and root is the only role we can be sure
                            still exists (and can log back in) after the
                            restored database lands. */}
                        {caps.isRoot ? (
                          <HintPressable
                            onPress={() => confirmRestore(backup)}
                            disabled={deletingId === backup.id}
                            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={`Restore backup ${backup.datePretty || backup.filename || backup.id}`}
                            android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
                          >
                            <Icon name="restore" size={22} color={colors.onSurfaceVariant} />
                          </HintPressable>
                        ) : null}
                        <HintPressable
                          onPress={() => handleDownload(backup)}
                          disabled={deletingId === backup.id}
                          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Download backup ${backup.datePretty || backup.filename || backup.id}`}
                          android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
                        >
                          <Icon name="download" size={22} color={colors.onSurfaceVariant} />
                        </HintPressable>
                        <HintPressable
                          onPress={() => confirmDelete(backup)}
                          disabled={deletingId === backup.id}
                          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Delete backup ${backup.datePretty || backup.filename || backup.id}`}
                          android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
                        >
                          <Icon name="trash" size={22} color={colors.error} />
                        </HintPressable>
                      </View>
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
