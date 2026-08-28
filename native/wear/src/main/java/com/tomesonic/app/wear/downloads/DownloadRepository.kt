package com.tomesonic.app.wear.downloads

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext
import java.io.File

/**
 * What the UI can say about one entry — a book or one episode. Additive to the
 * frozen cross-wave interface — Wave 4A renders it, nothing else depends on it.
 */
sealed class DownloadStatus {
    data object NotDownloaded : DownloadStatus()

    /** Enqueued and waiting on its constraints (the charger, unmetered WiFi). */
    data object Queued : DownloadStatus()

    /** 0..100 across the whole book, as the worker reports it. */
    data class Downloading(val progress: Int) : DownloadStatus()

    data object Downloaded : DownloadStatus()
    data object Failed : DownloadStatus()
}

/**
 * The downloads API every other wave talks to: the frozen surface from
 * native/wear/ARCHITECTURE.md ("Cross-wave interfaces") plus [status] and
 * [cancel], which are additive.
 *
 * It owns two things and nothing else — the [index] (what is downloaded) and the
 * folder tree under [root] (the bytes). The transfer itself belongs to
 * [DownloadWorker]; this class only enqueues, cancels and cleans up, which is
 * what keeps it callable from a UI thread's coroutine.
 *
 * Every method that names an item takes an OPTIONAL episode id beside it, and
 * the pair resolves to one [DownloadEntry.entryId] — the index key, the folder
 * name, the unique work name and the notification id, all the same string. The
 * single-argument v1 signatures delegate with a null episode, so they keep
 * meaning exactly "the book" and nothing else.
 *
 * Constructed with its collaborators so tests can point it at a temp dir;
 * production goes through [create] behind Graph's lazy singleton — same shape as
 * CredsRepository.
 */
