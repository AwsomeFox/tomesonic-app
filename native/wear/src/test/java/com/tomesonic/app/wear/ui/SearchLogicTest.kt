package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.LibrarySummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The decisions search makes with no server involved: which library home's
 * Search chip searches, and what counts as a query.
 *
 * Both are answers to input this app does not control — a list of libraries the
 * server chooses, and a string a microphone produced.
 */
class SearchLogicTest {

    private fun library(id: String, mediaType: String) =
        LibrarySummary(id = id, name = "Library $id", mediaType = mediaType)

    // ---- home's chip target ------------------------------------------------

    @Test
    fun theFirstBookLibraryWinsEvenWhenAPodcastLibraryComesFirst() {
        val libraries = listOf(
            library("lib_pod", "podcast"),
            library("lib_books", "book"),
            library("lib_more_books", "book")
        )
        assertEquals("lib_books", SearchLogic.defaultLibraryId(libraries))
    }

    @Test
    fun theOnlyLibraryIsUsedEvenWhenItIsNotABookLibrary() {
        assertEquals("lib_solo", SearchLogic.defaultLibraryId(listOf(library("lib_solo", "podcast"))))
    }

    @Test
    fun twoPodcastLibrariesAndNoBookLibraryLeaveTheChipOff() {
        // Nothing to pick between: the per-library chips already do that, and a
        // Search chip that guesses searches the wrong library half the time.
        val libraries = listOf(library("lib_a", "podcast"), library("lib_b", "podcast"))
        assertNull(SearchLogic.defaultLibraryId(libraries))
    }

    @Test
    fun noLibrariesAtAllLeaveTheChipOff() {
        // The offline home screen: the library list is empty, so is this.
        assertNull(SearchLogic.defaultLibraryId(emptyList()))
    }

    // ---- what counts as a query --------------------------------------------

    @Test
    fun queriesAreTrimmed() {
        assertEquals("dune", SearchLogic.normalize("  dune  "))
        assertEquals("frank herbert", SearchLogic.normalize("\nfrank herbert\t"))
    }

    @Test
    fun nothingToSearchForIsNullNotAnEmptyQuery() {
        // A blank `q=` asks the server for the WHOLE library; a cancelled
        // dictation produces exactly that.
        assertNull(SearchLogic.normalize(null))
        assertNull(SearchLogic.normalize(""))
        assertNull(SearchLogic.normalize("   "))
    }

    @Test
    fun aDictationAccidentIsCappedRatherThanSent() {
        val long = "a".repeat(SearchLogic.MAX_QUERY + 40)
        assertEquals(SearchLogic.MAX_QUERY, SearchLogic.normalize(long)!!.length)
        // The cut can land mid-space — the result is still a trimmed query.
        val cutOnSpace = "b".repeat(SearchLogic.MAX_QUERY - 1) + "   tail"
        assertEquals("b".repeat(SearchLogic.MAX_QUERY - 1), SearchLogic.normalize(cutOnSpace))
    }

    @Test
    fun aQueryExactlyAtTheCapSurvivesWhole() {
        val exact = "c".repeat(SearchLogic.MAX_QUERY)
        assertEquals(exact, SearchLogic.normalize(exact))
    }
}
