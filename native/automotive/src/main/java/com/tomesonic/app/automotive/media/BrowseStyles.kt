package com.tomesonic.app.automotive.media

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import org.json.JSONObject

/**
 * How a browse row LOOKS: the content-style hints a folder sets on its
 * children, the legacy badge extras a row carries, the progress text, and the
 * two MediaItem builders every node in [BrowseTree] goes through.
 *
 * Ported from the shipped Android Auto service (the patched RNTP MusicService,
 * `absBrowsableItem`/`absItemExtras`/`absPlayableItem`/`absProgressPct`/
 * `absProgressSubtitle`/`absLibraryIconRes`). Every key string here is
 * ARCHITECTURE.md §4.3, VERBATIM: media3 forwards metadata extras to the legacy
 * MediaBrowser the car renders from, and the "obvious"
 * `android.media.description.extra.*` spellings are simply wrong — they parse,
 * they ship, and they render nothing. A rename here is a silent regression in
 * the car and nowhere else, which is why a JVM test asserts the literals.
 *
 * Everything is a pure function of its arguments: no creds, no network, no
 * downloads map. The env-dependent decisions (which cover URL, whether to
 * inline bytes, which progress row) belong to [BrowseTree], which is also where
 * they can be cached — this file only turns already-resolved values into
 * MediaItems, so its whole surface is testable without a server.
 */
object BrowseStyles {

    // ---- Content-style hints (ARCHITECTURE.md §4.3) ----------------------
    // Legacy MediaBrowser extras, forwarded by media3. Set on a FOLDER to
    // control how its CHILDREN render; the root sets the global defaults and
    // folders override per level.

    const val CONTENT_STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
    const val CONTENT_STYLE_PLAYABLE_HINT = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
    const val CONTENT_STYLE_BROWSABLE_HINT = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"

    /** 1 = list, 2 = grid (cover tiles), 3 = category list (tinted icons). */
    const val STYLE_LIST = 1
    const val STYLE_GRID = 2
    const val STYLE_CATEGORY_LIST = 3

    // ---- Badge extras (ARCHITECTURE.md §4.3) -----------------------------
    // The car draws the checkmark, the progress bar and the download icon from
    // these three keys and no others.

    const val EXTRA_DOWNLOAD_STATUS = "android.media.extra.DOWNLOAD_STATUS"
    const val EXTRA_PLAYBACK_STATUS = "android.media.extra.PLAYBACK_STATUS"
    const val EXTRA_COMPLETION_PERCENTAGE = "androidx.media.MediaItem.Extras.COMPLETION_PERCENTAGE"

    /** MediaDescriptionCompat.STATUS_DOWNLOADED. A LONG — an Int renders no icon. */
    const val DOWNLOAD_STATUS_DOWNLOADED = 2L

    /** Ints, unlike the download status: 2 = finished (checkmark), 1 = partially played. */
    const val PLAYBACK_STATUS_FINISHED = 2
    const val PLAYBACK_STATUS_PARTIAL = 1

    /**
     * The global defaults, set on the browse ROOT: playable children render as
     * cover grids (fast visual scanning at a glance), browsable children as
     * category lists with tinted icons.
     */
    fun rootExtras(): Bundle = Bundle().apply {
        putBoolean(CONTENT_STYLE_SUPPORTED, true)
        putInt(CONTENT_STYLE_PLAYABLE_HINT, STYLE_GRID)
        putInt(CONTENT_STYLE_BROWSABLE_HINT, STYLE_CATEGORY_LIST)
    }

