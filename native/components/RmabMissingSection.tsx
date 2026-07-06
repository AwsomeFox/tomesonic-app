import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import { useRmabStore } from "../store/useRmabStore";
import { RmabBook } from "../utils/rmab";

/**
 * "Missing from your library" — books ReadMeABook knows about (Audible
 * catalog) that aren't in the linked library, each with a one-tap Request
 * button. Renders NOTHING unless RMAB is configured; the screens embedding it
 * (series/author/search) stay RMAB-free otherwise.
 *
 * `fetchMissing` is screen-specific (series lookup, author books, catalog
 * search) and must already return catalog-enriched books; this component
 * applies the `!isAvailable` filter and owns request-button state.
 */
export default function RmabMissingSection({
  title = "Missing from your library",
  fetchMissing,
  maxItems = 10,
}: {
  title?: string;
  fetchMissing: () => Promise<RmabBook[]>;
  maxItems?: number;
}) {
  const colors = useThemeColors();
  const configured = useRmabStore((s) => s.configured);
  const requestedAsins = useRmabStore((s) => s.requestedAsins);
  const requestBook = useRmabStore((s) => s.requestBook);

  const [books, setBooks] = useState<RmabBook[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    setLoading(true);
    fetchMissing()
      .then((list) => {
        if (cancelled) return;
        const missing = (list || []).filter((b) => b && b.asin && !b.isAvailable);
        setBooks(missing);
      })
      .catch((e) => {
        console.warn("[RMAB] missing-books lookup failed", e?.message || e);
        if (!cancelled) setBooks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, fetchMissing]);

  const onRequest = useCallback(
    async (book: RmabBook) => {
      setRequesting(book.asin);
      setNotice(null);
      const res = await requestBook(book);
      if (!res.ok && res.message) setNotice(res.message);
      setRequesting(null);
    },
    [requestBook]
  );

  if (!configured) return null;
  if (!loading && (!books || books.length === 0)) return null;

  const shown = (books || []).slice(0, maxItems);

  return (
    <View style={{ marginTop: 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, marginBottom: 8 }}>
        <Text style={{ flex: 1, color: colors.onSurface, fontSize: 18, fontWeight: "600" }}>{title}</Text>
        {loading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      </View>
      {notice ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, paddingHorizontal: 20, marginBottom: 6 }}>
          {notice}
        </Text>
      ) : null}
      {shown.map((book) => {
        const status = requestedAsins[book.asin] || book.requestStatus;
        return (
          <View
            key={book.asin}
            style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 8 }}
          >
            <Image
              source={book.coverArtUrl ? { uri: book.coverArtUrl } : undefined}
              style={{ width: 46, height: 46, borderRadius: 6, backgroundColor: colors.surfaceContainerHigh }}
              contentFit="cover"
            />
            <View style={{ flex: 1, marginLeft: 12, marginRight: 8 }}>
              <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "500" }}>
                {book.title}
              </Text>
              {book.author || book.narrator ? (
                <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                  {[book.author, book.narrator ? `read by ${book.narrator}` : null]
                    .filter(Boolean)
                    .join(" • ")}
                </Text>
              ) : null}
            </View>
            {status ? (
              <View
                style={{
                  backgroundColor: colors.surfaceContainerHigh,
                  borderRadius: 12,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                }}
              >
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, fontWeight: "600" }}>
                  Requested
                </Text>
              </View>
            ) : (
              <Pressable
                onPress={() => onRequest(book)}
                disabled={!!requesting}
                accessibilityRole="button"
                accessibilityLabel={`Request ${book.title}`}
                style={{
                  backgroundColor: colors.primaryContainer,
                  borderRadius: 16,
                  paddingHorizontal: 12,
                  height: 32,
                  flexDirection: "row",
                  alignItems: "center",
                  opacity: requesting && requesting !== book.asin ? 0.5 : 1,
                }}
              >
                {requesting === book.asin ? (
                  <ActivityIndicator size="small" color={colors.onPrimaryContainer} />
                ) : (
                  <>
                    <Icon name="add" size={16} color={colors.onPrimaryContainer} />
                    <Text style={{ color: colors.onPrimaryContainer, fontSize: 13, fontWeight: "600", marginLeft: 4 }}>
                      Request
                    </Text>
                  </>
                )}
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}
