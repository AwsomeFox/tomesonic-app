package com.tomesonic.app.wear.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Where the app opens, and what a route string looks like.
 *
 * The start-destination rule is the whole reason this is a function rather than
 * an `if` inside a composable: it decides the first thing a user sees on every
 * launch, and the authFailed half of it (a watch WITH credentials that still has
 * to go to `connect`) is the case nobody would think to test by hand.
 */
class RoutesTest {

    @Test
    fun noCredentialsOpensTheConnectScreen() {
        assertEquals(Routes.CONNECT, Routes.startDestination(hasCreds = false, authFailed = false))
    }

    @Test
    fun credentialsOpenHome() {
        assertEquals(Routes.HOME, Routes.startDestination(hasCreds = true, authFailed = false))
    }

    @Test
    fun aRejectedTokenOpensConnectEvenWithCredentialsStored() {
        // v1 never refreshes a token: the only fix is on the phone, so the watch
        // must not open a home screen where every row would fail to load.
        assertEquals(Routes.CONNECT, Routes.startDestination(hasCreds = true, authFailed = true))
        assertEquals(Routes.CONNECT, Routes.startDestination(hasCreds = false, authFailed = true))
    }

    @Test
    fun routesAreBuiltFromTheTemplatesTheGraphDeclares() {
        assertEquals("library/{${Routes.ARG_ID}}", Routes.LIBRARY_TEMPLATE)
        assertEquals("item/{${Routes.ARG_ID}}", Routes.ITEM_TEMPLATE)
        assertEquals("library/lib-1", Routes.library("lib-1"))
        assertEquals("item/li_abc123", Routes.item("li_abc123"))
    }
}
