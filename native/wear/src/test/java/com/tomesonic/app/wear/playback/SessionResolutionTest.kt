package com.tomesonic.app.wear.playback

import android.app.Application
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.media3.common.util.UnstableApi
import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.data.CredsRepository
import com.tomesonic.app.wear.data.PlaySession
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.time.ZoneId

/**
 * The local-vs-stream decision — the one rule this wave exists to enforce:
 * a DOWNLOADED book (or, since v2, a downloaded EPISODE) always plays its own
 * files and never touches the network, and everything else requires the network.
 * An episode resolves against its OWN entry, so neither a downloaded podcast nor
 * a downloaded sibling episode can make it play the wrong audio.
 *
 * Tested through SessionManager.resolve, which is deliberately player-free: the
 * decision, the queue it produces and the resume point it picks are all
 * checkable without an ExoPlayer or a server.
 *
 * Robolectric for DataStore's codec and for android.net.Uri inside MediaItem.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@androidx.annotation.OptIn(UnstableApi::class)
class SessionResolutionTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var creds: CredsRepository
    private lateinit var queue: OfflineProgressQueue

    /** Records whether the network leg was even attempted. */
    private var openedSessions = mutableListOf<Pair<String, String?>>()
    private var serverAnswer: PlaySession? = null

    @Before
    fun setUp() {
        val file = File(tempFolder.root, "wear.preferences_pb")
        creds = CredsRepository(PreferenceDataStoreFactory.create(produceFile = { file }))
        queue = OfflineProgressQueue(
            credsRepository = creds,
            clock = { 0L },
            zone = { ZoneId.of("UTC") },
            clientVersion = { "1.2.3" }
        )
        openedSessions = mutableListOf()
        serverAnswer = null
    }

    private fun track(index: Int, startOffset: Double, duration: Double, url: String) =
        AudioTrack(index, startOffset, duration, "Track $index", url, "audio/mpeg", "track_$index.mp3")

    private val downloaded = LocalBook(
        itemId = "li_1",
        title = "Dune",
        author = "Frank Herbert",
        duration = 400.0,
        coverUri = "file:///files/downloads/li_1/cover.jpg",
        tracks = listOf(
            track(0, 0.0, 200.0, "file:///files/downloads/li_1/track_0.mp3"),
            track(1, 200.0, 200.0, "file:///files/downloads/li_1/track_1.mp3")
        )
    )

    private fun streamed(currentTime: Double = 250.0, tracks: List<AudioTrack> = streamTracks) = PlaySession(
        id = "sess_1",
        libraryItemId = "li_1",
        episodeId = null,
        mediaType = "book",
        displayTitle = "Dune",
        displayAuthor = "Frank Herbert",
        duration = 400.0,
        currentTime = currentTime,
        audioTracks = tracks,
        chapters = emptyList()
    )

    private val streamTracks = listOf(
        track(0, 0.0, 200.0, "/api/items/li_1/file/11"),
        track(1, 200.0, 200.0, "/api/items/li_1/file/12")
    )

    private val downloadedEpisode = LocalBook(
        itemId = "li_1",
        // What DownloadsLocalSource builds for an episode entry: the EPISODE's
        // title (the notification names what is playing), the podcast's author.
        title = "Episode 42",
        author = "Host Person",
        duration = 1800.0,
        coverUri = "file:///files/downloads/li_1-ep-ep_42/cover.jpg",
        tracks = listOf(track(0, 0.0, 1800.0, "file:///files/downloads/li_1-ep-ep_42/track_0.mp3"))
    )

    /**
     * A source holding ONE episode and no book — the shape DownloadsLocalSource
     * has when a single episode of a never-downloaded podcast is on the watch.
     */
    private fun episodeSource(onlyEpisode: String, book: LocalBook) = object : LocalPlaybackSource {
        override fun localBook(itemId: String): LocalBook? = null

        override fun localEpisode(itemId: String, episodeId: String): LocalBook? =
            book.takeIf { episodeId == onlyEpisode }
    }

    private suspend fun resolve(
        itemId: String = "li_1",
        episodeId: String? = null,
        local: LocalBook? = null
    ) = resolveWith(
        itemId = itemId,
        episodeId = episodeId,
        // The SAM form is v1's whole world: books on disk, nothing episodic.
        source = local?.let { book -> LocalPlaybackSource { book } }
    )

    private suspend fun resolveWith(
        itemId: String = "li_1",
        episodeId: String? = null,
        source: LocalPlaybackSource?
    ) = SessionManager.resolve(
        itemId = itemId,
        episodeId = episodeId,
        credsRepository = creds,
        queue = queue,
        local = source,
        openSession = { id, ep ->
            openedSessions.add(id to ep)
            serverAnswer
        },
        coverUrl = { "http://abs.local/api/items/$it/cover?width=240&format=webp" },
        resolveUrl = { "http://abs.local$it" }
    )

    private suspend fun login() = creds.set("http://abs.local", "tok", "u1", "tony")

    // ---- downloaded --------------------------------------------------------

    @Test
    fun aDownloadedBookPlaysItsOwnFilesAndNeverOpensAServerSession() = runBlocking {
        login()
        val ready = resolve(local = downloaded) as SessionManager.Resolution.Ready

        // The whole point: no /play round trip, so a downloaded book behaves the
        // same online and offline.
        assertTrue(openedSessions.isEmpty())
        assertNull(ready.session.serverSessionId)
        assertTrue(ready.session.isLocal)
        assertEquals(2, ready.items.size)
        assertEquals(
            "file:///files/downloads/li_1/track_0.mp3",
            ready.items[0].localConfiguration?.uri?.toString()
        )
        assertEquals("file:///files/downloads/li_1/cover.jpg", ready.session.coverUri)
    }

    @Test
    fun aDownloadedBookPlaysWithNoCredentialsAtAll() = runBlocking {
        // Logged out (or creds not yet delivered from the phone) must not block
        // audio that is already on the watch.
        val ready = resolve(local = downloaded)
        assertTrue(ready is SessionManager.Resolution.Ready)
    }

    @Test
    fun aDownloadedBookResumesFromItsOwnLocalMarker() = runBlocking {
        login()
        queue.setResume("li_1", null, 137.5)
        val ready = resolve(local = downloaded) as SessionManager.Resolution.Ready
        assertEquals(137.5, ready.startSeconds, 1e-9)
    }

    @Test
    fun aDownloadedBookNeverPlayedStartsAtZero() = runBlocking {
        login()
        val ready = resolve(local = downloaded) as SessionManager.Resolution.Ready
        assertEquals(0.0, ready.startSeconds, 1e-9)
    }

    @Test
    fun aDownloadWithNoTracksIsNoTracksNotASilentStream() = runBlocking {
        login()
        val empty = downloaded.copy(tracks = emptyList())
        val failed = resolve(local = empty) as SessionManager.Resolution.Failed
        assertEquals(PlayResult.NoTracks, failed.result)
        assertTrue(openedSessions.isEmpty())
    }

    @Test
    fun aDownloadedBookWithNoStoredDurationSumsItsTracks() = runBlocking {
        login()
        val ready = resolve(local = downloaded.copy(duration = 0.0)) as SessionManager.Resolution.Ready
        assertEquals(400.0, ready.session.duration, 1e-9)
    }

    @Test
    fun aPodcastEpisodeStreamsEvenWhenTheItemIsDownloaded() = runBlocking {
        // A downloaded ITEM is not a downloaded EPISODE: the two are separate
        // entries, so an itemId hit must not be mistaken for "this episode is on
        // disk". (This is also every v1 source, which resolves books only.)
        login()
        serverAnswer = streamed()
        val ready = resolve(episodeId = "ep_9", local = downloaded) as SessionManager.Resolution.Ready
        assertEquals(listOf("li_1" to "ep_9"), openedSessions)
        assertEquals("sess_1", ready.session.serverSessionId)
    }

    // ---- downloaded episodes -----------------------------------------------

    @Test
    fun aDownloadedEpisodePlaysItsOwnFileAndNeverOpensAServerSession() = runBlocking {
        login()
        val ready = resolveWith(
            episodeId = "ep_42",
            source = episodeSource("ep_42", downloadedEpisode)
        ) as SessionManager.Resolution.Ready

        assertTrue(openedSessions.isEmpty())
        assertNull(ready.session.serverSessionId)
        assertTrue(ready.session.isLocal)
        assertEquals(1, ready.items.size)
        assertEquals(
            "file:///files/downloads/li_1-ep-ep_42/track_0.mp3",
            ready.items[0].localConfiguration?.uri?.toString()
        )
        assertEquals("Episode 42", ready.session.title)
    }

    @Test
    fun aDownloadedEpisodeKeepsItsEpisodeIdAndPodcastMediaType() = runBlocking {
        // Both are read straight off the session by ProgressSyncer: the episode
        // id keys the offline queues (`wear-local_<item>-<ep>_<date>`) and the
        // media type is what ABS files the local session under.
        login()
        val ready = resolveWith(
            episodeId = "ep_42",
            source = episodeSource("ep_42", downloadedEpisode)
        ) as SessionManager.Resolution.Ready
        assertEquals("li_1", ready.session.itemId)
        assertEquals("ep_42", ready.session.episodeId)
        assertEquals("podcast", ready.session.mediaType)
    }

    @Test
    fun aDownloadedEpisodePlaysWithNoCredentialsAtAll() = runBlocking {
        val ready = resolveWith(
            episodeId = "ep_42",
            source = episodeSource("ep_42", downloadedEpisode)
        )
        assertTrue(ready is SessionManager.Resolution.Ready)
        assertTrue(openedSessions.isEmpty())
    }

    @Test
    fun aDownloadedEpisodeResumesFromItsOwnMarkerNotThePodcasts() = runBlocking {
        login()
        queue.setResume("li_1", null, 500.0)
        queue.setResume("li_1", "ep_42", 137.5)
        val ready = resolveWith(
            episodeId = "ep_42",
            source = episodeSource("ep_42", downloadedEpisode)
        ) as SessionManager.Resolution.Ready
        assertEquals(137.5, ready.startSeconds, 1e-9)
    }

    @Test
    fun anotherEpisodeOfTheSamePodcastStillStreams() = runBlocking {
        // One episode on disk must not make the whole feed look local.
        login()
        serverAnswer = streamed()
        val ready = resolveWith(
            episodeId = "ep_43",
            source = episodeSource("ep_42", downloadedEpisode)
        ) as SessionManager.Resolution.Ready
        assertEquals(listOf("li_1" to "ep_43"), openedSessions)
        assertEquals("sess_1", ready.session.serverSessionId)
    }

    @Test
    fun aBlankEpisodeIdIsTheBookNotAnEpisode() = runBlocking {
        // The repository's null-or-blank convention, on the playback side: an
        // empty string must not go looking for an episode entry.
        login()
        val source = object : LocalPlaybackSource {
            override fun localBook(itemId: String): LocalBook? = downloaded
            override fun localEpisode(itemId: String, episodeId: String): LocalBook? = null
        }
        val ready = resolveWith(episodeId = "", source = source) as SessionManager.Resolution.Ready
        assertNull(ready.session.episodeId)
        assertEquals("book", ready.session.mediaType)
        assertTrue(openedSessions.isEmpty())
    }

    @Test
    fun offlineChaptersAreDerivedFromTracksOnlyWhenThereIsMoreThanOne() {
        // DownloadEntry carries no chapter list; for a multi-file audiobook the
        // files ARE the chapters, which keeps prev/next working offline.
        val derived = SessionManager.localChapters(downloaded.tracks)
        assertEquals(2, derived.size)
        assertEquals(0.0, derived[0].start, 1e-9)
        assertEquals(200.0, derived[0].end, 1e-9)
        assertEquals(200.0, derived[1].start, 1e-9)
        assertEquals(400.0, derived[1].end, 1e-9)
        // One file: nothing to navigate, so no bogus whole-book "chapter".
        assertTrue(SessionManager.localChapters(downloaded.tracks.take(1)).isEmpty())
    }

    // ---- streamed ----------------------------------------------------------

    @Test
    fun aNonDownloadedItemWithoutCredentialsIsNotConfigured() = runBlocking {
        val failed = resolve() as SessionManager.Resolution.Failed
        assertEquals(PlayResult.NotConfigured, failed.result)
        // No point asking a server we have no address for.
        assertTrue(openedSessions.isEmpty())
    }

    @Test
    fun aNonDownloadedItemWithNoServerAnswerNeedsNetwork() = runBlocking {
        login()
        serverAnswer = null
        val failed = resolve() as SessionManager.Resolution.Failed
        assertEquals(PlayResult.NeedsNetwork, failed.result)
        assertEquals(1, openedSessions.size)
    }

    @Test
    fun aSessionWithNoAudioTracksIsNoTracks() = runBlocking {
        login()
        serverAnswer = streamed(tracks = emptyList())
        val failed = resolve() as SessionManager.Resolution.Failed
        assertEquals(PlayResult.NoTracks, failed.result)
    }

    @Test
    fun aStreamedItemBuildsAuthorizedUrlsAndResumesFromTheServerPosition() = runBlocking {
        login()
        serverAnswer = streamed(currentTime = 250.0)
        val ready = resolve() as SessionManager.Resolution.Ready

        assertEquals("sess_1", ready.session.serverSessionId)
        assertFalse(ready.session.isLocal)
        assertEquals(250.0, ready.startSeconds, 1e-9)
        assertEquals(
            "http://abs.local/api/items/li_1/file/11",
            ready.items[0].localConfiguration?.uri?.toString()
        )
        assertEquals(
            "http://abs.local/api/items/li_1/cover?width=240&format=webp",
            ready.session.coverUri
        )
    }

    @Test
    fun aStreamedItemCarriesTheServersChapterAndTrackTables() = runBlocking {
        // The syncer maps (mediaItemIndex, position) back to book seconds through
        // these; an empty track list would pin every sync at 0.
        login()
        serverAnswer = streamed()
        val ready = resolve() as SessionManager.Resolution.Ready
        assertEquals(streamTracks, ready.session.tracks)
        assertEquals("Dune", ready.session.title)
        assertEquals("Frank Herbert", ready.session.author)
        assertEquals(400.0, ready.session.duration, 1e-9)
    }
}
