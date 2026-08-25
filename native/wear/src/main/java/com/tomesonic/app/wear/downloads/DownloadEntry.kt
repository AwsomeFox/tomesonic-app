package com.tomesonic.app.wear.downloads

import com.tomesonic.app.wear.data.absDouble
import com.tomesonic.app.wear.data.absFinite
import com.tomesonic.app.wear.data.absLong
import com.tomesonic.app.wear.data.absStr
import org.json.JSONArray
import org.json.JSONObject

// The on-disk record of one downloaded book: what `filesDir/downloads_index.json`
// holds, one object per entry. Deliberately the same shape as the phone's
// AutoDownloadEntry (utils/autoCreds.ts) — that file is read by the native
// Android Auto browse service to play downloads with JS asleep, which is exactly
// what this one does for Wave 3A's offline SessionManager.
//
// Parsing follows data/Models.kt's rules to the letter, and for the same reason:
// this file survives app upgrades, so a row written by an older build (or a
// half-written one from a kill) must cost that ROW, never the whole library.

/**
 * One playable file inside an entry. `filename` is the name the file actually
 * has under `filesDir/downloads/{itemId}/`, derived by [com.tomesonic.app.wear.data.AudioTrack]
 * — never re-derived here, so the index and the disk can't disagree.
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
 * One downloaded item. `bytes` is the item folder's whole on-disk footprint
 * (tracks + cover), which is what the downloads screen totals and what makes
 * eviction decisions honest.
 */
data class DownloadEntry(
    val id: String,
    val title: String,
    val author: String?,
    val duration: Double,
    val coverPath: String?,
    val tracks: List<DownloadTrack>,
    val bytes: Long
) {

    fun toJson(): JSONObject {
        val arr = JSONArray()
        tracks.forEach { arr.put(it.toJson()) }
        val o = JSONObject()
            .put("id", id)
            .put("title", title)
            .put("duration", absFinite(duration))
            .put("tracks", arr)
            .put("bytes", bytes)
        // Absent rather than JSON null: org.json's optString reads an explicit
        // null back as the STRING "null", so never write one.
        author?.let { o.put("author", it) }
        coverPath?.let { o.put("coverPath", it) }
        return o
    }

    companion object {
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
                    bytes = absLong(obj, "bytes") ?: 0L
                )
            } catch (t: Throwable) {
                null
            }
        }

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
