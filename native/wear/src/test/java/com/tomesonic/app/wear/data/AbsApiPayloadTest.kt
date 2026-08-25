package com.tomesonic.app.wear.data

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The request bodies AbsApi sends, pinned without a server.
 *
 * These shapes are contracts with ABS, not implementation details: a missing
 * `supportedMimeTypes` entry makes the server answer /play with an EMPTY track
 * set (the failure looks like "this book has no audio"), and a NaN in a sync
 * body throws out of JSONObject.put and silently drops a progress update.
 *
 * Robolectric only for org.json — no Context is touched.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class AbsApiPayloadTest {

    private fun body() = AbsApi.playSessionBody(
        deviceId = "dev-uuid-1",
        clientVersion = "1.2.3",
        manufacturer = "Google",
        model = "Pixel Watch",
        sdkVersion = 34
    )

    @Test
    fun playSessionBodyCarriesTheDeviceInfoAbsExpects() {
        val deviceInfo = body().getJSONObject("deviceInfo")
        assertEquals("dev-uuid-1", deviceInfo.getString("deviceId"))
        assertEquals("TomeSonic Wear", deviceInfo.getString("clientName"))
        assertEquals("1.2.3", deviceInfo.getString("clientVersion"))
        assertEquals("Google", deviceInfo.getString("manufacturer"))
        assertEquals("Pixel Watch", deviceInfo.getString("model"))
        assertEquals(34, deviceInfo.getInt("sdkVersion"))
    }

    @Test
    fun playSessionBodyAsksForDirectPlayWithoutForcingEitherWay() {
        val body = body()
        assertEquals("exo-player", body.getString("mediaPlayer"))
        assertFalse(body.getBoolean("forceDirectPlay"))
        assertFalse(body.getBoolean("forceTranscode"))
    }

    @Test
    fun supportedMimeTypesMatchThePhoneListExactly() {
        // Verbatim from store/usePlaybackStore.ts — this list is what makes the
        // server return real tracks instead of an empty set.
        val expected = listOf(
            "audio/flac", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a",
            "audio/m4b", "audio/aac", "audio/ogg", "audio/opus", "audio/webm",
            "audio/x-m4a"
        )
        assertEquals(expected, AbsApi.SUPPORTED_MIME_TYPES)
        val arr = body().getJSONArray("supportedMimeTypes")
        assertEquals(expected.size, arr.length())
        expected.forEachIndexed { i, mime -> assertEquals(mime, arr.getString(i)) }
    }

    @Test
    fun syncBodyIsExactlyTheThreeFieldsTheSyncAndCloseRoutesTake() {
        val body = AbsApi.syncBody(120.5, 15.0, 3600.0)
        assertEquals(3, body.length())
        assertEquals(120.5, body.getDouble("currentTime"), 1e-9)
        assertEquals(15.0, body.getDouble("timeListened"), 1e-9)
        assertEquals(3600.0, body.getDouble("duration"), 1e-9)
    }

    @Test
    fun syncBodyNeutralisesNonFiniteNumbers() {
        // A player reports NaN/Infinity while a track is torn down, and
        // JSONObject.put THROWS on those — the whole sync would be lost.
        val body = AbsApi.syncBody(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)
        assertEquals(0.0, body.getDouble("currentTime"), 1e-9)
        assertEquals(0.0, body.getDouble("timeListened"), 1e-9)
        assertEquals(0.0, body.getDouble("duration"), 1e-9)
    }

    @Test
    fun pathSegmentsAreEncodedWithoutFormPluses() {
        assertEquals("li_abc123", AbsApi.enc("li_abc123"))
        // URLEncoder is FORM encoding — its "+" for a space is wrong in a path.
        assertEquals("a%20b", AbsApi.enc("a b"))
        assertEquals("a%2Fb", AbsApi.enc("a/b"))
    }

    @Test
    fun responseParsingNeverThrowsOnGarbage() {
        assertNull(AbsApi.parseObject(null))
        assertNull(AbsApi.parseObject(""))
        // A reverse proxy's HTML error page is the realistic case.
        assertNull(AbsApi.parseObject("<html><body>502</body></html>"))
        assertNull(AbsApi.parseObject("[1,2,3]")) // an array where an object was expected
        assertTrue(AbsApi.parseObject("""{"ok":true}""")!!.getBoolean("ok"))
    }
}
