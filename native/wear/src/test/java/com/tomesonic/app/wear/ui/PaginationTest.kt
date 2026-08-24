package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.ItemSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Infinite scroll's arithmetic.
 *
 * The de-duplication is not defensive tidiness: two pages fetched seconds apart
 * from a library that gained a book overlap by one row, and a lazy list with two
 * items carrying the same key is a crash, not a cosmetic bug.
 */
class PaginationTest {

    private fun page(vararg ids: String): List<ItemSummary> = ids.map {
        ItemSummary(
            id = it,
            title = "Title $it",
            authorName = null,
            mediaType = "book",
            progress = null,
            episodeId = null
        )
    }

    @Test
    fun pagesAppendInOrder() {
        val combined = Pagination.append(page("a", "b"), page("c", "d"))
        assertEquals(listOf("a", "b", "c", "d"), combined.map { it.id })
    }

    @Test
    fun anIdAlreadyOnScreenIsNotAddedTwice() {
        val combined = Pagination.append(page("a", "b"), page("b", "c"))
        assertEquals(listOf("a", "b", "c"), combined.map { it.id })
    }

    @Test
    fun existingRowsKeepTheirOrderAndTheirIdentity() {
        // A re-sorted list under a scrolling finger is worse than a duplicate.
        val existing = page("b", "a")
        val combined = Pagination.append(existing, page("c"))
        assertEquals(listOf("b", "a", "c"), combined.map { it.id })
    }

    @Test
    fun anEmptyPageChangesNothingAtAll() {
        val existing = page("a")
        assertSame(existing, Pagination.append(existing, emptyList()))
    }

    @Test
    fun aFullPageMeansThereIsProbablyMore() {
        assertFalse(Pagination.isEnd(page(*Array(50) { "i$it" }), 50))
    }

    @Test
    fun aShortPageIsTheEnd() {
        assertTrue(Pagination.isEnd(page(*Array(49) { "i$it" }), 50))
    }

    @Test
    fun anEmptyPageIsTheEndIncludingTheFirstOne() {
        // How an empty library AND an offline fetch both stop asking.
        assertTrue(Pagination.isEnd(emptyList(), 50))
    }

    @Test
    fun pagesCountFromZero() {
        assertEquals(0, Pagination.nextPage(-1))
        assertEquals(1, Pagination.nextPage(0))
        assertEquals(4, Pagination.nextPage(3))
    }

    @Test
    fun theDefaultPageSizeMatchesTheApiClient() {
        assertEquals(50, Pagination.PAGE_SIZE)
    }
}
