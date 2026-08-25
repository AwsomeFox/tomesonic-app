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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

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
    val coverPath: String? = null
) {
    val isPodcast: Boolean get() = mediaType == "podcast"
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

    fun start(id: String) {
        if (itemId == id) return
        itemId = id
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
                _state.value = current.copy(loading = false, hasCreds = hasCreds, detailLoaded = false)
                return@launch
            }
            val progressTime = detail.userProgressCurrentTime
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
                episodes = ItemActions.recentEpisodes(detail.episodes),
                trackCount = if (detail.tracks.isNotEmpty()) detail.tracks.size else current.trackCount
            )
        }
    }

    /** The chips' commands, routed to the frozen DownloadRepository surface. */
    fun runCommand(command: DownloadCommand) {
        val id = itemId ?: return
        viewModelScope.launch {
            when (command) {
                DownloadCommand.Enqueue -> Graph.downloadRepository.enqueue(id)
                DownloadCommand.EnqueueNow -> Graph.downloadRepository.enqueue(id, force = true)
                DownloadCommand.Cancel -> Graph.downloadRepository.cancel(id)
                DownloadCommand.Delete -> Graph.downloadRepository.delete(id)
            }
        }
    }
}
