package com.tomesonic.app.wear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.ItemDetail
import com.tomesonic.app.wear.data.LastItem
import com.tomesonic.app.wear.downloads.DownloadEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

data class HomeUiState(
    val loading: Boolean = true,
    val rows: List<HomeRow> = emptyList(),
    /** What the download affordances read, via [HomeSections.downloadState]. */
    val downloads: List<DownloadEntry> = emptyList(),
    val requestedDownloads: Set<String> = emptySet()
)

/**
 * Home, assembled once per visit.
 *
 * Deliberately NOT a set of live flows: the three sources answer at very
 * different speeds (DataStore in microseconds, the download index off disk, the
 * server over a Bluetooth-proxied link), and a screen that re-lays-out three
 * times as they trickle in is the watch equivalent of a page reflow. One
 * assembly, one paint — [refresh] re-runs it when the screen is re-entered.
 *
 * The ORDER of the awaits matters: local sources first, so an offline watch has
 * already painted its resume card and downloads chip by the time the network
 * call gives up.
 */
class HomeViewModel : ViewModel() {

    private val _state = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = _state.asStateFlow()

    fun refresh() {
        viewModelScope.launch {
            val downloads = try {
                Graph.downloadRepository.entries.first()
            } catch (t: Throwable) {
                emptyList()
            }
            val last = try {
                Graph.credsRepository.lastItem.first()
            } catch (t: Throwable) {
                null
            }

            // AbsApi never throws: an empty list here means "no libraries" OR
            // "no server", and only the pair of them together is worth calling
            // offline (a real library that is genuinely empty still has a name).
            val libraries = Graph.absApi.libraries()
            val inProgress = Graph.absApi.itemsInProgress()
            val offline = libraries.isEmpty() && inProgress.isEmpty()

            val resume = HomeSections.resume(last, downloads, inProgress)
                ?: expandedResume(last, offline)

            _state.value = HomeUiState(
                loading = false,
                rows = HomeSections.build(
                    resume = resume,
                    inProgress = inProgress,
                    libraries = libraries,
                    downloadCount = downloads.size,
                    offline = offline
                ),
                downloads = downloads,
                // Kept across refreshes: a queued download is still no entry
                // (charger + Wi-Fi can be hours away), and downloadState already
                // lets a real entry outrank the marker.
                requestedDownloads = _state.value.requestedDownloads
            )
        }
    }

    /**
     * The home affordance's one verb: enqueue with the DEFAULT constraints —
     * the escape hatch ("Download now") and every other download state live on
     * the item screen, which the affordance opens once a request is in flight.
     */
    fun download(itemId: String, episodeId: String?) {
        val key = HomeSections.downloadKey(itemId, episodeId)
        _state.value = _state.value.copy(requestedDownloads = _state.value.requestedDownloads + key)
        viewModelScope.launch {
            try {
                Graph.downloadRepository.enqueue(itemId, episodeId?.takeIf { it.isNotBlank() })
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                // Un-mark, so the row honestly re-offers the download.
                _state.value = _state.value.copy(requestedDownloads = _state.value.requestedDownloads - key)
            }
        }
    }

    /**
     * The last-played book is known by id but by nothing else — it isn't
     * downloaded and it has dropped off the in-progress list (finished, or
     * pushed off the end of the 15 the server returns). One expanded fetch
     * rather than a resume card that says "Audiobook".
     */
    private suspend fun expandedResume(last: LastItem?, offline: Boolean): ResumeTarget? {
        val itemId = last?.itemId ?: return null
        if (offline) return null
        val detail: ItemDetail = Graph.absApi.itemExpanded(itemId) ?: return null
        val current = detail.userProgressCurrentTime
        return ResumeTarget(
            itemId = detail.id,
            episodeId = last.episodeId,
            title = detail.title,
            author = detail.authorName,
            progress = if (current != null && detail.duration > 0.0) {
                (current / detail.duration).coerceIn(0.0, 1.0)
            } else {
                null
            },
            downloaded = false,
            coverPath = null
        )
    }
}
