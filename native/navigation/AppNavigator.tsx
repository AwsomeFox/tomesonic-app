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
import LibraryScreen from "../screens/LibraryScreen";
import SeriesListScreen from "../screens/SeriesListScreen";
import SeriesDetailScreen from "../screens/SeriesDetailScreen";
import CollectionsPlaylistsScreen from "../screens/CollectionsPlaylistsScreen";
import AuthorsScreen from "../screens/AuthorsScreen";
import AuthorDetailScreen from "../screens/AuthorDetailScreen";
import CollectionDetailScreen from "../screens/CollectionDetailScreen";
import PlaylistDetailScreen from "../screens/PlaylistDetailScreen";
import SearchScreen from "../screens/SearchScreen";
import ItemDetailScreen from "../screens/ItemDetailScreen";
import SettingsScreen from "../screens/SettingsScreen";
import AccountScreen from "../screens/AccountScreen";
import LocalMediaScreen from "../screens/LocalMediaScreen";
import DownloadsScreen from "../screens/DownloadsScreen";
import StatsScreen from "../screens/StatsScreen";
import LogsScreen from "../screens/LogsScreen";
import LatestEpisodesScreen from "../screens/LatestEpisodesScreen";
import ListeningHistoryScreen from "../screens/ListeningHistoryScreen";
import ReaderScreen from "../screens/ReaderScreen";
import { usePlaybackStore } from "../store/usePlaybackStore";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TAB_ICONS: Record<string, IconName> = {
  Home: "home",
  Library: "library",
  Series: "series",
  Collections: "collections",
  Authors: "authors",
};

function TabNavigator() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
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
      <Tab.Screen name="Library" component={LibraryScreen} />
      <Tab.Screen name="Series" component={SeriesListScreen} />
      <Tab.Screen name="Collections" component={CollectionsPlaylistsScreen} />
      <Tab.Screen name="Authors" component={AuthorsScreen} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const user = useUserStore((state) => state.user);
  const colors = useThemeColors();

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
            const TAB_ROUTES = ["Home", "Library", "Series", "Collections", "Authors"];
            const isTab = TAB_ROUTES.includes(route.name) && !route.params?.showBack;
            usePlaybackStore.getState().setOnTabScreen(isTab);
          }
        }
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {user === null ? (
          // Connect/Login screen shown if session is unauthenticated
          <Stack.Screen name="Connect" component={ConnectScreen} />
        ) : (
          // Main app navigation stack
          <>
            <Stack.Screen name="MainTabs" component={TabNavigator} />
            <Stack.Screen 
              name="Library" 
              component={LibraryScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="ItemDetail" 
              component={ItemDetailScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="SeriesDetail" 
              component={SeriesDetailScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="AuthorDetail" 
              component={AuthorDetailScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="CollectionDetail" 
              component={CollectionDetailScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="PlaylistDetail" 
              component={PlaylistDetailScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="Search" 
              component={SearchScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="LatestEpisodes" 
              component={LatestEpisodesScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen
              name="Account"
              component={AccountScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen
              name="LocalMedia"
              component={LocalMediaScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="Downloads" 
              component={DownloadsScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen 
              name="Stats" 
              component={StatsScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen
              name="Logs"
              component={LogsScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen
              name="ListeningHistory"
              component={ListeningHistoryScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
            <Stack.Screen
              name="Reader"
              component={ReaderScreen}
              options={{
                animation: "slide_from_right",
              }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
