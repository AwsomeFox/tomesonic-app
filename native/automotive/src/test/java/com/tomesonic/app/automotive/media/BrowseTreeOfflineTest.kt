package com.tomesonic.app.automotive.media

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import androidx.media3.common.MediaItem
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.FileOutputStream

/**
 * The offline tree: what the car shows with no usable network, and the Binder
 * budget that keeps that answer deliverable.
 *
 * Two donor behaviours meet here. The offline SHAPE — root collapses to
 * `__DOWNLOADS__`, every other node answers with the downloads — is
 * ARCHITECTURE.md §7 and had no donor test at all. The cover INLINING is the
 * `absLocalArtBytes` half of the phone module's `MusicServiceBadgesTest`,
 * rewritten through the folder that needs it rather than by reflecting into a
 * private method: the car's process cannot read this app's private files, so a
 * `file://` artwork URI renders as a blank tile and the bytes have to cross the
 * session bridge instead.
 *
 * The budget is the other half of that: the car subscribes to Downloads
 * UNPAGINATED, so every row crosses one Binder transaction, and enough inlined
 * covers overflow it — which fails the whole node, offline, which is the one
 * moment it is the only node there is.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class BrowseTreeOfflineTest {

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

    private fun goOffline() = tree.update(false, "test")

    private fun downloads(vararg rows: BrowseDownload) {
        tree.downloadsSource = DownloadsSource { rows.toList() }
    }

    private fun book(id: String, title: String, cover: String? = null, playable: Boolean = true) =
        BrowseDownload(
            id = id,
            title = title,
            author = "Author A",
            coverPath = cover,
            playable = playable
        )

    /** A real 8x8 PNG in filesDir — the shape a finished download leaves behind. */
    private fun writeCoverPng(name: String): String {
        val f = File(context.filesDir, name)
        val bmp = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        bmp.eraseColor(android.graphics.Color.RED)
        FileOutputStream(f).use { out ->
            check(bmp.compress(Bitmap.CompressFormat.PNG, 100, out)) { "PNG compress failed" }
        }
        bmp.recycle()
        return f.absolutePath
    }

    private fun MediaItem.artBytes(): ByteArray? = mediaMetadata.artworkData

    // ---- The offline shape ------------------------------------------------

    @Test
    fun theOfflineRootIsDownloadsAlone() {
        goOffline()
        downloads(book("b1", "One"))
        val root = tree.loadChildren("__ROOT__")
        assertEquals(listOf("__DOWNLOADS__"), root.map { it.mediaId })
        assertEquals("Downloads", root.single().mediaMetadata.title.toString())
        assertEquals("Available offline", root.single().mediaMetadata.subtitle.toString())
    }

    @Test
    fun everyOtherNodeAnswersWithTheDownloadsWhileOffline() {
        goOffline()
        downloads(book("b1", "One"))
        // A head unit restoring the folder the user was last in must not get an
        // empty screen because that folder happens to be a server-backed one.
        listOf("__LIBRARIES__", "lib:l1:book", "allbooks:l1", "series:l1:s1").forEach { parent ->
            assertEquals(listOf("play:b1"), tree.loadChildren(parent).map { it.mediaId })
        }
    }

    @Test
    fun theOfflineTreeNeverAsksTheServerForAnything() {
        goOffline()
        downloads(book("b1", "One"))
        tree.loadChildren("__ROOT__")
        tree.loadChildren("__DOWNLOADS__")
        assertEquals(emptyList<String>(), api.calls)
    }

    @Test
    fun downloadsAreAlphabeticalAndBadgeOnlyRowsAreLeftOut() {
        goOffline()
        downloads(
            book("b2", "Zulu"),
            book("b1", "alpha"),
            // No local audio: it can still badge an online row, but it must not
            // be tappable in the folder whose whole promise is offline play.
            book("b3", "Badge Only", playable = false)
        )
        assertEquals(listOf("play:b1", "play:b2"), tree.loadChildren("__DOWNLOADS__").map { it.mediaId })
    }

    @Test
    fun aDownloadedEpisodeKeepsItsCompositePlayId() {
        goOffline()
        tree.downloadsSource = DownloadsSource {
            listOf(
                BrowseDownload(
                    id = "p1__e1",
                    title = "Episode One",
                    author = "The Show",
                    coverPath = null,
                    libraryItemId = "p1",
                    episodeId = "e1"
                )
            )
        }
        // The entry id is the download's own key; the MEDIA id has to be the
        // frozen grammar's item::episode form or playback resolves the wrong
        // thing (ARCHITECTURE.md §4.1).
        assertEquals(listOf("play:p1::e1"), tree.loadChildren("__DOWNLOADS__").map { it.mediaId })
    }

    @Test
    fun aFailingDownloadsSourceKeepsTheLastGoodSnapshot() {
        goOffline()
        downloads(book("b1", "One"))
        assertEquals(1, tree.loadChildren("__DOWNLOADS__").size)

        // The index is mid-write: that must cost this browse cycle, not the
        // whole offline catalog.
        tree.downloadsSource = DownloadsSource { throw IllegalStateException("index mid-write") }
        assertEquals(1, tree.loadChildren("__DOWNLOADS__").size)
    }

    // ---- Cover inlining ---------------------------------------------------

    @Test
    fun aLocalCoverIsInlinedAsBytesWhileOffline() {
        goOffline()
        val png = writeCoverPng("cover-file.png")
        downloads(book("b1", "One", cover = "file://$png"))
        val row = tree.loadChildren("__DOWNLOADS__").single()
        assertNotNull("a file:// cover must be decoded and inlined", row.artBytes())
        // A file:// URI would render as a blank tile in the car's process.
        assertNull(row.mediaMetadata.artworkUri)
    }

    @Test
    fun aBarePathCoverIsInlinedToo() {
        goOffline()
        val png = writeCoverPng("cover-bare.png")
        downloads(book("b1", "One", cover = png))
        assertNotNull(tree.loadChildren("__DOWNLOADS__").single().artBytes())
    }

    @Test
    fun remoteAndContentCoverPathsAreLeftToTheArtworkLoader() {
        goOffline()
        downloads(
            book("b1", "One", cover = "https://abs.example/api/items/x/cover"),
            book("b2", "Two", cover = "content://media/external/images/1")
        )
        // decodeFile on a non-filesystem path is exception-driven control flow
        // and per-lookup log spam; there is no such file to decode.
        tree.loadChildren("__DOWNLOADS__").forEach { assertNull(it.artBytes()) }
    }

    @Test
    fun onlyTheFirstEightTilesCarryInlinedArt() {
        goOffline()
        val png = writeCoverPng("cover-budget.png")
        // Twelve downloads, named so the sort order is the index order.
        downloads(*(1..12).map { book("b%02d".format(it), "Book %02d".format(it), cover = png) }
            .toTypedArray())

        val rows = tree.loadChildren("__DOWNLOADS__")
        assertEquals(12, rows.size)
        rows.forEachIndexed { index, row ->
            if (index < BrowseTree.DOWNLOADS_ART_BUDGET) {
                assertNotNull("tile $index is inside the budget", row.artBytes())
            } else {
                assertNull("tile $index is past the budget", row.artBytes())
            }
        }
        // Past the budget the rows are still listed and still playable — the
        // budget costs artwork, never access.
        assertTrue(rows.all { it.mediaMetadata.isPlayable == true })
    }

    // ---- Online: the cover comes from the server --------------------------

    @Test
    fun onlineRowsUseTheServerCoverUrlAndNeverDecodeAnything() {
        val png = writeCoverPng("cover-online.png")
        downloads(book("b1", "One", cover = "file://$png"))
        api.itemsAnswer = { jsonArray(itemRow("b1", "One")) }

        val row = tree.loadChildren("allbooks:l1").single()
        assertEquals(
            "https://abs.test/api/items/b1/cover?token=T",
            row.mediaMetadata.artworkUri.toString()
        )
        assertNull(row.artBytes())
        // …and it still carries the download badge, which is what the online
        // row is FOR.
        assertEquals(
            2L,
            requireNotNull(row.mediaMetadata.extras).getLong(BrowseStyles.EXTRA_DOWNLOAD_STATUS)
        )
    }
}
