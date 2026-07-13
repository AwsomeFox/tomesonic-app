import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import * as Clipboard from "expo-clipboard";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import HintPressable from "../components/HintPressable";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { RowBase, Divider, SectionHeader } from "../components/SettingsRows";
import StatusChip from "../components/StatusChip";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { getOpenFeeds, closeFeed } from "../utils/abs/feeds";
import { absErrorToErrorStateProps, absErrorToActionMessage } from "../utils/abs/errors";
import type { AbsFeed } from "../utils/abs/types";

/**
 * AdminFeedsScreen — manage-side list of all OPEN RSS feeds on the server
 * (admin-and-up: every feed route is admin-gated server-side).
 *
 * Route: "AdminFeeds" (no params)
 *
 * Scope: list + copy link + close (destructive confirm). OPENING a feed is NOT
 * offered anywhere in the app yet — feeds are opened from the Audiobookshelf
 * web dashboard (in-app opening from item/series/collection surfaces is
 * tracked in a follow-up issue). Copy in this screen must not promise an
 * in-app open flow.
 *
 * Feeds are PUBLIC unauthenticated URLs — the banner up top says so, and the
 * close confirm spells out what closing does to listeners.
 */

// Map a normalized AbsError to full-screen ErrorState props via the shared
// engine — including the mapper's SEMANTIC icon (offline → cloud-off, etc.),
// spread at the call site for cross-screen consistency. auth/server keep this
// screen's historical generic title.
function describeLoadError(e: any) {
  return absErrorToErrorStateProps(e, {
    subject: "feeds",
    overrides: {
      offline: { message: "Reconnect to manage RSS feeds." },
      forbidden: { message: "Only server admins can manage RSS feeds." },
      unsupported: {
        title: "Not available on this server",
        message: "This server doesn't offer RSS feed management (it may need an update).",
      },
      auth: { title: "Couldn't load feeds" },
      server: { title: "Couldn't load feeds" },
    },
  });
}

const actionErrorMessage = (e: any) =>
  absErrorToActionMessage(e, { forbidden: "Only server admins can manage RSS feeds." });

// Feed entityType → human chip label.
function entityLabel(entityType?: string): string {
  switch (entityType) {
    case "libraryItem":
    case "item":
      return "Item";
    case "series":
      return "Series";
    case "collection":
      return "Collection";
    default:
      return entityType || "Feed";
  }
}

function feedTitle(feed: AbsFeed): string {
  return feed?.meta?.title || feed.slug || feed.id;
}

export default function AdminFeedsScreen({ navigation }: any) {
  const colors = useThemeColors();

  const [feeds, setFeeds] = useState<AbsFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  const [retryTick, setRetryTick] = useState(0);
  // Feed id currently being closed (dims its row, guards double-taps).
  const [closingId, setClosingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getOpenFeeds();
        if (cancelled) return;
        setFeeds(data);
      } catch (e) {
        if (cancelled) return;
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [retryTick]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setFeeds(await getOpenFeeds());
      setError(null);
    } catch (e) {
      showSnackbar({ message: actionErrorMessage(e) });
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopy = (feed: AbsFeed) => {
    if (!feed.feedUrl) return;
    Clipboard.setStringAsync(feed.feedUrl).catch(() => {});
    showSnackbar({ message: "Link copied" });
  };

  const doClose = async (feed: AbsFeed) => {
    setClosingId(feed.id);
    try {
      await closeFeed(feed.id);
      setFeeds((prev) => prev.filter((f) => f.id !== feed.id));
      showSnackbar({ message: "Feed closed" });
    } catch (e) {
      showAppDialog({ title: "Couldn't close feed", message: actionErrorMessage(e) });
    } finally {
      setClosingId(null);
    }
  };

  const confirmClose = (feed: AbsFeed) => {
    showAppDialog({
      title: "Close feed?",
      message: `Close the feed for "${feedTitle(feed)}"? Anyone with the link will lose access, and podcast apps will stop updating.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Close feed", style: "destructive", onPress: () => doClose(feed) },
      ],
    });
  };

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
        <HintPressable
          onPress={() => navigation.goBack()}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </HintPressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
          RSS feeds
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          {...describeLoadError(error)}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />
          }
        >
          {/* Public-access warning — mandatory copy, see ux-plan ship-cautions. */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginHorizontal: 16,
              marginTop: 16,
              padding: 12,
              borderRadius: 12,
              backgroundColor: colors.secondaryContainer,
            }}
          >
            <Icon name="info" size={18} color={colors.onSecondaryContainer} style={{ marginRight: 10 }} />
            <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, flex: 1 }}>
              Open feeds are public — anyone with the link can stream these files without signing
              in.
            </Text>
          </View>

          {feeds.length === 0 ? (
            <EmptyState
              icon="rss"
              title="No open feeds"
              message="Feeds opened from the Audiobookshelf web dashboard appear here, where you can copy their links or close them."
            />
          ) : (
            <>
              <SectionHeader label={`Open feeds (${feeds.length})`} colors={colors} />
              {feeds.map((feed, index) => (
                <View key={feed.id} style={{ opacity: closingId === feed.id ? 0.5 : 1 }}>
                  {index > 0 ? <Divider colors={colors} /> : null}
                  <RowBase
                    icon="rss"
                    title={feedTitle(feed)}
                    subtitle={feed.feedUrl}
                    colors={colors}
                    trailing={
                      <View style={{ flexDirection: "row", alignItems: "center" }}>
                        <StatusChip label={entityLabel(feed.entityType)} tone="neutral" />
                        <HintPressable
                          onPress={() => handleCopy(feed)}
                          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginLeft: 4 }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Copy feed link for ${feedTitle(feed)}`}
                          android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
                        >
                          <Icon name="copy" size={22} color={colors.onSurface} />
                        </HintPressable>
                        <HintPressable
                          onPress={() => confirmClose(feed)}
                          disabled={closingId === feed.id}
                          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Close feed ${feedTitle(feed)}`}
                          android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
                        >
                          <Icon name="close" size={22} color={colors.error} />
                        </HintPressable>
                      </View>
                    }
                  />
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
