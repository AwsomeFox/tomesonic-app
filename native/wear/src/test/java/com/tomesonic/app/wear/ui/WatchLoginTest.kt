package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.LoginResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What the watch does with a typed address, and what it says when a sign-in
 * fails. Pure JVM: both are decisions a running watch cannot check for you —
 * a wrong error line looks exactly like a right one until the day it misleads.
 */
class WatchLoginTest {

    // ---- the address ---------------------------------------------------------

    @Test
    fun `a scheme-less address gets https`() {
        // A watch keyboard is a poor place to type "https://", and dictation
        // never produces it.
        assertEquals("https://abs.example.com", WatchLogin.normalizeEntry("abs.example.com"))
        assertEquals("https://abs.local:13378", WatchLogin.normalizeEntry("abs.local:13378"))
    }

    @Test
    fun `a typed scheme is kept, http included`() {
        // Self-hosted servers on plain http stay reachable by typing it — the
        // manifest keeps cleartext traffic on for exactly this.
        assertEquals("http://abs.local", WatchLogin.normalizeEntry("http://abs.local"))
        assertEquals("https://abs.local", WatchLogin.normalizeEntry("https://abs.local"))
        assertEquals("http://10.0.0.5:8080", WatchLogin.normalizeEntry("  http://10.0.0.5:8080  "))
    }

    @Test
    fun `trailing slashes are stripped, all of them`() {
        // Every URL in the app concatenates a leading-slash path onto this.
        assertEquals("https://abs.local", WatchLogin.normalizeEntry("abs.local/"))
        assertEquals("http://abs.local", WatchLogin.normalizeEntry("http://abs.local///"))
    }

    @Test
    fun `nothing typed is nothing to try`() {
        assertNull(WatchLogin.normalizeEntry(null))
        assertNull(WatchLogin.normalizeEntry(""))
        assertNull(WatchLogin.normalizeEntry("   "))
    }

    // ---- the sentence --------------------------------------------------------

    @Test
    fun `each failure maps to the phone's own wording`() {
        assertEquals(WatchLogin.INVALID_CREDENTIALS, WatchLogin.message(LoginResult.BadCredentials))
        assertEquals(WatchLogin.UNREACHABLE, WatchLogin.message(LoginResult.Unreachable))
        assertEquals(WatchLogin.RATE_LIMITED, WatchLogin.message(LoginResult.RateLimited))
        assertEquals(WatchLogin.SERVER_PROBLEM, WatchLogin.message(LoginResult.ServerError))
    }

    @Test
    fun `the wording is the phone's, verbatim`() {
        // screens/ConnectScreen.tsx — a user who mistypes on both devices must
        // be told the same thing by both.
        assertEquals("Invalid username or password.", WatchLogin.INVALID_CREDENTIALS)
        assertEquals(
            "Couldn't reach the server. Check the address and your connection.",
            WatchLogin.UNREACHABLE
        )
        assertEquals("Too many attempts. Please wait a moment and try again.", WatchLogin.RATE_LIMITED)
        assertEquals("The server had a problem. Please try again.", WatchLogin.SERVER_PROBLEM)
    }

    @Test
    fun `a success has no line - the app leaves the screen`() {
        val success = LoginResult.Success(
            server = "http://abs.local",
            token = "acc",
            refreshToken = "ref",
            userId = "u1",
            username = "tony"
        )
        assertNull(WatchLogin.message(success))
    }
}
