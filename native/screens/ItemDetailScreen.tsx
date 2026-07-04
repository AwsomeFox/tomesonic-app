import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, Image, ActivityIndicator, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import { useDownloadStore } from "../store/useDownloadStore";
import { downloader } from "../utils/downloader";
import { encodeFilterValue } from "../components/FilterModal";
import TopAppBar from "../components/TopAppBar";
import ChaptersModal from "../components/ChaptersModal";
import { hasAudio, hasEbook as itemHasEbook, getEbookFormat, bestCounterpart } from "../utils/bookMatch";

/** Strip HTML tags/entities from ABS descriptions (which contain markup). */
function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// base64Encode helper removed in favor of imported encodeFilterValue

/** Mirrors $elapsedPretty — "19 hr 25 min" / "45 min". */
function elapsedPretty(seconds: number | undefined) {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

export default function ItemDetailScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const { width: screenWidth } = useWindowDimensions();
  const { itemId } = route.params || {};
  const { serverConnectionConfig } = useUserStore();
  const [descExpanded, setDescExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [chaptersVisible, setChaptersVisible] = useState(false);

  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const currentSession = usePlaybackStore((state) => state.currentSession);
  const currentChapterIndex = usePlaybackStore((state) => state.currentChapterIndex);
  const seekToChapter = usePlaybackStore((state) => state.seekToChapter);

  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasSession = currentSession !== null;

  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const activeDownloads = useDownloadStore((s) => s.activeDownloads);
  const cancelDownload = useDownloadStore((s) => s.cancelDownload);

  const isDownloaded = !!(item?.id && completedDownloads[item.id]);
  const isDownloading = !!(item?.id && activeDownloads[item.id]);
  const isFinished = !!item?.userMediaProgress?.isFinished;

  const handleToggleFinished = async () => {
    if (!item?.id) return;
    try {
      await api.patch(`/api/me/progress/${item.id}`, { isFinished: !isFinished });
      refetchItem();
    } catch (err) {
      console.warn("[ItemDetail] Toggle finished failed:", err);
    }
  };

  const handleDownloadPress = async () => {
    if (!item?.id) return;
    if (isDownloaded) {
      cancelDownload(item.id);
      refetchItem();
    } else {
      if (isDownloading) return;
      try {
        await downloader.downloadBook(item, serverAddress, token);
        refetchItem();
      } catch (err) {
        console.warn("[ItemDetail] Download failed:", err);
      }
    }
  };

  const refetchItem = async () => {
    if (!itemId) return;
    try {
      const response = await api.get(`/api/items/${itemId}?expanded=1&include=progress,rssfeed`);
      setItem(response.data);
    } catch (err) {
      console.warn("[ItemDetail] refetch failed", err);
    }
  };

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  useEffect(() => {
    if (!itemId) {
      setError("No item ID provided.");
      setLoading(false);
      return;
    }
    const fetchItem = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await api.get(`/api/items/${itemId}?expanded=1&include=progress,rssfeed`);
        setItem(response.data);
      } catch (err) {
        console.error("[ItemDetail] Failed to fetch item:", err);
        setError("Failed to load item details.");
      } finally {
        setLoading(false);
      }
    };
    fetchItem();
  }, [itemId]);

  const metadata = item?.media?.metadata || {};
  const progress = item?.userMediaProgress || null;
  const coverUrl =
    itemId && serverAddress && token ? `${serverAddress}/api/items/${itemId}/cover?token=${token}` : null;

  const description = stripHtml(metadata.description || "");
  const duration = item?.media?.duration || 0;
  const progressPercent = progress ? Math.min(Math.round((progress.progress || 0) * 100), 100) : 0;
  const timeRemaining = progress ? elapsedPretty(duration - (progress.currentTime || 0)) : "";

  const chapters = item?.media?.chapters || [];
  const hasChapters = chapters.length > 0;
  const isCurrentlyPlaying = currentSession?.libraryItemId === itemId;

  // What media this exact item has, and what a matched sibling item supplies.
  // Podcasts carry episodes (not tracks), so hasAudio() would be false — treat
  // them as playable and never fuzzy-match them against books.
  const isPodcastItem = item?.mediaType === "podcast";
  const selfHasAudio = isPodcastItem || hasAudio(item);
  const selfHasEbook = itemHasEbook(item);
  const selfEbookFormat = getEbookFormat(item);

  // A separate library item that is the same book in the other format (ABS often
  // stores the ebook and audiobook as two items). Matched fuzzily by title+author.
  const [counterpart, setCounterpart] = useState<any>(null);
  useEffect(() => {
    if (!item || item.mediaType === "podcast") { setCounterpart(null); return; }
    // If this item already has both audio and ebook, no sibling is needed.
    if (selfHasAudio && selfHasEbook) { setCounterpart(null); return; }
    const libraryId = item.libraryId;
    const title = item?.media?.metadata?.title;
    if (!libraryId || !title) { setCounterpart(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(
          `/api/libraries/${libraryId}/search?q=${encodeURIComponent(String(title).slice(0, 60))}&limit=10`
        );
        const books = (r.data?.book || []).map((b: any) => b.libraryItem).filter(Boolean);
        const match = bestCounterpart(item, books);
        // Only keep the match if it supplies the format this item lacks.
        const useful = match && (selfHasAudio ? itemHasEbook(match) : hasAudio(match) || itemHasEbook(match));
        if (!cancelled) setCounterpart(useful ? match : null);
      } catch (e) {
        if (!cancelled) setCounterpart(null);
      }
    })();
    return () => { cancelled = true; };
  }, [item?.id]);

  // Resolve where to read/play from — this item, or its matched sibling.
  const ebookSource = selfHasEbook
    ? { id: item.id, format: selfEbookFormat }
    : counterpart && itemHasEbook(counterpart)
    ? { id: counterpart.id, format: getEbookFormat(counterpart) }
    : null;
  const audioCounterpartId =
    !selfHasAudio && counterpart && hasAudio(counterpart) ? counterpart.id : null;
  const canRead = !!ebookSource;

  const handleSeekToChapter = async (index: number) => {
    if (isCurrentlyPlaying) {
      await seekToChapter(index);
    } else {
      setStarting(true);
      const ok = await startPlayback(itemId);
      setStarting(false);
      if (ok) {
        // Wait a brief moment for track player setup before seeking
        setTimeout(async () => {
          await seekToChapter(index);
        }, 300);
        navigation.navigate("Player");
      }
    }
  };

  // Metadata sources (arrays from expanded API response).
  const authors: { id: string; name: string }[] = metadata.authors || [];
  const narrators: string[] = metadata.narrators || [];
  const seriesList: { id: string; name: string; sequence?: string; text: string }[] = (
    metadata.series || []
  ).map((se: any) => ({ ...se, text: se.sequence ? `${se.name} #${se.sequence}` : se.name }));
  const genres: string[] = metadata.genres || [];
  const tags: string[] = item?.media?.tags || [];
  const publishedYear: string | undefined = metadata.publishedYear;

  // Series subtitle e.g. "Expeditionary Force, Book 10".
  const seriesSubtitle =
    seriesList.length > 0
      ? seriesList[0].sequence
        ? `${seriesList[0].name}, Book ${seriesList[0].sequence}`
        : seriesList[0].name
      : metadata.subtitle || "";

  // Cover sizing — centered, ~68% of screen width, capped.
  const coverWidth = Math.min(Math.round(screenWidth * 0.68), 280);

  const startAudio = async (id: string) => {
    if (!item || starting) return;
    setStarting(true);
    const ok = await startPlayback(id);
    setStarting(false);
    if (ok) navigation.navigate("Player");
  };
  const handlePlay = () => startAudio(itemId);

  const openReader = () => {
    if (!ebookSource) return;
    navigation.navigate("Reader", {
      itemId: ebookSource.id,
      ebookFormat: ebookSource.format,
      title: metadata.title,
    });
  };

  /** Two-column metadata row: CAPS grey label (left) + value (right, links green+underline). */
  const MetaRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <View style={{ flexDirection: "row", paddingVertical: 6 }}>
      <Text
        style={{
          color: colors.onSurfaceVariant,
          fontSize: 12,
          fontWeight: "600",
          letterSpacing: 0.6,
          width: 118,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>{children}</View>
    </View>
  );

  /** Green underlined link chip inside a metadata value. */
  const Link = ({ text, onPress }: { text: string; onPress?: () => void }) => (
    <Pressable onPress={onPress}>
      <Text
        style={{
          color: colors.primary,
          fontSize: 14,
          textDecorationLine: "underline",
        }}
      >
        {text}
      </Text>
    </Pressable>
  );

  /** Plain (non-link) metadata value. */
  const Value = ({ text }: { text: string }) => (
    <Text style={{ color: colors.onSurface, fontSize: 14 }}>{text}</Text>
  );

  /** Comma-joined list of links. */
  const LinkList = ({ items }: { items: { key: string; text: string; onPress?: () => void }[] }) => (
    <>
      {items.map((it, i) => (
        <React.Fragment key={it.key}>
          <Link text={it.text} onPress={it.onPress} />
          {i < items.length - 1 ? (
            <Text style={{ color: colors.onSurface, fontSize: 14 }}>, </Text>
          ) : null}
        </React.Fragment>
      ))}
    </>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} showBack title={metadata.title || "Book Details"} />

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Icon name="close" size={40} color={colors.error} />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center", marginTop: 12 }}>{error}</Text>
        </View>
      ) : item ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: hasSession ? 120 : 48 }}>
          {/* Centered cover with progress bar on its bottom edge */}
          <View style={{ alignItems: "center", paddingTop: 20 }}>
            <View
              style={{
                width: coverWidth,
                height: coverWidth,
                borderRadius: 16,
                overflow: "hidden",
                backgroundColor: colors.surfaceContainerHigh,
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 6 },
                shadowOpacity: 0.22,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              {coverUrl ? (
                <Image source={{ uri: coverUrl }} style={{ width: coverWidth, height: coverWidth }} resizeMode="cover" />
              ) : (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="book" size={64} color={colors.onSurfaceVariant} />
                </View>
              )}
              {/* Thin pine-green progress bar along the cover's bottom edge */}
              {progressPercent > 0 ? (
                <View
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    height: 6,
                    width: `${progressPercent}%`,
                    backgroundColor: isFinished ? colors.tertiary : colors.primary,
                    borderTopRightRadius: 3,
                  }}
                />
              ) : null}
            </View>
          </View>

          {/* Title + series subtitle (centered) */}
          <View style={{ paddingHorizontal: 20, marginTop: 20, alignItems: "center" }}>
            <Text style={{ color: colors.onSurface, fontSize: 25, fontFamily: "serif", fontWeight: "700", lineHeight: 32, textAlign: "center" }}>
              {metadata.title || "Untitled"}
            </Text>
            {seriesSubtitle ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 16, marginTop: 6, textAlign: "center" }}>
                {seriesSubtitle}
              </Text>
            ) : null}
          </View>

          {/* Action row. Primary is Play for audiobooks; for an ebook-only item
              it becomes Read (in the play button's place). A matched sibling in
              the other format adds the secondary Play/Read button. */}
          <View style={{ flexDirection: "row", paddingHorizontal: 20, marginTop: 18, alignItems: "stretch" }}>
            {selfHasAudio ? (
              <Pressable
                onPress={handlePlay}
                disabled={starting}
                style={{
                  flex: 1,
                  backgroundColor: colors.primary,
                  height: 52,
                  borderRadius: 26,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  opacity: starting ? 0.6 : 1,
                }}
              >
                {starting ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <>
                    <Icon name="play" size={22} color={colors.onPrimary} />
                    <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600", marginLeft: 8 }}>
                      {progress && !isFinished && progressPercent > 0 ? "Continue" : "Play"}
                    </Text>
                  </>
                )}
              </Pressable>
            ) : canRead ? (
              // Ebook-only: Read takes the primary slot.
              <Pressable
                onPress={openReader}
                style={{
                  flex: 1,
                  backgroundColor: colors.primary,
                  height: 52,
                  borderRadius: 26,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                }}
              >
                <Icon name="book" size={22} color={colors.onPrimary} />
                <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600", marginLeft: 8 }}>
                  Read
                </Text>
              </Pressable>
            ) : (
              <View
                style={{
                  flex: 1, height: 52, borderRadius: 26, backgroundColor: colors.surfaceContainer,
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>No playable media</Text>
              </View>
            )}

            {/* Download Button — only for items with their own audio. */}
            {selfHasAudio ? (
              <Pressable
                onPress={handleDownloadPress}
                style={{
                  marginLeft: 10,
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: isDownloaded ? "rgba(179, 38, 30, 0.1)" : colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: isDownloaded ? 1 : 0,
                  borderColor: isDownloaded ? colors.error : "transparent",
                }}
              >
                {isDownloading ? (
                  <ActivityIndicator size="small" color={colors.onSecondaryContainer} />
                ) : (
                  <Icon
                    name={isDownloaded ? "trash" : "download"}
                    size={22}
                    color={isDownloaded ? colors.error : colors.onSecondaryContainer}
                  />
                )}
              </Pressable>
            ) : null}

            {/* Secondary Read button (audiobook that also has an ebook, own or matched). */}
            {selfHasAudio && canRead ? (
              <Pressable
                onPress={openReader}
                style={{
                  marginLeft: 10,
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="book" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            ) : null}

            {/* Secondary Play button (ebook-only item with a matched audiobook). */}
            {!selfHasAudio && audioCounterpartId ? (
              <Pressable
                onPress={() => startAudio(audioCounterpartId)}
                disabled={starting}
                style={{
                  marginLeft: 10,
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {starting ? (
                  <ActivityIndicator size="small" color={colors.onSecondaryContainer} />
                ) : (
                  <Icon name="play" size={22} color={colors.onSecondaryContainer} />
                )}
              </Pressable>
            ) : null}

            {/* Chapters Button */}
            {hasChapters ? (
              <Pressable
                onPress={() => setChaptersVisible(true)}
                style={{
                  marginLeft: 10,
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="list" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            ) : null}

            {/* Mark as Finished/Unfinished Button */}
            <Pressable
              onPress={handleToggleFinished}
              style={{
                marginLeft: 10,
                width: 52,
                height: 52,
                borderRadius: 26,
                backgroundColor: isFinished ? colors.primaryContainer : colors.secondaryContainer,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon
                name="check"
                size={22}
                color={isFinished ? colors.onPrimaryContainer : colors.onSecondaryContainer}
                style={{ opacity: isFinished ? 1 : 0.45 }}
              />
            </Pressable>
          </View>

          {/* Your Progress card */}
          {progressPercent > 0 ? (
            <View style={{ paddingHorizontal: 20, marginTop: 18 }}>
              <View
                style={{
                  backgroundColor: colors.surfaceContainer,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: colors.outlineVariant,
                  paddingVertical: 16,
                  paddingHorizontal: 16,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600" }}>
                  Your Progress: {progressPercent}%
                </Text>
                {isFinished ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4 }}>Finished</Text>
                ) : timeRemaining ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4 }}>
                    {timeRemaining} remaining
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Metadata table */}
          <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
             {authors.length > 0 ? (
              <MetaRow label="Author">
                <LinkList
                  items={authors.map((a) => ({
                    key: a.id,
                    text: a.name,
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `authors.${encodeFilterValue(a.id)}`,
                        showBack: true,
                        title: a.name,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {seriesList.length > 0 ? (
              <MetaRow label="Series">
                <LinkList
                  items={seriesList.map((s) => ({
                    key: s.id,
                    text: s.text,
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `series.${encodeFilterValue(s.id)}`,
                        showBack: true,
                        title: s.text,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {duration > 0 ? (
              <MetaRow label="Duration">
                <Value text={elapsedPretty(duration)} />
              </MetaRow>
            ) : null}

             {narrators.length > 0 ? (
              <MetaRow label="Narrators">
                <LinkList
                  items={narrators.map((n) => ({
                    key: n,
                    text: n,
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `narrators.${encodeFilterValue(n)}`,
                        showBack: true,
                        title: n,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {genres.length > 0 ? (
              <MetaRow label="Genres">
                <LinkList
                  items={genres.map((g) => ({
                    key: g,
                    text: g,
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `genres.${encodeFilterValue(g)}`,
                        showBack: true,
                        title: g,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {tags.length > 0 ? (
              <MetaRow label="Tags">
                <LinkList
                  items={tags.map((t) => ({
                    key: t,
                    text: t,
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `tags.${encodeFilterValue(t)}`,
                        showBack: true,
                        title: t,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {publishedYear ? (
              <MetaRow label="Publish Year">
                <Value text={String(publishedYear)} />
              </MetaRow>
            ) : null}
          </View>

          {/* Description with Read more */}
          {description ? (
            <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
              <Text numberOfLines={descExpanded ? undefined : 5} style={{ color: colors.onSurface, fontSize: 14, lineHeight: 21 }}>
                {description}
              </Text>
              {description.length > 240 ? (
                <Pressable onPress={() => setDescExpanded((v) => !v)}>
                  <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "600", marginTop: 8 }}>
                    {descExpanded ? "Read less" : "Read more"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      ) : null}

      <ChaptersModal
        visible={chaptersVisible}
        onClose={() => setChaptersVisible(false)}
        chapters={chapters}
        currentChapterIndex={isCurrentlyPlaying ? currentChapterIndex : -1}
        onSeekToChapter={handleSeekToChapter}
        hideBackdrop
      />
    </SafeAreaView>
  );
}
