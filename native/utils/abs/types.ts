/**
 * Shared types for the ABS server-admin API surface (utils/abs/*).
 *
 * These mirror the JSON the Audiobookshelf server actually returns — every
 * shape here was verified against the ABS v2.35.1 server source
 * (server/routers/ApiRouter.js + controllers) rather than guessed from the
 * docs. Fields the app doesn't consume are typed loosely (index signatures)
 * so a server-side addition never breaks parsing.
 */

/** A TaskManager task (GET /api/tasks → { tasks }). */
export interface AbsTask {
  id: string;
  /** e.g. "library-scan", "encode-m4b", "embed-metadata", "download-podcast-episode" */
  action: string;
  /** Action-specific payload (libraryId, libraryItemId, ...). */
  data: any;
  title: string;
  description?: string;
  /** Error message when the task failed, otherwise null/undefined. */
  error: string | null;
  isFailed: boolean;
  isFinished: boolean;
  startedAt: number;
  finishedAt: number | null;
  [key: string]: any;
}

export type AbsUserType = "root" | "admin" | "user" | "guest";

export interface AbsUserPermissions {
  download: boolean;
  update: boolean;
  delete: boolean;
  upload: boolean;
  accessAllLibraries: boolean;
  accessAllTags: boolean;
  /**
   * Inverts the itemTagsSelected list from an allow-list into a block-list.
   * There's no in-app UI to flip this; the user detail editor echoes it back
   * unchanged so a server-configured block-list survives an unrelated edit.
   */
  selectedTagsNotAccessible?: boolean;
  accessExplicitContent: boolean;
  /** Added in newer servers — absent on older ones. */
  createEreader?: boolean;
  [key: string]: any;
}

/** A user as returned by GET /api/users (toOldJSONForBrowser). */
export interface AbsUser {
  id: string;
  username: string;
  type: AbsUserType;
  isActive: boolean;
  lastSeen: number | null;
  createdAt: number;
  permissions: AbsUserPermissions;
  librariesAccessible: string[];
  itemTagsSelected: string[];
  [key: string]: any;
}

/**
 * Create/update payload for POST /api/users and PATCH /api/users/:id.
 * The server accepts librariesAccessible/itemTagsSelected either top-level
 * (old model) or inside permissions (new model) — we send them top-level.
 */
export interface AbsUserPayload {
  username?: string;
  password?: string;
  email?: string | null;
  type?: AbsUserType;
  isActive?: boolean;
  permissions?: Partial<AbsUserPermissions>;
  librariesAccessible?: string[];
  itemTagsSelected?: string[];
  [key: string]: any;
}

/** A backup row from GET /api/backups → { backups }. */
export interface AbsBackup {
  id: string;
  backupMetadataCovers: boolean;
  backupDirPath: string;
  datePretty: string;
  fullPath: string;
  path: string;
  filename: string;
  fileSize: number;
  createdAt: number;
  serverVersion: string;
  [key: string]: any;
}

/** A media chapter (POST /api/items/:id/chapters payload item). */
export interface AbsChapter {
  id: number;
  start: number;
  end: number;
  title: string;
}

/** An e-reader device (email settings / /api/authorize ereaderDevices). */
export interface AbsEreaderDevice {
  name: string;
  email: string;
  availabilityOption?: "adminAndUp" | "userAndUp" | "guestAndUp" | "specificUsers";
  /** User ids — only meaningful when availabilityOption === "specificUsers". */
  users?: string[];
  [key: string]: any;
}

/** GET /api/emails/settings → { settings }. */
export interface AbsEmailSettings {
  id?: string;
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  fromAddress: string | null;
  testAddress: string | null;
  ereaderDevices: AbsEreaderDevice[];
  [key: string]: any;
}

/** An open RSS feed (GET /api/feeds → { feeds }). */
export interface AbsFeed {
  id: string;
  slug: string;
  userId: string;
  entityType: string;
  entityId: string;
  feedUrl: string;
  coverPath?: string | null;
  serverAddress?: string;
  [key: string]: any;
}

/** GET /api/api-keys → { apiKeys } row. `apiKey` (the token) is present ONLY in the create response. */
export interface AbsApiKey {
  id: string;
  name: string;
  expiresAt: string | null;
  createdAt: string;
  isActive: boolean;
  userId: string;
  createdByUserId?: string | null;
  user?: { id: string; username: string; type: AbsUserType };
  /** Only returned once, from POST /api/api-keys. */
  apiKey?: string;
  [key: string]: any;
}

/** A playback/listening session row (GET /api/sessions, listening-sessions). */
export interface AbsListeningSession {
  id: string;
  userId: string;
  libraryId?: string;
  libraryItemId: string;
  episodeId?: string | null;
  mediaType?: string;
  displayTitle: string;
  displayAuthor?: string;
  duration: number;
  playMethod?: number;
  mediaPlayer?: string;
  deviceInfo?: any;
  serverVersion?: string;
  date?: string;
  dayOfWeek?: string;
  timeListening: number;
  startTime: number;
  currentTime: number;
  startedAt: number;
  updatedAt: number;
  /** Present on GET /api/sessions rows (admin listing joins the user). */
  user?: { id: string; username: string };
  [key: string]: any;
}

/**
 * A subset of ABS LibrarySettings the admin library editor exposes. The server
 * carries more keys than this (metadata precedence, scan cron, mark-finished
 * thresholds, …); an editor MUST merge its edits onto the loaded settings and
 * send the whole object back, never a bare partial, or unexposed keys are lost.
 */
