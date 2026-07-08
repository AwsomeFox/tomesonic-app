/**
 * Whether the Discover bottom tab should be present.
 *
 * - Fully (jwt) connected to ReadMeABook: always shown (discovery works).
 * - Not fully connected: shown by default so the tab can promote ReadMeABook
 *   with a "how to connect" screen, UNLESS the user turned that off
 *   (showDiscoverWhenDisconnected === false), which restores the old
 *   hidden-until-connected behavior.
 *
 * Kept in its own leaf module (no screen/store imports) so it can be unit-tested
 * without pulling in the whole navigator's module graph.
 */
export function shouldShowDiscover(
  rmabConnected: boolean,
  showDiscoverWhenDisconnected: boolean | undefined
): boolean {
  return rmabConnected || showDiscoverWhenDisconnected !== false;
}
