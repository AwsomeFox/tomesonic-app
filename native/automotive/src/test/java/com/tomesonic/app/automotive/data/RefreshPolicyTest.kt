package com.tomesonic.app.automotive.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The 401 decision table, as a table.
 *
 * Pure JVM — no Robolectric, no OkHttp, no server: that is the whole reason
 * these two decisions were lifted out of AbsClient. The rules they encode are
 * the ones that cannot be verified by looking at a running car, because getting
 * them wrong looks like "it works" until a token expires mid-drive, or like a
 * signed-out head unit after a parking garage.
 *
 * The donor's table has one more axis — the credential SOURCE, which the watch
 * uses to arbitrate a phone mirror against its own login. Collapsed away here
 * (ARCHITECTURE.md §3, §6): one owner, one axis.
 */
class RefreshPolicyTest {

    private fun creds(
        source: CredsSource,
        refreshToken: String?
    ) = Creds(
        server = "http://abs.local",
        token = "acc",
        userId = "u1",
        username = "tony",
        source = source,
        refreshToken = refreshToken
    )

    // ---- refresh token -> what a 401 means ---------------------------------

    @Test
    fun `a login with a refresh token refreshes`() {
        assertEquals(
            RefreshPolicy.Action.REFRESH,
            RefreshPolicy.onUnauthorized(creds(CredsSource.CAR, "ref"))
        )
    }

    @Test
    fun `a login without a refresh token is terminal`() {
        // A server with refresh disabled: the car's own session, but with
        // nothing to renew. Sign in again, while parked.
        assertEquals(
            RefreshPolicy.Action.TERMINAL,
            RefreshPolicy.onUnauthorized(creds(CredsSource.CAR, null))
        )
        assertEquals(
            RefreshPolicy.Action.TERMINAL,
            RefreshPolicy.onUnauthorized(creds(CredsSource.CAR, "   "))
        )
    }

    @Test
    fun `no credentials at all is terminal`() {
        assertEquals(RefreshPolicy.Action.TERMINAL, RefreshPolicy.onUnauthorized(null))
    }

    @Test
    fun `the credential source is not a gate because there is only one`() {
        // :wear's first rule is `creds.source != WATCH -> TERMINAL`, which is
        // how a phone mirror (an access token with no refresh token behind it)
        // stays terminal there. The car has exactly one credential owner, so
        // the enum has exactly one value and the refresh token is the whole
        // decision — this pins both halves of that claim, because a second
        // value silently reintroduced would change every answer above.
        assertEquals(1, CredsSource.values().size)
        assertEquals(CredsSource.CAR, CredsSource.values()[0])
        assertEquals(
            RefreshPolicy.Action.REFRESH,
            RefreshPolicy.onUnauthorized(
                Creds("http://abs.local", "acc", "u1", "tony", refreshToken = "ref")
            )
        )
    }

    // ---- refresh response -> outcome ---------------------------------------

    @Test
    fun `200 with an access token is a success`() {
        assertEquals(RefreshPolicy.Outcome.SUCCESS, RefreshPolicy.classify(200, "new-acc"))
    }

    @Test
    fun `401 and 403 from the refresh endpoint are definitive`() {
        assertEquals(RefreshPolicy.Outcome.DEFINITIVE, RefreshPolicy.classify(401, null))
        assertEquals(RefreshPolicy.Outcome.DEFINITIVE, RefreshPolicy.classify(403, null))
        // Even with a token in the body: the status is the answer.
        assertEquals(RefreshPolicy.Outcome.DEFINITIVE, RefreshPolicy.classify(401, "new-acc"))
    }

    @Test
    fun `no response at all is transient`() {
        // Offline, DNS, TLS, a hung server. Signing the user out over a parking
        // garage would strand a session that is alive — the phone's
        // utils/api.ts draws exactly this line.
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(null, null))
    }

    @Test
    fun `server errors are transient`() {
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(500, null))
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(502, null))
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(503, null))
    }

    @Test
    fun `a 200 with no token is transient, not a dead session`() {
        // A proxy that rewrote the body is not the server revoking anything.
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(200, null))
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(200, ""))
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(200, "   "))
    }

    @Test
    fun `other statuses are transient`() {
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(400, null))
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(404, null))
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(429, null))
        // A 2xx that isn't 200 is not the shape ABS answers with.
        assertEquals(RefreshPolicy.Outcome.TRANSIENT, RefreshPolicy.classify(204, "new-acc"))
    }

    // ---- only DEFINITIVE may raise authFailed -------------------------------

    @Test
    fun `only a definitive outcome reports an auth failure`() {
        assertTrue(RefreshPolicy.isAuthFailure(RefreshPolicy.Outcome.DEFINITIVE))
        assertFalse(RefreshPolicy.isAuthFailure(RefreshPolicy.Outcome.TRANSIENT))
        assertFalse(RefreshPolicy.isAuthFailure(RefreshPolicy.Outcome.SUCCESS))
    }
}
