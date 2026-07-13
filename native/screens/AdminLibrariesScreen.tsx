import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Pressable,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon, { IconName } from "../components/Icon";
import LibraryIcon from "../components/LibraryIcon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import StatusChip from "../components/StatusChip";
import { api } from "../utils/api";
import { AbsError, normalizeAbsError } from "../utils/abs/errors";
import { scanLibrary, matchAllLibrary } from "../utils/abs/libraries";
import { subscribeTasks, getTasksSnapshot, startTaskWatch } from "../utils/abs/tasks";
import type { AbsTask } from "../utils/abs/types";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";

/**
 * AdminLibrariesScreen — server library administration (admin-gated on the
 * server; every write 403s otherwise and we surface that).
 *
 * Route: "AdminLibraries" (no params)
 *
 * - Lists the server's libraries (fresh GET /api/libraries — deliberately NOT
 *   useLibraryStore, whose list is a 5-minute-cached app-browsing concern).
 * - Per-library actions: scan / force re-scan / match-all — each behind a
 *   showAppDialog confirm, then fire → startTaskWatch → completion snackbar.
 * - Row tap → "AdminLibraryEdit" { libraryId }; header add → create mode.
 * - While focused, subscribes to the shared task poller so rows with a running
 *   scan/match show a live status chip.
 */

// Map an AbsError kind onto the ErrorState idiom, one branch per kind so
// offline / forbidden / unsupported / server failures each read differently.
function errorStateProps(err: AbsError): { icon: IconName; title: string; message: string } {
  switch (err.kind) {
    case "offline":
      return {
        icon: "cloud-off",
        title: "You're offline",
        message: "Managing libraries needs a connection to the server.",
      };
    case "forbidden":
      return { icon: "lock", title: "Admin access required", message: err.message };
    case "unsupported":
      return { icon: "info", title: "Not supported by this server", message: err.message };
    case "server":
      return { icon: "warning", title: "The server hit an error", message: err.message };
    default:
      return { icon: "warning", title: "Couldn't load libraries", message: err.message };
  }
}

