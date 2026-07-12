package com.tomesonic.app.trackplayer

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * SPEC-MIRROR TEST — weaker than testing the production method, and labelled
 * as such on purpose.
 *
 * The page-windowing under test lives inline in two anonymous
 * MediaLibrarySession.Callback overrides of the patched MusicService
 * (node_modules/react-native-track-player/android/src/main/java/com/
 * doublesymmetry/trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch). Search that file for
 * the `override fun onGetChildren(` and `override fun onGetSearchResult(`
 * declarations: the windowing is the `val from = ... val to = ... subList`
 * block below the "Honor the requested page window" comment in each.
 *
 * TODO(pagination-extraction): extract this windowing into a NAMED function
 * in the RNTP patch (e.g. a companion-object member or top-level
 * `internal fun` that both callbacks call), then rewrite this spec-mirror as
 * a direct test of the production function and delete the copy below.
 * Deliberately NOT done on this branch: the patch file is concurrently
 * modified on the PR #54 branch and editing it here would tangle that rebase.
 * Do the extraction once #54 lands.
 *
 * Those overrides take non-null MediaLibrarySession/ControllerInfo parameters
 * (Kotlin null-check intrinsics reject reflective null arguments), so they
 * are unreachable without standing up a live media3 session and player. The
 * expression below is therefore copied VERBATIM from the service:
 *
 *   val from = (page.toLong() * pageSize.toLong())
 *       .coerceIn(0L, children.size.toLong()).toInt()
 *   val to = (from.toLong() + pageSize.toLong())
 *       .coerceIn(from.toLong(), children.size.toLong()).toInt()
 *   val window = children.subList(from, to)
 *
 * IF THE EXPRESSION IN MusicService.kt CHANGES, UPDATE THIS COPY TO MATCH.
 * The tests pin the expression's contract — disjoint pages (the head-unit
 * duplicate-rows bug), an empty (not out-of-range) page past the end, and no
 * Int overflow for hostile page/pageSize values — not the service wiring
 * around it.
 */
class BrowsePaginationSpecTest {

    /** Verbatim copy of the windowing expression — see class comment. */
    private fun <T> pageWindow(children: List<T>, page: Int, pageSize: Int): List<T> {
        val from = (page.toLong() * pageSize.toLong())
            .coerceIn(0L, children.size.toLong()).toInt()
        val to = (from.toLong() + pageSize.toLong())
            .coerceIn(from.toLong(), children.size.toLong()).toInt()
        val window = children.subList(from, to)
        return window
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
        assertEquals(items, pageWindow(items, 0, Int.MAX_VALUE))
    }

    @Test
    fun hugePageTimesPageSizeDoesNotOverflowInt() {
        // page * pageSize overflows Int; the toLong() arithmetic must clamp
        // to the list size instead of producing a negative index.
        assertEquals(emptyList<String>(), pageWindow(items, Int.MAX_VALUE, Int.MAX_VALUE))
    }

    @Test
    fun zeroPageSizeYieldsEmptyPage() {
        assertEquals(emptyList<String>(), pageWindow(items, 0, 0))
    }
}
