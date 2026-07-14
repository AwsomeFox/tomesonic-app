import React from "react";
import { NavigationContainer, DefaultTheme, DarkTheme } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { navigationRef } from "./navigationRef";
import { useUserStore } from "../store/useUserStore";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon, { IconName } from "../components/Icon";
import { TAB_BAR_HEIGHT } from "../utils/layoutConstants";

// Import Screens
import ConnectScreen from "../screens/ConnectScreen";
import BookshelfScreen from "../screens/BookshelfScreen";
import LibraryHubScreen from "../screens/LibraryHubScreen";
import CollectionsPlaylistsScreen from "../screens/CollectionsPlaylistsScreen";
import LibraryScreen from "../screens/LibraryScreen";
import SeriesDetailScreen from "../screens/SeriesDetailScreen";
import AuthorDetailScreen from "../screens/AuthorDetailScreen";
import CollectionDetailScreen from "../screens/CollectionDetailScreen";
import PlaylistDetailScreen from "../screens/PlaylistDetailScreen";
import ItemDetailScreen from "../screens/ItemDetailScreen";
import SettingsScreen from "../screens/SettingsScreen";
import AccountScreen from "../screens/AccountScreen";
import DownloadsScreen from "../screens/DownloadsScreen";
import StatsScreen from "../screens/StatsScreen";
import LogsScreen from "../screens/LogsScreen";
import LatestEpisodesScreen from "../screens/LatestEpisodesScreen";
import ListeningHistoryScreen from "../screens/ListeningHistoryScreen";
import RmabRequestsScreen from "../screens/RmabRequestsScreen";
import DiscoverScreen from "../screens/DiscoverScreen";
import GenreBrowseScreen from "../screens/GenreBrowseScreen";
import YearInReviewScreen from "../screens/YearInReviewScreen";
import PodcastSettingsScreen from "../screens/PodcastSettingsScreen";
import PodcastEpisodesScreen from "../screens/PodcastEpisodesScreen";
import PodcastDownloadQueueScreen from "../screens/PodcastDownloadQueueScreen";
import PodcastAddSearchScreen from "../screens/PodcastAddSearchScreen";
import PodcastFeedPreviewScreen from "../screens/PodcastFeedPreviewScreen";
import ServerAdminHubScreen from "../screens/ServerAdminHubScreen";
import AdminLibrariesScreen from "../screens/AdminLibrariesScreen";
import AdminLibraryEditScreen from "../screens/AdminLibraryEditScreen";
import AdminUsersScreen from "../screens/AdminUsersScreen";
import AdminUserDetailScreen from "../screens/AdminUserDetailScreen";
import AdminSessionsScreen from "../screens/AdminSessionsScreen";
import AdminBackupsScreen from "../screens/AdminBackupsScreen";
import AdminEmailScreen from "../screens/AdminEmailScreen";
import AdminServerLogsScreen from "../screens/AdminServerLogsScreen";
import AdminFeedsScreen from "../screens/AdminFeedsScreen";
import AdminNotificationsScreen from "../screens/AdminNotificationsScreen";
import AdminMaintenanceScreen from "../screens/AdminMaintenanceScreen";
import AdminServerSettingsScreen from "../screens/AdminServerSettingsScreen";
import AdminApiKeysScreen from "../screens/AdminApiKeysScreen";
import EditMetadataScreen from "../screens/EditMetadataScreen";
import ChapterEditorScreen from "../screens/ChapterEditorScreen";
import ItemHistoryScreen from "../screens/ItemHistoryScreen";
import LibraryStatsScreen from "../screens/LibraryStatsScreen";
import { useRmabStore } from "../store/useRmabStore";
import { useLibraryStore } from "../store/useLibraryStore";
import { libraryIconName } from "../components/LibraryIcon";
import ReaderScreen from "../screens/ReaderScreen";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useUiStore } from "../store/useUiStore";
import { shouldShowDiscover } from "./discoverVisibility";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

/**
 * Whether the Discover bottom tab should exist.
 *
 * - Fully connected (RMAB configured in jwt mode): always shown — BookDate +
 *   discovery shelves work.
 * - Not fully connected: shown by default so the tab can promote ReadMeABook
 *   with a "how to connect" screen, UNLESS the user turned that off
 *   (showDiscoverWhenDisconnected === false), which restores the old
 *   hidden-until-connected behavior.
 *
 * The pure gating helper lives in ./discoverVisibility (a leaf module) so it can
 * be unit-tested without importing this navigator's whole screen/store graph.
 */
export { shouldShowDiscover } from "./discoverVisibility";

