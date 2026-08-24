package com.tomesonic.app.wear.downloads

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkInfo
import kotlinx.coroutines.flow.first
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

/**
 * The repository's index-and-filesystem half, over a temp folder.
 *
 * Nothing here goes through WorkManager: `work-testing` is deliberately not a
 * dependency, so enqueue/cancel are exercised only for what they do to the
 * files and the index (the WorkManager call itself is best-effort and swallowed
 * — a download that can't be scheduled must still leave a consistent watch).
 * The state fold behind `status()` is tested directly, as a table.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class DownloadRepositoryTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var root: File
    private lateinit var index: DownloadIndex
    private lateinit var repo: DownloadRepository

    private val dune = DownloadEntry(
        id = "li_book1",
        title = "Dune",
        author = "Frank Herbert",
        duration = 7200.0,
        coverPath = null,
        tracks = listOf(DownloadTrack("track_0.mp3", 0.0, 3600.0, "/api/items/li_book1/file/9000")),
        bytes = 700L
    )
    private val ubik = dune.copy(id = "li_book2", title = "Ubik", bytes = 300L)

    @Before
    fun setUp() {
        root = File(tempFolder.root, "downloads")
        index = DownloadIndex(File(tempFolder.root, "downloads_index.json"))
        repo = DownloadRepository(ApplicationProvider.getApplicationContext<Application>(), index, root)
    }

    // ---- layout + local files ----------------------------------------------

    @Test
    fun itemFoldersFollowTheContractLayout() {
        assertEquals(File(root, "li_book1"), repo.itemDir("li_book1"))
    }

    @Test
    fun localFileResolvesDownloadedTracksAndTheCover() {
        val track = write("li_book1", "track_0.mp3", 128)
        val cover = write("li_book1", "cover.jpg", 64)
        assertEquals(track, repo.localFile("li_book1", "track_0.mp3"))
        assertEquals(cover, repo.localFile("li_book1", "cover.jpg"))
    }

    @Test
    fun localFileIsNullForAnythingThatIsNotThere() {
        write("li_book1", "track_0.mp3", 128)
        assertNull(repo.localFile("li_book1", "track_9.mp3"))
        assertNull(repo.localFile("li_nope", "track_0.mp3"))
        // A zero-byte leftover is not a playable file — a rerun re-fetches it.
        write("li_book1", "track_1.mp3", 0)
        assertNull(repo.localFile("li_book1", "track_1.mp3"))
        // ...and a directory is never a track.
        File(root, "li_book1/sub").mkdirs()
        assertNull(repo.localFile("li_book1", "sub"))
    }

    @Test
    fun localFileRefusesNamesThatWouldEscapeTheDownloadsTree() {
        write("li_book1", "track_0.mp3", 128)
        assertNull(repo.localFile("li_book1", "../li_book1/track_0.mp3"))
        assertNull(repo.localFile("../li_book1", "track_0.mp3"))
        assertNull(repo.localFile("li_book1", ""))
        assertNull(repo.localFile("", "track_0.mp3"))
    }

    // ---- index reads -------------------------------------------------------

    @Test
    fun entryForAndEntriesReadThroughTheIndex() = runBlocking {
        assertNull(repo.entryFor("li_book1"))
        assertEquals(emptyList<DownloadEntry>(), repo.entries.first())

        index.upsert(dune)
        index.upsert(ubik)

        assertEquals(dune, repo.entryFor("li_book1"))
        assertNull(repo.entryFor("li_nope"))
        assertEquals(listOf(dune, ubik), repo.entries.first())
    }

    @Test
    fun entryForNowAnswersOnceTheIndexIsWarm() = runBlocking {
        index.upsert(dune)
        val cold = DownloadRepository(
            ApplicationProvider.getApplicationContext<Application>(),
            DownloadIndex(File(tempFolder.root, "downloads_index.json")),
            root
        )
        // Wave 3A resolves a downloaded book from a plain function, so the
        // startup path has to warm the index or a downloaded book streams.
        assertNull(cold.entryForNow("li_book1"))
        cold.warm()
        assertEquals(dune, cold.entryForNow("li_book1"))
        assertNull(cold.entryForNow("li_nope"))
    }

    @Test
    fun totalBytesSumsEveryEntry() = runBlocking {
        assertEquals(0L, repo.totalBytes())
        index.upsert(dune)
        index.upsert(ubik)
        assertEquals(1000L, repo.totalBytes())
    }

    // ---- delete ------------------------------------------------------------

    @Test
    fun deleteRemovesTheWholeTreeAndTheIndexEntry() = runBlocking {
        write("li_book1", "track_0.mp3", 100)
        write("li_book1", "track_1.mp3.part", 40)
        write("li_book1", "cover.jpg", 30)
        File(root, "li_book1/extra").mkdirs()
        write("li_book1/extra", "notes.txt", 10)
        write("li_book2", "track_0.mp3", 100)
        index.upsert(dune)
        index.upsert(ubik)

        repo.delete("li_book1")

        assertFalse(repo.itemDir("li_book1").exists())
        assertNull(repo.entryFor("li_book1"))
        assertEquals(300L, repo.totalBytes())
        // The other book is untouched — eviction is per item.
        assertTrue(File(root, "li_book2/track_0.mp3").isFile)
        assertEquals(ubik, repo.entryFor("li_book2"))
    }

    @Test
    fun deletingSomethingThatIsNotThereIsANoOp() = runBlocking {
        repo.delete("li_never")
        assertEquals(emptyList<DownloadEntry>(), repo.entries.first())
        assertEquals(0L, repo.totalBytes())
    }

    @Test
    fun deleteRefusesAnItemIdThatWouldEscapeTheDownloadsTree() = runBlocking {
        val outside = File(tempFolder.root, "keep-me.txt")
        outside.writeText("not a download")
        root.mkdirs()

        repo.delete("..")

        assertTrue(outside.isFile)
        assertTrue(root.isDirectory)
    }

    // ---- cancel ------------------------------------------------------------

    @Test
    fun cancelDropsPartialsAndKeepsWhatAlreadyLanded() = runBlocking {
        val whole = write("li_book1", "track_0.mp3", 100)
        val partial = write("li_book1", "track_1.mp3.part", 40)
        index.upsert(dune)

        repo.cancel("li_book1")

        assertTrue(whole.isFile)
        assertFalse(partial.exists())
        // A cancel is not an eviction: the entry and the finished bytes stay, so
        // re-enqueueing resumes instead of starting over.
        assertEquals(dune, repo.entryFor("li_book1"))
    }

    // ---- status fold -------------------------------------------------------

    @Test
    fun liveWorkReportsItselfEvenOverAnExistingEntry() {
        assertEquals(
            DownloadStatus.Queued,
            DownloadRepository.statusFrom(hasEntry = false, state = WorkInfo.State.ENQUEUED, progress = 0)
        )
        assertEquals(
            DownloadStatus.Queued,
            DownloadRepository.statusFrom(hasEntry = true, state = WorkInfo.State.BLOCKED, progress = 0)
        )
        assertEquals(
            DownloadStatus.Downloading(42),
            DownloadRepository.statusFrom(hasEntry = false, state = WorkInfo.State.RUNNING, progress = 42)
        )
        assertEquals(
            DownloadStatus.Downloading(100),
            DownloadRepository.statusFrom(hasEntry = true, state = WorkInfo.State.RUNNING, progress = 140)
        )
        assertEquals(
            DownloadStatus.Downloading(0),
            DownloadRepository.statusFrom(hasEntry = false, state = WorkInfo.State.RUNNING, progress = -3)
        )
    }

    @Test
    fun anIndexEntryWinsOnceTheWorkIsFinishedOrForgotten() {
        // WorkManager prunes finished jobs; their absence must never un-download
        // a book that is sitting on the watch.
        assertEquals(
            DownloadStatus.Downloaded,
            DownloadRepository.statusFrom(hasEntry = true, state = null, progress = 0)
        )
        assertEquals(
            DownloadStatus.Downloaded,
            DownloadRepository.statusFrom(hasEntry = true, state = WorkInfo.State.SUCCEEDED, progress = 100)
        )
        // Even a FAILED retry over an already-downloaded book is still downloaded.
        assertEquals(
            DownloadStatus.Downloaded,
            DownloadRepository.statusFrom(hasEntry = true, state = WorkInfo.State.FAILED, progress = 0)
        )
    }

    @Test
    fun withoutAnEntryOnlyAFailureIsAFailure() {
        assertEquals(
            DownloadStatus.NotDownloaded,
            DownloadRepository.statusFrom(hasEntry = false, state = null, progress = 0)
        )
        assertEquals(
            DownloadStatus.Failed,
            DownloadRepository.statusFrom(hasEntry = false, state = WorkInfo.State.FAILED, progress = 0)
        )
        assertEquals(
            DownloadStatus.NotDownloaded,
            DownloadRepository.statusFrom(hasEntry = false, state = WorkInfo.State.CANCELLED, progress = 0)
        )
        // SUCCEEDED with no entry means the entry has since been deleted.
        assertEquals(
            DownloadStatus.NotDownloaded,
            DownloadRepository.statusFrom(hasEntry = false, state = WorkInfo.State.SUCCEEDED, progress = 100)
        )
    }

    @Test
    fun noJobAtAllDescribesNothing() {
        // WorkInfo is not constructed here on purpose: without `work-testing`
        // the only honest fixture is the empty one, and the interesting folds
        // are covered above by passing the state directly.
        assertNull(DownloadRepository.activeInfo(emptyList()))
    }

    private fun write(relativeDir: String, name: String, bytes: Int): File {
        val dir = File(root, relativeDir)
        dir.mkdirs()
        val file = File(dir, name)
        file.writeBytes(ByteArray(bytes))
        return file
    }
}
