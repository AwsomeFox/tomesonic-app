package com.tomesonic.app.automotive.media

import android.app.Application
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
 * The tree's pure predicates and labels: [BrowseTree.hasAudio],
 * [BrowseTree.sequenceLabel] and [BrowseStyles.libraryIconRes].
 *
 * The rewrite of the applicable half of the phone module's
 * `MusicServiceFormattersTest`. Its `absStr` cases are not repeated here — that
 * helper came across in Wave 2 as `data/Models.kt`'s `absStr` and is pinned by
 * `data/ModelsTest`; its `speedIconRes` cases belong to a playback surface this
 * module does not have (the car draws its own transport controls).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class BrowseFormattersTest {

    // ---- hasAudio: the ebook-only filter ---------------------------------

    @Test
    fun hasAudioNullMediaIsFalse() {
        assertFalse(BrowseTree.hasAudio(null))
    }

    @Test
    fun hasAudioMinifiedCounts() {
        assertTrue(BrowseTree.hasAudio(JSONObject("""{"numTracks":3}""")))
        assertTrue(BrowseTree.hasAudio(JSONObject("""{"numAudioFiles":1}""")))
    }

    @Test
    fun hasAudioExpandedArrays() {
        assertTrue(BrowseTree.hasAudio(JSONObject("""{"tracks":[{"index":0}]}""")))
        assertTrue(BrowseTree.hasAudio(JSONObject("""{"audioFiles":[{"ino":"1"}]}""")))
    }

    @Test
    fun hasAudioDurationOnly() {
        assertTrue(BrowseTree.hasAudio(JSONObject("""{"duration":42.0}""")))
    }

    @Test
    fun hasAudioEbookOnlyItemIsFalse() {
        // The shape a dual-format library sends for an EPUB with no audio: the
        // counts are present and zero, and every array is empty.
        assertFalse(
            BrowseTree.hasAudio(
                JSONObject(
                    """{"numTracks":0,"numAudioFiles":0,"tracks":[],"audioFiles":[],
                       "duration":0,"ebookFile":{"ino":"9"}}"""
                )
            )
        )
    }

    @Test
    fun hasAudioAllFieldsAbsentIsFalse() {
        assertFalse(BrowseTree.hasAudio(JSONObject("{}")))
    }

    // ---- sequenceLabel: "Book 3" inside a series -------------------------

    @Test
    fun sequenceLabelFromSeriesObject() {
        assertEquals(
            "Book 3",
            BrowseTree.sequenceLabel(JSONObject("""{"series":{"sequence":"3"}}"""))
        )
    }

    @Test
    fun sequenceLabelSeriesObjectWinsOverSeriesNameSuffix() {
        assertEquals(
            "Book 3",
            BrowseTree.sequenceLabel(
                JSONObject("""{"series":{"sequence":"3"},"seriesName":"Expanse #9"}""")
            )
        )
    }

    @Test
    fun sequenceLabelFallsBackToTheSeriesNameHashSuffix() {
        assertEquals(
            "Book 9",
            BrowseTree.sequenceLabel(JSONObject("""{"seriesName":"Expanse #9"}"""))
        )
    }

    @Test
    fun sequenceLabelWithoutASequenceIsNull() {
        assertNull(BrowseTree.sequenceLabel(null))
        assertNull(BrowseTree.sequenceLabel(JSONObject("{}")))
        assertNull(BrowseTree.sequenceLabel(JSONObject("""{"seriesName":"Expanse"}""")))
    }

    // ---- libraryIconRes: the server's icon name -> a bundled drawable -----

    @Test
    fun everyMappedIconNameResolvesToAnAaDrawable() {
        val mapping = mapOf(
            "database" to "aa_lib_database",
            "audiobookshelf" to "aa_library",
            "books-1" to "aa_books",
            "books-2" to "aa_collections",
            "book-1" to "aa_library",
            "microphone-1" to "aa_lib_mic",
            "microphone-3" to "aa_lib_mic",
            "podcast" to "aa_lib_mic",
            "radio" to "aa_lib_radio",
            "rss" to "aa_lib_rss",
            "headphones" to "aa_lib_headphones",
            "music" to "aa_lib_music",
            "file-picture" to "aa_lib_image",
            "rocket" to "aa_lib_rocket",
            "power" to "aa_lib_power",
            "star" to "aa_lib_star",
            "heart" to "aa_lib_heart"
        )
        mapping.forEach { (name, drawable) ->
            assertEquals(drawable, BrowseStyles.libraryIconRes(name, "book"))
        }
    }

    @Test
    fun anUnknownIconFallsBackByMediaType() {
        // A server newer than this build must still render a tile.
        assertEquals("aa_library", BrowseStyles.libraryIconRes("brand-new-glyph", "book"))
        assertEquals("aa_lib_mic", BrowseStyles.libraryIconRes("brand-new-glyph", "podcast"))
        assertEquals("aa_library", BrowseStyles.libraryIconRes(null, "book"))
        assertEquals("aa_lib_mic", BrowseStyles.libraryIconRes(null, "podcast"))
    }

    @Test
    fun theIconUriIsAnAndroidResourceUriForTheApplicationId() {
        val uri = BrowseStyles.iconUri("com.tomesonic.app", "aa_series").toString()
        assertEquals("android.resource://com.tomesonic.app/drawable/aa_series", uri)
    }
}
