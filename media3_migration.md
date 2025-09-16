Persona: You are an expert Android Software Architect with deep, specialized knowledge in the Android media ecosystem, including the latest androidx.media3 libraries, Android Auto, and Google Cast integration. Your expertise lies in designing robust, maintainable, and user-centric media applications.

Primary Goal:
Your mission is to devise a comprehensive migration and re-architecture plan for an existing Android audiobook application. The plan must detail the process of replacing all legacy media functionality with the modern Media3 APIs. The new architecture must be clean, robust, and centered around a unified playback experience across local playback, Android Auto, and Google Cast.

Context:
The current application is an audiobook player. Its media architecture has evolved over time and suffers from several pain points:

It uses a combination of MediaBrowserServiceCompat and a custom-managed ExoPlayer instance.

The logic for local playback, Android Auto, and Chromecast is fragmented, leading to inconsistent behavior and duplicated state management.

Playback progress and state are tracked in multiple places, causing synchronization issues and bugs.

Support for chapters is inconsistent, especially when handling "skip next/previous" actions in audiobooks that are structured as a single large audio file with chapter metadata versus those structured as multiple audio files (one per chapter).

Core Architectural Requirements:

Full Migration to Media3:

Analyze the existing implementation (MediaBrowserServiceCompat, MediaPlayer, custom ExoPlayer wrappers, etc.).

Propose a complete replacement using the androidx.media3 artifacts. This includes using MediaLibraryService, MediaSession, and the Media3 ExoPlayer implementation.

Unified Player Architecture (The Cornerstone):

Design an architecture where a single MediaSession acts as the primary interface for all clients (the local app UI, Android Auto, Google Assistant, Cast notifications, etc.).

The player logic should seamlessly switch between local playback on ExoPlayer and remote playback on a CastPlayer without the UI or the service needing to manage separate logic paths. The goal is to have the UI interact with the MediaController and be completely agnostic about whether the audio is rendering on the device's speakers, headphones, a car, or a Chromecast.

Single Source of Truth for Playback State:

Architect a robust data layer (e.g., using the Repository pattern) that is the only source of truth for the currently playing media item, its duration, the user's current progress, and playback speed.

This state must be collected from the Media3 player instance and exposed reactively (e.g., via Kotlin StateFlow) to the entire application (ViewModels, UI, etc.). This eliminates UI-level timers or disparate state holders for tracking progress.

Comprehensive Chapter-Aware Playback:

The entire application must be "chapter-aware." This is a critical feature.

The MediaItem creation process must correctly handle both types of audiobooks:

Multi-Track: A playlist of multiple audio files, where each file is a chapter. The MediaItem list in the player should represent this playlist.

Single-Track: A single audio file with embedded chapter metadata (e.g., in ID3 tags or a separate manifest). The architecture must parse this metadata and treat the chapters as distinct seek points within the single MediaItem.

All playback actions must behave correctly in a chapter-aware context:

seekToNext() / seekToPrevious() should navigate to the next/previous chapter boundary, regardless of whether it's the next file in a playlist or the next metadata marker in a single file.

The UI progress bar should be able to display chapter markers.

Android Auto and other clients should display the correct chapter title and metadata.

Simplified & Unified Playback Controls:

Based on the unified player architecture, propose a simplification of the playback controls UI.

Look for opportunities to reduce redundant buttons. For example, can the "skip 30s" and "skip to next chapter" buttons be combined intelligently?

The UI should reactively update based on the player's capabilities. For instance, the "Cast" button should only change state based on cast availability discovered by the Media3 framework, not through separate logic.

Deliverables:

Please structure your response to provide the following:

Analysis of the "Old" Architecture: Briefly describe the likely problems with the existing setup and why the Media3 architecture solves them.

Proposed High-Level Architecture Diagram: Create a simple diagram or text-based flow showing the relationship between the UI (Activity/Fragment), ViewModel, Repository, MediaLibraryService, MediaSession, and the ExoPlayer/CastPlayer.

Core Component Implementation Strategy:

MediaLibraryService & MediaSession: Explain how to configure the service and session to be the heart of the app. Detail how the MediaSession.Callback should be used to handle custom logic.

Player Management: Describe the strategy for creating and managing the ExoPlayer instance and integrating the CastPlayer. Explain how the MediaSession will manage switching between them.

