package com.tomesonic.app.wear.tile

import com.tomesonic.app.wear.data.LastItem

/**
 * Everything the Continue Listening tile draws, decided from the two facts a
 * tile render is allowed to read.
 *
 * Pure on purpose. A tile renders in a system surface, off the app's own
 * process lifecycle and with no network on the render path (see
 * native/wear/ARCHITECTURE.md), so "why does the tile say the wrong thing" is
 * the hardest bug in this lane to reproduce by hand. Deciding it here makes the
 * whole table a JVM test and leaves the service with layout only.
 *
 * Three lines, always the same three slots, so the layout never branches:
 * [primary] and [secondary] are the text, [actionLabel] is the one chip.
 */
sealed interface TileState {

    /** The headline. Never blank — the tile has no empty state to fall into. */
    val primary: String

    /** The line under it, or null when there is nothing true to put there. */
    val secondary: String?

    /** The chip's label. The tile offers exactly ONE action, in every state. */
    val actionLabel: String

    /**
     * No server + token on the watch. The tile still opens the app rather than
     * saying nothing: the connect screen is where "open TomeSonic on your phone"
     * is explained, and it is the only screen that can change this state.
     */
    data object NotConfigured : TileState {
        override val primary: String = APP_NAME
        override val secondary: String = "Connect from your phone"
        override val actionLabel: String = "Open TomeSonic"
    }

    /** Configured, but this watch has never played anything (no `last_item_id`). */
    data object NothingPlaying : TileState {
        override val primary: String = APP_NAME
        override val secondary: String = "Nothing playing yet"
        override val actionLabel: String = "Browse your library"
    }

    /**
     * The last thing this watch played. [itemId]/[episodeId] ride the tap intent
     * into MainActivity, so a Resume tap starts the book rather than dropping the
     * user on home to find it again.
     */
    data class Resume(
        override val primary: String,
        override val secondary: String?,
        val itemId: String,
        val episodeId: String?
    ) : TileState {
        override val actionLabel: String = "Resume"
    }

    companion object {

        const val APP_NAME = "TomeSonic"

        /**
         * What a [LastItem] with no title says. Rows written by v1 builds carry
         * an id and nothing else (title/author only started being written in v2
         * — see CredsRepository.setLastItem), and the tile has no way to look one
         * up: it must render id-only data without looking broken.
         */
        const val GENERIC_TITLE = "Continue listening"

        /**
         * Credentials outrank the resume pointer even when both exist. A tile
         * that offered Resume with no token would hand the user a play attempt
         * that can only fail — SessionManager needs the token to open a play
         * session, and the one case that would still work (a downloaded book) is
         * not knowable here: the download index is a file read, and the render
         * path stays off disk beyond the one DataStore snapshot.
         */
        fun from(hasCreds: Boolean, lastItem: LastItem?): TileState {
            if (!hasCreds) return NotConfigured
            val last = lastItem ?: return NothingPlaying
            return Resume(
                primary = last.title?.takeIf { it.isNotBlank() } ?: GENERIC_TITLE,
                // No author line rather than a placeholder one: a v1 row has no
                // author to show, and "Unknown author" is a worse lie than a
                // shorter card.
                secondary = last.author?.takeIf { it.isNotBlank() },
                itemId = last.itemId,
                episodeId = last.episodeId
            )
        }
    }
}
