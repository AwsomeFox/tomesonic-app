package com.tomesonic.app.trackplayer

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import com.doublesymmetry.trackplayer.service.MusicService
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.FileOutputStream

/**
 * Android Auto badge extras + offline cover inlining of the patched
 * MusicService (node_modules/react-native-track-player/.../service/
 * MusicService.kt, applied by patches/react-native-track-player+5.0.0-
 * alpha0.patch).
 *
 * absItemExtras: AA renders the native checkmark / progress bar / download
 * icon ONLY for the legacy MediaDescription extra keys — and those key
 * strings are counter-intuitive (media3's DESCRIPTION_EXTRAS_KEY_COMPLETION_
 * STATUS is literally "android.media.extra.PLAYBACK_STATUS", not the
 * "obvious" android.media.description.extra.* names, which render nothing).
 * The EXACT strings are asserted here so a well-meaning rename breaks CI
 * instead of silently blanking every badge in the car.
 *
 * absLocalArtBytes: downloaded covers are decoded + re-compressed to bytes
 * because Android Auto's process cannot read this app's private files — a
 * file:// URI renders as a blank tile. Only filesystem paths ("file://..."
 * or bare "/...") are decodable; http(s):// and content:// coverPaths come
 * back null from BitmapFactory.decodeFile (there is no such file), leaving
 * those URIs to the regular artwork loader.
 *
 * Harness per the sibling tests: Robolectric.buildService(...).get() (base
 * Context attached, onCreate never called), private members via reflection.
 * The download catalog is seeded end-to-end: write auto_downloads.json into
 * the service's filesDir and invoke the real absRefreshDownloaded parser.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceBadgesTest {

    // The load-bearing key strings (see the class doc): keep as literals.
    private companion object {
        const val KEY_PLAYBACK_STATUS = "android.media.extra.PLAYBACK_STATUS"
        const val KEY_COMPLETION = "androidx.media.MediaItem.Extras.COMPLETION_PERCENTAGE"
        const val KEY_DOWNLOAD_STATUS = "android.media.extra.DOWNLOAD_STATUS"
    }

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

    // ---- absItemExtras(prog: JSONObject?, downloaded: Boolean): Bundle ----

    private fun extras(prog: JSONObject?, downloaded: Boolean): Bundle =
        method("absItemExtras", JSONObject::class.java, Boolean::class.javaPrimitiveType!!)
            .invoke(service, prog, downloaded) as Bundle

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
        // AA reads this as a long (STATUS_DOWNLOADED = 2L); an Int here
        // silently renders no icon.
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

    // ---- absLocalArtBytes(itemId: String): ByteArray? ----

    private fun localArtBytes(itemId: String): ByteArray? =
        method("absLocalArtBytes", String::class.java)
            .invoke(service, itemId) as ByteArray?

    /** Writes a real 8x8 PNG into filesDir and returns its absolute path. */
    private fun writeCoverPng(name: String): String {
        val f = File(service.filesDir, name)
        val bmp = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        bmp.eraseColor(android.graphics.Color.RED)
        FileOutputStream(f).use { out ->
            check(bmp.compress(Bitmap.CompressFormat.PNG, 100, out)) { "PNG compress failed" }
        }
        bmp.recycle()
        return f.absolutePath
    }

    /** Seeds the real download catalog through the production JSON parser. */
    private fun seedDownloads(entriesJson: String) {
        File(service.filesDir, "auto_downloads.json").writeText(entriesJson)
        method("absRefreshDownloaded").invoke(service)
    }

    private fun entry(id: String, coverPath: String?): String {
        val cover = if (coverPath != null) ""","coverPath":${JSONObject.quote(coverPath)}""" else ""
        return """{"id":"$id","title":"T","currentTime":0,"duration":10,"tracks":[]$cover}"""
    }

    @Test
    fun fileSchemeCoverPathDecodesToInlineBytes() {
        val png = writeCoverPng("cover-scheme.png")
        seedDownloads("[${entry("bk-file", "file://$png")}]")
        val bytes = localArtBytes("bk-file")
        assertNotNull("file:// coverPath must decode", bytes)
        // The bytes must be a real image (AA decodes them on its side).
        assertNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes!!.size))
    }

    @Test
    fun barePathCoverPathDecodesToInlineBytes() {
        val png = writeCoverPng("cover-bare.png")
        seedDownloads("[${entry("bk-bare", png)}]")
        assertNotNull("bare /path coverPath must decode", localArtBytes("bk-bare"))
    }

    @Test
    fun httpAndHttpsCoverPathsAreLeftToTheArtworkLoader() {
        seedDownloads(
            "[" + entry("bk-http", "http://abs.example/api/items/x/cover") + "," +
                entry("bk-https", "https://abs.example/api/items/x/cover") + "]"
        )
        assertNull(localArtBytes("bk-http"))
        assertNull(localArtBytes("bk-https"))
    }

    @Test
    fun contentUriCoverPathIsLeftToTheArtworkLoader() {
        seedDownloads("[${entry("bk-content", "content://media/external/images/1")}]")
        assertNull(localArtBytes("bk-content"))
    }

    @Test
    fun missingCoverPathAndUnknownItemAreNull() {
        seedDownloads("[${entry("bk-nocover", null)}]")
        assertNull(localArtBytes("bk-nocover"))
        assertNull(localArtBytes("never-downloaded"))
    }

    @Test
    fun secondLookupServesTheCachedByteArray() {
        val png = writeCoverPng("cover-cache.png")
        seedDownloads("[${entry("bk-cache", "file://$png")}]")
        val first = localArtBytes("bk-cache")
        assertNotNull(first)
        // Same array instance: decode-once, then absArtCache serves it.
        assertSame(first, localArtBytes("bk-cache"))
    }
}
