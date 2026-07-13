import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { SectionHeader, Divider, ToggleRow, NavRow } from "../components/SettingsRows";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { useUserStore } from "../store/useUserStore";
import { useLibraryStore } from "../store/useLibraryStore";
import { useServerCapabilities } from "../utils/abs/capabilities";
import { getUser, createUser, updateUser, deleteUser, getUserListeningStats } from "../utils/abs/users";
import type { AbsUser, AbsUserPayload, AbsUserType } from "../utils/abs/types";

/**
 * AdminUserDetailScreen — create or edit a server user account (admin-only).
 *
 * Route: "AdminUserDetail"
 * Params: { userId?: string } — absent = create mode.
 *
 * Edit mode loads the account (GET /api/users/:id) plus best-effort listening
 * stats, and PATCHes username/type/permissions/library access (an entered
 * "New password" resets the password). Create mode POSTs the same payload
 * shape with a required password.
 *
 * Guards (server enforces these too — we encode them so the UI never offers a
 * doomed action):
 *  - Only the root user can edit the root account → non-root sees read-only.
 *  - You can't delete your own account (blocked with an explaining dialog).
 *  - You can't demote your own admin account (blocked with an explaining
 *    dialog — losing admin here would lock you out of this very screen).
 *  - Deleting a user is Tier-3 destructive: typed username confirm.
 */

const TYPE_OPTIONS: { label: string; value: AbsUserType }[] = [
  { label: "Guest", value: "guest" },
  { label: "User", value: "user" },
  { label: "Admin", value: "admin" },
];

interface PermFlags {
  download: boolean;
  update: boolean;
  delete: boolean;
  upload: boolean;
  accessExplicitContent: boolean;
}

// ABS server defaults for a brand-new account.
const DEFAULT_PERMS: PermFlags = {
  download: true,
  update: false,
  delete: false,
  upload: false,
  accessExplicitContent: true,
};

interface FormSnapshot {
  username: string;
  type: AbsUserType;
  isActive: boolean;
  perms: PermFlags;
  allLibraries: boolean;
  libs: string[]; // sorted
}

function formatListeningTime(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function errorViewProps(e: any): { icon: any; title: string; message: string } {
  if (e?.kind === "offline") {
    return {
      icon: "cloud-off",
      title: "You're offline",
      message: "Server administration needs a connection.",
    };
  }
  if (e?.kind === "forbidden") {
    return {
      icon: "lock",
      title: "Admin access required",
      message: "Only server admins can manage user accounts.",
    };
  }
  return {
    icon: "warning",
    title: "Couldn't load this user",
    message: e?.message || "Something went wrong. Please try again.",
  };
}

// Operation-failure message (dialog body) keyed off the normalized error.
function failureMessage(e: any): string {
  if (e?.kind === "offline") return "You're offline. Reconnect and try again.";
  return e?.message || "The server rejected the change.";
}

// Module-scope (stable identity) text field — an inline component would
// remount its TextInput on every keystroke.
function Field({
  label,
  helper,
  value,
  onChangeText,
  editable,
  secure,
  colors,
}: {
  label: string;
  helper?: string;
  value: string;
  onChangeText: (t: string) => void;
  editable: boolean;
  secure?: boolean;
  colors: any;
}) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
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
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
        placeholderTextColor={colors.onSurfaceVariant}
        style={{
          backgroundColor: colors.surfaceContainer,
          color: colors.onSurface,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          fontSize: 15,
          opacity: editable ? 1 : 0.6,
        }}
      />
    </View>
  );
}

