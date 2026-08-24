package com.tomesonic.app.wear.data

import org.json.JSONArray
import org.json.JSONObject

// ABS response models + their org.json parsers. Ported from the phone's native
// ABS client (the patched RNTP MusicService.kt) — same tolerance rules, because
// the same servers answer both: every parser takes what it recognises, defaults
// what it doesn't, and returns null instead of throwing. A malformed row must
// cost one row, never a whole screen.

/**
 * org.json GOTCHA (verbatim from MusicService.absStr): `optString` on an
 * EXPLICIT JSON null returns the STRING "null", which would render literally.
 * Empty strings collapse to null too — ABS sends "" for "unset" all over.
 */
internal fun absStr(o: JSONObject?, key: String): String? {
    if (o == null || o.isNull(key)) return null
    return o.optString(key).ifEmpty { null }
}

/** Null (not 0.0) for absent/null/unparseable numbers — callers pick the default. */
internal fun absDouble(o: JSONObject?, key: String): Double? {
    if (o == null || o.isNull(key)) return null
    val d = o.optDouble(key, Double.NaN)
    return if (d.isNaN() || d.isInfinite()) null else d
}

internal fun absLong(o: JSONObject?, key: String): Long? {
    if (o == null || o.isNull(key)) return null
    return o.optLong(key, 0L)
}

/** Non-finite values would throw out of JSONObject.put — clamp them at the edge. */
internal fun absFinite(v: Double): Double = if (v.isNaN() || v.isInfinite()) 0.0 else v

/** The ABS credentials mirrored from the phone. Never persisted anywhere else. */
data class Creds(
    val server: String,
    val token: String,
    val userId: String,
    val username: String
)

/** `last_item_id` + `last_episode_id` as one value — the home screen's resume card. */
data class LastItem(val itemId: String, val episodeId: String?)

data class LibrarySummary(
    val id: String,
    val name: String,
    val mediaType: String
) {
    companion object {
        fun fromJson(o: JSONObject?): LibrarySummary? {
            val obj = o ?: return null
            return try {
                val id = absStr(obj, "id") ?: return null
                LibrarySummary(
                    id = id,
                    name = absStr(obj, "name") ?: "Library",
                    mediaType = absStr(obj, "mediaType") ?: "book"
                )
            } catch (t: Throwable) {
                null
            }
        }
    }
}

/**
 * One row of a browse list. Parses BOTH shapes the watch asks for:
 * - a minified `/api/libraries/{id}/items` result, and
 * - an `/api/me/items-in-progress` libraryItem, which may carry `recentEpisode`
 *   (its `id` is the episodeId to play — same read as BookshelfScreen.tsx).
 *
 * `title` is always the ITEM's title, podcast rows included; the episode title
 * costs an extra expanded fetch and only the item screen needs it.
 */
data class ItemSummary(
    val id: String,
    val title: String,
    val authorName: String?,
    val mediaType: String,
    val progress: Double?,
    val episodeId: String?
) {
    companion object {
        fun fromJson(o: JSONObject?): ItemSummary? {
            val obj = o ?: return null
            return try {
                val id = absStr(obj, "id") ?: return null
                val media = obj.optJSONObject("media")
                val md = media?.optJSONObject("metadata")
                val mediaType = absStr(obj, "mediaType") ?: absStr(media, "mediaType") ?: "book"
                ItemSummary(
                    id = id,
                    title = absStr(md, "title")
                        ?: absStr(obj, "title")
                        ?: if (mediaType == "podcast") "Podcast" else "Audiobook",
                    // Books carry authorName, podcasts author (MusicService reads
                    // the same two keys for the same reason).
                    authorName = absStr(md, "authorName") ?: absStr(md, "author"),
                    mediaType = mediaType,
                    progress = progressFraction(obj.optJSONObject("userMediaProgress")),
                    episodeId = absStr(obj.optJSONObject("recentEpisode"), "id")
                )
            } catch (t: Throwable) {
                null
            }
        }

        /** 0..1, from the server's own fraction when present, else currentTime/duration. */
        private fun progressFraction(prog: JSONObject?): Double? {
            if (prog == null) return null
            absDouble(prog, "progress")?.let { return it.coerceIn(0.0, 1.0) }
            val current = absDouble(prog, "currentTime") ?: return null
            val duration = absDouble(prog, "duration") ?: return null
            if (duration <= 0.0) return null
            return (current / duration).coerceIn(0.0, 1.0)
        }
    }
}