Media Item Creation: Provide a detailed strategy and pseudo-code for building MediaItem objects that include the necessary chapter metadata for both multi-track and single-track books. How would you store and pass this metadata?

State Management (Single Source of Truth): Show how a Repository would listen to player events (Player.Listener) to get progress, duration, and the current MediaItem index, and then expose this data to the app's ViewModels via a Kotlin Flow.

Chapter Navigation Logic:

Provide a concrete implementation plan or high-quality pseudo-code for overriding onSeekToNext() and onSeekToPrevious() in the MediaSession.Callback to correctly handle chapter navigation for both book types.

Code Snippets: Include key Kotlin code snippets for:

Initializing the MediaSession and linking it to the player.

A sample Player.Listener implementation inside the Repository.

A sample ViewModel collecting the playback state Flow.

Building a MediaItem with custom metadata for chapters.

Your final output should be a developer-ready architectural blueprint that serves as a clear and actionable guide for the engineering team to begin the migration. Output as a markdown file that ai agents can also follow.


## 1. Analysis of Current Architecture Issues

### Current Problems
The existing MediaBrowserManager.kt reveals several architectural issues:

1. **Fragmented State Management**: Progress tracking happens in multiple places (`DeviceManager.dbManager`, `mediaManager.serverUserMediaProgress`)
2. **Complex Browser Tree Logic**: Manual construction of browse trees with extensive conditional branching
3. **Legacy APIs**: Using `MediaBrowserServiceCompat` and `MediaDescriptionCompat` instead of modern Media3 APIs
4. **Inconsistent Chapter Handling**: Chapters are handled as browsable items but lack unified playback logic
5. **Manual Cache Management**: Complex cache reset logic (`forceReloadingAndroidAuto`, `cacheResetInProgress`)
6. **Tight Coupling**: Direct dependencies on `DeviceManager`, `NetworkConnectivityManager`, and various data sources

### Why Media3 Solves These Issues
- **Unified API**: Single MediaSession handles all client interactions
- **Built-in State Management**: MediaSession automatically syncs state across all clients
- **Modern Architecture**: Supports reactive patterns with Kotlin coroutines and Flow
- **Simplified Cast Integration**: CastPlayer seamlessly integrates with the same MediaSession
- **Chapter Support**: Native support for MediaItem metadata and custom commands

## 2. Proposed High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         UI Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Activity   │  │   Fragment   │  │  Android     │     │
│  │              │  │              │  │    Auto      │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘             │
│                            ▼                                │
│                    ┌──────────────┐                         │
│                    │MediaController│                        │
│                    └──────┬───────┘                         │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│                   ViewModel Layer                           │
│                    ┌──────▼───────┐                         │
│                    │  PlaybackVM  │                         │
│                    └──────┬───────┘                         │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│                    Domain Layer                             │
│                    ┌──────▼───────┐                         │
│                    │PlaybackRepository                      │
│                    │(Single Source of Truth)                │
│                    └──────┬───────┘                         │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│                    Service Layer                            │
│         ┌──────────────────▼──────────────────┐             │
│         │      AudiobookMediaService          │             │
│         │        (MediaLibraryService)        │             │
│         └──────────────┬───────────────────────┘            │
│                        │                                    │
│         ┌──────────────▼──────────────────────┐            │
│         │          MediaSession                │            │
│         │   ┌─────────────────────────┐        │            │
│         │   │  MediaSession.Callback  │        │            │
│         │   └─────────────────────────┘        │            │
│         └──────────┬──────────┬────────────────┘           │
│                    │          │                             │
│         ┌──────────▼───┐  ┌───▼──────────┐                │
│         │  ExoPlayer   │  │  CastPlayer  │                │
│         └──────────────┘  └──────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

## 3. Core Component Implementation Strategy

### 3.1 MediaLibraryService & MediaSession

