package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.ItemSummary
import com.tomesonic.app.wear.data.LastItem
import com.tomesonic.app.wear.data.LibrarySummary
import com.tomesonic.app.wear.downloads.DownloadEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Home, assembled from fakes.
 *
 * Two behaviours are pinned here that the screen itself cannot state: which of
 * three sources describes the resume card (downloads win — they play with no
 * network), and that an offline watch still gets a working screen rather than an
 * error, with the same chips in the same order plus one quiet line.
 */
class HomeSectionsTest {

    private fun summary(
        id: String,
        title: String = "Title $id",
        author: String? = "Author $id",
        progress: Double? = null,
        episodeId: String? = null,
        mediaType: String = "book"
    ) = ItemSummary(
        id = id,
        title = title,
        authorName = author,
        mediaType = mediaType,
        progress = progress,
        episodeId = episodeId
    )

    private fun entry(id: String, title: String = "Downloaded $id") = DownloadEntry(
        id = id,
        title = title,
        author = "Local Author",
        duration = 3_600.0,
        coverPath = "/data/user/0/com.tomesonic.app/files/downloads/$id/cover.jpg",
        tracks = emptyList(),
        bytes = 1_048_576L
    )

    private fun library(id: String, mediaType: String = "book") =
        LibrarySummary(id = id, name = "Library $id", mediaType = mediaType)

    private fun episodeEntry(itemId: String, episodeId: String) = DownloadEntry(
        id = DownloadEntry.entryId(itemId, episodeId),
        title = "Podcast $itemId",
        author = null,
        duration = 1_800.0,
        coverPath = null,
        tracks = emptyList(),
        bytes = 4_096L,
        libraryItemId = itemId,
        episodeId = episodeId,
        episodeTitle = "Episode $episodeId"
    )

    // ---- the download affordance's state table ------------------------------

    @Test
    fun aBookWithItsEntryOnTheWatchReadsDownloaded() {
        assertEquals(
            HomeDownloadState.Downloaded,
            HomeSections.downloadState(listOf(entry("b")), emptySet(), "b", null)
        )
    }

    @Test
    fun aRequestedBookReadsRequestedUntilItsEntryExists() {
        val key = HomeSections.downloadKey("b", null)
        assertEquals(
            HomeDownloadState.Requested,
            HomeSections.downloadState(emptyList(), setOf(key), "b", null)
        )
        // The entry landing outranks the stale marker — no cleanup pass needed.
        assertEquals(
            HomeDownloadState.Downloaded,
            HomeSections.downloadState(listOf(entry("b")), setOf(key), "b", null)
        )
    }

    @Test
    fun anUntouchedBookOffersTheDownload() {
        assertEquals(
            HomeDownloadState.None,
            HomeSections.downloadState(emptyList(), emptySet(), "b", null)
        )
    }

    @Test
    fun aPodcastRowIsJudgedByItsEpisodeNotByTheItem() {
        // An item-level entry (or another episode's) must not make THIS row's
        // tap read as playable-offline — playback resolves by (item, episode).
        val itemLevel = listOf(entry("p"))
        val otherEpisode = listOf(episodeEntry("p", "ep-2"))
        assertEquals(
            HomeDownloadState.None,
            HomeSections.downloadState(itemLevel, emptySet(), "p", "ep-1")
        )
        assertEquals(
            HomeDownloadState.None,
            HomeSections.downloadState(otherEpisode, emptySet(), "p", "ep-1")
        )
        assertEquals(
            HomeDownloadState.Downloaded,
            HomeSections.downloadState(listOf(episodeEntry("p", "ep-1")), emptySet(), "p", "ep-1")
        )
    }

    @Test
    fun episodeKeysNeverCollideWithTheirPodcastsBookKey() {
        assertEquals("p", HomeSections.downloadKey("p", null))
        assertEquals("p", HomeSections.downloadKey("p", ""))
        assertTrue(HomeSections.downloadKey("p", "ep-1") != HomeSections.downloadKey("p", null))
    }

    // ---- resume -------------------------------------------------------------

    @Test
    fun nothingPlayedAndNothingInProgressHasNoResumeCard() {
        assertNull(HomeSections.resume(null, emptyList(), emptyList()))
    }

    @Test
    fun withNoLastItemTheFirstInProgressBookIsTheResume() {
        val target = HomeSections.resume(null, emptyList(), listOf(summary("a"), summary("b")))
        assertEquals("a", target?.itemId)
        assertEquals("Title a", target?.title)
    }

