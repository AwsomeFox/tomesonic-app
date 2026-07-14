import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Pressable,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { RowBase, SectionHeader, SelectRow } from "../components/SettingsRows";
import SettingSelectModal from "../components/SettingSelectModal";
import OpmlImportSheet from "../components/OpmlImportSheet";
import { api } from "../utils/api";
import {
  AbsError,
  normalizeAbsError,
  absErrorToErrorStateProps,
  absErrorToActionMessage,
} from "../utils/abs/errors";
import { refreshCapabilities, useServerCapabilities } from "../utils/abs/capabilities";
import { searchPodcasts } from "../utils/abs/podcasts";
import type { AbsPodcastSearchResult } from "../utils/abs/types";

/**
 * PodcastAddSearchScreen — find podcasts to add to the server (issue #56 P2).
 *
 * Route: "PodcastAddSearch"  Params: { libraryId?: string }
 *
 * Admin-gated like ServerAdminHubScreen: mount-time refreshCapabilities() with
 * a spinner until it settles, then an explicit lock ErrorState for a confirmed
 * non-admin (POST /api/podcasts is admin-only server-side).
 *
 * - Library context: podcast-type libraries from a fresh GET /api/libraries
 *   (AdminLibraries idiom — not the cached browsing store); params.libraryId
 *   preselects, else the first podcast library. No podcast libraries → an
 *   EmptyState explaining one is required.
 * - Search box (~400ms debounce) → GET /api/search/podcast. When the input IS
 *   a URL (http/https) we don't search the provider — a "Preview RSS feed" row
 *   goes straight to PodcastFeedPreview with the pasted URL.
 * - Result rows (LatestEpisodes row anatomy: cover thumb + title/artist/genre
 *   + episode count) navigate to PodcastFeedPreview with the result as `seed`;
 *   results the provider returns without a feedUrl are disabled with a hint.
 * - Secondary actions: "Add by RSS URL" (focuses the same input) and
 *   "Import OPML" (OpmlImportSheet, seeded with the selected library).
 *
 * Navigator registration is owned by the P3 package.
 */

const isUrlInput = (s: string) => /^https?:\/\//i.test(s.trim());

