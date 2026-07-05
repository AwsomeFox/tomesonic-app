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
  state: { title?: string; author?: string; itemId?: string } | null
) {
  try {
    if (state && state.title) {
      await FileSystem.writeAsStringAsync(WIDGET_STATE_PATH, JSON.stringify(state));
    } else {
      await FileSystem.deleteAsync(WIDGET_STATE_PATH, { idempotent: true });
    }
  } catch (e) {
    console.warn("[Widget] state write failed", e);
  }
}

export async function writeAutoDownloads(entries: AutoDownloadEntry[]) {
  try {
    await FileSystem.writeAsStringAsync(DOWNLOADS_PATH, JSON.stringify(entries || []));
  } catch (e) {
    console.warn("[AutoCreds] downloads write failed", e);
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
  try {
    const info = await FileSystem.getInfoAsync(CREDS_PATH);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(CREDS_PATH);
    const creds = JSON.parse(raw);
    if (!creds?.server || !creds?.token) return null;
    return creds as AutoCreds;
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
      await FileSystem.writeAsStringAsync(
        CREDS_PATH,
        JSON.stringify(creds)
      );
    } else {
      await FileSystem.deleteAsync(CREDS_PATH, { idempotent: true });
    }
  } catch (e) {
    console.warn("[AutoCreds] write failed", e);
  }
}
