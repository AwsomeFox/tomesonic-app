package com.tomesonic.app.wear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.LoginResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ConnectUiState(
    val signingIn: Boolean = false,
    /** One line under the chip; cleared when the next attempt starts. */
    val error: String? = null
)

/**
 * The watch-side sign-in, as state rather than as a callback.
 *
 * A ViewModel and not a `rememberCoroutineScope`, for the same reason
 * [SearchViewModel] is one: the three values arrive from ANOTHER activity (the
 * platform's remote input), and this composition can be recreated — or the
 * process trimmed — while that activity is on top.
 *
 * The password is a parameter and a local, never a field: it is spent on one
 * request and must not survive it. Nothing in this module logs, and this class
 * least of all.
 */
class ConnectViewModel : ViewModel() {

    private val _state = MutableStateFlow(ConnectUiState())
    val state: StateFlow<ConnectUiState> = _state.asStateFlow()

    /**
     * The remote input's three results. A blank step is a dismissed step — the
     * platform chains them and any one can be skipped — and there is nothing to
     * send without all three.
     */
    fun signIn(server: CharSequence?, username: CharSequence?, password: CharSequence?) {
        if (_state.value.signingIn) return
        val host = WatchLogin.normalizeEntry(server)
        val user = username?.toString()?.trim().orEmpty()
        val secret = password?.toString().orEmpty()
        if (host == null || user.isEmpty() || secret.isEmpty()) {
            _state.value = ConnectUiState(error = WatchLogin.INCOMPLETE)
            return
        }
        _state.value = ConnectUiState(signingIn = true)
        viewModelScope.launch {
            val result = try {
                Graph.absApi.login(host, user, secret)
            } catch (t: Throwable) {
                // AbsApi.login does not throw; a Graph that isn't initialised
                // could. Either way the watch is not signed in.
                LoginResult.Unreachable
            }
            if (result !is LoginResult.Success) {
                _state.value = ConnectUiState(error = WatchLogin.message(result))
                return@launch
            }
            val stored = try {
                Graph.credsRepository.setWatchLogin(
                    server = result.server,
                    token = result.token,
                    refreshToken = result.refreshToken,
                    userId = result.userId,
                    username = result.username
                )
                true
            } catch (t: Throwable) {
                // An unwritable store is the one failure that is neither the
                // server's nor the password's — and an uncaught one here would
                // take the app down on the sign-in screen.
                false
            }
            // No success state: the credentials flow re-routes the app off this
            // screen, and a "signed in" line would be rendered by a composition
            // that is already being torn down.
            _state.value = ConnectUiState(error = if (stored) null else WatchLogin.NOT_SAVED)
        }
    }
}