export default function PodcastAddSearchScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const caps = useServerCapabilities();

  // Admin gate (ServerAdminHub pattern): a cold-restored thin user has no
  // `type`, so hold a spinner until the mount-time authorize probe settles.
  const [refreshDone, setRefreshDone] = useState(false);
  useEffect(() => {
    let mounted = true;
    refreshCapabilities().finally(() => {
      if (mounted) setRefreshDone(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Library context.
  const [libraries, setLibraries] = useState<any[]>([]);
  const [libsLoading, setLibsLoading] = useState(true);
  const [libsError, setLibsError] = useState<AbsError | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | undefined>(
    route?.params?.libraryId
  );
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);

  // Search.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AbsPodcastSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchInputRef = useRef<TextInput | null>(null);
  // Monotonic request id: a slow earlier search must never clobber a newer one.
  const searchReqRef = useRef(0);

  const [opmlOpen, setOpmlOpen] = useState(false);

  useEffect(() => {
    if (!caps.isAdmin) return;
    let cancelled = false;
    (async () => {
      setLibsLoading(true);
      setLibsError(null);
      try {
        const res = await api.get("/api/libraries");
        if (cancelled) return;
        const raw = res.data?.libraries || res.data || [];
        setLibraries(
          Array.isArray(raw) ? raw.filter((l: any) => l && typeof l === "object" && l.id) : []
        );
      } catch (e) {
        if (!cancelled) setLibsError(normalizeAbsError(e));
      } finally {
        if (!cancelled) setLibsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caps.isAdmin, retryTick]);

  const podcastLibraries = useMemo(
    () => libraries.filter((l: any) => l.mediaType === "podcast"),
    [libraries]
  );

  // Preselect: keep params.libraryId when it IS a podcast library, otherwise
  // fall back to the first podcast library so navigation always carries one.
  useEffect(() => {
    if (!podcastLibraries.length) return;
    setSelectedLibraryId((cur) =>
      cur && podcastLibraries.some((l: any) => l.id === cur) ? cur : podcastLibraries[0].id
    );
  }, [podcastLibraries]);

  const selectedLibrary = podcastLibraries.find((l: any) => l.id === selectedLibraryId);

  const trimmedQuery = query.trim();
  const urlMode = isUrlInput(trimmedQuery);

  // Debounced provider search (~400ms). URL input never searches — the
  // preview row below handles it.
  useEffect(() => {
    if (!trimmedQuery || urlMode) {
      // Invalidate any in-flight search so its late result is dropped.
      searchReqRef.current++;
      setResults(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const reqId = ++searchReqRef.current;
    setSearching(true);
    setSearchError(null);
    const timer = setTimeout(async () => {
      try {
        const found = await searchPodcasts(trimmedQuery);
        if (searchReqRef.current !== reqId) return;
        setResults(found);
      } catch (e) {
        if (searchReqRef.current !== reqId) return;
        setResults(null);
        setSearchError(
          absErrorToActionMessage(e, { forbidden: "Only server admins can add podcasts." })
        );
      } finally {
        if (searchReqRef.current === reqId) setSearching(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [trimmedQuery, urlMode]);

  const openPreview = (params: { feedUrl: string; seed?: AbsPodcastSearchResult }) => {
    navigation.navigate("PodcastFeedPreview", {
      feedUrl: params.feedUrl,
      ...(params.seed ? { seed: params.seed } : {}),
      libraryId: selectedLibraryId,
    });
  };

  const renderResultRow = (result: AbsPodcastSearchResult, index: number) => {
    const cover = result.cover || result.artworkUrl;
    const hasFeed = !!result.feedUrl;
    const detail = [result.artistName, result.genres?.[0]].filter(Boolean).join(" · ");
    const count =
      typeof result.trackCount === "number"
        ? `${result.trackCount} episode${result.trackCount === 1 ? "" : "s"}`
        : "";
    // Provider hits without a feed URL can't be previewed or added — keep the
    // row visible (so the search doesn't look broken) but disabled with a hint.
    const subtitleBits = hasFeed
      ? [detail, count].filter(Boolean)
      : [detail, "No RSS feed link from this provider"].filter(Boolean);
    return (
      <Pressable
        key={result.id ?? result.feedUrl ?? index}
        onPress={() => hasFeed && openPreview({ feedUrl: result.feedUrl!, seed: result })}
        disabled={!hasFeed}
        accessibilityRole="button"
        accessibilityLabel={`Podcast result: ${result.title || "Untitled"}`}
        accessibilityState={{ disabled: !hasFeed }}
        android_ripple={{ color: withAlpha(colors.onSurface, 0.1) }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
          opacity: hasFeed ? 1 : 0.5,
        }}
      >
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 10,
            overflow: "hidden",
            backgroundColor: colors.surfaceContainerHigh,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {cover ? (
            <Image source={{ uri: cover }} style={{ width: 56, height: 56 }} contentFit="cover" />
          ) : (
            <Icon name="podcast" size={24} color={colors.onSurfaceVariant} />
          )}
        </View>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text
            numberOfLines={2}
            style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}
          >
            {result.title || "Untitled"}
          </Text>
          {subtitleBits.length ? (
            <Text
              numberOfLines={1}
              style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}
            >
              {subtitleBits.join(" · ")}
            </Text>
          ) : null}
        </View>
        {hasFeed ? (
          <Icon name="chevron-right" size={24} color={colors.onSurfaceVariant} />
        ) : null}
      </Pressable>
    );
  };

  let body: React.ReactNode;
  if (caps.isAdmin) {
    if (libsLoading) {
      body = (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      );
    } else if (libsError) {
      body = (
        <ErrorState
          style={{ flex: 1 }}
          {...absErrorToErrorStateProps(libsError, {
            subject: "libraries",
            overrides: {
              offline: { message: "Adding podcasts needs a connection to the server." },
            },
          })}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      );
    } else if (podcastLibraries.length === 0) {
      body = (
        <EmptyState
          style={{ flex: 1 }}
          icon="podcast"
          title="No podcast libraries"
          message="Podcasts can only be added to a podcast-type library. Create one under Libraries first."
        />
      );
    } else {
      body = (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Destination library context — every preview/import inherits it. */}
          <SelectRow
            icon="library"
            title="Library"
            subtitle={selectedLibrary?.name || "Choose a podcast library"}
            onPress={() => setLibraryPickerOpen(true)}
            colors={colors}
          />

          {/* Search / URL input. */}
          <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
            <TextInput
              ref={searchInputRef}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Search podcasts or paste an RSS feed URL"
              placeholderTextColor={colors.onSurfaceVariant}
              accessibilityLabel="Search podcasts"
              style={{
                backgroundColor: colors.surfaceContainer,
                color: colors.onSurface,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 15,
              }}
            />
          </View>

          {urlMode ? (
            // The input parses as a URL — skip the provider entirely and go
            // straight to the server-side feed preview.
            <RowBase
              icon="rss"
              title="Preview RSS feed"
              subtitle={trimmedQuery}
              onPress={() => openPreview({ feedUrl: trimmedQuery })}
              colors={colors}
            />
          ) : searching ? (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : searchError ? (
            <Text
              accessibilityRole="alert"
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 14,
                textAlign: "center",
                paddingVertical: 24,
                paddingHorizontal: 32,
              }}
            >
              {searchError}
            </Text>
          ) : results !== null ? (
            results.length === 0 ? (
              <EmptyState
                icon="search"
                title="No podcasts found"
                message="Try different search terms, or paste the show's RSS feed URL."
              />
            ) : (
              results.map(renderResultRow)
            )
          ) : null}

          <SectionHeader label="Other ways to add" colors={colors} />
          <RowBase
            icon="rss"
            title="Add by RSS URL"
            subtitle="Paste a feed address into the box above"
            onPress={() => searchInputRef.current?.focus()}
            colors={colors}
          />
          <RowBase
            icon="download"
            title="Import OPML"
            subtitle="Bulk-add feeds exported from another app"
            onPress={() => setOpmlOpen(true)}
            colors={colors}
          />
        </ScrollView>
      );
    }
  } else if (!refreshDone) {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  } else {
    body = (
      <ErrorState
        icon="lock"
        title="Admin access required"
        message="Only server admins can add podcasts to the server."
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
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
          Add podcasts
        </Text>
      </View>

      {body}

      <SettingSelectModal
        visible={libraryPickerOpen}
        title="Library"
        options={podcastLibraries.map((l: any) => ({ label: l.name || l.id, value: l.id }))}
        selected={selectedLibraryId}
        onSelect={(v) => setSelectedLibraryId(v)}
        onClose={() => setLibraryPickerOpen(false)}
      />

      <OpmlImportSheet
        visible={opmlOpen}
        libraryId={selectedLibraryId}
        onClose={() => setOpmlOpen(false)}
      />
    </SafeAreaView>
  );
}