```kotlin
// AudiobookMediaService.kt
import androidx.media3.session.*
import androidx.media3.common.*
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.SessionAvailabilityListener
import kotlinx.coroutines.*
import javax.inject.Inject

class AudiobookMediaService : MediaLibraryService() {

    @Inject lateinit var playbackRepository: PlaybackRepository
    @Inject lateinit var mediaItemBuilder: MediaItemBuilder

    private lateinit var player: Player
    private lateinit var mediaSession: MediaLibrarySession
    private lateinit var castPlayer: CastPlayer
    private lateinit var exoPlayer: ExoPlayer

    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    override fun onCreate() {
        super.onCreate()

        // Initialize ExoPlayer
        exoPlayer = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.Builder()
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                .setUsage(C.USAGE_MEDIA)
                .build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()

        // Initialize CastPlayer
        castPlayer = CastPlayer(CastContext.getSharedInstance(this))
        castPlayer.setSessionAvailabilityListener(CastSessionAvailabilityListener())

        // Start with local player
        player = exoPlayer

        // Create MediaSession with custom callback
        mediaSession = MediaLibrarySession.Builder(this, player, createCallback())
            .setId("AudiobookMediaSession")
            .setSessionActivity(createPendingIntent())
            .build()

        // Setup player listener for state management
        player.addListener(PlayerEventListener())
    }

    private fun createCallback(): MediaLibrarySession.Callback {
        return AudiobookMediaSessionCallback()
    }

    inner class AudiobookMediaSessionCallback : MediaLibrarySession.Callback {

        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo
        ): MediaSession.ConnectionResult {
            val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                .add(SessionCommand(COMMAND_SEEK_TO_CHAPTER, Bundle.EMPTY))
                .build()

            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(sessionCommands)
                .build()
        }

        override fun onGetLibraryRoot(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            params: LibraryParams?
        ): ListenableFuture<LibraryResult<MediaItem>> {
            return Futures.immediateFuture(
                LibraryResult.ofItem(
                    MediaItem.Builder()
                        .setMediaId(ROOT_ID)
                        .setMediaMetadata(
                            MediaMetadata.Builder()
                                .setTitle("Audiobook Library")
                                .setIsPlayable(false)
                                .setIsBrowsable(true)
                                .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                                .build()
                        )
                        .build(),
                    params
                )
            )
        }

        override fun onGetChildren(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            parentId: String,
            page: Int,
            pageSize: Int,
            params: LibraryParams?
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            return serviceScope.future {
                when {
                    parentId == ROOT_ID -> buildRootMenu()
                    parentId.startsWith("library_") -> buildLibraryItems(parentId)
                    parentId.startsWith("book_") -> buildChapterItems(parentId)
                    else -> LibraryResult.ofItemList(ImmutableList.of(), params)
                }
            }
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle
        ): ListenableFuture<SessionResult> {
            return when (customCommand.customAction) {
                COMMAND_SEEK_TO_CHAPTER -> {
                    val chapterIndex = args.getInt("chapter_index", -1)
                    if (chapterIndex >= 0) {
                        seekToChapter(chapterIndex)
                    }
                    Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
                else -> super.onCustomCommand(session, controller, customCommand, args)
            }
        }

        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            return serviceScope.future {
                val lastPlayback = playbackRepository.getLastPlaybackSession()
                lastPlayback?.let {
                    MediaSession.MediaItemsWithStartPosition(
                        it.mediaItems,
                        it.startIndex,
                        it.startPositionMs
                    )
                } ?: MediaSession.MediaItemsWithStartPosition(
                    ImmutableList.of(),
                    0,
                    C.TIME_UNSET
                )
            }
        }
    }

    inner class CastSessionAvailabilityListener : SessionAvailabilityListener {
        override fun onCastSessionAvailable() {
            switchToPlayer(castPlayer)
        }

        override fun onCastSessionUnavailable() {
            switchToPlayer(exoPlayer)
        }
    }

    private fun switchToPlayer(newPlayer: Player) {
        val oldPlayer = player

        // Copy state
        newPlayer.setMediaItems(
            oldPlayer.mediaItems,
            oldPlayer.currentMediaItemIndex,
            oldPlayer.currentPosition
        )
        newPlayer.playWhenReady = oldPlayer.playWhenReady

        // Switch players
        oldPlayer.stop()
        oldPlayer.clearMediaItems()
        player = newPlayer
        mediaSession.player = newPlayer

        // Update repository
        playbackRepository.onPlayerChanged(newPlayer)
    }

    inner class PlayerEventListener : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            playbackRepository.updatePlaybackState(playbackState)
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            mediaItem?.let {
                playbackRepository.updateCurrentMediaItem(it)
                handleChapterTransition(it)
            }
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int
        ) {
            playbackRepository.updatePosition(newPosition.positionMs)
        }
    }

    companion object {
        const val ROOT_ID = "root"
        const val COMMAND_SEEK_TO_CHAPTER = "seek_to_chapter"
    }
}
```