export interface AbsLibrarySettings {
  /** 0 = Standard (book) cover, 1 = Square. */
  coverAspectRatio?: number;
  audiobooksOnly?: boolean;
  hideSingleBookSeries?: boolean;
  onlyShowLaterBooksInContinueSeries?: boolean;
  disableWatcher?: boolean;
  skipMatchingMediaWithAsin?: boolean;
  skipMatchingMediaWithIsbn?: boolean;
  [key: string]: any;
}

/** A library as returned by GET /api/libraries / GET /api/libraries/:id. */
export interface AbsLibrary {
  id: string;
  name: string;
  mediaType: "book" | "podcast";
  provider?: string;
  /** ABS icon key (see components/LibraryIcon ABS_ICON_MAP), e.g. "books-1". */
  icon?: string;
  folders?: Array<{ id?: string; fullPath: string }>;
  settings?: AbsLibrarySettings;
  [key: string]: any;
}

/** GET /api/libraries/:id/stats. */
export interface AbsLibraryStats {
  totalItems: number;
  totalAuthors?: number;
  totalGenres?: number;
  totalDuration?: number;
  totalSize?: number;
  numAudioTracks?: number;
  largestItems?: any[];
  longestItems?: any[];
  authorsWithCount?: any[];
  genresWithCount?: any[];
  [key: string]: any;
}

/**
 * A media-item share (POST /api/share/mediaitem → toJSONForClient).
 * NOTE: mediaItemId is the MEDIA id (book.id / podcastEpisode.id), NOT the
 * libraryItemId — verified against ShareController.createMediaItemShare.
 */
export interface AbsShareLink {
  id: string;
  slug: string;
  expiresAt: string | number | null;
  mediaItemId: string;
  mediaItemType: "book" | "podcastEpisode";
  userId?: string;
  isDownloadable?: boolean;
  [key: string]: any;
}

/**
 * One Apprise event notification (GET /api/notifications → settings.notifications[]).
 * NOTE: unlike most shapes in this file, the notification surface is verified
 * at DOCS level (openapi spec + web client behavior), not against the server
 * source — see utils/abs/notifications.ts.
 */
export interface AbsNotification {
  id: string;
  libraryId?: string | null;
  /** e.g. "onPodcastEpisodeDownloaded", "onBackupCompleted", "onTest". */
  eventName: string;
  /** Apprise destination URLs. */
  urls: string[];
  titleTemplate?: string;
  bodyTemplate?: string;
  enabled: boolean;
  type?: string;
  lastFiredAt?: number | null;
  lastAttemptFailed?: boolean;
  numConsecutiveFailedAttempts?: number;
  createdAt?: number;
  [key: string]: any;
}

/** GET /api/notifications → { settings } (the server's notification settings). */
export interface AbsNotificationSettings {
  id?: string;
  appriseType?: string;
  appriseApiUrl: string | null;
  notifications: AbsNotification[];
  maxFailedAttempts?: number;
  maxNotificationQueue?: number;
  notificationDelay?: number;
  [key: string]: any;
}

/**
 * A provider podcast-search hit (GET /api/search/podcast). NOTE: like the
 * notification shapes, the podcast surface is verified at ISSUE-TEXT +
 * web-client-behavior level, not against the server source — see
 * utils/abs/podcasts.ts. Everything is optional/loose on purpose.
 */
export interface AbsPodcastSearchResult {
  id?: string | number;
  title?: string;
  artistName?: string;
  cover?: string;
  artworkUrl?: string;
  feedUrl?: string;
  trackCount?: number;
  genres?: string[];
  [key: string]: any;
}

/** One episode inside a parsed podcast feed (POST /api/podcasts/feed). */
export interface AbsPodcastFeedEpisode {
  title?: string;
  subtitle?: string;
  description?: string;
  pubDate?: string;
  publishedAt?: number;
  enclosure?: { url?: string; type?: string; length?: string | number; [key: string]: any };
  guid?: string;
  episode?: string | number;
  season?: string | number;
  [key: string]: any;
}

/** A parsed podcast feed (POST /api/podcasts/feed → { podcast }). */
export interface AbsPodcastFeed {
  metadata?: any;
  episodes?: AbsPodcastFeedEpisode[];
  [key: string]: any;
}

/** An episode-download-queue row (GET /api/podcasts/:id/downloads). */
export interface AbsEpisodeDownload {
  id?: string;
  episodeDisplayTitle?: string;
  podcastId?: string;
  libraryItemId?: string;
  [key: string]: any;
}

/** A feed entry parsed out of an OPML file (POST /api/podcasts/opml/parse → { feeds }). */
export interface AbsOpmlFeed {
  title?: string;
  feedUrl?: string;
  [key: string]: any;
}

/**
 * POST /api/podcasts create payload. The media.metadata NESTING is one of the
 * podcast module's weakest pins (web-client-mirrored, not server-verified) —
 * see utils/abs/podcasts.ts.
 */
export interface AbsCreatePodcastPayload {
  path: string;
  folderId: string;
  libraryId: string;
  media: {
    metadata: any;
    autoDownloadEpisodes?: boolean;
    autoDownloadSchedule?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

/** A narrator row from GET /api/libraries/:id/narrators → { narrators }. */
export interface AbsNarrator {
  /** encodeURIComponent(base64(name)) — the :narratorId path param scheme. */
  id: string;
  name: string;
  numBooks: number;
}