    @Test
    fun theLastItemThisWatchPlayedWinsOverListOrder() {
        val target = HomeSections.resume(
            LastItem("b", null),
            emptyList(),
            listOf(summary("a"), summary("b", progress = 0.5))
        )
        assertEquals("b", target?.itemId)
        assertEquals(0.5, target?.progress ?: -1.0, 1e-9)
    }

    @Test
    fun aDownloadedLastItemIsDescribedByTheIndexNotTheServer() {
        // The index answers with no network; the server row only adds progress.
        val target = HomeSections.resume(
            LastItem("c", null),
            listOf(entry("c")),
            listOf(summary("c", title = "Server Title", progress = 0.25))
        )
        assertEquals("Downloaded c", target?.title)
        assertEquals("Local Author", target?.author)
        assertEquals(0.25, target?.progress ?: -1.0, 1e-9)
        assertTrue(target?.downloaded == true)
        assertTrue(target?.coverPath?.endsWith("cover.jpg") == true)
    }

    @Test
    fun aDownloadedLastItemResumesWithNoServerRowAtAll() {
        val target = HomeSections.resume(LastItem("c", null), listOf(entry("c")), emptyList())
        assertEquals("c", target?.itemId)
        assertTrue(target?.downloaded == true)
        assertNull(target?.progress)
    }

    @Test
    fun anUnknownLastItemLeavesTheFetchToTheCaller() {
        // Null, NOT the first in-progress row: falling back would resume a
        // different book than the one this watch was playing.
        assertNull(HomeSections.resume(LastItem("z", null), emptyList(), listOf(summary("a"))))
    }

    @Test
    fun theEpisodeOfAPodcastResumeSurvives() {
        val fromLast = HomeSections.resume(
            LastItem("p", "ep-9"),
            listOf(entry("p")),
            emptyList()
        )
        assertEquals("ep-9", fromLast?.episodeId)

        val fromInProgress = HomeSections.resume(
            null,
            emptyList(),
            listOf(summary("p", mediaType = "podcast", episodeId = "ep-3"))
        )
        assertEquals("ep-3", fromInProgress?.episodeId)
    }

    // ---- ordering -----------------------------------------------------------

    @Test
    fun rowsComeOutInTheContractsOrder() {
        val resume = HomeSections.resume(null, emptyList(), listOf(summary("a")))
        val rows = HomeSections.build(
            resume = resume,
            inProgress = listOf(summary("a"), summary("b")),
            libraries = listOf(library("lib-books"), library("lib-pods", "podcast")),
            downloadCount = 3,
            offline = false
        )

        assertEquals(
            listOf(
                "Resume",
                "ContinueHeader",
                "Continue:b",
                "Downloads:3",
                "Library:lib-books",
                "Library:lib-pods",
                "Settings"
            ),
            rows.map { describe(it) }
        )
    }

    @Test
    fun theResumeBookIsNotRepeatedInContinueListening() {
        val resume = HomeSections.resume(LastItem("b", null), emptyList(), listOf(summary("a"), summary("b")))
        val rows = HomeSections.build(resume, listOf(summary("a"), summary("b")), emptyList(), 0, false)
        assertEquals(listOf("Continue:a"), rows.map { describe(it) }.filter { it.startsWith("Continue:") })
    }

    @Test
    fun noInProgressMeansNoSectionHeader() {
        val rows = HomeSections.build(null, emptyList(), listOf(library("lib")), 0, false)
        assertEquals(listOf("Downloads:0", "Library:lib", "Settings"), rows.map { describe(it) })
    }

    @Test
    fun continueListeningIsCapped() {
        val many = (1..20).map { summary("i$it") }
        val rows = HomeSections.build(null, many, emptyList(), 0, false)
        assertEquals(
            HomeSections.MAX_CONTINUE,
            rows.count { it is HomeRow.Continue }
        )
    }

    @Test
    fun offlineKeepsDownloadsAndSettingsAndAddsOneLine() {
        // The whole point: no server means no libraries, not a broken screen.
        val resume = HomeSections.resume(LastItem("c", null), listOf(entry("c")), emptyList())
        val rows = HomeSections.build(resume, emptyList(), emptyList(), 1, offline = true)
        assertEquals(
            listOf("Resume", "Offline", "Downloads:1", "Settings"),
            rows.map { describe(it) }
        )
    }

    private fun describe(row: HomeRow): String = when (row) {
        is HomeRow.Resume -> "Resume"
        HomeRow.ContinueHeader -> "ContinueHeader"
        is HomeRow.Continue -> "Continue:${row.item.id}"
        HomeRow.Offline -> "Offline"
        is HomeRow.Downloads -> "Downloads:${row.count}"
        is HomeRow.Library -> "Library:${row.library.id}"
        HomeRow.Settings -> "Settings"
    }
}
