package com.tomesonic.app.automotive.media

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `__CONTINUE_SERIES__` is the tree's N+1 — a series list AND an items query
 * per active series, across every book library — and ARCHITECTURE.md §7 is
 * explicit that it "loads lazily and must never block the root answer" (DR-1/2,
 * the car's two-second button and ten-second launch budgets).
 *
 * That is a NEGATIVE, which is why it needs a test: nothing about the root's
 * code says "and do not fetch the series shelf", and the way this regresses is
 * someone helpfully pre-computing the shelf so the folder opens faster. The
 * fake api records every call, so "the root asked for nothing" and "the
 * pre-warm asked for nothing" are both assertable.
 *
 * The rest of the file is the merge itself: the server's between-books shelf
 * plus the series of books you are mid-way through, de-duplicated, alphabetical,
 * each with "X of Y finished".
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class ContinueSeriesLazyTest {

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

    private fun awaitUntil(timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(10)
        }
        throw AssertionError("condition not reached within ${timeoutMs}ms; calls=${api.calls}")
    }

    // ---- The negative -----------------------------------------------------

    @Test
    fun theRootAnswerFetchesNothingAtAll() {
        val root = tree.loadChildren("__ROOT__")
        assertTrue(root.any { it.mediaId == "__CONTINUE_SERIES__" })
        // The folder is listed; its contents are not computed to list it.
        assertEquals(emptyList<String>(), api.calls)
    }

    @Test
    fun preWarmingNeverBuildsTheContinueSeriesShelf() {
        tree.prewarm()
        // The pre-warm's own work is the root plus the progress map; waiting for
        // the progress fetch is waiting for the whole task.
        awaitUntil { api.calls.contains("mediaProgress") }
        assertFalse(
            "pre-warm must not run the N+1 series fan-out",
            api.calls.contains("personalized") || api.calls.contains("series")
        )
    }

    @Test
    fun openingTheFolderIsTheOnlyThingThatBuildsIt() {
        api.librariesAnswer = jsonArray(libraryRow("l1", "Library"))
        tree.loadChildren("__CONTINUE_SERIES__")
        assertTrue(api.calls.contains("personalized"))
        assertTrue(api.calls.contains("series"))
        assertTrue(api.calls.contains("itemsInProgress"))
    }

    // ---- The merge --------------------------------------------------------

    @Test
    fun theShelfMergesTheServersAndTheInProgressSeriesAlphabetically() {
        api.librariesAnswer = jsonArray(
            libraryRow("l1", "Books"),
            // Podcast libraries have no series shelf and must be skipped.
            libraryRow("l2", "Shows", "podcast")
        )
        api.seriesAnswer = jsonArray(
            JSONObject().put("id", "s1").put("name", "The Expanse"),
            JSONObject().put("id", "s2").put("name", "Ancillary")
        )
        // (a) The server's between-books shelf: finished one, next one up.
        api.personalizedAnswer = jsonArray(
            JSONObject()
                .put("id", "continue-series")
                .put(
                    "entities",
                    jsonArray(
                        JSONObject()
                            .put("id", "i9")
                            .put(
                                "media",
                                JSONObject().put(
                                    "metadata",
                                    JSONObject().put(
                                        "series",
                                        JSONObject().put("id", "s1").put("name", "The Expanse")
                                    )
                                )
                            )
                    )
                )
        )
        // (b) A book currently in progress, whose series carries a "#seq"
        // suffix that has to be stripped before the name -> id lookup.
        api.itemsInProgressAnswer = jsonArray(
            itemRow("i1", "Ancillary Justice", seriesName = "Ancillary #1", libraryId = "l1")
        )
        api.itemsAnswer = { query ->
            when (query.filterValue) {
                "s1" -> jsonArray(itemRow("i9", "Leviathan Wakes"), itemRow("i10", "Caliban's War"))
                else -> jsonArray(itemRow("i1", "Ancillary Justice"))
            }
        }
        api.mediaProgressAnswer = jsonArray(progressRow("i9", 100.0, 100.0, isFinished = true))

        val rows = tree.loadChildren("__CONTINUE_SERIES__")
        assertEquals(listOf("series:l1:s2", "series:l1:s1"), rows.map { it.mediaId })
        assertEquals(listOf("Ancillary", "The Expanse"), rows.map { it.mediaMetadata.title.toString() })
        // "X of Y finished" is the whole reason the per-series query is worth
        // its cost: it is the most glanceable series fact there is while
        // driving.
        assertEquals("0 of 1 finished", rows[0].mediaMetadata.subtitle.toString())
        assertEquals("1 of 2 finished", rows[1].mediaMetadata.subtitle.toString())
    }

    @Test
    fun aSeriesInBothSourcesIsListedOnce() {
        api.librariesAnswer = jsonArray(libraryRow("l1", "Books"))
        api.seriesAnswer = jsonArray(JSONObject().put("id", "s1").put("name", "The Expanse"))
        api.personalizedAnswer = jsonArray(
            JSONObject()
                .put("id", "continue-series")
                .put(
                    "entities",
                    jsonArray(
                        JSONObject()
                            .put("id", "i9")
                            .put(
                                "media",
                                JSONObject().put(
                                    "metadata",
                                    JSONObject().put(
                                        "series",
                                        JSONObject().put("id", "s1").put("name", "The Expanse")
                                    )
                                )
                            )
                    )
                )
        )
        api.itemsInProgressAnswer = jsonArray(
            itemRow("i1", "Leviathan Wakes", seriesName = "The Expanse", libraryId = "l1")
        )
        assertEquals(
            listOf("series:l1:s1"),
            tree.loadChildren("__CONTINUE_SERIES__").map { it.mediaId }
        )
    }

    @Test
    fun aFailedLibraryListIsAnEmptyShelfNotACrash() {
        api.librariesAnswer = null
        assertEquals(emptyList<String>(), tree.loadChildren("__CONTINUE_SERIES__"))
    }
}
