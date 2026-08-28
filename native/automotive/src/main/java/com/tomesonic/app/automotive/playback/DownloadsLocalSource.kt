package com.tomesonic.app.automotive.playback

import android.net.Uri
import com.tomesonic.app.automotive.data.AudioTrack
import com.tomesonic.app.automotive.downloads.DownloadRepository
import java.io.File

/**
 * The ONE place playback knows the downloads package exists.
 *
 * Everything else in `playback/` speaks [LocalPlaybackSource] and [LocalBook],
 * which is what keeps the local-vs-stream resolution JVM-testable and keeps the
 * package compiling against nothing but its own types. Only this adapter
 * references `downloads.DownloadRepository`, and only through its frozen surface
 * (`entryForNow`, `localFile`, and the entry's documented fields) — nothing
 * about how the repository is built or persisted.
 *
 * Someone owning composition (Graph / MainApplication) installs it once:
 * ```
 * PlaybackWiring.localSource = DownloadsLocalSource(Graph.downloadRepository)
 * ```
 * Until then `PlaybackWiring.localSource` is null, which reads as "nothing is
 * downloaded" — playback streams and the module still builds and runs.
 */
class DownloadsLocalSource(private val repository: DownloadRepository) : LocalPlaybackSource {

    override fun localBook(itemId: String): LocalBook? = resolve(itemId, null)

    override fun localEpisode(itemId: String, episodeId: String): LocalBook? =
        resolve(itemId, episodeId)

    /**
     * One downloaded entry as playback's own type. A null [episodeId] asks for
     * the BOOK entry — the repository's frozen behaviour, unchanged.
     */
    private fun resolve(itemId: String, episodeId: String?): LocalBook? {
        val entry = try {
            // entryForNow, not entryFor: this is a plain function on the
            // playback resolution path and cannot suspend. It answers from the
            // in-memory index, which is why composition (MainApplication) MUST
            // call repository.warm() at startup — before the seed, this returns
            // null and a downloaded book would silently stream.
            repository.entryForNow(itemId, episodeId)
        } catch (e: Exception) {
            // The index is a file on disk; an unreadable one means "not
            // downloaded", never a failed play. Exception, not Throwable (a
            // deliberate divergence from the wear donor, per review): a VM
            // Error must fail the tap visibly, not quietly stream the book.
            null
        } ?: return null

        val tracks = ArrayList<AudioTrack>()
        entry.tracks.forEachIndexed { index, track ->
            val filename = track.filename.toString()
            // A missing file means the download is INCOMPLETE. Dropping the track
            // would shift every later chapter's offset, so the whole entry is
            // treated as absent and the item streams instead.
            val file = try {
                // Keyed by the ENTRY id, which IS the folder name: the item id
                // for a book (unchanged), the episode's own key otherwise.
                repository.localFile(entry.id, filename)
            } catch (e: Exception) {
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
            // The PODCAST's id, never the entry's: this is what the session, the
            // progress queues and the resumption target all key on.
            itemId = itemId,
            // What is PLAYING gets named — the episode when there is one. An
            // episode entry's `title` is the podcast's, which is what the
            // Downloads browse folder shows underneath it.
            title = (entry.episodeTitle?.takeIf { it.isNotBlank() } ?: entry.title).toString(),
            author = entry.author?.toString(),
            duration = entry.duration.toDouble(),
            coverUri = coverUri(entry.coverPath?.toString()),
            tracks = tracks
        )
    }

    /** The downloaded cover is a PATH; media3 wants a uri. */
    private fun coverUri(path: String?): String? {
        val raw = path?.takeIf { it.isNotBlank() } ?: return null
        // The writer stores bare paths; the schemed branches are defensive.
        // Either way a cover that is GONE answers null — media3 retrying a
        // dead file:// uri per queue item is the failure mode this avoids.
        if (raw.startsWith("file://")) {
            val file = try {
                File(Uri.parse(raw).path ?: return null)
            } catch (e: Exception) {
                return null
            }
            return if (file.exists()) raw else null
        }
        if (raw.startsWith("content://")) return raw
        val file = File(raw)
        return if (file.exists()) Uri.fromFile(file).toString() else null
    }
}