/** Absolute book-second boundaries; `end` is EXCLUSIVE (see ChapterMath). */
data class Chapter(
    val id: Int,
    val start: Double,
    val end: Double,
    val title: String
) {
    companion object {
        fun fromJson(o: JSONObject?, fallbackId: Int = 0): Chapter? {
            val obj = o ?: return null
            return try {
                val id = if (obj.isNull("id")) fallbackId else obj.optInt("id", fallbackId)
                Chapter(
                    id = id,
                    start = absDouble(obj, "start") ?: 0.0,
                    end = absDouble(obj, "end") ?: 0.0,
                    title = absStr(obj, "title") ?: "Chapter ${id + 1}"
                )
            } catch (t: Throwable) {
                null
            }
        }
    }
}

/**
 * One playable file. `filename` is derived EXACTLY like utils/downloader.ts
 * builds its part filenames (`track_{index}.{ext}`, uniquified on a repeated
 * index) so Wave 3B's on-disk layout and Wave 3A's local MediaItems agree
 * without either re-deriving it.
 */
data class AudioTrack(
    val index: Int,
    val startOffset: Double,
    val duration: Double,
    val title: String,
    val contentUrl: String,
    val mimeType: String,
    val filename: String
) {
    companion object {
        /**
         * `itemId` builds the `/api/items/{id}/file/{ino}` fallback used when a row
         * has no contentUrl (media.audioFiles rows never do — see downloader.ts).
         * `runningOffset` is the fallback startOffset for those same rows.
         */
        fun fromJson(
            o: JSONObject?,
            itemId: String,
            fallbackIndex: Int,
            runningOffset: Double = 0.0
        ): AudioTrack? {
            val obj = o ?: return null
            return try {
                val index = if (obj.isNull("index")) fallbackIndex else obj.optInt("index", fallbackIndex)
                val metadata = obj.optJSONObject("metadata")
                val ext = (absStr(metadata, "ext") ?: absStr(obj, "ext") ?: "mp3").removePrefix(".")
                AudioTrack(
                    index = index,
                    startOffset = absDouble(obj, "startOffset") ?: runningOffset,
                    duration = absDouble(obj, "duration") ?: 0.0,
                    title = absStr(obj, "title") ?: absStr(metadata, "filename") ?: "track_$index",
                    contentUrl = absStr(obj, "contentUrl")
                        ?: "/api/items/$itemId/file/${absStr(obj, "ino") ?: ""}",
                    mimeType = absStr(obj, "mimeType") ?: "",
                    filename = "track_$index.$ext"
                )
            } catch (t: Throwable) {
                null
            }
        }
    }
}

data class PodcastEpisode(
    val id: String,
    val title: String,
    val publishedAt: Long?,
    val duration: Double?
) {
    companion object {
        fun fromJson(o: JSONObject?): PodcastEpisode? {
            val obj = o ?: return null
            return try {
                val id = absStr(obj, "id") ?: return null
                PodcastEpisode(
                    id = id,
                    title = absStr(obj, "title") ?: "Episode",
                    publishedAt = absLong(obj, "publishedAt"),
                    // Episodes carry the duration on the episode or on its audioFile.
                    duration = absDouble(obj, "duration")
                        ?: absDouble(obj.optJSONObject("audioFile"), "duration")
                )
            } catch (t: Throwable) {
                null
            }
        }
    }
}

/** `GET /api/items/{id}?expanded=1` — everything the item + player screens need. */
data class ItemDetail(
    val id: String,
    val title: String,
    val authorName: String?,
    val mediaType: String,
    val duration: Double,
    val size: Long?,
    val chapters: List<Chapter>,
    val tracks: List<AudioTrack>,
    val episodes: List<PodcastEpisode>,
    val userProgressCurrentTime: Double?
) {
    companion object {
        fun fromJson(o: JSONObject?): ItemDetail? {
            val obj = o ?: return null
            return try {
                val id = absStr(obj, "id") ?: return null
                val media = obj.optJSONObject("media")
                val md = media?.optJSONObject("metadata")
                val mediaType = absStr(obj, "mediaType") ?: absStr(media, "mediaType") ?: "book"
                val tracks = parseTracks(id, media)
                val chapters = parseChapters(media?.optJSONArray("chapters"))
                ItemDetail(
                    id = id,
                    title = absStr(md, "title")
                        ?: if (mediaType == "podcast") "Podcast" else "Audiobook",
                    authorName = absStr(md, "authorName") ?: absStr(md, "author"),
                    mediaType = mediaType,
                    duration = deriveDuration(media, tracks, chapters),
                    size = absLong(obj, "size"),
                    chapters = chapters,
                    tracks = tracks,
                    episodes = parseEpisodes(media?.optJSONArray("episodes")),
                    userProgressCurrentTime =
                        absDouble(obj.optJSONObject("userMediaProgress"), "currentTime")
                )
            } catch (t: Throwable) {
                null
            }
        }
    }
}

/**
 * `POST /api/items/{id}/play[/{episodeId}]`. HLS transcode sessions have the
 * same shape as direct-play ones — only the tracks' contentUrls differ.
 */