### 3.2 Media Item Creation with Chapter Support

```kotlin
// MediaItemBuilder.kt
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import android.net.Uri
import android.os.Bundle

class MediaItemBuilder {

    fun buildBookMediaItem(
        book: AudiobookData,
        chapters: List<ChapterData>
    ): List<MediaItem> {
        return when (book.type) {
            BookType.MULTI_TRACK -> buildMultiTrackBook(book, chapters)
            BookType.SINGLE_TRACK -> buildSingleTrackBook(book, chapters)
        }
    }

    private fun buildMultiTrackBook(
        book: AudiobookData,
        chapters: List<ChapterData>
    ): List<MediaItem> {
        return chapters.mapIndexed { index, chapter ->
            MediaItem.Builder()
                .setMediaId("${book.id}_chapter_$index")
                .setUri(chapter.audioUri)
                .setMimeType(MimeTypes.AUDIO_MP4)
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(chapter.title)
                        .setSubtitle(book.title)
                        .setArtist(book.author)
                        .setArtworkUri(Uri.parse(book.coverUrl))
                        .setTrackNumber(index + 1)
                        .setTotalTrackCount(chapters.size)
                        .setIsPlayable(true)
                        .setExtras(Bundle().apply {
                            putString("book_id", book.id)
                            putInt("chapter_index", index)
                            putLong("chapter_start_ms", 0)
                            putLong("chapter_end_ms", chapter.durationMs)
                            putString("book_type", "multi_track")
                        })
                        .build()
                )
                .setTag(ChapterInfo(
                    bookId = book.id,
                    chapterIndex = index,
                    startMs = 0,
                    endMs = chapter.durationMs,
                    isMultiTrack = true
                ))
                .build()
        }
    }

    private fun buildSingleTrackBook(
        book: AudiobookData,
        chapters: List<ChapterData>
    ): List<MediaItem> {
        // For single track, we create one MediaItem with chapter metadata
        val mediaItem = MediaItem.Builder()
            .setMediaId(book.id)
            .setUri(book.audioUri)
            .setMimeType(MimeTypes.AUDIO_MP4)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(book.title)
                    .setArtist(book.author)
                    .setArtworkUri(Uri.parse(book.coverUrl))
                    .setIsPlayable(true)
                    .setExtras(Bundle().apply {
                        putString("book_id", book.id)
                        putString("book_type", "single_track")
                        putParcelableArrayList("chapters", ArrayList(chapters.map {
                            ChapterBundle(it.title, it.startMs, it.endMs)
                        }))
                    })
                    .build()
            )
            .setTag(BookInfo(
                bookId = book.id,
                chapters = chapters.map {
                    ChapterInfo(
                        bookId = book.id,
                        chapterIndex = chapters.indexOf(it),
                        startMs = it.startMs,
                        endMs = it.endMs,
                        isMultiTrack = false
                    )
                }
            ))
            .build()

        return listOf(mediaItem)
    }

    // Helper function to build chapter items for browsing
    fun buildChapterBrowsableItems(
        book: AudiobookData,
        chapters: List<ChapterData>
    ): List<MediaItem> {
        return chapters.mapIndexed { index, chapter ->
            MediaItem.Builder()
                .setMediaId("${book.id}_chapter_browse_$index")
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(chapter.title ?: "Chapter ${index + 1}")
                        .setSubtitle(formatDuration(chapter.durationMs))
                        .setArtworkUri(Uri.parse(book.coverUrl))
                        .setIsPlayable(true)
                        .setIsBrowsable(false)
                        .setExtras(Bundle().apply {
                            putString("book_id", book.id)
                            putInt("chapter_index", index)
                            putLong("start_position_ms", chapter.startMs)
                        })
                        .build()
                )
                .build()
        }
    }
}

data class ChapterInfo(
    val bookId: String,
    val chapterIndex: Int,
    val startMs: Long,
    val endMs: Long,
    val isMultiTrack: Boolean
)

data class BookInfo(
    val bookId: String,
    val chapters: List<ChapterInfo>
)
```

### 3.3 State Management Repository

