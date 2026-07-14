/**
 * Regression guard for issue #56: the podcast-admin screens were authored in
 * one commit while their routes were registered in another, and two of them
 * (PodcastAddSearch, PodcastFeedPreview) shipped UNREGISTERED — every
 * navigate() to them threw at runtime and the whole "add a podcast" flow was
 * dead. The navigator has no ParamList generic, so TypeScript couldn't catch
 * it, and per-screen tests render in isolation with a mocked navigation.
 *
 * This source-scan test closes that gap: every podcast route a screen navigates
 * to must have a matching <Stack.Screen name="..."> in AppNavigator.
 */
import { readFileSync } from "fs";
import { join } from "path";

const NATIVE_ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(NATIVE_ROOT, rel), "utf8");
}

describe("podcast route registration", () => {
  const navigatorSrc = read("navigation/AppNavigator.tsx");

  const registered = new Set(
    Array.from(navigatorSrc.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)).map((m) => m[1])
  );

  // The four podcast-admin routes must all be registered.
  it.each([
    "PodcastAddSearch",
    "PodcastFeedPreview",
    "PodcastEpisodes",
    "PodcastDownloadQueue",
  ])("registers the %s route", (route) => {
    expect(registered.has(route)).toBe(true);
  });

  // Every Podcast* route that any screen navigates to must be registered — this
  // catches a NEW podcast destination added without a Stack.Screen entry.
  it("every navigated Podcast* route is registered", () => {
    const screenFiles = [
      "screens/ServerAdminHubScreen.tsx",
      "screens/PodcastAddSearchScreen.tsx",
      "screens/PodcastFeedPreviewScreen.tsx",
      "screens/PodcastSettingsScreen.tsx",
      "screens/PodcastEpisodesScreen.tsx",
      "screens/PodcastDownloadQueueScreen.tsx",
    ];
    const navigated = new Set<string>();
    for (const f of screenFiles) {
      const src = read(f);
      for (const m of src.matchAll(/navigation\.navigate\(\s*"(Podcast[A-Za-z]+)"/g)) {
        navigated.add(m[1]);
      }
      // ServerAdminHub dispatches via a `route:` field on a row config object.
      for (const m of src.matchAll(/route:\s*"(Podcast[A-Za-z]+)"/g)) {
        navigated.add(m[1]);
      }
    }
    // Sanity: we actually found the entry-point route, so the scan isn't a no-op.
    expect(navigated.has("PodcastAddSearch")).toBe(true);

    const unregistered = Array.from(navigated).filter((r) => !registered.has(r));
    expect(unregistered).toEqual([]);
  });
});
