package com.tomesonic.app.automotive.downloads

import android.app.Application
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
 * so "written by an older build" and "half-written" are the normal cases —
 * which is why the v1-schema rows below are tested as their own section rather
 * than as a footnote.
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

    private val episodeEntry = DownloadEntry(
        id = "li_pod-ep-ep_42",
        // The PODCAST's title; the episode's own is beside it.
        title = "The Show",
        author = "Host Person",
        duration = 1800.0,
        coverPath = "/data/user/0/com.tomesonic.app/files/downloads/li_pod-ep-ep_42/cover.jpg",
        tracks = listOf(DownloadTrack("track_0.mp3", 0.0, 1800.0, "/api/items/li_pod/file/7001")),
        bytes = 24_000_000L,
        libraryItemId = "li_pod",
        episodeId = "ep_42",
        episodeTitle = "Episode 42"
    )

    // ---- round trips -------------------------------------------------------

    @Test
    fun roundTripsAFullEntry() {
        val parsed = DownloadEntry.fromJson(JSONObject(fullEntry.toJson().toString()))
        assertEquals(fullEntry, parsed)
    }

    @Test
    fun roundTripsTheWholeArrayForm() {
        // copy() does not re-run `libraryItemId = id`'s default; a book's two
        // ids are the same string.
        val entries = listOf(
            fullEntry,
            fullEntry.copy(id = "li_book2", libraryItemId = "li_book2", title = "Ubik")
        )
        val text = DownloadEntry.toJsonArray(entries).toString()
        assertEquals(entries, DownloadEntry.parseList(text))
    }

    @Test
    fun roundTripsAnEpisodeEntry() {
        val parsed = DownloadEntry.fromJson(JSONObject(episodeEntry.toJson().toString()))
        assertEquals(episodeEntry, parsed)
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
        // which would render literally in a browse row.
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

    // ---- schema v1 -> v2 ---------------------------------------------------

    @Test
    fun aRowWrittenBeforeV2IsExactlyTheBookItAlwaysWas() {
        // The whole back-compat rule: no libraryItemId, no episode keys — an
        // upgraded head unit must keep playing (and keep counting) every book it
        // already has on disk.
        val raw = """
            { "id": "li_book1", "title": "Dune", "author": "Frank Herbert",
              "duration": 12345.5, "bytes": 734003200,
              "tracks": [ { "filename": "track_0.mp3", "startOffset": 0, "duration": 3600 } ] }
        """.trimIndent()
        val entry = DownloadEntry.fromJson(JSONObject(raw))!!
        assertEquals("li_book1", entry.id)
        assertEquals("li_book1", entry.libraryItemId)
        assertNull(entry.episodeId)
        assertNull(entry.episodeTitle)
        assertTrue(entry.isFor("li_book1", null))
        // ...and the folder it names is the one v1 created.
        assertEquals("li_book1", DownloadEntry.entryId("li_book1", null))
    }

    @Test
    fun aBookWritesNoEpisodeKeysAndAlwaysWritesItsItemId() {
        val json = fullEntry.toJson()
        assertEquals("li_book1", json.optString("libraryItemId"))
        assertFalse(json.has("episodeId"))
        assertFalse(json.has("episodeTitle"))
    }

    @Test
    fun aMixedIndexKeepsBothSchemasAndLosesOnlyTheBadRow() {
        val v1Book = JSONObject("""{ "id": "li_v1", "title": "Ubik", "bytes": 10 }""")
        val raw = JSONArray()
            .put(v1Book)
            .put(JSONObject("""{ "episodeId": "ep_1", "title": "no id" }"""))
            .put(episodeEntry.toJson())
            .toString()
        val entries = DownloadEntry.parseList(raw)!!
        assertEquals(2, entries.size)
        assertEquals("li_v1", entries[0].libraryItemId)
        assertNull(entries[0].episodeId)
        assertEquals(episodeEntry, entries[1])
    }

    @Test
    fun isForSeparatesABookFromItsOwnEpisodes() {
        // The reason an item id alone is not the answer: a podcast and its
        // episode both name the same libraryItemId.
        assertTrue(episodeEntry.isFor("li_pod", "ep_42"))
        assertFalse(episodeEntry.isFor("li_pod", null))
        assertFalse(episodeEntry.isFor("li_pod", "ep_43"))
        assertFalse(episodeEntry.isFor("li_other", "ep_42"))
        assertTrue(fullEntry.isFor("li_book1", null))
        // Blank is absent — the repository's null-or-blank convention.
        assertTrue(fullEntry.isFor("li_book1", ""))
        assertFalse(fullEntry.isFor("li_book1", "ep_42"))
    }

    // ---- entry ids ---------------------------------------------------------

    @Test
    fun aBooksEntryIdIsItsItemIdUntouched() {
        assertEquals("li_book1", DownloadEntry.entryId("li_book1", null))
        // Blank reads as "no episode", which is what keeps a stray "" from
        // minting a second folder for the same book.
        assertEquals("li_book1", DownloadEntry.entryId("li_book1", ""))
        assertEquals("li_book1", DownloadEntry.entryId("li_book1", "   "))
    }

    @Test
    fun anAlreadySafeEpisodeIdIsKeptVerbatim() {
        // ABS ids are nanoids: the common case must stay readable on disk and
        // identical between builds.
        assertEquals("li_pod-ep-ep_42", DownloadEntry.entryId("li_pod", "ep_42"))
        assertEquals("ep_42", DownloadEntry.sanitizeSegment("ep_42"))
        assertEquals("A-Z.a-z_0-9", DownloadEntry.sanitizeSegment("A-Z.a-z_0-9"))
    }

    @Test
    fun aDirtyEpisodeIdIsFlattenedAndHashed() {
        val id = DownloadEntry.sanitizeSegment("https://feed/ep 1")
        // Every disallowed character becomes '_', and the hash marks that
        // something WAS replaced.
        assertTrue(id.startsWith("https___feed_ep_1-"))
        assertEquals("https___feed_ep_1".length + 9, id.length)
        // A single plain path component: nothing here can escape a folder.
        assertTrue(DownloadWorker.isSafeName(id))
        assertTrue(DownloadWorker.isSafeName(DownloadEntry.entryId("li_pod", "https://feed/ep 1")))
    }

    @Test
    fun sanitisingIsDeterministicAcrossCalls() {
        // The id IS the folder name — one that changed between runs would orphan
        // a folder full of audio and re-download it.
        assertEquals(
            DownloadEntry.sanitizeSegment("tag:feed,2026:ep/1"),
            DownloadEntry.sanitizeSegment("tag:feed,2026:ep/1")
        )
    }

    @Test
    fun twoEpisodeIdsThatFlattenTheSameStillGetTheirOwnFolder() {
        // The collision the hash exists for: `ep/1` and `ep:1` both flatten to
        // `ep_1`, and one folder for two episodes is one episode's audio played
        // as the other's.
        val slash = DownloadEntry.entryId("li_pod", "ep/1")
        val colon = DownloadEntry.entryId("li_pod", "ep:1")
        assertNotEquals(slash, colon)
        assertTrue(slash.startsWith("li_pod-ep-ep_1-"))
        assertTrue(colon.startsWith("li_pod-ep-ep_1-"))
        // ...and neither may collide with an episode LITERALLY called ep_1,
        // which is the one id that keeps its exact name.
        assertEquals("li_pod-ep-ep_1", DownloadEntry.entryId("li_pod", "ep_1"))
        assertNotEquals(slash, DownloadEntry.entryId("li_pod", "ep_1"))
    }
}