```kotlin
// PlaybackRepository.kt
import androidx.media3.common.Player
import androidx.media3.common.MediaItem
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PlaybackRepository @Inject constructor(
    private val database: AudiobookDatabase
) {
    private val scope = CoroutineScope(Dispatchers.Main)

    // Single source of truth for playback state
    private val _playbackState = MutableStateFlow(PlaybackState())
    val playbackState: StateFlow<PlaybackState> = _playbackState.asStateFlow()

    // Current chapter information
    private val _currentChapter = MutableStateFlow<ChapterInfo?>(null)
    val currentChapter: StateFlow<ChapterInfo?> = _currentChapter.asStateFlow()

    // Playback progress
    private val _playbackProgress = MutableStateFlow(PlaybackProgress())
    val playbackProgress: StateFlow<PlaybackProgress> = _playbackProgress.asStateFlow()

    private var currentPlayer: Player? = null
    private var progressUpdateJob: Job? = null

    fun onPlayerChanged(player: Player) {
        currentPlayer?.removeListener(playerListener)
        currentPlayer = player
        player.addListener(playerListener)

        // Start progress updates
        startProgressUpdates()
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            updatePlaybackState(playbackState)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            _playbackState.update { it.copy(isPlaying = isPlaying) }
            if (isPlaying) {
                startProgressUpdates()
            } else {
                stopProgressUpdates()
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            mediaItem?.let { item ->
                updateCurrentMediaItem(item)

                // Extract chapter info from MediaItem
                when (val tag = item.localConfiguration?.tag) {
                    is ChapterInfo -> {
                        _currentChapter.value = tag
                    }
                    is BookInfo -> {
                        // For single-track books, determine current chapter by position
                        val position = currentPlayer?.currentPosition ?: 0
                        val chapter = tag.chapters.find {
                            position >= it.startMs && position < it.endMs
                        }
                        _currentChapter.value = chapter
                    }
                }
            }
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int
        ) {
            updatePosition(newPosition.positionMs)
            checkChapterBoundary(newPosition.positionMs)
        }
    }

    private fun startProgressUpdates() {
        progressUpdateJob?.cancel()
        progressUpdateJob = scope.launch {
            while (currentPlayer?.isPlaying == true) {
                val position = currentPlayer?.currentPosition ?: 0
                val duration = currentPlayer?.duration ?: 0
                val bufferedPosition = currentPlayer?.bufferedPosition ?: 0

                _playbackProgress.update {
                    PlaybackProgress(
                        positionMs = position,
                        durationMs = duration,
                        bufferedPositionMs = bufferedPosition,
                        playbackSpeed = currentPlayer?.playbackParameters?.speed ?: 1f
                    )
                }

                // Check if we've crossed a chapter boundary
                checkChapterBoundary(position)

                // Save progress to database
                saveProgress(position, duration)

                delay(1000) // Update every second
            }
        }
    }

    private fun checkChapterBoundary(positionMs: Long) {
        val currentItem = currentPlayer?.currentMediaItem ?: return

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book - check chapter boundaries
                val newChapter = tag.chapters.find {
                    positionMs >= it.startMs && positionMs < it.endMs
                }
                if (newChapter != _currentChapter.value) {
                    _currentChapter.value = newChapter
                    onChapterChanged(newChapter)
                }
            }
        }
    }

    private fun onChapterChanged(chapter: ChapterInfo?) {
        // Notify UI about chapter change
        // Could trigger notifications, analytics, etc.
    }

    private suspend fun saveProgress(position: Long, duration: Long) {
        val mediaItem = currentPlayer?.currentMediaItem ?: return
        val bookId = mediaItem.mediaMetadata.extras?.getString("book_id") ?: return

        database.savePlaybackProgress(
            PlaybackProgressEntity(
                bookId = bookId,
                positionMs = position,
                durationMs = duration,
                lastUpdated = System.currentTimeMillis()
            )
        )
    }

    fun updatePlaybackState(state: Int) {
        _playbackState.update {
            it.copy(
                playerState = state,
                isBuffering = state == Player.STATE_BUFFERING
            )
        }
    }

    fun updateCurrentMediaItem(mediaItem: MediaItem) {
        _playbackState.update {
            it.copy(
                currentMediaItem = mediaItem,
                title = mediaItem.mediaMetadata.title?.toString(),
                artist = mediaItem.mediaMetadata.artist?.toString(),
                artworkUri = mediaItem.mediaMetadata.artworkUri
            )
        }
    }

    fun updatePosition(positionMs: Long) {
        _playbackProgress.update {
            it.copy(positionMs = positionMs)
        }
    }

    suspend fun getLastPlaybackSession(): LastPlaybackSession? {
        return database.getLastPlaybackSession()
    }

    fun seekToChapter(chapterIndex: Int) {
        val currentItem = currentPlayer?.currentMediaItem ?: return

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book - seek to chapter start
                val chapter = tag.chapters.getOrNull(chapterIndex) ?: return
                currentPlayer?.seekTo(chapter.startMs)
            }
            is ChapterInfo -> {
                // Multi-track book - seek to different media item
                if (tag.isMultiTrack) {
                    currentPlayer?.seekTo(chapterIndex, 0)
                }
            }
        }
    }
}

data class PlaybackState(
    val isPlaying: Boolean = false,
    val playerState: Int = Player.STATE_IDLE,
    val isBuffering: Boolean = false,
    val currentMediaItem: MediaItem? = null,
    val title: String? = null,
    val artist: String? = null,
    val artworkUri: Uri? = null
)

data class PlaybackProgress(
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val bufferedPositionMs: Long = 0,
    val playbackSpeed: Float = 1f
)
```

