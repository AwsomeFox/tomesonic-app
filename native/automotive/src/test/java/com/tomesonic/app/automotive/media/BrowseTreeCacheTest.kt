package com.tomesonic.app.automotive.media

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The browse cache windows of ARCHITECTURE.md §7, driven by a FAKE CLOCK: 45 s
 * fresh, 10 min stale-on-failure, 15 s for the progress map, and
 * `__DOWNLOADS__` never cached at all.
 *
 * New for the car — the donor had no test for any of it, because reaching the
 * cache meant reaching the tree, and reaching the tree meant a live server and
 * a real clock. Both of those are exactly what makes the failure mode
 * untestable in the place it matters: the stale window is the difference
 * between a car that keeps browsing through a dead zone mid-drive and one that
 * blanks its library.
 *
 * Each case moves [now] rather than sleeping, so the whole file runs in
 * milliseconds and pins the boundary rather than a timing approximation.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class BrowseTreeCacheTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val api = FakeBrowseApi()
    private var now = 1_000_000L
    private lateinit var tree: BrowseTree

    @Before
    fun setUp() {
        api.itemsAnswer = { jsonArray(itemRow("i1", "Critical Mass")) }
        tree = BrowseTree(context = context, api = api, clock = { now })
    }

    @After
    fun tearDown() {
        tree.release()
    }

    private fun itemFetches(): Int = api.itemQueries.size

    @Test
    fun aFolderInsideTheFreshWindowCostsNoRequest() {
        assertEquals(1, tree.loadChildren("allbooks:l1").size)
        now += BrowseTree.CACHE_FRESH_MS - 1
        assertEquals(1, tree.loadChildren("allbooks:l1").size)
        assertEquals("the second open must be served from cache", 1, itemFetches())
    }

    @Test
    fun theFreshWindowEndsAtExactlyFortyFiveSeconds() {
        tree.loadChildren("allbooks:l1")
        now += BrowseTree.CACHE_FRESH_MS
        tree.loadChildren("allbooks:l1")
        assertEquals(2, itemFetches())
    }

    @Test
    fun aFailedRefreshServesTheStaleCopy() {
        val fresh = tree.loadChildren("allbooks:l1")
        assertEquals(1, fresh.size)

        // Mid-drive dead zone: the refresh returns nothing at all.
        now += BrowseTree.CACHE_FRESH_MS + 1
        api.itemsAnswer = { null }
        val stale = tree.loadChildren("allbooks:l1")

        assertEquals("a dead zone must not blank the folder", 1, stale.size)
        assertEquals(fresh.single().mediaId, stale.single().mediaId)
        assertEquals("it did try to refresh", 2, itemFetches())
    }

    @Test
    fun pastTheStaleWindowAFailedRefreshIsAnEmptyFolder() {
        tree.loadChildren("allbooks:l1")
        now += BrowseTree.CACHE_STALE_MS + 1
        api.itemsAnswer = { null }
        // Ten minutes of nothing is no longer "the library as it was" — it is
        // an answer this build should not be pretending to have.
        assertEquals(emptyList<String>(), tree.loadChildren("allbooks:l1").map { it.mediaId })
    }

    @Test
    fun aSuccessfulRefreshReplacesTheCachedCopy() {
        tree.loadChildren("allbooks:l1")
        now += BrowseTree.CACHE_FRESH_MS + 1
        api.itemsAnswer = { jsonArray(itemRow("i2", "Something Else")) }
        assertEquals(listOf("play:i2"), tree.loadChildren("allbooks:l1").map { it.mediaId })
    }

    @Test
    fun downloadsIsNeverCached() {
        tree.downloadsSource = DownloadsSource {
            listOf(BrowseDownload(id = "b1", title = "One", author = null, coverPath = null))
        }
        assertEquals(1, tree.loadChildren("__DOWNLOADS__").size)

        // No clock movement at all: the folder renders from local state, so a
        // download that finished a second ago must show up on the next open.
        tree.downloadsSource = DownloadsSource {
            listOf(
                BrowseDownload(id = "b1", title = "One", author = null, coverPath = null),
                BrowseDownload(id = "b2", title = "Two", author = null, coverPath = null)
            )
        }
        assertEquals(2, tree.loadChildren("__DOWNLOADS__").size)
    }

    @Test
    fun nothingIsCachedWhileOffline() {
        tree.update(false, "test")
        var calls = 0
        tree.downloadsSource = DownloadsSource {
            calls++
            listOf(BrowseDownload(id = "b1", title = "One", author = null, coverPath = null))
        }
        tree.loadChildren("__ROOT__")
        tree.loadChildren("__ROOT__")
        // An offline tree must never be cached and then served online (or the
        // reverse), so the offline path skips the cache entirely.
        assertEquals(2, calls)
    }

    @Test
    fun theProgressMapIsSharedAcrossFoldersForFifteenSeconds() {
        api.mediaProgressAnswer = jsonArray(progressRow("i1", 250.0, 1000.0))
        // Two DIFFERENT folders, both of which annotate their rows with
        // progress: the second must reuse the first one's fetch.
        tree.loadChildren("listenagain:l1")
        tree.loadChildren("author:l1:a1")
        assertEquals(1, api.calls.count { it == "mediaProgress" })

        now += BrowseTree.PROGRESS_CACHE_MS
        tree.loadChildren("series:l1:s1")
        assertEquals(2, api.calls.count { it == "mediaProgress" })
    }

    @Test
    fun anEmptyProgressAnswerIsNotCached() {
        // An offline fetch must not poison the map with emptiness for 15 s
        // after the network comes back.
        api.mediaProgressAnswer = null
        tree.loadChildren("listenagain:l1")
        tree.loadChildren("author:l1:a1")
        assertEquals(2, api.calls.count { it == "mediaProgress" })
    }

    @Test
    fun invalidateDropsEveryCachedAnswer() {
        api.searchAnswer = jsonArray(itemRow("i1", "Dune"))
        tree.loadChildren("allbooks:l1")
        tree.search("dune")
        assertEquals(1, itemFetches())
        assertEquals(listOf("play:i1"), tree.searchResults("dune").map { it.mediaId })

        // A credential change is the case this exists for: every cached row
        // embeds the OLD token in its cover URI and would render as a blank
        // tile until it aged out.
        tree.invalidate("credentials changed")

        tree.loadChildren("allbooks:l1")
        assertEquals("children must be re-fetched after an invalidate", 2, itemFetches())
        assertEquals(
            "search results must not survive an invalidate",
            emptyList<String>(),
            tree.searchResults("dune").map { it.mediaId }
        )
    }

    @Test
    fun aConnectivityFlipInvalidatesAndNotifiesExactlyOnce() {
        val reasons = mutableListOf<String>()
        val flipping = BrowseTree(
            context = context,
            api = api,
            clock = { now },
            onBrowseChanged = { reasons += it }
        )
        try {
            flipping.update(false, "network lost")
            flipping.update(false, "network lost again")
            flipping.update(true, "internet validated")
            assertEquals(listOf("network lost", "internet validated"), reasons)
        } finally {
            flipping.release()
        }
    }
}
