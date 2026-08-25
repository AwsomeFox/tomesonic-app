package com.tomesonic.app.wear.data

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins AbsClient.sameOrigin — the predicate every token-attach decision rides
 * on. The original implementation was a raw string-prefix test on the full URL,
 * which leaked the Bearer token to any host whose name string-extends the
 * configured origin ("http://abs.local" prefixes "http://abs.local.attacker.com",
 * "http://10.0.0.5" prefixes "http://10.0.0.50"). These tests exist so that
 * shape of bug cannot come back.
 */
class AbsClientOriginTest {

    private fun same(a: String, b: String) =
        AbsClient.sameOrigin(a.toHttpUrl(), b.toHttpUrl())

    @Test
    fun `same origin matches regardless of path and query`() {
        assertTrue(same("http://abs.local/api/libraries?limit=50", "http://abs.local/"))
        assertTrue(same("https://abs.example.com/api/items/x/cover", "https://abs.example.com/"))
    }

    @Test
    fun `host that string-extends the origin does NOT match`() {
        // The exact leak from the review finding.
        assertFalse(same("http://abs.local.attacker.com/cover.jpg", "http://abs.local/"))
    }

    @Test
    fun `adjacent IP that string-extends the origin does NOT match`() {
        assertFalse(same("http://10.0.0.50/api/items", "http://10.0.0.5/"))
    }

    @Test
    fun `different scheme does NOT match`() {
        assertFalse(same("https://abs.local/api", "http://abs.local/"))
    }

    @Test
    fun `explicit default port equals implicit default port`() {
        assertTrue(same("http://abs.local:80/api", "http://abs.local/"))
        assertTrue(same("https://abs.local:443/api", "https://abs.local/"))
    }

    @Test
    fun `non-default port does NOT match the default`() {
        assertFalse(same("http://abs.local:8080/api", "http://abs.local/"))
    }

    @Test
    fun `matching non-default ports match`() {
        assertTrue(same("http://abs.local:13378/api", "http://abs.local:13378/"))
    }

    @Test
    fun `host comparison is case-insensitive`() {
        assertTrue(same("http://ABS.Local/api", "http://abs.local/"))
    }

    @Test
    fun `subdomain of the origin does NOT match`() {
        assertFalse(same("http://evil.abs.local/api", "http://abs.local/"))
    }
}
