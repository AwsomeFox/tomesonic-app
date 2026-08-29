package com.tomesonic.app.automotive.data

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
 *
 * Ported from :wear MINUS its Data Layer suite — `applyFromDataLayer`, the
 * phone-mirror `set()` and the whole phone-vs-watch precedence matrix test the
 * arbitration of two credential sources, and a car has one (ARCHITECTURE.md §3,
 * §6). What survives is every rule that still has something to decide, plus the
 * two pins the collapse itself needs.
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
        repo.setCarLogin("", "tok", null, "u1", "tony")
        assertNull(repo.creds.first())
        repo.setCarLogin("http://abs.local", "", null, "u1", "tony")
        assertNull(repo.creds.first())
        repo.setCarLogin("   ", "   ", null, "u1", "tony")
        assertNull(repo.creds.first())
    }

    @Test
    fun storesAndReadsBackACompletePair() = runBlocking {
        repo.setCarLogin("http://abs.local", "tok", null, "u1", "tony")
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
        repo.setCarLogin("  http://abs.local///  ", "  tok  ", null, "", "")
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
        repo.setCarLogin("http://abs.local", "tok", null, "u1", "tony")
        repo.setLastItem("li_1", "ep_1")
        repo.setPlaybackSpeed(1.5f)
        val deviceId = repo.deviceId()

        repo.clear()

        assertNull(repo.creds.first())
        // User-scoped: the next account must never see the previous one's book
        // on a car the whole household shares.
        assertNull(repo.lastItem.first())
        // Device-scoped: these belong to the car, not the login.
        assertEquals(1.5f, repo.playbackSpeed.first(), 1e-6f)
        assertEquals(deviceId, repo.deviceId())
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
        repo.setCarLogin("http://abs.local", "tok", null, "", "")
        assertEquals(first, repo.deviceId())
        repo.clear()
        // A new id per account (or per launch) would fragment this car's stats
        // into a new "device" on the server every time.
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
        repo.setOfflineSessions("""[{"id":"automotive-local_li_1_2026-01-01"}]""")
        assertEquals(
            """[{"id":"automotive-local_li_1_2026-01-01"}]""",
            repo.offlineSessions.first()
        )
    }

    // ---- identity changes must not leak user-scoped state -------------------
    // The offline queue flushes under whatever token is CURRENT, so a queue
    // that outlives an account switch posts account A's listening as B's.

    @Test
    fun serverChangeWipesResumePointerAndOfflineQueue() = runBlocking {
        repo.setCarLogin("http://abs-a.local", "tokA", null, "", "")
        repo.setLastItem("li_a", null)
        repo.setOfflineSessions("""{"days":{"automotive-local_li_a_2026-01-01":{}}}""")

        repo.setCarLogin("http://abs-b.local", "tokB", null, "", "")

        assertNull(repo.lastItem.first())
        assertNull(repo.offlineSessions.first())
        assertEquals("http://abs-b.local", repo.creds.first()?.server)
    }

    @Test
    fun sameServerReLoginKeepsResumePointerAndOfflineQueue() = runBlocking {
        repo.setCarLogin("http://abs.local", "tok1", "ref1", "u1", "tony")
        repo.setLastItem("li_1", null)
        repo.setOfflineSessions("""{"days":{}}""")

        // The common case: the same person signs in again on the same server
        // after their session was ended (a 401 the refresh could not answer).
        repo.setCarLogin("http://abs.local", "tok2", "ref2", "u1", "tony")

        assertEquals("li_1", repo.lastItem.first()?.itemId)
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())
    }

    @Test
    fun knownUserChangeOnSameServerWipes() = runBlocking {
        repo.setCarLogin("http://abs.local", "tokA", null, "userA", "a")
        repo.setOfflineSessions("""{"days":{}}""")

        repo.setCarLogin("http://abs.local", "tokB", null, "userB", "b")

        assertNull(repo.offlineSessions.first())
    }

    @Test
    fun blankUserIdsNeverReadAsAChangedIdentity() = runBlocking {
        // A server that answers a login without an id leaves this blank; "" ->
        // "u1" (or the reverse) is LEARNING the identity, not changing it.
        repo.setCarLogin("http://abs.local", "tok1", null, "", "")
        repo.setOfflineSessions("""{"days":{}}""")

        repo.setCarLogin("http://abs.local", "tok2", null, "u1", "tony")
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())

        repo.setCarLogin("http://abs.local", "tok3", null, "", "")
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())
    }

    @Test
    fun clearDropsTheOfflineQueue() = runBlocking {
        repo.setCarLogin("http://abs.local", "tok", null, "u1", "tony")
        repo.setOfflineSessions("""{"days":{}}""")

        repo.clear()

        // A queue that survived a logout would flush under whichever account
        // signs in next.
        assertNull(repo.offlineSessions.first())
    }

    // ---- credential SOURCE --------------------------------------------------
    // One owner, one value. These two pin the collapse itself: the donor's
    // suite spends a dozen cases arbitrating PHONE against WATCH, and the whole
    // point of the car's store is that there is nothing to arbitrate.

    @Test
    fun everyStoredRowIsCarSourcedAndKeepsItsRefreshToken() = runBlocking {
        repo.setCarLogin("http://abs.local/", " acc ", " ref ", "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals(CredsSource.CAR, creds.source)
        assertEquals("http://abs.local", creds.server)
        assertEquals("acc", creds.token)
        assertEquals("ref", creds.refreshToken)
        assertEquals("tony", creds.username)
        // The type itself carries the collapse — a second value would silently
        // reopen every precedence question this module deleted.
        assertEquals(1, CredsSource.values().size)
    }

    @Test
    fun aStoredLoginIsRefreshableOnItsRefreshTokenAloneWithNoSourceGate() = runBlocking {
        // The collapse, end to end. :wear asks the SOURCE first — a phone
        // mirror is terminal however many tokens it carries — and only then the
        // refresh token. Here the stored refresh token is the whole test.
        repo.setCarLogin("http://abs.local", "acc", "ref", "u1", "tony")
        assertEquals(
            RefreshPolicy.Action.REFRESH,
            RefreshPolicy.onUnauthorized(repo.creds.first())
        )

        repo.setCarLogin("http://abs.local", "acc", null, "u1", "tony")
        assertEquals(
            RefreshPolicy.Action.TERMINAL,
            RefreshPolicy.onUnauthorized(repo.creds.first())
        )
    }

    @Test
    fun aLoginWithoutARefreshTokenHasNoRefreshPath() = runBlocking {
        // A server with refresh disabled. Car-owned like every row, but its
        // 401s stay terminal — and it must not inherit an earlier login's token.
        repo.setCarLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.setCarLogin("http://abs.local", "acc2", null, "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals(CredsSource.CAR, creds.source)
        assertNull(creds.refreshToken)
    }

    // ---- login identity rules ----------------------------------------------

    @Test
    fun aLoginToADifferentServerWipesUserScopedState() = runBlocking {
        repo.setCarLogin("http://abs-a.local", "tokA", "refA", "", "")
        repo.setLastItem("li_a", null)
        repo.setOfflineSessions("""{"days":{"automotive-local_li_a_2026-01-01":{}}}""")

        repo.setCarLogin("http://abs-b.local", "tokB", "refB", "", "")

        assertNull(repo.lastItem.first())
        assertNull(repo.offlineSessions.first())
    }

    @Test
    fun aLoginAsADifferentKnownUserWipesUserScopedState() = runBlocking {
        repo.setCarLogin("http://abs.local", "tokA", "refA", "userA", "a")
        repo.setOfflineSessions("""{"days":{}}""")

        repo.setCarLogin("http://abs.local", "tokB", "refB", "userB", "b")

        assertNull(repo.offlineSessions.first())
    }

    @Test
    fun aLoginAsTheSameIdentityKeepsUserScopedState() = runBlocking {
        repo.setCarLogin("http://abs.local", "tok1", "ref1", "u1", "tony")
        repo.setLastItem("li_1", null)
        repo.setOfflineSessions("""{"days":{}}""")

        repo.setCarLogin("http://abs.local", "tok2", "ref2", "u1", "tony")

        assertEquals("li_1", repo.lastItem.first()?.itemId)
        assertEquals("""{"days":{}}""", repo.offlineSessions.first())
    }

    // ---- refresh results ----------------------------------------------------

    @Test
    fun updateAccessTokenKeepsTheRefreshTokenWhenTheServerDoesNotRotate() = runBlocking {
        repo.setCarLogin("http://abs.local", "acc1", "ref1", "u1", "tony")

        repo.updateAccessToken("acc2", null)

        val creds = repo.creds.first()!!
        assertEquals("acc2", creds.token)
        // An absent rotation means the token that just worked still works —
        // clearing it here would strand the session at the next 401.
        assertEquals("ref1", creds.refreshToken)
        assertEquals(CredsSource.CAR, creds.source)
    }

    @Test
    fun updateAccessTokenKeepsTheRefreshTokenWhenTheRotationIsBlank() = runBlocking {
        repo.setCarLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.updateAccessToken("acc2", "   ")
        assertEquals("ref1", repo.creds.first()?.refreshToken)
    }

    @Test
    fun updateAccessTokenReplacesTheRefreshTokenWhenItRotates() = runBlocking {
        repo.setCarLogin("http://abs.local", "acc1", "ref1", "u1", "tony")

        repo.updateAccessToken("acc2", "ref2")

        val creds = repo.creds.first()!!
        assertEquals("acc2", creds.token)
        assertEquals("ref2", creds.refreshToken)
    }

    @Test
    fun updateAccessTokenDoesNotWipeUserScopedState() = runBlocking {
        // A token ageing out is not an account switch; wiping here would drop
        // the resume pointer and the offline queue on every refresh.
        repo.setCarLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
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

        repo.setCarLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.clear()
        repo.updateAccessToken("acc3", "ref3")
        assertNull(repo.creds.first())
    }

    @Test
    fun updateAccessTokenRefusesABlankToken() = runBlocking {
        repo.setCarLogin("http://abs.local", "acc1", "ref1", "u1", "tony")
        repo.updateAccessToken("   ", "ref2")
        val creds = repo.creds.first()!!
        assertEquals("acc1", creds.token)
        assertEquals("ref1", creds.refreshToken)
    }

    @Test
    fun clearRemovesTheSourceMarkerAndTheRefreshToken() = runBlocking {
        repo.setCarLogin("http://abs.local", "acc1", "ref1", "u1", "tony")

        repo.clear()
        assertNull(repo.creds.first())

        // The next login must not inherit the cleared refresh token — signing
        // in against a refresh-disabled server would otherwise renew, with a
        // dead token, a session that never issued one.
        repo.setCarLogin("http://abs.local", "acc2", null, "u1", "tony")
        val creds = repo.creds.first()!!
        assertEquals(CredsSource.CAR, creds.source)
        assertNull(creds.refreshToken)
        assertEquals(
            RefreshPolicy.Action.TERMINAL,
            RefreshPolicy.onUnauthorized(creds)
        )
    }
}
