package com.tomesonic.app.wear.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The 401 decision table, as a table.
 *
 * Pure JVM — no Robolectric, no OkHttp, no server: that is the whole reason
 * these two decisions were lifted out of AbsClient. The rules they encode are
 * the ones that cannot be verified by looking at a running watch, because
 * getting them wrong looks like "it works" until a token expires far from a
 * phone, or like a signed-out watch after a tunnel.
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

    // ---- source × refresh token -> what a 401 means ------------------------

    @Test
    fun `a watch login with a refresh token refreshes`() {
        assertEquals(
            RefreshPolicy.Action.REFRESH,
            RefreshPolicy.onUnauthorized(creds(CredsSource.WATCH, "ref"))
        )
    }

    @Test
    fun `a phone mirror is terminal even if a refresh token somehow appears`() {
        // The Data Layer carries the ACCESS token alone, and credsFrom refuses
        // to read a refresh token for a phone row — this pins the rule at the
        // other end too, so v1's behaviour cannot regress through this door.
        assertEquals(
            RefreshPolicy.Action.TERMINAL,
            RefreshPolicy.onUnauthorized(creds(CredsSource.PHONE, null))
        )
        assertEquals(
            RefreshPolicy.Action.TERMINAL,
            RefreshPolicy.onUnauthorized(creds(CredsSource.PHONE, "ref"))
        )
    }

    @Test
    fun `a watch login without a refresh token is terminal`() {
        // A server with refresh disabled: watch-owned, but with nothing to
        // renew. Same answer as a phone mirror — sign in again.
        assertEquals(
            RefreshPolicy.Action.TERMINAL,
            RefreshPolicy.onUnauthorized(creds(CredsSource.WATCH, null))
        )
        assertEquals(
            RefreshPolicy.Action.TERMINAL,
            RefreshPolicy.onUnauthorized(creds(CredsSource.WATCH, "   "))
        )
    }

    @Test
    fun `no credentials at all is terminal`() {
        assertEquals(RefreshPolicy.Action.TERMINAL, RefreshPolicy.onUnauthorized(null))
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
        // Offline, DNS, TLS, a hung server. Signing the user out over a tunnel
        // would strand a session that is alive — the phone's utils/api.ts draws
        // exactly this line.
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
