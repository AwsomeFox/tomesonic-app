import * as FileSystem from "expo-file-system/legacy";

// Mirrors the server address + token into the app's files dir so the native
// Android Auto browse service (a Media3 MediaLibraryService) can fetch the
// library without a JS bridge. Native reads `filesDir/auto_creds.json`, which is
// exactly where `documentDirectory` points.
const CREDS_PATH = `${FileSystem.documentDirectory}auto_creds.json`;

// Mirrors the set of downloaded library-item ids so the native Android Auto
// browse service can mark downloaded books with a "⤋" badge.
const DOWNLOADS_PATH = `${FileSystem.documentDirectory}auto_downloads.json`;

// Mirrors the current/last book for the home-screen "Resume" widget. Native
// `ResumeWidgetProvider` reads `filesDir/widget_state.json`.
const WIDGET_STATE_PATH = `${FileSystem.documentDirectory}widget_state.json`;

export async function writeWidgetState(state: { title?: string; author?: string } | null) {
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

export async function writeAutoDownloads(ids: string[]) {
  try {
    await FileSystem.writeAsStringAsync(DOWNLOADS_PATH, JSON.stringify(ids || []));
  } catch (e) {
    console.warn("[AutoCreds] downloads write failed", e);
  }
}

export async function writeAutoCreds(
  address?: string | null,
  token?: string | null,
  libraryId?: string | null,
  refreshToken?: string | null,
) {
  try {
    if (address && token) {
      const creds: any = { server: address.replace(/\/$/, ""), token };
      if (refreshToken) {
        // Lets the native Android Auto service refresh the access token itself
        // when it 401s (e.g. app backgrounded for hours while driving).
        creds.refreshToken = refreshToken;
      }
      if (libraryId) {
        creds.libraryId = libraryId;
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
