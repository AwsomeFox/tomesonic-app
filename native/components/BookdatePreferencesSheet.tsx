import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import BottomSheet from "./BottomSheet";
import Icon from "./Icon";
import Pressable from "./HintPressable";
import {
  getBookdatePreferences,
  updateBookdatePreferences,
  getBookdateLibrary,
  generateBookdateRecommendations,
  resolveRmabUrl,
  BookdatePreferences,
} from "../utils/rmab";

const MAX_FAVORITES = 25;
const MAX_PROMPT = 1000;

/**
 * BookDate Preferences — mirrors RMAB's web dialog: library scope (full /
 * rated when the backend supports ratings / up-to-25 favorites with a
 * searchable picker) plus the free-text "special requests" prompt that
 * steers the AI.
 */
export default function BookdatePreferencesSheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  /** Called after a successful save (e.g. to refresh the deck). */
  onSaved?: () => void;
}) {
  const colors = useThemeColors();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<BookdatePreferences["libraryScope"]>("full");
  const [supportsRatings, setSupportsRatings] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [library, setLibrary] = useState<{ id: string; title: string; author?: string; coverUrl?: string | null }[] | null>(null);
  const [search, setSearch] = useState("");
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Load current preferences each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError(null);
    getBookdatePreferences()
      .then((p) => {
        if (!aliveRef.current) return;
        setScope(p.libraryScope || "full");
        setFavorites(p.favoriteBookIds || []);
        setPrompt(p.customPrompt || "");
        setSupportsRatings(!!p.backendCapabilities?.supportsRatings);
      })
      .catch(() => {
        if (aliveRef.current) setError("Couldn't load preferences");
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, [visible]);

  // The favorites picker needs the library — fetched once, on demand.
  useEffect(() => {
    if (!visible || scope !== "favorites" || library !== null) return;
    getBookdateLibrary()
      .then((books) => {
        if (aliveRef.current) setLibrary(books);
      })
      .catch(() => {
        if (aliveRef.current) setLibrary([]);
      });
  }, [visible, scope, library]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) =>
      prev.includes(id)
        ? prev.filter((f) => f !== id)
        : prev.length >= MAX_FAVORITES
        ? prev
        : [...prev, id]
    );
  }, []);

  // Selected first, then search matches — the whole library can be huge, so
  // cap the unselected tail.
  const pickerRows = useMemo(() => {
    if (!library) return [];
    const q = search.trim().toLowerCase();
    const selected = library.filter((b) => favorites.includes(b.id));
    const rest = library.filter(
      (b) =>
        !favorites.includes(b.id) &&
        (!q || b.title.toLowerCase().includes(q) || (b.author || "").toLowerCase().includes(q))
    );
    return [...selected, ...rest.slice(0, 30)];
  }, [library, favorites, search]);

  const canSave = !saving && !loading && (scope !== "favorites" || favorites.length > 0);

  const onSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateBookdatePreferences({
        libraryScope: scope,
        favoriteBookIds: scope === "favorites" ? favorites : [],
        customPrompt: prompt,
      });
      if (!aliveRef.current) return;
      onSaved?.();
      onClose();
    } catch (e: any) {
      if (aliveRef.current) setError(e?.response?.data?.error || "Couldn't save preferences");
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  const onRegenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    setError(null);
    try {
      await generateBookdateRecommendations();
      if (!aliveRef.current) return;
      onSaved?.();
      onClose();
    } catch (e: any) {
      if (aliveRef.current) setError(e?.response?.data?.error || "Couldn't regenerate picks");
    } finally {
      if (aliveRef.current) setRegenerating(false);
    }
  };

  const ScopeCard = ({
    value,
    title,
    body,
  }: {
    value: BookdatePreferences["libraryScope"];
    title: string;
    body: string;
  }) => {
    const active = scope === value;
    return (
      <Pressable
        onPress={() => setScope(value)}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ selected: active }}
        android_ripple={{ color: withAlpha(colors.primary, 0.08) }}
        style={{
          borderWidth: 2,
          borderColor: active ? colors.primary : colors.outlineVariant,
          backgroundColor: active ? withAlpha(colors.primaryContainer, 0.2) : "transparent",
          borderRadius: 16,
          padding: 14,
          marginBottom: 10,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Icon
          name={active ? "check" : "chevron-right"}
          size={20}
          color={active ? colors.primary : colors.onSurfaceVariant}
          style={{ marginRight: 12 }}
        />
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>{title}</Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>{body}</Text>
        </View>
      </Pressable>
    );
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="90%">
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
          <Text style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", marginBottom: 12 }}>
            BookDate Preferences
          </Text>

          {loading ? (
            <View style={{ paddingVertical: 32, alignItems: "center" }}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : (
            <>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, fontWeight: "600", marginBottom: 8 }}>
                Library scope
              </Text>
              <ScopeCard
                value="full"
                title="Full library"
                body="Recommendations based on your entire library"
              />
              {supportsRatings ? (
                <ScopeCard
                  value="rated"
                  title="Rated books"
                  body="Weight recommendations by your ratings"
                />
              ) : null}
              <ScopeCard
                value="favorites"
                title="Pick my favorites"
                body={`Select up to ${MAX_FAVORITES} books as your personalized library`}
              />

              {scope === "favorites" ? (
                <View style={{ marginTop: 4, marginBottom: 8 }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginBottom: 8 }}>
                    {favorites.length}/{MAX_FAVORITES} selected
                    {favorites.length === 0 ? " — pick at least one" : ""}
                  </Text>
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search your library"
                    placeholderTextColor={colors.onSurfaceVariant}
                    accessibilityLabel="Search favorites"
                    style={{
                      backgroundColor: colors.surfaceContainer,
                      color: colors.onSurface,
                      borderRadius: 12,
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      marginBottom: 8,
                    }}
                  />
                  {library === null ? (
                    <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 16 }} />
                  ) : (
                    pickerRows.map((b) => {
                      const selected = favorites.includes(b.id);
                      const cover = resolveRmabUrl(b.coverUrl || undefined);
                      return (
                        <Pressable
                          key={b.id}
                          onPress={() => toggleFavorite(b.id)}
                          accessibilityRole="button"
                          accessibilityLabel={`${selected ? "Remove" : "Add"} ${b.title}`}
                          android_ripple={{ color: withAlpha(colors.primary, 0.08) }}
                          style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7 }}
                        >
                          <Image
                            source={cover ? { uri: cover } : undefined}
                            style={{ width: 36, height: 36, borderRadius: 6, backgroundColor: colors.surfaceContainerHigh }}
                            contentFit="cover"
                          />
                          <View style={{ flex: 1, marginLeft: 10, marginRight: 8 }}>
                            <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 14, fontWeight: "500" }}>
                              {b.title}
                            </Text>
                            {b.author ? (
                              <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 11 }}>
                                {b.author}
                              </Text>
                            ) : null}
                          </View>
                          <Icon
                            name="check"
                            size={18}
                            color={selected ? colors.primary : colors.outlineVariant}
                          />
                        </Pressable>
                      );
                    })
                  )}
                </View>
              ) : null}

              <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, fontWeight: "600", marginTop: 12, marginBottom: 6 }}>
                Special requests (optional)
              </Text>
              <TextInput
                value={prompt}
                onChangeText={(t) => setPrompt(t.slice(0, MAX_PROMPT))}
                placeholder="e.g. fun narrators, mostly sci-fi and fantasy"
                placeholderTextColor={colors.onSurfaceVariant}
                multiline
                accessibilityLabel="Special requests"
                style={{
                  backgroundColor: colors.surfaceContainer,
                  color: colors.onSurface,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  minHeight: 90,
                  textAlignVertical: "top",
                }}
              />
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 11, alignSelf: "flex-end", marginTop: 4 }}>
                {prompt.length}/{MAX_PROMPT}
              </Text>

              {error ? (
                <Text style={{ color: colors.error, fontSize: 13, marginTop: 6 }}>{error}</Text>
              ) : null}

              {/* Rerun the AI with current preferences — separate from Save. */}
              <Pressable
                onPress={onRegenerate}
                disabled={regenerating || saving}
                accessibilityRole="button"
                accessibilityLabel="Regenerate picks now"
                android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.13) }}
                style={{
                  marginTop: 16,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  opacity: regenerating || saving ? 0.6 : 1,
                }}
              >
                {regenerating ? (
                  <ActivityIndicator size="small" color={colors.onSecondaryContainer} />
                ) : (
                  <>
                    <Icon name="refresh" size={18} color={colors.onSecondaryContainer} />
                    <Text style={{ color: colors.onSecondaryContainer, fontSize: 14, fontWeight: "600", marginLeft: 8 }}>
                      Regenerate picks now
                    </Text>
                  </>
                )}
              </Pressable>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 11, marginTop: 4, textAlign: "center" }}>
                Runs a fresh AI generation with the preferences above — can take a minute.
              </Text>

              <View style={{ flexDirection: "row", justifyContent: "flex-end", columnGap: 10, marginTop: 14 }}>
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.13) }}
                  style={{
                    height: 44,
                    paddingHorizontal: 20,
                    borderRadius: 22,
                    backgroundColor: colors.surfaceContainerHigh,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600" }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={onSave}
                  disabled={!canSave}
                  accessibilityRole="button"
                  accessibilityLabel="Save preferences"
                  android_ripple={{ color: withAlpha(colors.onPrimary, 0.13) }}
                  style={{
                    height: 44,
                    paddingHorizontal: 24,
                    borderRadius: 22,
                    backgroundColor: colors.primary,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: canSave ? 1 : 0.5,
                  }}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color={colors.onPrimary} />
                  ) : (
                    <Text style={{ color: colors.onPrimary, fontSize: 14, fontWeight: "600" }}>
                      Save preferences
                    </Text>
                  )}
                </Pressable>
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
