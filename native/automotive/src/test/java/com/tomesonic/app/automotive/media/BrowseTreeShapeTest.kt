package com.tomesonic.app.automotive.media

import android.app.Application
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.test.core.app.ApplicationProvider
import com.tomesonic.app.automotive.data.ItemDetail
import com.tomesonic.app.automotive.data.PodcastEpisode
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The SHAPE of the browse tree: which node yields which children, in which
 * order, built from which request.
 *
 * There was no single donor test for this — the phone module could not reach
 * the tree at all (its callbacks take non-null media3 session parameters, which
 * Kotlin's null-check intrinsics reject reflectively), so the shipped tree's
 * shape was only ever verified in a car. The seam this module builds on
 * ([BrowseApi]) is what makes it assertable, and the assertions are the donor's
 * behaviour read off `absLoadChildrenUncached`: the four root folders, the six
 * library categories, alphabetical everywhere except Recently Added, the
 * ebook-only filter, and the exact filter/sort each list asks the server for.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class BrowseTreeShapeTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val api = FakeBrowseApi()
    private lateinit var tree: BrowseTree

    @Before
    fun setUp() {
        tree = BrowseTree(context = context, api = api)
    }

    @After
    fun tearDown() {
        tree.release()
    }

    private fun ids(parentId: String): List<String> = tree.loadChildren(parentId).map { it.mediaId }

    private fun titles(parentId: String): List<String> =
        tree.loadChildren(parentId).map { it.mediaMetadata.title.toString() }

    private fun MediaItem.artist(): String = mediaMetadata.artist.toString()

    // ---- The root and the library level ----------------------------------

    @Test
    fun rootIsTheFourFixedFolders() {
        assertEquals(
            listOf("__CONTINUE__", "__CONTINUE_SERIES__", "__DOWNLOADS__", "__LIBRARIES__"),
            ids("__ROOT__")
        )
        assertEquals(
            listOf("Continue Listening", "Continue Series", "Downloads", "Libraries"),
            titles("__ROOT__")
        )
    }

    @Test
    fun librariesAreAlphabeticalAndKeepTheirMediaType() {
        api.librariesAnswer = jsonArray(
            libraryRow("l2", "Zed Library", "podcast", icon = "microphone-1"),
            libraryRow("l1", "Alpha Library", "book", icon = "books-1")
        )
        assertEquals(listOf("lib:l1:book", "lib:l2:podcast"), ids("__LIBRARIES__"))
    }

    @Test
    fun aPodcastLibraryOpensIntoAGridOfShows() {
        api.librariesAnswer = jsonArray(libraryRow("l2", "Shows", "podcast"))
        val podcastFolder = tree.loadChildren("__LIBRARIES__").single()
        val extras = requireNotNull(podcastFolder.mediaMetadata.extras)
        // Podcast libraries skip the category level entirely, so their children
        // (the shows) are browsable tiles rather than a tinted list.
        assertEquals(
            BrowseStyles.STYLE_GRID,
            extras.getInt(BrowseStyles.CONTENT_STYLE_BROWSABLE_HINT)
        )

        api.itemsAnswer = {
            jsonArray(itemRow("p2", "Zeta Show"), itemRow("p1", "Alpha Show"))
        }
        assertEquals(listOf("podcast:p1", "podcast:p2"), ids("lib:l2:podcast"))
    }

    @Test
    fun aBookLibraryOpensIntoTheSixCategories() {
        assertEquals(
            listOf(
                "latest:l1",
                "authors:l1",
                "serieslist:l1",
                "collections:l1",
                "listenagain:l1",
                "allbooks:l1"
            ),
            ids("lib:l1:book")
        )
    }

    // ---- Item lists: order, filters, and the ebook-only drop --------------

    @Test
    fun recentlyAddedKeepsTheServersRecencyOrder() {
        api.itemsAnswer = { jsonArray(itemRow("i2", "Zulu"), itemRow("i1", "Alpha")) }
        assertEquals(listOf("play:i2", "play:i1"), ids("latest:l1"))

        val query = api.itemQueries.single()
        assertEquals(100, query.limit)
        assertEquals("addedAt", query.sort)
        assertTrue("Recently Added is newest-first", query.desc)
    }

    @Test
    fun allBooksIsAlphabeticalRegardlessOfWhatTheServerReturned() {
        api.itemsAnswer = { jsonArray(itemRow("i2", "Zulu"), itemRow("i1", "alpha")) }
        assertEquals(listOf("play:i1", "play:i2"), ids("allbooks:l1"))

        val query = api.itemQueries.single()
        assertEquals(200, query.limit)
        assertEquals("media.metadata.title", query.sort)
    }

    @Test
    fun ebookOnlyRowsAreFilteredOut() {
        api.itemsAnswer = {
            jsonArray(itemRow("audio", "Has Audio"), itemRow("ebook", "Ebook Only", numTracks = 0))
        }
        assertEquals(listOf("play:audio"), ids("allbooks:l1"))
    }

    @Test
    fun listenAgainAsksForFinishedProgressAndLabelsItAsFinished() {
        api.itemsAnswer = { jsonArray(itemRow("i1", "Critical Mass", author = "Author A")) }
        api.mediaProgressAnswer =
            jsonArray(progressRow("i1", 1000.0, 1000.0, isFinished = true))

        val row = tree.loadChildren("listenagain:l1").single()
        assertEquals("✓ Critical Mass", row.mediaMetadata.title.toString())
        assertEquals("Author A • Finished", row.artist())

        val query = api.itemQueries.single()
        assertEquals("progress", query.filterType)
        assertEquals("finished", query.filterValue)
    }

    @Test
    fun aSeriesDrillInAsksForSequenceOrderAndLeadsWithBookN() {
        api.itemsAnswer = {
            jsonArray(itemRow("i1", "Leviathan Wakes", author = "Author A", sequence = "3"))
        }
        val row = tree.loadChildren("series:l1:s1").single()
        // "Book 3" replaces the author, which repeats on every tile in here.
        assertEquals("Book 3", row.artist())

        val query = api.itemQueries.single()
        assertEquals("series", query.filterType)
        assertEquals("s1", query.filterValue)
        assertEquals("media.metadata.series.sequence", query.sort)
    }

    @Test
    fun anAuthorDrillInFiltersOnTheAuthorIdAndSortsByTitle() {
        api.itemsAnswer = { jsonArray(itemRow("i2", "Zulu"), itemRow("i1", "Alpha")) }
        assertEquals(listOf("play:i1", "play:i2"), ids("author:l1:a1"))

        val query = api.itemQueries.single()
        assertEquals("authors", query.filterType)
        assertEquals("a1", query.filterValue)
    }

    // ---- Folder levels: authors, series, collections ----------------------

    @Test
    fun authorsAreAlphabeticalWithABookCount() {
        api.authorsAnswer = jsonArray(
            JSONObject().put("id", "a2").put("name", "Zed Writer").put("numBooks", 3),
            JSONObject().put("id", "a1").put("name", "Alpha Writer").put("numBooks", 1),
            JSONObject().put("id", "a3").put("name", "Mid Writer")
        )
        val rows = tree.loadChildren("authors:l1")
        assertEquals(listOf("author:l1:a1", "author:l1:a3", "author:l1:a2"), rows.map { it.mediaId })
        assertEquals("1 book", rows[0].mediaMetadata.subtitle.toString())
        // No count at all rather than "0 books".
        assertNull(rows[1].mediaMetadata.subtitle)
        assertEquals("3 books", rows[2].mediaMetadata.subtitle.toString())
    }

    @Test
    fun aSeriesRowIsLabelledSeriesThenAuthor() {
        api.seriesAnswer = jsonArray(
            JSONObject()
                .put("id", "s1")
                .put("name", "The Expanse")
                .put("numBooks", 9)
                .put("books", jsonArray(itemRow("i1", "Leviathan Wakes", author = "Author A")))
        )
        val row = tree.loadChildren("serieslist:l1").single()
        assertEquals("series:l1:s1", row.mediaId)
        assertEquals("The Expanse • Author A", row.mediaMetadata.title.toString())
        assertEquals("9 books", row.mediaMetadata.subtitle.toString())
    }

    @Test
    fun collectionsListThenOpenIntoTheirBooks() {
        api.collectionsAnswer = jsonArray(
            JSONObject().put("id", "c2").put("name", "Zeta picks"),
            JSONObject().put("id", "c1").put("name", "Alpha picks")
        )
        assertEquals(listOf("collection:c1", "collection:c2"), ids("collections:l1"))

        api.collectionAnswer = jsonArray(itemRow("i2", "Zulu"), itemRow("i1", "Alpha"))
        assertEquals(listOf("play:i1", "play:i2"), ids("collection:c1"))
    }

    // ---- Podcast episodes -------------------------------------------------

    @Test
    fun podcastEpisodesAreNewestFirstAndCappedAtFifty() {
        api.podcastAnswer = ItemDetail(
            id = "p1",
            title = "The Show",
            authorName = "Host",
            mediaType = "podcast",
            duration = 0.0,
            size = null,
            chapters = emptyList(),
            tracks = emptyList(),
            episodes = (1..60).map {
                PodcastEpisode(id = "e$it", title = "Episode $it", publishedAt = it.toLong(), duration = 60.0)
            },
            userProgressCurrentTime = null
        )
        val rows = tree.loadChildren("podcast:p1")
        assertEquals(50, rows.size)
        assertEquals("play:p1::e60", rows.first().mediaId)
        assertEquals("Episode 60", rows.first().mediaMetadata.title.toString())
        // The show's title is the line under each episode.
        assertEquals("The Show", rows.first().artist())
    }

    // ---- Continue Listening ----------------------------------------------

    @Test
    fun continueListeningDropsEbooksAndReadingOnlyProgress() {
        api.itemsInProgressAnswer = jsonArray(
            itemRow("audio", "Listening", author = "Author A"),
            itemRow("reading", "Reading Only", author = "Author B"),
            itemRow("ebook", "Ebook", numTracks = 0)
        )
        api.mediaProgressAnswer = jsonArray(
            progressRow("audio", 500.0, 1000.0),
            // The ebook side of a dual-format book: progress, but no listening.
            progressRow("reading", 0.0, 1000.0)
        )
        val rows = tree.loadChildren("__CONTINUE__")
        assertEquals(listOf("play:audio"), rows.map { it.mediaId })
        assertEquals("50% • Listening", rows.single().mediaMetadata.title.toString())
        assertEquals("Author A • 8m left", rows.single().artist())
    }

    @Test
    fun aBooksExplicitNullEpisodeIdKeepsItInTheItemProgressMap() {
        // The org.json gotcha, end to end: optString on an explicit JSON null
        // returns the STRING "null". Reading that as an episode key emptied the
        // ITEM map and silently removed every percent, checkmark and time-left
        // from the whole tree.
        api.itemsAnswer = { jsonArray(itemRow("i1", "Critical Mass")) }
        api.mediaProgressAnswer = jsonArray(
            progressRow("i1", 250.0, 1000.0),
            progressRow("i2", 10.0, 100.0, episodeId = "e1")
        )
        val row = tree.loadChildren("listenagain:l1").single()
        assertEquals("25% • Critical Mass", row.mediaMetadata.title.toString())
    }

    // ---- Failures degrade to empty, never to an exception ------------------

    @Test
    fun aFailedFetchIsAnEmptyFolderNotACrash() {
        api.librariesAnswer = null
        api.authorsAnswer = null
        api.collectionsAnswer = null
        assertEquals(emptyList<String>(), ids("__LIBRARIES__"))
        assertEquals(emptyList<String>(), ids("authors:l1"))
        assertEquals(emptyList<String>(), ids("collections:l1"))
    }

    @Test
    fun anUnknownParentIdIsAnEmptyFolder() {
        assertEquals(emptyList<String>(), ids("something:else"))
    }
}
