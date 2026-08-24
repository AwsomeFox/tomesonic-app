package com.tomesonic.app.wear.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import coil.ImageLoader
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.Creds
import com.tomesonic.app.wear.playback.PlayerConnection
import com.tomesonic.app.wear.ui.components.buildCoverLoader
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * `loaded` is NOT "has credentials" — it is "the credential store has answered
 * at least once". Without it a cold start renders the connect screen for the
 * frame or two DataStore takes to read, which on a watch is a visible flash of
 * "your phone isn't connected" on an app that is perfectly connected.
 */
data class RootState(
    val loaded: Boolean = false,
    val creds: Creds? = null,
    val authFailed: Boolean = false
)

/**
 * The one ViewModel that lives for the whole app rather than for one screen, and
 * therefore the owner of the two things that must be built exactly once:
 *
 *  - [player] — a MediaController wrapper. Re-creating it per screen would
 *    rebind the media session on every navigation; it is released in
 *    [onCleared], which is the only place that runs after the last screen is
 *    gone but before the process is.
 *  - [coverLoader] — Coil's ImageLoader over the authorized OkHttp client. Its
 *    memory and disk caches belong to the loader, so a second one would halve
 *    both and re-fetch every cover.
 *
 * Scoped to the Activity (see WearApp), which is what makes both survive
 * navigation and configuration changes.
 */
class RootViewModel(application: Application) : AndroidViewModel(application) {

    val player: PlayerConnection = PlayerConnection(application)

    val coverLoader: ImageLoader = buildCoverLoader(application)

    private val _state = MutableStateFlow(RootState())
    val state: StateFlow<RootState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            Graph.credsRepository.creds.collect { creds ->
                _state.value = _state.value.copy(loaded = true, creds = creds)
            }
        }
        viewModelScope.launch {
            // Terminal for v1: the watch never refreshes a token, so a 401 can
            // only be answered from the phone (see AbsClient).
            Graph.absClient.authFailed.collect { failed ->
                _state.value = _state.value.copy(authFailed = failed)
            }
        }
    }

    override fun onCleared() {
        super.onCleared()
        // Drops the controller only — playback and its service keep running,
        // which is the point: closing the app must not stop the book.
        player.release()
    }
}
