package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.ItemSummary
import com.tomesonic.app.wear.data.LastItem
import com.tomesonic.app.wear.data.LibrarySummary
import com.tomesonic.app.wear.downloads.DownloadEntry

/**
 * The one thing the resume card needs to draw itself and start playing, from
 * whichever of the three sources answered first — the download index, the
 * in-progress list, or an expanded fetch.
 *
 * `coverPath` is an on-disk absolute path (a downloaded cover) or null, in which
 * case the screen falls back to the server's cover URL. Keeping it a String
 * rather than a File is what lets this whole file stay JVM-pure.
 */
data class ResumeTarget(
    val itemId: String,
    val episodeId: String?,
    val title: String,
    val author: String?,
    val progress: Double?,
    val downloaded: Boolean,
    val coverPath: String?
)

/**
 * What the download affordance on a home row shows. [Requested] is screen-local
 * truth — the tap happened, the entry doesn't exist yet (the worker may be
 * waiting on charger + Wi-Fi); the item screen is where the real progress lives,
 * which is where the affordance sends a tap in that state.
 */
enum class HomeDownloadState { None, Requested, Downloaded }

/** One row of the home list, in the order [HomeSections.build] emits them. */
sealed interface HomeRow {
    data class Resume(val target: ResumeTarget) : HomeRow
    data object ContinueHeader : HomeRow
    data class Continue(val item: ItemSummary) : HomeRow
    data object Offline : HomeRow
    data class Downloads(val count: Int) : HomeRow
    data class Library(val library: LibrarySummary) : HomeRow
    data object Settings : HomeRow
}

/**
 * Home, assembled from whatever the watch actually has. Pure on purpose: the
 * screen's whole behaviour — what resume points at, what "offline" hides, what
 * order the chips land in — is decided here and pinned by JVM tests, leaving the
 * composable to draw a list it is handed.
 */
object HomeSections {

    /** Continue Listening on a watch is a glance, not a backlog. */
    const val MAX_CONTINUE = 8

    /** One key per downloadable thing — a podcast row's key is its EPISODE's. */
    fun downloadKey(itemId: String, episodeId: String?): String =
        if (episodeId.isNullOrBlank()) itemId else "$itemId::$episodeId"

    /**
     * The affordance's state for one row, decided the same way playback decides
     * what is offline: [DownloadEntry.isFor], exactly. A podcast row asks about
     * its EPISODE — an item-level entry (or some other episode's) does not make
     * this row's tap play offline, so it must not read as downloaded here.
     * An entry that exists always outranks a stale requested marker.
     */
    fun downloadState(
        downloads: List<DownloadEntry>,
        requested: Set<String>,
        itemId: String,
        episodeId: String?
    ): HomeDownloadState = when {
        downloads.any { it.isFor(itemId, episodeId?.takeIf { e -> e.isNotBlank() }) } ->
            HomeDownloadState.Downloaded
        downloadKey(itemId, episodeId) in requested -> HomeDownloadState.Requested
        else -> HomeDownloadState.None
    }

    /**
     * The resume card's subject: the last thing THIS WATCH played
     * (`last_item_id`), described by the richest source that knows it.
     *
     * Downloads win over the server list — a downloaded book is the one that
     * plays with no network, and its title/cover are already on disk. Falling
     * back to the first in-progress item is the contract's rule for a watch that
     * has never played anything itself.
     *
     * Returns null when the last item is known but nothing local describes it;
     * the caller then has one expanded fetch to make (see HomeViewModel).
     */
    fun resume(
        last: LastItem?,
        downloads: List<DownloadEntry>,
        inProgress: List<ItemSummary>
    ): ResumeTarget? {
        val lastId = last?.itemId
        if (lastId != null) {
            val row = inProgress.firstOrNull { it.id == lastId }
            // isFor, not an id compare: a downloaded EPISODE's entry id is the
            // composite key, and the resume pointer holds the podcast's item id
            // plus the episode id. Books match exactly as before. The fallback
            // keeps v1's rule: an episode resume whose PODCAST has an item-level
            // entry still gets its card described off the index (title, cover,
            // offline) — the episode itself streams, exactly as it always did.
            val entry = downloads.firstOrNull { it.isFor(lastId, last.episodeId) }
                ?: last.episodeId?.let { downloads.firstOrNull { e -> e.isFor(lastId, null) } }
            if (entry != null) {
                return ResumeTarget(
                    // The ITEM id — an episode entry's own id is a folder key,
                    // not something the server or the player should ever see.
                    itemId = entry.libraryItemId,
                    episodeId = last.episodeId,
                    title = entry.episodeTitle?.takeIf { it.isNotBlank() } ?: entry.title,
                    author = entry.author,
                    progress = row?.progress,
                    downloaded = true,
                    coverPath = entry.coverPath
                )
            }
            if (row != null) return fromSummary(row, last.episodeId, downloads)
            return null
        }
        val first = inProgress.firstOrNull() ?: return null
        return fromSummary(first, first.episodeId, downloads)
    }

    /** An in-progress row promoted to a resume target, download state folded in. */
    fun fromSummary(
        item: ItemSummary,
        episodeId: String?,
        downloads: List<DownloadEntry>
    ): ResumeTarget {
        val resolvedEpisode = episodeId ?: item.episodeId
        // The episode's own entry wins; an item-level entry (a v1-style podcast
        // download) still describes the card. Some OTHER episode's entry never
        // matches either arm — episode entries carry their episodeId.
        val entry = downloads.firstOrNull { it.isFor(item.id, resolvedEpisode) }
            ?: resolvedEpisode?.let { downloads.firstOrNull { e -> e.isFor(item.id, null) } }
        return ResumeTarget(
            itemId = item.id,
            episodeId = resolvedEpisode,
            title = item.title,
            author = item.authorName,
            progress = item.progress,
            downloaded = entry != null,
            coverPath = entry?.coverPath
        )
    }

    /**
     * The whole screen, in order: resume, Continue Listening, then the chips.
     *
     * The resume item is REMOVED from Continue Listening — it is already the
     * biggest thing on the screen, and a watch list that shows the same book
     * twice in the first two rows looks broken.
     *
     * [offline] adds one quiet line instead of replacing the screen: Downloads,
     * Settings and the resume card all work with no server, so an error wall
     * would hide three working things to report one broken one. The library
     * chips simply aren't there, because the list they came from is empty.
     */
    fun build(
        resume: ResumeTarget?,
        inProgress: List<ItemSummary>,
        libraries: List<LibrarySummary>,
        downloadCount: Int,
        offline: Boolean
    ): List<HomeRow> {
        val rows = ArrayList<HomeRow>()
        resume?.let { rows.add(HomeRow.Resume(it)) }

        val rest = inProgress
            .filter { it.id != resume?.itemId }
            .take(MAX_CONTINUE)
        if (rest.isNotEmpty()) {
            rows.add(HomeRow.ContinueHeader)
            rest.forEach { rows.add(HomeRow.Continue(it)) }
        }

        if (offline) rows.add(HomeRow.Offline)
        rows.add(HomeRow.Downloads(downloadCount))
        libraries.forEach { rows.add(HomeRow.Library(it)) }
        rows.add(HomeRow.Settings)
        return rows
    }
}
