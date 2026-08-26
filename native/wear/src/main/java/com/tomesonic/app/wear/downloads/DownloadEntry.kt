package com.tomesonic.app.wear.downloads

import com.tomesonic.app.wear.data.absDouble
import com.tomesonic.app.wear.data.absFinite
import com.tomesonic.app.wear.data.absLong
import com.tomesonic.app.wear.data.absStr
import org.json.JSONArray
import org.json.JSONObject

// The on-disk record of one downloaded book or podcast episode: what
// `filesDir/downloads_index.json` holds, one object per entry. Deliberately the
// same shape as the phone's AutoDownloadEntry (utils/autoCreds.ts) — that file
// is read by the native Android Auto browse service to play downloads with JS
// asleep, which is exactly what this one does for Wave 3A's offline
// SessionManager.
//
// Parsing follows data/Models.kt's rules to the letter, and for the same reason:
// this file survives app upgrades, so a row written by an older build (or a
// half-written one from a kill) must cost that ROW, never the whole library.
//
// SCHEMA v2 adds `libraryItemId`/`episodeId`/`episodeTitle` and is READ-COMPATIBLE
// with v1 in both directions: `id` is still the unique entry (and folder) key, a
// book still has `id == libraryItemId`, and a v1 row — which carries neither new
// field — parses as exactly the book entry it always was.

/**
 * One playable file inside an entry. `filename` is the name the file actually
 * has under `filesDir/downloads/{entryId}/`, derived by [com.tomesonic.app.wear.data.AudioTrack]
 * for a book and by DownloadWorker.episodeFilename for an episode — never
 * re-derived here, so the index and the disk can't disagree.
 *
 * `contentUrl` is kept for a re-download after an eviction; playback never needs
 * it (the local file is the source) and it is optional for exactly that reason.
 */
data class DownloadTrack(
    val filename: String,
    val startOffset: Double,
    val duration: Double,
    val contentUrl: String?
) {

    fun toJson(): JSONObject {
        // absFinite: JSONObject.put THROWS on NaN/Infinity, and a duration
        // derived from bad server metadata can be either.
        val o = JSONObject()
            .put("filename", filename)
            .put("startOffset", absFinite(startOffset))
            .put("duration", absFinite(duration))
        contentUrl?.let { o.put("contentUrl", it) }
        return o
    }

    companion object {
        fun fromJson(o: JSONObject?): DownloadTrack? {
            val obj = o ?: return null
            return try {
                // No filename means no file on disk — the row is unplayable.
                val filename = absStr(obj, "filename") ?: return null
                DownloadTrack(
                    filename = filename,
                    startOffset = absDouble(obj, "startOffset") ?: 0.0,
                    duration = absDouble(obj, "duration") ?: 0.0,
                    contentUrl = absStr(obj, "contentUrl")
                )
            } catch (t: Throwable) {
                null
            }
        }
    }
}

/**
 * One downloaded entry — a book, or ONE podcast episode. `bytes` is that
 * entry's own folder's whole on-disk footprint (its tracks + its cover), which
 * is what the downloads screen totals and what makes eviction decisions honest.
 *
 * [id] is the unique entry key AND the folder name under `filesDir/downloads/`.
 * A book's is its library item id; an episode's is [entryId]'s composite. The
 * v2 fields exist so a row can be traced back to what it downloaded: an episode
 * entry's id is not an item id and must never be sent to the server as one.
 *
 * The three v2 fields carry defaults so `libraryItemId = id, episodeId = null`
 * — a BOOK — is what any caller that predates them keeps constructing.
 */