## 4. Chapter Navigation Implementation

```kotlin
// ChapterNavigationHandler.kt
class ChapterNavigationHandler(
    private val player: Player
) {

    fun seekToNextChapter() {
        val currentItem = player.currentMediaItem ?: return
        val currentPosition = player.currentPosition

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book with chapters
                val currentChapter = tag.chapters.find {
                    currentPosition >= it.startMs && currentPosition < it.endMs
                }
                val currentIndex = tag.chapters.indexOf(currentChapter)

                if (currentIndex < tag.chapters.size - 1) {
                    // Seek to next chapter in same file
                    val nextChapter = tag.chapters[currentIndex + 1]
                    player.seekTo(nextChapter.startMs)
                } else if (player.hasNextMediaItem()) {
                    // Move to next book if available
                    player.seekToNextMediaItem()
                }
            }
            is ChapterInfo -> {
                // Multi-track book
                if (tag.isMultiTrack) {
                    player.seekToNextMediaItem()
                }
            }
            else -> {
                // Fallback to default behavior
                player.seekToNextMediaItem()
            }
        }
    }

    fun seekToPreviousChapter() {
        val currentItem = player.currentMediaItem ?: return
        val currentPosition = player.currentPosition

        // If we're more than 3 seconds into the chapter, restart it
        val restartThreshold = 3000L

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book with chapters
                val currentChapter = tag.chapters.find {
                    currentPosition >= it.startMs && currentPosition < it.endMs
                }
                val currentIndex = tag.chapters.indexOf(currentChapter)

                currentChapter?.let {
                    if (currentPosition - it.startMs > restartThreshold) {
                        // Restart current chapter
                        player.seekTo(it.startMs)
                    } else if (currentIndex > 0) {
                        // Go to previous chapter
                        val prevChapter = tag.chapters[currentIndex - 1]
                        player.seekTo(prevChapter.startMs)
                    } else if (player.hasPreviousMediaItem()) {
                        // Move to previous book if available
                        player.seekToPreviousMediaItem()
                    } else {
                        // Restart from beginning
                        player.seekTo(0)
                    }
                }
            }
            is ChapterInfo -> {
                // Multi-track book
                if (tag.isMultiTrack) {
                    if (currentPosition > restartThreshold) {
                        player.seekTo(0)
                    } else {
                        player.seekToPreviousMediaItem()
                    }
                }
            }
            else -> {
                // Fallback
                if (currentPosition > restartThreshold) {
                    player.seekTo(0)
                } else {
                    player.seekToPreviousMediaItem()
                }
            }
        }
    }

    fun skipForward(seconds: Int = 30) {
        val newPosition = player.currentPosition + (seconds * 1000)
        val duration = player.duration

        if (duration != C.TIME_UNSET && newPosition >= duration) {
            // Would skip past end, go to next chapter instead
            seekToNextChapter()
        } else {
            player.seekTo(newPosition)
        }
    }

    fun skipBackward(seconds: Int = 30) {
        val newPosition = player.currentPosition - (seconds * 1000)

        if (newPosition < 0) {
            // Would skip before start, go to previous chapter
            seekToPreviousChapter()
        } else {
            player.seekTo(newPosition)
        }
    }
}

// Integration in MediaSession.Callback
class AudiobookMediaSessionCallback : MediaLibrarySession.Callback {

    private lateinit var chapterNavigationHandler: ChapterNavigationHandler

    override fun onConnect(
        session: MediaSession,
        controller: MediaSession.ControllerInfo
    ): MediaSession.ConnectionResult {
        chapterNavigationHandler = ChapterNavigationHandler(session.player)
        // ... rest of connection logic
    }

    override fun onMediaButtonEvent(
        session: MediaSession,
        controllerInfo: MediaSession.ControllerInfo,
        intent: Intent
    ): Boolean {
        val keyEvent = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)

        return when (keyEvent?.keyCode) {
            KeyEvent.KEYCODE_MEDIA_NEXT -> {
                chapterNavigationHandler.seekToNextChapter()
                true
            }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                chapterNavigationHandler.seekToPreviousChapter()
                true
            }
            else -> super.onMediaButtonEvent(session, controllerInfo, intent)
        }
    }
}
```

