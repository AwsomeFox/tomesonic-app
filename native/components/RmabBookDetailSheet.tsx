import React, { useEffect, useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import BottomSheet from "./BottomSheet";
import Icon from "./Icon";
import Pressable from "./HintPressable";
import { RmabBook, resolveRmabUrl } from "../utils/rmab";
import BookDescription from "./BookDescription";

/**
 * Catalog-book details sheet shared by every discovery surface (missing-from
 * series/author, search results, Discover deck). Same layout as the request
 * details sheet minus the request-specific info; an optional Request action
 * lets surfaces with request buttons offer it here too.
 */
export default function RmabBookDetailSheet({
  book,
  onClose,
  onRequest,
  requested = false,
  requesting = false,
  notice = null,
}: {
  book: (RmabBook & { coverUrl?: string }) | null;
  onClose: () => void;
  /** Omit to hide the Request action (e.g. Discover, where Like requests). */
  onRequest?: (book: RmabBook) => void;
  requested?: boolean;
  requesting?: boolean;
  /** Request-outcome message rendered INSIDE the sheet — the host section's
   *  notice line paints underneath the open sheet where it can't be seen. */
  notice?: string | null;
}) {
  const colors = useThemeColors();
  const cover = resolveRmabUrl(book?.coverArtUrl || book?.coverUrl);
  const year = book?.releaseDate ? String(book.releaseDate).slice(0, 4) : null;

  // Description (incl. the lazy Audnexus fill) lives in BookDescription; the
  // sheet only backfills the narrator line from the same fetch.
  const [fetchedNarrator, setFetchedNarrator] = useState<string | null>(null);
  useEffect(() => setFetchedNarrator(null), [book?.asin, (book as any)?.audnexusAsin]);
  // BookDate recs carry audnexusAsin instead of asin — accept either.
  const lookupAsin = book?.asin || (book as any)?.audnexusAsin;
  const narrator = book?.narrator || fetchedNarrator;

  return (
    <BottomSheet visible={!!book} onClose={onClose}>
      {book ? (
        <View style={{ paddingHorizontal: 24, paddingBottom: 16 }}>
          <View style={{ flexDirection: "row" }}>
            <Image
              source={cover ? { uri: cover } : undefined}
              style={{ width: 96, height: 96, borderRadius: 10, backgroundColor: colors.surfaceContainerHigh }}
              contentFit="cover"
            />
            <View style={{ flex: 1, marginLeft: 16, justifyContent: "center" }}>
              <Text style={{ color: colors.onSurface, fontSize: 19, fontWeight: "600" }} numberOfLines={3}>
                {book.title}
              </Text>
              {book.author ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 4 }} numberOfLines={1}>
                  {book.author}
                </Text>
              ) : null}
              {narrator ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
                  Read by {narrator}
                </Text>
              ) : null}
            </View>
          </View>

          {(book.sequence || year) ? (
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 8 }}>
              {book.sequence ? (
                <View style={{ backgroundColor: colors.surfaceContainerHigh, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, fontWeight: "600" }}>
                    Book {book.sequence}
                  </Text>
                </View>
              ) : null}
              {year ? (
                <View style={{ backgroundColor: colors.surfaceContainerHigh, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, fontWeight: "600" }}>{year}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {(book as any).aiReason ? (
            <View style={{ backgroundColor: colors.secondaryContainer, borderRadius: 14, padding: 12, marginTop: 14 }}>
              <Text
                style={{
                  color: colors.onSecondaryContainer,
                  fontSize: 11,
                  fontWeight: "700",
                  letterSpacing: 0.8,
                  marginBottom: 4,
                }}
              >
                WHY THIS WAS RECOMMENDED
              </Text>
              <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, lineHeight: 19 }}>
                {(book as any).aiReason}
              </Text>
            </View>
          ) : null}

          <BookDescription
            text={book.description}
            asin={lookupAsin}
            onFetched={(d) => {
              if (d?.narrator) setFetchedNarrator(d.narrator);
            }}
          />

          {notice ? (
            <Text
              // Request outcome (error / "already requested") — announce it; a
              // TalkBack user otherwise gets no feedback from the tap.
              accessibilityLiveRegion="polite"
              style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 14 }}
            >
              {notice}
            </Text>
          ) : null}

          {onRequest ? (
            <View style={{ alignItems: "flex-end", marginTop: 18 }}>
              {requested ? (
                <View
                  // Announce the Request→Requested transition for screen readers.
                  // accessible marks it as one focusable element so the live
                  // region reliably fires.
                  accessible
                  accessibilityLiveRegion="polite"
                  accessibilityLabel="Requested"
                  style={{
                    backgroundColor: colors.surfaceContainerHigh,
                    borderRadius: 20,
                    height: 40,
                    paddingHorizontal: 18,
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "row",
                  }}
                >
                  <Icon name="check" size={18} color={colors.onSurfaceVariant} />
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "600", marginLeft: 6 }}>
                    Requested
                  </Text>
                </View>
              ) : (
                <Pressable
                  onPress={() => onRequest(book)}
                  disabled={requesting}
                  accessibilityRole="button"
                  accessibilityLabel={`Request ${book.title}`}
                  accessibilityState={{ disabled: requesting, busy: requesting }}
                  android_ripple={{ color: withAlpha(colors.onPrimaryContainer, 0.13) }}
                  style={{
                    backgroundColor: colors.primaryContainer,
                    borderRadius: 20,
                    height: 40,
                    paddingHorizontal: 18,
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "row",
                    opacity: requesting ? 0.6 : 1,
                  }}
                >
                  {requesting ? (
                    <ActivityIndicator size="small" color={colors.onPrimaryContainer} />
                  ) : (
                    <>
                      <Icon name="add" size={18} color={colors.onPrimaryContainer} />
                      <Text style={{ color: colors.onPrimaryContainer, fontSize: 14, fontWeight: "600", marginLeft: 6 }}>
                        Request
                      </Text>
                    </>
                  )}
                </Pressable>
              )}
            </View>
          ) : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}
