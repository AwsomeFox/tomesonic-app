package com.tomesonic.app.automotive.downloads

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.tomesonic.app.automotive.Graph
import com.tomesonic.app.automotive.data.AudioTrack
import com.tomesonic.app.automotive.data.ItemDetail
import com.tomesonic.app.automotive.data.PodcastEpisode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * One ENTRY's download — a whole book, or one podcast episode — as a
 * WorkManager job.
 *
 * WorkManager rather than a foreground service of our own because the whole
 * point of an offline download is that it survives the app being closed and
 * waits for its constraint — constraints, retries and reboot persistence are
 * what this library exists for, and a car is switched off mid-transfer as a
 * matter of routine. One unique job per ENTRY ([uniqueWorkName] over
 * [DownloadEntry.entryId]) so a double tap can't run two copies over the same
 * folder, while a book and two of its episodes coexist as three jobs.
 *
 * FOLDER OWNERSHIP: an entry owns `filesDir/downloads/{entryId}/` entirely and
 * nothing outside it — its audio AND its own `cover.jpg`. An episode therefore
 * fetches the podcast's cover a second time into its own folder rather than
 * pointing at the book entry's copy. That makes every delete one recursive
 * folder delete that can never take another entry's artwork with it; sharing
 * one file across entries would need a refcount, and a cover at width 240 is
 * a few KB.
 *
 * The transfer discipline is ported whole from `utils/downloader.ts`: stream to
 * a `.part` file, verify the length the server promised, and only then rename
 * into place. A file therefore only ever HAS its final name once it is complete,
 * which is what makes a re-run a resume — finished tracks are skipped and just
 * the missing ones are fetched.
 */
class DownloadWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    private val itemId: String get() = inputData.getString(KEY_ITEM_ID).orEmpty()

    /** Blank is absent: a book job may carry the key with nothing in it. */
    private val episodeId: String?
        get() = inputData.getString(KEY_EPISODE_ID)?.takeIf { it.isNotBlank() }

    /** The folder name, the index key and the notification id. `itemId` for a book. */
    private val entryId: String get() = DownloadEntry.entryId(itemId, episodeId)

    // Filled in once the expanded item lands, so the notification stops saying
    // "Downloading" and starts naming the book (or the episode).
    @Volatile
    private var itemTitle: String? = null

    private var lastProgress = -1
    private var lastProgressAt = 0L

    override suspend fun doWork(): Result {
        val id = itemId.takeIf { isSafeName(it) } ?: return Result.failure()
        val episode = episodeId
        // Both halves are checked: the item id is server-supplied and so is the
        // episode id it was composed with (sanitised, but a composed name still
        // has to be a plain component before anything creates it).
        val key = entryId.takeIf { isSafeName(it) } ?: return Result.failure()
        // Defensive, per Graph's own contract: WorkManager can start this in a
        // process where nothing else has run yet. Idempotent.
        Graph.init(applicationContext)
        val repository = Graph.downloadRepository
        val dir = repository.itemDir(key)

        try {
            report(id, 0)
            pushForeground()

            // Null covers offline, no credentials yet, a 401 and a 404 alike —
            // AbsApi deliberately reports none of them apart. Retrying a small
            // number of times turns the common one (a car that drove out of
            // Wi-Fi range) into a delay instead of a failure.
            val item = Graph.absApi.itemExpanded(id) ?: return retryOrFail(dir)
            val episodeRow = episode?.let { wanted ->
                // The fetch SUCCEEDED and the episode isn't in it: the feed
                // dropped it (or the id was stale). Asking again gets the same
                // answer, so this is terminal rather than a retry.
                item.episodes.firstOrNull { it.id == wanted } ?: return failAndClean(dir)
            }
            itemTitle = episodeRow?.title ?: item.title
            pushForeground()

            val coverUrl = Graph.absApi.coverUrl(id)
            val plan = if (episodeRow == null) {
                buildPlan(item, dir, coverUrl)
            } else {
                buildEpisodePlan(id, episodeRow, dir, coverUrl)
            }
            // No usable audio: a podcast asked for as a book, or metadata with
            // no contentUrl and no ino. Retrying would not change the answer.
            if (plan == null) return failAndClean(dir)

            withContext(Dispatchers.IO) { dir.mkdirs() }

            // Cover first and best-effort — a book with no artwork is still a
            // perfectly good download, and the offline browse row falls back to
            // a placeholder exactly like the online one does.
            val coverFile = plan.cover?.let { cover ->
                if (alreadyComplete(cover)) return@let cover.target
                try {
                    fetch(cover) { _, _ -> }
                    cover.target
                } catch (ce: CancellationException) {
                    throw ce
                } catch (t: Throwable) {
                    cover.partFile.delete()
                    null
                }
            }

            val total = plan.tracks.size
            plan.tracks.forEachIndexed { index, planned ->
                // Resume-by-rerun: a file that already carries its FINAL name
                // passed a previous run's length check, so this attempt only
                // fetches what is actually missing.
                if (!alreadyComplete(planned.download)) {
                    fetch(planned.download) { written, expected ->
                        report(id, trackProgress(index, total, written, expected))
                    }
                }
                report(id, trackProgress(index + 1, total, 0L, 0L))
            }

            val entry = DownloadEntry(
                // The REQUESTED id, not the one the response echoed: this is the
                // folder that was just written and the key every lookup uses, and
                // the two must not be able to disagree.
                id = key,
                // The ITEM's title even for an episode — the downloads row shows
                // the episode title first and this one under it, and an offline
                // podcast folder has nothing else to call the show.
                title = item.title,
                author = item.authorName,
                duration = if (episodeRow != null) (episodeRow.duration ?: 0.0) else item.duration,
                coverPath = coverFile?.takeIf { it.isFile }?.absolutePath,
                tracks = plan.tracks.map {
                    DownloadTrack(
                        filename = it.track.filename,
                        startOffset = it.track.startOffset,
                        duration = it.track.duration,
                        contentUrl = it.track.contentUrl
                    )
                },
                bytes = withContext(Dispatchers.IO) { bytesOnDisk(dir) },
                libraryItemId = id,
                episodeId = episodeRow?.id,
                episodeTitle = episodeRow?.title
            )
            // The index entry is written LAST and only on success: its presence
            // is what "this is on the head unit" means to everything else.
            repository.index.upsert(entry)
            report(id, 100)
            return Result.success()
        } catch (ce: CancellationException) {
            // Cancelled by the user, or stopped because a constraint lapsed (off
            // unmetered Wi-Fi). Drop the half-written .part files but KEEP whole
            // tracks — re-enqueueing then resumes from here instead of
            // re-downloading a gigabyte. Plain unlink() calls, so they still run
            // in an already-cancelled coroutine; nothing here suspends.
            deletePartials(dir)
            throw ce
        } catch (t: Throwable) {
            return retryOrFail(dir)
        }
    }

    /**
     * The notification WorkManager shows while this job holds a foreground
     * service. Overridden (rather than only built at [pushForeground]) because
     * WorkManager asks for it itself whenever it promotes the job.
     */
    override suspend fun getForegroundInfo(): ForegroundInfo =
        // Keyed by the ENTRY, so a book and one of its episodes downloading at
        // once own two notifications instead of overwriting one.
        foregroundInfo(applicationContext, entryId, itemTitle, lastProgress)

    /**
     * Never fatal. POST_NOTIFICATIONS is a runtime permission the user can
     * refuse, a background process can be barred from starting a foreground
     * service outright, and on API 34+ the platform rejects the promotion unless
     * WorkManager's own SystemForegroundService declares the dataSync type in
     * the MERGED manifest (the car manifest does not declare it yet — see the
     * Wave-3B handoff note). In every one of those cases the bytes still want to
     * be fetched — the job simply runs as an ordinary background worker.
     */
    private suspend fun pushForeground() {
        try {
            setForeground(getForegroundInfo())
        } catch (ce: CancellationException) {
            throw ce
        } catch (t: Throwable) {
        }
    }

    private suspend fun report(id: String, percent: Int) {
        val clamped = percent.coerceIn(0, 100)
        if (clamped == lastProgress) return
        val now = System.currentTimeMillis()
        // Every setProgress is a WorkManager database write. Throttle the middle
        // of a transfer; never throttle the ends, which the UI acts on.
        if (clamped != 0 && clamped != 100 && now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return
        lastProgress = clamped
        lastProgressAt = now
        try {
            setProgress(workDataOf(KEY_PROGRESS to clamped, KEY_ITEM_ID to id))
        } catch (ce: CancellationException) {
            throw ce
        } catch (t: Throwable) {
            // A stopped worker rejects progress writes; the transfer itself is
            // unaffected and the next state change tells the UI what happened.
        }
    }

    private suspend fun alreadyComplete(plan: PlannedDownload): Boolean =
        withContext(Dispatchers.IO) { isComplete(plan.target.length(), plan.expectedBytes) }

    /**
     * Streams one planned file to `<target>.part`, verifies the promised length
     * and renames it into place. [onBytes] receives (written, expected) with
     * expected <= 0 when the server sent no Content-Length.
     */
    private suspend fun fetch(plan: PlannedDownload, onBytes: suspend (Long, Long) -> Unit) {
        val client = Graph.absClient
        val url = client.resolve(plan.url) ?: throw IOException("the car is not configured")
        withContext(Dispatchers.IO) {
            val part = plan.partFile
            part.parentFile?.mkdirs()
            // v1 has no HTTP Range resume (neither does the phone downloader), so
            // a leftover .part is a previous attempt's garbage, not a checkpoint.
            part.delete()
            client.client.newCall(client.authorizedRequest(url)).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IOException("HTTP ${response.code} for ${plan.target.name}")
                }
                val body = response.body ?: throw IOException("no body for ${plan.target.name}")
                val expected = body.contentLength()
                var written = 0L
                body.byteStream().use { input ->
                    FileOutputStream(part).use { output ->
                        val buffer = ByteArray(BUFFER_BYTES)
                        while (true) {
                            // The only cancellation check that matters: a track
                            // can be hundreds of MB and the read loop is where
                            // all of that time is spent.
                            ensureActive()
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            written += read
                            onBytes(written, expected)
                        }
                        output.flush()
                        // fsync before the rename: the rename is what declares
                        // this file complete, and a power loss between them would
                        // otherwise leave a full-length file with unwritten tail
                        // blocks that plays as silence.
                        try {
                            output.fd.sync()
                        } catch (t: Throwable) {
                        }
                    }
                }
                // Only when the server told us what to expect — ABS behind a
                // gzipping proxy sends no length for a streamed file.
                if (expected > 0L && written != expected) {
                    part.delete()
                    throw IOException("short read for ${plan.target.name}: $written of $expected")
                }
            }
            if (!part.renameTo(plan.target)) {
                plan.target.delete()
                if (!part.renameTo(plan.target)) {
                    part.delete()
                    throw IOException("could not finalise ${plan.target.name}")
                }
            }
        }
    }

    /**
     * A small retry cap, then give up. The retry is what covers a car that drove
     * off Wi-Fi mid-book; past that the failure is real (a deleted item, an
     * expired token) and hammering it costs nothing useful.
     */
    private fun retryOrFail(dir: File): Result {
        deletePartials(dir)
        if (runAttemptCount < MAX_ATTEMPTS - 1) return Result.retry()
        return failAndClean(dir)
    }

    /**
     * Terminal failure. Partial files go; whole tracks stay so a manual retry
     * resumes from them, and the folder itself goes only when nothing landed in
     * it (delete() on a non-empty directory is a no-op, which is exactly right).
     */
    private fun failAndClean(dir: File): Result {
        deletePartials(dir)
        dir.delete()
        return Result.failure()
    }

    companion object {

        const val KEY_ITEM_ID = "itemId"

        /** Absent (or blank) means "the book" — the v1 job, unchanged. */
        const val KEY_EPISODE_ID = "episodeId"

        const val KEY_PROGRESS = "progress"

        /** Low importance: a progress bar must never chime at a driver. */
        const val CHANNEL_ID = "downloads"
        const val CHANNEL_NAME = "Downloads"

        const val COVER_FILENAME = "cover.jpg"
        const val PART_SUFFIX = ".part"

        /** Three tries total (runAttemptCount 0, 1, 2) on WorkManager's default backoff. */
        const val MAX_ATTEMPTS = 3

        private const val BUFFER_BYTES = 32 * 1024
        private const val PROGRESS_MIN_INTERVAL_MS = 750L
        private const val NOTIFICATION_ID_BASE = 4200

        /**
         * One job per ENTRY — a double tap enqueues the same name and KEEPs the
         * first. Take [entryId] from [DownloadEntry.entryId], which is the item
         * id itself for a book (so v1 job names are unchanged) and carries the
         * episode discriminator otherwise.
         */
        fun uniqueWorkName(entryId: String): String = "download_$entryId"

        /**
         * A single path component we are willing to create under filesDir. Track
         * filenames carry a server-supplied extension (`metadata.ext`) and item
         * ids are server-supplied too; one containing a separator would let a
         * download write outside its own folder.
         */
        fun isSafeName(name: String): Boolean =
            name.isNotBlank() &&
                name != "." &&
                name != ".." &&
                !name.contains('/') &&
                !name.contains('\\') &&
                !name.contains('\u0000')

        /** [dir]/[name], or null when [name] isn't a plain component of [dir]. */
        fun resolveInside(dir: File, name: String): File? =
            if (isSafeName(name)) File(dir, name) else null

        /**
         * Everything one download needs, derived purely from the expanded item —
         * no Context, no clock, no network, so the URL and path decisions are
         * pinned by tests rather than by a server round trip.
         *
         * Null when the item has nothing downloadable: no tracks at all (a
         * podcast, whose audio lives on its episodes — see [buildEpisodePlan]),
         * a row whose url resolves to the empty-ino `/file/` endpoint, or a
         * filename that would escape [dir].
         */
        fun buildPlan(item: ItemDetail, dir: File, coverUrl: String?): DownloadPlan? {
            if (item.tracks.isEmpty()) return null
            val tracks = ArrayList<PlannedTrack>(item.tracks.size)
            for (track in item.tracks) {
                if (!isUsableUrl(track.contentUrl)) return null
                val target = resolveInside(dir, track.filename) ?: return null
                tracks.add(PlannedTrack(track, PlannedDownload(track.contentUrl, target)))
            }
            // The cover is fetched through the same authorized client as
            // everything else, so AbsApi's url is right — including its query
            // token, which this client would have supplied a header for anyway.
            val cover = coverUrl
                ?.takeIf { it.isNotBlank() }
                ?.let { PlannedDownload(it, File(dir, COVER_FILENAME)) }
            return DownloadPlan(item.id, dir, cover, tracks)
        }

        /**
         * ONE episode's download: its single audio file, plus the podcast cover
         * into the EPISODE's own folder (see the class comment's ownership rule).
         *
         * Null for an episode with no downloadable audio — the same bail the
         * phone's downloadEpisode makes, and for the same reason.
         */
        fun buildEpisodePlan(
            itemId: String,
            episode: PodcastEpisode,
            dir: File,
            coverUrl: String?
        ): DownloadPlan? {
            val url = episodeUrl(itemId, episode) ?: return null
            val filename = episodeFilename(url)
            val target = resolveInside(dir, filename) ?: return null
            val track = AudioTrack(
                index = 0,
                startOffset = 0.0,
                duration = episode.duration ?: 0.0,
                title = episode.title,
                contentUrl = url,
                // Left empty exactly like DownloadsLocalSource does for a played
                // file: media3 sniffs the container, and a guessed mime type is
                // the one that can be WRONG.
                mimeType = "",
                filename = filename
            )
            val cover = coverUrl
                ?.takeIf { it.isNotBlank() }
                ?.let { PlannedDownload(it, File(dir, COVER_FILENAME)) }
            return DownloadPlan(
                itemId,
                dir,
                cover,
                listOf(PlannedTrack(track, PlannedDownload(url, target, episode.size ?: 0L)))
            )
        }

        /**
         * The episode's file url in utils/downloader.ts's order: the direct-play
         * contentUrl the server exposes on the audioTrack, else the ino file
         * endpoint. Null when the episode carries neither — the fallback would
         * then be `/api/items/{id}/file/` with no ino at all.
         */
        fun episodeUrl(itemId: String, episode: PodcastEpisode): String? {
            episode.contentUrl?.takeIf { isUsableUrl(it) }?.let { return it }
            val ino = episode.ino?.takeIf { it.isNotBlank() } ?: return null
            return "/api/items/$itemId/file/$ino"
        }

        /**
         * `track_0.<ext>`. One audio file per episode entry, in a folder of its
         * own, so the name only has to be STABLE (a re-run must recognise it),
         * never unique across items — which is why this doesn't need the phone's
         * collision uniquifier.
         *
         * The extension is read off the url's own last segment when it carries a
         * plausible one and is `mp3` otherwise: ABS's `/file/{ino}` endpoint
         * names no format, and nothing downstream depends on the guess (media3
         * sniffs the container, and the ext is not part of any lookup key).
         */
        fun episodeFilename(url: String?): String = "track_0.${episodeExt(url)}"

        private fun episodeExt(url: String?): String {
            val path = url?.substringBefore('?')?.substringBefore('#').orEmpty()
            val ext = path.substringAfterLast('/').substringAfterLast('.', "")
            // Letters and digits only, so a mangled url can never contribute a
            // path separator to a filename.
            return if (ext.length in 1..5 && ext.all { it.isLetterOrDigit() }) {
                ext.lowercase()
            } else {
                "mp3"
            }
        }

        /**
         * `/api/items/{id}/file/` with no ino is what Models.kt synthesises for a
         * row carrying neither a contentUrl nor an ino — the phone's
         * downloadEpisode rejects exactly this shape, for the same reason: it
         * would 404 an endpoint that looks valid.
         */
        fun isUsableUrl(url: String): Boolean = url.isNotBlank() && !url.endsWith("/file/")

        /**
         * Whether an already-present target counts as finished. Bytes only get
         * the final name after their stream completed AND matched the server's
         * Content-Length, so any non-empty target is complete by construction —
         * which is what makes a re-run a resume. [expectedBytes] is honoured when
         * a caller does know the size: 0 for a book's tracks (ABS's expanded item
         * carries a whole-item `size`, never a per-track one), the episode's own
         * recorded size for an episode. A size the server later disagrees with
         * costs one re-fetch on a re-run, never a wrong file — the transfer's own
         * check is still Content-Length.
         */
        fun isComplete(existingBytes: Long, expectedBytes: Long = 0L): Boolean =
            existingBytes > 0L && (expectedBytes <= 0L || existingBytes == expectedBytes)

        /** 0..100 across the whole book: whole tracks plus the fraction of the current one. */
        fun trackProgress(completedTracks: Int, totalTracks: Int, written: Long, expected: Long): Int {
            if (totalTracks <= 0) return 0
            val done = completedTracks.coerceIn(0, totalTracks)
            val fraction = if (expected > 0L && written in 0L..expected) {
                written.toDouble() / expected.toDouble()
            } else {
                0.0
            }
            val whole = if (done >= totalTracks) 1.0 else (done + fraction) / totalTracks
            return (whole * 100.0).toInt().coerceIn(0, 100)
        }

        /**
         * On-disk footprint of one item's folder. `.part` files are excluded:
         * they aren't content yet and counting them would let a failed attempt
         * inflate the size the settings screen reports.
         */
        fun bytesOnDisk(dir: File): Long {
            val files = dir.listFiles() ?: return 0L
            var total = 0L
            for (f in files) {
                total += when {
                    f.isDirectory -> bytesOnDisk(f)
                    f.name.endsWith(PART_SUFFIX) -> 0L
                    else -> f.length()
                }
            }
            return total
        }

        /** Removes half-written files, leaving completed ones. Returns how many went. */
        fun deletePartials(dir: File): Int {
            val files = dir.listFiles() ?: return 0
            var removed = 0
            for (f in files) {
                if (f.isFile && f.name.endsWith(PART_SUFFIX) && f.delete()) removed++
            }
            return removed
        }

        fun notificationTitle(itemTitle: String?): String =
            if (itemTitle.isNullOrBlank()) "Downloading" else "Downloading $itemTitle"

        /**
         * Distinct per ENTRY so two queued downloads don't overwrite each
         * other's notification, and never 0 (which the platform rejects).
         */
        fun notificationId(entryId: String): Int =
            NOTIFICATION_ID_BASE + (entryId.hashCode() and 0xffff)

        /**
         * Created HERE rather than in MainApplication: this is the only component
         * that posts on it, WorkManager can start it in a process where the
         * Application's channel setup has not been reached, and re-creating an
         * existing channel is a no-op the platform explicitly supports.
         */
        fun ensureChannel(context: Context) {
            try {
                val manager = context.getSystemService(NotificationManager::class.java) ?: return
                manager.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        CHANNEL_NAME,
                        NotificationManager.IMPORTANCE_LOW
                    ).apply { setShowBadge(false) }
                )
            } catch (t: Throwable) {
                // A channel we couldn't create means a notification that won't
                // show — the download itself doesn't care.
            }
        }

        fun foregroundInfo(
            context: Context,
            entryId: String,
            itemTitle: String?,
            progress: Int
        ): ForegroundInfo {
            ensureChannel(context)
            val notification = Notification.Builder(context, CHANNEL_ID)
                .setContentTitle(notificationTitle(itemTitle))
                // A platform drawable: this module ships no notification icon of
                // its own, and a missing small icon throws at post time.
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                // Kept from the donor: a transfer notification has no business
                // bridging to a paired device. On a head unit there is nothing to
                // bridge to, so this is inert — and inert beats divergent.
                .setLocalOnly(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setProgress(100, progress.coerceIn(0, 100), progress < 0)
                .build()
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // API 34+ requires the type at startForeground time. It ALSO
                // requires WorkManager's SystemForegroundService to declare
                // dataSync in the merged manifest — see pushForeground for what
                // happens when it doesn't.
                ForegroundInfo(
                    notificationId(entryId),
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                ForegroundInfo(notificationId(entryId), notification)
            }
        }
    }
}

/** One file the worker fetches: what to GET, where it lands, how big it should be. */
data class PlannedDownload(
    /** Server-relative path or absolute url — resolved through AbsClient. */
    val url: String,
    /** Final destination. Bytes stream to [partFile] and are renamed here. */
    val target: File,
    /** Size the caller already knows; 0 when unknown (see [DownloadWorker.isComplete]). */
    val expectedBytes: Long = 0L
) {
    val partFile: File get() = File(target.path + DownloadWorker.PART_SUFFIX)
}

/** A [PlannedDownload] plus the track metadata the finished index entry needs. */
data class PlannedTrack(
    val track: AudioTrack,
    val download: PlannedDownload
)

/** Everything one item's download needs, derived purely from its expanded detail. */
data class DownloadPlan(
    val itemId: String,
    val dir: File,
    val cover: PlannedDownload?,
    val tracks: List<PlannedTrack>
)
