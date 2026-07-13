import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { getTags } from "../utils/abs/server";
import { absErrorToErrorStateProps } from "../utils/abs/errors";
import { formatListeningTime } from "../utils/format";
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
 *  - You can't disable your own account (same reasoning — explaining dialog).
 *  - Deleting a user is Tier-3 destructive: typed username confirm.
 *
 * A dirty form arms a beforeRemove discard guard (ChapterEditor idiom), and
 * saving happens from a header "Save" text button enabled once dirty. Per-tag
 * library access (accessAllTags/itemTagsSelected) is editable via the "Tag
 * access" section; the block-list flag (selectedTagsNotAccessible) has no UI
 * and is echoed back from the loaded user unchanged so edits never clobber it.
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
  allTags: boolean;
  tags: string[]; // sorted
}

// Create mode compares against the server defaults, so `dirty` means "the
// admin has actually typed/toggled something" (drives both the header Save
// enablement and the discard guard).
const CREATE_SEED: FormSnapshot = {
  username: "",
  type: "user",
  isActive: true,
  perms: DEFAULT_PERMS,
  allLibraries: true,
  libs: [],
  allTags: true,
  tags: [],
};

// This screen historically lumped auth/server/unsupported into the generic
// "Couldn't load this user" fallback, so those overrides preserve that copy.
const GENERIC_LOAD_ERROR = { icon: "warning", title: "Couldn't load this user" } as const;
function errorViewProps(e: any) {
  return absErrorToErrorStateProps(e, {
    subject: "this user",
    overrides: {
      forbidden: { message: "Only server admins can manage user accounts." },
      auth: GENERIC_LOAD_ERROR,
      server: GENERIC_LOAD_ERROR,
      unsupported: GENERIC_LOAD_ERROR,
    },
  });
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
  error,
  value,
  onChangeText,
  editable,
  secure,
  autoCapitalize,
  returnKeyType,
  onSubmitEditing,
  inputRef,
  colors,
}: {
  label: string;
  helper?: string;
  /** Inline validation error rendered under the field (error-colored). */
  error?: string | null;
  value: string;
  onChangeText: (t: string) => void;
  editable: boolean;
  secure?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  returnKeyType?: "next" | "done";
  onSubmitEditing?: () => void;
  inputRef?: React.RefObject<TextInput | null>;
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
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        secureTextEntry={secure}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
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
          borderWidth: 1,
          borderColor: error ? colors.error : "transparent",
        }}
      />
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ color: colors.error, fontSize: 12, marginTop: 4 }}
        >
          {error}
        </Text>
      ) : null}
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
  const [allTags, setAllTags] = useState(true);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // Every tag defined on the server — the checklist source (best-effort load).
  const [allServerTags, setAllServerTags] = useState<string[]>([]);
  // Distinguishes "the fetch failed" from "the server genuinely has no tags",
  // so the empty state doesn't misreport a network error as an empty server.
  const [tagsLoadFailed, setTagsLoadFailed] = useState(false);
  const [seed, setSeed] = useState<FormSnapshot | null>(isCreate ? CREATE_SEED : null);
  // Inline validation errors (cleared as the admin retypes).
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const passwordInputRef = useRef<TextInput | null>(null);

  const targetIsRoot = loadedUser?.type === "root";
  // A user whose tag list is a BLOCK-list (selectedTagsNotAccessible) can't be
  // faithfully represented by the allow-list checklist — editing it here would
  // silently invert their access. Show it read-only and echo the fields.
  const tagBlockList = !isCreate && loadedUser?.permissions?.selectedTagsNotAccessible === true;
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

  // Server tag vocabulary for the tag-access checklist — best-effort: a tag
  // load failure leaves the list empty (helper text) but never blocks editing.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([getTags()]).then(([res]) => {
      if (cancelled) return;
      if (res.status === "fulfilled" && Array.isArray(res.value)) {
        setAllServerTags([...res.value].sort());
        setTagsLoadFailed(false);
      } else {
        setTagsLoadFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
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
    const allTagsAccess = p.accessAllTags !== false;
    const tags = Array.isArray(u.itemTagsSelected) ? [...u.itemTagsSelected].sort() : [];
    setUsername(u.username || "");
    setPassword("");
    setType(u.type === "root" ? "admin" : u.type); // type is never PATCHed for root (chips hidden)
    setIsActive(u.isActive !== false);
    setPerms(permFlags);
    setAllLibraries(all);
    setSelectedLibs(libs);
    setAllTags(allTagsAccess);
    setSelectedTags(tags);
    setSeed({
      username: u.username || "",
      type: u.type === "root" ? "admin" : u.type,
      isActive: u.isActive !== false,
      perms: permFlags,
      allLibraries: all,
      libs,
      allTags: allTagsAccess,
      tags,
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
    if (!seed) return false;
    const libsNow = [...selectedLibs].sort();
    const tagsNow = [...selectedTags].sort();
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
      libsNow.join("\n") !== seed.libs.join("\n") ||
      allTags !== seed.allTags ||
      tagsNow.join("\n") !== seed.tags.join("\n")
    );
  }, [isCreate, seed, username, password, type, isActive, perms, allLibraries, selectedLibs, allTags, selectedTags]);

  // Unsaved-changes guard (ChapterEditorScreen idiom): intercept ANY
  // navigation that would remove this screen while the form is dirty —
  // header back, hardware back, and gestures all funnel through beforeRemove.
  // Refs keep the listener stable.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty && !saving && !readOnly;
  useEffect(() => {
    if (!navigation?.addListener) return;
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      showAppDialog({
        title: "Discard changes?",
        message: isCreate
          ? "This user hasn't been created yet. Nothing has been sent to the server."
          : "You have unsaved changes to this account. Nothing has been sent to the server yet.",
        buttons: [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => navigation.dispatch(e.data.action),
          },
        ],
      });
    });
    return unsub;
  }, [navigation, isCreate]);

  const buildPayload = (): AbsUserPayload => {
    // Editing the root account (root viewer only): the ONLY safe fields are
    // username + password — never synthesize permissions for root.
    if (targetIsRoot) {
      const p: AbsUserPayload = { username: username.trim() };
      if (password) p.password = password;
      return p;
    }
    // Per-tag access IS editable (Tag access section). Create mode always
    // grants all tags; edit mode sends the toggled value + the chosen tags.
    // Seed permissions from the LOADED object so every server-owned key we
    // don't surface (createEreader, the block-list flag selectedTagsNotAccessible,
    // any newer-server key) round-trips unchanged — an edit here only ever
    // touches the fields the form actually controls. This is the same
    // clobber-safety guarantee the tag/library lists carry.
    // Create mode always grants all tags (per-tag restriction is an edit-only
    // affordance); derive BOTH tag fields from this single value so the payload
    // can't go internally inconsistent (accessAllTags:true + a non-empty list).
    const effectiveAllTags = isCreate ? true : allTags;
    const loadedPerms: any = loadedUser?.permissions || {};
    const permissions: any = {
      ...(isCreate ? {} : loadedPerms),
      download: perms.download,
      update: perms.update,
      delete: perms.delete,
      upload: perms.upload,
      accessExplicitContent: perms.accessExplicitContent,
      accessAllLibraries: allLibraries,
      // A block-list user's tag access is read-only here — echo it unchanged
      // (the loadedPerms spread already carried accessAllTags, restore it in
      // case a later field overrode it).
      accessAllTags: tagBlockList ? loadedPerms.accessAllTags : effectiveAllTags,
    };
    const payload: AbsUserPayload = {
      username: username.trim(),
      type,
      isActive,
      permissions,
      librariesAccessible: allLibraries ? [] : [...selectedLibs],
      itemTagsSelected: tagBlockList
        ? [...(loadedUser?.itemTagsSelected ?? [])]
        : effectiveAllTags
          ? []
          : [...selectedTags],
    };
    // Older servers keep the accessible-tags list top-level — echo it too.
    if (!isCreate && Array.isArray((loadedUser as any)?.itemTagsAccessible)) {
      payload.itemTagsAccessible = [...(loadedUser as any).itemTagsAccessible];
    }
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
      // A 409 means the username collided — that's a field problem, not an
      // operation problem, so it lands inline under the field.
      if (e?.status === 409) {
        setUsernameError("Username already taken");
      } else {
        showAppDialog({
          title: isCreate ? "Couldn't create user" : "Couldn't save user",
          message: failureMessage(e),
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (saving || readOnly) return;
    // Required-field validation surfaces inline (not as dialogs).
    let valid = true;
    if (!username.trim()) {
      setUsernameError("Username required");
      valid = false;
    }
    if (isCreate && !password) {
      setPasswordError("Password required");
      valid = false;
    }
    if (!valid) return;
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

  const toggleTag = (tag: string) => {
    setSelectedTags((cur) =>
      cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]
    );
  };

  // Self-disable guard (same class as self-delete/self-demote): disabling
  // your own account would end your own session — blocked with an explainer.
  const handleActiveToggle = (v: boolean) => {
    if (readOnly) return;
    if (!v && isSelf) {
      showAppDialog({
        title: "You can't disable your own account",
        message:
          "You're signed in as this user. Disabling your own account would sign you out and lock you out of server administration — ask another admin (or the root user) to disable it.",
      });
      return;
    }
    setIsActive(v);
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
        {/* Header Save (EditMetadata/ChapterEditor idiom) — enabled once dirty. */}
        {showSave ? (
          <Pressable
            onPress={handleSave}
            disabled={saving || !dirty}
            accessibilityRole="button"
            accessibilityLabel={isCreate ? "Create user" : "Save user"}
            accessibilityState={{ disabled: saving || !dirty, busy: saving }}
            hitSlop={8}
            style={{ paddingHorizontal: 8, paddingVertical: 6, opacity: saving || !dirty ? 0.4 : 1 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "700" }}>
                {isCreate ? "Create" : "Save"}
              </Text>
            )}
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
            error={usernameError}
            value={username}
            onChangeText={(t) => {
              setUsername(t);
              if (usernameError) setUsernameError(null);
            }}
            editable={!readOnly}
            autoCapitalize="none"
            returnKeyType="next"
            onSubmitEditing={() => passwordInputRef.current?.focus()}
            colors={colors}
          />
          <Field
            label={isCreate ? "Password" : "New password"}
            helper={isCreate ? undefined : "Leave blank to keep the current password."}
            error={passwordError}
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              if (passwordError) setPasswordError(null);
            }}
            editable={!readOnly}
            secure
            returnKeyType="done"
            inputRef={passwordInputRef}
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
              onValueChange={handleActiveToggle}
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

              {/* Per-tag restriction is an EDIT-only affordance — a new user
                  starts with all tags (create-mode saves force accessAllTags),
                  so the checklist would be misleading during create. */}
              {!isCreate ? (
                <>
              <SectionHeader label="Tag access" colors={colors} />
              {tagBlockList ? (
                <Text
                  style={{
                    color: colors.onSurfaceVariant,
                    fontSize: 13,
                    paddingHorizontal: 20,
                    paddingVertical: 12,
                  }}
                >
                  This user's tag access is configured as a block-list on the server. Manage it from
                  the web admin — it's shown here read-only so an edit can't invert their access.
                </Text>
              ) : (
                <>
              <ToggleRow
                icon="bookmark"
                title="All tags"
                value={allTags}
                onValueChange={(v) => {
                  setAllTags(v);
                  // Turning "all tags" back on abandons any partial selection.
                  if (v) setSelectedTags([]);
                }}
                colors={colors}
              />
              {!allTags ? (
                allServerTags.length > 0 ? (
                  allServerTags.map((tag) => {
                    const checked = selectedTags.includes(tag);
                    return (
                      <TouchableOpacity
                        key={tag}
                        onPress={() => toggleTag(tag)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked }}
                        accessibilityLabel={`Tag access: ${tag}`}
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
                        <Text style={{ color: colors.onSurface, fontSize: 16, flex: 1 }}>{tag}</Text>
                      </TouchableOpacity>
                    );
                  })
                ) : (
                  <Text
                    style={{
                      color: colors.onSurfaceVariant,
                      fontSize: 13,
                      paddingHorizontal: 20,
                      paddingVertical: 12,
                    }}
                  >
                    {tagsLoadFailed
                      ? "Couldn't load the server's tags. Pull back and reopen to retry."
                      : "No tags are defined on this server yet."}
                  </Text>
                )
              ) : null}
                </>
              )}
                </>
              ) : null}
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
                onPress={() =>
                  navigation.navigate("AdminSessions", {
                    userId,
                    username: loadedUser?.username || username.trim() || undefined,
                  })
                }
                colors={colors}
              />
              <Divider colors={colors} />
            </>
          ) : null}

        </ScrollView>
      )}
    </SafeAreaView>
  );
}
