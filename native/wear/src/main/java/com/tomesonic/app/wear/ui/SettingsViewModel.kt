package com.tomesonic.app.wear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.CredsRepository
import com.tomesonic.app.wear.data.CredsSource
import com.tomesonic.app.wear.playback.OfflineProgressQueue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

data class SettingsUiState(
    val host: String? = null,
    val username: String? = null,
    val connected: Boolean = false,
    /** Null when nothing is stored — the source of what IS stored otherwise. */
    val source: CredsSource? = null,
    val storageBytes: Long = 0L,
    val version: String = "",
    val syncing: Boolean = false,
    /** One line under the Sync row; cleared on the next tap. */
    val syncMessage: String? = null
)

/**
 * Settings is a read-only screen with two verbs, and the second one only
 * sometimes.
 *
 * Sign-out is offered for a WATCH login and nothing else. A phone-mirrored
 * session is the phone's to end — the watch clearing it would leave the phone
 * still pushing the same credentials back over the Data Layer, so the button
 * would appear to do nothing. A watch login has no such owner, which is exactly
 * why it needs one here.
 */
class SettingsViewModel : ViewModel() {

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    init {
        _state.value = _state.value.copy(version = Graph.versionName)
        viewModelScope.launch {
            Graph.credsRepository.creds.collect { creds ->
                _state.value = _state.value.copy(
                    host = creds?.server?.let { UiFormat.hostOnly(it) },
                    username = creds?.username?.takeIf { it.isNotBlank() },
                    connected = creds != null && !Graph.absClient.authFailed.value,
                    source = creds?.source
                )
            }
        }
        viewModelScope.launch {
            Graph.absClient.authFailed.collect { failed ->
                val creds = try {
                    Graph.credsRepository.creds.first()
                } catch (t: Throwable) {
                    null
                }
                _state.value = _state.value.copy(connected = creds != null && !failed)
            }
        }
        viewModelScope.launch {
            // Live, not a one-shot totalBytes(): a download finishing or a
            // delete while this screen is open must move the number — same
            // source of truth the Downloads screen renders from.
            try {
                Graph.downloadRepository.entries.collect { entries ->
                    _state.value = _state.value.copy(storageBytes = entries.sumOf { it.bytes })
                }
            } catch (t: Throwable) {
                _state.value = _state.value.copy(storageBytes = 0L)
            }
        }
    }

    /**
     * Flush trigger #4: the user asking.
     *
     * The other three (app start, playback start/reconnect, a network callback)
     * all happen without anyone watching; this one exists so a watch that spent a
     * run offline can be made to hand its progress over before the phone is
     * opened, and so the answer is visible when it does.
     */
    fun syncNow() {
        if (_state.value.syncing) return
        _state.value = _state.value.copy(syncing = true, syncMessage = null)
        viewModelScope.launch {
            val ok = try {
                OfflineProgressQueue.shared.flush(Graph.absApi)
            } catch (t: Throwable) {
                false
            }
            _state.value = _state.value.copy(
                syncing = false,
                syncMessage = if (ok) "Synced" else "Sync failed — try again in range"
            )
        }
    }

    /**
     * Ends a watch-owned session. The same [CredsRepository.clear] a phone
     * logout performs, so the user-scoped state goes with it — including any
     * offline listening that never reached the server, which is why the screen
     * asks twice and says so.
     *
     * Downloads are NOT touched: files on this watch outlive the login that
     * fetched them, and deleting them is the Downloads screen's job.
     */
    fun signOut() {
        viewModelScope.launch {
            try {
                Graph.credsRepository.clear()
            } catch (t: Throwable) {
                // A store that cannot be written cannot be signed out of. The
                // screen keeps showing the session, which is the truth.
            }
        }
    }
}
