package com.tomesonic.app.wear.playback

import android.net.Uri
import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.downloads.DownloadRepository
import java.io.File

/**
 * The ONE place playback knows the downloads package exists.
 *
 * Everything else in `playback/` speaks [LocalPlaybackSource] and [LocalBook],
 * which is what keeps the local-vs-stream resolution JVM-testable and keeps
 * this wave compiling against nothing but its own types. Only this adapter
 * references `downloads.DownloadRepository`, and only through the frozen
 * cross-wave surface (`entryFor`, `localFile`, and the entry's documented
 * fields) — nothing about how the repository is built or persisted.
 *
 * Someone owning composition (Graph / MainApplication) installs it once:
 * ```
 * PlaybackWiring.localSource = DownloadsLocalSource(<the DownloadRepository>)
 * ```
 * Until then `PlaybackWiring.localSource` is null, which reads as "nothing is
 * downloaded" — playback streams and the module still builds and runs.
 */
class DownloadsLocalSource(private val repository: DownloadRepository) : LocalPlaybackSource {

    override fun localBook(itemId: String): LocalBook? {
        val entry = try {
            // entryForNow, not entryFor: localBook is a plain function on the
            // playback resolution path and cannot suspend. It answers from the
            // in-memory index, which is why composition (MainApplication) MUST
            // call repository.warm() at startup — before the seed, this returns
            // null and a downloaded book would silently stream.
            repository.entryForNow(itemId)
        } catch (t: Throwable) {
            // The index is a file on disk; an unreadable one means "not
            // downloaded", never a failed play.
            null
        } ?: return null

        val tracks = ArrayList<AudioTrack>()
        entry.tracks.forEachIndexed { index, track ->
            val filename = track.filename.toString()
            // A missing file means the download is INCOMPLETE. Dropping the track
            // would shift every later chapter's offset, so the whole entry is
            // treated as absent and the item streams instead.
            val file = try {
                repository.localFile(itemId, filename)
            } catch (t: Throwable) {
                null
            } ?: return null
            if (!file.exists()) return null
            tracks.add(
                AudioTrack(
                    index = index,
                    startOffset = track.startOffset.toDouble(),
                    duration = track.duration.toDouble(),
                    title = filename,
                    contentUrl = Uri.fromFile(file).toString(),
                    mimeType = "",
                    filename = filename
                )
            )
        }
        if (tracks.isEmpty()) return null

        return LocalBook(
            itemId = itemId,
            title = entry.title.toString(),
            author = entry.author?.toString(),
            duration = entry.duration.toDouble(),
            coverUri = coverUri(entry.coverPath?.toString()),
            tracks = tracks
        )
    }

    /** The downloaded cover is a PATH; media3 and Coil both want a uri. */
    private fun coverUri(path: String?): String? {
        val raw = path?.takeIf { it.isNotBlank() } ?: return null
        if (raw.startsWith("file://") || raw.startsWith("content://")) return raw
        val file = File(raw)
        return if (file.exists()) Uri.fromFile(file).toString() else null
    }
}
