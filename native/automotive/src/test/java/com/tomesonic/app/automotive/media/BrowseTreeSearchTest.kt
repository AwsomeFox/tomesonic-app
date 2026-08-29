package com.tomesonic.app.automotive.media

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Search, and the cache the car's two-call search protocol depends on.
 *
 * The rewrite of the phone module's `MusicServiceSearchCacheTest`, which
 * reflected the patch's private `absSearchCache` map out of a bare service and
 * asserted the map object's own semantics. Here the same contract is asserted
 * through the two calls that actually use it — `onSearch` fills the cache,
 * `onGetSearchResult` reads it back — because that pairing is the whole reason
 * the cache is FIFO rather than LRU:
 *
 * a different query flooding the cache in the gap between the two calls must
 * not evict the pending one, and a READ must not rescue an old entry from
 * eviction (the map is built with `accessOrder = false`). The earlier
 * clear()-everything-at-30 implementation failed exactly the first of those.
 *
 * Voice is why it matters at all (VC-1): the Assistant's "play <title>" goes
 * through this pair, and an evicted pending query is a voice command that
 * silently does nothing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class BrowseTreeSearchTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val api = FakeBrowseApi()
    private lateinit var tree: BrowseTree

    @Before
    fun setUp() {
        api.searchAnswer = jsonArray(itemRow("i1", "Dune", author = "Author A"))
        tree = BrowseTree(context = context, api = api)
    }

    @After
    fun tearDown() {
        tree.release()
    }

    private fun cached(query: String): Boolean = tree.searchResults(query).isNotEmpty()

    // ---- What a search returns -------------------------------------------

    @Test
    fun searchBuildsPlayableRowsWithProgress() {
        api.mediaProgressAnswer = jsonArray(progressRow("i1", 250.0, 1000.0))
        val results = tree.search("dune")
        val row = results.single()
        assertEquals("play:i1", row.mediaId)
        assertEquals("25% • Dune", row.mediaMetadata.title.toString())
        assertEquals("Author A • 12m left", row.mediaMetadata.artist.toString())
        assertEquals(true, row.mediaMetadata.isPlayable)
    }

    @Test
    fun searchDropsEbookOnlyHitsAndRepeatedIds() {
        api.searchAnswer = jsonArray(
            itemRow("i1", "Dune"),
            // The same book, matched in a second library.
            itemRow("i1", "Dune"),
            itemRow("i2", "Dune (ebook)", numTracks = 0)
        )
        assertEquals(listOf("play:i1"), tree.search("dune").map { it.mediaId })
    }

    @Test
    fun aFailedSearchIsAnEmptyResultNotACrash() {
        api.searchAnswer = null
        assertEquals(emptyList<String>(), tree.search("dune").map { it.mediaId })
    }

    @Test
    fun theResultsAreReadBackByTheExactQueryText() {
        tree.search("dune")
        assertTrue(cached("dune"))
        // The car asks with the same string it searched with; nothing here
        // normalises case, and inventing that would change which results a
        // second, differently-cased voice query gets.
        assertTrue(tree.searchResults("Dune").isEmpty())
    }

    // ---- The FIFO cache ---------------------------------------------------

    @Test
    fun thirtyQueriesFitWithoutEviction() {
        repeat(BrowseTree.SEARCH_CACHE_CAP) { tree.search("q$it") }
        assertTrue(cached("q0"))
        assertTrue(cached("q29"))
    }

    @Test
    fun theThirtyFirstInsertEvictsOnlyTheEldest() {
        repeat(BrowseTree.SEARCH_CACHE_CAP + 1) { tree.search("q$it") }
        assertTrue("the eldest entry must be the one evicted", !cached("q0"))
        assertTrue(cached("q1"))
        assertTrue(cached("q30"))
    }

    @Test
    fun theJustInsertedQuerySurvivesInsertionIntoAFullCache() {
        // The regression this cache exists for: a pending query's results must
        // still be there when onGetSearchResult comes back for them.
        repeat(BrowseTree.SEARCH_CACHE_CAP) { tree.search("filler$it") }
        tree.search("pending-query")
        assertTrue(cached("pending-query"))
    }

    @Test
    fun evictionIsInsertionOrderedNotAccessOrdered() {
        repeat(BrowseTree.SEARCH_CACHE_CAP) { tree.search("q$it") }
        // A READ — which is exactly what onGetSearchResult does — must not
        // refresh an entry's age; the map is built with accessOrder = false.
        tree.searchResults("q0")
        tree.search("q30")
        assertTrue("a read must not rescue q0 from eviction", !cached("q0"))
        assertTrue(cached("q30"))
    }

    @Test
    fun reSearchingAnExistingQueryEvictsNothing() {
        repeat(BrowseTree.SEARCH_CACHE_CAP) { tree.search("q$it") }
        tree.search("q5")
        assertTrue(cached("q0"))
        assertTrue(cached("q29"))
    }

    @Test
    fun searchResultsArePagedByTheSameWindowAsChildren() {
        api.searchAnswer = jsonArray(*(1..25).map { itemRow("i$it", "Book $it") }.toTypedArray())
        val results = tree.search("book")
        assertEquals(25, results.size)

        val (from, to) = BrowseTree.pageWindow(results.size, 1, 10)
        assertEquals(listOf(10, 19), listOf(from, to - 1))
    }
}