    /**
     * One row's badges, from an ABS `mediaProgress` object.
     *
     * [prog] stays a JSONObject rather than becoming a model: these are the
     * rows of `GET /api/me`, read by the donor for exactly three fields, and
     * the reads are the port. A finished item gets the checkmark and NO
     * completion percentage — carrying both makes the car draw a full progress
     * bar UNDER the checkmark, which reads as "not finished".
     */
    fun itemExtras(prog: JSONObject?, downloaded: Boolean): Bundle {
        val b = Bundle()
        if (downloaded) {
            b.putLong(EXTRA_DOWNLOAD_STATUS, DOWNLOAD_STATUS_DOWNLOADED)
        }
        if (prog != null) {
            val finished = prog.optBoolean("isFinished", false)
            val duration = prog.optDouble("duration", 0.0)
            val current = prog.optDouble("currentTime", 0.0)
            when {
                finished -> b.putInt(EXTRA_PLAYBACK_STATUS, PLAYBACK_STATUS_FINISHED)
                current > 0 && duration > 0 -> {
                    b.putInt(EXTRA_PLAYBACK_STATUS, PLAYBACK_STATUS_PARTIAL)
                    b.putDouble(
                        EXTRA_COMPLETION_PERCENTAGE,
                        (current / duration).coerceIn(0.0, 1.0)
                    )
                }
            }
        }
        return b
    }

    /**
     * In-progress percent (1..99), or null when there is nothing meaningful to
     * show. Rides the TITLE prefix, not the subtitle — see [displayTitle].
     *
     * The clamp is the point: 0.4% of a 30-hour book truncates to 0 and would
     * render as "0% • Title" (indistinguishable from unstarted), and 100% is
     * reserved for `isFinished`, which renders as a checkmark instead.
     */
    fun progressPct(prog: JSONObject?): Int? {
        if (prog == null || prog.optBoolean("isFinished", false)) return null
        val duration = prog.optDouble("duration", 0.0)
        val current = prog.optDouble("currentTime", 0.0)
        if (duration <= 0 || current <= 0) return null
        return ((current / duration) * 100).toInt().coerceIn(1, 99)
    }

    /**
     * "author • 3h 12m left" — the one line the car shows under a title.
     *
     * The percent deliberately does NOT appear here: car screens truncate the
     * second line early, and losing "…left" off the end is worse than losing a
     * number that already rides the title.
     */
    fun progressSubtitle(prog: JSONObject?, author: String?): String {
        if (prog == null) return author ?: ""
        if (prog.optBoolean("isFinished", false)) {
            return if (author.isNullOrEmpty()) "Finished" else "$author • Finished"
        }
        val duration = prog.optDouble("duration", 0.0)
        val current = prog.optDouble("currentTime", 0.0)
        val remaining = duration - current
        if (remaining <= 0 || current <= 0) return author ?: ""
        val h = (remaining / 3600).toInt()
        val m = ((remaining % 3600) / 60).toInt()
        val left = if (h > 0) "${h}h ${m}m left" else "${m}m left"
        return if (author.isNullOrEmpty()) left else "$author • $left"
    }

    /**
     * Progress at the FRONT of the title ("42% • Critical Mass", "✓ Critical
     * Mass"). The donor moved it here after the trailing form never showed:
     * car screens truncate subtitles early, the native badges are unreliable
     * across head units, and the cover tile already identifies the book.
     */
    fun displayTitle(prog: JSONObject?, title: String): String {
        val pct = progressPct(prog)
        return when {
            prog?.optBoolean("isFinished", false) == true -> "✓ $title"
            pct != null -> "$pct% • $title"
            else -> title
        }
    }

    /**
     * ABS library icon name -> bundled drawable. Mirrors the phone's
     * components/LibraryIcon.tsx (keep the two maps in sync); an unknown name
     * — a server newer than this build — falls back by media type rather than
     * rendering an empty tile.
     *
     * The names are drawable resources of THIS module (`res/drawable/aa_*.xml`,
     * all 20 copied from the phone app in Wave 3), reached by the car's process
     * through the `android.resource://` URI [iconUri] builds.
     */
    fun libraryIconRes(iconName: String?, mediaType: String): String = when (iconName) {
        "database" -> "aa_lib_database"
        "audiobookshelf" -> "aa_library"
        "books-1" -> "aa_books"
        "books-2" -> "aa_collections"
        "book-1" -> "aa_library"
        "microphone-1", "microphone-3", "podcast" -> "aa_lib_mic"
        "radio" -> "aa_lib_radio"
        "rss" -> "aa_lib_rss"
        "headphones" -> "aa_lib_headphones"
        "music" -> "aa_lib_music"
        "file-picture" -> "aa_lib_image"
        "rocket" -> "aa_lib_rocket"
        "power" -> "aa_lib_power"
        "star" -> "aa_lib_star"
        "heart" -> "aa_lib_heart"
        else -> if (mediaType == "podcast") "aa_lib_mic" else "aa_library"
    }

