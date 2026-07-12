package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Tests the REAL Android Auto search cache of the patched MusicService
 * (private field `absSearchCache` in
 * node_modules/react-native-track-player/android/src/main/java/com/
 * doublesymmetry/trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch).
 *
 * The service comes from Robolectric.buildService(...).get(): the base
 * Context is attached but onCreate() is NEVER called (no player, no session).
 * Construction is safe because every constructor-time field initializer on
 * MusicService is either pure JVM (maps, constants, an executor) or
 * Robolectric-supported (Binder(), MainScope(),
 * Handler(Looper.getMainLooper())). The cache field is then read via
 * reflection because it is private. This exercises the real map object
 * MusicService constructs — its cap, its eviction order, and its synchronized
 * wrapper — not a copy of it.
 *
 * Contract under test (see the comment above absSearchCache in
 * MusicService.kt): an insertion-ordered LRU capped at 30 entries whose
 * overflow evicts only the ELDEST entry — never the just-inserted query — so
 * a concurrent flood of other queries between onSearch and onGetSearchResult
 * cannot clear a pending query's results (the previous clear()-at-30
 * implementation did exactly that).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceSearchCacheTest {

    private lateinit var cache: MutableMap<String, Any?>

    @Suppress("UNCHECKED_CAST")
    @Before
    fun setUp() {
        val service = Robolectric.buildService(MusicService::class.java).get()
        val field = try {
            MusicService::class.java.getDeclaredField("absSearchCache")
        } catch (e: NoSuchFieldException) {
            throw AssertionError(
                "absSearchCache field missing — renamed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        field.isAccessible = true
        cache = field.get(service) as MutableMap<String, Any?>
    }

    // Values are List<MediaItem> in production; entries here only need
    // distinguishable keys, so an empty list stands in (generics are erased).
    private fun put(key: String) {
        cache[key] = emptyList<Any>()
    }

    @Test
    fun cacheIsWrappedInSynchronizedMap() {
        // onSearch writes from the browse thread pool while onGetSearchResult
        // reads from the media3 callback thread.
        assertEquals("java.util.Collections\$SynchronizedMap", cache.javaClass.name)
    }

    @Test
    fun holdsThirtyEntriesWithoutEvicting() {
        repeat(30) { put("q$it") }
        assertEquals(30, cache.size)
        assertTrue(cache.containsKey("q0"))
        assertTrue(cache.containsKey("q29"))
    }

    @Test
    fun thirtyFirstInsertEvictsOnlyTheEldest() {
        repeat(31) { put("q$it") }
        assertEquals(30, cache.size)
        assertFalse("eldest entry must be evicted", cache.containsKey("q0"))
        assertTrue(cache.containsKey("q1"))
        assertTrue(cache.containsKey("q30"))
    }

    @Test
    fun justInsertedQuerySurvivesInsertionIntoFullCache() {
        // Regression guard for the pending-query bug: inserting into a full
        // cache must never drop the entry that was just written.
        repeat(30) { put("filler$it") }
        put("pending-query")
        assertEquals(30, cache.size)
        assertTrue(cache.containsKey("pending-query"))
    }

    @Test
    fun evictionsProceedInInsertionOrder() {
        repeat(30) { put("q$it") }
        put("q30")
        put("q31")
        assertEquals(30, cache.size)
        assertFalse(cache.containsKey("q0"))
        assertFalse(cache.containsKey("q1"))
        assertTrue(cache.containsKey("q2"))
        assertTrue(cache.containsKey("q31"))
    }

    @Test
    fun evictionIsInsertionOrderedNotAccessOrdered() {
        // The LinkedHashMap is constructed with accessOrder = false: a read
        // (what onGetSearchResult does) must NOT refresh an entry's age.
        repeat(30) { put("q$it") }
        cache["q0"] // read the eldest entry
        put("q30")
        assertFalse("a read must not rescue q0 from eviction", cache.containsKey("q0"))
        assertTrue(cache.containsKey("q30"))
    }

    @Test
    fun reinsertingExistingKeyDoesNotEvict() {
        // Overwriting a present key keeps size at 30, so removeEldestEntry
        // never fires and nothing is dropped.
        repeat(30) { put("q$it") }
        put("q5")
        assertEquals(30, cache.size)
        assertTrue(cache.containsKey("q0"))
    }
}
