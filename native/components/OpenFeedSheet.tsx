import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, ActivityIndicator, Clipboard } from "react-native";
import BottomSheet from "./BottomSheet";
import Pressable from "./HintPressable";
import Icon from "./Icon";
import { RowBase } from "./SettingsRows";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { useUserStore } from "../store/useUserStore";
import { useServerCapabilities } from "../utils/abs/capabilities";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { openItemFeed, openSeriesFeed, openCollectionFeed } from "../utils/abs/feeds";
import { AbsError } from "../utils/abs/errors";
import type { AbsFeed } from "../utils/abs/types";

/**
 * Shared "Open RSS feed" flow for items, series, and collections. All three
 * feed-open routes are admin-only server-side, so the sheet renders nothing
 * for non-admins (the calling screens gate their trigger the same way — a
 * dead affordance is worse than a hidden one).
 *
 * The flow: prompt for a slug (defaulted from the title), warn that open feeds
 * are PUBLIC (banner + a confirm dialog before opening — same caution
 * AdminFeedsScreen carries), then POST to the right open route. On success the
 * resulting public feed URL renders with a Copy action; a slug collision (400)
 * gets its own copy, everything else surfaces the normalized AbsError message.
 */

export type OpenFeedKind = "item" | "series" | "collection";

export interface OpenFeedEntity {
  kind: OpenFeedKind;
  /** libraryItemId / seriesId / collectionId. */
  id: string;
  /** Display title — seeds the default slug and the confirm copy. */
  title: string;
}

/** "Wheel of Time!" → "wheel-of-time" — default slug for a new feed. */
export function slugifyFeedTitle(title: string): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function openFeedFor(
  kind: OpenFeedKind,
  id: string,
  params: { serverAddress: string; slug: string }
): Promise<AbsFeed> {
  if (kind === "series") return openSeriesFeed(id, params);
  if (kind === "collection") return openCollectionFeed(id, params);
  return openItemFeed(id, params);
}

export default function OpenFeedSheet({
  entity,
  onClose,
}: {
  entity: OpenFeedEntity | null;
  onClose: () => void;
}) {
  const colors = useThemeColors();
  const capabilities = useServerCapabilities();
  const serverAddress =
    useUserStore((s) => s.serverConnectionConfig?.address)?.replace(/\/$/, "") || "";

  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState<AbsFeed | null>(null);
  // Retain the entity being shown so the sheet content survives the exit
  // animation after the parent clears `entity` on close.
  const [shown, setShown] = useState<OpenFeedEntity | null>(entity);

  useEffect(() => {
    if (entity) {
      setShown(entity);
      setSlug(slugifyFeedTitle(entity.title));
      setFeed(null);
      setBusy(false);
    }
  }, [entity?.kind, entity?.id, entity?.title]);

  // Guard post-await setState against unmount mid-request (navigation away).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Feed routes are admin-only — never render the affordance otherwise.
  if (!capabilities.isAdmin) return null;

  const display = entity || shown;
  if (!display) return null;

  const feedUrl = feed?.feedUrl || (feed?.slug ? `${serverAddress}/feed/${feed.slug}` : "");

  const doOpen = async (s: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await openFeedFor(display.kind, display.id, { serverAddress, slug: s });
      if (!mountedRef.current) return;
      setFeed(result);
      showSnackbar({ message: "RSS feed opened" });
    } catch (e: any) {
      if (!mountedRef.current) return;
      // A 400 on these routes is (almost always) a slug collision — the slug
      // must be unique across every open feed. Give it dedicated copy; anything
      // else surfaces the normalized AbsError message (offline/forbidden/server).
      if (e instanceof AbsError && e.status === 400) {
        showAppDialog({
          title: "Couldn't open feed",
          message: "That address is already in use — pick a different one.",
        });
      } else {
        showAppDialog({
          title: "Couldn't open feed",
          message: e?.message || "Something went wrong. Please try again.",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleOpenPress = () => {
    const s = slug.trim();
    if (!s) {
      showAppDialog({ title: "Couldn't open feed", message: "Enter an address for the feed." });
      return;
    }
    if (!serverAddress) {
      showAppDialog({
        title: "Couldn't open feed",
        message: "No server session available. Reconnect and try again.",
      });
      return;
    }
    // Public-access confirm before anything is opened.
    showAppDialog({
      title: "Open a public RSS feed?",
      message: `The feed for "${display.title}" will be public — anyone with the link can stream these files without signing in.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Open feed", onPress: () => doOpen(s) },
      ],
    });
  };

  const handleCopy = () => {
    if (!feedUrl) return;
    Clipboard.setString(feedUrl);
    showSnackbar({ message: "Link copied" });
  };

  return (
    <BottomSheet visible={!!entity} onClose={onClose}>
      <View style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 12 }}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 18, fontWeight: "600", color: colors.onSurface }}
        >
          Open RSS feed
        </Text>
        <Text style={{ fontSize: 13, color: colors.onSurfaceVariant, marginTop: 2 }}>
          Publishes a podcast-style feed for "{display.title}".
        </Text>
      </View>

      {feed ? (
        <>
          <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
            <Text
              selectable
              accessibilityLabel={feedUrl ? `RSS feed URL: ${feedUrl}` : "RSS feed opened"}
              style={{ color: colors.onSurface, fontSize: 14 }}
            >
              {feedUrl || "Feed opened. Find its link in the server's RSS feeds."}
            </Text>
          </View>
          {feedUrl ? (
            <RowBase icon="copy" title="Copy link" colors={colors} onPress={handleCopy} />
          ) : null}
        </>
      ) : (
        <>
          <View style={{ paddingHorizontal: 24, paddingBottom: 4 }}>
            <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600" }}>Address</Text>
            <TextInput
              value={slug}
              onChangeText={setSlug}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="RSS feed address"
              style={{
                backgroundColor: colors.surfaceContainer,
                color: colors.onSurface,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 15,
                marginTop: 6,
              }}
            />
          </View>

          {/* Public-access warning — mirrors AdminFeedsScreen's banner copy. */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginHorizontal: 24,
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              backgroundColor: colors.secondaryContainer,
            }}
          >
            <Icon name="info" size={18} color={colors.onSecondaryContainer} style={{ marginRight: 10 }} />
            <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, flex: 1 }}>
              Open feeds are public — anyone with the link can stream these files without signing in.
            </Text>
          </View>

          <Pressable
            onPress={handleOpenPress}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Open RSS feed"
            accessibilityState={{ disabled: busy, busy }}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              marginHorizontal: 24,
              marginTop: 12,
              marginBottom: 16,
              height: 48,
              borderRadius: 24,
              overflow: "hidden",
              backgroundColor: colors.primary,
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700" }}>
                Open feed
              </Text>
            )}
          </Pressable>
        </>
      )}
    </BottomSheet>
  );
}
