package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pure formatter/predicate helpers of the patched MusicService
 * (node_modules/react-native-track-player/android/src/main/java/com/
 * doublesymmetry/trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch):
 *
 *  - absStr:           null-safe optString (org.json returns the literal
 *                      string "null" for explicit JSON nulls — that rendered
 *                      in the car UI).
 *  - absHasAudio:      audio-relevance filter across minified
 *                      (numTracks/numAudioFiles) and expanded (tracks[]/
 *                      audioFiles[]) media payload shapes.
 *  - absSequenceLabel: "Book 3" from series.sequence, falling back to the
 *                      "Name #3" suffix on minified seriesName rows.
 *  - speedIconRes:     playback-speed bucket -> media3 icon. Asserted via
 *                      resId EQUALITY across boundary pairs so the test never
 *                      names media3's R constants.
 *
 * All four are private, so they are invoked by reflection on a bare service
 * from Robolectric.buildService(...).get() (base Context attached, onCreate
 * NEVER called — construction-safe per the sibling tests' analysis).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceFormattersTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    private fun method(name: String, vararg types: Class<*>): java.lang.reflect.Method {
        val m = try {
            MusicService::class.java.getDeclaredMethod(name, *types)
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "$name missing — signature changed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        return m
    }

    // ---- absStr(o: JSONObject?, key: String): String? ----

    private fun absStr(o: JSONObject?, key: String): String? =
        method("absStr", JSONObject::class.java, String::class.java)
            .invoke(service, o, key) as String?

    @Test
    fun absStrAbsentKeyIsNull() {
        assertNull(absStr(JSONObject("{}"), "k"))
    }

    @Test
    fun absStrExplicitJsonNullIsNullNotTheStringNull() {
        // org.json's optString gotcha: an explicit JSON null reads back as the
        // four-character string "null" — absStr exists to swallow exactly that.
        val v = absStr(JSONObject("""{"k":null}"""), "k")
        assertNotEquals("null", v)
        assertNull(v)
    }

    @Test
    fun absStrEmptyStringIsNull() {
        assertNull(absStr(JSONObject("""{"k":""}"""), "k"))
    }

    @Test
    fun absStrRealValuePassesThrough() {
        assertEquals("x", absStr(JSONObject("""{"k":"x"}"""), "k"))
    }

    @Test
    fun absStrNullReceiverIsNull() {
        assertNull(absStr(null, "k"))
    }

    // ---- absHasAudio(mediaObj: JSONObject?): Boolean ----

    private fun absHasAudio(o: JSONObject?): Boolean =
        method("absHasAudio", JSONObject::class.java).invoke(service, o) as Boolean

    @Test
    fun hasAudioNullMediaIsFalse() {
        assertFalse(absHasAudio(null))
    }

    @Test
    fun hasAudioMinifiedNumTracks() {
        // Minified library rows carry counts, not arrays.
        assertTrue(absHasAudio(JSONObject("""{"numTracks":12,"numAudioFiles":0}""")))
    }

    @Test
    fun hasAudioMinifiedNumAudioFiles() {
        assertTrue(absHasAudio(JSONObject("""{"numTracks":0,"numAudioFiles":3}""")))
    }

    @Test
    fun hasAudioExpandedTracksArray() {
        // Expanded payloads carry the arrays themselves.
        assertTrue(absHasAudio(JSONObject("""{"tracks":[{"index":0,"duration":600}]}""")))
    }

    @Test
    fun hasAudioExpandedAudioFilesArray() {
        assertTrue(absHasAudio(JSONObject("""{"audioFiles":[{"index":0}]}""")))
    }

    @Test
    fun hasAudioDurationOnly() {
        assertTrue(absHasAudio(JSONObject("""{"duration":7521.5}""")))
    }

    @Test
    fun hasAudioEbookOnlyItemIsFalse() {
        // Ebook-only item: zero counts, empty arrays, zero duration.
        val ebook = JSONObject(
            """{"numTracks":0,"numAudioFiles":0,"tracks":[],"audioFiles":[],"duration":0.0,"ebookFormat":"epub"}"""
        )
        assertFalse(absHasAudio(ebook))
    }

    @Test
    fun hasAudioAllFieldsAbsentIsFalse() {
        assertFalse(absHasAudio(JSONObject("{}")))
    }

    // ---- absSequenceLabel(md: JSONObject?): String? ----

    private fun absSequenceLabel(o: JSONObject?): String? =
        method("absSequenceLabel", JSONObject::class.java).invoke(service, o) as String?

    @Test
    fun sequenceLabelFromSeriesObject() {
        assertEquals(
            "Book 3",
            absSequenceLabel(JSONObject("""{"series":{"sequence":"3"}}"""))
        )
    }

    @Test
    fun sequenceLabelSeriesObjectWinsOverSeriesNameSuffix() {
        assertEquals(
            "Book 3",
            absSequenceLabel(JSONObject("""{"series":{"sequence":"3"},"seriesName":"Saga #9"}"""))
        )
    }

    @Test
    fun sequenceLabelFallsBackToSeriesNameHashSuffix() {
        // Minified rows have no series object — only "Name #3" on seriesName.
        assertEquals(
            "Book 3",
            absSequenceLabel(JSONObject("""{"seriesName":"Wheel of Time #3"}"""))
        )
    }

    @Test
    fun sequenceLabelNoSeriesIsNull() {
        assertNull(absSequenceLabel(JSONObject("{}")))
    }

    @Test
    fun sequenceLabelNullMetadataIsNull() {
        assertNull(absSequenceLabel(null))
    }

    @Test
    fun sequenceLabelEmptySequenceIsNull() {
        assertNull(absSequenceLabel(JSONObject("""{"series":{"sequence":""}}""")))
    }

    @Test
    fun sequenceLabelEmptySequenceStillFallsThroughToSeriesName() {
        // Documents the elvis chain: an empty series.sequence does not
        // short-circuit — the seriesName suffix still applies.
        assertEquals(
            "Book 4",
            absSequenceLabel(JSONObject("""{"series":{"sequence":""},"seriesName":"Saga #4"}"""))
        )
    }

    @Test
    fun sequenceLabelSeriesNameWithoutHashIsNull() {
        assertNull(absSequenceLabel(JSONObject("""{"seriesName":"Standalone Series"}""")))
    }

    // ---- speedIconRes(speed: Float): Int ----

    private fun res(speed: Float): Int =
        method("speedIconRes", Float::class.javaPrimitiveType!!)
            .invoke(service, speed) as Int

    @Test
    fun speedBucketBoundariesMatchTheJsSpeedSteps() {
        // <=0.85 -> 0.8x icon
        assertEquals(res(0.5f), res(0.85f))
        assertNotEquals(res(0.85f), res(0.86f))
        // <=1.1 -> 1.0x icon
        assertEquals(res(0.86f), res(1.0f))
        assertEquals(res(1.0f), res(1.1f))
        assertNotEquals(res(1.1f), res(1.11f))
        // <=1.35 -> 1.2x icon
        assertEquals(res(1.11f), res(1.35f))
        assertNotEquals(res(1.35f), res(1.36f))
        // <=1.65 -> 1.5x icon
        assertEquals(res(1.36f), res(1.5f))
        assertEquals(res(1.5f), res(1.65f))
        assertNotEquals(res(1.65f), res(1.66f))
        // <=1.9 -> 1.8x icon
        assertEquals(res(1.66f), res(1.9f))
        assertNotEquals(res(1.9f), res(1.91f))
        // else -> 2.0x icon (open-ended top bucket)
        assertEquals(res(1.91f), res(2.0f))
        assertEquals(res(2.0f), res(3.5f))
    }

    @Test
    fun speedBucketsAreSixDistinctIcons() {
        val ids = setOf(res(0.8f), res(1.0f), res(1.2f), res(1.5f), res(1.8f), res(2.5f))
        assertEquals("expected six distinct speed icons", 6, ids.size)
    }
}