## 5. ViewModel Integration

```kotlin
// PlaybackViewModel.kt
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class PlaybackViewModel @Inject constructor(
    private val playbackRepository: PlaybackRepository,
    private val mediaControllerManager: MediaControllerManager
) : ViewModel() {

    // Expose repository state directly
    val playbackState = playbackRepository.playbackState
    val playbackProgress = playbackRepository.playbackProgress
    val currentChapter = playbackRepository.currentChapter

    // UI-specific state
    private val _uiState = MutableStateFlow(PlaybackUiState())
    val uiState: StateFlow<PlaybackUiState> = _uiState.asStateFlow()

    // MediaController for sending commands
    private var mediaController: MediaController? = null

    init {
        // Observe MediaController availability
        viewModelScope.launch {
            mediaControllerManager.controller.collect { controller ->
                mediaController = controller
                controller?.let { setupControllerListeners(it) }
            }
        }

        // Combine repository states into UI state
        combine(
            playbackState,
            playbackProgress,
            currentChapter
        ) { state, progress, chapter ->
            PlaybackUiState(
                isPlaying = state.isPlaying,
                isBuffering = state.isBuffering,
                title = state.title ?: "",
                artist = state.artist ?: "",
                artworkUri = state.artworkUri,
                positionMs = progress.positionMs,
                durationMs = progress.durationMs,
                bufferedPercentage = calculateBufferedPercentage(
                    progress.bufferedPositionMs,
                    progress.durationMs
                ),
                playbackSpeed = progress.playbackSpeed,
                chapterTitle = chapter?.let { "Chapter ${it.chapterIndex + 1}" },
                chapterProgress = chapter?.let {
                    calculateChapterProgress(progress.positionMs, it)
                } ?: 0f
            )
        }.onEach { state ->
            _uiState.value = state
        }.launchIn(viewModelScope)
    }

    private fun setupControllerListeners(controller: MediaController) {
        // Additional controller-specific setup if needed
    }

    // Playback controls
    fun play() {
        mediaController?.play()
    }

    fun pause() {
        mediaController?.pause()
    }

    fun seekToNext() {
        sendCustomCommand(COMMAND_NEXT_CHAPTER)
    }

    fun seekToPrevious() {
        sendCustomCommand(COMMAND_PREVIOUS_CHAPTER)
    }

    fun seekTo(positionMs: Long) {
        mediaController?.seekTo(positionMs)
    }

    fun skipForward() {
        sendCustomCommand(COMMAND_SKIP_FORWARD)
    }

    fun skipBackward() {
        sendCustomCommand(COMMAND_SKIP_BACKWARD)
    }

    fun setPlaybackSpeed(speed: Float) {
        mediaController?.setPlaybackSpeed(speed)
    }

    fun seekToChapter(chapterIndex: Int) {
        val bundle = Bundle().apply {
            putInt("chapter_index", chapterIndex)
        }
        sendCustomCommand(COMMAND_SEEK_TO_CHAPTER, bundle)
    }

    private fun sendCustomCommand(command: String, args: Bundle = Bundle.EMPTY) {
        mediaController?.sendCustomCommand(
            SessionCommand(command, Bundle.EMPTY),
            args
        )
    }

    private fun calculateBufferedPercentage(buffered: Long, duration: Long): Float {
        return if (duration > 0) {
            (buffered.toFloat() / duration * 100).coerceIn(0f, 100f)
        } else 0f
    }

    private fun calculateChapterProgress(position: Long, chapter: ChapterInfo): Float {
        val chapterDuration = chapter.endMs - chapter.startMs
        val chapterPosition = position - chapter.startMs
        return if (chapterDuration > 0) {
            (chapterPosition.toFloat() / chapterDuration).coerceIn(0f, 1f)
        } else 0f
    }

    companion object {
        private const val COMMAND_NEXT_CHAPTER = "next_chapter"
        private const val COMMAND_PREVIOUS_CHAPTER = "previous_chapter"
        private const val COMMAND_SKIP_FORWARD = "skip_forward"
        private const val COMMAND_SKIP_BACKWARD = "skip_backward"
        private const val COMMAND_SEEK_TO_CHAPTER = "seek_to_chapter"
    }
}

data class PlaybackUiState(
    val isPlaying: Boolean = false,
    val isBuffering: Boolean = false,
    val title: String = "",
    val artist: String = "",
    val artworkUri: Uri? = null,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val bufferedPercentage: Float = 0f,
    val playbackSpeed: Float = 1f,
    val chapterTitle: String? = null,
    val chapterProgress: Float = 0f
)
```

