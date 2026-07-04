import React, { useState, useEffect } from "react";
import { View, Text, Pressable, Modal, TextInput, BackHandler } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUiStore } from "../store/useUiStore";
import Icon from "./Icon";

interface TopAppBarProps {
  navigation: any;
  showFilter?: boolean;
  showSort?: boolean;
  showDownload?: boolean;
  showBack?: boolean;
  title?: string;
  onFilter?: () => void;
  onSort?: () => void;
  onDownload?: () => void;
}

/**
 * Top app bar used across the bookshelf tab screens, mirroring the original
 * tomesonic layout (Appbar.vue + reference screenshots 01/05): hamburger menu,
 * mint library-selector pill (stack icon + name), green cloud-check sync
 * indicator, and context-dependent action icons plus search. Surface background
 * with a hairline bottom divider; icons are on-surface, ~24dp.
 */
export default function TopAppBar({
  navigation,
  showFilter,
  showSort,
  showDownload,
  showBack,
  title,
  onFilter,
  onSort,
  onDownload,
}: TopAppBarProps) {
  const colors = useThemeColors();
  const [menuOpen, setMenuOpen] = useState(false);
  const openLibrarySelector = useUiStore((s) => s.openLibrarySelector);
  const { libraries, currentLibraryId } = useLibraryStore();

  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const setSearchActive = useUiStore((s) => s.setSearchActive);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const setSearchQuery = useUiStore((s) => s.setSearchQuery);

  const currentLibrary = libraries.find((l) => l.id === currentLibraryId);
  const libraryName = currentLibrary?.name || "Library";

  // Android hardware back closes the search overlay instead of popping the
  // screen (or exiting the app) — matches every native Android search UX.
  // Two guards, both load-bearing:
  //  - ONLY tab-level bars (`!showBack`): a PUSHED screen's bar must not
  //    register this, or backing out of a screen opened FROM a search result
  //    would close the underlying search instead of popping to the results.
  //  - ONLY while THIS screen is focused: BackHandler is PROCESS-GLOBAL and
  //    tab screens stay mounted under pushed screens — without the focus
  //    check, the Home bar's handler kept firing underneath AuthorDetail etc.,
  //    eating the first back press (closing the invisible search, blocking
  //    the pop) so back "did nothing" once and then skipped past the results.
  useEffect(() => {
    if (!isSearchActive || showBack) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (navigation?.isFocused && !navigation.isFocused()) return false;
      setSearchActive(false);
      setSearchQuery("");
      return true;
    });
    return () => sub.remove();
  }, [isSearchActive, showBack, navigation, setSearchActive, setSearchQuery]);

  // Same gate for the header itself: pushed screens keep their real back/title
  // header while a search is open underneath.
  if (isSearchActive && !showBack) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 8,
          height: 56,
          backgroundColor: colors.surface,
          borderBottomWidth: 1,
          borderBottomColor: withAlpha(colors.outlineVariant, 0.5),
        }}
      >
        <Pressable
          onPress={() => {
            setSearchActive(false);
            setSearchQuery("");
          }}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Close search"
          style={{ padding: 10, borderRadius: 24 }}
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>

        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: colors.surfaceContainerHighest || colors.surfaceVariant,
            borderRadius: 24,
            paddingHorizontal: 16,
            paddingVertical: 6,
            marginLeft: 4,
            marginRight: 8,
          }}
        >
          <Icon name="search" size={20} color={colors.onSurfaceVariant} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search library..."
            placeholderTextColor={colors.onSurfaceVariant}
            autoFocus
            returnKeyType="search"
            style={{
              flex: 1,
              color: colors.onSurface,
              fontSize: 16,
              padding: 0,
              marginLeft: 12,
            }}
          />
          {searchQuery.length > 0 ? (
            <Pressable
              onPress={() => setSearchQuery("")}
              hitSlop={8}
              android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 18 }}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              style={{ padding: 2 }}
            >
              <Icon name="close" size={18} color={colors.onSurfaceVariant} />
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 8,
        height: 56,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: withAlpha(colors.outlineVariant, 0.5),
      }}
    >
      {showBack ? (
        /* Back Button */
        <Pressable
          onPress={() => navigation?.goBack()}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ padding: 10, borderRadius: 24, marginRight: 4 }}
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
      ) : null}

      {showBack ? (
        /* Simple Title */
        title ? (
          <Text
            numberOfLines={1}
            style={{
              color: colors.onSurface,
              fontSize: 18,
              fontWeight: "600",
              marginLeft: 8,
              flex: 1,
            }}
          >
            {title}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )
      ) : (
        /* Library selector pill (filled mint secondary-container) + sync check */
        <>
          <Pressable
            onPress={openLibrarySelector}
            android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.12) }}
            accessibilityRole="button"
            accessibilityLabel={`Switch library. Current library: ${libraryName}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: colors.secondaryContainer,
              borderRadius: 20,
              overflow: "hidden",
              paddingHorizontal: 16,
              paddingVertical: 8,
              marginLeft: 4,
            }}
          >
            <Icon name="library" size={20} color={colors.onSecondaryContainer} />
            <Text
              numberOfLines={1}
              style={{
                color: colors.onSecondaryContainer,
                fontSize: 16,
                fontWeight: "600",
                marginLeft: 10,
                maxWidth: 150,
              }}
            >
              {libraryName}
            </Text>
          </Pressable>

          {/* Decorative sync indicator — hidden from screen readers. */}
          <View
            style={{ marginLeft: 10 }}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            <Icon name="cloud" size={22} color={colors.primary} />
          </View>
          
          <View style={{ flex: 1 }} />
        </>
      )}

      {/* Download (series/item detail) */}
      {showDownload ? (
        <Pressable
          onPress={onDownload}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Download"
          style={{ padding: 10 }}
        >
          <Icon name="download" size={24} color={colors.onSurface} />
        </Pressable>
      ) : null}

      {/* Filter */}
      {showFilter ? (
        <Pressable
          onPress={onFilter}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Filter"
          style={{ padding: 10 }}
        >
          <Icon name="filter" size={24} color={colors.onSurface} />
        </Pressable>
      ) : null}

      {/* Sort */}
      {showSort ? (
        <Pressable
          onPress={onSort}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Sort"
          style={{ padding: 10 }}
        >
          <Icon name="sort" size={24} color={colors.onSurface} />
        </Pressable>
      ) : null}

      {/* Search */}
      {!showBack && (
        <Pressable
          onPress={() => setSearchActive(true)}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Search"
          style={{ padding: 10 }}
        >
          <Icon name="search" size={24} color={colors.onSurface} />
        </Pressable>
      )}

      {/* User profile dropdown shortcut */}
      <Pressable
        onPress={() => setMenuOpen(true)}
        hitSlop={8}
        android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 20 }}
        accessibilityRole="button"
        accessibilityLabel="Account menu"
        style={{
          padding: 8,
          borderRadius: 20,
          backgroundColor: colors.surfaceContainerHighest,
          marginLeft: 6,
        }}
      >
        <Icon name="person" size={20} color={colors.onSurface} />
      </Pressable>

      {/* Profile Dropdown Modal */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable style={{ flex: 1 }} onPress={() => setMenuOpen(false)}>
          <View
            style={{
              position: "absolute",
              top: 56,
              right: 12,
              backgroundColor: colors.surfaceContainerHigh,
              borderRadius: 16,
              elevation: 8,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.15,
              shadowRadius: 8,
              paddingVertical: 8,
              minWidth: 160,
              borderWidth: 1,
              borderColor: colors.outlineVariant,
            }}
          >
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                navigation?.navigate("Account");
              }}
              android_ripple={{ color: colors.surfaceContainerHighest }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              <Icon name="account" size={20} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text style={{ color: colors.onSurface, fontSize: 16 }}>
                Account
              </Text>
            </Pressable>

            <Pressable
              onPress={() => {
                setMenuOpen(false);
                navigation?.navigate("Settings");
              }}
              android_ripple={{ color: colors.surfaceContainerHighest }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              <Icon name="settings" size={20} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text style={{ color: colors.onSurface, fontSize: 16 }}>
                Settings
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
