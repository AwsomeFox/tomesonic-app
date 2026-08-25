package com.tomesonic.app.wear.data

import android.app.Application
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * ABS response parsing, against real response shapes.
 *
 * Robolectric only because org.json lives in android.jar: the stub in a plain
 * unit test throws "not mocked" on every call. Nothing here touches a Context.
 *
 * The rule every case pins: a field the server didn't send, sent as an explicit
 * null, or sent with the wrong type costs that FIELD — never the row, and never
 * an exception on a UI thread.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class ModelsTest {

    // ---- fixtures ----------------------------------------------------------

    /** `GET /api/items/{id}?expanded=1` for a book — the full happy path. */
    private val expandedBook = """
        {
          "id": "li_book1",
          "mediaType": "book",
          "size": 734003200,
          "media": {
            "duration": 12345.5,
            "metadata": { "title": "Dune", "authorName": "Frank Herbert" },
            "chapters": [
              { "id": 0, "start": 0, "end": 100.5, "title": "One" },
              { "id": 1, "start": 100.5, "end": 400, "title": "Two" }
            ],
            "tracks": [
              {
                "index": 0,
                "startOffset": 0,
                "duration": 3600,
                "title": "Part 1",
                "contentUrl": "/api/items/li_book1/file/9001",
                "mimeType": "audio/mpeg",
                "metadata": { "ext": ".mp3", "filename": "dune-01.mp3" }
              },
              {
                "index": 1,
                "startOffset": 3600,
                "duration": 8745.5,
                "contentUrl": "/api/items/li_book1/file/9002",
                "mimeType": "audio/mp4",
                "metadata": { "ext": "m4b", "filename": "dune-02.m4b" }
              }
            ]
          },
          "userMediaProgress": { "currentTime": 4200.25, "duration": 12345.5, "progress": 0.34 }
        }
    """.trimIndent()

    /** No `tracks`, only `audioFiles` — no startOffset and no contentUrl on the rows. */
    private val expandedAudioFilesOnly = """
        {
          "id": "li_af",
          "media": {
            "metadata": { "title": "No Tracks" },
            "audioFiles": [
              { "index": 1, "ino": "1111", "duration": 600, "metadata": { "ext": "mp3" } },
              { "index": 2, "ino": "2222", "duration": 900, "metadata": { "ext": "mp3" } }
            ]
          }
        }
    """.trimIndent()

    /** A minified `/api/libraries/{id}/items` result row. */
    private val minifiedRow = """
        {
          "id": "li_min",
          "mediaType": "book",
          "media": {
            "numTracks": 3,
            "metadata": { "title": "Minified Book", "authorName": "A. Writer" }
          }
        }
    """.trimIndent()

    /** An `/api/me/items-in-progress` podcast row, with recentEpisode. */
    private val inProgressPodcastRow = """
        {
          "id": "li_pod",
          "mediaType": "podcast",
          "media": { "metadata": { "title": "The Show", "author": "Host Person" } },
          "recentEpisode": { "id": "ep_42", "title": "Episode 42" },
          "userMediaProgress": { "currentTime": 300, "duration": 1200 }
        }
    """.trimIndent()

    private val expandedPodcast = """
        {
          "id": "li_pod",
          "mediaType": "podcast",
          "media": {
            "metadata": { "title": "The Show", "author": "Host Person" },
            "episodes": [
              { "id": "ep_1", "title": "First", "publishedAt": 1700000000000,
                "audioFile": { "duration": 1800 } },
              { "id": "ep_2", "title": "Second", "duration": 2400 }
            ]
          }
        }
    """.trimIndent()

    private val playSession = """
        {
          "id": "sess_1",
          "libraryItemId": "li_book1",
          "episodeId": null,
          "mediaType": "book",
          "displayTitle": "Dune",
          "displayAuthor": "Frank Herbert",
          "duration": 12345.5,
          "currentTime": 4200.25,
          "audioTracks": [
            { "index": 0, "startOffset": 0, "duration": 3600,
              "contentUrl": "/hls/sess_1/output.m3u8", "mimeType": "application/x-mpegURL" }
          ],
          "chapters": [ { "id": 0, "start": 0, "end": 100, "title": "One" } ]
        }
    """.trimIndent()

    private fun obj(raw: String) = JSONObject(raw)

    // ---- ItemDetail: happy path -------------------------------------------

    @Test
    fun parsesAnExpandedBook() {
        val item = ItemDetail.fromJson(obj(expandedBook))!!
        assertEquals("li_book1", item.id)
        assertEquals("Dune", item.title)
        assertEquals("Frank Herbert", item.authorName)
        assertEquals("book", item.mediaType)
        assertEquals(12345.5, item.duration, 1e-9)
        assertEquals(734003200L, item.size!!)
        assertEquals(4200.25, item.userProgressCurrentTime!!, 1e-9)
        assertEquals(2, item.chapters.size)
        assertEquals(100.5, item.chapters[0].end, 1e-9)
        assertEquals("Two", item.chapters[1].title)
    }

    @Test
    fun derivesTrackFilenamesTheWayTheDownloaderDoes() {
        val tracks = ItemDetail.fromJson(obj(expandedBook))!!.tracks
        assertEquals(2, tracks.size)
        // Leading dot stripped from `.mp3`, exactly like utils/downloader.ts.
        assertEquals("track_0.mp3", tracks[0].filename)
        assertEquals("track_1.m4b", tracks[1].filename)
        assertEquals("/api/items/li_book1/file/9001", tracks[0].contentUrl)
        assertEquals("audio/mp4", tracks[1].mimeType)
        assertEquals(3600.0, tracks[1].startOffset, 1e-9)
        // A row with no `title` falls back to its filename metadata.
        assertEquals("Part 1", tracks[0].title)
        assertEquals("dune-02.m4b", tracks[1].title)
    }

    @Test
    fun fallsBackToAudioFilesAndSynthesisesOffsetsAndContentUrls() {
        val item = ItemDetail.fromJson(obj(expandedAudioFilesOnly))!!
        assertEquals(2, item.tracks.size)
        // audioFiles rows carry no startOffset — durations accumulate instead.
        assertEquals(0.0, item.tracks[0].startOffset, 1e-9)
        assertEquals(600.0, item.tracks[1].startOffset, 1e-9)
        // ...and no contentUrl: the /file/{ino} route is the documented fallback.
        assertEquals("/api/items/li_af/file/1111", item.tracks[0].contentUrl)
        assertEquals("/api/items/li_af/file/2222", item.tracks[1].contentUrl)
        // Filenames follow the row's own index, not its ordinal.
        assertEquals("track_1.mp3", item.tracks[0].filename)
        // media.duration absent -> summed track durations.
        assertEquals(1500.0, item.duration, 1e-9)
    }

    @Test
    fun uniquifiesFilenamesWhenTheServerRepeatsATrackIndex() {
        // Malformed metadata does this; identical filenames would let one
        // downloaded file overwrite another and both tracks play the same audio.
        val raw = """
            { "id": "li_dup", "media": { "tracks": [
              { "index": 0, "duration": 10, "metadata": { "ext": "mp3" } },
              { "index": 0, "duration": 20, "metadata": { "ext": "mp3" } }
            ] } }
        """.trimIndent()
        val tracks = ItemDetail.fromJson(obj(raw))!!.tracks
        assertEquals("track_0.mp3", tracks[0].filename)
        assertEquals("track_0_1.mp3", tracks[1].filename)
    }

    @Test
    fun fallsBackToTheLastChapterEndForDuration() {
        val raw = """
            { "id": "li_c", "media": { "chapters": [
              { "start": 0, "end": 60 }, { "start": 60, "end": 180 }
            ] } }
        """.trimIndent()
        val item = ItemDetail.fromJson(obj(raw))!!
        assertEquals(180.0, item.duration, 1e-9)
        // No title anywhere -> the book default, not an empty label.
        assertEquals("Audiobook", item.title)
        // Missing chapter titles get positional ones, never "null".
        assertEquals("Chapter 1", item.chapters[0].title)
    }

    @Test
    fun toleratesMissingOptionalFields() {
        val item = ItemDetail.fromJson(obj("""{ "id": "li_bare" }"""))!!
        assertEquals("li_bare", item.id)
        assertEquals("book", item.mediaType)
        assertEquals(0.0, item.duration, 1e-9)
        assertNull(item.authorName)
        assertNull(item.size)
        assertNull(item.userProgressCurrentTime)
        assertTrue(item.chapters.isEmpty())
        assertTrue(item.tracks.isEmpty())
        assertTrue(item.episodes.isEmpty())
    }

    @Test
    fun explicitJsonNullsNeverBecomeTheStringNull() {
        // org.json's optString returns "null" for an explicit null — the single
        // gotcha that has bitten every ABS parser in this repo.
        val raw = """
            { "id": "li_n", "mediaType": null,
              "media": { "metadata": { "title": null, "authorName": null } } }
        """.trimIndent()
        val item = ItemDetail.fromJson(obj(raw))!!
        assertEquals("Audiobook", item.title)
        assertNull(item.authorName)
        assertEquals("book", item.mediaType)
    }

    @Test
    fun malformedShapesReturnNullOrEmptyInsteadOfThrowing() {
        assertNull(ItemDetail.fromJson(null))
        assertNull(ItemDetail.fromJson(obj("{}"))) // no id
        assertNull(ItemDetail.fromJson(obj("""{ "id": "" }""")))
        assertNull(ItemDetail.fromJson(obj("""{ "id": null }""")))
        // Wrong TYPES where arrays/objects belong: fields drop, nothing throws.
        val wrongTypes = ItemDetail.fromJson(
            obj("""{ "id": "li_w", "size": "big", "media": { "chapters": "nope", "tracks": 7 } }""")
        )!!
        assertTrue(wrongTypes.chapters.isEmpty())
        assertTrue(wrongTypes.tracks.isEmpty())
    }

    @Test
    fun podcastEpisodesParseFromEitherDurationLocation() {
        val item = ItemDetail.fromJson(obj(expandedPodcast))!!
        assertEquals("podcast", item.mediaType)
        assertEquals("Host Person", item.authorName) // metadata.author, not authorName
        assertEquals(2, item.episodes.size)
        assertEquals("ep_1", item.episodes[0].id)
        assertEquals(1700000000000L, item.episodes[0].publishedAt!!)
        assertEquals(1800.0, item.episodes[0].duration!!, 1e-9) // audioFile.duration
        assertEquals(2400.0, item.episodes[1].duration!!, 1e-9) // episode.duration
        assertNull(item.episodes[1].publishedAt)
    }

    @Test
    fun anEpisodeWithoutAnIdIsDroppedNotFaked() {
        val raw = """
            { "id": "li_p", "media": { "episodes": [ { "title": "orphan" }, { "id": "ep_ok" } ] } }
        """.trimIndent()
        val episodes = ItemDetail.fromJson(obj(raw))!!.episodes
        assertEquals(1, episodes.size)
        assertEquals("ep_ok", episodes[0].id)
        assertEquals("Episode", episodes[0].title)
    }

    // ---- ItemSummary -------------------------------------------------------

    @Test
    fun parsesAMinifiedLibraryItemsRow() {
        val row = ItemSummary.fromJson(obj(minifiedRow))!!
        assertEquals("li_min", row.id)
        assertEquals("Minified Book", row.title)
        assertEquals("A. Writer", row.authorName)
        assertEquals("book", row.mediaType)
        assertNull(row.progress)
        assertNull(row.episodeId)
    }

    @Test
    fun parsesAnItemsInProgressRowWithRecentEpisode() {
        val row = ItemSummary.fromJson(obj(inProgressPodcastRow))!!
        assertEquals("li_pod", row.id)
        // recentEpisode.id IS the episodeId to play (BookshelfScreen reads it too).
        assertEquals("ep_42", row.episodeId)
        assertEquals("podcast", row.mediaType)
        // Podcasts carry metadata.author, books metadata.authorName.
        assertEquals("Host Person", row.authorName)
        // No `progress` field -> derived from currentTime/duration.
        assertEquals(0.25, row.progress!!, 1e-9)
        // The ITEM's title, not the episode's — the episode needs an expanded fetch.
        assertEquals("The Show", row.title)
    }

    @Test
    fun prefersTheServersOwnProgressFractionAndClampsIt() {
        val exact = ItemSummary.fromJson(obj(expandedBook))!!
        assertEquals(0.34, exact.progress!!, 1e-9)
        val overshoot = ItemSummary.fromJson(
            obj("""{ "id": "x", "userMediaProgress": { "progress": 1.4 } }""")
        )!!
        assertEquals(1.0, overshoot.progress!!, 1e-9)
        // A zero duration must not divide into an Infinity/NaN progress.
        val zeroDuration = ItemSummary.fromJson(
            obj("""{ "id": "x", "userMediaProgress": { "currentTime": 5, "duration": 0 } }""")
        )!!
        assertNull(zeroDuration.progress)
    }

    @Test
    fun summaryRowsSurviveMissingEverythingButAnId() {
        val row = ItemSummary.fromJson(obj("""{ "id": "li_x" }"""))!!
        assertEquals("Audiobook", row.title)
        assertNull(row.authorName)
        assertNull(row.progress)
        assertNull(row.episodeId)
        assertNull(ItemSummary.fromJson(obj("{}")))
        assertNull(ItemSummary.fromJson(null))
        // A podcast with no title gets the podcast default, not the book one.
        assertEquals(
            "Podcast",
            ItemSummary.fromJson(obj("""{ "id": "p", "mediaType": "podcast" }"""))!!.title
        )
    }

    // ---- LibrarySummary ----------------------------------------------------

    @Test
    fun parsesLibrariesAndDefaultsTheMediaType() {
        val lib = LibrarySummary.fromJson(obj("""{ "id": "lib1", "name": "Books", "mediaType": "book" }"""))!!
        assertEquals("lib1", lib.id)
        assertEquals("Books", lib.name)
        assertEquals("book", lib.mediaType)
        val bare = LibrarySummary.fromJson(obj("""{ "id": "lib2" }"""))!!
        assertEquals("Library", bare.name)
        assertEquals("book", bare.mediaType)
        assertNull(LibrarySummary.fromJson(obj("{}")))
        assertNull(LibrarySummary.fromJson(null))
    }

    // ---- PlaySession -------------------------------------------------------

    @Test
    fun parsesAPlaySession() {
        val session = PlaySession.fromJson(obj(playSession))!!
        assertEquals("sess_1", session.id)
        assertEquals("li_book1", session.libraryItemId)
        assertNull(session.episodeId) // explicit JSON null, not the string "null"
        assertEquals("Dune", session.displayTitle)
        assertEquals("Frank Herbert", session.displayAuthor)
        assertEquals(12345.5, session.duration, 1e-9)
        assertEquals(4200.25, session.currentTime, 1e-9)
        assertEquals(1, session.audioTracks.size)
        assertEquals("/hls/sess_1/output.m3u8", session.audioTracks[0].contentUrl)
        assertEquals(1, session.chapters.size)
    }

    @Test
    fun playSessionFallsBackToTheTracksKeyAndTheNestedLibraryItemId() {
        val raw = """
            {
              "id": "sess_2",
              "libraryItem": { "id": "li_nested" },
              "episodeId": "ep_9",
              "tracks": [ { "index": 0, "duration": 60, "contentUrl": "/f/1" } ]
            }
        """.trimIndent()
        val session = PlaySession.fromJson(obj(raw))!!
        assertEquals("li_nested", session.libraryItemId)
        assertEquals("ep_9", session.episodeId)
        // An episode session is by definition a podcast's.
        assertEquals("podcast", session.mediaType)
        assertEquals(1, session.audioTracks.size)
    }

    @Test
    fun aSessionWithNoIdOrNoItemIsUnusable() {
        assertNull(PlaySession.fromJson(null))
        assertNull(PlaySession.fromJson(obj("""{ "libraryItemId": "li_1" }""")))
        assertNull(PlaySession.fromJson(obj("""{ "id": "sess_3" }""")))
        // ...but an EMPTY track list still parses: the caller reports "no audio".
        assertNotNull(PlaySession.fromJson(obj("""{ "id": "s", "libraryItemId": "li", "audioTracks": [] }""")))
    }
}
