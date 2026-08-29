package com.tomesonic.app.automotive.media

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins [BrowseTree.pageWindow] — the browse page-windowing the car's
 * `onGetChildren` and `onGetSearchResult` both slice with.
 *
 * The rewrite of `BrowsePaginationSpecTest` from the phone module, which drove
 * the same expression by reflection into the patched MusicService's private
 * `absPageWindow`. Here it is a real function on a real class, so the test
 * calls it: no Robolectric, no service, no reflection — nothing to go stale
 * against a signature change, because a signature change is a compile error.
 *
 * The contract is the same one that bug reports wrote: disjoint pages (the
 * head-unit duplicate-rows bug), an EMPTY rather than out-of-range page past
 * the end, and no Int overflow for hostile page/pageSize pairs.
 */
class BrowsePaginationTest {

    private fun <T> pageWindow(children: List<T>, page: Int, pageSize: Int): List<T> {
        val (from, to) = BrowseTree.pageWindow(children.size, page, pageSize)
        return children.subList(from, to)
    }

    private val items = (0 until 25).map { "item$it" }

    @Test
    fun firstPageReturnsFirstPageSizeItems() {
        assertEquals((0 until 10).map { "item$it" }, pageWindow(items, 0, 10))
    }

    @Test
    fun consecutivePagesAreDisjoint() {
        // Root cause of the duplicate-rows bug: every page used to return the
        // full list, so paginating head units appended the same rows again.
        assertEquals((10 until 20).map { "item$it" }, pageWindow(items, 1, 10))
    }

    @Test
    fun lastPartialPageIsTruncated() {
        assertEquals((20 until 25).map { "item$it" }, pageWindow(items, 2, 10))
    }

    @Test
    fun pagePastTheEndIsEmptyNotOutOfRange() {
        assertEquals(emptyList<String>(), pageWindow(items, 3, 10))
        assertEquals(emptyList<String>(), pageWindow(items, 100, 10))
    }

    @Test
    fun emptyListYieldsEmptyPage() {
        assertEquals(emptyList<String>(), pageWindow(emptyList<String>(), 0, 10))
    }

    @Test
    fun pageSizeLargerThanListReturnsWholeList() {
        // The Downloads node is subscribed to exactly like this: page 0,
        // pageSize MAX_VALUE, everything in one Binder transaction.
        assertEquals(items, pageWindow(items, 0, Int.MAX_VALUE))
    }

    @Test
    fun hugePageTimesPageSizeDoesNotOverflowInt() {
        // page * pageSize overflows Int; the toLong() arithmetic must clamp to
        // the list size instead of producing a negative index.
        assertEquals(emptyList<String>(), pageWindow(items, Int.MAX_VALUE, Int.MAX_VALUE))
    }

    @Test
    fun zeroPageSizeYieldsEmptyPage() {
        assertEquals(emptyList<String>(), pageWindow(items, 0, 0))
    }
}
