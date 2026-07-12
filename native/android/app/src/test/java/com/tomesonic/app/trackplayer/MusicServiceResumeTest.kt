package com.tomesonic.app.trackplayer

import android.app.Application
import android.os.SystemClock
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSystemClock
import java.io.File
import java.time.Duration

/**
 * JS-dead resume paths of the patched MusicService (node_modules/
 * react-native-track-player/.../service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch):
 *
 *  - absSleepRemainingNow: the native sleep countdown consumes only REAL
 *    listening time — paused stretches must not eat the timer, and playing
 *    stretches drain it by (elapsedRealtime - anchor)/1000.
 *  - absResolveOfflinePlay: cold-start offline playback resolves a
 *    downloaded book's local track file + resume position (seconds -> ms)
 *    from the mirrored auto_downloads.json entry, with percent-encoded
 *    file:// URIs and never a negative/NaN position.
 *  - absResolvePlayResumable: offline (or creds-less) resolution funnels
 *    into the offline path; an explicit override position ("@@<seconds>"
 *    bookmark ids) beats the stored progress.
 *
 * Harness per the sibling tests: Robolectric.buildService(...).get() (base
 * Context attached, onCreate never called), private members via reflection.
 * The sleep-timer fields are seeded directly; the download catalog is seeded
 * end-to-end by writing auto_downloads.json into filesDir and invoking the
 * real absRefreshDownloaded parser. The ONLINE branch of
 * absResolvePlayResumable (server /play session) needs live HTTP and is
 * covered only up to its creds gate here; the network path is device/CI-
 * integration territory.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceResumeTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    private fun method(name: String, vararg types: Class<*>): java.lang.reflect.Method {
        val m = try {
            MusicService::class.java.getDeclaredMethod(name, *types)
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "$name missing — signature changed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        return m
    }

    private fun setField(name: String, value: Any?) {
        val f = try {
            MusicService::class.java.getDeclaredField(name)
        } catch (e: NoSuchFieldException) {
            throw AssertionError(
                "$name field missing — renamed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        f.isAccessible = true
        f.set(service, value)
    }

    private fun getField(name: String): Any? {
        val f = MusicService::class.java.getDeclaredField(name)
        f.isAccessible = true
        return f.get(service)
    }

    // ---- absSleepRemainingNow(): Double ----

    private fun remainingNow(): Double =
        method("absSleepRemainingNow").invoke(service) as Double

    private fun seedSleep(remaining: Double, playing: Boolean) {
        setField("absSleepActive", true)
        setField("absSleepRemaining", remaining)
        setField("absSleepAnchorMs", SystemClock.elapsedRealtime())
        setField("absSleepAnchoredPlaying", playing)
    }

    @Test
    fun inactiveTimerReportsZero() {
        setField("absSleepActive", false)
        setField("absSleepRemaining", 900.0)
        assertEquals(0.0, remainingNow(), 0.0)
    }

    @Test
    fun pausedAnchorDoesNotDrainTheTimer() {
        seedSleep(1234.5, playing = false)
        // A long paused stretch: elapsed realtime advances, remaining doesn't.
        ShadowSystemClock.advanceBy(Duration.ofMinutes(45))
        assertEquals(1234.5, remainingNow(), 1e-9)
    }

    @Test
    fun playingAnchorDrainsByElapsedRealSeconds() {
        seedSleep(300.0, playing = true)
        ShadowSystemClock.advanceBy(Duration.ofSeconds(7))
        assertEquals(293.0, remainingNow(), 1e-9)
    }

    @Test
    fun playingAnchorWithNoElapsedTimeIsUnchanged() {
        seedSleep(300.0, playing = true)
        assertEquals(300.0, remainingNow(), 1e-9)
    }

    // ---- absResolveOfflinePlay(itemId: String, overrideSec: Double?) ----

    /** Seeds the real download catalog through the production JSON parser. */
    private fun seedDownloads(json: String) {
        File(service.filesDir, "auto_downloads.json").writeText(json)
        method("absRefreshDownloaded").invoke(service)
    }

    // Two-track book, JS-writer shape (store/useDownloadStore.ts): folder with
    // a space and a spaced filename to exercise the percent-encoding path.
    private fun seedTwoTrackBook(currentTime: Double = 700.5) = seedDownloads(
        """
        [{"id":"book1","title":"The Martian","author":"Andy Weir",
          "folder":"file:///data/books/My Book",
          "coverPath":"file:///data/books/My Book/cover.jpg",
          "currentTime":$currentTime,"duration":1200,
          "tracks":[
            {"filename":"part 1.mp3","startOffset":0,"duration":600},
            {"filename":"part2.mp3","startOffset":600,"duration":600}
          ]}]
        """.trimIndent()
    )

    @Suppress("UNCHECKED_CAST")
    private fun resolveOffline(itemId: String, overrideSec: Double?): Pair<String, Long>? =
        method("absResolveOfflinePlay", String::class.java, java.lang.Double::class.java)
            .invoke(service, itemId, overrideSec) as Pair<String, Long>?

    @Test
    fun storedProgressPicksTheContainingTrackAndConvertsSecondsToMillis() {
        seedTwoTrackBook(currentTime = 700.5) // inside track 2 (600..1200)
        val (url, posMs) = resolveOffline("book1", null)!!
        assertTrue("expected a file:// URI, got $url", url.startsWith("file://"))
        assertTrue("expected track 2, got $url", url.endsWith("/part2.mp3"))
        // Track-relative: (700.5 - 600) s -> 100500 ms.
        assertEquals(100_500L, posMs)
    }

    @Test
    fun fileUriIsPercentEncodedForSpacedPaths() {
        seedTwoTrackBook(currentTime = 30.0) // inside track 1
        val (url, posMs) = resolveOffline("book1", null)!!
        // Uri.fromFile must encode the space in both folder and filename —
        // raw concat broke ExoPlayer on spaces / # / % / ?.
        assertTrue("folder not encoded: $url", url.contains("/My%20Book/"))
        assertTrue("filename not encoded: $url", url.endsWith("/part%201.mp3"))
        assertEquals(30_000L, posMs)
    }

    @Test
    fun explicitOverrideSecondsBeatsStoredProgress() {
        seedTwoTrackBook(currentTime = 700.5) // stored progress says track 2
        val (url, posMs) = resolveOffline("book1", 50.0)!!
        assertTrue("override must re-target track 1: $url", url.endsWith("/part%201.mp3"))
        assertEquals(50_000L, posMs)
    }

    @Test
    fun missingProgressResumesAtZeroNotNaNOrNegative() {
        // No currentTime key at all -> optDouble default 0.0 -> track 1 @ 0ms.
        seedDownloads(
            """[{"id":"book1","title":"T","folder":"file:///data/books/b1",
                 "duration":1200,
                 "tracks":[{"filename":"a.mp3","startOffset":0,"duration":1200}]}]"""
        )
        val (_, posMs) = resolveOffline("book1", null)!!
        assertEquals(0L, posMs)
    }

    @Test
    fun targetBeforeFirstTrackWindowClampsToZeroWithinFallbackTrack() {
        // Degenerate mirror: first track starts at 10s. A 5s target matches no
        // window -> falls back to track 1, and within must clamp to 0, never
        // go negative.
        seedDownloads(
            """[{"id":"bookX","title":"T","folder":"/data/books/bx",
                 "currentTime":5,"duration":100,
                 "tracks":[{"filename":"a.mp3","startOffset":10,"duration":90}]}]"""
        )
        val (_, posMs) = resolveOffline("bookX", null)!!
        assertEquals(0L, posMs)
    }

    @Test
    fun undownloadedItemResolvesNull() {
        seedTwoTrackBook()
        assertNull(resolveOffline("not-downloaded", null))
    }

    @Test
    fun legacyBadgeOnlyEntryCannotPlayOffline() {
        // Legacy mirror rows are bare ids: no folder, no tracks -> badge only.
        seedDownloads("""["legacy-item-id"]""")
        assertNull(resolveOffline("legacy-item-id", null))
    }

    @Test
    fun offlineResolveSeedsTheColdStartPersisterFields() {
        seedTwoTrackBook(currentTime = 700.5)
        resolveOffline("book1", null)!!
        // Chosen track's startOffset (600s) so a later JS handoff can map the
        // track-relative position back to absolute book seconds.
        assertEquals(600_000L, getField("absColdStartOffsetMs"))
        assertEquals("book1", getField("absColdStartItemId"))
        assertEquals(1200.0, getField("absColdStartDurationSec") as Double, 0.0)
        // Offline: no server session to sync.
        assertNull(getField("absColdStartSessionId"))
    }

    // ---- absResolvePlayResumable(itemId, episodeId, overrideSec) ----

    @Suppress("UNCHECKED_CAST")
    private fun resolveResumable(
        itemId: String,
        episodeId: String?,
        overrideSec: Double?
    ): Pair<String, Long>? =
        method(
            "absResolvePlayResumable",
            String::class.java, String::class.java, java.lang.Double::class.java
        ).invoke(service, itemId, episodeId, overrideSec) as Pair<String, Long>?

    private fun goOffline() = setField("absNetworkAvailable", false)

    @Test
    fun offlineResumableFunnelsIntoTheOfflineResolver() {
        goOffline()
        seedTwoTrackBook(currentTime = 700.5)
        val (url, posMs) = resolveResumable("book1", null, null)!!
        assertTrue(url.startsWith("file://") && url.endsWith("/part2.mp3"))
        assertEquals(100_500L, posMs)
        assertEquals(600_000L, getField("absColdStartOffsetMs"))
    }

    @Test
    fun offlineResumableHonorsTheOverridePosition() {
        goOffline()
        seedTwoTrackBook(currentTime = 700.5)
        val (url, posMs) = resolveResumable("book1", null, 50.0)!!
        assertTrue(url.endsWith("/part%201.mp3"))
        assertEquals(50_000L, posMs)
    }

    @Test
    fun offlineEpisodeNeverUsesTheBookOfflinePath() {
        // Podcast episodes are excluded from the offline mirror; with an
        // episodeId the offline branch is skipped and, with no creds stored
        // (bare Robolectric filesDir), resolution fails cleanly.
        goOffline()
        seedTwoTrackBook()
        assertNull(resolveResumable("book1", "ep1", null))
    }

    @Test
    fun offlineUndownloadedItemFailsCleanlyWithoutCreds() {
        goOffline()
        seedDownloads("[]")
        assertNull(resolveResumable("nope", null, null))
    }

    @Test
    fun onlineWithoutStoredCredsFailsCleanlyBeforeAnyNetworkCall() {
        // absNetworkAvailable defaults true; no auto_creds.json exists in the
        // test filesDir, so the creds gate returns null before absPost runs.
        seedTwoTrackBook()
        assertNull(resolveResumable("book1", null, null))
    }
}
