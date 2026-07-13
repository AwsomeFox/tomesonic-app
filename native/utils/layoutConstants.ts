// Shared layout constants for the persistent player/tab-bar chrome, so the
// several components that must line up against them (AppSnackbar floats above
// them, PlayerBottomSheet sizes its collapsed mini-player, AppNavigator sizes
// the tab bar) reference a single source of truth instead of re-declaring the
// same magic number with a "keep in sync" comment.

/** Collapsed mini-player height (PlayerBottomSheet's docked bar). */
export const MINIPLAYER_HEIGHT = 68;

/** Bottom tab bar content height, excluding the safe-area bottom inset. */
export const TAB_BAR_HEIGHT = 64;