    /**
     * `android.resource://com.tomesonic.app/drawable/aa_series` — a category
     * icon the Media Center's own process can resolve.
     *
     * [packageName] is the APPLICATION id, not this module's Kotlin package:
     * the car app ships under `com.tomesonic.app` (shared with the phone,
     * ARCHITECTURE.md §1) while the code lives in `…app.automotive`. Callers
     * pass `Context.getPackageName()` so the two can never drift.
     */
    fun iconUri(packageName: String, iconRes: String): Uri =
        Uri.parse("android.resource://$packageName/drawable/$iconRes")

    /**
     * A folder. [artworkUri] (a real cover) wins over [iconUri]: the donor's
     * rule, and the reason a Continue-Series folder shows the next book's cover
     * while a plain category shows a tinted glyph.
     *
     * The child-style hints are set as metadata EXTRAS on the folder itself —
     * that is where the legacy browser reads them from, not from the params of
     * the `onGetChildren` call that returns the folder's children.
     */
    fun browsableItem(
        id: String,
        title: String,
        subtitle: String? = null,
        artworkUri: Uri? = null,
        iconUri: Uri? = null,
        childPlayableStyle: Int? = null,
        childBrowsableStyle: Int? = null
    ): MediaItem {
        val md = MediaMetadata.Builder()
            .setTitle(title)
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        if (!subtitle.isNullOrEmpty()) md.setSubtitle(subtitle)
        when {
            artworkUri != null -> md.setArtworkUri(artworkUri)
            iconUri != null -> md.setArtworkUri(iconUri)
        }
        if (childPlayableStyle != null || childBrowsableStyle != null) {
            val extras = Bundle()
            childPlayableStyle?.let { extras.putInt(CONTENT_STYLE_PLAYABLE_HINT, it) }
            childBrowsableStyle?.let { extras.putInt(CONTENT_STYLE_BROWSABLE_HINT, it) }
            md.setExtras(extras)
        }
        return MediaItem.Builder().setMediaId(id).setMediaMetadata(md.build()).build()
    }

    /**
     * A playable row. [mediaId] is always a [PlayMediaId] string — the frozen
     * `play:` grammar is what the car hands back on a tap.
     *
     * [artist] is the line the car renders under the title for playable items,
     * which is why the callers pass the PROGRESS line into it rather than a
     * bare author: it is the only one of the two that is guaranteed to show.
     *
     * Artwork is either a URI (online: the car's process fetches the cover
     * itself, token in the query string per §4.4) or raw BYTES (offline: the
     * car's process cannot read this app's private files, so a `file://` cover
     * renders as a blank tile — [BrowseTree] decodes and re-compresses instead).
     * Both null leaves the tile art-less, which is what the Downloads folder's
     * Binder budget spends on the rows past its cap.
     */
    fun playableItem(
        mediaId: String,
        title: String,
        artist: String?,
        subtitle: String?,
        prog: JSONObject? = null,
        artworkUri: Uri? = null,
        artworkBytes: ByteArray? = null,
        downloaded: Boolean = false
    ): MediaItem {
        val md = MediaMetadata.Builder()
            .setTitle(displayTitle(prog, title))
            .setArtist(artist ?: "")
            .setIsBrowsable(false)
            .setIsPlayable(true)
            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
            .setExtras(itemExtras(prog, downloaded))
        when {
            artworkUri != null -> md.setArtworkUri(artworkUri)
            artworkBytes != null ->
                md.setArtworkData(artworkBytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
        }
        if (!subtitle.isNullOrEmpty()) md.setSubtitle(subtitle)
        return MediaItem.Builder().setMediaId(mediaId).setMediaMetadata(md.build()).build()
    }
}