export default function AdminLibrariesScreen({ navigation }: any) {
  const colors = useThemeColors();

  const [libraries, setLibraries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<AbsError | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [tasks, setTasks] = useState<AbsTask[]>([]);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const res = await api.get("/api/libraries");
      const raw = res.data?.libraries || res.data || [];
      setLibraries(
        Array.isArray(raw) ? raw.filter((l: any) => l && typeof l === "object" && l.id) : []
      );
    } catch (e) {
      setError(normalizeAbsError(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, retryTick]);

  // Silent reload on focus (AdminApiKeys idiom) so a create/edit/delete made
  // on AdminLibraryEdit is reflected when the admin pops back to this list.
  // isRefresh=true skips the full-screen spinner — the stale list stays up
  // until the fresh one lands.
  useEffect(() => {
    if (!navigation?.addListener) return undefined;
    const unsub = navigation.addListener("focus", () => load(true));
    return unsub;
  }, [navigation, load]);

  // Live task chips while focused: the shared poller is ref-counted, so this
  // subscription is exactly what starts/stops it for this screen.
  useFocusEffect(
    useCallback(() => {
      setTasks(getTasksSnapshot());
      const unsubscribe = subscribeTasks(setTasks);
      return unsubscribe;
    }, [])
  );

  const runningTaskFor = (libraryId: string, fragment: string): AbsTask | undefined =>
    tasks.find(
      (t) =>
        !t.isFinished &&
        typeof t.action === "string" &&
        t.action.includes(fragment) &&
        t.data?.libraryId === libraryId
    );

  const showAbsErrorDialog = (title: string, e: any) => {
    const err = normalizeAbsError(e);
    showAppDialog({ title, message: err.message });
  };

  const runScan = async (lib: any, force: boolean) => {
    try {
      await scanLibrary(lib.id, force ? { force: true } : undefined);
      showSnackbar({ message: `Scanning "${lib.name}"…` });
      // The watch resolves when the task reports finished OR when it vanishes
      // from the snapshot (ABS drops completed tasks from GET /api/tasks — the
      // result then carries inferredCompletion with no exit status). Only an
      // explicit isFailed gets the failure copy; anything else — including an
      // inferred completion — reads as generic success.
      const task = await startTaskWatch(
        (t) => typeof t.action === "string" && t.action.includes("scan") && t.data?.libraryId === lib.id
      );
      if (task) {
        showSnackbar({
          message: task.isFailed
            ? `Scan of "${lib.name}" failed${task.error ? `: ${task.error}` : ""}`
            : `Scan of "${lib.name}" finished`,
        });
      }
    } catch (e) {
      showAbsErrorDialog("Couldn't start the scan", e);
    }
  };

  const confirmScan = (lib: any) => {
    showAppDialog({
      title: `Scan "${lib.name}"`,
      message:
        "Look for new, changed, and removed files in this library's folders. Force re-scan rescans every item even if its files look unchanged.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Force re-scan", onPress: () => runScan(lib, true) },
        { text: "Scan", onPress: () => runScan(lib, false) },
      ],
    });
  };

  const runMatchAll = async (lib: any) => {
    try {
      await matchAllLibrary(lib.id);
      showSnackbar({ message: `Matching all items in "${lib.name}"…` });
      // Same terminal semantics as runScan: isFailed → failure copy, everything
      // else (finished OR inferredCompletion) → generic finished copy.
      const task = await startTaskWatch(
        (t) => typeof t.action === "string" && t.action.includes("match") && t.data?.libraryId === lib.id
      );
      if (task) {
        showSnackbar({
          message: task.isFailed
            ? `Match-all in "${lib.name}" failed${task.error ? `: ${task.error}` : ""}`
            : `Match-all in "${lib.name}" finished`,
        });
      }
    } catch (e) {
      showAbsErrorDialog("Couldn't start match-all", e);
    }
  };

  const confirmMatchAll = (lib: any) => {
    showAppDialog({
      title: `Match all items in "${lib.name}"`,
      message:
        "Quick-match every item in this library against its metadata provider. Matched fields can overwrite existing metadata and there is no undo.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Match all", style: "destructive", onPress: () => runMatchAll(lib) },
      ],
    });
  };

  const iconButton = (
    name: IconName,
    label: string,
    onPress: () => void
  ) => (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12), borderless: true }}
      style={{
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        marginLeft: 4,
        overflow: "hidden",
      }}
    >
      <Icon name={name} size={22} color={colors.onSurfaceVariant} />
    </Pressable>
  );

  const renderLibraryRow = (lib: any) => {
    const folderCount = Array.isArray(lib.folders) ? lib.folders.length : 0;
    const scanTask = runningTaskFor(lib.id, "scan");
    const matchTask = runningTaskFor(lib.id, "match");
    const subtitle = `${lib.mediaType === "podcast" ? "Podcasts" : "Books"} · ${folderCount} folder${
      folderCount === 1 ? "" : "s"
    }`;
    return (
      <TouchableOpacity
        key={lib.id}
        onPress={() => navigation.navigate("AdminLibraryEdit", { libraryId: lib.id })}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${lib.name}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingVertical: 14,
        }}
      >
        <LibraryIcon icon={lib.icon} mediaType={lib.mediaType} size={26} color={colors.onSurface} style={{ marginRight: 18 }} />
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={{ color: colors.onSurface, fontSize: 17 }} numberOfLines={1}>
            {lib.name}
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
            {subtitle}
          </Text>
          {scanTask || matchTask ? (
            <View style={{ marginTop: 6 }}>
              <StatusChip label={scanTask ? "Scanning" : "Matching"} tone="info" dot />
            </View>
          ) : null}
        </View>
        {iconButton("refresh", `Scan ${lib.name}`, () => confirmScan(lib))}
        {lib.mediaType !== "podcast"
          ? iconButton("search", `Match all in ${lib.name}`, () => confirmMatchAll(lib))
          : null}
      </TouchableOpacity>
    );
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
          Libraries
        </Text>
        <Pressable
          onPress={() => navigation.navigate("AdminLibraryEdit", {})}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Add library"
        >
          <Icon name="add" size={24} color={colors.onSurface} />
        </Pressable>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          {...errorStateProps(error)}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load(true);
              }}
              tintColor={colors.primary}
            />
          }
        >
          {libraries.length === 0 ? (
            <EmptyState
              icon="library"
              title="No libraries"
              message="Add a library to start organizing the server's audiobooks and podcasts."
            />
          ) : (
            libraries.map((lib, i) => (
              <View key={lib.id}>
                {renderLibraryRow(lib)}
                {i < libraries.length - 1 ? (
                  <View
                    style={{
                      height: 1,
                      backgroundColor: colors.outlineVariant,
                      marginHorizontal: 20,
                      opacity: 0.6,
                    }}
                  />
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