class DownloadRepository(
    private val context: Context,
    /** Public for [DownloadWorker], which writes the finished entry. */
    val index: DownloadIndex,
    /** `filesDir/downloads` — one subfolder per ENTRY id (see [DownloadEntry.entryId]). */
    val root: File
) {

    /** Frozen: the downloaded library, cold until someone collects it. */
    val entries: Flow<List<DownloadEntry>> = index.entries

    /** Frozen: the BOOK entry, or null when the item isn't downloaded. */
    suspend fun entryFor(itemId: String): DownloadEntry? = entryFor(itemId, null)

    /**
     * Additive: one entry by what it downloaded. A null (or blank) [episodeId]
     * asks for the item's BOOK entry — the frozen behaviour above, which a
     * downloaded episode of the same item must never satisfy.
     */
    suspend fun entryFor(itemId: String, episodeId: String?): DownloadEntry? =
        index.get(DownloadEntry.entryId(itemId, episodeId))?.takeIf { it.isFor(itemId, episodeId) }

    /**
     * Additive: read the index into memory once, so [entryForNow] can answer
     * without suspending. Cheap and idempotent — call it at startup.
     */
    suspend fun warm() {
        index.warm()
    }

    /**
     * Additive, non-suspending sibling of [entryFor]. Wave 3A's
     * `LocalPlaybackSource.localBook(itemId)` is a plain function, and a
     * downloaded book must resolve there without a round trip to a coroutine.
     *
     * Returns null before the index has been warmed, which reads as "not
     * downloaded" and would silently stream a book that is on the watch — so
     * [warm] belongs in the same startup path that installs the plug.
     */
    fun entryForNow(itemId: String): DownloadEntry? = entryForNow(itemId, null)

    /** Additive: [entryForNow] for one episode. Same non-suspending contract. */
    fun entryForNow(itemId: String, episodeId: String?): DownloadEntry? {
        val key = DownloadEntry.entryId(itemId, episodeId)
        return index.snapshot().firstOrNull { it.id == key && it.isFor(itemId, episodeId) }
    }

    /**
     * Frozen: the local file for a track (or the cover), or null when it isn't
     * there. Keyed by the ENTRY id, which IS the folder name — for a book that
     * is the item id, exactly as before. Deliberately NOT suspending — Wave 3A
     * resolves these while building media3 items on a callback thread that
     * cannot suspend, and the cost is one stat() per track.
     */
    fun localFile(entryId: String, filename: String): File? {
        val dir = DownloadWorker.resolveInside(root, entryId) ?: return null
        val file = DownloadWorker.resolveInside(dir, filename) ?: return null
        return file.takeIf { it.isFile && it.length() > 0L }
    }

    /** `filesDir/downloads/{entryId}` — the contract's layout, created by the worker. */
    fun itemDir(entryId: String): File = File(root, entryId)

    /**
     * Frozen: queue [itemId] for download.
     *
     * Default constraints are the ones WEAR_OS.md argues for: **unmetered
     * network + on the charger**. A watch pulling a gigabyte over a BT-proxied
     * link on battery is slow, hot and pointless.
     *
     * [force] is "download it now": the charging requirement goes, and the
     * network requirement relaxes to CONNECTED rather than disappearing — an LTE
     * watch with no WiFi is precisely who needs to force, and a download with no
     * network constraint at all would just fail instead of waiting.
     *
     * Non-forced enqueues KEEP an existing job (a double tap must not restart a
     * transfer). A forced one REPLACEs it, because the whole point is to drop
     * constraints the queued job still carries — keeping it would silently do
     * nothing. A replaced worker's cancellation cleans its own `.part` files and
     * the new run resumes from the whole tracks.
     */
    suspend fun enqueue(itemId: String, force: Boolean = false) = enqueue(itemId, null, force)

    /**
     * Additive: [enqueue] for ONE podcast episode (a null [episodeId] is the
     * book above). Constraints, force semantics and the KEEP/REPLACE policy are
     * identical — the only difference is the unique work name, which carries the
     * episode discriminator so a podcast's book job and two of its episodes'
     * jobs are three jobs rather than one that keeps replacing itself.
     */
    suspend fun enqueue(itemId: String, episodeId: String?, force: Boolean = false): Boolean {
        // Reports whether a request actually reached WorkManager — every
        // failure here is SILENT by design (never throw into a tap handler),
        // and a caller keeping "requested" UI state needs the difference
        // between "queued" and "quietly refused" or that state sticks forever.
        if (!DownloadWorker.isSafeName(itemId)) return false
        val entryId = DownloadEntry.entryId(itemId, episodeId)
        if (!DownloadWorker.isSafeName(entryId)) return false
        val episode = episodeId?.takeIf { it.isNotBlank() }
        val input = if (episode == null) {
            workDataOf(DownloadWorker.KEY_ITEM_ID to itemId)
        } else {
            workDataOf(
                DownloadWorker.KEY_ITEM_ID to itemId,
                DownloadWorker.KEY_EPISODE_ID to episode
            )
        }
        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setInputData(input)
            .setConstraints(constraints(force))
            .addTag(TAG_ALL)
            .addTag(itemTag(entryId))
            .build()
        val policy = if (force) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
        return withContext(Dispatchers.IO) {
            try {
                workManager().enqueueUniqueWork(
                    DownloadWorker.uniqueWorkName(entryId),
                    policy,
                    request
                )
                true
            } catch (t: Throwable) {
                // WorkManager unavailable (an uninitialised process). Nothing to
                // roll back — no bytes and no index entry exist yet.
                false
            }
        }
    }

    /**
     * Stop an in-flight or queued download without touching what it already
     * fetched. The worker cleans its own partials when it observes the
     * cancellation; this sweep covers the job that never started, or one the
     * system killed before it could.
     */
    suspend fun cancel(itemId: String) = cancel(itemId, null)

    /** Additive: [cancel] for one episode's job and its own folder. */
    suspend fun cancel(itemId: String, episodeId: String?) {
        if (!DownloadWorker.isSafeName(itemId)) return
        val entryId = DownloadEntry.entryId(itemId, episodeId)
        if (!DownloadWorker.isSafeName(entryId)) return
        cancelWork(entryId)
        withContext(Dispatchers.IO) { DownloadWorker.deletePartials(itemDir(entryId)) }
    }

    /**
     * Frozen: forget the BOOK entirely — cancel its job, delete its folder, drop
     * its index entry. The order matters: cancelling first stops a running
     * worker from re-creating files behind the delete, and the index entry goes
     * last so a crash mid-delete leaves an entry pointing at missing files
     * (which [localFile] reports as absent) rather than files nothing owns.
     */
    suspend fun delete(itemId: String) = delete(itemId, null)

    /**
     * Additive: [delete] for one entry. A null [episodeId] deletes the BOOK
     * entry and NOTHING else — a podcast's episodes are separate entries with
     * separate folders, so evicting them is a per-episode act. Nothing here
     * reaches outside `downloads/{entryId}/`, which is what makes deleting an
     * episode unable to take the book's cover (or the reverse).
     */
    suspend fun delete(itemId: String, episodeId: String?) {
        if (!DownloadWorker.isSafeName(itemId)) return
        val entryId = DownloadEntry.entryId(itemId, episodeId)
        if (!DownloadWorker.isSafeName(entryId)) return
        cancelWork(entryId)
        withContext(Dispatchers.IO) { itemDir(entryId).deleteRecursively() }
        index.remove(entryId)
    }

    /**
     * Frozen: bytes held by all downloads. SUSPEND — the index seeds itself from
     * disk on first read, and doing that on a UI thread is the one thing this
     * class must not make easy.
     */
    suspend fun totalBytes(): Long = index.totalBytes()

    /**
     * Additive: one item's state for the UI, folded from WorkManager's live job
     * and the index. Live work reports itself (a re-run over an existing entry
     * really is downloading); everything else defers to the index, because
     * WorkManager prunes finished jobs and their absence must never un-download
     * a book that is sitting on the watch.
     */
    fun status(itemId: String): Flow<DownloadStatus> = status(itemId, null)

    /** Additive: [status] for one episode (null [episodeId] = the book above). */
    fun status(itemId: String, episodeId: String?): Flow<DownloadStatus> {
        val entryId = DownloadEntry.entryId(itemId, episodeId)
        return combine(index.entries, workInfos(entryId)) { stored, infos ->
            val active = activeInfo(infos)
            statusFrom(
                hasEntry = stored.any { it.id == entryId && it.isFor(itemId, episodeId) },
                state = active?.state,
                progress = active?.progress?.getInt(DownloadWorker.KEY_PROGRESS, 0) ?: 0
            )
        }.distinctUntilChanged()
    }

    private fun workManager(): WorkManager = WorkManager.getInstance(context)

    private fun workInfos(entryId: String): Flow<List<WorkInfo>> = flow {
        val upstream = try {
            workManager().getWorkInfosForUniqueWorkFlow(DownloadWorker.uniqueWorkName(entryId))
        } catch (t: Throwable) {
            // WorkManager not initialised in this process — the index alone
            // still answers downloaded-or-not, which is what the UI routes on.
            flowOf(emptyList())
        }
        emitAll(upstream)
    }

    private fun cancelWork(entryId: String) {
        try {
            workManager().cancelUniqueWork(DownloadWorker.uniqueWorkName(entryId))
        } catch (t: Throwable) {
            // Best effort: the files and the index entry must go regardless of
            // whether there was a job to stop.
        }
    }

    private fun constraints(force: Boolean): Constraints = Constraints.Builder()
        .setRequiredNetworkType(if (force) NetworkType.CONNECTED else NetworkType.UNMETERED)
        .setRequiresCharging(!force)
        .build()

    companion object {

        const val INDEX_FILENAME = "downloads_index.json"
        const val DOWNLOADS_DIRNAME = "downloads"

        /** Tags, so a future "cancel everything" doesn't need the id list. */
        const val TAG_ALL = "tomesonic_download"

        /** Per ENTRY, like every other key here — the item id for a book. */
        fun itemTag(entryId: String): String = "$TAG_ALL:$entryId"

        fun create(context: Context): DownloadRepository {
            val app = context.applicationContext
            return DownloadRepository(
                app,
                DownloadIndex(File(app.filesDir, INDEX_FILENAME)),
                File(app.filesDir, DOWNLOADS_DIRNAME)
            )
        }

        /**
         * The job that describes the item right now: the first unfinished one,
         * else the most recent finished one. A unique work name normally has
         * exactly one, but a REPLACE leaves the cancelled predecessor visible
         * for a moment.
         */
        fun activeInfo(infos: List<WorkInfo>): WorkInfo? =
            infos.firstOrNull { !it.state.isFinished } ?: infos.lastOrNull()

        /**
         * The pure fold behind [status], kept separate so the table of cases is
         * pinned by a plain JVM test instead of by a live WorkManager.
         */
        fun statusFrom(hasEntry: Boolean, state: WorkInfo.State?, progress: Int): DownloadStatus {
            when (state) {
                WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED -> return DownloadStatus.Queued
                WorkInfo.State.RUNNING ->
                    return DownloadStatus.Downloading(progress.coerceIn(0, 100))
                else -> Unit
            }
            if (hasEntry) return DownloadStatus.Downloaded
            return when (state) {
                WorkInfo.State.FAILED -> DownloadStatus.Failed
                // SUCCEEDED with no entry means the entry has since been
                // deleted; CANCELLED and "no job at all" are the same nothing.
                else -> DownloadStatus.NotDownloaded
            }
        }
    }
}
