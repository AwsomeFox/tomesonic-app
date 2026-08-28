package com.tomesonic.app.automotive.media

import android.app.Application
import android.os.Bundle
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The badge extras a browse row carries — [BrowseStyles.itemExtras] — and the
 * content-style keys the root sets.
 *
 * The rewrite of the `absItemExtras` half of the phone module's
 * `MusicServiceBadgesTest` (its `absLocalArtBytes` half became
 * [BrowseTreeOfflineTest], which exercises the same decode through the folder
 * that needs it).
 *
 * The KEY STRINGS are the reason this test exists. The car renders the
 * checkmark, the progress bar and the download icon from these legacy
 * MediaDescription extras only, and the names are counter-intuitive: media3's
 * DESCRIPTION_EXTRAS_KEY_COMPLETION_STATUS is literally
 * "android.media.extra.PLAYBACK_STATUS", while the "obvious"
 * android.media.description.extra.* spellings compile, ship, and render
 * nothing. They are asserted as literals (ARCHITECTURE.md §4.3) so a
 * well-meaning rename breaks CI rather than every badge in the car.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class BadgeExtrasTest {

    private companion object {
        const val KEY_PLAYBACK_STATUS = "android.media.extra.PLAYBACK_STATUS"
        const val KEY_COMPLETION = "androidx.media.MediaItem.Extras.COMPLETION_PERCENTAGE"
        const val KEY_DOWNLOAD_STATUS = "android.media.extra.DOWNLOAD_STATUS"
        const val KEY_STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
        const val KEY_STYLE_PLAYABLE = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
        const val KEY_STYLE_BROWSABLE = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"
    }

    private fun extras(prog: JSONObject?, downloaded: Boolean): Bundle =
        BrowseStyles.itemExtras(prog, downloaded)

    @Test
    fun theKeyStringsAreTheContractsVerbatim() {
        assertEquals(KEY_PLAYBACK_STATUS, BrowseStyles.EXTRA_PLAYBACK_STATUS)
        assertEquals(KEY_COMPLETION, BrowseStyles.EXTRA_COMPLETION_PERCENTAGE)
        assertEquals(KEY_DOWNLOAD_STATUS, BrowseStyles.EXTRA_DOWNLOAD_STATUS)
        assertEquals(KEY_STYLE_SUPPORTED, BrowseStyles.CONTENT_STYLE_SUPPORTED)
        assertEquals(KEY_STYLE_PLAYABLE, BrowseStyles.CONTENT_STYLE_PLAYABLE_HINT)
        assertEquals(KEY_STYLE_BROWSABLE, BrowseStyles.CONTENT_STYLE_BROWSABLE_HINT)
    }

    @Test
    fun finishedItemGetsCheckmarkStatusAndNoCompletionPercentage() {
        val b = extras(
            JSONObject("""{"isFinished":true,"currentTime":3000.0,"duration":7000.0}"""),
            false
        )
        assertEquals(2, b.getInt(KEY_PLAYBACK_STATUS))
        assertFalse(
            "finished items must not also carry a progress bar",
            b.containsKey(KEY_COMPLETION)
        )
    }

    @Test
    fun partialProgressGetsStatusOneAndExactCompletionRatio() {
        val b = extras(JSONObject("""{"currentTime":25.0,"duration":100.0}"""), false)
        assertEquals(1, b.getInt(KEY_PLAYBACK_STATUS))
        assertEquals(0.25, b.getDouble(KEY_COMPLETION, -1.0), 0.0)
    }

    @Test
    fun completionPercentageClampsToOneWhenCurrentExceedsDuration() {
        val b = extras(JSONObject("""{"currentTime":150.0,"duration":100.0}"""), false)
        assertEquals(1, b.getInt(KEY_PLAYBACK_STATUS))
        assertEquals(1.0, b.getDouble(KEY_COMPLETION, -1.0), 0.0)
    }

    @Test
    fun zeroProgressGetsNoPlaybackKeysAtAll() {
        val b = extras(JSONObject("""{"currentTime":0.0,"duration":100.0}"""), false)
        assertFalse(b.containsKey(KEY_PLAYBACK_STATUS))
        assertFalse(b.containsKey(KEY_COMPLETION))
    }

    @Test
    fun noProgressAndNotDownloadedIsAnEmptyBundle() {
        assertTrue(extras(null, false).isEmpty)
    }

    @Test
    @Suppress("DEPRECATION") // Bundle.get: the untyped read IS the assertion
    fun downloadedItemGetsDownloadStatusAsALong() {
        val b = extras(null, true)
        // The car reads this as a long (STATUS_DOWNLOADED = 2L); an Int here
        // silently renders no icon at all.
        val v = b.get(KEY_DOWNLOAD_STATUS)
        assertTrue("DOWNLOAD_STATUS must be a Long, got ${v?.javaClass}", v is Long)
        assertEquals(2L, b.getLong(KEY_DOWNLOAD_STATUS))
        assertFalse(b.containsKey(KEY_PLAYBACK_STATUS))
    }

    @Test
    fun downloadedPlusPartialCarriesExactlyTheThreeLegacyKeys() {
        val b = extras(JSONObject("""{"currentTime":50.0,"duration":200.0}"""), true)
        assertEquals(
            setOf(KEY_PLAYBACK_STATUS, KEY_COMPLETION, KEY_DOWNLOAD_STATUS),
            b.keySet()
        )
        assertEquals(2L, b.getLong(KEY_DOWNLOAD_STATUS))
        assertEquals(1, b.getInt(KEY_PLAYBACK_STATUS))
        assertEquals(0.25, b.getDouble(KEY_COMPLETION, -1.0), 0.0)
    }

    // ---- The root's global content-style defaults -------------------------

    @Test
    fun rootExtrasAreGridForPlayableAndCategoryListForBrowsable() {
        val root = BrowseStyles.rootExtras()
        assertTrue(root.getBoolean(KEY_STYLE_SUPPORTED))
        assertEquals(2, root.getInt(KEY_STYLE_PLAYABLE))
        assertEquals(3, root.getInt(KEY_STYLE_BROWSABLE))
    }

    @Test
    fun aFolderCarriesOnlyTheChildStylesItWasGiven() {
        val gridFolder = BrowseStyles.browsableItem(
            id = "__CONTINUE__",
            title = "Continue Listening",
            childPlayableStyle = BrowseStyles.STYLE_GRID
        )
        val extras = requireNotNull(gridFolder.mediaMetadata.extras)
        assertEquals(setOf(KEY_STYLE_PLAYABLE), extras.keySet())
        assertEquals(2, extras.getInt(KEY_STYLE_PLAYABLE))

        // A folder with no hint at all sets no extras bundle — the root's
        // defaults then apply, which is what "override per level" means.
        val plain = BrowseStyles.browsableItem(id = "collection:c1", title = "Favourites")
        assertNull(plain.mediaMetadata.extras)
    }

    @Test
    fun aPlayableRowIsPlayableAndCarriesItsBadges() {
        val item = BrowseStyles.playableItem(
            mediaId = "play:i1",
            title = "Critical Mass",
            artist = "Author A • 1h 1m left",
            subtitle = "Author A • 1h 1m left",
            prog = JSONObject("""{"currentTime":50.0,"duration":200.0}"""),
            downloaded = true
        )
        assertEquals("play:i1", item.mediaId)
        assertEquals(true, item.mediaMetadata.isPlayable)
        assertEquals(false, item.mediaMetadata.isBrowsable)
        // The percent rides the title, per §4.3.
        assertEquals("25% • Critical Mass", item.mediaMetadata.title.toString())
        val extras = requireNotNull(item.mediaMetadata.extras)
        assertEquals(2L, extras.getLong(KEY_DOWNLOAD_STATUS))
        assertEquals(1, extras.getInt(KEY_PLAYBACK_STATUS))
    }
}
