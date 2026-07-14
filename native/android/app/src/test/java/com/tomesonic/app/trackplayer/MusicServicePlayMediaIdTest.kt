package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pins parsePlayMediaId — the extracted parser for the
 * "play:<itemId>[::<episodeId>][@@<bookmarkSeconds>]" Android Auto media-id
 * grammar of the patched MusicService (node_modules/react-native-track-player/
 * android/src/main/java/com/doublesymmetry/trackplayer/service/MusicService.kt,
 * applied by patches/react-native-track-player+5.0.0-alpha0.patch).
 *
 * Before the extraction this grammar was inlined verbatim at four call sites
 * (onGetItem, onSetMediaItems, onAddMediaItems cold-start, absPersistTickOnce);
 * these tests lock the exact semantics each of those relied on. parsePlayMediaId
 * is private and returns the private PlayMediaId data class, so both the method
 * and its result fields are reached by reflection on a bare service from
 * Robolectric.buildService(...).get() (onCreate NEVER called).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServicePlayMediaIdTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    /** Reflected view of a parsed PlayMediaId. */
    private data class Parsed(val itemId: String, val episodeId: String?, val bookmarkSeconds: Double?)

    private fun parse(mediaId: String): Parsed {
        val m = try {
            MusicService::class.java.getDeclaredMethod("parsePlayMediaId", String::class.java)
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "parsePlayMediaId missing — signature changed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        val result = m.invoke(service, mediaId)!!
        val cls = result.javaClass
        fun get(name: String): Any? = cls.getDeclaredMethod(name).apply { isAccessible = true }.invoke(result)
        return Parsed(
            get("getItemId") as String,
            get("getEpisodeId") as String?,
            get("getBookmarkSeconds") as Double?
        )
    }

    @Test
    fun plainItemId() {
        val p = parse("play:a")
        assertEquals("a", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun itemAndEpisode() {
        val p = parse("play:a::e")
        assertEquals("a", p.itemId)
        assertEquals("e", p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun bookmarkSuffixIsStrippedFromItemId() {
        // onGetItem/onAddMediaItems relied on "@@<sec>" NOT bleeding into itemId.
        val p = parse("play:a@@123.5")
        assertEquals("a", p.itemId)
        assertNull(p.episodeId)
        assertEquals(123.5, p.bookmarkSeconds!!, 0.0)
    }

    @Test
    fun episodeAndZeroBookmark() {
        val p = parse("play:a::e@@0")
        assertEquals("a", p.itemId)
        assertEquals("e", p.episodeId)
        // "@@0" parses to 0.0 (present, not absent) — a real bookmark override.
        assertEquals(0.0, p.bookmarkSeconds!!, 0.0)
    }

    @Test
    fun bareplayPrefixYieldsEmptyItemId() {
        val p = parse("play:")
        assertEquals("", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun nonPlayInputRemovePrefixIsNoOp() {
        // Callers guard with startsWith("play:"); removePrefix is a no-op if the
        // prefix is absent, so a non-"play:" string parses as a bare itemId.
        val p = parse("abc")
        assertEquals("abc", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun malformedTripleColonSeparator() {
        // "play:::" -> body "::" -> itemId "" / episodeId "" (substringAfter first
        // "::" is empty). Documents that an empty episodeId is "" (present, not
        // null): the "::" is contained, so the episode branch is taken.
        val p = parse("play:::")
        assertEquals("", p.itemId)
        assertEquals("", p.episodeId)
        assertNull(p.bookmarkSeconds)
    }

    @Test
    fun malformedTrailingBookmarkDelimiter() {
        // Trailing "@@" with no number -> substringAfter("@@","") is "" ->
        // toDoubleOrNull() is null (no bookmark), itemId keeps the pre-"@@" part.
        val p = parse("play:a@@")
        assertEquals("a", p.itemId)
        assertNull(p.episodeId)
        assertNull(p.bookmarkSeconds)
    }
}
