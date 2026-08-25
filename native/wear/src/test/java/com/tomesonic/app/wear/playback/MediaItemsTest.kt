package com.tomesonic.app.wear.playback

import android.app.Application
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.data.ChapterMath
import com.tomesonic.app.wear.data.PlaySession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The player QUEUE — one media item per track, in track order, for both sources.
 *
 * Order and count are the whole game: media3 addresses positions by
 * (mediaItemIndex, positionInItem), so an item dropped or reordered here makes
 * every ChapterMath mapping — the scrubber, the chapter title, the syncer's
 * position — silently point at the wrong part of the book.
 *
 * Robolectric only for android.net.Uri and Bundle, which MediaItem/MediaMetadata
 * are built on; no Context is touched.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@androidx.annotation.OptIn(UnstableApi::class)
class MediaItemsTest {

    private fun track(index: Int, startOffset: Double, duration: Double, url: String) =
        AudioTrack(index, startOffset, duration, "Track $index", url, "audio/mpeg", "track_$index.mp3")

    private val streamedTracks = listOf(
        track(0, 0.0, 200.0, "/api/items/li_1/file/11"),
        track(1, 200.0, 200.0, "/api/items/li_1/file/12")
    )

    private val session = PlaySession(
        id = "sess_1",
        libraryItemId = "li_1",
        episodeId = null,
        mediaType = "book",
        displayTitle = "Dune",
        displayAuthor = "Frank Herbert",
        duration = 400.0,
        currentTime = 250.0,
        audioTracks = streamedTracks,
        chapters = emptyList()
    )

    private val localBook = LocalBook(
        itemId = "li_1",
        title = "Dune",
        author = "Frank Herbert",
        duration = 400.0,
        coverUri = "file:///data/user/0/app/files/downloads/li_1/cover.jpg",
        tracks = listOf(
            track(0, 0.0, 200.0, "file:///data/user/0/app/files/downloads/li_1/track_0.mp3"),
            track(1, 200.0, 200.0, "file:///data/user/0/app/files/downloads/li_1/track_1.mp3")
        )
    )

    private fun uriOf(index: Int, items: List<MediaItem>) =
        items[index].localConfiguration?.uri?.toString()

    // ---- streamed ----------------------------------------------------------

    @Test
    fun streamedTracksAreJoinedToTheServerOriginInOrder() {
        val items = MediaItems.forSession(session, { "http://abs.local$it" }, null)
        assertEquals(2, items.size)
        assertEquals("http://abs.local/api/items/li_1/file/11", uriOf(0, items))
        assertEquals("http://abs.local/api/items/li_1/file/12", uriOf(1, items))
    }

    @Test
    fun streamedItemsCarryTheBookTitleAuthorAndCover() {
        // The BOOK, not the track: this is what the media notification and every
        // connected controller display, and a per-track title would make the
        // watch's own media control read "Track 3".
        val items = MediaItems.forSession(session, { "http://abs.local$it" }, "http://abs.local/cover")
        val metadata = items[0].mediaMetadata
        assertEquals("Dune", metadata.title.toString())
        assertEquals("Frank Herbert", metadata.artist.toString())
        assertEquals("http://abs.local/cover", metadata.artworkUri.toString())
        assertEquals(metadata.title, items[1].mediaMetadata.title)
    }

    @Test
    fun mediaIdsAreUniqueAndPositional() {
        val items = MediaItems.forSession(session, { "http://abs.local$it" }, null)
        assertEquals("li_1:0:0", items[0].mediaId)
        assertEquals("li_1:1:1", items[1].mediaId)
    }

    @Test
    fun anUnresolvableTrackIsDroppedRatherThanQueuedBroken() {
        // Not configured -> AbsClient.resolve returns null. One broken entry
        // mid-queue stalls the whole book at that point.
        val items = MediaItems.forSession(session, { null }, null)
        assertEquals(0, items.size)
    }

    // ---- downloaded --------------------------------------------------------

    @Test
    fun downloadedTracksKeepTheirFileUrisInOrder() {
        val items = MediaItems.forLocal(localBook)
        assertEquals(2, items.size)
        assertEquals("file:///data/user/0/app/files/downloads/li_1/track_0.mp3", uriOf(0, items))
        assertEquals("file:///data/user/0/app/files/downloads/li_1/track_1.mp3", uriOf(1, items))
    }

    @Test
    fun downloadedItemsUseTheDownloadedCoverNotAServerUrl() {
        // A server cover url is dead offline and carries a token from download
        // time; the on-disk file is neither.
        val metadata = MediaItems.forLocal(localBook)[0].mediaMetadata
        assertEquals("Dune", metadata.title.toString())
        assertEquals("Frank Herbert", metadata.artist.toString())
        assertEquals("file:///data/user/0/app/files/downloads/li_1/cover.jpg", metadata.artworkUri.toString())
    }

    @Test
    fun aDownloadWithNoCoverSimplyHasNoArtwork() {
        val metadata = MediaItems.forLocal(localBook.copy(coverUri = null))[0].mediaMetadata
        assertNull(metadata.artworkUri)
    }

    // ---- resume mapping ----------------------------------------------------

    @Test
    fun resumeMapsAnAbsolutePositionOntoTheRightQueueEntry() {
        // What SessionManager.play feeds setMediaItems(items, index, positionMs).
        // 250s into a 2x200s book is 50s into the SECOND item, not 250s into the
        // first — the difference between resuming correctly and restarting.
        val target = ChapterMath.trackPositionAt(session.audioTracks, session.currentTime)!!
        assertEquals(1, target.trackIndex)
        assertEquals(50.0, target.positionSeconds, 1e-9)
    }

    @Test
    fun aFreshDownloadResumesAtTheStartOfTheFirstTrack() {
        val target = ChapterMath.trackPositionAt(localBook.tracks, 0.0)!!
        assertEquals(0, target.trackIndex)
        assertEquals(0.0, target.positionSeconds, 1e-9)
    }
}
