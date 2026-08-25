package com.tomesonic.app.wear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.PodcastEpisode
import com.tomesonic.app.wear.downloads.DownloadStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** One episode row's download state — the same two facts the book header uses. */
data class EpisodeDownload(
    val status: DownloadStatus = DownloadStatus.NotDownloaded,
    val bytes: Long? = null
)

data class ItemUiState(
    val itemId: String = "",
    val loading: Boolean = true,
    val title: String = "",
    val author: String? = null,
    val mediaType: String = "book",
    val duration: Double = 0.0,
    val progress: Double? = null,
    val episodes: List<PodcastEpisode> = emptyList(),
    val trackCount: Int = 0,
    /** False when the expanded fetch failed — the difference between offline and empty. */
    val detailLoaded: Boolean = false,
    val hasCreds: Boolean = false,
    val status: DownloadStatus = DownloadStatus.NotDownloaded,
    val downloaded: Boolean = false,
    val bytes: Long? = null,
    val coverPath: String? = null,
    /** By episode id; absent means "nothing known yet", which renders as not downloaded. */
    val episodeDownloads: Map<String, EpisodeDownload> = emptyMap()
) {
    val isPodcast: Boolean get() = mediaType == "podcast"

    // Nullable in, because the screen's one play() path carries a null episode
    // id for the book — which simply has no episode row.
    fun episodeDownload(episodeId: String?): EpisodeDownload =
        episodeId?.let { episodeDownloads[it] } ?: EpisodeDownload()

    /** What ItemActions.precheck's `episodeDownloaded` needs, for one episode. */
    fun episodeDownloaded(episodeId: String?): Boolean =
        episodeDownload(episodeId).status == DownloadStatus.Downloaded
}

/**
 * One item screen.
 *
 * Two independent streams feed it, and they are kept independent on purpose:
 * the expanded fetch is a one-shot that can fail (offline), while the download
 * status is a LIVE flow that must keep updating a progress number while the
 * screen is open. Folding them into one load would freeze the progress bar at
 * whatever it was when the fetch returned.
 *
 * A downloaded item renders fully with no server at all — title, author,
 * duration and cover all come off the index — which is what makes this screen
 * the offline entry point to playback.
 */
class ItemViewModel : ViewModel() {

    private val _state = MutableStateFlow(ItemUiState())
    val state: StateFlow<ItemUiState> = _state.asStateFlow()

    private var itemId: String? = null
    private var statusJob: Job? = null
    private var episodeJob: Job? = null

    fun start(id: String) {
        if (itemId == id) return
        itemId = id
        // The previous item's episode rows must stop writing into this state
        // before the new item's blank one replaces it.
        episodeJob?.cancel()
        _state.value = ItemUiState(itemId = id)
        observeDownload(id)
        load(id)
    }

    private fun observeDownload(id: String) {
        statusJob?.cancel()
        statusJob = viewModelScope.launch {
            Graph.downloadRepository.status(id).collect { status ->
                val entry = Graph.downloadRepository.entryFor(id)
                val current = _state.value
                _state.value = current.copy(
                    status = status,
                    downloaded = entry != null,
                    bytes = entry?.bytes,
                    coverPath = entry?.coverPath ?: current.coverPath,
                    // A downloaded item that never reached the server still has
                    // a name and a length: take them from the index.
                    title = current.title.ifEmpty { entry?.title.orEmpty() },
                    author = current.author ?: entry?.author,
                    duration = if (current.duration > 0.0) current.duration else (entry?.duration ?: 0.0),
                    trackCount = if (current.trackCount > 0) current.trackCount else (entry?.tracks?.size ?: 0)
                )
            }
        }
    }

    private fun load(id: String) {
        viewModelScope.launch {
            val hasCreds = try {
                Graph.credsRepository.creds.first() != null
            } catch (t: Throwable) {
                false
            }
            val detail = Graph.absApi.itemExpanded(id)
            val current = _state.value
            if (detail == null) {
                // Offline, the index still knows which of this item's episodes
                // are on the watch — and they are the only ones that could play
                // anyway. Listing none would strand a download the downloads
                // screen points straight at.
                val local = downloadedEpisodes(id)
                _state.value = current.copy(
                    loading = false,
                    hasCreds = hasCreds,
                    detailLoaded = false,
                    episodes = local,
                    // A downloaded episode proves what this item is; with no
                    // fetch there is nothing else to tell the screen, and the
                    // book download section would be the wrong one to draw.
                    mediaType = if (local.isNotEmpty()) "podcast" else current.mediaType
                )
                observeEpisodeDownloads(id, local)
                return@launch
            }
            val progressTime = detail.userProgressCurrentTime
            val episodes = episodeRows(id, detail.episodes)
            _state.value = current.copy(
                loading = false,
                hasCreds = hasCreds,
                detailLoaded = true,
                title = detail.title,
                author = detail.authorName ?: current.author,
                mediaType = detail.mediaType,
                duration = if (detail.duration > 0.0) detail.duration else current.duration,
                progress = if (progressTime != null && detail.duration > 0.0) {
                    (progressTime / detail.duration).coerceIn(0.0, 1.0)
                } else {
                    null
                },
                episodes = episodes,
                trackCount = if (detail.tracks.isNotEmpty()) detail.tracks.size else current.trackCount
            )
            observeEpisodeDownloads(id, episodes)
        }
    }

