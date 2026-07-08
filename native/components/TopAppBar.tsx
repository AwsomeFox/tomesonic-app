import React, { useState, useEffect } from "react";
import { View, Text, Modal, TextInput, BackHandler } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUiStore } from "../store/useUiStore";
import Icon from "./Icon";
import Pressable from "./HintPressable";
import { useRmabStore } from "../store/useRmabStore";
import { useDownloadStore } from "../store/useDownloadStore";

interface TopAppBarProps {
  navigation: any;
  showFilter?: boolean;
  /** Badge the filter icon (a dot) when a non-default filter/sort is applied —
   *  a persisted filter is otherwise invisible after a restart. */
  filterActive?: boolean;
  showSort?: boolean;
  showDownload?: boolean;
  showBack?: boolean;
  /** Hide the search action (e.g. offline Bookshelf — the overlay only
   *  searches the server, so offering it there was a dead end). */
  hideSearch?: boolean;
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
  filterActive,
  showSort,
  showDownload,
  showBack,
  hideSearch,
  title,
  onFilter,
  onSort,
  onDownload,
}: TopAppBarProps) {
  const colors = useThemeColors();
  const [menuOpen, setMenuOpen] = useState(false);
  const rmabConfigured = useRmabStore((st) => st.configured);
  const pendingApprovals = useRmabStore((st) => st.pendingApprovalCount);
  const refreshPendingCount = useRmabStore((st) => st.refreshPendingCount);
  const openLibrarySelector = useUiStore((s) => s.openLibrarySelector);
  // Downloads has no home in the tab bar after the Round 11 nav split, so it's
  // surfaced from the account menu. Count in-flight downloads to badge the menu
  // (and the account icon) — an active download must stay reachable from here.
  const activeDownloadCount = useDownloadStore((s) => Object.keys(s.activeDownloads).length);
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
            accessibilityLabel="Search library"
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
          <Text maxFontSizeMultiplier={1.3}
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
            <Text maxFontSizeMultiplier={1.3}
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
          // Reflect the active state in the label too — the dot alone is
          // invisible to a screen reader.
          accessibilityLabel={filterActive ? "Filter, active" : "Filter"}
          style={{ padding: 10 }}
        >
          <Icon name="filter" size={24} color={colors.onSurface} />
          {filterActive ? (
            <View
              testID="filter-active-badge"
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                width: 9,
                height: 9,
                borderRadius: 5,
                backgroundColor: colors.primary,
                borderWidth: 1.5,
                borderColor: colors.surface,
              }}
            />
          ) : null}
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
      {!showBack && !hideSearch && (
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
        onPress={() => {
          refreshPendingCount();
          setMenuOpen(true);
        }}
        hitSlop={8}
        android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 20 }}
        accessibilityRole="button"
        accessibilityLabel={
          "Account menu" +
          (pendingApprovals > 0 ? `, ${pendingApprovals} requests awaiting approval` : "") +
          (activeDownloadCount > 0
            ? `, ${activeDownloadCount} ${activeDownloadCount === 1 ? "download" : "downloads"} in progress`
            : "")
        }
        style={{
          padding: 8,
          borderRadius: 20,
          backgroundColor: colors.surfaceContainerHighest,
          marginLeft: 6,
        }}
      >
        <Icon name="person" size={20} color={colors.onSurface} />
        {pendingApprovals > 0 ? (
          <View
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              minWidth: 18,
              height: 18,
              borderRadius: 9,
              paddingHorizontal: 4,
              backgroundColor: colors.error,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 2,
              borderColor: colors.surface,
            }}
          >
            <Text style={{ color: colors.onError, fontSize: 10, fontWeight: "700" }}>
              {pendingApprovals > 9 ? "9+" : pendingApprovals}
            </Text>
          </View>
        ) : null}
        {/* Active-download indicator — a small themed dot at the bottom-right so
            an in-progress download is visibly reachable via this menu even when
            no approvals badge is shown. Decorative (the count is in the button
            label above); kept out of the a11y tree. */}
        {activeDownloadCount > 0 ? (
          <View
            testID="account-download-indicator"
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            style={{
              position: "absolute",
              bottom: -1,
              right: -1,
              width: 11,
              height: 11,
              borderRadius: 6,
              backgroundColor: colors.primary,
              borderWidth: 2,
              borderColor: colors.surface,
            }}
          />
        ) : null}
      </Pressable>

      {/* Profile Dropdown Modal */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable
          style={{ flex: 1 }}
          onPress={() => setMenuOpen(false)}
          // Same treatment as the BottomSheet backdrop: keep tap-to-dismiss
          // but out of the screen-reader focus order — this was the FIRST
          // TalkBack focus in the menu, a nameless full-screen element.
          // (Unlike BottomSheet, the menu rows are CHILDREN of this Pressable,
          // so "no" — not "no-hide-descendants" — keeps them reachable.)
          importantForAccessibility="no"
          accessible={false}
        >
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
              accessibilityRole="button"
              accessibilityLabel="Account"
              android_ripple={{ color: colors.surfaceContainerHighest }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              <Icon name="account" size={20} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text maxFontSizeMultiplier={1.3} style={{ color: colors.onSurface, fontSize: 16 }}>
                Account
              </Text>
            </Pressable>

            {/* Downloads — its only home now that the tab bar dropped it. Badges
                with the in-flight count so an active download is reachable. */}
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                navigation?.navigate("Downloads");
              }}
              accessibilityRole="button"
              accessibilityLabel={
                activeDownloadCount > 0
                  ? `Downloads, ${activeDownloadCount} in progress`
                  : "Downloads"
              }
              android_ripple={{ color: colors.surfaceContainerHighest }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              <Icon name="download" size={20} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text maxFontSizeMultiplier={1.3} style={{ color: colors.onSurface, fontSize: 16 }}>
                Downloads
              </Text>
              {activeDownloadCount > 0 ? (
                <View
                  testID="downloads-active-badge"
                  style={{
                    marginLeft: 10,
                    minWidth: 20,
                    height: 20,
                    borderRadius: 10,
                    paddingHorizontal: 5,
                    backgroundColor: colors.primary,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: colors.onPrimary, fontSize: 11, fontWeight: "700" }}>
                    {activeDownloadCount > 9 ? "9+" : activeDownloadCount}
                  </Text>
                </View>
              ) : null}
            </Pressable>

            {rmabConfigured ? (
              <Pressable
                onPress={() => {
                  setMenuOpen(false);
                  navigation?.navigate("RmabRequests");
                }}
                android_ripple={{ color: colors.surfaceContainerHighest }}
                accessibilityRole="button"
                accessibilityLabel={
                  pendingApprovals > 0
                    ? `Requests, ${pendingApprovals} awaiting approval`
                    : "Requests"
                }
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                }}
              >
                <Icon name="send" size={20} color={colors.onSurface} style={{ marginRight: 12 }} />
                <Text maxFontSizeMultiplier={1.3} style={{ color: colors.onSurface, fontSize: 16 }}>
                  Requests
                </Text>
                {pendingApprovals > 0 ? (
                  <View
                    style={{
                      marginLeft: 10,
                      minWidth: 20,
                      height: 20,
                      borderRadius: 10,
                      paddingHorizontal: 5,
                      backgroundColor: colors.error,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: colors.onError, fontSize: 11, fontWeight: "700" }}>
                      {pendingApprovals > 9 ? "9+" : pendingApprovals}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            ) : null}

            <Pressable
              onPress={() => {
                setMenuOpen(false);
                navigation?.navigate("Settings");
              }}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              android_ripple={{ color: colors.surfaceContainerHighest }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              <Icon name="settings" size={20} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text maxFontSizeMultiplier={1.3} style={{ color: colors.onSurface, fontSize: 16 }}>
                Settings
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
