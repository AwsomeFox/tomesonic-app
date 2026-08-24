package com.tomesonic.app.wear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tomesonic.app.wear.Graph
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
    val storageBytes: Long = 0L,
    val version: String = "",
    val syncing: Boolean = false,
    /** One line under the Sync row; cleared on the next tap. */
    val syncMessage: String? = null
)

/**
 * Settings is a read-only screen with one verb.
 *
 * There is no "disconnect watch": logout is phone-driven (the phone puts empty
 * credentials on the Data Layer and CredsRepository clears itself), and a watch
 * that could log itself out would leave the phone thinking it was still paired —
 * a documented v1 non-goal, not an omission.
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
                    connected = creds != null && !Graph.absClient.authFailed.value
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
            _state.value = _state.value.copy(
                storageBytes = try {
                    Graph.downloadRepository.totalBytes()
                } catch (t: Throwable) {
                    0L
                }
            )
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
}
