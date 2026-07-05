import type { ImageSource } from "expo-image";

// expo-image keys its disk cache by URI — and our cover/author image URLs
// embed `?token=`, which ROTATES on every auth refresh. Every rotation
// therefore invalidated the entire image cache; worse, waking the phone often
// resumes the app before Wi-Fi is back up, so the re-fetches fail and covers
// render blank until something re-mounts them. Deriving a cacheKey from the
// URL WITHOUT the token keeps the cache stable across rotations: anything
// seen once paints from disk instantly, offline or mid-refresh.
export function coverSource(uri?: string | null): ImageSource | undefined {
  if (!uri) return undefined;
  if (!uri.startsWith("http")) return { uri }; // local file — the file IS the cache
  const cacheKey = uri.replace(/([?&])token=[^&]*&?/, "$1").replace(/[?&]$/, "");
  return { uri, cacheKey };
}
