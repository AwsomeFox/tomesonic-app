package com.tomesonic.app.wear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.ItemSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class LibraryUiState(
    val name: String = "Library",
    val items: List<ItemSummary> = emptyList(),
    val loading: Boolean = false,
    val endReached: Boolean = false,
    /** The last page successfully consumed; -1 before the first fetch. */
    val page: Int = -1
) {
    val isEmpty: Boolean get() = items.isEmpty() && !loading
}

/**
 * One library, one page at a time.
 *
 * The guard here is `loading`, not a debounce: the screen asks for more from a
 * composable at the end of the list, which recomposes freely, and two overlapping
 * fetches of the same page would double every row (Pagination.append would then
 * throw them away, having spent the network twice).
 */
class LibraryViewModel : ViewModel() {

    private val _state = MutableStateFlow(LibraryUiState())
    val state: StateFlow<LibraryUiState> = _state.asStateFlow()

    private var libraryId: String? = null

    /** Idempotent: re-entering the screen with the same id must not re-fetch. */
    fun start(id: String) {
        if (libraryId == id) return
        libraryId = id
        _state.value = LibraryUiState()
        loadMore()
        // The route carries an id, not a name. One small extra call rather than
        // a screen titled with a UUID; it fails silently to "Library".
        viewModelScope.launch {
            val name = Graph.absApi.libraries().firstOrNull { it.id == id }?.name
            if (name != null) _state.value = _state.value.copy(name = name)
        }
    }

    fun loadMore() {
        val id = libraryId ?: return
        val current = _state.value
        if (current.loading || current.endReached) return
        val page = Pagination.nextPage(current.page)
        _state.value = current.copy(loading = true)
        viewModelScope.launch {
            val incoming = Graph.absApi.libraryItems(id, page = page, limit = Pagination.PAGE_SIZE)
            val latest = _state.value
            _state.value = latest.copy(
                items = Pagination.append(latest.items, incoming),
                loading = false,
                endReached = Pagination.isEnd(incoming, Pagination.PAGE_SIZE),
                // Only a page that actually arrived advances the cursor: an
                // offline fetch returns empty, and treating that as consumed
                // would skip a real page once the link comes back.
                page = if (incoming.isEmpty()) latest.page else page
            )
        }
    }

    /** After an offline first page: let the screen ask again. */
    fun retry() {
        _state.value = _state.value.copy(endReached = false)
        loadMore()
    }
}
