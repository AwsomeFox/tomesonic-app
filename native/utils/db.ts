import { createMMKV } from "react-native-mmkv";

// Database storage simulating the native PaperDB storage namespace structure
export const dbStorage = createMMKV({
  id: "tomesonic-db",
});

// Keys namespace prefixes
const PREFIX_DEVICE = "device_";
const PREFIX_LOCAL_LIBRARY_ITEMS = "localLibraryItems_";
const PREFIX_LOCAL_FOLDERS = "localFolders_";
const PREFIX_LOCAL_MEDIA_PROGRESS = "localMediaProgress_";
const PREFIX_DOWNLOADS = "downloads_";
const PREFIX_LOGS = "logs_";

export const db = {
  // --- Device Data ---
  getDeviceData: () => {
    const data = dbStorage.getString(`${PREFIX_DEVICE}data`);
    return data ? JSON.parse(data) : {
      serverConnectionConfigs: [],
      lastServerConnectionConfigId: null,
      currentLocalPlaybackSession: null,
      deviceSettings: {}
    };
  },
  
  saveDeviceData: (deviceData: any) => {
    dbStorage.set(`${PREFIX_DEVICE}data`, JSON.stringify(deviceData));
  },

  // --- Local Library Items ---
  getLocalLibraryItems: (mediaType?: string) => {
    const keys = dbStorage.getAllKeys().filter(k => k.startsWith(PREFIX_LOCAL_LIBRARY_ITEMS));
    const items: any[] = [];
    keys.forEach(key => {
      const val = dbStorage.getString(key);
      if (val) {
        const parsed = JSON.parse(val);
        if (!mediaType || parsed.mediaType === mediaType) {
          items.push(parsed);
        }
      }
    });
    return items;
  },

  getLocalLibraryItem: (id: string) => {
    const data = dbStorage.getString(`${PREFIX_LOCAL_LIBRARY_ITEMS}${id}`);
    return data ? JSON.parse(data) : null;
  },

  getLocalLibraryItemByLId: (libraryItemId: string) => {
    const items = db.getLocalLibraryItems();
    return items.find(it => it.libraryItemId === libraryItemId) || null;
  },

  saveLocalLibraryItem: (item: any) => {
    if (!item?.id) return;
    dbStorage.set(`${PREFIX_LOCAL_LIBRARY_ITEMS}${item.id}`, JSON.stringify(item));
  },

  removeLocalLibraryItem: (id: string) => {
    dbStorage.remove(`${PREFIX_LOCAL_LIBRARY_ITEMS}${id}`);
  },

  // --- Local Folders ---
  getAllLocalFolders: () => {
    const keys = dbStorage.getAllKeys().filter(k => k.startsWith(PREFIX_LOCAL_FOLDERS));
    const folders: any[] = [];
    keys.forEach(key => {
      const val = dbStorage.getString(key);
      if (val) {
        folders.push(JSON.parse(val));
      }
    });
    return folders;
  },

  getLocalFolder: (id: string) => {
    const data = dbStorage.getString(`${PREFIX_LOCAL_FOLDERS}${id}`);
    return data ? JSON.parse(data) : null;
  },

  saveLocalFolder: (folder: any) => {
    if (!folder?.id) return;
    dbStorage.set(`${PREFIX_LOCAL_FOLDERS}${folder.id}`, JSON.stringify(folder));
  },

  removeLocalFolder: (id: string) => {
    dbStorage.remove(`${PREFIX_LOCAL_FOLDERS}${id}`);
  },

  // --- Local Media Progress ---
  getAllLocalMediaProgress: () => {
    const keys = dbStorage.getAllKeys().filter(k => k.startsWith(PREFIX_LOCAL_MEDIA_PROGRESS));
    const progressList: any[] = [];
    keys.forEach(key => {
      const val = dbStorage.getString(key);
      if (val) {
        progressList.push(JSON.parse(val));
      }
    });
    return progressList;
  },

  getLocalMediaProgress: (id: string) => {
    const data = dbStorage.getString(`${PREFIX_LOCAL_MEDIA_PROGRESS}${id}`);
    return data ? JSON.parse(data) : null;
  },

  saveLocalMediaProgress: (progress: any) => {
    if (!progress?.id) return;
    dbStorage.set(`${PREFIX_LOCAL_MEDIA_PROGRESS}${progress.id}`, JSON.stringify(progress));
  },

  removeLocalMediaProgress: (id: string) => {
    dbStorage.remove(`${PREFIX_LOCAL_MEDIA_PROGRESS}${id}`);
  },

  // --- Downloads ---
  getAllDownloads: () => {
    const keys = dbStorage.getAllKeys().filter(k => k.startsWith(PREFIX_DOWNLOADS));
    const downloads: any[] = [];
    keys.forEach(key => {
      const val = dbStorage.getString(key);
      if (!val) return;
      // A single corrupt record must not crash the whole downloads restore
      // (this runs on app start) — drop it instead.
      try {
        downloads.push(JSON.parse(val));
      } catch (e) {
        console.warn("[db] Dropping corrupt download record", key, e);
        dbStorage.remove(key);
      }
    });
    return downloads;
  },

  saveDownloadItem: (item: any) => {
    if (!item?.id) return;
    dbStorage.set(`${PREFIX_DOWNLOADS}${item.id}`, JSON.stringify(item));
  },

  removeDownloadItem: (id: string) => {
    dbStorage.remove(`${PREFIX_DOWNLOADS}${id}`);
  },

  // --- Logs ---
  getLogs: () => {
    const keys = dbStorage.getAllKeys().filter(k => k.startsWith(PREFIX_LOGS));
    const logs: any[] = [];
    keys.forEach(key => {
      const val = dbStorage.getString(key);
      if (val) {
        logs.push(JSON.parse(val));
      }
    });
    return logs.sort((a, b) => a.timestamp - b.timestamp);
  },

  saveLog: (log: any) => {
    const id = log.id || `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    dbStorage.set(`${PREFIX_LOGS}${id}`, JSON.stringify({ ...log, id }));
  },

  cleanLogs: (hoursToKeep = 24) => {
    const keys = dbStorage.getAllKeys().filter(k => k.startsWith(PREFIX_LOGS));
    const limit = Date.now() - hoursToKeep * 60 * 60 * 1000;
    
    keys.forEach(key => {
      const val = dbStorage.getString(key);
      if (val) {
        const parsed = JSON.parse(val);
        if (parsed.timestamp && parsed.timestamp < limit) {
          dbStorage.remove(key);
        }
      }
    });
  }
};
