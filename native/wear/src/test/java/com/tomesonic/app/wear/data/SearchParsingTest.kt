package com.tomesonic.app.wear.data

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `GET /api/libraries/{id}/search` — the merge, the cap, and the one
 * distinction the screen is built on: a request that FAILED (null) is not a
 * search that found nothing (empty).
 *
 * Robolectric only because org.json lives in android.jar; no Context is touched.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class SearchParsingTest {

    // ---- fixtures ----------------------------------------------------------

    /**
     * A real answer: both sections present, each row wrapping the item as
     * `libraryItem` next to the match fields (the shape formatSwitch.ts reads).
     */
    private val bookAndPodcast = """
        {
          "book": [
            {
              "libraryItem": {
                "id": "li_b1",
                "mediaType": "book",
                "media": { "metadata": { "title": "Dune", "authorName": "Frank Herbert" } },
                "userMediaProgress": { "progress": 0.5 }
              },
              "matchKey": "title",
              "matchText": "Dune"
            },
            {
              "libraryItem": {
                "id": "li_b2",
                "mediaType": "book",
                "media": { "metadata": { "title": "Dune Messiah", "authorName": "Frank Herbert" } }
              }
            }
          ],
          "podcast": [
            {
              "libraryItem": {
                "id": "li_p1",
                "mediaType": "podcast",
                "media": { "metadata": { "title": "Dune Podcast", "author": "Host Person" } }
              }
            }
          ],
          "tags": [],
          "authors": [ { "id": "au_1", "name": "Frank Herbert" } ],
          "series": []
        }
    """.trimIndent()

    // ---- merge -------------------------------------------------------------

    @Test
    fun mergesBooksThenPodcastsInServerOrder() {
        val results = AbsApi.parseSearch(bookAndPodcast, 12)!!
        assertEquals(listOf("li_b1", "li_b2", "li_p1"), results.map { it.id })
        assertEquals("Dune", results[0].title)
        assertEquals("Frank Herbert", results[0].authorName)
        assertEquals(0.5, results[0].progress!!, 1e-9)
        // Podcasts carry metadata.author where books carry authorName.
        assertEquals("Host Person", results[2].authorName)
        assertEquals("podcast", results[2].mediaType)
    }

    @Test
    fun podcastResultsCarryNoEpisodeId() {
        // /search rows have no `recentEpisode` — unlike items-in-progress rows.
        // A non-null episodeId here would play an episode the user never picked.
        val results = AbsApi.parseSearch(bookAndPodcast, 12)!!
        assertTrue(results.all { it.episodeId == null })
    }

    @Test
    fun theAuthorsAndSeriesSectionsAreIgnored() {
        // They are not library items and cannot be opened by the item screen.
        val results = AbsApi.parseSearch(bookAndPodcast, 12)!!
        assertEquals(3, results.size)
    }

    // ---- cap ---------------------------------------------------------------

    @Test
    fun capsAtTheLimitAcrossBothSectionsCombined() {
        val results = AbsApi.parseSearch(bookAndPodcast, 2)!!
        assertEquals(listOf("li_b1", "li_b2"), results.map { it.id })
    }

    @Test
    fun theCapCountsBooksFirstSoAPodcastCanBeCutOff() {
        assertEquals(listOf("li_b1"), AbsApi.parseSearch(bookAndPodcast, 1)!!.map { it.id })
        assertTrue(AbsApi.parseSearch(bookAndPodcast, 0)!!.isEmpty())
    }

    @Test
    fun theDefaultLimitIsTheContractsTwelve() {
        assertEquals(12, AbsApi.SEARCH_LIMIT)
    }

    // ---- null vs empty -----------------------------------------------------

    @Test
    fun aBodyThatIsNotJsonIsAFailedRequestNotAnEmptyResult() {
        // Offline (null), a reverse proxy's error page, a truncated body: the
        // screen must offer a retry, not report "No matches".
        assertNull(AbsApi.parseSearch(null, 12))
        assertNull(AbsApi.parseSearch("", 12))
        assertNull(AbsApi.parseSearch("<html><body>502</body></html>", 12))
    }

    @Test
    fun anAnswerWithNoSectionsIsAnEmptyResult() {
        assertTrue(AbsApi.parseSearch("{}", 12)!!.isEmpty())
        assertTrue(AbsApi.parseSearch("""{ "book": [], "podcast": [] }""", 12)!!.isEmpty())
    }

    // ---- malformed rows ----------------------------------------------------

    @Test
    fun aMalformedRowCostsThatRowAndNothingElse() {
        val raw = """
            {
              "book": [
                { "matchKey": "title", "matchText": "no item here" },
                { "libraryItem": null },
                { "libraryItem": { "media": { "metadata": { "title": "No Id" } } } },
                "not-an-object",
                { "libraryItem": { "id": "li_ok" } }
              ],
              "podcast": "not-an-array"
            }
        """.trimIndent()
        val results = AbsApi.parseSearch(raw, 12)!!
        assertEquals(listOf("li_ok"), results.map { it.id })
        // ...and the survivor still gets its defaults, not a literal "null".
        assertEquals("Audiobook", results[0].title)
        assertNull(results[0].authorName)
    }
}
