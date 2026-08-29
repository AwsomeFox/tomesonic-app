package com.tomesonic.app.automotive.media

/**
 * The media-id grammar, frozen across all four clients (ARCHITECTURE.md §4.1):
 *
 * ```
 * play:<itemId>[::<episodeId>][@@<seconds>]
 * ```
 *
 * Examples, and the whole of the grammar:
 *
 * ```
 * play:li_abc                    // a book
 * play:li_abc::ep_1              // a podcast episode
 * play:li_abc@@1234.5            // a book, resumed at an absolute second
 * play:li_abc::ep_1@@0           // an episode, explicitly from the start
 * ```
 *
 * A port of the patched RNTP MusicService's `parsePlayMediaId` (L353–369),
 * mirrored on the JS side by `native/utils/playMediaId.ts`. Both split at the
 * FIRST delimiter, and that is load-bearing: `a@@1@@2` has the suffix `1@@2`
 * (not a bookmark of 1) and `a::e::x` has the episode `e::x` (not `e`). A
 * `split()`-based parser looks equivalent and diverges on exactly those ids.
 *
 * The one documented difference from the JS parser: an EMPTY episode segment
 * (`play:a::`) reads as `""` here and as `undefined` there. Kotlin's is the
 * older shape and stays, because it is what the shipped Auto service produces
 * and consumes; every consumer must therefore treat a blank episode id as
 * absent, which is what [PlayMediaId.episodeOrNull] exists for — an empty
 * episode id sent to ABS would build `/api/items/{id}/play/` and 404.
 */
data class PlayMediaId(
    val itemId: String,
    /** May be `""` when the id carried an empty `::` segment — see [episodeOrNull]. */
    val episodeId: String?,
    /** The absolute-seconds override some ids carry; null when absent OR unparseable. */
    val bookmarkSeconds: Double?
) {

    /** The episode id a request may actually use: blank collapses to null. */
    fun episodeOrNull(): String? = episodeId?.takeIf { it.isNotBlank() }

    /** Round-trips to the id this was parsed from, for every well-formed input. */
    fun format(): String = format(itemId, episodeId, bookmarkSeconds)

    companion object {

        const val PREFIX = "play:"

        /** The two delimiters, named once so a call site can't misspell one. */
        const val EPISODE_SEPARATOR = "::"
        const val BOOKMARK_SEPARATOR = "@@"

        fun isPlayId(mediaId: String): Boolean = mediaId.startsWith(PREFIX)

        /**
         * Parses the grammar above.
         *
         * `removePrefix` is a no-op when `play:` is absent, matching every call
         * site (each guards with [isPlayId] first) and matching the JS parser's
         * `hasPrefix` option: a stripped-form id parses as a bare item id.
         *
         * Never throws and never rejects: a malformed id yields an empty
         * [itemId], which is what the caller rejects. A browse callback that
         * threw here would leave the controller hanging on an unset future.
         */
        fun parse(mediaId: String): PlayMediaId {
            val body = mediaId.removePrefix(PREFIX)
            val raw = body.substringBefore(BOOKMARK_SEPARATOR)
            // "@@" with nothing (or nothing numeric) after it is NOT a bookmark
            // of 0 — `"".toDoubleOrNull()` is null, and the JS side guards the
            // same footgun (`Number("")` is 0 there).
            val bookmarkSeconds = body.substringAfter(BOOKMARK_SEPARATOR, "").toDoubleOrNull()
            val itemId = raw.substringBefore(EPISODE_SEPARATOR)
            val episodeId =
                if (raw.contains(EPISODE_SEPARATOR)) raw.substringAfter(EPISODE_SEPARATOR) else null
            return PlayMediaId(itemId, episodeId, bookmarkSeconds)
        }

        /**
         * Builds an id. The inverse of [parse] for every id this module emits.
         *
         * A blank [episodeId] is omitted rather than written as an empty `::`
         * segment: the browse tree only ever has one or the other, and emitting
         * the ambiguous form would push the JS/Kotlin divergence above onto the
         * wire. [seconds] is interpolated exactly as the donor's handoff builds
         * it (`"$raw@@$absSec"`), so a Double's own `toString` is the format.
         */
        fun format(itemId: String, episodeId: String? = null, seconds: Double? = null): String {
            val episode = episodeId?.takeIf { it.isNotBlank() }
            val sb = StringBuilder(PREFIX).append(itemId)
            if (episode != null) sb.append(EPISODE_SEPARATOR).append(episode)
            if (seconds != null) sb.append(BOOKMARK_SEPARATOR).append(seconds)
            return sb.toString()
        }
    }
}
