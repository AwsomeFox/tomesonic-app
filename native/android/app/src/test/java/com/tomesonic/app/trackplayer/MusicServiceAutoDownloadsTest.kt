package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pins parseAutoDownloads — the auto_downloads.json -> offline-catalog map
 * builder extracted from absRefreshDownloaded in the patched MusicService
 * (node_modules/react-native-track-player/android/src/main/java/com/
 * doublesymmetry/trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch).
 *
 * Two row shapes coexist: legacy bare-string ids (badge only) and rich
 * JSONObject rows with a tracks[] list. The "keep last good map on throw"
 * recovery stays in absRefreshDownloaded's wrapper AROUND this call, so
 * parseAutoDownloads itself just maps a JSONArray. Both the method and the
 * private AbsDownload value fields are reached by reflection on a bare service
 * from Robolectric.buildService(...).get() (onCreate NEVER called).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceAutoDownloadsTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    @Suppress("UNCHECKED_CAST")
    private fun parse(json: String): Map<String, Any?> {
        val m = try {
            MusicService::class.java.getDeclaredMethod("parseAutoDownloads", JSONArray::class.java)
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "parseAutoDownloads missing — signature changed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        return m.invoke(service, JSONArray(json)) as Map<String, Any?>
    }

    /** Reflected getter on the private AbsDownload value class. */
    private fun field(row: Any?, getter: String): Any? =
        row!!.javaClass.getDeclaredMethod(getter).apply { isAccessible = true }.invoke(row)

    private fun trackCount(row: Any?): Int = (field(row, "getTracks") as List<*>).size

    @Test
    fun emptyArrayYieldsEmptyMap() {
        assertTrue(parse("[]").isEmpty())
    }

    @Test
    fun legacyBareStringIds() {
        val out = parse("""["a","b"]""")
        assertEquals(2, out.size)
        assertEquals(setOf("a", "b"), out.keys)
        // Legacy rows are badge-only: default title, no author, no tracks.
        assertEquals("Audiobook", field(out["a"], "getTitle"))
        assertNull(field(out["a"], "getAuthor"))
        assertEquals(0, trackCount(out["a"]))
    }

    @Test
    fun richObjectWithTracks() {
        val out = parse(
            """[{"id":"x","title":"T","author":"A","folder":"F","coverPath":"C",
               "currentTime":10.0,"duration":100.0,
               "tracks":[{"filename":"f1","startOffset":0,"duration":50},
                         {"filename":"f2","startOffset":50,"duration":50}]}]"""
        )
        assertEquals(1, out.size)
        assertEquals(setOf("x"), out.keys)
        assertEquals("T", field(out["x"], "getTitle"))
        assertEquals("A", field(out["x"], "getAuthor"))
        assertEquals(100.0, field(out["x"], "getDuration") as Double, 0.0)
        assertEquals(2, trackCount(out["x"]))
    }

    @Test
    fun malformedElementsAreSkipped() {
        // A non-string/non-object element (42) is ignored; a JSONObject with an
        // empty id is skipped (continue). Only the two valid rows survive.
        val out = parse("""["valid",42,{"id":""},{"id":"y","title":"Y"}]""")
        assertEquals(2, out.size)
        assertEquals(setOf("valid", "y"), out.keys)
        assertEquals("Y", field(out["y"], "getTitle"))
    }
}
