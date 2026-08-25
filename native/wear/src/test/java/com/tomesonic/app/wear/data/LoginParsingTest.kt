package com.tomesonic.app.wear.data

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `POST /login` — both success shapes and every failure the watch can be told
 * apart, since each one sends the user somewhere different: to their password,
 * to the address they typed, to a wait, or to the server's own logs.
 *
 * Robolectric only because org.json lives in android.jar; no Context is touched.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class LoginParsingTest {

    private val server = "http://abs.local"

    // ---- fixtures ----------------------------------------------------------

    /** A current server: an access/refresh pair, plus the fields the mirror needs. */
    private val newServerShape = """
        {
          "user": {
            "id": "usr_1",
            "username": "tony",
            "accessToken": "acc_new",
            "refreshToken": "ref_new",
            "type": "user"
          },
          "userDefaultLibraryId": "lib_1"
        }
    """.trimIndent()

    /** An older server: one long-lived `token`, no refresh at all. */
    private val legacyShape = """
        {
          "user": {
            "id": "usr_1",
            "username": "tony",
            "token": "legacy_tok"
          }
        }
    """.trimIndent()

    // ---- success shapes ----------------------------------------------------

    @Test
    fun readsTheAccessAndRefreshPairFromACurrentServer() {
        val result = AbsApi.parseLogin(server, 200, newServerShape)
        assertTrue(result is LoginResult.Success)
        val success = result as LoginResult.Success
        assertEquals(server, success.server)
        assertEquals("acc_new", success.token)
        assertEquals("ref_new", success.refreshToken)
        assertEquals("usr_1", success.userId)
        assertEquals("tony", success.username)
    }

    @Test
    fun fallsBackToTheLegacyTokenField() {
        // `user.accessToken ?: user.token` — the phone's exact read.
        val success = AbsApi.parseLogin(server, 200, legacyShape) as LoginResult.Success
        assertEquals("legacy_tok", success.token)
        // No refresh token: this login's 401s stay terminal, by design.
        assertNull(success.refreshToken)
    }

    @Test
    fun prefersAccessTokenWhenBothArePresent() {
        val raw = """{ "user": { "accessToken": "acc", "token": "legacy" } }"""
        val success = AbsApi.parseLogin(server, 200, raw) as LoginResult.Success
        assertEquals("acc", success.token)
    }

    @Test
    fun missingIdentityFieldsBecomeEmptyStringsNotTheStringNull() {
        // org.json's optString returns "null" for an explicit JSON null, which
        // would land in the mirror and render literally.
        val raw = """{ "user": { "accessToken": "acc", "id": null, "username": null } }"""
        val success = AbsApi.parseLogin(server, 200, raw) as LoginResult.Success
        assertEquals("", success.userId)
        assertEquals("", success.username)
    }

    // ---- 200 without a token ------------------------------------------------

    @Test
    fun a200WithNoTokenIsAServerProblemNotABadPassword() {
        // A proxy that strips or rewrites the body, or an interstitial page from
        // one the request never got past. Reporting bad credentials would send
        // the user to change a password that was never wrong.
        assertEquals(LoginResult.ServerError, AbsApi.parseLogin(server, 200, """{ "user": {} }"""))
        assertEquals(LoginResult.ServerError, AbsApi.parseLogin(server, 200, "{}"))
        assertEquals(LoginResult.ServerError, AbsApi.parseLogin(server, 200, null))
        assertEquals(
            LoginResult.ServerError,
            AbsApi.parseLogin(server, 200, "<html><body>hello</body></html>")
        )
        // An explicit null token is just as absent as a missing one.
        assertEquals(
            LoginResult.ServerError,
            AbsApi.parseLogin(server, 200, """{ "user": { "accessToken": null, "token": "" } }""")
        )
    }

    // ---- failure mapping ----------------------------------------------------

    @Test
    fun rejectedCredentialsAre401And403() {
        assertEquals(LoginResult.BadCredentials, AbsApi.parseLogin(server, 401, null))
        assertEquals(LoginResult.BadCredentials, AbsApi.parseLogin(server, 403, null))
    }

    @Test
    fun noResponseAtAllIsUnreachable() {
        // The distinction the whole error line rests on: the server said no,
        // versus there was no server.
        assertEquals(LoginResult.Unreachable, AbsApi.parseLogin(server, null, null))
    }

    @Test
    fun tooManyAttemptsIs429() {
        assertEquals(LoginResult.RateLimited, AbsApi.parseLogin(server, 429, null))
    }

    @Test
    fun serverProblemsAre5xx() {
        assertEquals(LoginResult.ServerError, AbsApi.parseLogin(server, 500, null))
        assertEquals(LoginResult.ServerError, AbsApi.parseLogin(server, 502, null))
        assertEquals(LoginResult.ServerError, AbsApi.parseLogin(server, 503, null))
    }

    @Test
    fun anyOtherStatusFallsBackToTheCredentialsMessage() {
        // The phone's ConnectScreen fallback, kept identical.
        assertEquals(LoginResult.BadCredentials, AbsApi.parseLogin(server, 400, null))
        assertEquals(LoginResult.BadCredentials, AbsApi.parseLogin(server, 404, null))
    }
}
