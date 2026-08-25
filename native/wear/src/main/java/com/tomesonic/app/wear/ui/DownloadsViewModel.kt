package com.tomesonic.app.wear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.downloads.DownloadEntry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class DownloadsUiState(
    val loading: Boolean = true,
    val entries: List<DownloadEntry> = emptyList(),
    val totalBytes: Long = 0L
)

/**
 * The downloaded library, live.
 *
 * This one IS a live flow (unlike home): a download finishing while the screen
 * is open must add its row, and the whole screen is three fields per row — there
 * is nothing here for a re-layout to disturb.
 *
 * The total comes from the repository rather than from summing the rows on
 * screen: totalBytes is the frozen interface's answer, and keeping one owner of
 * that number is what stops the footer and the settings screen disagreeing.
 */
class DownloadsViewModel : ViewModel() {

    private val _state = MutableStateFlow(DownloadsUiState())
    val state: StateFlow<DownloadsUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            Graph.downloadRepository.entries.collect { entries ->
                _state.value = DownloadsUiState(
                    loading = false,
                    entries = entries,
                    totalBytes = try {
                        Graph.downloadRepository.totalBytes()
                    } catch (t: Throwable) {
                        0L
                    }
                )
            }
        }
    }
}
