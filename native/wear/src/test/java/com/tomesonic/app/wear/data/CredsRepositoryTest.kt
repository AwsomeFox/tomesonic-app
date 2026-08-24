package com.tomesonic.app.wear.data

import android.app.Application
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.UUID

/**
 * CredsRepository over a real DataStore backed by a per-test temp file.
 *
 * Robolectric because DataStore's preferences codec is an Android artifact; the
 * store itself is injected rather than resolved from a Context, which is what
 * lets each test own its own file — two live DataStore instances over ONE file
 * is an error in DataStore, not a merge, so a shared production path would make
 * these tests interfere with each other.
 *
 * No coroutine test library (it isn't a dependency, deliberately): runBlocking
 * is enough because every operation here is a plain suspend read or write.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class CredsRepositoryTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var repo: CredsRepository

    @Before
    fun setUp() {
        // ONE store per test, over that test's own temp folder: DataStore treats
        // two live instances on one file as an error, and nothing here can close
        // an instance once it exists.
        val file = File(tempFolder.root, "creds.preferences_pb")
        repo = CredsRepository(PreferenceDataStoreFactory.create(produceFile = { file }))
    }

    // ---- creds -------------------------------------------------------------

    @Test
    fun isUnconfiguredUntilBothServerAndTokenArrive() = runBlocking {
        assertNull(repo.creds.first())
        repo.set("", "tok", "u1", "tony")
        assertNull(repo.creds.first())
        repo.set("http://abs.local", "", "u1", "tony")
        assertNull(repo.creds.first())
        repo.set("   ", "   ", "u1", "tony")
        assertNull(repo.creds.first())
    }

    @Test
    fun storesAndReadsBackACompletePair() = runBlocking {
        repo.set("http://abs.local", "tok", "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals("http://abs.local", creds.server)
        assertEquals("tok", creds.token)
        assertEquals("u1", creds.userId)
        assertEquals("tony", creds.username)
    }

    @Test
    fun normalisesTheServerOriginOnTheWayIn() = runBlocking {
        // Every URL is built by concatenating a leading-slash path onto this, so
        // a surviving trailing slash would produce `//api/...`.
        repo.set("  http://abs.local///  ", "  tok  ", "", "")
        val creds = repo.creds.first()!!
        assertEquals("http://abs.local", creds.server)
        assertEquals("tok", creds.token)
        assertEquals("", creds.userId)
        assertEquals("", creds.username)
    }

    @Test
    fun normalizeServerHandlesTheEdgeCasesDirectly() {
        assertEquals("http://abs.local", CredsRepository.normalizeServer("http://abs.local/"))
        assertEquals("http://abs.local", CredsRepository.normalizeServer("http://abs.local////"))
        assertEquals("https://a.b:8443", CredsRepository.normalizeServer(" https://a.b:8443 "))
        assertEquals("", CredsRepository.normalizeServer("   "))
        assertEquals("", CredsRepository.normalizeServer("///"))
    }

    @Test
    fun clearRemovesCredentialsAndTheResumePointerButKeepsDeviceSettings() = runBlocking {
        repo.set("http://abs.local", "tok", "u1", "tony")
        repo.setLastItem("li_1", "ep_1")
        repo.setPlaybackSpeed(1.5f)
        val deviceId = repo.deviceId()

        repo.clear()

        assertNull(repo.creds.first())
        // User-scoped: the next account must never see the previous one's book.
        assertNull(repo.lastItem.first())
        // Device-scoped: these belong to the watch, not the login.
        assertEquals(1.5f, repo.playbackSpeed.first(), 1e-6f)
        assertEquals(deviceId, repo.deviceId())
    }

    // ---- Data Layer semantics ---------------------------------------------

    @Test
    fun aDataLayerPutWithValuesLogsIn() = runBlocking {
        repo.applyFromDataLayer("http://abs.local/", "tok", "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals("http://abs.local", creds.server)
        assertEquals("tok", creds.token)
    }

    @Test
    fun aDataLayerPutWithEmptyStringsIsTheLogoutSignal() = runBlocking {
        // The phone clears by putting "" — deliberately NOT by deleting the
        // DataItem — so an empty pair must mean "logged out", not "ignore".
        repo.set("http://abs.local", "tok", "u1", "tony")
        repo.applyFromDataLayer("", "", "", "")
        assertNull(repo.creds.first())
    }

    @Test
    fun aDataLayerPutMissingEitherHalfAlsoClears() = runBlocking {
        repo.set("http://abs.local", "tok", "u1", "tony")
        repo.applyFromDataLayer("http://abs.local", null, "u1", "tony")
        assertNull(repo.creds.first())

        repo.set("http://abs.local", "tok", "u1", "tony")
        repo.applyFromDataLayer(null, "tok", "u1", "tony")
        assertNull(repo.creds.first())
    }

    // ---- device id ---------------------------------------------------------

    @Test
    fun deviceIdIsMintedOnceAndStaysStable() = runBlocking {
        val first = repo.deviceId()
        assertTrue(first.isNotBlank())
        // A parseable UUID — ABS keys listening sessions by this string.
        assertNotNull(UUID.fromString(first))
        assertEquals(first, repo.deviceId())
        assertEquals(first, repo.deviceId())
    }

    @Test
    fun deviceIdSurvivesLoginAndLogout() = runBlocking {
        val first = repo.deviceId()
        repo.set("http://abs.local", "tok", "", "")
        assertEquals(first, repo.deviceId())
        repo.clear()
        // A new id per account (or per launch) would fragment this watch's
        // stats into a new "device" on the server every time.
        assertEquals(first, repo.deviceId())
    }

    // ---- speed + resume pointer -------------------------------------------

    @Test
    fun playbackSpeedDefaultsToOneAndRoundTrips() = runBlocking {
        assertEquals(1.0f, repo.playbackSpeed.first(), 1e-6f)
        repo.setPlaybackSpeed(1.75f)
        assertEquals(1.75f, repo.playbackSpeed.first(), 1e-6f)
    }

    @Test
    fun playbackSpeedRefusesValuesThatWouldWedgeThePlayer() = runBlocking {
        repo.setPlaybackSpeed(1.25f)
        repo.setPlaybackSpeed(0f)
        repo.setPlaybackSpeed(-2f)
        repo.setPlaybackSpeed(Float.NaN)
        repo.setPlaybackSpeed(Float.POSITIVE_INFINITY)
        // A persisted 0 or NaN rate would survive every relaunch.
        assertEquals(1.25f, repo.playbackSpeed.first(), 1e-6f)
    }

    @Test
    fun lastItemRoundTripsWithAndWithoutAnEpisode() = runBlocking {
        assertNull(repo.lastItem.first())

        repo.setLastItem("li_1", "ep_1")
        assertEquals(LastItem("li_1", "ep_1"), repo.lastItem.first())

        // Switching to a book must drop the previous episode id, not inherit it.
        repo.setLastItem("li_2", null)
        assertEquals(LastItem("li_2", null), repo.lastItem.first())

        repo.setLastItem(null, null)
        assertNull(repo.lastItem.first())
    }

    @Test
    fun offlineSessionsBlobRoundTrips() = runBlocking {
        assertNull(repo.offlineSessions.first())
        repo.setOfflineSessions("""[{"id":"wear-local_li_1_2026-01-01"}]""")
        assertEquals("""[{"id":"wear-local_li_1_2026-01-01"}]""", repo.offlineSessions.first())
    }
}
