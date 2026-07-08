/**
 * AppNavigator Discover-tab gating. The tab is present when RMAB is fully
 * (jwt) connected OR when it's not connected but the user hasn't hidden the
 * pre-connect promo (showDiscoverWhenDisconnected !== false).
 */
// Import the pure gating helper from its leaf module — NOT from AppNavigator,
// whose full screen/store import graph would pollute shared module mocks (e.g.
// expo/fetch) and break unrelated suites like oauth.test.
import { shouldShowDiscover } from "../../navigation/discoverVisibility";

describe("shouldShowDiscover gating", () => {
  it("always shows when fully (jwt) connected, regardless of the setting", () => {
    expect(shouldShowDiscover(true, true)).toBe(true);
    expect(shouldShowDiscover(true, false)).toBe(true);
    expect(shouldShowDiscover(true, undefined)).toBe(true);
  });

  it("shows when NOT connected and the setting is on/default", () => {
    expect(shouldShowDiscover(false, true)).toBe(true);
    // Missing setting (older persisted blob) defaults to shown.
    expect(shouldShowDiscover(false, undefined)).toBe(true);
  });

  it("hides ONLY when not connected AND the setting is explicitly off", () => {
    expect(shouldShowDiscover(false, false)).toBe(false);
  });
});
