package com.tomesonic.app.automotive.downloads

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
 * — a download that can't be scheduled must still leave a consistent car).
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
    // copy() does NOT re-run `libraryItemId = id`'s default, and a book whose
    // two ids disagree is not a shape the worker can write — so say both.
    private val ubik = dune.copy(id = "li_book2", libraryItemId = "li_book2", title = "Ubik", bytes = 300L)

    private val episode = DownloadEntry(
        id = "li_pod-ep-ep_42",
        title = "The Show",
        author = "Host Person",
        duration = 1800.0,
        coverPath = null,
        tracks = listOf(DownloadTrack("track_0.mp3", 0.0, 1800.0, "/api/items/li_pod/file/7001")),
        bytes = 500L,
        libraryItemId = "li_pod",
        episodeId = "ep_42",
        episodeTitle = "Episode 42"
    )

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
        // Playback resolves a downloaded book from a plain function, so the
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

    // ---- episode entries ---------------------------------------------------

    @Test
    fun anEpisodeIsFoundByItsOwnKeyAndNeverByTheItemsAlone() = runBlocking {
        index.upsert(episode)

        assertEquals(episode, repo.entryFor("li_pod", "ep_42"))
        // The frozen single-argument call is the BOOK's, and the podcast itself
        // was never downloaded — one downloaded episode must not make its whole
        // podcast look local (which would stream nothing and play one file).
        assertNull(repo.entryFor("li_pod"))
        assertNull(repo.entryFor("li_pod", null))
        assertNull(repo.entryFor("li_pod", "ep_43"))
        // ...and an episode's key is not an item id either.
        assertNull(repo.entryFor("li_pod-ep-ep_42"))
    }

    @Test
    fun aDownloadedBookAndItsOwnEpisodesCoexist() = runBlocking {
        // The book answer for the item must survive an episode of the same item
        // being downloaded beside it.
        index.upsert(dune)
        index.upsert(episode.copy(id = "li_book1-ep-ep_1", libraryItemId = "li_book1", episodeId = "ep_1"))

        assertEquals(dune, repo.entryFor("li_book1"))
        assertEquals("li_book1-ep-ep_1", repo.entryFor("li_book1", "ep_1")?.id)
        assertNull(repo.entryFor("li_book1", "ep_2"))
    }

    @Test
    fun entryForNowAnswersForEpisodesOnceWarmed() = runBlocking {
        index.upsert(episode)
        val cold = DownloadRepository(
            ApplicationProvider.getApplicationContext<Application>(),
            DownloadIndex(File(tempFolder.root, "downloads_index.json")),
            root
        )
        assertNull(cold.entryForNow("li_pod", "ep_42"))
        cold.warm()
        assertEquals(episode, cold.entryForNow("li_pod", "ep_42"))
        assertNull(cold.entryForNow("li_pod"))
    }

    @Test
    fun anEpisodesFilesLiveUnderItsOwnEntryFolder() {
        // The ownership rule the delete depends on: one folder per entry, keyed
        // by the entry id, never shared with the book's.
        assertEquals(File(root, "li_pod-ep-ep_42"), repo.itemDir("li_pod-ep-ep_42"))
        val audio = write("li_pod-ep-ep_42", "track_0.mp3", 128)
        assertEquals(audio, repo.localFile("li_pod-ep-ep_42", "track_0.mp3"))
        assertNull(repo.localFile("li_pod", "track_0.mp3"))
    }

    @Test
    fun deletingAnEpisodeTakesNothingElseWithIt() = runBlocking {
        write("li_pod", "cover.jpg", 30)
        write("li_pod", "track_0.mp3", 100)
        write("li_pod-ep-ep_42", "cover.jpg", 30)
        write("li_pod-ep-ep_42", "track_0.mp3", 100)
        write("li_pod-ep-ep_43", "track_0.mp3", 100)
        val podcastBook = dune.copy(id = "li_pod", libraryItemId = "li_pod", bytes = 130L)
        index.upsert(podcastBook)
        index.upsert(episode)
        index.upsert(episode.copy(id = "li_pod-ep-ep_43", episodeId = "ep_43", bytes = 100L))

        repo.delete("li_pod", "ep_42")

        assertFalse(repo.itemDir("li_pod-ep-ep_42").exists())
        assertNull(repo.entryFor("li_pod", "ep_42"))
        // The book's own cover — the file an entry-shared cover would have taken
        // — and the sibling episode are untouched.
        assertTrue(File(root, "li_pod/cover.jpg").isFile)
        assertTrue(File(root, "li_pod-ep-ep_43/track_0.mp3").isFile)
        assertEquals(podcastBook, repo.entryFor("li_pod"))
        assertEquals(230L, repo.totalBytes())
    }

    @Test
    fun deletingTheItemDeletesTheBookAndLeavesItsEpisodesAlone() = runBlocking {
        // delete(itemId, null) is the frozen call: evicting a podcast's episodes
        // is a per-episode act, so nothing here may cascade.
        write("li_pod", "track_0.mp3", 100)
        write("li_pod-ep-ep_42", "track_0.mp3", 100)
        index.upsert(dune.copy(id = "li_pod", libraryItemId = "li_pod", bytes = 100L))
        index.upsert(episode)

        repo.delete("li_pod")

        assertFalse(repo.itemDir("li_pod").exists())
        assertTrue(File(root, "li_pod-ep-ep_42/track_0.mp3").isFile)
        assertEquals(episode, repo.entryFor("li_pod", "ep_42"))
    }

    @Test
    fun cancellingAnEpisodeDropsOnlyItsOwnPartials() = runBlocking {
        val bookPartial = write("li_pod", "track_0.mp3.part", 40)
        val episodeWhole = write("li_pod-ep-ep_42", "track_0.mp3", 100)
        val episodePartial = write("li_pod-ep-ep_42", "track_1.mp3.part", 40)

        repo.cancel("li_pod", "ep_42")

        assertTrue(episodeWhole.isFile)
        assertFalse(episodePartial.exists())
        assertTrue(bookPartial.isFile)
    }

    @Test
    fun anEpisodeOfAnUnsafeItemIdIsRefusedLikeAnUnsafeBook() = runBlocking {
        val outside = File(tempFolder.root, "keep-me.txt")
        outside.writeText("not a download")
        root.mkdirs()

        repo.delete("..", "ep_42")
        repo.enqueue("..", "ep_42")
        repo.cancel("..", "ep_42")

        assertTrue(outside.isFile)
        assertTrue(root.isDirectory)
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
        // a book that is sitting on the head unit.
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
