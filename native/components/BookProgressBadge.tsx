import React, { useMemo } from "react";
import { View, Text } from "react-native";
import { useUserStore } from "../store/useUserStore";
import { useDownloadStore } from "../store/useDownloadStore";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import { hasAudio, hasEbook } from "../utils/bookMatch";

// Stable empty map so the podcast-only whole-map subscription returns a constant
// reference for book rows — a book badge then never re-renders off another
// item's per-tick mediaProgress write.
const EMPTY_MEDIA_PROGRESS: Record<string, any> = {};

function remainingPretty(seconds: number): string {
  // < 1s would render "0s" — treat sub-second remainders as done.
  if (!seconds || seconds < 1) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/** In-progress percent for display, clamped to 1–99: a just-started book must
 *  never read "0%" and a nearly-done one must never read "100%" (100% is
 *  reserved for actually-finished, which renders as "Finished" instead). */
function pctLabel(fraction: number): string {
  return `${Math.min(99, Math.max(1, Math.round(fraction * 100)))}%`;
}

/** Remaining time spelled out for TTS ("3 hours 20 minutes"), vs the badge's
 *  compact visual "3h 20m" which TalkBack reads as "3h 20m". */
function remainingSpoken(seconds: number): string {
  if (!seconds || seconds < 60) return "less than a minute";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
  if (m > 0) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  return parts.join(" ");
}

/** Spoken status for a book card, folded into the card's accessibilityLabel so
 *  TalkBack conveys the badge's Finished / remaining / Downloaded state (the
 *  card's outer label otherwise overrides the badge, hiding it). Books only —
 *  podcasts summarize to Downloaded or nothing. Returns "" when the badge shows
 *  nothing. */
export function bookStatusA11yLabel(
  item: any,
  mediaProgress: Record<string, any>,
  isDownloaded: boolean
): string {
  try {
    const itemId = item?.id;
    if (item?.mediaType === "podcast") return isDownloaded ? "Downloaded" : "";
    const p = itemId ? mediaProgress?.[itemId] : null;
    const itemHasAudio = hasAudio(item);
    const itemHasEbook = hasEbook(item);
    const duration = itemHasAudio ? Number(p?.duration || 0) : 0;
    const currentTime = itemHasAudio ? Number(p?.currentTime || 0) : 0;
    const audioFraction = itemHasAudio
      ? Math.max(Math.min(1, Number(p?.progress ?? (duration > 0 ? currentTime / duration : 0))), 0)
      : 0;
    const ebookFraction = itemHasEbook
      ? Number(p?.ebookProgress || (!itemHasAudio ? p?.progress : 0) || 0)
      : 0;
    // Mirror the visual badge's finished/in-progress computation EXACTLY so the
    // spoken label can't drift from the icon (see the badge render below).
    const readerSetFinished = ebookFraction >= 0.99 && audioFraction > 0 && audioFraction < 0.99;
    const isEbookFinished = itemHasEbook && (ebookFraction >= 0.99 || (!!p?.isFinished && !readerSetFinished));
    const isAudioFinished = itemHasAudio && !!p?.isFinished && !readerSetFinished;
    const isAudioInProgress = audioFraction > 0 && !isAudioFinished;
    const isEbookInProgress = itemHasEbook && ebookFraction > 0 && !isEbookFinished;
    const anyFinished = isAudioFinished || isEbookFinished;
    const anyInProgress = isAudioInProgress || isEbookInProgress;

    const bits: string[] = [];
    if (anyFinished && !anyInProgress) {
      bits.push("Finished");
    } else {
      if (isAudioInProgress) {
        bits.push(
          duration > 0
            ? `${remainingSpoken(duration * (1 - audioFraction))} left`
            : `${Math.min(99, Math.max(1, Math.round(audioFraction * 100)))} percent`
        );
      }
      if (isEbookInProgress) {
        bits.push(`${Math.min(99, Math.max(1, Math.round(ebookFraction * 100)))} percent read`);
      }
    }
    if (isDownloaded) bits.push("Downloaded");
    return bits.join(", ");
  } catch {
    return "";
  }
}

interface Props {
  itemId: string;
  item?: any;
  downloaded?: boolean;
  progress?: any;
  style?: any;
}

export default function BookProgressBadge({ itemId, item, downloaded, progress, style }: Props) {
  const colors = useThemeColors();
  const isPodcast = item?.mediaType === "podcast";
  // BOOK path: subscribe to ONLY this item's entry, so a different book playing
  // (which rewrites its own mediaProgress key) never re-renders this badge.
  const perItemProgress = useUserStore((s) => (isPodcast ? undefined : s.mediaProgress[itemId]));
  // PODCAST path: needs to summarize across the per-episode composite keys, so
  // it reads the whole map — but only podcast rows subscribe to it (book rows
  // get the stable empty constant), and the O(n) scan below is memoized on the
  // map reference so it never rescans on an unrelated re-render.
  const podcastMap = useUserStore((s) => (isPodcast ? s.mediaProgress : EMPTY_MEDIA_PROGRESS));
  const isDownloadedEntry = useDownloadStore((s) => !!(itemId && s.completedDownloads[itemId]));

  const isDownloaded = !!downloaded || isDownloadedEntry;

  // Precomputed podcast episode summary (most-recent unfinished episode +
  // finished-episode count), memoized on the map so a per-tick progress write
  // doesn't re-run the full scan on every render. Only computed for the
  // whole-podcast summary — a caller that passed a specific episode's `progress`
  // uses that directly and skips the scan.
  const podcastSummary = useMemo(() => {
    if (!isPodcast || progress) return null;
    let latest: any = null;
    let latestAt = -1;
    let finishedCount = 0;
    Object.values(podcastMap).forEach((p: any) => {
      if (!p || p.libraryItemId !== itemId) return;
      if (p.isFinished) {
        // Only composite (per-episode) entries count toward "all finished" — a
        // plain-key entry from the tick loop would double-count an episode that
        // also has a server-side composite entry.
        if (p.episodeId) finishedCount++;
        return;
      }
      const fraction = Number(p.progress || 0);
      const currentTime = Number(p.currentTime || 0);
      if (fraction <= 0 && currentTime <= 0) return;
      const at = Number(p.lastUpdate || p.updatedAt || 0);
      if (at >= latestAt) {
        latestAt = at;
        latest = p;
      }
    });
    return { latest, finishedCount };
  }, [isPodcast, progress, podcastMap, itemId]);

  // What the chip shows — filled in per media type below, rendered once at the
  // bottom. The cloud (downloaded) icon is independent of progress state so a
  // downloaded book keeps its offline indicator while in progress / finished.
  let showCheck = false;
  let showHeadphones = false;
  let showBook = false;
  let label = "";

  if (isPodcast) {
    // Podcast progress lives per-EPISODE under composite `${itemId}-${episodeId}`
    // keys in the mediaProgress map, so the plain item-id lookup used for books
    // finds nothing. Summarize the episodes instead (via the memoized
    // podcastSummary): surface the most recently played unfinished episode, and
    // "Finished" only when every known episode is done. (Entries written by the
    // playback tick loop under the plain item key have libraryItemId === itemId
    // too, so they're picked up there.)
    let latest: any = null;
    let explicitFinished = false;
    let finishedCount = 0;
    if (progress) {
      // A caller passed a specific episode's progress entry (episode rows) —
      // show exactly that instead of the whole-podcast summary.
      if (progress.isFinished) explicitFinished = true;
      else if (Number(progress.progress || 0) > 0 || Number(progress.currentTime || 0) > 0) latest = progress;
    } else if (podcastSummary) {
      latest = podcastSummary.latest;
      finishedCount = podcastSummary.finishedCount;
    }
    const totalEpisodes = Number(item?.media?.numEpisodes ?? item?.media?.episodes?.length ?? 0);

    if (explicitFinished) {
      showCheck = true;
      label = "Finished";
    } else if (latest) {
      showHeadphones = true;
      const duration = Number(latest.duration || 0);
      const currentTime = Number(latest.currentTime || 0);
      const fraction = Number(latest.progress ?? 0) || (duration > 0 ? currentTime / duration : 0);
      label = duration > 0 ? remainingPretty(duration - currentTime) : pctLabel(fraction);
    } else if (!progress && totalEpisodes > 0 && finishedCount >= totalEpisodes) {
      showCheck = true;
      label = "Finished";
    } else if (isDownloaded) {
      label = "Downloaded";
    } else {
      return null;
    }
  } else {
    const progressObj = progress || perItemProgress || null;
    // Prefer the item payload for format detection; fall back to inferring
    // from the progress entry's fields when only an id was provided.
    const itemHasAudio = item ? hasAudio(item) : progressObj?.duration > 0 || progressObj?.currentTime > 0;
    const itemHasEbook = item ? hasEbook(item) : !!(progressObj?.ebookProgress > 0 || progressObj?.ebookLocation);

    const duration = itemHasAudio ? Number(progressObj?.duration || 0) : 0;
    const currentTime = itemHasAudio ? Number(progressObj?.currentTime || 0) : 0;
    const audioFraction = itemHasAudio
      ? Math.max(Math.min(1, progressObj?.progress ?? (duration > 0 ? currentTime / duration : 0)), 0)
      : 0;

    let ebookFraction = 0;
    if (itemHasEbook) {
      if (itemHasAudio) {
        ebookFraction = Number(progressObj?.ebookProgress || 0);
      } else {
        // Ebook-only: some payloads store reading progress in `progress`.
        ebookFraction = Number(progressObj?.ebookProgress || progressObj?.progress || 0);
      }
    }

    // Finished semantics — mediaProgress.isFinished is an ITEM-level flag. An
    // EXPLICIT mark-as-finished finishes the whole book: BOTH formats display
    // finished. The ONE exception is the reader auto-finish — ebook read to
    // >=99% while the audio sits mid-way (1–98%) — where the audio side keeps
    // its real remaining time visible. Mirrors ItemDetailScreen's progress
    // card (audioFinished / ebookFinished) so badge and card never disagree.
    const readerSetFinished = ebookFraction >= 0.99 && audioFraction > 0 && audioFraction < 0.99;
    const isEbookFinished =
      itemHasEbook && (ebookFraction >= 0.99 || (!!progressObj?.isFinished && !readerSetFinished));
    const isAudioFinished = itemHasAudio && !!progressObj?.isFinished && !readerSetFinished;

    const isAudioInProgress = audioFraction > 0 && !isAudioFinished;
    const isEbookInProgress = itemHasEbook && ebookFraction > 0 && !isEbookFinished;

    const anyFinished = isAudioFinished || isEbookFinished;
    const anyInProgress = isAudioInProgress || isEbookInProgress;

    if (!isDownloaded && !anyFinished && !anyInProgress) {
      return null;
    }

    showCheck = anyFinished;
    showHeadphones = isAudioInProgress;
    showBook = isEbookInProgress;

    const listenLabel = duration > 0 ? remainingPretty(duration * (1 - audioFraction)) : pctLabel(audioFraction);
    if (anyFinished && !anyInProgress) {
      // Everything the user has touched is done. "Finished" is the item-level
      // state, so an untouched second format doesn't block it — but a format
      // still mid-flight does (handled by the in-progress branches, which keep
      // the check icon alongside).
      label = "Finished";
    } else if (isAudioInProgress && isEbookInProgress) {
      label = `${listenLabel} • ${pctLabel(ebookFraction)}`;
    } else if (isAudioInProgress) {
      label = listenLabel;
    } else if (isEbookInProgress) {
      label = pctLabel(ebookFraction);
    } else if (isDownloaded) {
      label = "Downloaded";
    }
  }

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.tertiaryContainer,
          borderRadius: 999,
          paddingHorizontal: 8,
          paddingVertical: 3,
          alignSelf: "flex-start",
        },
        style,
      ]}
    >
      {/* Icon cluster: cloud (downloaded) + check (finished) + format icons */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginRight: label ? 5 : 0,
          columnGap: 4,
        }}
      >
        {isDownloaded && <Icon name="cloud" size={12} color={colors.onTertiaryContainer} />}
        {showCheck && <Icon name="check" size={12} color={colors.onTertiaryContainer} />}
        {showHeadphones && <Icon name="headphones" size={12} color={colors.onTertiaryContainer} />}
        {showBook && <Icon name="book" size={12} color={colors.onTertiaryContainer} />}
      </View>

      {/* Label */}
      {label ? (
        <Text
          numberOfLines={1}
          style={{
            color: colors.onTertiaryContainer,
            fontSize: 10,
            fontWeight: "600",
            letterSpacing: 0.1,
            flexShrink: 1,
          }}
        >
          {label}
        </Text>
      ) : null}
    </View>
  );
}
