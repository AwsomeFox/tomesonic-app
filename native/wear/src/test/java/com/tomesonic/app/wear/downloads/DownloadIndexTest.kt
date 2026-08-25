package com.tomesonic.app.wear.downloads

import android.app.Application
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
 * `downloads_index.json` over a real file in a per-test temp folder.
 *
 * Robolectric because the serialisation goes through org.json (android.jar); the
 * index itself takes its File as a constructor argument precisely so a test can
 * own one. No coroutine test library (it isn't a dependency, deliberately) —
 * runBlocking is enough for plain suspend reads and writes.
 *
 * The cases that matter here are the failure ones: a watch is killed mid-write
 * routinely, and this file is the only record of what has been downloaded.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class DownloadIndexTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var file: File
    private lateinit var tmpFile: File
    private lateinit var badFile: File
    private lateinit var index: DownloadIndex

    private val dune = DownloadEntry(
        id = "li_book1",
        title = "Dune",
        author = "Frank Herbert",
        duration = 12345.5,
        coverPath = "/files/downloads/li_book1/cover.jpg",
        tracks = listOf(DownloadTrack("track_0.mp3", 0.0, 3600.0, "/api/items/li_book1/file/9001")),
        bytes = 700L
    )
    // copy() does NOT re-run `libraryItemId = id`'s default — a book's two ids
    // are the same string, so say both.
    private val ubik = dune.copy(id = "li_book2", libraryItemId = "li_book2", title = "Ubik", bytes = 300L)

    private val episode = DownloadEntry(
        id = "li_pod-ep-ep_42",
        title = "The Show",
        author = "Host Person",
        duration = 1800.0,
        coverPath = "/files/downloads/li_pod-ep-ep_42/cover.jpg",
        tracks = listOf(DownloadTrack("track_0.mp3", 0.0, 1800.0, "/api/items/li_pod/file/7001")),
        bytes = 500L,
        libraryItemId = "li_pod",
        episodeId = "ep_42",
        episodeTitle = "Episode 42"
    )

    @Before
    fun setUp() {
        file = File(tempFolder.root, "downloads_index.json")
        tmpFile = File(file.path + DownloadIndex.TMP_SUFFIX)
        badFile = File(file.path + DownloadIndex.BAD_SUFFIX)
        index = DownloadIndex(file)
    }

    // ---- the empty case ----------------------------------------------------

    @Test
    fun aFreshInstallHasNothingAndWritesNothing() = runBlocking {
        assertEquals(emptyList<DownloadEntry>(), index.all())
        assertEquals(emptyList<DownloadEntry>(), index.entries.first())
        assertEquals(0L, index.totalBytes())
        // Reading must not create the file: a cold start that never downloads
        // anything should leave filesDir untouched.
        assertFalse(file.exists())
    }

    // ---- round trip through disk -------------------------------------------

    @Test
    fun upsertWritesThroughAndAnIndependentIndexReadsItBack() = runBlocking {
        index.upsert(dune)
        index.upsert(ubik)

        val reopened = DownloadIndex(file)
        assertEquals(listOf(dune, ubik), reopened.all())
        assertEquals(dune, reopened.get("li_book1"))
        assertEquals(1000L, reopened.totalBytes())
    }

    @Test
    fun booksAndEpisodesShareOneFileAndOneKeyspace() = runBlocking {
        // One json array, as the contract says — the entry id is the only key,
        // and an episode's is simply a longer one.
        index.upsert(dune)
        index.upsert(episode)

        val reopened = DownloadIndex(file)
        assertEquals(listOf(dune, episode), reopened.all())
        assertEquals(episode, reopened.get("li_pod-ep-ep_42"))
        // The podcast itself was never downloaded, and its episode must not
        // answer for it.
        assertNull(reopened.get("li_pod"))
        assertEquals(1200L, reopened.totalBytes())
    }

    @Test
    fun removingAnEpisodeLeavesEveryOtherEntryAlone() = runBlocking {
        index.upsert(episode)
        index.upsert(episode.copy(id = "li_pod-ep-ep_43", episodeId = "ep_43", bytes = 400L))
        index.upsert(dune)

        index.remove("li_pod-ep-ep_42")

        assertEquals(listOf("li_pod-ep-ep_43", "li_book1"), DownloadIndex(file).all().map { it.id })
    }

    @Test
    fun theFlowSeedsItselfFromDiskOnFirstCollection() = runBlocking {
        file.writeText(DownloadEntry.toJsonArray(listOf(dune)).toString())
        // A brand-new index that has never been asked for anything.
        assertEquals(listOf(dune), DownloadIndex(file).entries.first())
    }

    @Test
    fun snapshotIsEmptyUntilWarmedAndThenAnswersWithoutSuspending() = runBlocking {
        file.writeText(DownloadEntry.toJsonArray(listOf(dune)).toString())
        val cold = DownloadIndex(file)
        // The trap the doc comment names: a synchronous read before the seed
        // reports "nothing downloaded".
        assertEquals(emptyList<DownloadEntry>(), cold.snapshot())
        cold.warm()
        assertEquals(listOf(dune), cold.snapshot())
        // Warming twice is a no-op, not a re-read.
        cold.warm()
        assertEquals(listOf(dune), cold.snapshot())
    }

    @Test
    fun snapshotTracksMutations() = runBlocking {
        index.warm()
        index.upsert(dune)
        assertEquals(listOf(dune), index.snapshot())
        index.remove("li_book1")
        assertEquals(emptyList<DownloadEntry>(), index.snapshot())
    }

    @Test
    fun upsertReplacesByIdRatherThanAppending() = runBlocking {
        index.upsert(dune)
        index.upsert(dune.copy(title = "Dune (remaster)", bytes = 999L))
        val entries = index.all()
        assertEquals(1, entries.size)
        assertEquals("Dune (remaster)", entries[0].title)
        assertEquals(999L, index.totalBytes())
        assertEquals(listOf("Dune (remaster)"), DownloadIndex(file).all().map { it.title })
    }

    @Test
    fun removeDropsTheEntryAndPersistsTheRemoval() = runBlocking {
        index.upsert(dune)
        index.upsert(ubik)
        index.remove("li_book1")
        assertEquals(listOf(ubik), index.all())
        assertEquals(listOf(ubik), DownloadIndex(file).all())
        // Removing something that was never there is a no-op, not a failure.
        index.remove("li_nope")
        assertEquals(listOf(ubik), index.all())
    }

    @Test
    fun totalBytesSumsEveryEntry() = runBlocking {
        assertEquals(0L, index.totalBytes())
        index.upsert(dune)
        assertEquals(700L, index.totalBytes())
        index.upsert(ubik)
        assertEquals(1000L, index.totalBytes())
        index.remove("li_book2")
        assertEquals(700L, index.totalBytes())
    }

    // ---- atomic write ------------------------------------------------------

    @Test
    fun aWriteLeavesOneCompleteFileAndNoTemp() = runBlocking {
        index.upsert(dune)
        assertTrue(file.isFile)
        // The temp is renamed INTO place, never left behind — a stale temp would
        // be read back as crash recovery content on the next cold start.
        assertFalse(tmpFile.exists())
        // ...and what landed is a complete document, not a prefix of one.
        assertEquals(listOf(dune), DownloadEntry.parseList(file.readText()))
    }

    @Test
    fun recoversFromTheTempWhenTheDestinationWentMissing() = runBlocking {
        // The kill window the rename exists to shrink: destination gone, the
        // fully-written temp still holding the previous complete list.
        tmpFile.writeText(DownloadEntry.toJsonArray(listOf(dune, ubik)).toString())
        assertFalse(file.exists())
        assertEquals(listOf(dune, ubik), DownloadIndex(file).all())
    }

    // ---- corruption --------------------------------------------------------

    @Test
    fun aCorruptFileIsQuarantinedAndTheWatchBehavesLikeAFreshInstall() = runBlocking {
        file.writeText("{ this is not an index")
        assertEquals(emptyList<DownloadEntry>(), index.all())
        // Moved aside rather than deleted: it is the only evidence of what went
        // wrong, and it costs one file's worth of space.
        assertTrue(badFile.isFile)
        assertEquals("{ this is not an index", badFile.readText())
        assertFalse(file.exists())
    }

    @Test
    fun theIndexKeepsWorkingAfterAQuarantine() = runBlocking {
        file.writeText("garbage")
        assertEquals(emptyList<DownloadEntry>(), index.all())
        index.upsert(dune)
        assertEquals(listOf(dune), DownloadIndex(file).all())
    }

    @Test
    fun aSecondQuarantineReplacesTheFirstRatherThanPilingUp() = runBlocking {
        file.writeText("garbage one")
        assertEquals(emptyList<DownloadEntry>(), DownloadIndex(file).all())
        file.writeText("garbage two")
        assertEquals(emptyList<DownloadEntry>(), DownloadIndex(file).all())
        assertEquals("garbage two", badFile.readText())
    }

    @Test
    fun aZeroLengthFileIsATruncatedWriteNotACorruptDocument() = runBlocking {
        // An empty list still serialises to "[]", so zero bytes means the write
        // never finished — nothing to quarantine, nothing to report.
        file.writeText("")
        assertEquals(emptyList<DownloadEntry>(), index.all())
        assertFalse(badFile.exists())
    }

    @Test
    fun aReadableFileWithOneBadRowLosesThatRowOnly() = runBlocking {
        file.writeText("""[{ "title": "no id" }, ${dune.toJson()}]""")
        assertEquals(listOf(dune), index.all())
        assertFalse(badFile.exists())
    }

    @Test
    fun anIndexUnderAMissingDirectoryStillWrites() = runBlocking {
        // filesDir exists in production, but the index file's parent may not on
        // the very first download of a fresh install.
        val nested = File(File(tempFolder.root, "a/b/c"), "downloads_index.json")
        val deep = DownloadIndex(nested)
        deep.upsert(dune)
        assertTrue(nested.isFile)
        assertEquals(listOf(dune), DownloadIndex(nested).all())
    }
}
