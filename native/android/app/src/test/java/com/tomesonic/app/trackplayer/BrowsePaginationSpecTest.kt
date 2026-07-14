package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pins absPageWindow — the browse page-windowing extracted from the patched
 * MusicService (node_modules/react-native-track-player/android/src/main/java/
 * com/doublesymmetry/trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch). It was previously
 * inlined verbatim in the onGetChildren and onGetSearchResult callbacks; both
 * now call absPageWindow(size, page, pageSize), which returns the [from, to)
 * sub-list bounds.
 *
 * Those callbacks take non-null MediaLibrarySession/ControllerInfo parameters
 * (Kotlin null-check intrinsics reject reflective null arguments), so they stay
 * unreachable without a live media3 session — but the windowing itself is now a
 * named private member, so this test drives it DIRECTLY by reflection on a bare
 * service from Robolectric.buildService(...).get() (onCreate NEVER called),
 * replacing the old verbatim spec-mirror copy.
 *
 * The tests pin the expression's contract — disjoint pages (the head-unit
 * duplicate-rows bug), an empty (not out-of-range) page past the end, and no
 * Int overflow for hostile page/pageSize values.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class BrowsePaginationSpecTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    /** Drives the extracted absPageWindow and applies its bounds, like the callbacks. */
    private fun <T> pageWindow(children: List<T>, page: Int, pageSize: Int): List<T> {
        val m = try {
            MusicService::class.java.getDeclaredMethod(
                "absPageWindow",
                Int::class.javaPrimitiveType!!,
                Int::class.javaPrimitiveType!!,
                Int::class.javaPrimitiveType!!
            )
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "absPageWindow missing — signature changed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        val bounds = m.invoke(service, children.size, page, pageSize) as Pair<*, *>
        val from = bounds.first as Int
        val to = bounds.second as Int
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
