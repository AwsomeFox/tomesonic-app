package com.audiobookshelf.app.player

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.util.Log
import androidx.media.MediaBrowserServiceCompat
import androidx.media.utils.MediaConstants
import com.audiobookshelf.app.R
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.media.MediaManager
import com.audiobookshelf.app.media.*
import com.audiobookshelf.app.media.getUriToAbsIconDrawable
import com.audiobookshelf.app.media.getUriToDrawable
import com.audiobookshelf.app.plugins.AbsLogger
import kotlinx.coroutines.runBlocking

class MediaBrowserManager(
    private val service: PlayerNotificationService,
    private val mediaManager: MediaManager,
    private val networkConnectivityManager: NetworkConnectivityManager,
    private val ctx: Context
) {
    private val tag = "MediaBrowserManager"

    // Helper function to determine if a book should be browsable (has chapters)
    private fun shouldBookBeBrowsable(libraryItem: LibraryItem): Boolean {
        return libraryItem.mediaType == "book" &&
               (libraryItem.media as? Book)?.chapters?.isNotEmpty() == true
    }

    // Helper function for local library items
    private fun shouldLocalBookBeBrowsable(localLibraryItem: LocalLibraryItem): Boolean {
        return localLibraryItem.mediaType == "book" &&
               (localLibraryItem.media as? Book)?.chapters?.isNotEmpty() == true
    }

    // Helper function to format duration in seconds to readable format
    private fun formatTime(seconds: Long): String {
        val hours = seconds / 3600
        val minutes = (seconds % 3600) / 60
        val secs = seconds % 60

        return if (hours > 0) {
            String.format("%d:%02d:%02d", hours, minutes, secs)
        } else {
            String.format("%d:%02d", minutes, secs)
        }
    }

    // Constants
    companion object {
        const val AUTO_MEDIA_ROOT = "/"
        const val LIBRARIES_ROOT = "__LIBRARIES__"
        const val RECENTLY_ROOT = "__RECENTLY__"
        const val DOWNLOADS_ROOT = "__DOWNLOADS__"
        const val CONTINUE_ROOT = "__CONTINUE__"

        // Android Auto package names for MediaBrowser validation
        private const val ANDROID_AUTO_PKG_NAME = "com.google.android.projection.gearhead"
        private const val ANDROID_AUTO_SIMULATOR_PKG_NAME = "com.google.android.projection.gearhead.emulator"
        private const val ANDROID_WEARABLE_PKG_NAME = "com.google.android.wearable.app"
        private const val ANDROID_GSEARCH_PKG_NAME = "com.google.android.googlequicksearchbox"
        private const val ANDROID_AUTOMOTIVE_PKG_NAME = "com.google.android.projection.gearhead.phone"

        private val VALID_MEDIA_BROWSERS = setOf(
            "com.audiobookshelf.app",
            "com.audiobookshelf.app.debug",
            ANDROID_AUTO_PKG_NAME,
            ANDROID_AUTO_SIMULATOR_PKG_NAME,
            ANDROID_WEARABLE_PKG_NAME,
            ANDROID_GSEARCH_PKG_NAME,
            ANDROID_AUTOMOTIVE_PKG_NAME
        )
    }
    private var forceReloadingAndroidAuto: Boolean = false
    private var firstLoadDone: Boolean = false
    private var cachedSearch: String = ""
    private var cachedSearchResults: MutableList<MediaBrowserCompat.MediaItem> = mutableListOf()
    private lateinit var browseTree: BrowseTree

    // Only allowing android auto or similar to access media browser service
    //  normal loading of audiobooks is handled in webview (not natively)
    fun isValid(packageName: String, uid: Int): Boolean {
        Log.d(tag, "onGetRoot: Checking package $packageName with uid $uid")
        if (!VALID_MEDIA_BROWSERS.contains(packageName)) {
            Log.d(tag, "onGetRoot: package $packageName not valid for the media browser service")
            return false
        }
        return true
    }

    fun onGetRoot(
        clientPackageName: String,
        clientUid: Int,
        rootHints: Bundle?
    ): MediaBrowserServiceCompat.BrowserRoot? {
        // Verify that the specified package is allowed to access your content
        return if (!isValid(clientPackageName, clientUid)) {
            // No further calls will be made to other media browsing methods.
            null
        } else {
            AbsLogger.info(tag, "onGetRoot: clientPackageName: $clientPackageName, clientUid: $clientUid")
            PlayerNotificationService.isStarted = true

            // Reset cache if no longer connected to server or server changed
            if (mediaManager.checkResetServerItems()) {
                AbsLogger.info(tag, "onGetRoot: Reset Android Auto server items cache (${DeviceManager.serverConnectionConfigString})")
                forceReloadingAndroidAuto = true
                firstLoadDone = false // Reset firstLoadDone when server items are reset
                networkConnectivityManager.setFirstLoadDone(false) // Sync with NetworkConnectivityManager

                // Trigger refresh to ensure service is ready
                Handler(Looper.getMainLooper()).post {
                    AbsLogger.info(tag, "onGetRoot: Triggering Android Auto refresh after cache reset")
                    service.notifyChildrenChanged(AUTO_MEDIA_ROOT)
                }
            }

            service.isAndroidAuto = true

            val extras = Bundle()
            extras.putBoolean(MediaConstants.BROWSER_SERVICE_EXTRAS_KEY_SEARCH_SUPPORTED, true)
            extras.putInt(
                MediaConstants.DESCRIPTION_EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
                MediaConstants.DESCRIPTION_EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
            )
            extras.putInt(
                MediaConstants.DESCRIPTION_EXTRAS_KEY_CONTENT_STYLE_PLAYABLE,
                MediaConstants.DESCRIPTION_EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
            )

            MediaBrowserServiceCompat.BrowserRoot(AUTO_MEDIA_ROOT, extras)
        }
    }

    fun onLoadChildren(
        parentMediaId: String,
        result: MediaBrowserServiceCompat.Result<MutableList<MediaBrowserCompat.MediaItem>>
    ) {
        AbsLogger.info(tag, "onLoadChildren: parentMediaId: $parentMediaId (${DeviceManager.serverConnectionConfigString})")

        result.detach()

        // Prevent crashing if app is restarted while browsing
        if ((parentMediaId != DOWNLOADS_ROOT && parentMediaId != AUTO_MEDIA_ROOT) && !firstLoadDone) {
            result.sendResult(null)
            return
        }

        if (parentMediaId == DOWNLOADS_ROOT) { // Load downloads
            val localBooks = DeviceManager.dbManager.getLocalLibraryItems("book")
            val localPodcasts = DeviceManager.dbManager.getLocalLibraryItems("podcast")
            val localBrowseItems: MutableList<MediaBrowserCompat.MediaItem> = mutableListOf()

            localBooks.forEach { localLibraryItem ->
                if (localLibraryItem.media.getAudioTracks().isNotEmpty()) {
                    val progress = DeviceManager.dbManager.getLocalMediaProgress(localLibraryItem.id)
                    val description = localLibraryItem.getMediaDescription(progress, ctx)

                    // Make books with chapters browsable instead of playable
                    if (shouldLocalBookBeBrowsable(localLibraryItem)) {
                        localBrowseItems +=
                            MediaBrowserCompat.MediaItem(
                                description,
                                MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                            )
                    } else {
                        localBrowseItems +=
                            MediaBrowserCompat.MediaItem(
                                description,
                                MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                            )
                    }
                }
            }

            localPodcasts.forEach { localLibraryItem ->
                val mediaDescription = localLibraryItem.getMediaDescription(null, ctx)
                localBrowseItems +=
                    MediaBrowserCompat.MediaItem(
                        mediaDescription,
                        MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                    )
            }

            result.sendResult(localBrowseItems)
        } else if (parentMediaId == CONTINUE_ROOT) {
            val localBrowseItems: MutableList<MediaBrowserCompat.MediaItem> = mutableListOf()
            mediaManager.serverItemsInProgress.forEach { itemInProgress ->
                val progress: MediaProgressWrapper?
                val mediaDescription: MediaDescriptionCompat
                if (itemInProgress.episode != null) {
                    if (itemInProgress.isLocal) {
                        progress =
                            DeviceManager.dbManager.getLocalMediaProgress(
                                "${itemInProgress.libraryItemWrapper.id}-${itemInProgress.episode.id}"
                            )
                    } else {
                        progress =
                            mediaManager.serverUserMediaProgress.find {
                                it.libraryItemId == itemInProgress.libraryItemWrapper.id &&
                                        it.episodeId == itemInProgress.episode.id
                            }

                        // to show download icon
                        val localLibraryItem =
                            DeviceManager.dbManager.getLocalLibraryItemByLId(
                                itemInProgress.libraryItemWrapper.id
                            )
                        localLibraryItem?.let { lli ->
                            val localEpisode =
                                (lli.media as Podcast).episodes?.find {
                                    it.serverEpisodeId == itemInProgress.episode.id
                                }
                            itemInProgress.episode.localEpisodeId = localEpisode?.id
                        }
                    }
                    mediaDescription =
                        itemInProgress.episode.getMediaDescription(
                            itemInProgress.libraryItemWrapper,
                            progress,
                            ctx
                        )
                } else {
                    if (itemInProgress.isLocal) {
                        progress =
                            DeviceManager.dbManager.getLocalMediaProgress(
                                itemInProgress.libraryItemWrapper.id
                            )
                    } else {
                        progress =
                            mediaManager.serverUserMediaProgress.find {
                                it.libraryItemId == itemInProgress.libraryItemWrapper.id
                            }

                        val localLibraryItem =
                            DeviceManager.dbManager.getLocalLibraryItemByLId(
                                itemInProgress.libraryItemWrapper.id
                            )
                        (itemInProgress.libraryItemWrapper as LibraryItem).localLibraryItemId =
                            localLibraryItem?.id // To show downloaded icon
                    }
                    mediaDescription = itemInProgress.libraryItemWrapper.getMediaDescription(progress, ctx)
                }
                localBrowseItems +=
                    MediaBrowserCompat.MediaItem(
                        mediaDescription,
                        MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                    )
            }
            result.sendResult(localBrowseItems)
        } else if (parentMediaId == AUTO_MEDIA_ROOT) {
            Log.d(tag, "Trying to initialize browseTree.")
            if (!this::browseTree.isInitialized || forceReloadingAndroidAuto) {
                forceReloadingAndroidAuto = false
                AbsLogger.info(tag, "onLoadChildren: Loading Android Auto items")

                // Show loading indicator immediately
                val loadingItem = createLoadingMediaItem()
                result.sendResult(mutableListOf(loadingItem))

                mediaManager.loadAndroidAutoItems {
                    AbsLogger.info(tag, "onLoadChildren: Loaded Android Auto data (${mediaManager.serverLibraries.size} libraries), initializing browseTree")

                    // Check connection status
                    val isConnected = DeviceManager.isConnectedToServer
                    val hasConnectivity = DeviceManager.checkConnectivity(ctx)
                    AbsLogger.info(tag, "onLoadChildren: Connection status - Server: $isConnected, Network: $hasConnectivity")

                    // Check for existing session or resume from server when Android Auto starts
                    if (service.currentPlaybackSession == null) {
                        Log.d(tag, "Android Auto: No active session found, attempting to resume from last session")
                        networkConnectivityManager.resumeFromLastSessionForAndroidAuto()
                    } else {
                        Log.d(tag, "Android Auto: Active session found: ${service.currentPlaybackSession?.displayTitle}")
                    }

                    browseTree =
                        BrowseTree(
                            ctx,
                            mediaManager.serverItemsInProgress,
                            mediaManager.serverLibraries,
                            mediaManager.allLibraryPersonalizationsDone
                        )
                    val children =
                        browseTree[parentMediaId]?.map { item ->
                            Log.d(tag, "Found top menu item: ${item.description.title}")
                            MediaBrowserCompat.MediaItem(
                                item.description,
                                MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                            )
                        }?.toMutableList() ?: mutableListOf()

                    // If no server content but we have local books, add downloads option
                    if (children.isEmpty()) {
                        val localBooks = DeviceManager.dbManager.getLocalLibraryItems("book")
                        val localPodcasts = DeviceManager.dbManager.getLocalLibraryItems("podcast")
                        if (localBooks.isNotEmpty() || localPodcasts.isNotEmpty()) {
                            val downloadsDescription = MediaDescriptionCompat.Builder()
                                .setMediaId(DOWNLOADS_ROOT)
                                .setTitle("Downloaded Content")
                                .setSubtitle("${localBooks.size + localPodcasts.size} items")
                                .setIconUri(getUriToDrawable(ctx, R.drawable.icon_monochrome))
                                .build()

                            children.add(MediaBrowserCompat.MediaItem(
                                downloadsDescription,
                                MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                            ))
                        }
                    }

                    service.notifyChildrenChanged(AUTO_MEDIA_ROOT)
                    firstLoadDone = true
                    networkConnectivityManager.setFirstLoadDone(true) // Sync with NetworkConnectivityManager

                    if (mediaManager.serverLibraries.isNotEmpty()) {
                        AbsLogger.info(tag, "onLoadChildren: Android Auto fetching personalized data for all libraries")
                        mediaManager.populatePersonalizedDataForAllLibraries {
                            AbsLogger.info(tag, "onLoadChildren: Android Auto loaded personalized data for all libraries")
                            service.notifyChildrenChanged("/")
                        }

                        AbsLogger.info(tag, "onLoadChildren: Android Auto fetching in progress items")
                        mediaManager.initializeInProgressItems {
                            AbsLogger.info(tag, "onLoadChildren: Android Auto loaded in progress items")
                            service.notifyChildrenChanged("/")
                        }
                    }
                }
                return
            } else {
                Log.d(tag, "Starting browseTree refresh")
                browseTree =
                    BrowseTree(
                        service,
                        mediaManager.serverItemsInProgress,
                        mediaManager.serverLibraries,
                        mediaManager.allLibraryPersonalizationsDone
                    )
                val children =
                    browseTree[parentMediaId]?.map { item ->
                        Log.d(tag, "Found top menu item: ${item.description.title}")
                        MediaBrowserCompat.MediaItem(
                            item.description,
                            MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                        )
                    }?.toMutableList()

                AbsLogger.info(tag, "onLoadChildren: Android auto data loaded")
                result.sendResult(children)
            }
        } else if (parentMediaId == LIBRARIES_ROOT || parentMediaId == RECENTLY_ROOT) {
            Log.d(tag, "Loading $parentMediaId - First load done: $firstLoadDone")
            if (!firstLoadDone) {
                // Show loading indicator while waiting for initial load to complete
                val loadingItem = createLoadingMediaItem()
                result.sendResult(mutableListOf(loadingItem))

                // Start a background task to wait and retry
                Thread {
                    var waitedMs = 0
                    val waitInterval = 200L
                    val maxWait = 5000L // Increased to 5 seconds for better network handling

                    while (!firstLoadDone && waitedMs < maxWait) {
                        try {
                            Thread.sleep(waitInterval)
                        } catch (ie: InterruptedException) {
                            // ignore
                        }
                        waitedMs += waitInterval.toInt()
                    }

                    // Notify Android Auto to refresh the view
                    if (firstLoadDone && this::browseTree.isInitialized) {
                        service.notifyChildrenChanged(parentMediaId)
                    } else {
                        Log.w(tag, "Loading timeout for $parentMediaId after ${waitedMs}ms - firstLoadDone: $firstLoadDone, browseTree initialized: ${this::browseTree.isInitialized}")
                        // Still show empty result if loading fails completely
                        result.sendResult(mutableListOf())
                    }
                }.start()

                return
            }

            // Wait until top-menu (browseTree) is initialized with a bounded wait
            var waitedMs2 = 0
            val waitInterval2 = 200L
            val maxWait2 = 3000L // Increased timeout
            while (!this::browseTree.isInitialized && waitedMs2 < maxWait2) {
                try {
                    Thread.sleep(waitInterval2)
                } catch (ie: InterruptedException) {
                    // ignore
                }
                waitedMs2 += waitInterval2.toInt()
            }
            if (!this::browseTree.isInitialized) {
                result.sendResult(mutableListOf())
                return
            }

            val children =
                browseTree[parentMediaId]?.map { item ->
                    Log.d(tag, "[MENU: $parentMediaId] Showing list item ${item.description.title}")
                    MediaBrowserCompat.MediaItem(
                        item.description,
                        MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                    )
                }?.toMutableList() ?: mutableListOf()
            result.sendResult(children)
        } else if (mediaManager.getIsLibrary(parentMediaId)) { // Load library items for library
            Log.d(tag, "Loading items for library $parentMediaId")
            val selectedLibrary = mediaManager.getLibrary(parentMediaId)
            if (selectedLibrary?.mediaType == "podcast") { // Podcasts are browseable
                mediaManager.loadLibraryPodcasts(parentMediaId) { libraryItems ->
                    val children =
                        libraryItems?.map { libraryItem ->
                            val mediaDescription = libraryItem.getMediaDescription(null, ctx)
                            MediaBrowserCompat.MediaItem(
                                mediaDescription,
                                MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                            )
                        }?.toMutableList() ?: mutableListOf()
                    result.sendResult(children)
                }
            } else {
                val children =
                    mutableListOf(
                        MediaBrowserCompat.MediaItem(
                            MediaDescriptionCompat.Builder()
                                .setTitle("Authors")
                                .setMediaId("__LIBRARY__${parentMediaId}__AUTHORS")
                                .setIconUri(getUriToAbsIconDrawable(ctx, "authors"))
                                .build(),
                            MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                        ),
                        MediaBrowserCompat.MediaItem(
                            MediaDescriptionCompat.Builder()
                                .setTitle("Series")
                                .setMediaId("__LIBRARY__${parentMediaId}__SERIES_LIST")
                                .setIconUri(getUriToAbsIconDrawable(ctx, "columns"))
                                .build(),
                            MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                        ),
                        MediaBrowserCompat.MediaItem(
                            MediaDescriptionCompat.Builder()
                                .setTitle("Collections")
                                .setMediaId("__LIBRARY__${parentMediaId}__COLLECTIONS")
                                .setIconUri(
                                    getUriToDrawable(
                                        ctx,
                                        R.drawable.md_book_multiple_outline
                                    )
                                )
                                .build(),
                            MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                        )
                    )
                if (mediaManager.getHasDiscovery(parentMediaId)) {
                    children.add(
                        MediaBrowserCompat.MediaItem(
                            MediaDescriptionCompat.Builder()
                                .setTitle("Discovery")
                                .setMediaId("__LIBRARY__${parentMediaId}__DISCOVERY")
                                .setIconUri(getUriToDrawable(ctx, R.drawable.md_telescope))
                                .build(),
                            MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                        )
                    )
                }
                result.sendResult(children)
            }
        } else if (parentMediaId.startsWith(RECENTLY_ROOT)) {
            Log.d(tag, "Browsing recently $parentMediaId")
            val mediaIdParts = parentMediaId.split("__")
            if (!mediaManager.getIsLibrary(mediaIdParts[2])) {
                Log.d(tag, "${mediaIdParts[2]} is not library")
                result.sendResult(null)
                return
            }
            Log.d(tag, "Mediaparts: ${mediaIdParts.size} | $mediaIdParts")
            if (mediaIdParts.size == 3) {
                mediaManager.getLibraryRecentShelfs(mediaIdParts[2]) { availableShelfs ->
                    Log.d(tag, "Found ${availableShelfs.size} shelfs")
                    val children: MutableList<MediaBrowserCompat.MediaItem> = mutableListOf()
                    for (shelf in availableShelfs) {
                        if (shelf.type == "book") {
                            children.add(
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle("Books")
                                        .setMediaId("${parentMediaId}__BOOK")
                                        .setIconUri(
                                            getUriToDrawable(
                                                ctx,
                                                R.drawable.md_book_open_blank_variant_outline
                                            )
                                        )
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            )
                        } else if (shelf.type == "series") {
                            children.add(
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle("Series")
                                        .setMediaId("${parentMediaId}__SERIES")
                                        .setIconUri(getUriToAbsIconDrawable(ctx, "columns"))
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            )
                        } else if (shelf.type == "episode") {
                            children.add(
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle("Episodes")
                                        .setMediaId("${parentMediaId}__EPISODE")
                                        .setIconUri(getUriToAbsIconDrawable(ctx, "microphone_2"))
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            )
                        } else if (shelf.type == "podcast") {
                            children.add(
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle("Podcast")
                                        .setMediaId("${parentMediaId}__PODCAST")
                                        .setIconUri(getUriToAbsIconDrawable(ctx, "podcast"))
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            )
                        } else if (shelf.type == "authors") {
                            children.add(
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle("Authors")
                                        .setMediaId("${parentMediaId}__AUTHORS")
                                        .setIconUri(getUriToAbsIconDrawable(ctx, "authors"))
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            )
                        }
                    }
                    result.sendResult(children)
                }
            } else if (mediaIdParts.size == 4) {
                mediaManager.getLibraryRecentShelfByType(mediaIdParts[2], mediaIdParts[3]) { shelf ->
                    if (shelf === null) {
                        result.sendResult(mutableListOf())
                    } else {
                        if (shelf.type == "book") {
                            val children =
                                (shelf as LibraryShelfBookEntity).entities?.map { libraryItem ->
                                    val progress =
                                        mediaManager.serverUserMediaProgress.find {
                                            it.libraryItemId == libraryItem.id
                                        }
                                    val localLibraryItem =
                                        DeviceManager.dbManager.getLocalLibraryItemByLId(libraryItem.id)
                                    libraryItem.localLibraryItemId = localLibraryItem?.id
                                    val description =
                                        libraryItem.getMediaDescription(progress, ctx, null, false)

                                    // Make books with chapters browsable instead of playable
                                    if (shouldBookBeBrowsable(libraryItem)) {
                                        MediaBrowserCompat.MediaItem(
                                            description,
                                            MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                        )
                                    } else {
                                        MediaBrowserCompat.MediaItem(
                                            description,
                                            MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                                        )
                                    }
                                }?.toMutableList()
                            result.sendResult(children)
                        } else if (shelf.type == "episode") {
                            val episodesWithRecentEpisode =
                                (shelf as LibraryShelfEpisodeEntity).entities?.filter { libraryItem ->
                                    libraryItem.recentEpisode !== null
                                }
                            val children =
                                episodesWithRecentEpisode?.map { libraryItem ->
                                    val podcast = libraryItem.media as Podcast
                                    val progress =
                                        mediaManager.serverUserMediaProgress.find {
                                            it.libraryItemId == libraryItem.libraryId &&
                                                    it.episodeId == libraryItem.recentEpisode?.id
                                        }

                                    // to show download icon
                                    val localLibraryItem =
                                        DeviceManager.dbManager.getLocalLibraryItemByLId(
                                            libraryItem.recentEpisode!!.id
                                        )
                                    localLibraryItem?.let { lli ->
                                        val localEpisode =
                                            (lli.media as Podcast).episodes?.find {
                                                it.serverEpisodeId == libraryItem.recentEpisode.id
                                            }
                                        libraryItem.recentEpisode.localEpisodeId = localEpisode?.id
                                    }

                                    val description =
                                        libraryItem.recentEpisode.getMediaDescription(
                                            libraryItem,
                                            progress,
                                            ctx
                                        )
                                    MediaBrowserCompat.MediaItem(
                                        description,
                                        MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                                    )
                                }?.toMutableList()
                            result.sendResult(children)
                        } else if (shelf.type == "podcast") {
                            val children =
                                (shelf as LibraryShelfPodcastEntity).entities?.map { libraryItem ->
                                    val mediaDescription = libraryItem.getMediaDescription(null, ctx)
                                    MediaBrowserCompat.MediaItem(
                                        mediaDescription,
                                        MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                    )
                                }?.toMutableList()
                            result.sendResult(children)
                        } else if (shelf.type == "series") {
                            val children =
                                (shelf as LibraryShelfSeriesEntity).entities?.map { librarySeriesItem ->
                                    val description = librarySeriesItem.getMediaDescription(null, ctx)
                                    MediaBrowserCompat.MediaItem(
                                        description,
                                        MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                    )
                                }?.toMutableList()
                            result.sendResult(children)
                        } else if (shelf.type == "authors") {
                            val children =
                                (shelf as LibraryShelfAuthorEntity).entities?.map { authorItem ->
                                    val description = authorItem.getMediaDescription(null, ctx)
                                    MediaBrowserCompat.MediaItem(
                                        description,
                                        MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                    )
                                }?.toMutableList()
                            result.sendResult(children)
                        } else {
                            result.sendResult(mutableListOf())
                        }
                    }
                }
            }
        } else if (parentMediaId.startsWith("__LIBRARY__")) {
            Log.d(tag, "Browsing library $parentMediaId")
            val mediaIdParts = parentMediaId.split("__")
            /*
             MediaIdParts for Library
             1: LIBRARY
             2: mediaId for library
             3: Browsing style (AUTHORS, AUTHOR, AUTHOR_SERIES, SERIES_LIST, SERIES, COLLECTION, COLLECTIONS, DISCOVERY)
             4:
               - Paging: SERIES_LIST, AUTHORS
               - SeriesId: SERIES
               - AuthorId: AUTHOR, AUTHOR_SERIES
               - CollectionId: COLLECTIONS
             5: SeriesId: AUTHOR_SERIES
            */
            if (!mediaManager.getIsLibrary(mediaIdParts[2])) {
                Log.d(tag, "${mediaIdParts[2]} is not library")
                result.sendResult(null)
                return
            }
            Log.d(tag, "$mediaIdParts")
            if (mediaIdParts[3] == "SERIES_LIST" && mediaIdParts.size == 5) {
                Log.d(tag, "Loading series from library ${mediaIdParts[2]} with paging ${mediaIdParts[4]}")
                mediaManager.loadLibrarySeriesWithAudio(mediaIdParts[2], mediaIdParts[4]) { seriesItems ->
                    Log.d(tag, "Received ${seriesItems.size} series")

                    val seriesLetters =
                        seriesItems
                            .groupingBy { iwb ->
                                iwb.title.substring(0, mediaIdParts[4].length + 1).uppercase()
                            }
                            .eachCount()
                    if (seriesItems.size >
                        DeviceManager.deviceData.deviceSettings!!
                            .androidAutoBrowseLimitForGrouping &&
                        seriesItems.size > 1 &&
                        seriesLetters.size > 1
                    ) {
                        val children =
                            seriesLetters.map { (seriesLetter, seriesCount) ->
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle(seriesLetter)
                                        .setMediaId("${parentMediaId}${seriesLetter.last()}")
                                        .setSubtitle("$seriesCount series")
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            }?.toMutableList()
                        result.sendResult(children)
                    } else {
                        val children =
                            seriesItems.map { seriesItem ->
                                val description = seriesItem.getMediaDescription(null, ctx)
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            }
                        result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                    }
                }
            } else if (mediaIdParts[3] == "SERIES_LIST") {
                Log.d(tag, "Loading series from library ${mediaIdParts[2]}")
                mediaManager.loadLibrarySeriesWithAudio(mediaIdParts[2]) { seriesItems ->
                    Log.d(tag, "Received ${seriesItems.size} series")
                    if (seriesItems.size >
                        DeviceManager.deviceData.deviceSettings!!
                            .androidAutoBrowseLimitForGrouping && seriesItems.size > 1
                    ) {
                        val seriesLetters =
                            seriesItems.groupingBy { iwb -> iwb.title.first().uppercaseChar() }.eachCount()
                        val children =
                            seriesLetters.map { (seriesLetter, seriesCount) ->
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle(seriesLetter.toString())
                                        .setSubtitle("$seriesCount series")
                                        .setMediaId("${parentMediaId}__${seriesLetter}")
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            }
                        result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                    } else {
                        val children =
                            seriesItems.map { seriesItem ->
                                val description = seriesItem.getMediaDescription(null, ctx)
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            }
                        result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                    }
                }
            } else if (mediaIdParts[3] == "SERIES") {
                Log.d(tag, "Loading items for serie ${mediaIdParts[4]} from library ${mediaIdParts[2]}")
                mediaManager.loadLibrarySeriesItemsWithAudio(mediaIdParts[2], mediaIdParts[4]) {
                    libraryItems ->
                    Log.d(tag, "Received ${libraryItems.size} library items")
                    var items = libraryItems
                    if (DeviceManager.deviceData.deviceSettings!!.androidAutoBrowseSeriesSequenceOrder ===
                        AndroidAutoBrowseSeriesSequenceOrderSetting.DESC
                    ) {
                        items = libraryItems.reversed()
                    }
                    val children =
                        items.map { libraryItem ->
                            val progress =
                                mediaManager.serverUserMediaProgress.find {
                                    it.libraryItemId == libraryItem.id
                                }
                            val localLibraryItem =
                                DeviceManager.dbManager.getLocalLibraryItemByLId(libraryItem.id)
                            libraryItem.localLibraryItemId = localLibraryItem?.id
                            val description = libraryItem.getMediaDescription(progress, ctx, null, true)

                            // Make books with chapters browsable instead of playable
                            if (shouldBookBeBrowsable(libraryItem)) {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            } else {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                                )
                            }
                        }
                    result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                }
            } else if (mediaIdParts[3] == "AUTHORS" && mediaIdParts.size == 5) {
                Log.d(tag, "Loading authors from library ${mediaIdParts[2]} with paging ${mediaIdParts[4]}")
                mediaManager.loadAuthorsWithBooks(mediaIdParts[2], mediaIdParts[4]) { authorItems ->
                    Log.d(tag, "Received ${authorItems.size} authors")

                    val authorLetters =
                        authorItems
                            .groupingBy { iwb ->
                                iwb.name.substring(0, mediaIdParts[4].length + 1).uppercase()
                            }
                            .eachCount()
                    if (authorItems.size >
                        DeviceManager.deviceData.deviceSettings!!
                            .androidAutoBrowseLimitForGrouping &&
                        authorItems.size > 1 &&
                        authorLetters.size > 1
                    ) {
                        val children =
                            authorLetters.map { (authorLetter, authorCount) ->
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle(authorLetter)
                                        .setMediaId("${parentMediaId}${authorLetter.last()}")
                                        .setSubtitle("$authorCount authors")
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            }
                        result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                    } else {
                        val children =
                            authorItems.map { authorItem ->
                                val description = authorItem.getMediaDescription(null, ctx)
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            }
                        result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                    }
                }
            } else if (mediaIdParts[3] == "AUTHORS") {
                Log.d(tag, "Loading authors from library ${mediaIdParts[2]}")
                mediaManager.loadAuthorsWithBooks(mediaIdParts[2]) { authorItems ->
                    Log.d(tag, "Received ${authorItems.size} authors")
                    if (authorItems.size >
                        DeviceManager.deviceData.deviceSettings!!
                            .androidAutoBrowseLimitForGrouping && authorItems.size > 1
                    ) {
                        val authorLetters =
                            authorItems.groupingBy { iwb -> iwb.name.first().uppercaseChar() }.eachCount()
                        val children =
                            authorLetters.map { (authorLetter, authorCount) ->
                                MediaBrowserCompat.MediaItem(
                                    MediaDescriptionCompat.Builder()
                                        .setTitle(authorLetter.toString())
                                        .setSubtitle("$authorCount authors")
                                        .setMediaId("${parentMediaId}__${authorLetter}")
                                        .build(),
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            }
                        result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                    } else {
                        val children =
                            authorItems.map { authorItem ->
                                val description = authorItem.getMediaDescription(null, ctx)
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            }
                        result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                    }
                }
            } else if (mediaIdParts[3] == "AUTHOR") {
                mediaManager.loadAuthorBooksWithAudio(mediaIdParts[2], mediaIdParts[4]) { libraryItems ->
                    val children =
                        libraryItems.map { libraryItem ->
                            val progress =
                                mediaManager.serverUserMediaProgress.find {
                                    it.libraryItemId == libraryItem.id
                                }
                            val localLibraryItem =
                                DeviceManager.dbManager.getLocalLibraryItemByLId(libraryItem.id)
                            libraryItem.localLibraryItemId = localLibraryItem?.id
                            if (libraryItem.collapsedSeries != null) {
                                val description =
                                    libraryItem.getMediaDescription(progress, ctx, mediaIdParts[4])
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            } else if (shouldBookBeBrowsable(libraryItem)) {
                                val description = libraryItem.getMediaDescription(progress, ctx)
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            } else {
                                val description = libraryItem.getMediaDescription(progress, ctx)
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                                )
                            }
                        }
                    result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                }
            } else if (mediaIdParts[3] == "AUTHOR_SERIES") {
                mediaManager.loadAuthorSeriesBooksWithAudio(
                    mediaIdParts[2],
                    mediaIdParts[4],
                    mediaIdParts[5]
                ) { libraryItems ->
                    var items = libraryItems
                    if (DeviceManager.deviceData.deviceSettings!!.androidAutoBrowseSeriesSequenceOrder ===
                        AndroidAutoBrowseSeriesSequenceOrderSetting.DESC
                    ) {
                        items = libraryItems.reversed()
                    }
                    val children =
                        items.map { libraryItem ->
                            val progress =
                                mediaManager.serverUserMediaProgress.find {
                                    it.libraryItemId == libraryItem.id
                                }
                            val localLibraryItem =
                                DeviceManager.dbManager.getLocalLibraryItemByLId(libraryItem.id)
                            libraryItem.localLibraryItemId = localLibraryItem?.id
                            val description = libraryItem.getMediaDescription(progress, ctx, null, true)
                            if (libraryItem.collapsedSeries != null) {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            } else if (shouldBookBeBrowsable(libraryItem)) {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            } else {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                                )
                            }
                        }
                    result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                }
            } else if (mediaIdParts[3] == "COLLECTIONS") {
                Log.d(tag, "Loading collections from library ${mediaIdParts[2]}")
                mediaManager.loadLibraryCollectionsWithAudio(mediaIdParts[2]) { collectionItems ->
                    Log.d(tag, "Received ${collectionItems.size} collections")
                    val children =
                        collectionItems.map { collectionItem ->
                            val description = collectionItem.getMediaDescription(null, ctx)
                            MediaBrowserCompat.MediaItem(
                                description,
                                MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                            )
                        }
                    result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                }
            } else if (mediaIdParts[3] == "COLLECTION") {
                Log.d(tag, "Loading collection ${mediaIdParts[4]} books from library ${mediaIdParts[2]}")
                mediaManager.loadLibraryCollectionBooksWithAudio(mediaIdParts[2], mediaIdParts[4]) {
                    libraryItems ->
                    Log.d(tag, "Received ${libraryItems.size} collections")
                    val children =
                        libraryItems.map { libraryItem ->
                            val progress =
                                mediaManager.serverUserMediaProgress.find {
                                    it.libraryItemId == libraryItem.id
                                }
                            val localLibraryItem =
                                DeviceManager.dbManager.getLocalLibraryItemByLId(libraryItem.id)
                            libraryItem.localLibraryItemId = localLibraryItem?.id
                            val description = libraryItem.getMediaDescription(progress, ctx)

                            // Make books with chapters browsable instead of playable
                            if (shouldBookBeBrowsable(libraryItem)) {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            } else {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                                )
                            }
                        }
                    result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                }
            } else if (mediaIdParts[3] == "DISCOVERY") {
                Log.d(tag, "Loading discovery from library ${mediaIdParts[2]}")
                mediaManager.loadLibraryDiscoveryBooksWithAudio(mediaIdParts[2]) { libraryItems ->
                    Log.d(tag, "Received ${libraryItems.size} libraryItems for discovery")
                    val children =
                        libraryItems.map { libraryItem ->
                            val progress =
                                mediaManager.serverUserMediaProgress.find {
                                    it.libraryItemId == libraryItem.id
                                }
                            val localLibraryItem =
                                DeviceManager.dbManager.getLocalLibraryItemByLId(libraryItem.id)
                            libraryItem.localLibraryItemId = localLibraryItem?.id
                            val description = libraryItem.getMediaDescription(progress, ctx)

                            // Make books with chapters browsable instead of playable
                            if (shouldBookBeBrowsable(libraryItem)) {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                                )
                            } else {
                                MediaBrowserCompat.MediaItem(
                                    description,
                                    MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                                )
                            }
                        }
                    result.sendResult(children as MutableList<MediaBrowserCompat.MediaItem>?)
                }
            } else {
                result.sendResult(null)
            }
        } else {
            // Check if this is a book ID (for chapter browsing)
            val libraryItem = mediaManager.getById(parentMediaId)
            val localLibraryItem = DeviceManager.dbManager.getLocalLibraryItem(parentMediaId) as? LocalLibraryItem

            if (libraryItem != null && libraryItem is LibraryItem && shouldBookBeBrowsable(libraryItem)) {
                Log.d(tag, "Loading chapters for book ${libraryItem.media.metadata.title}")
                val book = libraryItem.media as Book
                val chapters = book.chapters ?: emptyList()

                val children = chapters.mapIndexed { index, chapter ->
                    val chapterMediaId = "${libraryItem.id}__CHAPTER__${index}"
                    val chapterTitle = chapter.title ?: "Chapter ${index + 1}"
                    val chapterSubtitle = "${formatTime((chapter.end - chapter.start).toLong())} • ${libraryItem.media.metadata.title}"

                    val description = MediaDescriptionCompat.Builder()
                        .setMediaId(chapterMediaId)
                        .setTitle(chapterTitle)
                        .setSubtitle(chapterSubtitle)
                        .setIconUri(libraryItem.getCoverUri())
                        .build()

                    MediaBrowserCompat.MediaItem(
                        description,
                        MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                    )
                }.toMutableList()

                result.sendResult(children)
            } else if (localLibraryItem != null && shouldLocalBookBeBrowsable(localLibraryItem)) {
                Log.d(tag, "Loading chapters for local book ${localLibraryItem.media.metadata.title}")
                val book = localLibraryItem.media as Book
                val chapters = book.chapters ?: emptyList()

                // Cache bitmap for local books to avoid loading the same image multiple times
                var cachedBitmap: Bitmap? = null
                val coverUri = localLibraryItem.getCoverUri(ctx)

                // Load bitmap once for local books
                if (localLibraryItem.coverContentUrl != null) {
                    try {
                        cachedBitmap = if (Build.VERSION.SDK_INT < 28) {
                            MediaStore.Images.Media.getBitmap(ctx.contentResolver, coverUri)
                        } else {
                            val source: ImageDecoder.Source = ImageDecoder.createSource(ctx.contentResolver, coverUri)
                            ImageDecoder.decodeBitmap(source)
                        }
                        Log.d(tag, "Cached bitmap loaded for local book browse chapters")
                    } catch (e: Exception) {
                        Log.w(tag, "Failed to load cached bitmap for browse chapters: ${e.message}")
                    }
                }

                val children = chapters.mapIndexed { index, chapter ->
                    val chapterMediaId = "${localLibraryItem.id}__CHAPTER__${index}"
                    val chapterTitle = chapter.title ?: "Chapter ${index + 1}"
                    val chapterSubtitle = "${formatTime((chapter.end - chapter.start).toLong())} • ${localLibraryItem.media.metadata.title}"

                    val description = MediaDescriptionCompat.Builder()
                        .setMediaId(chapterMediaId)
                        .setTitle(chapterTitle)
                        .setSubtitle(chapterSubtitle)
                        .setIconUri(coverUri)
                        .apply {
                            cachedBitmap?.let { setIconBitmap(it) }
                        }
                        .build()

                    MediaBrowserCompat.MediaItem(
                        description,
                        MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                    )
                }.toMutableList()

                result.sendResult(children)
            } else {
                Log.d(tag, "Loading podcast episodes for podcast $parentMediaId")
                mediaManager.loadPodcastEpisodeMediaBrowserItems(parentMediaId, ctx) { result.sendResult(it) }
            }
        }
    }

    fun onSearch(
        query: String,
        extras: Bundle?,
        result: MediaBrowserServiceCompat.Result<MutableList<MediaBrowserCompat.MediaItem>>
    ) {
        result.detach()
        if (cachedSearch != query) {
            Log.d(tag, "Search bundle: $extras")
            var foundBooks: MutableList<MediaBrowserCompat.MediaItem> = mutableListOf()
            var foundPodcasts: MutableList<MediaBrowserCompat.MediaItem> = mutableListOf()
            var foundSeries: MutableList<MediaBrowserCompat.MediaItem> = mutableListOf()
            var foundAuthors: MutableList<MediaBrowserCompat.MediaItem> = mutableListOf()

            mediaManager.serverLibraries.forEach { serverLibrary ->
                runBlocking {
                    // Skip searching library if it doesn't have any audio files
                    if (serverLibrary.stats?.numAudioFiles == 0) return@runBlocking
                    val searchResult = mediaManager.doSearch(serverLibrary.id, query)
                    for (resultData in searchResult.entries.iterator()) {
                        when (resultData.key) {
                            "book" -> foundBooks.addAll(resultData.value)
                            "series" -> foundSeries.addAll(resultData.value)
                            "authors" -> foundAuthors.addAll(resultData.value)
                            "podcast" -> foundPodcasts.addAll(resultData.value)
                        }
                    }
                }
            }
            foundBooks.addAll(foundSeries)
            foundBooks.addAll(foundAuthors)
            cachedSearchResults = foundBooks
        }
        result.sendResult(cachedSearchResults)
        cachedSearch = query
        Log.d(tag, "onSearch: Done")
    }

    // Method to force reload (called when server changes)
    fun resetForceReloading() {
        AbsLogger.info(tag, "resetForceReloading: Forcing Android Auto to reload")
        forceReloadingAndroidAuto = true
        firstLoadDone = false // Reset to trigger proper reload
        networkConnectivityManager.setFirstLoadDone(false) // Sync with NetworkConnectivityManager
    }

    // Method to get browse tree state
    fun isBrowseTreeInitialized(): Boolean = this::browseTree.isInitialized

    // Method to handle app refresh scenarios
    fun handleAppRefresh() {
        AbsLogger.info(tag, "handleAppRefresh: Resetting Android Auto state for app refresh")
        forceReloadingAndroidAuto = true
        firstLoadDone = false
        networkConnectivityManager.setFirstLoadDone(false)

        // Clear server data if not connected
        if (!DeviceManager.isConnectedToServer || !DeviceManager.checkConnectivity(ctx)) {
            mediaManager.checkResetServerItems()
        }

        // Force refresh of the main root
        service.notifyChildrenChanged(AUTO_MEDIA_ROOT)
    }

    private fun createLoadingMediaItem(): MediaBrowserCompat.MediaItem {
        val description = MediaDescriptionCompat.Builder()
            .setMediaId("__LOADING__")
            .setTitle("Loading...")
            .setSubtitle("Please wait while library data loads")
            .setIconUri(getUriToDrawable(ctx, R.drawable.icon_monochrome))
            .build()

        return MediaBrowserCompat.MediaItem(
            description,
            MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
        )
    }
}

