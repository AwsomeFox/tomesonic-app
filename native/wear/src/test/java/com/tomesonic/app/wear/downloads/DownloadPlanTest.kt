package com.tomesonic.app.wear.downloads

import android.app.Application
import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.data.ItemDetail
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
        // A podcast, in practice: episode downloads are a documented v1 non-goal.
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
