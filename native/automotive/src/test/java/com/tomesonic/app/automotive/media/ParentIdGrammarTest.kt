package com.tomesonic.app.automotive.media

import com.tomesonic.app.automotive.data.AbsClient
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The browse parent-id grammar, ARCHITECTURE.md §4.2, asserted VERBATIM.
 *
 * These ids are not internal names. A head unit remembers the node a user was
 * last in, a voice target resolves through them, and the phone's shipped
 * Android Auto tree already uses this exact table — so a rename here is not a
 * refactor, it is four clients disagreeing about what "Continue Listening"
 * is called. The contract carries the same list so that drift is visible in
 * review; this test is what makes it visible in CI.
 *
 * The expected values are written as literals on purpose: comparing the
 * constants to themselves would pass under any rename.
 */
class ParentIdGrammarTest {

    @Test
    fun theFixedNodesAreTheContractsFiveSentinels() {
        assertEquals("__ROOT__", BrowseTree.ROOT_ID)
        assertEquals("__CONTINUE__", BrowseTree.CONTINUE_ID)
        assertEquals("__CONTINUE_SERIES__", BrowseTree.CONTINUE_SERIES_ID)
        assertEquals("__DOWNLOADS__", BrowseTree.DOWNLOADS_ID)
        assertEquals("__LIBRARIES__", BrowseTree.LIBRARIES_ID)
    }

    @Test
    fun theLibraryScopedPrefixesAreTheContracts() {
        assertEquals("lib:", BrowseTree.LIB_PREFIX)
        assertEquals("latest:", BrowseTree.LATEST_PREFIX)
        assertEquals("allbooks:", BrowseTree.ALL_BOOKS_PREFIX)
        assertEquals("listenagain:", BrowseTree.LISTEN_AGAIN_PREFIX)
        assertEquals("authors:", BrowseTree.AUTHORS_PREFIX)
        assertEquals("serieslist:", BrowseTree.SERIES_LIST_PREFIX)
        assertEquals("collections:", BrowseTree.COLLECTIONS_PREFIX)
    }

    @Test
    fun theEntityScopedPrefixesAreTheContracts() {
        assertEquals("author:", BrowseTree.AUTHOR_PREFIX)
        assertEquals("series:", BrowseTree.SERIES_PREFIX)
        assertEquals("collection:", BrowseTree.COLLECTION_PREFIX)
        assertEquals("podcast:", BrowseTree.PODCAST_PREFIX)
    }

    @Test
    fun theIdsThosePrefixesBuildAreTheContractsShapes() {
        // The grammar as §4.2 writes it, one line per production.
        assertEquals("lib:lib1:book", "${BrowseTree.LIB_PREFIX}lib1:book")
        assertEquals("latest:lib1", "${BrowseTree.LATEST_PREFIX}lib1")
        assertEquals("allbooks:lib1", "${BrowseTree.ALL_BOOKS_PREFIX}lib1")
        assertEquals("listenagain:lib1", "${BrowseTree.LISTEN_AGAIN_PREFIX}lib1")
        assertEquals("authors:lib1", "${BrowseTree.AUTHORS_PREFIX}lib1")
        assertEquals("author:lib1:a1", "${BrowseTree.AUTHOR_PREFIX}lib1:a1")
        assertEquals("serieslist:lib1", "${BrowseTree.SERIES_LIST_PREFIX}lib1")
        assertEquals("series:lib1:s1", "${BrowseTree.SERIES_PREFIX}lib1:s1")
        assertEquals("collections:lib1", "${BrowseTree.COLLECTIONS_PREFIX}lib1")
        assertEquals("collection:c1", "${BrowseTree.COLLECTION_PREFIX}c1")
        assertEquals("podcast:i1", "${BrowseTree.PODCAST_PREFIX}i1")
    }

    @Test
    fun thePluralPrefixesCannotBeMistakenForTheSingularOnes() {
        // The one way this table could break silently: a `startsWith` chain
        // that matches "authors:lib1" as an author id. It cannot — the plural
        // forms differ before the colon — and this pins that property rather
        // than the branch order that currently also protects it.
        assertEquals(false, "authors:lib1".startsWith(BrowseTree.AUTHOR_PREFIX))
        assertEquals(false, "serieslist:lib1".startsWith(BrowseTree.SERIES_PREFIX))
        assertEquals(false, "collections:lib1".startsWith(BrowseTree.COLLECTION_PREFIX))
    }

    @Test
    fun theBudgetsAreTheContractsNumbers() {
        // ARCHITECTURE.md §7: 45 s fresh, 10 min stale, 15 s progress, 8 inlined
        // covers, a search cache of 30.
        assertEquals(45_000L, BrowseTree.CACHE_FRESH_MS)
        assertEquals(600_000L, BrowseTree.CACHE_STALE_MS)
        assertEquals(15_000L, BrowseTree.PROGRESS_CACHE_MS)
        assertEquals(8, BrowseTree.DOWNLOADS_ART_BUDGET)
        assertEquals(30, BrowseTree.SEARCH_CACHE_CAP)
    }

    @Test
    fun theBrowseSocketBudgetIsTheDonorsFiveAndTen() {
        // The same §7 paragraph, but it lives with the sockets: a browse fetch
        // may give up early ONLY because the stale cache above it can answer.
        assertEquals(5L, AbsClient.BROWSE_CONNECT_SECONDS)
        assertEquals(10L, AbsClient.BROWSE_READ_SECONDS)
    }
}