    /**
     * The rows the screen shows: the server's recent episodes, plus any episode
     * already ON the watch that the cap left out. A downloaded episode with no
     * row is one the user can neither play offline nor delete, and this screen
     * is where the downloads list sends them to do both.
     */
    private suspend fun episodeRows(id: String, fetched: List<PodcastEpisode>): List<PodcastEpisode> {
        val recent = ItemActions.recentEpisodes(fetched)
        val extra = downloadedEpisodes(id).filterNot { local -> recent.any { it.id == local.id } }
        return recent + extra
    }

    /**
     * This item's downloaded episodes as rows, described entirely by the index —
     * title, length and id all come off the entry, so these render with no
     * server at all. Uncapped: every one of them is something the user chose to
     * put on the watch.
     */
    private suspend fun downloadedEpisodes(id: String): List<PodcastEpisode> = try {
        Graph.downloadRepository.entries.first()
            .filter { it.libraryItemId == id && !it.episodeId.isNullOrBlank() }
            .map { entry ->
                PodcastEpisode(
                    id = entry.episodeId.orEmpty(),
                    title = entry.episodeTitle?.takeIf { it.isNotBlank() } ?: entry.title,
                    publishedAt = null,
                    duration = entry.duration.takeIf { it > 0.0 }
                )
            }
    } catch (t: Throwable) {
        emptyList()
    }

    /**
     * One live status per episode row, folded into a map.
     *
     * Combined rather than collected separately so the screen sees ONE
     * consistent snapshot per change instead of a re-layout per episode. The
     * row list is bounded (ItemActions.MAX_EPISODES recent ones, plus whatever
     * this item already has downloaded), and each flow is the in-memory index
     * plus one WorkManager query — cheap, but not free, which is why it is
     * scoped to the rows actually on screen. `combine` emits only once every
     * flow has, which stops the rows flickering through a half-filled map.
     */
    private fun observeEpisodeDownloads(id: String, episodes: List<PodcastEpisode>) {
        // A fetch that was still in flight when the screen moved on must not
        // install the previous item's rows over the current one's.
        if (itemId != id) return
        episodeJob?.cancel()
        if (episodes.isEmpty()) return
        episodeJob = viewModelScope.launch {
            val flows = episodes.map { episode ->
                Graph.downloadRepository.status(id, episode.id).map { episode.id to it }
            }
            combine(flows) { it.toList() }.collect { pairs ->
                val next = LinkedHashMap<String, EpisodeDownload>(pairs.size)
                for ((episodeId, status) in pairs) {
                    // The size a delete decision is made on lives on the entry,
                    // not in the status — same read the book header makes.
                    val entry = Graph.downloadRepository.entryFor(id, episodeId)
                    next[episodeId] = EpisodeDownload(status = status, bytes = entry?.bytes)
                }
                _state.value = _state.value.copy(episodeDownloads = next)
            }
        }
    }

    /** The chips' commands, routed to the frozen DownloadRepository surface. */
    fun runCommand(command: DownloadCommand) = runCommand(command, null)

    /**
     * The same commands for ONE episode. A null [episodeId] is the book — the
     * repository's own convention, so this is one route rather than two.
     */
    fun runCommand(command: DownloadCommand, episodeId: String?) {
        val id = itemId ?: return
        val repository = Graph.downloadRepository
        viewModelScope.launch {
            when (command) {
                DownloadCommand.Enqueue -> repository.enqueue(id, episodeId)
                DownloadCommand.EnqueueNow -> repository.enqueue(id, episodeId, force = true)
                DownloadCommand.Cancel -> repository.cancel(id, episodeId)
                DownloadCommand.Delete -> repository.delete(id, episodeId)
            }
        }
    }
}
