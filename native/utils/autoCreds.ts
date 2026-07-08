import * as FileSystem from "expo-file-system/legacy";

// Mirrors the server address + token into the app's files dir so the native
// Android Auto browse service (a Media3 MediaLibraryService) can fetch the
// library without a JS bridge. Native reads `filesDir/auto_creds.json`, which is
// exactly where `documentDirectory` points.
const CREDS_PATH = `${FileSystem.documentDirectory}auto_creds.json`;

// Mirrors the downloaded books (metadata + local file layout + resume time)
// so the native Android Auto browse service can (a) badge downloaded books
// with the native download icon and (b) browse AND play them fully OFFLINE
// from local files when there's no network.
const DOWNLOADS_PATH = `${FileSystem.documentDirectory}auto_downloads.json`;

export interface AutoDownloadEntry {
  id: string;
  title: string;
  author?: string;
  /** Absolute folder holding the downloaded files (file:// or plain path). */
  folder?: string;
  /** Local cover file path, if downloaded. */
  coverPath?: string;
  /** Last known absolute book position (seconds) for cold-start offline resume. */
  currentTime?: number;
  duration?: number;
  tracks?: { filename: string; startOffset: number; duration: number }[];
}

// Mirrors the current/last book for the home-screen "Resume" widget. Native
// `ResumeWidgetProvider` reads `filesDir/widget_state.json`, and the Media3
// service's onPlaybackResumption uses `itemId` to natively restart the last
// book from Android Auto's resume card with JS asleep.
const WIDGET_STATE_PATH = `${FileSystem.documentDirectory}widget_state.json`;

export async function writeWidgetState(
  // episodeId is REQUIRED for podcasts: the native media3 onPlaybackResumption
  // path (AA resume card / BT / headset resume) reads it back so a podcast
  // resumes the right episode (/play/{episode}) instead of the item as a whole.
  state: { title?: string; author?: string; itemId?: string; episodeId?: string } | null
) {
  try {
    if (state && state.title) {
      await atomicWrite(WIDGET_STATE_PATH, JSON.stringify(state));
    } else {
      await FileSystem.deleteAsync(WIDGET_STATE_PATH, { idempotent: true });
      // Also drop any stale temp: the native readers fall back to .tmp when
      // the main file is missing (mid-swap recovery), and a leftover temp
      // from an interrupted write would resurrect the cleared state.
      await FileSystem.deleteAsync(`${WIDGET_STATE_PATH}.tmp`, { idempotent: true }).catch(() => {});
    }
  } catch (e) {
    console.warn("[Widget] state write failed", e);
  }
}

export async function writeAutoDownloads(entries: AutoDownloadEntry[]) {
  try {
    await atomicWrite(DOWNLOADS_PATH, JSON.stringify(entries || []));
  } catch (e) {
    console.warn("[AutoCreds] downloads write failed", e);
  }
}

// Temp-then-rename write. These files are read by the NATIVE Android Auto
// service on its own schedule (auto_downloads on every uncached browse,
// widget_state on resumption) while JS rewrites them — auto_downloads every
// ~15s during downloaded-book playback. A plain truncate-and-write hands a
// concurrent native reader a torn file; the rename swap means it only ever
// sees the previous or the new complete content.
async function atomicWrite(path: string, payload: string) {
  const tmpPath = `${path}.tmp`;
  await FileSystem.writeAsStringAsync(tmpPath, payload);
  try {
    // moveAsync rejects when the destination exists — clear it first so the
    // swap is a rename in every case.
    await FileSystem.deleteAsync(path, { idempotent: true });
    await FileSystem.moveAsync({ from: tmpPath, to: path });
  } catch (mvErr) {
    // Rename mechanism failed (unexpected) — last resort direct write.
    console.warn("[AutoCreds] atomic write failed; direct write", mvErr);
    await FileSystem.writeAsStringAsync(path, payload);
    await FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
  }
}

export interface AutoCreds {
  server: string;
  token: string;
  refreshToken?: string | null;
  libraryId?: string | null;
}