data class DownloadEntry(
    val id: String,
    val title: String,
    val author: String?,
    val duration: Double,
    val coverPath: String?,
    val tracks: List<DownloadTrack>,
    val bytes: Long,
    /** The ABS item this belongs to. Equals [id] for a book, always. */
    val libraryItemId: String = id,
    /** Null for a book; the podcast episode's id otherwise. */
    val episodeId: String? = null,
    /** The episode's own title — [title] stays the PODCAST's, for the list row. */
    val episodeTitle: String? = null
) {

    /**
     * Whether this entry IS the download of that item (or of that item's
     * episode). The id alone is very nearly enough, but an item id that
     * literally contains [EPISODE_MARKER] could collide with some podcast's
     * episode key — this makes "entryFor(itemId) returns the BOOK entry"
     * provable rather than probable. A v1 row answers exactly as a v2 one does:
     * it parses with `libraryItemId = id` and `episodeId = null`.
     */
    fun isFor(itemId: String, episodeId: String?): Boolean =
        libraryItemId == itemId && this.episodeId == episodeId?.takeIf { it.isNotBlank() }

    fun toJson(): JSONObject {
        val arr = JSONArray()
        tracks.forEach { arr.put(it.toJson()) }
        val o = JSONObject()
            .put("id", id)
            .put("title", title)
            .put("duration", absFinite(duration))
            .put("tracks", arr)
            .put("bytes", bytes)
            // Always written, even for a book where it repeats `id`: a reader
            // must never have to know which build wrote the row.
            .put("libraryItemId", libraryItemId)
        // Absent rather than JSON null: org.json's optString reads an explicit
        // null back as the STRING "null", so never write one.
        author?.let { o.put("author", it) }
        coverPath?.let { o.put("coverPath", it) }
        episodeId?.let { o.put("episodeId", it) }
        episodeTitle?.let { o.put("episodeTitle", it) }
        return o
    }

    companion object {

        /**
         * What separates an item id from its episode discriminator in an entry
         * id. Chosen out of the SAFE alphabet below so a sanitised id is still
         * a single plain path component.
         */
        const val EPISODE_MARKER = "-ep-"

        fun fromJson(o: JSONObject?): DownloadEntry? {
            val obj = o ?: return null
            return try {
                val id = absStr(obj, "id") ?: return null
                DownloadEntry(
                    id = id,
                    title = absStr(obj, "title") ?: "Audiobook",
                    author = absStr(obj, "author"),
                    duration = absDouble(obj, "duration") ?: 0.0,
                    coverPath = absStr(obj, "coverPath"),
                    tracks = tracksFrom(obj.optJSONArray("tracks")),
                    bytes = absLong(obj, "bytes") ?: 0L,
                    // The v1 back-compat rule, in one line: a row with no
                    // libraryItemId was written when every entry was a book, and
                    // a book's entry id IS its item id.
                    libraryItemId = absStr(obj, "libraryItemId") ?: id,
                    episodeId = absStr(obj, "episodeId"),
                    episodeTitle = absStr(obj, "episodeTitle")
                )
            } catch (t: Throwable) {
                null
            }
        }

        /**
         * The entry (and folder) key for one download. A book keeps `itemId`
         * unchanged — that is what makes every v1 row, every v1 folder and every
         * existing call site still resolve. An episode gets
         * `<itemId>-ep-<sanitised episodeId>`.
         */
        fun entryId(itemId: String, episodeId: String?): String {
            val episode = episodeId?.takeIf { it.isNotBlank() } ?: return itemId
            return "$itemId$EPISODE_MARKER${sanitizeSegment(episode)}"
        }

        /**
         * One path component the watch is willing to create: `[A-Za-z0-9._-]`
         * kept, everything else replaced by `_`. ABS episode ids are nanoids and
         * survive untouched; ids from an imported feed can be a whole URL.
         *
         * Replacement COLLIDES (`ep/1` and `ep:1` both flatten to `ep_1`), and
         * two episodes sharing a folder would overwrite each other's audio — so
         * a sanitised segment carries a short deterministic hash of the ORIGINAL
         * id. Only when sanitising actually changed something: an id that was
         * already safe keeps its exact name, which is what keeps the common case
         * readable on disk and stable across builds.
         */
        internal fun sanitizeSegment(raw: String): String {
            val cleaned = buildString(raw.length) {
                for (c in raw) append(if (isSegmentChar(c)) c else '_')
            }
            if (cleaned == raw) return cleaned
            return "$cleaned-${shortHash(raw)}"
        }

        private fun isSegmentChar(c: Char): Boolean =
            c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '.' || c == '_' || c == '-'

        /**
         * 8 hex digits of the string's own hash. `String.hashCode` is specified
         * by the JVM (s[0]*31^(n-1)+…), so this is stable across processes,
         * builds and devices — an entry id that changed between runs would
         * orphan a folder full of audio.
         */
        private fun shortHash(raw: String): String =
            (raw.hashCode().toLong() and 0xffffffffL).toString(16).padStart(8, '0')

        fun toJsonArray(entries: List<DownloadEntry>): JSONArray {
            val arr = JSONArray()
            entries.forEach { arr.put(it.toJson()) }
            return arr
        }

        fun fromJsonArray(arr: JSONArray?): List<DownloadEntry> {
            val a = arr ?: return emptyList()
            val out = ArrayList<DownloadEntry>(a.length())
            for (i in 0 until a.length()) {
                fromJson(a.optJSONObject(i))?.let { out.add(it) }
            }
            return out
        }

        /**
         * The whole index file's text -> entries, or NULL when the text isn't a
         * JSON array at all. That distinction is the quarantine signal
         * [DownloadIndex] acts on: an unreadable file is moved aside, whereas a
         * readable file holding one bad ROW just loses that row.
         */
        fun parseList(raw: String?): List<DownloadEntry>? {
            val text = raw?.takeIf { it.isNotBlank() } ?: return null
            return try {
                fromJsonArray(JSONArray(text))
            } catch (t: Throwable) {
                null
            }
        }

        private fun tracksFrom(arr: JSONArray?): List<DownloadTrack> {
            val a = arr ?: return emptyList()
            val out = ArrayList<DownloadTrack>(a.length())
            for (i in 0 until a.length()) {
                DownloadTrack.fromJson(a.optJSONObject(i))?.let { out.add(it) }
            }
            return out
        }
    }
}