data class PlaySession(
    val id: String,
    val libraryItemId: String,
    val episodeId: String?,
    val mediaType: String,
    val displayTitle: String,
    val displayAuthor: String?,
    val duration: Double,
    val currentTime: Double,
    val audioTracks: List<AudioTrack>,
    val chapters: List<Chapter>
) {
    companion object {
        fun fromJson(o: JSONObject?): PlaySession? {
            val obj = o ?: return null
            return try {
                val id = absStr(obj, "id") ?: return null
                val itemId = absStr(obj, "libraryItemId")
                    ?: absStr(obj.optJSONObject("libraryItem"), "id")
                    ?: return null
                val episodeId = absStr(obj, "episodeId")
                // Older/edge responses put the list under `tracks` — the phone
                // reads `session?.audioTracks || session?.tracks`, so do we.
                val trackArray = obj.optJSONArray("audioTracks")?.takeIf { it.length() > 0 }
                    ?: obj.optJSONArray("tracks")
                PlaySession(
                    id = id,
                    libraryItemId = itemId,
                    episodeId = episodeId,
                    mediaType = absStr(obj, "mediaType")
                        ?: if (episodeId != null) "podcast" else "book",
                    displayTitle = absStr(obj, "displayTitle") ?: "Audiobook",
                    displayAuthor = absStr(obj, "displayAuthor"),
                    duration = absDouble(obj, "duration") ?: 0.0,
                    currentTime = absDouble(obj, "currentTime") ?: 0.0,
                    audioTracks = parseTrackArray(itemId, trackArray),
                    chapters = parseChapters(obj.optJSONArray("chapters"))
                )
            } catch (t: Throwable) {
                null
            }
        }
    }
}

internal fun parseChapters(arr: JSONArray?): List<Chapter> {
    val a = arr ?: return emptyList()
    val out = ArrayList<Chapter>(a.length())
    for (i in 0 until a.length()) {
        Chapter.fromJson(a.optJSONObject(i), i)?.let { out.add(it) }
    }
    return out
}

internal fun parseEpisodes(arr: JSONArray?): List<PodcastEpisode> {
    val a = arr ?: return emptyList()
    val out = ArrayList<PodcastEpisode>(a.length())
    for (i in 0 until a.length()) {
        PodcastEpisode.fromJson(a.optJSONObject(i))?.let { out.add(it) }
    }
    return out
}

/**
 * `media.tracks` first, `media.audioFiles` second — the phone's fallback order
 * everywhere (deriveItemDuration, bookMatch.hasAudio, downloader). audioFiles
 * rows carry no startOffset, so offsets are accumulated from the durations,
 * which is exactly what the server's own track startOffsets are.
 */
internal fun parseTracks(itemId: String, media: JSONObject?): List<AudioTrack> {
    val m = media ?: return emptyList()
    val arr = m.optJSONArray("tracks")?.takeIf { it.length() > 0 }
        ?: m.optJSONArray("audioFiles")
    return parseTrackArray(itemId, arr)
}

internal fun parseTrackArray(itemId: String, arr: JSONArray?): List<AudioTrack> {
    val a = arr ?: return emptyList()
    val out = ArrayList<AudioTrack>(a.length())
    // Malformed metadata can REPEAT track.index — colliding filenames would let
    // one downloaded file overwrite another and both logical tracks resolve to
    // the same audio. Uniquify exactly like utils/downloader.ts does.
    val usedFilenames = HashSet<String>()
    var runningOffset = 0.0
    for (i in 0 until a.length()) {
        val track = AudioTrack.fromJson(a.optJSONObject(i), itemId, i, runningOffset) ?: continue
        runningOffset = track.startOffset + track.duration
        val resolved = if (usedFilenames.add(track.filename)) {
            track
        } else {
            val ext = track.filename.substringAfterLast('.', "mp3")
            val unique = "track_${track.index}_$i.$ext"
            usedFilenames.add(unique)
            track.copy(filename = unique)
        }
        out.add(resolved)
    }
    return out
}

/**
 * media.duration, else summed tracks, else the last chapter end — ported from
 * ChapterEditorScreen.deriveItemDuration. A book with no duration anywhere is
 * 0.0, which the UI renders as "unknown" rather than a bogus scrubber.
 */
internal fun deriveDuration(
    media: JSONObject?,
    tracks: List<AudioTrack>,
    chapters: List<Chapter>
): Double {
    absDouble(media, "duration")?.let { if (it > 0.0) return it }
    val fromTracks = tracks.sumOf { if (it.duration > 0.0) it.duration else 0.0 }
    if (fromTracks > 0.0) return fromTracks
    val lastEnd = chapters.maxOfOrNull { it.end } ?: 0.0
    return if (lastEnd > 0.0) lastEnd else 0.0
}