// Reads the creds file back. The native Android Auto service refreshes the
// access token itself while JS is backgrounded, and ABS ROTATES refresh tokens
// on every /auth/refresh (the previous one dies ~60s later) — so after a drive
// this file can hold the ONLY valid token pair. Callers (api.ts 401 handler,
// useUserStore.initialize) use it to recover the freshest pair instead of
// forcing a logout with a stale one.
export async function readAutoCreds(): Promise<AutoCreds | null> {
  const parseFile = async (path: string): Promise<AutoCreds | null> => {
    try {
      const raw = await FileSystem.readAsStringAsync(path);
      const creds = JSON.parse(raw);
      if (!creds?.server || !creds?.token) return null;
      return creds as AutoCreds;
    } catch {
      return null;
    }
  };
  try {
    const info = await FileSystem.getInfoAsync(CREDS_PATH);
    if (info.exists) {
      const main = await parseFile(CREDS_PATH);
      if (main) return main;
    }
    // Crash-window recovery: the atomic write (see writeAutoCreds) deletes the
    // destination before renaming the temp into place, and its last-resort
    // fallback is a direct write. So the main file can be MISSING (kill
    // between delete and rename) or CORRUPT (kill mid direct-write) — in both
    // cases the fully-written temp, created before any of that, still holds a
    // complete pair. Read it and promote it rather than dropping the only
    // valid rotated pair.
    const tmpPath = `${CREDS_PATH}.tmp`;
    const tmpInfo = await FileSystem.getInfoAsync(tmpPath);
    if (!tmpInfo.exists) return null;
    const recovered = await parseFile(tmpPath);
    if (!recovered) return null;
    try {
      await FileSystem.deleteAsync(CREDS_PATH, { idempotent: true });
      await FileSystem.moveAsync({ from: tmpPath, to: CREDS_PATH });
    } catch {
      // Promotion is best-effort — the recovered pair is already in hand.
    }
    return recovered;
  } catch (e) {
    return null;
  }
}

export async function writeAutoCreds(
  address?: string | null,
  token?: string | null,
  libraryId?: string | null,
  refreshToken?: string | null,
  // TRUE only when the caller's token pair is known-fresh (just logged in /
  // just refreshed). Mirror-only writes (e.g. a library switch) must NOT
  // trust their pair: ABS ROTATES refresh tokens, and the NATIVE Android Auto
  // service may have rotated while JS slept — this file can hold the ONLY
  // valid pair, and clobbering it with the secure store's stale copy killed
  // the exact recovery path this file exists for (dead refresh → forced
  // logout after a long drive).
  trustTokens = false,
) {
  try {
    if (address && token) {
      const server = address.replace(/\/$/, "");
      const existing = await readAutoCreds();
      const sameServer = existing?.server === server;

      const creds: any = { server, token };
      if (
        !trustTokens &&
        sameServer &&
        existing?.refreshToken &&
        existing.refreshToken !== refreshToken
      ) {
        // The file holds a (possibly natively-rotated) pair this caller
        // doesn't know about — keep the whole pair, only update metadata.
        creds.token = existing!.token;
        creds.refreshToken = existing!.refreshToken;
      } else if (refreshToken) {
        // Lets the native Android Auto service refresh the access token itself
        // when it 401s (e.g. app backgrounded for hours while driving).
        creds.refreshToken = refreshToken;
      } else if (sameServer && existing?.refreshToken) {
        // Never DROP an existing refresh token just because a caller didn't
        // pass one.
        creds.refreshToken = existing.refreshToken;
      }

      if (libraryId) {
        creds.libraryId = libraryId;
      } else if (sameServer && existing?.libraryId) {
        // No library specified (e.g. a token-refresh rewrite from api.ts):
        // keep whatever library the file already has for this server so the
        // native browse service doesn't lose its selection on every refresh.
        creds.libraryId = existing.libraryId;
      }
      // Atomic write: this file can hold the ONLY valid (rotated) refresh-token
      // pair, and the native Android Auto service reads/writes it too. Write a
      // temp then move (rename) over the destination — moveAsync is an atomic
      // path swap on the same filesystem, so a concurrent reader (native or a
      // second JS write) never sees a half-written file, and a kill mid-write
      // leaves the previous complete file intact.
      const tmpPath = `${CREDS_PATH}.tmp`;
      const payload = JSON.stringify(creds);
      await FileSystem.writeAsStringAsync(tmpPath, payload);
      try {
        // moveAsync REJECTS when the destination already exists (the common
        // case), so clear it first — the move then just renames the
        // fully-written temp into place. A reader (native or JS) always sees
        // either the previous complete file or the new one, never a
        // half-written one; the sub-tick gap where neither exists is safe (a
        // missing file reads as "no creds" and self-heals on the next write)
        // and can't corrupt the token, unlike an interrupted in-place write.
        await FileSystem.deleteAsync(CREDS_PATH, { idempotent: true });
        await FileSystem.moveAsync({ from: tmpPath, to: CREDS_PATH });
      } catch (mvErr) {
        // The rename mechanism itself failed (rare) — last resort so the fresh
        // token still persists; then drop the temp.
        console.warn("[AutoCreds] atomic move failed; direct write", mvErr);
        await FileSystem.writeAsStringAsync(CREDS_PATH, payload);
        await FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
      }
    } else {
      await FileSystem.deleteAsync(CREDS_PATH, { idempotent: true });
    }
  } catch (e) {
    console.warn("[AutoCreds] write failed", e);
  }
}