## 6. Migration Strategy

### Phase 1: Foundation (Week 1-2)
1. Add Media3 dependencies
2. Create new `AudiobookMediaService` alongside existing service
3. Implement `PlaybackRepository` with basic state management
4. Create `MediaItemBuilder` for both book types

### Phase 2: Core Implementation (Week 3-4)
1. Implement chapter navigation logic
2. Set up MediaSession callbacks
3. Integrate ExoPlayer with proper audio attributes
4. Create ViewModel layer with reactive state

### Phase 3: Cast Integration (Week 5)
1. Add CastPlayer setup
2. Implement player switching logic
3. Test Cast session handling
4. Ensure state persistence during switches

### Phase 4: Android Auto (Week 6)
1. Migrate browse tree to Media3 MediaLibraryService
2. Implement onGetChildren with new MediaItem structure
3. Test chapter browsing in Android Auto
4. Verify playback controls work correctly

### Phase 5: Testing & Migration (Week 7-8)
1. Comprehensive testing of all playback scenarios
2. A/B testing with feature flags
3. Gradual rollout to users
4. Remove legacy code

## 7. Key Improvements Over Current Architecture

1. **Unified State**: Single `PlaybackRepository` eliminates state synchronization issues
2. **Native Chapter Support**: MediaItem metadata and tags handle chapters elegantly
3. **Simplified Cast**: Automatic player switching without manual state management
4. **Reactive Architecture**: Kotlin Flow ensures UI always reflects current state
5. **Reduced Complexity**: Media3 handles Android Auto, notifications, and media buttons
6. **Better Performance**: ExoPlayer optimizations and proper buffering strategies
7. **Future-Proof**: Built on Google's latest media architecture

## 8. Testing Strategy

```kotlin
// Example test for chapter navigation
@Test
fun testSingleTrackChapterNavigation() {
    // Given a single-track book with 3 chapters
    val book = createTestBook(BookType.SINGLE_TRACK, chapterCount = 3)
    val mediaItems = mediaItemBuilder.buildBookMediaItem(book, book.chapters)

    // When playing and seeking to next chapter
    player.setMediaItems(mediaItems)
    player.prepare()
    player.play()

    chapterNavigationHandler.seekToNextChapter()

    // Then position should be at chapter 2 start
    assertEquals(book.chapters[1].startMs, player.currentPosition)
}

@Test
fun testMultiTrackChapterNavigation() {
    // Given a multi-track book
    val book = createTestBook(BookType.MULTI_TRACK, chapterCount = 3)
    val mediaItems = mediaItemBuilder.buildBookMediaItem(book, book.chapters)

    // When seeking to next chapter
    player.setMediaItems(mediaItems)
    player.prepare()
    player.play()

    chapterNavigationHandler.seekToNextChapter()

    // Then should move to next media item
    assertEquals(1, player.currentMediaItemIndex)
}
```

This architecture provides a clean, maintainable, and robust foundation for the audiobook application, fully leveraging Media3's capabilities while addressing all the pain points of the current implementation.
