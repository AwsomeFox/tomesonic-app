import React, { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Pressable from "./HintPressable";

/**
 * Book description with clamp + "Show more" — shared by every detail sheet.
 *
 * Owns the lazy Audnexus fill: sources routinely carry TRUNCATED blurbs
 * (BookDate recs, RMAB's category cache) and the unauthenticated Audible
 * catalog never returns summaries at all, so when an ASIN is available and
 * the provided text is missing or short, the full summary is fetched and the
 * LONGER of the two wins.
 */
export default function BookDescription({
  text,
  asin,
  onFetched,
}: {
  text?: string | null;
  asin?: string | null;
  /** Full fetched details (e.g. narrator backfill for the caller). */
  onFetched?: (details: any) => void;
}) {
  const colors = useThemeColors();
  const [fetched, setFetched] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setFetched(null);
    setExpanded(false);
    // Short text is the truncation tell — full summaries run long.
    if (!asin || (text && text.length >= 600)) return;
    // Effect-local cancellation: a slow response for the PREVIOUS asin must
    // not land on the book currently shown.
    let cancelled = false;
    const { audibleBookDetails } = require("../utils/audible");
    audibleBookDetails(asin)
      .then((d: any) => {
        if (cancelled || !aliveRef.current || !d) return;
        if (d.description) setFetched(d.description);
        onFetched?.(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asin]);

  const cleanText = text ? String(text).replace(/<[^>]+>/g, "").trim() : "";
  const best = fetched && fetched.length > cleanText.length ? fetched : cleanText;
  if (!best) return null;

  return (
    <>
      <Text
        // key forces a remount on toggle — Fabric doesn't reliably re-layout
        // when numberOfLines changes on a live Text node.
        key={expanded ? "desc-full" : "desc-clamped"}
        style={{ color: colors.onSurfaceVariant, fontSize: 14, lineHeight: 20, marginTop: 12 }}
        numberOfLines={expanded ? undefined : 6}
      >
        {best}
      </Text>
      {best.length > 240 ? (
        <Pressable
          onPress={() => setExpanded((e) => !e)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Show less" : "Show more"}
          style={{ alignSelf: "flex-start", paddingVertical: 6 }}
        >
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: "600" }}>
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}