export default function AdminUserDetailScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const params = route?.params || {};
  const userId: string | undefined = params.userId;
  const isCreate = !userId;

  const caps = useServerCapabilities();
  const me = useUserStore((s) => s.user);
  const libraries = useLibraryStore((s) => s.libraries);

  const [loadedUser, setLoadedUser] = useState<AbsUser | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(!isCreate);
  const [error, setError] = useState<any>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [saving, setSaving] = useState(false);

  // Form state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState(""); // create: required; edit: reset-when-set
  const [type, setType] = useState<AbsUserType>("user");
  const [isActive, setIsActive] = useState(true);
  const [perms, setPerms] = useState<PermFlags>(DEFAULT_PERMS);
  const [allLibraries, setAllLibraries] = useState(true);
  const [selectedLibs, setSelectedLibs] = useState<string[]>([]);
  const [seed, setSeed] = useState<FormSnapshot | null>(null);

  const targetIsRoot = loadedUser?.type === "root";
  // Root/permission edge case: only root may edit the root account.
  const readOnly = targetIsRoot && !caps.isRoot;
  const isSelf = !isCreate && !!me?.id && me.id === userId;

  // Library names for the access checklist come from the existing library
  // store (kept warm by the rest of the app); refresh is best-effort.
  useEffect(() => {
    useLibraryStore
      .getState()
      .loadLibraries()
      .catch(() => {});
  }, []);

  const seedFromUser = (u: AbsUser) => {
    const p = u.permissions || ({} as any);
    const permFlags: PermFlags = {
      download: !!p.download,
      update: !!p.update,
      delete: !!p.delete,
      upload: !!p.upload,
      accessExplicitContent: !!p.accessExplicitContent,
    };
    const all = p.accessAllLibraries !== false;
    const libs = Array.isArray(u.librariesAccessible) ? [...u.librariesAccessible].sort() : [];
    setUsername(u.username || "");
    setPassword("");
    setType(u.type === "root" ? "admin" : u.type); // type is never PATCHed for root (chips hidden)
    setIsActive(u.isActive !== false);
    setPerms(permFlags);
    setAllLibraries(all);
    setSelectedLibs(libs);
    setSeed({
      username: u.username || "",
      type: u.type === "root" ? "admin" : u.type,
      isActive: u.isActive !== false,
      perms: permFlags,
      allLibraries: all,
      libs,
    });
  };

  useEffect(() => {
    if (isCreate) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // Stats are decorative — a stats failure must not block editing.
        const [userRes, statsRes] = await Promise.allSettled([
          getUser(userId!),
          getUserListeningStats(userId!),
        ]);
        if (cancelled) return;
        if (userRes.status === "rejected") throw userRes.reason;
        setLoadedUser(userRes.value);
        seedFromUser(userRes.value);
        if (statsRes.status === "fulfilled") setStats(statsRes.value);
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, isCreate, retryTick]);

  const dirty = useMemo(() => {
    if (isCreate) return true;
    if (!seed) return false;
    const libsNow = [...selectedLibs].sort();
    return (
      username.trim() !== seed.username ||
      password.length > 0 ||
      type !== seed.type ||
      isActive !== seed.isActive ||
      perms.download !== seed.perms.download ||
      perms.update !== seed.perms.update ||
      perms.delete !== seed.perms.delete ||
      perms.upload !== seed.perms.upload ||
      perms.accessExplicitContent !== seed.perms.accessExplicitContent ||
      allLibraries !== seed.allLibraries ||
      libsNow.join(" ") !== seed.libs.join(" ")
    );
  }, [isCreate, seed, username, password, type, isActive, perms, allLibraries, selectedLibs]);

  const buildPayload = (): AbsUserPayload => {
    // Editing the root account (root viewer only): the ONLY safe fields are
    // username + password — never synthesize permissions for root.
    if (targetIsRoot) {
      const p: AbsUserPayload = { username: username.trim() };
      if (password) p.password = password;
      return p;
    }
    const payload: AbsUserPayload = {
      username: username.trim(),
      type,
      isActive,
      permissions: {
        download: perms.download,
        update: perms.update,
        delete: perms.delete,
        upload: perms.upload,
        accessExplicitContent: perms.accessExplicitContent,
        accessAllLibraries: allLibraries,
        accessAllTags: true,
      },
      librariesAccessible: allLibraries ? [] : [...selectedLibs],
    };
    if (isCreate || password) payload.password = password;
    return payload;
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const payload = buildPayload();
      if (isCreate) {
        await createUser(payload);
        showSnackbar({ message: "User created" });
      } else {
        await updateUser(userId!, payload);
        showSnackbar({ message: "User saved" });
      }
      navigation.goBack();
    } catch (e: any) {
      showAppDialog({
        title: isCreate ? "Couldn't create user" : "Couldn't save user",
        message: failureMessage(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (saving || readOnly) return;
    if (!username.trim()) {
      showAppDialog({ title: "Username required", message: "Enter a username for this account." });
      return;
    }
    if (isCreate && !password) {
      showAppDialog({ title: "Password required", message: "New accounts need a password." });
      return;
    }
    // Self-demotion guard: losing your own admin type would lock you out of
    // this admin area mid-session. Blocked — another admin has to do it.
    if (!isCreate && isSelf && loadedUser?.type === "admin" && type !== "admin") {
      showAppDialog({
        title: "You can't demote your own account",
        message:
          "You're signed in as this admin. Removing your own admin access would lock you out of server administration — ask another admin (or the root user) to change your account type.",
      });
      return;
    }
    void doSave();
  };

  const doDelete = async () => {
    try {
      await deleteUser(userId!);
      showSnackbar({ message: "User deleted" });
      navigation.goBack();
    } catch (e: any) {
      showAppDialog({ title: "Couldn't delete user", message: failureMessage(e) });
    }
  };

  const handleDelete = () => {
    // Self-deletion guard: blocked outright with an explanation.
    if (isSelf) {
      showAppDialog({
        title: "You can't delete your own account",
        message:
          "You're signed in as this user. Another admin (or the root user) has to delete this account.",
      });
      return;
    }
    const uname = loadedUser?.username || username.trim();
    // Tier-3 destructive: typed-confirm with the username.
    showAppDialog({
      title: `Delete ${uname}?`,
      message:
        "This permanently removes the account, its listening sessions, and its progress from the server. Files on disk are not affected. Type the username to confirm.",
      confirmInput: { placeholder: uname, requiredText: uname },
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void doDelete() },
      ],
    });
  };

  const toggleLib = (libId: string) => {
    setSelectedLibs((cur) =>
      cur.includes(libId) ? cur.filter((id) => id !== libId) : [...cur, libId]
    );
  };

  const title = isCreate ? "New user" : loadedUser?.username || "User";
  const showDelete = !isCreate && !loading && !error && !targetIsRoot;
  const showSave = !readOnly && !loading && !error;

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
          {title}
        </Text>
        {showDelete ? (
          <Pressable
            onPress={handleDelete}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Delete user"
          >
            <Icon name="trash" size={24} color={colors.error} />
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState style={{ flex: 1 }} {...errorViewProps(error)} onRetry={() => setRetryTick((t) => t + 1)} />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Root read-only note */}
          {readOnly ? (
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
                Only the root user can edit the root account. Showing the current values.
              </Text>
            </View>
          ) : null}

          <SectionHeader label="Account" colors={colors} />

          <Field
            label="Username"
            value={username}
            onChangeText={setUsername}
            editable={!readOnly}
            colors={colors}
          />
          <Field
            label={isCreate ? "Password" : "New password"}
            helper={isCreate ? undefined : "Leave blank to keep the current password."}
            value={password}
            onChangeText={setPassword}
            editable={!readOnly}
            secure
            colors={colors}
          />

          {/* Account type chips (root is immutable — shown as a static note) */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 8 }}>
              Account type
            </Text>
            {targetIsRoot ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
                root — the root account's type can't be changed.
              </Text>
            ) : (
              <View style={{ flexDirection: "row" }}>
                {TYPE_OPTIONS.map((opt) => {
                  const active = type === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => !readOnly && setType(opt.value)}
                      disabled={readOnly}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active, disabled: readOnly }}
                      accessibilityLabel={`Account type: ${opt.label}`}
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
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {type === "admin" && !targetIsRoot ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 8 }}>
                Admins can manage users, libraries, and every item on the server.
              </Text>
            ) : null}
          </View>

          {!targetIsRoot ? (
            <ToggleRow
              icon="person"
              title="Account enabled"
              subtitle="Disabled accounts can't sign in"
              value={isActive}
              onValueChange={(v) => !readOnly && setIsActive(v)}
              colors={colors}
            />
          ) : null}

          {/* Root implicitly has every permission and library — showing toggles
              would just misrepresent it. */}
          {!targetIsRoot ? (
            <>
              <SectionHeader label="Permissions" colors={colors} />
              <ToggleRow
                icon="download"
                title="Can download"
                value={perms.download}
                onValueChange={(v) => setPerms((p) => ({ ...p, download: v }))}
                colors={colors}
              />
              <ToggleRow
                icon="edit"
                title="Can update"
                value={perms.update}
                onValueChange={(v) => setPerms((p) => ({ ...p, update: v }))}
                colors={colors}
              />
              <ToggleRow
                icon="trash"
                title="Can delete"
                value={perms.delete}
                onValueChange={(v) => setPerms((p) => ({ ...p, delete: v }))}
                colors={colors}
              />
              <ToggleRow
                icon="cloud"
                title="Can upload"
                value={perms.upload}
                onValueChange={(v) => setPerms((p) => ({ ...p, upload: v }))}
                colors={colors}
              />
              <ToggleRow
                icon="warning"
                title="Explicit content"
                subtitle="Access items marked explicit"
                value={perms.accessExplicitContent}
                onValueChange={(v) => setPerms((p) => ({ ...p, accessExplicitContent: v }))}
                colors={colors}
              />

              <SectionHeader label="Library access" colors={colors} />
              <ToggleRow
                icon="library"
                title="All libraries"
                value={allLibraries}
                onValueChange={setAllLibraries}
                colors={colors}
              />
              {!allLibraries
                ? libraries.map((lib) => {
                    const checked = selectedLibs.includes(lib.id);
                    return (
                      <TouchableOpacity
                        key={lib.id}
                        onPress={() => toggleLib(lib.id)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked }}
                        accessibilityLabel={`Library access: ${lib.name}`}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          paddingVertical: 14,
                          paddingHorizontal: 20,
                        }}
                      >
                        <View
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 6,
                            borderWidth: 2,
                            borderColor: checked ? colors.primary : colors.outline,
                            backgroundColor: checked ? colors.primary : "transparent",
                            alignItems: "center",
                            justifyContent: "center",
                            marginRight: 16,
                          }}
                        >
                          {checked ? <Icon name="check" size={16} color={colors.onPrimary} /> : null}
                        </View>
                        <Text style={{ color: colors.onSurface, fontSize: 16, flex: 1 }}>{lib.name}</Text>
                      </TouchableOpacity>
                    );
                  })
                : null}
            </>
          ) : null}

          {/* Edit-mode extras: stats + sessions link */}
          {!isCreate ? (
            <>
              <SectionHeader label="Activity" colors={colors} />
              {stats ? (
                <View style={{ paddingHorizontal: 20, paddingVertical: 8 }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>
                    Total listening time: {formatListeningTime(stats.totalTime)}
                  </Text>
                </View>
              ) : null}
              <NavRow
                icon="clock"
                title="Listening sessions"
                subtitle="View this user's playback sessions"
                onPress={() => navigation.navigate("AdminSessions", { userId })}
                colors={colors}
              />
              <Divider colors={colors} />
            </>
          ) : null}

          {/* Save */}
          {showSave ? (
            <Pressable
              onPress={handleSave}
              disabled={saving || (!isCreate && !dirty)}
              accessibilityRole="button"
              accessibilityLabel={isCreate ? "Create user" : "Save user"}
              accessibilityState={{ disabled: saving || (!isCreate && !dirty) }}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                marginHorizontal: 16,
                marginTop: 20,
                height: 48,
                borderRadius: 24,
                overflow: "hidden",
                backgroundColor: colors.primary,
                opacity: saving || (!isCreate && !dirty) ? 0.5 : 1,
              }}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700" }}>
                  {isCreate ? "Create user" : "Save changes"}
                </Text>
              )}
            </Pressable>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
