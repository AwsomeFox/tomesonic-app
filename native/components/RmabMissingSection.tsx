import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import { useRmabStore } from "../store/useRmabStore";
import { RmabBook, resolveRmabUrl } from "../utils/rmab";
import RmabBookDetailSheet from "./RmabBookDetailSheet";
import Pressable from "./HintPressable";

/**
 * "Missing from your library" — books ReadMeABook knows about (Audible
 * catalog) that aren't in the linked library, each with a one-tap Request
 * button. Renders NOTHING unless RMAB is configured; the screens embedding it
 * (series/author/search) stay RMAB-free otherwise.
 *
 * `fetchMissing` is screen-specific and returns MISSING candidates: sources
 * that know library membership pre-diff themselves (series/author screens
 * diff Audible catalog books against the library locally and return books
 * with no `isAvailable` field). This component additionally drops any row
 * explicitly flagged `isAvailable: true` (RMAB search enrichment) — rows
 * without the flag are trusted as missing, so don't rely on the filter to
 * do the diffing. Request-button state lives here.
 */
export default function RmabMissingSection({
  title = "Missing from your library",
  fetchMissing,
  maxItems = 10,
  requiresFullAuth = false,
}: {
  title?: string;
  fetchMissing: () => Promise<RmabBook[]>;
  maxItems?: number;
  /** Series/author endpoints reject static rmab_ API tokens (allowlist) —
   *  set for surfaces that need the JWT (login-token) mode. */
  requiresFullAuth?: boolean;
}) {
  const colors = useThemeColors();
  const configuredAny = useRmabStore((s) => s.configured);
  const authMode = useRmabStore((s) => s.authMode);
  const configured = configuredAny && (!requiresFullAuth || authMode === "jwt");
  const requestedAsins = useRmabStore((s) => s.requestedAsins);
  const requestBook = useRmabStore((s) => s.requestBook);

  const [books, setBooks] = useState<RmabBook[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<RmabBook | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    setLoading(true);
    // A changed fetchMissing means a NEW query/series/author — drop the
    // previous rows and notice so stale results never show while loading
    // (and the "Checking…" copy can render).
    setBooks(null);
    setNotice(null);
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
      // The request may resolve after navigation away.
      if (!aliveRef.current) return;
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
      {loading && (!books || books.length === 0) ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, paddingHorizontal: 20, marginBottom: 6 }}>
          Checking Audible for books you don't have…
        </Text>
      ) : null}
      {notice ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, paddingHorizontal: 20, marginBottom: 6 }}>
          {notice}
        </Text>
      ) : null}
      {shown.map((book) => {
        const status = requestedAsins[book.asin] || book.requestStatus;
        // RMAB-sourced rows (search) carry server-relative /api/cache/ cover
        // paths; resolve against the RMAB base URL. Absolute Audible URLs
        // (series/author rows) pass through untouched.
        const coverUri = resolveRmabUrl(book.coverArtUrl);
        return (
          <Pressable
            key={book.asin}
            onPress={() => setDetail(book)}
            accessibilityRole="button"
            accessibilityLabel={`Details for ${book.title}`}
            android_ripple={{ color: colors.primary + "14" }}
            style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 8 }}
          >
            <Image
              source={coverUri ? { uri: coverUri } : undefined}
              style={{ width: 46, height: 46, borderRadius: 6, backgroundColor: colors.surfaceContainerHigh }}
              contentFit="cover"
            />
            <View style={{ flex: 1, marginLeft: 12, marginRight: 8 }}>
              <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "500" }}>
                {book.title}
              </Text>
              {/* Series position leads (this list is usually a series gap),
                  then year, author, narrator. */}
              <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                {[
                  book.sequence ? `Book ${book.sequence}` : null,
                  book.releaseDate ? String(book.releaseDate).slice(0, 4) : null,
                  book.author,
                  book.narrator ? `read by ${book.narrator}` : null,
                ]
                  .filter(Boolean)
                  .join(" • ")}
              </Text>
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
                // Requests are deliberately SERIALIZED: everything disables
                // while one is in flight (the notice line reports per-request
                // outcomes), the active row keeps full opacity to show its
                // spinner, and the rest dim.
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
          </Pressable>
        );
      })}

      <RmabBookDetailSheet
        book={detail}
        onClose={() => setDetail(null)}
        onRequest={(b) => onRequest(b)}
        requested={!!(detail && (requestedAsins[detail.asin] || detail.requestStatus))}
        requesting={!!(detail && requesting === detail.asin)}
      />
    </View>
  );
}
