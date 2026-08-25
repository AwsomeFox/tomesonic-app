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

    // ---- identity changes must not leak user-scoped state -------------------
    // The offline queue flushes under whatever token is CURRENT, so a queue
    // that outlives an account switch posts account A's listening as B's.

    @Test
    fun serverChangeWipesResumePointerAndOfflineQueue() = runBlocking {
        repo.set("http://abs-a.local", "tokA", "", "")
        repo.setLastItem("li_a", null)
        repo.setOfflineSessions("""{"days":{"wear-local_li_a_2026-01-01":{}}}""")

        repo.set("http://abs-b.local", "tokB", "", "")

        assertNull(repo.lastItem.first())
        assertNull(repo.offlineSessions.first())
        assertEquals("http://abs-b.local", repo.creds.first()?.server)
    }

    @Test
    fun sameServerTokenRefreshKeepsResumePointerAndOfflineQueue() = runBlocking {
        repo.set("http://abs.local", "tok1", "u1", "tony")
        repo.setLastItem("li_1", null)
        repo.setOfflineSessions("""{"days":{}}""")

        // The common case: the phone re-pushes after a token refresh.
        repo.set("http://abs.local", "tok2", "u1", "tony")

        assertEquals("li_1", repo.lastItem.first()?.itemId)
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())
    }

    @Test
    fun knownUserChangeOnSameServerWipes() = runBlocking {
        repo.set("http://abs.local", "tokA", "userA", "a")
        repo.setOfflineSessions("""{"days":{}}""")

        repo.set("http://abs.local", "tokB", "userB", "b")

        assertNull(repo.offlineSessions.first())
    }

    @Test
    fun blankUserIdsNeverReadAsAChangedIdentity() = runBlocking {
        // The phone bridge sends "" for userId today; "" -> "u1" (or the
        // reverse) is LEARNING the identity, not changing it.
        repo.set("http://abs.local", "tok1", "", "")
        repo.setOfflineSessions("""{"days":{}}""")

        repo.set("http://abs.local", "tok2", "u1", "tony")
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())

        repo.set("http://abs.local", "tok3", "", "")
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())
    }

    @Test
    fun clearDropsTheOfflineQueue() = runBlocking {
        repo.set("http://abs.local", "tok", "u1", "tony")
        repo.setOfflineSessions("""{"days":{}}""")

        repo.clear()

        // A queue that survived a logout would flush under whichever account
        // logs in next.
        assertNull(repo.offlineSessions.first())
    }

    // ---- credential SOURCE --------------------------------------------------

    @Test
    fun aPhoneMirrorIsPhoneSourcedAndHoldsNoRefreshToken() = runBlocking {
        // Absent marker = phone, which is every row a v1 build ever wrote.
        repo.set("http://abs.local", "tok", "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals(CredsSource.PHONE, creds.source)
        assertNull(creds.refreshToken)
    }

    @Test
    fun aWatchLoginIsWatchSourcedAndKeepsItsRefreshToken() = runBlocking {
        repo.setWatchLogin("http://abs.local/", " acc ", " ref ", "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals(CredsSource.WATCH, creds.source)
        assertEquals("http://abs.local", creds.server)
        assertEquals("acc", creds.token)
        assertEquals("ref", creds.refreshToken)
        assertEquals("tony", creds.username)
    }

    @Test
    fun aWatchLoginWithoutARefreshTokenHasNoRefreshPath() = runBlocking {
        // A server with refresh disabled. Watch-owned, but its 401s stay
        // terminal — and it must not inherit an earlier login's token.
        repo.setWatchLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.setWatchLogin("http://abs.local", "acc2", null, "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals(CredsSource.WATCH, creds.source)
        assertNull(creds.refreshToken)
    }

    // ---- applyFromDataLayer precedence matrix -------------------------------
    // phone-creds / phone-logout  ×  phone-source / watch-source.

    @Test
    fun phoneCredentialsOverwriteAPhoneMirror() = runBlocking {
        repo.set("http://abs.local", "tok1", "u1", "tony")
        repo.applyFromDataLayer("http://abs.local", "tok2", "u1", "tony")
        assertEquals("tok2", repo.creds.first()?.token)
    }

    @Test
    fun phoneCredentialsOverwriteAWatchLoginWholesale() = runBlocking {
        // The phone is the PRIMARY source. Its token belongs to a different ABS
        // session, so the watch login's refresh token must not survive it —
        // spending it would renew a login the user is no longer in.
        repo.setWatchLogin("http://abs.local", "watch-acc", "watch-ref", "u1", "tony")
        repo.applyFromDataLayer("http://abs.local", "phone-tok", "u1", "tony")

        val creds = repo.creds.first()!!
        assertEquals("phone-tok", creds.token)
        assertEquals(CredsSource.PHONE, creds.source)
        assertNull(creds.refreshToken)
    }

    @Test
    fun aPhoneLogoutClearsAPhoneSourcedSession() = runBlocking {
        repo.set("http://abs.local", "tok", "u1", "tony")
        repo.applyFromDataLayer("", "", "", "")
        assertNull(repo.creds.first())
    }

    @Test
    fun aPhoneLogoutLeavesAWatchLoginAlone() = runBlocking {
        // Signing out on the phone ends the PHONE's ABS session. The watch's own
        // login is a separate one and survives — otherwise a standalone watch
        // would be logged out by a phone it never asked.
        repo.setWatchLogin("http://abs.local", "watch-acc", "watch-ref", "u1", "tony")
        repo.setLastItem("li_1", null)
        repo.setOfflineSessions("""{"days":{}}""")

        repo.applyFromDataLayer("", "", "", "")

        val creds = repo.creds.first()!!
        assertEquals("watch-acc", creds.token)
        assertEquals(CredsSource.WATCH, creds.source)
        assertEquals("watch-ref", creds.refreshToken)
        // ...and nothing user-scoped was collected on the way past.
        assertEquals("li_1", repo.lastItem.first()?.itemId)
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())
    }

    @Test
    fun aPhoneLogoutAfterAWatchLoginReplacedByThePhoneClearsAgain() = runBlocking {
        // The full round trip: watch login, phone takes over, phone signs out.
        // The takeover made it phone-sourced, so the logout applies.
        repo.setWatchLogin("http://abs.local", "watch-acc", "watch-ref", "u1", "tony")
        repo.applyFromDataLayer("http://abs.local", "phone-tok", "u1", "tony")
        repo.applyFromDataLayer("", "", "", "")
        assertNull(repo.creds.first())
    }

    @Test
    fun aHalfBlankPhonePutIsStillALogoutAndStillRespectsTheSource() = runBlocking {
        repo.setWatchLogin("http://abs.local", "watch-acc", "watch-ref", "u1", "tony")
        repo.applyFromDataLayer("http://abs.local", null, "u1", "tony")
        assertEquals("watch-acc", repo.creds.first()?.token)

        repo.set("http://abs.local", "phone-tok", "u1", "tony")
        repo.applyFromDataLayer(null, "phone-tok", "u1", "tony")
        assertNull(repo.creds.first())
    }

    // ---- watch login identity rules ----------------------------------------

    @Test
    fun aWatchLoginToADifferentServerWipesUserScopedState() = runBlocking {
        repo.set("http://abs-a.local", "tokA", "", "")
        repo.setLastItem("li_a", null)
        repo.setOfflineSessions("""{"days":{"wear-local_li_a_2026-01-01":{}}}""")

        repo.setWatchLogin("http://abs-b.local", "tokB", "refB", "", "")

        assertNull(repo.lastItem.first())
        assertNull(repo.offlineSessions.first())
    }

    @Test
    fun aWatchLoginAsADifferentKnownUserWipesUserScopedState() = runBlocking {
        repo.set("http://abs.local", "tokA", "userA", "a")
        repo.setOfflineSessions("""{"days":{}}""")

        repo.setWatchLogin("http://abs.local", "tokB", "refB", "userB", "b")

        assertNull(repo.offlineSessions.first())
    }

    @Test
    fun aWatchLoginAsTheSameIdentityKeepsUserScopedState() = runBlocking {
        // Signing in on the watch to the account already mirrored from the
        // phone is not an account switch.
        repo.set("http://abs.local", "phone-tok", "u1", "tony")
        repo.setLastItem("li_1", null)
        repo.setOfflineSessions("""{"days":{}}""")

        repo.setWatchLogin("http://abs.local", "watch-acc", "watch-ref", "u1", "tony")

        assertEquals("li_1", repo.lastItem.first()?.itemId)
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())
    }

    // ---- refresh results ----------------------------------------------------

    @Test
    fun updateAccessTokenKeepsTheRefreshTokenWhenTheServerDoesNotRotate() = runBlocking {
        repo.setWatchLogin("http://abs.local", "acc1", "ref1", "u1", "tony")

        repo.updateAccessToken("acc2", null)

        val creds = repo.creds.first()!!
        assertEquals("acc2", creds.token)
        // An absent rotation means the token that just worked still works —
        // clearing it here would strand the session at the next 401.
        assertEquals("ref1", creds.refreshToken)
        assertEquals(CredsSource.WATCH, creds.source)
    }

    @Test
    fun updateAccessTokenKeepsTheRefreshTokenWhenTheRotationIsBlank() = runBlocking {
        repo.setWatchLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.updateAccessToken("acc2", "   ")
        assertEquals("ref1", repo.creds.first()?.refreshToken)
    }

    @Test
    fun updateAccessTokenReplacesTheRefreshTokenWhenItRotates() = runBlocking {
        repo.setWatchLogin("http://abs.local", "acc1", "ref1", "u1", "tony")

        repo.updateAccessToken("acc2", "ref2")

        val creds = repo.creds.first()!!
        assertEquals("acc2", creds.token)
        assertEquals("ref2", creds.refreshToken)
    }

    @Test
    fun updateAccessTokenDoesNotWipeUserScopedState() = runBlocking {
        // A token ageing out is not an account switch; wiping here would drop
        // the resume pointer and the offline queue on every refresh.
        repo.setWatchLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.setLastItem("li_1", null)
        repo.setOfflineSessions("""{"days":{}}""")

        repo.updateAccessToken("acc2", "ref2")

        assertEquals("li_1", repo.lastItem.first()?.itemId)
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())
    }

    @Test
    fun updateAccessTokenIsANoOpWithNothingStored() = runBlocking {
        // A refresh that lands after a logout must not resurrect the session.
        repo.updateAccessToken("acc2", "ref2")
        assertNull(repo.creds.first())

        repo.setWatchLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.clear()
        repo.updateAccessToken("acc3", "ref3")
        assertNull(repo.creds.first())
    }

    @Test
    fun updateAccessTokenRefusesABlankToken() = runBlocking {
        repo.setWatchLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.updateAccessToken("   ", "ref2")
        val creds = repo.creds.first()!!
        assertEquals("acc1", creds.token)
        assertEquals("ref1", creds.refreshToken)
    }

    @Test
    fun clearRemovesTheSourceMarkerAndTheRefreshToken() = runBlocking {
        repo.setWatchLogin("http://abs.local", "acc1", "ref1", "u1", "tony")

        repo.clear()
        assertNull(repo.creds.first())

        // The next login must not inherit either. A leftover watch marker would
        // make a phone mirror refuse the phone's own logout.
        repo.set("http://abs.local", "phone-tok", "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals(CredsSource.PHONE, creds.source)
        assertNull(creds.refreshToken)
        repo.applyFromDataLayer("", "", "", "")
        assertNull(repo.creds.first())
    }
}
