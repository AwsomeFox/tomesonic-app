package com.tomesonic.app.automotive.data

import org.json.JSONArray
import org.json.JSONObject

// ABS response models + their org.json parsers. Ported from :wear, which ported
// them from the phone's native ABS client (the patched RNTP MusicService.kt) —
// same tolerance rules, because the same servers answer all three: every parser
// takes what it recognises, defaults what it doesn't, and returns null instead
// of throwing. A malformed row must cost one row, never a whole screen — and on
// a car screen "a whole screen" is the Media Center's only view of the library.

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

/**
 * Which device owns the session behind the stored credentials.
 *
 * ONE value, deliberately (ARCHITECTURE.md §3, §6). The watch has two — a
 * PHONE mirror arriving over the Wearable Data Layer and its own WATCH login —
 * and every rule that reads the marker there answers a question this module
 * cannot ask: there is no phone in a car, no Data Layer, and therefore exactly
 * one credential owner. What the watch decided by SOURCE (may a 401 be
 * refreshed? may a remote logout end this session?) the car decides by the only
 * fact left: whether a refresh token is stored (see [RefreshPolicy]).
 *
 * The type survives the collapse rather than being deleted because the contract
 * names it, [Creds] keeps its shape against the donor, and `abs_source` stays in
 * the key table — a second owner (a future companion-app handoff) would land
 * here rather than as a new field.
 */
enum class CredsSource { CAR }

/**
 * The ABS credentials in use. Never persisted anywhere but the car's DataStore.
 *
 * [refreshToken] is what makes a session renewable: a server with refresh
 * disabled answers a login without one, and that login's 401s are then terminal
 * (RefreshPolicy.onUnauthorized). Both fields default so a construction that
 * names neither still reads as "the car's own login, not renewable".
 */
data class Creds(
    val server: String,
    val token: String,
    val userId: String,
    val username: String,
    val source: CredsSource = CredsSource.CAR,
    val refreshToken: String? = null
)

/**
 * `last_item_id` + `last_episode_id` (+ display fields) as one value — the
 * resume target behind the Media Center's playback-resumption affordance
 * (ARCHITECTURE.md §8), which is the ONLY autoplay path this app has (MA-1).
 * Title/author are best-effort: the system asks for a resumable item before the
 * app has fetched anything, and every consumer must render without them.
 */
data class LastItem(
    val itemId: String,
    val episodeId: String?,
    val title: String? = null,
    val author: String? = null
)

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
 * One row of a browse list. Parses BOTH shapes the car asks for:
 * - a minified `/api/libraries/{id}/items` result, and
 * - an `/api/me/items-in-progress` libraryItem, which may carry `recentEpisode`
 *   (its `id` is the episodeId to play — same read as BookshelfScreen.tsx).
 *
 * `title` is always the ITEM's title, podcast rows included; the episode title
 * costs an extra expanded fetch and only the podcast folder needs it.
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
 * index) so Wave 3's on-disk download layout and its local MediaItems agree
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

/**
 * One podcast episode. The three download fields are optional and default to
 * absent, so a caller that only wants a row to play keeps constructing one.
 *
 * ABS puts an episode's audio in two places: `audioTrack` (the play-ready shape,
 * carrying a server-relative `contentUrl`) and `audioFile` (the scanned file,
 * carrying the `ino` and the byte size). utils/downloader.ts reads BOTH and
 * prefers the track's contentUrl; so does this. Neither present means the
 * episode has no downloadable audio — see DownloadWorker.episodeUrl (Wave 3).
 */
data class PodcastEpisode(
    val id: String,
    val title: String,
    val publishedAt: Long?,
    val duration: Double?,
    /** The audio file's inode id — the `/api/items/{itemId}/file/{ino}` fallback. */
    val ino: String? = null,
    /** Server-relative direct-play url when the server exposes one. */
    val contentUrl: String? = null,
    /** Bytes on the server, when its metadata records them; never 0. */
    val size: Long? = null
) {
    companion object {
        fun fromJson(o: JSONObject?): PodcastEpisode? {
            val obj = o ?: return null
            return try {
                val id = absStr(obj, "id") ?: return null
                val track = obj.optJSONObject("audioTrack")
                val file = obj.optJSONObject("audioFile")
                PodcastEpisode(
                    id = id,
                    title = absStr(obj, "title") ?: "Episode",
                    publishedAt = absLong(obj, "publishedAt"),
                    // Episodes carry the duration on the episode or on its audioFile.
                    duration = absDouble(obj, "duration")
                        ?: absDouble(file, "duration")
                        ?: absDouble(track, "duration"),
                    ino = absStr(file, "ino") ?: absStr(track, "ino") ?: absStr(obj, "ino"),
                    contentUrl = absStr(track, "contentUrl") ?: absStr(obj, "contentUrl"),
                    // A recorded 0 is "unknown", not "empty file" — the phone's
                    // `||` chain skips it the same way, and a 0 handed to the
                    // downloader as an expected length would fail every re-run.
                    size = listOf(
                        absLong(track?.optJSONObject("metadata"), "size"),
                        absLong(file?.optJSONObject("metadata"), "size"),
                        absLong(file, "size"),
                        absLong(file, "fileSize")
                    ).firstOrNull { it != null && it > 0L }
                )
            } catch (t: Throwable) {
                null
            }
        }
    }
}

/** `GET /api/items/{id}?expanded=1` — everything the browse tree and player need. */
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
 * 0.0, which renders as "unknown" rather than a bogus scrubber.
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
