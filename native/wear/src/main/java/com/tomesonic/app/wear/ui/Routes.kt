package com.tomesonic.app.wear.ui

/**
 * The navigation graph as data — the contract's route list from
 * native/wear/ARCHITECTURE.md ("UI (Wave 4A)") and nothing else.
 *
 * Route STRINGS are built here rather than at call sites so a screen can never
 * navigate to a path the graph doesn't declare, and the start-destination rule
 * is a pure function so it can be pinned by a JVM test instead of by pairing a
 * watch with a phone.
 */
object Routes {

    const val CONNECT = "connect"
    const val HOME = "home"
    const val PLAYER = "player"
    const val DOWNLOADS = "downloads"
    const val SETTINGS = "settings"

    /** Templates — the `{}` names are what [android.os.Bundle.getString] reads back. */
    const val LIBRARY_TEMPLATE = "library/{id}"
    const val ITEM_TEMPLATE = "item/{id}"
    const val SEARCH_TEMPLATE = "search/{id}"

    const val ARG_ID = "id"

    fun library(libraryId: String): String = "library/$libraryId"

    fun item(itemId: String): String = "item/$itemId"

    fun search(libraryId: String): String = "search/$libraryId"

    /**
     * Where the app opens.
     *
     * Both "never configured" and "the server rejected our token" land on
     * [CONNECT], because the fix for both is the same single action on the
     * phone; the screen itself changes its copy (see ConnectScreen). A watch
     * with a dead token can still reach its downloads FROM that screen, which is
     * why the whole graph is registered either way and only the start
     * destination moves.
     */
    fun startDestination(hasCreds: Boolean, authFailed: Boolean): String =
        if (!hasCreds || authFailed) CONNECT else HOME
}
