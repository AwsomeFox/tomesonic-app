package com.tomesonic.app.automotive.media

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * The persisted root of ARCHITECTURE.md §7's DR-3 addition: the last-good root
 * written to `filesDir`, read back on a cold start, and replaced by a real
 * fetch immediately afterwards.
 *
 * New for the car — the donor persisted nothing. What is being pinned is the
 * FILE (a version, browsable rows only, no cover URL and therefore no token)
 * and the RESTORE RULE (serve it, mark it stale, refresh it). The offline case
 * matters most: a root persisted while online must never be shown to a car that
 * has no network, or the user taps into folders that cannot answer.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class PersistedRootTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val api = FakeBrowseApi()
    private val trees = mutableListOf<BrowseTree>()

    /** The file name is this feature's contract with its own next cold start. */
    private val cacheFile: File
        get() = File(context.filesDir, "automotive_browse_root.json")

    @Before
    fun setUp() {
        cacheFile.delete()
    }

    @After
    fun tearDown() {
        trees.forEach { it.release() }
        cacheFile.delete()
    }

    private fun newTree(): BrowseTree =
        BrowseTree(context = context, api = api).also { trees += it }

    private fun awaitUntil(timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(10)
        }
        throw AssertionError("condition not reached within ${timeoutMs}ms")
    }

    @Test
    fun servingTheOnlineRootWritesItToDisk() {
        val ids = newTree().loadChildren("__ROOT__").map { it.mediaId }
        assertTrue(cacheFile.exists())

        val doc = JSONObject(cacheFile.readText())
        assertEquals(1, doc.getInt("version"))
        val children = doc.getJSONArray("children")
        assertEquals(ids.size, children.length())

        val first = children.getJSONObject(0)
        assertEquals("__CONTINUE__", first.getString("id"))
        assertEquals("Continue Listening", first.getString("title"))
        // Browsable-only, and the icon by NAME — the one field a MediaItem
        // cannot give back, and the reason a restored row still renders.
        assertEquals("browsable", first.getString("type"))
        assertEquals("aa_continue", first.getString("icon"))
        assertEquals(BrowseStyles.STYLE_GRID, first.getInt("playableStyle"))
        // No cover URL anywhere in the file: a cover URL carries the access
        // token, and nothing here writes a credential to a second file.
        assertTrue(!cacheFile.readText().contains("token"))
    }

    @Test
    fun aColdStartServesTheRestoredRowsAsTheyWereWritten() {
        // A root from a previous run, with a title the static builder would
        // never produce — the provenance of the answer is the whole assertion.
        cacheFile.writeText(
            JSONObject()
                .put("version", 1)
                .put("at", 1L)
                .put(
                    "children",
                    jsonArray(
                        JSONObject()
                            .put("id", "__DOWNLOADS__")
                            .put("title", "Downloads (as last seen)")
                            .put("type", "browsable")
                            .put("icon", "aa_downloads")
                            .put("playableStyle", BrowseStyles.STYLE_GRID)
                    )
                )
                .toString()
        )

        val tree = newTree()
        tree.restoreRoot()
        val rows = tree.loadChildren("__ROOT__")

        assertEquals(listOf("__DOWNLOADS__"), rows.map { it.mediaId })
        assertEquals("Downloads (as last seen)", rows.single().mediaMetadata.title.toString())
        assertEquals(
            BrowseStyles.STYLE_GRID,
            requireNotNull(rows.single().mediaMetadata.extras)
                .getInt(BrowseStyles.CONTENT_STYLE_PLAYABLE_HINT)
        )
    }

    @Test
    fun aRestoredRootIsReplacedByARealFetchRightAfterItIsServed() {
        cacheFile.writeText(
            JSONObject()
                .put("version", 1)
                .put("at", 1L)
                .put(
                    "children",
                    jsonArray(
                        JSONObject()
                            .put("id", "__DOWNLOADS__")
                            .put("title", "Downloads (as last seen)")
                            .put("type", "browsable")
                    )
                )
                .toString()
        )
        val notified = mutableListOf<String>()
        val tree = BrowseTree(
            context = context,
            api = api,
            onBrowseChanged = { synchronized(notified) { notified += it } }
        ).also { trees += it }

        tree.restoreRoot()
        // The stale answer goes out first…
        assertEquals(listOf("__DOWNLOADS__"), tree.loadChildren("__ROOT__").map { it.mediaId })
        // …and the refresh it scheduled replaces it, then tells the car.
        awaitUntil { tree.loadChildren("__ROOT__").size == 4 }
        assertEquals(
            listOf("__CONTINUE__", "__CONTINUE_SERIES__", "__DOWNLOADS__", "__LIBRARIES__"),
            tree.loadChildren("__ROOT__").map { it.mediaId }
        )
        awaitUntil { synchronized(notified) { notified.isNotEmpty() } }
    }

    @Test
    fun aFileFromAnotherBuildIsIgnoredRatherThanGuessedAt() {
        cacheFile.writeText(
            JSONObject()
                .put("version", 99)
                .put("children", jsonArray(JSONObject().put("id", "__NOPE__").put("title", "x")))
                .toString()
        )
        val tree = newTree()
        tree.restoreRoot()
        assertEquals(
            listOf("__CONTINUE__", "__CONTINUE_SERIES__", "__DOWNLOADS__", "__LIBRARIES__"),
            tree.loadChildren("__ROOT__").map { it.mediaId }
        )
    }

    @Test
    fun aTornFileIsIgnoredRatherThanThrown() {
        cacheFile.writeText("{ this is not json")
        val tree = newTree()
        tree.restoreRoot()
        assertEquals(4, tree.loadChildren("__ROOT__").size)
    }

    @Test
    fun anOnlineRootIsNeverRestoredIntoAnOfflineCar() {
        newTree().loadChildren("__ROOT__")
        assertTrue(cacheFile.exists())

        val cold = newTree()
        cold.update(false, "no network at cold start")
        cold.restoreRoot()
        // Offline reads no cache at all: the car gets the downloads root, not
        // four folders that cannot answer.
        assertEquals(listOf("__DOWNLOADS__"), cold.loadChildren("__ROOT__").map { it.mediaId })
    }

    @Test
    fun anOfflineRootIsNeverPersisted() {
        val tree = newTree()
        tree.update(false, "offline")
        tree.loadChildren("__ROOT__")
        assertTrue("only an online root is a last-GOOD root", !cacheFile.exists())
    }
}
