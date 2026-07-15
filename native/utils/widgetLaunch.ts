import { navigationRef } from "../navigation/navigationRef";

// The home-row widget opens a book by launching the app with a
// tomesonic://item/<id> (or audiobookshelf://item/<id>) deep link. This parses
// that URL back to the library-item id. Returns null for anything else (the app
// is launched with all sorts of intents). Exported for unit testing.
export function parseItemDeepLink(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/^(?:tomesonic|audiobookshelf):\/\/item\/([^/?#]+)/i);
  if (!m) return null;
  try {
    const id = decodeURIComponent(m[1]);
    return id || null;
  } catch {
    return m[1] || null;
  }
}

// Navigate to a book's detail screen (NO auto-play — the user taps play there).
// Navigation may not be mounted yet on a cold launch, so retry briefly until the
// container is ready, then give up.
export function openItemById(itemId: string, attempt = 0): void {
  if (!itemId) return;
  if (navigationRef.isReady()) {
    (navigationRef.navigate as any)("ItemDetail", { itemId });
    return;
  }
  if (attempt >= 40) return; // ~6s of 150ms retries — well past cold-start nav mount.
  setTimeout(() => openItemById(itemId, attempt + 1), 150);
}

// Handle one inbound URL: if it's an item deep link, open that book.
export function handleWidgetUrl(url: string | null | undefined): boolean {
  const itemId = parseItemDeepLink(url);
  if (!itemId) return false;
  openItemById(itemId);
  return true;
}
