package com.tomesonic.app.wear.downloads

import android.app.Application
import org.json.JSONArray
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
 * The index record's serialisation, both directions.
 *
 * Robolectric only because org.json lives in android.jar — nothing here touches
 * a Context. The rule every case pins is data/Models.kt's: a field the file
 * doesn't carry costs that FIELD, a malformed row costs that ROW, and neither
 * ever costs an exception. This file survives app upgrades and process kills,
 * so "written by an older build" and "half-written" are the normal cases.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class DownloadEntryTest {

    private val fullEntry = DownloadEntry(
        id = "li_book1",
        title = "Dune",
        author = "Frank Herbert",
        duration = 12345.5,
        coverPath = "/data/user/0/com.tomesonic.app/files/downloads/li_book1/cover.jpg",
        tracks = listOf(
            DownloadTrack("track_0.mp3", 0.0, 3600.0, "/api/items/li_book1/file/9001"),
            DownloadTrack("track_1.m4b", 3600.0, 8745.5, "/api/items/li_book1/file/9002")
        ),
        bytes = 734003200L
    )

    // ---- round trips -------------------------------------------------------

    @Test
    fun roundTripsAFullEntry() {
        val parsed = DownloadEntry.fromJson(JSONObject(fullEntry.toJson().toString()))
        assertEquals(fullEntry, parsed)
    }

    @Test
    fun roundTripsTheWholeArrayForm() {
        val entries = listOf(fullEntry, fullEntry.copy(id = "li_book2", title = "Ubik"))
        val text = DownloadEntry.toJsonArray(entries).toString()
        assertEquals(entries, DownloadEntry.parseList(text))
    }

    @Test
    fun anEmptyLibrarySerialisesToAnArrayNotNothing() {
        // "[]" is what makes a zero-length file distinguishable from a truncated
        // write — DownloadIndex leans on exactly that.
        assertEquals("[]", DownloadEntry.toJsonArray(emptyList()).toString())
        assertEquals(emptyList<DownloadEntry>(), DownloadEntry.parseList("[]"))
    }

    // ---- optional fields ---------------------------------------------------

    @Test
    fun optionalFieldsAreOmittedRatherThanWrittenAsNull() {
        // org.json's optString reads an explicit null back as the STRING "null",
        // which would render literally on the downloads screen.
        val bare = fullEntry.copy(author = null, coverPath = null)
        val json = bare.toJson()
        assertFalse(json.has("author"))
        assertFalse(json.has("coverPath"))
        assertEquals(bare, DownloadEntry.fromJson(JSONObject(json.toString())))
    }

    @Test
    fun explicitJsonNullsNeverBecomeTheStringNull() {
        val raw = """
            { "id": "li_n", "title": null, "author": null, "coverPath": null, "bytes": null }
        """.trimIndent()
        val entry = DownloadEntry.fromJson(JSONObject(raw))!!
        assertEquals("Audiobook", entry.title)
        assertNull(entry.author)
        assertNull(entry.coverPath)
        assertEquals(0L, entry.bytes)
    }

    @Test
    fun toleratesAnEntryCarryingNothingButAnId() {
        val entry = DownloadEntry.fromJson(JSONObject("""{ "id": "li_bare" }"""))!!
        assertEquals("li_bare", entry.id)
        assertEquals("Audiobook", entry.title)
        assertEquals(0.0, entry.duration, 1e-9)
        assertEquals(0L, entry.bytes)
        assertNull(entry.author)
        assertNull(entry.coverPath)
        assertTrue(entry.tracks.isEmpty())
    }

    @Test
    fun anEntryWithoutAnIdIsUnusable() {
        assertNull(DownloadEntry.fromJson(null))
        assertNull(DownloadEntry.fromJson(JSONObject("{}")))
        assertNull(DownloadEntry.fromJson(JSONObject("""{ "id": null }""")))
        assertNull(DownloadEntry.fromJson(JSONObject("""{ "id": "" }""")))
    }

    @Test
    fun nonFiniteDurationsSerialiseInsteadOfThrowing() {
        // JSONObject.put THROWS on NaN/Infinity, and a duration derived from bad
        // server metadata can be either — one such entry must not make the whole
        // index unwritable.
        val odd = fullEntry.copy(
            duration = Double.NaN,
            tracks = listOf(DownloadTrack("track_0.mp3", Double.POSITIVE_INFINITY, Double.NaN, null))
        )
        val parsed = DownloadEntry.fromJson(JSONObject(odd.toJson().toString()))!!
        assertEquals(0.0, parsed.duration, 1e-9)
        assertEquals(0.0, parsed.tracks[0].startOffset, 1e-9)
        assertEquals(0.0, parsed.tracks[0].duration, 1e-9)
        assertNull(parsed.tracks[0].contentUrl)
    }

    // ---- tracks ------------------------------------------------------------

    @Test
    fun aTrackWithoutAFilenameIsDroppedNotFaked() {
        // The filename IS the file on disk; a row without one is unplayable.
        val raw = """
            { "id": "li_t", "tracks": [
              { "startOffset": 0, "duration": 10 },
              { "filename": "track_1.mp3", "startOffset": 10, "duration": 20 }
            ] }
        """.trimIndent()
        val tracks = DownloadEntry.fromJson(JSONObject(raw))!!.tracks
        assertEquals(1, tracks.size)
        assertEquals("track_1.mp3", tracks[0].filename)
        assertEquals(10.0, tracks[0].startOffset, 1e-9)
    }

    @Test
    fun aTrackKeepsItsDefaultsWhenTheTimingIsMissing() {
        val track = DownloadTrack.fromJson(JSONObject("""{ "filename": "track_0.mp3" }"""))!!
        assertEquals(0.0, track.startOffset, 1e-9)
        assertEquals(0.0, track.duration, 1e-9)
        assertNull(track.contentUrl)
        assertNull(DownloadTrack.fromJson(null))
        assertNull(DownloadTrack.fromJson(JSONObject("{}")))
    }

    @Test
    fun wrongTypesWhereAnArrayBelongsCostTheTracksNotTheEntry() {
        val entry = DownloadEntry.fromJson(JSONObject("""{ "id": "li_w", "tracks": 7 }"""))!!
        assertTrue(entry.tracks.isEmpty())
    }

    // ---- whole-file parsing ------------------------------------------------

    @Test
    fun parseListReturnsNullOnlyWhenTheTextIsNotAnArray() {
        // Null is the quarantine signal DownloadIndex acts on, so it must mean
        // "this file is not an index", never "this file is empty".
        assertNull(DownloadEntry.parseList(null))
        assertNull(DownloadEntry.parseList(""))
        assertNull(DownloadEntry.parseList("   "))
        assertNull(DownloadEntry.parseList("not json at all"))
        assertNull(DownloadEntry.parseList("""{ "id": "li_1" }""")) // an object, not an array
        assertNull(DownloadEntry.parseList("""[{ "id": "li_1" }""")) // truncated
    }

    @Test
    fun parseListDropsUnreadableRowsAndKeepsTheRest() {
        val raw = JSONArray()
            .put(7)
            .put(JSONObject("""{ "title": "no id here" }"""))
            .put(fullEntry.toJson())
            .toString()
        val entries = DownloadEntry.parseList(raw)!!
        assertEquals(1, entries.size)
        assertEquals(fullEntry, entries[0])
    }
}
