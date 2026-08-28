package com.tomesonic.app.automotive.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The frozen media-id grammar (ARCHITECTURE.md §4.1).
 *
 * The rewrite of `MusicServicePlayMediaIdTest` from the phone module (which
 * reflected into the patch's private `parsePlayMediaId`), with the table from
 * `native/utils/playMediaId.ts`'s own unit test folded in — the two parsers are
 * one contract, and the cases that make them one are the FIRST-occurrence
 * splits: `a@@1@@2` and `a::e::x` are where a `split()`-based rewrite of either
 * side would quietly diverge.
 *
 * The one place the two sides differ on purpose is an EMPTY episode segment,
 * and it is asserted here in both spellings so the divergence stays a decision
 * rather than a surprise.
 */
class PlayMediaIdTest {

    // ---- The prefixed form, as the car hands it back on a tap -------------

    @Test
    fun plainItemId() {
        val p = PlayMediaId.parse("play:a")
        assertEquals("a", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun itemAndEpisode() {
        val p = PlayMediaId.parse("play:a::e")
        assertEquals("a", p.itemId)
        assertEquals("e", p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun bookmarkSuffixIsStrippedFromItemId() {
        val p = PlayMediaId.parse("play:a@@123.5")
        assertEquals("a", p.itemId)
        assertNull(p.episodeId)
        assertEquals(123.5, p.bookmarkSeconds!!, 0.0)
    }

    @Test
    fun episodeAndZeroBookmark() {
        val p = PlayMediaId.parse("play:a::e@@0")
        assertEquals("a", p.itemId)
        assertEquals("e", p.episodeId)
        // "@@0" parses to 0.0 (present, not absent) — a real position override.
        assertEquals(0.0, p.bookmarkSeconds!!, 0.0)
    }

    @Test
    fun barePlayPrefixYieldsEmptyItemId() {
        val p = PlayMediaId.parse("play:")
        assertEquals("", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun nonPlayInputRemovePrefixIsNoOp() {
        // Callers guard with isPlayId first; removePrefix is a no-op when the
        // prefix is absent, so the stripped form parses as a bare item id —
        // which is exactly what the JS side's `hasPrefix: false` does.
        val p = PlayMediaId.parse("abc")
        assertEquals("abc", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun strippedFormWithEpisodeAndBookmark() {
        val p = PlayMediaId.parse("a::e@@5")
        assertEquals("a", p.itemId)
        assertEquals("e", p.episodeId)
        assertEquals(5.0, p.bookmarkSeconds!!, 0.0)
    }

    // ---- Malformed input: documented, never thrown ------------------------

    @Test
    fun malformedTripleColonSeparator() {
        // "play:::" -> body "::" -> itemId "" / episodeId "" (the "::" IS
        // contained, so the episode branch is taken).
        val p = PlayMediaId.parse("play:::")
        assertEquals("", p.itemId)
        assertEquals("", p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun emptyEpisodeSegmentIsPresentButBlank() {
        // The ONE documented difference from native/utils/playMediaId.ts, which
        // collapses this to `undefined`. Kotlin keeps "", and every consumer
        // asks episodeOrNull() rather than trusting the raw field — a blank
        // episode id would build "/api/items/{id}/play/" and 404.
        val p = PlayMediaId.parse("play:a::")
        assertEquals("a", p.itemId)
        assertEquals("", p.episodeId)
        assertNull(p.episodeOrNull())
    }

    @Test
    fun malformedTrailingBookmarkDelimiter() {
        // Trailing "@@" with no number -> substringAfter("@@", "") is "" ->
        // toDoubleOrNull() is null, and the item id keeps the pre-"@@" part.
        val p = PlayMediaId.parse("play:a@@")
        assertEquals("a", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun nonNumericBookmarkIsNoBookmark() {
        assertNull(PlayMediaId.parse("a@@later").bookmarkSeconds)
    }

    @Test
    fun firstOccurrenceSplitsMatchTheJsParser() {
        // Kotlin: substringAfter("@@") is "1@@2" -> toDoubleOrNull() is null. A
        // split("@@") would wrongly yield 1.0.
        val bookmark = PlayMediaId.parse("a@@1@@2")
        assertEquals("a", bookmark.itemId)
        assertNull(bookmark.bookmarkSeconds)
        // Kotlin: substringAfter("::") is "e::x". A split("::") would wrongly
        // yield "e".
        val episode = PlayMediaId.parse("a::e::x")
        assertEquals("a", episode.itemId)
        assertEquals("e::x", episode.episodeId)
    }

    @Test
    fun emptyStringParsesToAnEmptyItemId() {
        val p = PlayMediaId.parse("")
        assertEquals("", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    // ---- format(): the inverse the browse tree builds ids with ------------

    @Test
    fun formatBuildsTheThreeShapesOfTheGrammar() {
        assertEquals("play:a", PlayMediaId.format("a"))
        assertEquals("play:a::e", PlayMediaId.format("a", "e"))
        assertEquals("play:a::e@@12.5", PlayMediaId.format("a", "e", 12.5))
        assertEquals("play:a@@12.5", PlayMediaId.format("a", null, 12.5))
    }

    @Test
    fun formatOmitsABlankEpisodeRatherThanEmittingTheAmbiguousForm() {
        assertEquals("play:a", PlayMediaId.format("a", ""))
        assertEquals("play:a", PlayMediaId.format("a", "   "))
    }

    @Test
    fun formatRoundTripsThroughParse() {
        listOf("play:a", "play:a::e", "play:a@@12.5", "play:a::e@@0.0").forEach { id ->
            assertEquals(id, PlayMediaId.parse(id).format())
        }
    }

    @Test
    fun isPlayIdOnlyMatchesThePrefix() {
        assertTrue(PlayMediaId.isPlayId("play:a"))
        assertFalse(PlayMediaId.isPlayId("__ROOT__"))
        assertFalse(PlayMediaId.isPlayId("lib:l1:book"))
    }
}
