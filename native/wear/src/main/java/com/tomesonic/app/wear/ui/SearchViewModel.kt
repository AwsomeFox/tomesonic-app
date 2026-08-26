package com.tomesonic.app.wear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.ItemSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class SearchUiState(
    /** What was actually asked of the server. Shown back: voice gets it wrong. */
    val query: String = "",
    val results: List<ItemSummary> = emptyList(),
    val searching: Boolean = false,
    /** The server ANSWERED. With no results that is "No matches", not a failure. */
    val answered: Boolean = false,
    val failed: Boolean = false
)

/**
 * One library, one query at a time.
 *
 * The query is state rather than a parameter because it arrives from ANOTHER
 * activity (the platform's remote input), which the screen can be recomposed —
 * or recreated — around while it is up.
 */
class SearchViewModel : ViewModel() {

    private val _state = MutableStateFlow(SearchUiState())
    val state: StateFlow<SearchUiState> = _state.asStateFlow()

    private var libraryId: String? = null
    private var prompted = false

    /** Idempotent: re-entering the screen with the same id keeps the results. */
    fun start(id: String) {
        if (libraryId == id) return
        libraryId = id
        prompted = false
        _state.value = SearchUiState()
    }

    /**
     * True exactly once per library: the screen opens the input itself on its
     * first composition, and the LaunchedEffect that does it re-runs whenever
     * the composition is recreated — including on the way back from the input
     * activity, which would reopen it on top of the answer just given.
     */
    fun consumePrompt(): Boolean {
        if (prompted) return false
        prompted = true
        return true
    }

    fun search(raw: CharSequence?) {
        val id = libraryId ?: return
        val query = SearchLogic.normalize(raw) ?: return
        _state.value = SearchUiState(query = query, searching = true)
        viewModelScope.launch {
            val results = Graph.absApi.search(id, query)
            // A slow earlier query must not land on top of a newer one's
            // results — the input activity is one tap away from the retry chip.
            if (_state.value.query != query) return@launch
            _state.value = SearchUiState(
                query = query,
                results = results.orEmpty(),
                answered = results != null,
                failed = results == null
            )
        }
    }

    /** The failed state's chip: same query, one more try. */
    fun retry() {
        search(_state.value.query)
    }
}
