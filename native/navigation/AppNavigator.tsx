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

// Import Screens
import ConnectScreen from "../screens/ConnectScreen";
import BookshelfScreen from "../screens/BookshelfScreen";
import LibraryHubScreen from "../screens/LibraryHubScreen";
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
import { useRmabStore } from "../store/useRmabStore";
import ReaderScreen from "../screens/ReaderScreen";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useUiStore } from "../store/useUiStore";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TAB_ICONS: Record<string, IconName> = {
  Home: "home",
  Library: "library",
  Discover: "explore",
};

function TabNavigator() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  // BookDate needs a JWT (login-token) RMAB session — API tokens can't hit
  // its endpoints, so the tab only exists for full-access connections.
  const showDiscover = useRmabStore((s) => s.configured && s.authMode === "jwt");

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
              name={TAB_ICONS[route.name] || "home"}
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
          height: 64 + insets.bottom,
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
      {/* Consolidated Library hub — Books/Series/Collections/Authors live behind
          one destination with a segmented control (M3 ≤5 destinations). */}
      <Tab.Screen name="Library" component={LibraryHubScreen} />
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
            const TAB_ROUTES = ["Home", "Library", "Discover"];
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
            <Stack.Screen name="Reader" component={ReaderScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