const TAB_ICONS: Record<string, IconName> = {
  Home: "home",
  Library: "library",
  Collections: "collections",
  Discover: "explore",
};

function TabNavigator() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  // BookDate needs a JWT (login-token) RMAB session — API tokens can't hit its
  // endpoints, so the full discovery experience only works for full-access
  // connections. When NOT fully connected, the tab still shows by default (its
  // screen renders a "connect ReadMeABook" promo) unless the user hid it.
  const rmabConnected = useRmabStore((s) => s.configured && s.authMode === "jwt");
  const showDiscoverWhenDisconnected = useUserStore((s) => s.settings.showDiscoverWhenDisconnected);
  const showDiscover = shouldShowDiscover(rmabConnected, showDiscoverWhenDisconnected);
  // The Library tab wears the CURRENT library's server-assigned icon (parity
  // with the original app), falling back to the generic glyph.
  const currentLibraryIconName = useLibraryStore((s) => {
    const lib = s.libraries.find((l) => l.id === s.currentLibraryId);
    return lib ? libraryIconName(lib.icon, lib.mediaType) : ("library" as IconName);
  });

  return (
    <Tab.Navigator
      // Tapping any bottom tab while the search overlay is open closes the
      // search and shows that tab's real content — otherwise the (global)
      // overlay follows you to the next tab and it looks like the tabs are
      // dead while searching.
      screenListeners={{
        tabPress: () => {
          const ui = useUiStore.getState();
          if (ui.isSearchActive) {
            ui.setSearchActive(false);
            ui.setSearchQuery("");
          }
        },
      }}
      screenOptions={({ route }) => ({
        headerShown: false,
        // Stop off-screen tabs from rendering while another tab is focused
        // (react-native-screens). The Library hub keeps its Books list mounted,
        // and a playing book re-renders that list; without freezeOnBlur those
        // renders happen behind every other tab and steal frames from the
        // foreground screen's animations.
        freezeOnBlur: true,
        tabBarIcon: ({ focused }) => (
          // Material 3 active-indicator pill (w-16 h-8 = 64x32) per BookshelfNavBar.vue
          <View
            style={{
              width: 64,
              height: 32,
              borderRadius: 16,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: focused ? colors.secondaryContainer : "transparent",
            }}
          >
            <Icon
              name={route.name === "Library" ? currentLibraryIconName : TAB_ICONS[route.name] || "home"}
              size={22}
              color={focused ? colors.onSecondaryContainer : colors.onSurfaceVariant}
            />
          </View>
        ),
        tabBarActiveTintColor: colors.onSurface,
        tabBarInactiveTintColor: colors.onSurfaceVariant,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopWidth: 1,
          borderTopColor: withAlpha(colors.outlineVariant, 0.5),
          elevation: 0,
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingBottom: 8 + insets.bottom,
          paddingTop: 8,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: "500",
          marginTop: 2,
        },
      })}
    >
      <Tab.Screen name="Home" component={BookshelfScreen} />
      {/* Consolidated Library hub — Books/Series/Authors live behind one
          destination with a segmented control (M3 ≤5 destinations). */}
      <Tab.Screen name="Library" component={LibraryHubScreen} />
      {/* Collections + Playlists get their own destination (the screen renders
          standalone: its own Collections|Playlists sub-selector + create FAB). */}
      <Tab.Screen name="Collections" component={CollectionsPlaylistsScreen} />
      {showDiscover ? <Tab.Screen name="Discover" component={DiscoverScreen} /> : null}
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const user = useUserStore((state) => state.user);
  const isInitialized = useUserStore((state) => state.isInitialized);
  const colors = useThemeColors();

  // Until the user store has hydrated from MMKV, `user` is still its default
  // null — rendering the Connect screen here would flash the login UI for a
  // frame on every authenticated launch. Hold a neutral splash (the themed
  // surface, same as the native splash) until initialize() has run.
  if (!isInitialized) {
    return <View style={{ flex: 1, backgroundColor: colors.surface }} />;
  }

  const navTheme = {
    ...(colors.isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(colors.isDark ? DarkTheme : DefaultTheme).colors,
      background: colors.surface,
      card: colors.surfaceContainer,
      text: colors.onSurface,
      primary: colors.primary,
      border: colors.outlineVariant,
    },
  };

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navTheme}
      onStateChange={() => {
        if (navigationRef.isReady()) {
          const route: any = navigationRef.getCurrentRoute();
          if (route) {
            // The four browse facets now live inside the "Library" hub tab; the
            // pushed narrator/tag/genre "Library" list (route.params.showBack)
            // still counts as a non-tab screen via the guard below.
            const TAB_ROUTES = ["Home", "Library", "Collections", "Discover"];
            const isTab = TAB_ROUTES.includes(route.name) && !route.params?.showBack;
            usePlaybackStore.getState().setOnTabScreen(isTab);
          }
        }
      }}
    >
      {/* Every pushed screen slides in from the right; MainTabs/Connect are
          roots so the default has no visible effect on them. */}
      <Stack.Navigator screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
        {user === null ? (
          // Connect/Login screen shown if session is unauthenticated
          <Stack.Screen name="Connect" component={ConnectScreen} />
        ) : (
          // Main app navigation stack
          <>
            <Stack.Screen name="MainTabs" component={TabNavigator} />
            <Stack.Screen name="Library" component={LibraryScreen} />
            <Stack.Screen name="ItemDetail" component={ItemDetailScreen} />
            <Stack.Screen name="SeriesDetail" component={SeriesDetailScreen} />
            <Stack.Screen name="AuthorDetail" component={AuthorDetailScreen} />
            <Stack.Screen name="CollectionDetail" component={CollectionDetailScreen} />
            <Stack.Screen name="PlaylistDetail" component={PlaylistDetailScreen} />
            <Stack.Screen name="LatestEpisodes" component={LatestEpisodesScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="Account" component={AccountScreen} />
            <Stack.Screen name="Downloads" component={DownloadsScreen} />
            <Stack.Screen name="Stats" component={StatsScreen} />
            <Stack.Screen name="Logs" component={LogsScreen} />
            <Stack.Screen name="ListeningHistory" component={ListeningHistoryScreen} />
            <Stack.Screen name="RmabRequests" component={RmabRequestsScreen} />
            <Stack.Screen name="GenreBrowse" component={GenreBrowseScreen} />
            <Stack.Screen name="YearInReview" component={YearInReviewScreen} />
            <Stack.Screen name="PodcastSettings" component={PodcastSettingsScreen} />
            <Stack.Screen name="Reader" component={ReaderScreen} />
            {/* Server administration (entry gated in SettingsScreen). Each
                screen surfaces a fetch-time 403 as a "forbidden" ErrorState
                rather than pre-gating; only the hub, AdminUserDetail, and
                AdminApiKeys consult useServerCapabilities directly. Route
                names are the frozen §3 contract of the admin-features
                architecture plan. */}
            <Stack.Screen name="ServerAdmin" component={ServerAdminHubScreen} />
            <Stack.Screen name="AdminLibraries" component={AdminLibrariesScreen} />
            <Stack.Screen name="AdminLibraryEdit" component={AdminLibraryEditScreen} />
            <Stack.Screen name="AdminUsers" component={AdminUsersScreen} />
            <Stack.Screen name="AdminUserDetail" component={AdminUserDetailScreen} />
            <Stack.Screen name="AdminSessions" component={AdminSessionsScreen} />
            <Stack.Screen name="AdminBackups" component={AdminBackupsScreen} />
            <Stack.Screen name="AdminEmail" component={AdminEmailScreen} />
            {/* "AdminServerLogs" is deliberately distinct from the app-log
                "Logs" route above. */}
            <Stack.Screen name="AdminServerLogs" component={AdminServerLogsScreen} />
            <Stack.Screen name="AdminFeeds" component={AdminFeedsScreen} />
            <Stack.Screen name="AdminNotifications" component={AdminNotificationsScreen} />
            <Stack.Screen name="AdminMaintenance" component={AdminMaintenanceScreen} />
            <Stack.Screen name="AdminServerSettings" component={AdminServerSettingsScreen} />
            <Stack.Screen name="AdminApiKeys" component={AdminApiKeysScreen} />
            {/* Podcast administration (issue #56): per-show feed browsing /
                server-side episode downloads + the download queue. */}
            <Stack.Screen name="PodcastEpisodes" component={PodcastEpisodesScreen} />
            <Stack.Screen name="PodcastDownloadQueue" component={PodcastDownloadQueueScreen} />
            {/* Find & add shows (iTunes search / RSS URL / OPML) and the RSS
                feed preview — the entry point is the ServerAdminHub Podcasts row. */}
            <Stack.Screen name="PodcastAddSearch" component={PodcastAddSearchScreen} />
            <Stack.Screen name="PodcastFeedPreview" component={PodcastFeedPreviewScreen} />
            {/* Item-scoped editors + non-admin extras from the same plan. */}
            <Stack.Screen name="EditMetadata" component={EditMetadataScreen} />
            <Stack.Screen name="ChapterEditor" component={ChapterEditorScreen} />
            <Stack.Screen name="ItemHistory" component={ItemHistoryScreen} />
            <Stack.Screen name="LibraryStats" component={LibraryStatsScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
