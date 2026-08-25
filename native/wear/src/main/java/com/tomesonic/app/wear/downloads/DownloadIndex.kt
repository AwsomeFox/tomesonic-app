package com.tomesonic.app.wear.downloads

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/**
 * `filesDir/downloads_index.json` — the list of downloaded items, held in memory
 * and written through on every change.
 *
 * DataStore owns every other persisted value on the watch (see CredsRepository);
 * this one is a plain file on purpose. It is read by a WORKER process path and a
 * UI path, it can grow to hundreds of KB of track metadata, and — the deciding
 * reason — the phone has proven this exact file discipline in
 * `utils/autoCreds.ts`, where the native Android Auto service reads a JSON array
 * that JS rewrites underneath it.
 *
 * Three rules, all borrowed from that ancestor:
 *  - **Atomic writes**: temp file, then rename over the destination. A rename is
 *    a path swap, so a concurrent reader (or a kill mid-write) sees the previous
 *    complete file or the new one, never a torn one.
 *  - **Lazy seeding**: nothing touches the disk until someone actually asks. The
 *    watch's cold start already has a Data Layer read and a network call in it.
 *  - **Never throw**: a corrupt file is quarantined (`.bad`) and the watch
 *    behaves like a fresh install. Downloads are re-derivable; a crash loop on
 *    every launch is not recoverable by the user.
 *
 * The file is injected rather than resolved from a Context so tests can point it
 * at a temp dir — same shape as CredsRepository's injected DataStore.
 */
class DownloadIndex(private val file: File) {

    private val tmpFile = File(file.path + TMP_SUFFIX)
    private val badFile = File(file.path + BAD_SUFFIX)

    // One lock over BOTH the seed and every mutation: a read-modify-write of the
    // whole array is not atomic on its own, and two concurrent upserts (a worker
    // finishing while the user deletes something) would otherwise write each
    // other's stale snapshot back to disk.
    private val mutex = Mutex()
    private val state = MutableStateFlow<List<DownloadEntry>>(emptyList())

    @Volatile
    private var loaded = false

    /**
     * The frozen cross-wave stream. Cold: the disk read happens on first
     * collection, then every collector shares the one in-memory list.
     */
    val entries: Flow<List<DownloadEntry>> = flow {
        mutex.withLock { seed() }
        emitAll(state)
    }

    suspend fun all(): List<DownloadEntry> = mutex.withLock {
        seed()
        state.value
    }

    suspend fun get(itemId: String): DownloadEntry? = all().firstOrNull { it.id == itemId }

    /** Seeds from disk if that hasn't happened yet. Pairs with [snapshot]. */
    suspend fun warm() {
        mutex.withLock { seed() }
    }

    /**
     * The in-memory list, with no disk IO and no suspension — and therefore
     * EMPTY until something has seeded it (see [warm]). Only for the caller that
     * genuinely cannot suspend: Wave 3A resolves a downloaded book from a plain
     * function while building media3 items. Everything else uses [all].
     */
    fun snapshot(): List<DownloadEntry> = state.value

    /** Sum of every entry's on-disk footprint — what the settings screen shows. */
    suspend fun totalBytes(): Long = all().sumOf { it.bytes }

    /** Adds the entry, or replaces the one with the same id. Writes through. */
    suspend fun upsert(entry: DownloadEntry) {
        mutate { list -> list.filterNot { it.id == entry.id } + entry }
    }

    /** Drops the entry if present. Writes through even when nothing matched. */
    suspend fun remove(itemId: String) {
        mutate { list -> list.filterNot { it.id == itemId } }
    }

    private suspend fun mutate(transform: (List<DownloadEntry>) -> List<DownloadEntry>) {
        mutex.withLock {
            seed()
            val next = transform(state.value)
            // In-memory first: the UI is correct even if the disk write fails
            // (a full watch), and the next successful write repairs the file.
            state.value = next
            withContext(Dispatchers.IO) { writeToDisk(next) }
        }
    }

    /** Caller MUST hold [mutex]. Idempotent. */
    private suspend fun seed() {
        if (loaded) return
        state.value = withContext(Dispatchers.IO) { readFromDisk() }
        loaded = true
    }

    private fun readFromDisk(): List<DownloadEntry> {
        readEntries(file, quarantineOnFailure = true)?.let { return it }
        // Crash-window recovery, exactly like readAutoCreds: the write below is
        // temp-then-rename with a delete-first fallback, so a kill in the gap can
        // leave the destination missing while the FULLY-written temp still holds
        // the previous complete list. Reading it beats reporting "no downloads"
        // for files that are all still sitting on disk. No promotion needed —
        // the next write renames a fresh temp back into place.
        readEntries(tmpFile, quarantineOnFailure = false)?.let { return it }
        return emptyList()
    }

    /** Null for "nothing usable here" — missing, empty, unreadable or not JSON. */
    private fun readEntries(f: File, quarantineOnFailure: Boolean): List<DownloadEntry>? {
        val raw = try {
            // A zero-length file is a truncated write, not a corrupt document:
            // an empty list still serialises to "[]". Nothing to quarantine.
            if (!f.isFile || f.length() == 0L) return null
            f.readText()
        } catch (t: Throwable) {
            return null
        }
        DownloadEntry.parseList(raw)?.let { return it }
        if (quarantineOnFailure) quarantine(f)
        return null
    }

    /**
     * Move the unreadable file aside instead of deleting it: it costs one file's
     * worth of space and it is the only evidence left of what went wrong. A
     * previous `.bad` is replaced — one is a bug report, a pile is a leak.
     */
    private fun quarantine(f: File) {
        try {
            badFile.delete()
            if (!f.renameTo(badFile)) f.delete()
        } catch (t: Throwable) {
            // Even the quarantine is best-effort; the caller gets an empty list
            // either way and the next write overwrites the bad file.
        }
    }

    private fun writeToDisk(entries: List<DownloadEntry>) {
        val payload = try {
            DownloadEntry.toJsonArray(entries).toString()
        } catch (t: Throwable) {
            return
        }
        try {
            file.parentFile?.mkdirs()
            tmpFile.writeText(payload)
            if (!tmpFile.renameTo(file)) {
                // Some filesystems refuse a rename onto an existing path — clear
                // it first so the swap is a plain rename in every case (the same
                // repair the phone's atomicWrite makes).
                file.delete()
                if (!tmpFile.renameTo(file)) {
                    // The rename mechanism itself failed: last-resort direct
                    // write, then drop the temp so a stale one can't be read
                    // back as recovery content.
                    file.writeText(payload)
                    tmpFile.delete()
                }
            }
        } catch (t: Throwable) {
            // Out of space, or a filesDir the system revoked under us. The
            // in-memory list already carries the change; nothing here is worth
            // taking down a download worker or a UI collector for.
        }
    }

    companion object {
        const val TMP_SUFFIX = ".tmp"
        const val BAD_SUFFIX = ".bad"
    }
}
