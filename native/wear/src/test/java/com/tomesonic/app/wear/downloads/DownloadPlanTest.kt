package com.tomesonic.app.wear.downloads

import android.app.Application
import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.data.ItemDetail
import com.tomesonic.app.wear.data.PodcastEpisode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * DownloadWorker's PURE half: what it decides to fetch, where it writes, what it
 * skips, and how it counts bytes.
 *
 * There are no WorkManager tests here and there will not be: `work-testing` is
 * deliberately absent from the dependency set, so the job is tested AROUND
 * WorkManager rather than through it. Everything that matters about a download —
 * the URL, the target path, the resume decision, the accounting — is a pure
 * function of the expanded item and the folder, which is exactly why those
 * functions were split out of doWork.
 *
 * Robolectric only so the worker class (a CoroutineWorker) loads; nothing here
 * builds one, and no case touches a Context.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class DownloadPlanTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private val dir: File get() = File(tempFolder.root, "li_book1")

    /** An episode entry's own folder — never the podcast's (see buildEpisodePlan). */
    private val episodeDir: File get() = File(tempFolder.root, "li_pod-ep-ep_42")

    private fun episode(
        id: String = "ep_42",
        title: String = "Episode 42",
        duration: Double? = 1800.0,
        ino: String? = null,
        contentUrl: String? = null,
        size: Long? = null
    ) = PodcastEpisode(
        id = id,
        title = title,
        publishedAt = 1700000000000L,
        duration = duration,
        ino = ino,
        contentUrl = contentUrl,
        size = size
    )

    private fun track(
        index: Int,
        filename: String = "track_$index.mp3",
        contentUrl: String = "/api/items/li_book1/file/900$index",
        startOffset: Double = index * 3600.0,
        duration: Double = 3600.0
    ) = AudioTrack(
        index = index,
        startOffset = startOffset,
        duration = duration,
        title = "Part $index",
        contentUrl = contentUrl,
        mimeType = "audio/mpeg",
        filename = filename
    )

    private fun item(tracks: List<AudioTrack>) = ItemDetail(
        id = "li_book1",
        title = "Dune",
        authorName = "Frank Herbert",
        mediaType = "book",
        duration = 7200.0,
        size = 734003200L,
        chapters = emptyList(),
        tracks = tracks,
        episodes = emptyList(),
        userProgressCurrentTime = null
    )

    // ---- the plan ----------------------------------------------------------

    @Test
    fun plansOneDownloadPerTrackPlusTheCover() {
        val plan = DownloadWorker.buildPlan(
            item(listOf(track(0), track(1))),
            dir,
            "http://abs.local/api/items/li_book1/cover?width=240&format=webp"
        )!!

        assertEquals("li_book1", plan.itemId)
        assertEquals(2, plan.tracks.size)
        // URLs come straight off the track — Models.kt already resolved
        // contentUrl-or-/file/{ino}, and re-deriving it here is how the two
        // copies would drift.
        assertEquals("/api/items/li_book1/file/9000", plan.tracks[0].download.url)
        assertEquals("/api/items/li_book1/file/9001", plan.tracks[1].download.url)
        // ...and the on-disk layout is the contract's: downloads/{itemId}/{filename}.
        assertEquals(File(dir, "track_0.mp3"), plan.tracks[0].download.target)
        assertEquals(File(dir, "track_1.mp3"), plan.tracks[1].download.target)
        assertEquals(File(dir, "cover.jpg"), plan.cover!!.target)
        assertEquals(
            "http://abs.local/api/items/li_book1/cover?width=240&format=webp",
            plan.cover!!.url
        )
    }

    @Test
    fun carriesTheTrackMetadataTheIndexEntryNeeds() {
        val plan = DownloadWorker.buildPlan(item(listOf(track(0), track(1))), dir, null)!!
        assertEquals(3600.0, plan.tracks[1].track.startOffset, 1e-9)
        assertEquals(3600.0, plan.tracks[1].track.duration, 1e-9)
        assertEquals("track_1.mp3", plan.tracks[1].track.filename)
    }

    @Test
    fun partFilesSitBesideTheirTargetAndNeverReplaceIt() {
        val plan = DownloadWorker.buildPlan(item(listOf(track(0))), dir, null)!!
        val download = plan.tracks[0].download
        assertEquals("track_0.mp3.part", download.partFile.name)
        assertEquals(dir, download.partFile.parentFile)
        assertNotEquals(download.target, download.partFile)
    }

    @Test
    fun noCoverUrlMeansNoCoverInThePlan() {
        // AbsApi.coverUrl returns null when the watch has no server configured.
        assertNull(DownloadWorker.buildPlan(item(listOf(track(0))), dir, null)!!.cover)
        assertNull(DownloadWorker.buildPlan(item(listOf(track(0))), dir, "")!!.cover)
    }

    @Test
    fun anItemWithNoTracksHasNothingToDownload() {
        // A podcast, in practice: its audio lives on its episodes, which are
        // planned by buildEpisodePlan and downloaded one entry each.
        assertNull(DownloadWorker.buildPlan(item(emptyList()), dir, "http://abs.local/cover"))
    }

    @Test
    fun aTrackWithNeitherContentUrlNorInoHasNoPlan() {
        // Models.kt synthesises `/api/items/{id}/file/` for that row; downloading
        // it would 404 an endpoint that looks valid (the phone's downloadEpisode
        // rejects the same shape).
        assertNull(
            DownloadWorker.buildPlan(
                item(listOf(track(0), track(1, contentUrl = "/api/items/li_book1/file/"))),
                dir,
                null
            )
        )
        assertNull(
            DownloadWorker.buildPlan(item(listOf(track(0, contentUrl = ""))), dir, null)
        )
    }

    @Test
    fun aFilenameThatWouldEscapeTheFolderHasNoPlan() {
        // `filename` ends in a server-supplied extension; a hostile or mangled
        // one must not let a download write outside its own folder.
        assertNull(DownloadWorker.buildPlan(item(listOf(track(0, filename = "../evil.mp3"))), dir, null))
        assertNull(DownloadWorker.buildPlan(item(listOf(track(0, filename = "sub/track.mp3"))), dir, null))
        assertNull(DownloadWorker.buildPlan(item(listOf(track(0, filename = ".."))), dir, null))
        assertNull(DownloadWorker.buildPlan(item(listOf(track(0, filename = ""))), dir, null))
    }

    // ---- the episode plan --------------------------------------------------

    @Test
    fun anEpisodePlansItsOneFileAndItsOwnCover() {
        val plan = DownloadWorker.buildEpisodePlan(
            "li_pod",
            episode(contentUrl = "/api/items/li_pod/file/7001", size = 24_000_000L),
            episodeDir,
            "http://abs.local/api/items/li_pod/cover?width=240&format=webp"
        )!!

        assertEquals(1, plan.tracks.size)
        assertEquals("/api/items/li_pod/file/7001", plan.tracks[0].download.url)
        assertEquals(File(episodeDir, "track_0.mp3"), plan.tracks[0].download.target)
        assertEquals(24_000_000L, plan.tracks[0].download.expectedBytes)
        // The ownership rule: the cover lands in the EPISODE's folder, so
        // deleting the episode can never take the book's artwork (or the
        // reverse) and no entry needs a refcount.
        assertEquals(File(episodeDir, "cover.jpg"), plan.cover!!.target)
        assertEquals(episodeDir, plan.dir)
    }

    @Test
    fun anEpisodeCarriesTheTrackMetadataItsIndexEntryNeeds() {
        val plan = DownloadWorker.buildEpisodePlan(
            "li_pod",
            episode(duration = 1800.0, ino = "7001"),
            episodeDir,
            null
        )!!
        val track = plan.tracks[0].track
        assertEquals(0, track.index)
        assertEquals(0.0, track.startOffset, 1e-9)
        assertEquals(1800.0, track.duration, 1e-9)
        assertEquals("Episode 42", track.title)
        assertEquals("track_0.mp3", track.filename)
    }

    @Test
    fun anEpisodePrefersItsContentUrlAndFallsBackToTheInoEndpoint() {
        // utils/downloader.ts's order exactly: the direct-play url the server
        // exposes, else the file endpoint built from the ino.
        assertEquals(
            "/api/items/li_pod/file/7001",
            DownloadWorker.episodeUrl("li_pod", episode(contentUrl = "/api/items/li_pod/file/7001"))
        )
        assertEquals(
            "/s/item/li_pod/ep.m4a",
            DownloadWorker.episodeUrl(
                "li_pod",
                episode(contentUrl = "/s/item/li_pod/ep.m4a", ino = "7001")
            )
        )
        assertEquals(
            "/api/items/li_pod/file/7001",
            DownloadWorker.episodeUrl("li_pod", episode(ino = "7001"))
        )
    }

    @Test
    fun anEpisodeWithNoAudioAtAllHasNoPlan() {
        // Neither a contentUrl nor an ino: the fallback would be the empty-ino
        // `/file/` endpoint, which 404s an url that looks valid — the same bail
        // the phone's downloadEpisode makes.
        assertNull(DownloadWorker.episodeUrl("li_pod", episode()))
        assertNull(
            DownloadWorker.episodeUrl("li_pod", episode(contentUrl = "/api/items/li_pod/file/"))
        )
        assertNull(DownloadWorker.buildEpisodePlan("li_pod", episode(), episodeDir, "http://abs.local/cover"))
    }

    @Test
    fun anEpisodeFilenameTakesAPlausibleExtensionAndDefaultsToMp3() {
        // ABS's `/file/{ino}` endpoint names no format; a `/s/item/…` url does.
        assertEquals("track_0.mp3", DownloadWorker.episodeFilename("/api/items/li_pod/file/7001"))
        assertEquals("track_0.m4a", DownloadWorker.episodeFilename("/s/item/li_pod/ep.m4a"))
        assertEquals("track_0.m4a", DownloadWorker.episodeFilename("/s/item/li_pod/ep.M4A?token=x"))
        assertEquals("track_0.mp3", DownloadWorker.episodeFilename(null))
        assertEquals("track_0.mp3", DownloadWorker.episodeFilename(""))
        // Anything that isn't a short alphanumeric extension is not one: a
        // filename may never pick up a separator from a mangled url.
        assertEquals("track_0.mp3", DownloadWorker.episodeFilename("/s/item/li_pod/ep.something"))
        assertEquals("track_0.mp3", DownloadWorker.episodeFilename("/s/item/li_pod/2026.01.01/audio"))
        assertTrue(DownloadWorker.isSafeName(DownloadWorker.episodeFilename("/s/item/x/a.b%2Fc")))
    }

    @Test
    fun anEpisodeUniqueWorkNameIsNotItsPodcastsAndNotItsSiblings() {
        // A book download and two episode downloads of the same item have to be
        // able to coexist — one shared name would KEEP or REPLACE the wrong job.
        val book = DownloadWorker.uniqueWorkName(DownloadEntry.entryId("li_pod", null))
        val first = DownloadWorker.uniqueWorkName(DownloadEntry.entryId("li_pod", "ep_42"))
        val second = DownloadWorker.uniqueWorkName(DownloadEntry.entryId("li_pod", "ep_43"))
        assertEquals("download_li_pod", book)
        assertEquals("download_li_pod-ep-ep_42", first)
        assertNotEquals(book, first)
        assertNotEquals(first, second)
        // ...and so do their notifications.
        assertNotEquals(
            DownloadWorker.notificationId("li_pod"),
            DownloadWorker.notificationId("li_pod-ep-ep_42")
        )
    }

    // ---- name safety -------------------------------------------------------

    @Test
    fun safeNamesAreSinglePlainComponents() {
        assertTrue(DownloadWorker.isSafeName("track_0.mp3"))
        assertTrue(DownloadWorker.isSafeName("li_8Kd2mQ-x"))
        assertTrue(DownloadWorker.isSafeName("cover.jpg"))
        assertFalse(DownloadWorker.isSafeName(""))
        assertFalse(DownloadWorker.isSafeName("   "))
        assertFalse(DownloadWorker.isSafeName("."))
        assertFalse(DownloadWorker.isSafeName(".."))
        assertFalse(DownloadWorker.isSafeName("a/b"))
        assertFalse(DownloadWorker.isSafeName("../b"))
        assertFalse(DownloadWorker.isSafeName("a\\b"))
    }

    @Test
    fun resolveInsideRefusesWhatIsSafeNameRefuses() {
        assertEquals(File(dir, "track_0.mp3"), DownloadWorker.resolveInside(dir, "track_0.mp3"))
        assertNull(DownloadWorker.resolveInside(dir, "../track_0.mp3"))
        assertNull(DownloadWorker.resolveInside(dir, ""))
    }

    // ---- resume-by-rerun ---------------------------------------------------

    @Test
    fun anExistingTargetCountsAsCompleteWhenTheSizeIsUnknown() {
        // Bytes only get the final name after a verified stream, so any non-empty
        // target is complete by construction — that is the whole resume story.
        assertTrue(DownloadWorker.isComplete(existingBytes = 4_096L))
        assertTrue(DownloadWorker.isComplete(existingBytes = 1L, expectedBytes = 0L))
        // A missing file reports length 0, and so does a zero-byte leftover.
        assertFalse(DownloadWorker.isComplete(existingBytes = 0L))
        assertFalse(DownloadWorker.isComplete(existingBytes = 0L, expectedBytes = 4_096L))
    }

    @Test
    fun aKnownSizeMustMatchExactly() {
        assertTrue(DownloadWorker.isComplete(existingBytes = 4_096L, expectedBytes = 4_096L))
        assertFalse(DownloadWorker.isComplete(existingBytes = 4_095L, expectedBytes = 4_096L))
        assertFalse(DownloadWorker.isComplete(existingBytes = 4_097L, expectedBytes = 4_096L))
    }

    // ---- progress ----------------------------------------------------------

    @Test
    fun progressSpansWholeTracksPlusTheFractionOfTheCurrentOne() {
        assertEquals(0, DownloadWorker.trackProgress(0, 4, 0L, 0L))
        assertEquals(25, DownloadWorker.trackProgress(1, 4, 0L, 0L))
        // Half way through the second of four tracks.
        assertEquals(37, DownloadWorker.trackProgress(1, 4, 50L, 100L))
        assertEquals(100, DownloadWorker.trackProgress(4, 4, 0L, 0L))
    }

    @Test
    fun progressStaysInRangeWhenTheServerLies() {
        // No Content-Length, an over-long body, a bogus track count: none of
        // these may produce a bar outside 0..100.
        assertEquals(0, DownloadWorker.trackProgress(0, 1, 500L, -1L))
        assertEquals(0, DownloadWorker.trackProgress(0, 1, 500L, 100L))
        assertEquals(100, DownloadWorker.trackProgress(9, 4, 0L, 0L))
        assertEquals(0, DownloadWorker.trackProgress(-1, 4, 0L, 0L))
        assertEquals(0, DownloadWorker.trackProgress(1, 0, 0L, 0L))
    }

    // ---- bytes accounting + cleanup ---------------------------------------

    @Test
    fun bytesOnDiskCountsContentAndIgnoresPartials() {
        dir.mkdirs()
        write(File(dir, "track_0.mp3"), 100)
        write(File(dir, "track_1.mp3"), 250)
        write(File(dir, "cover.jpg"), 30)
        // A partial is not content yet; counting it would let a failed attempt
        // inflate the size the downloads screen reports.
        write(File(dir, "track_2.mp3.part"), 9_999)
        val nested = File(dir, "extra").also { it.mkdirs() }
        write(File(nested, "notes.txt"), 20)

        assertEquals(400L, DownloadWorker.bytesOnDisk(dir))
        // A folder that was never created is zero bytes, not a crash.
        assertEquals(0L, DownloadWorker.bytesOnDisk(File(tempFolder.root, "li_missing")))
    }

    @Test
    fun deletePartialsKeepsWholeTracks() {
        dir.mkdirs()
        val whole = File(dir, "track_0.mp3").also { write(it, 100) }
        val partial = File(dir, "track_1.mp3.part").also { write(it, 40) }
        val cover = File(dir, "cover.jpg").also { write(it, 30) }

        assertEquals(1, DownloadWorker.deletePartials(dir))
        assertTrue(whole.isFile)
        assertTrue(cover.isFile)
        assertFalse(partial.exists())
        // Idempotent, and safe on a folder that isn't there.
        assertEquals(0, DownloadWorker.deletePartials(dir))
        assertEquals(0, DownloadWorker.deletePartials(File(tempFolder.root, "li_missing")))
    }

    // ---- naming ------------------------------------------------------------

    @Test
    fun uniqueWorkNamesAreOnePerItem() {
        assertEquals("download_li_book1", DownloadWorker.uniqueWorkName("li_book1"))
        assertNotEquals(
            DownloadWorker.uniqueWorkName("li_book1"),
            DownloadWorker.uniqueWorkName("li_book2")
        )
    }

    @Test
    fun theNotificationNamesTheBookOnlyOnceItIsKnown() {
        assertEquals("Downloading", DownloadWorker.notificationTitle(null))
        assertEquals("Downloading", DownloadWorker.notificationTitle("  "))
        assertEquals("Downloading Dune", DownloadWorker.notificationTitle("Dune"))
    }

    @Test
    fun notificationIdsAreStableDistinctAndNeverZero() {
        val first = DownloadWorker.notificationId("li_book1")
        assertEquals(first, DownloadWorker.notificationId("li_book1"))
        assertNotEquals(first, DownloadWorker.notificationId("li_book2"))
        // 0 is rejected by the platform, and two concurrent downloads must not
        // overwrite each other's notification.
        assertNotEquals(0, first)
        assertTrue(first > 0)
        assertTrue(DownloadWorker.notificationId("") > 0)
    }

    private fun write(file: File, bytes: Int) {
        file.writeBytes(ByteArray(bytes))
    }
}
