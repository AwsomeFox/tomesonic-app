package com.tomesonic.app.automotive.ui

import com.tomesonic.app.automotive.data.AbsApi
import com.tomesonic.app.automotive.data.CredsRepository
import com.tomesonic.app.automotive.data.LoginResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Where a sign-in attempt is. Four states and no more: the car's form is one
 * screen with one button, and every extra state would be one the activity has
 * to render.
 *
 * [Done] is TERMINAL — the activity finishes on it, and the credentials the
 * service watches are already written by the time it arrives.
 */
sealed interface SignInState {
    data object Idle : SignInState
    data object Working : SignInState

    /** One line under the form. The sentence, not the case — see [SignInViewModel.message]. */
    data class Error(val message: String) : SignInState

    data object Done : SignInState
}

/**
 * The two calls a sign-in makes, as a seam.
 *
 * Same shape and same reason as [com.tomesonic.app.automotive.media.BrowseApi]:
 * [AbsApi] and [CredsRepository] are final classes over a socket and a file, and
 * the thing worth pinning here is the STATE MACHINE — which failure becomes
 * which sentence, what happens when the store refuses the write, what a second
 * tap does while the first is in flight. None of that is checkable against a
 * live ABS instance without pinning the instance instead.
 */
interface SignInBackend {
    suspend fun login(server: String, username: String, password: String): LoginResult

    /** Persist a successful login. Throws only if the store itself refuses. */
    suspend fun store(result: LoginResult.Success)
}

/**
 * [SignInBackend] over the real data layer — the one production implementation.
 *
 * `setCarLogin` is the ONLY way credentials enter this module's store
 * (CredsRepository's own contract), and this is its only caller.
 */
class AbsSignInBackend(
    private val api: AbsApi,
    private val creds: CredsRepository
) : SignInBackend {

    override suspend fun login(server: String, username: String, password: String): LoginResult =
        api.login(server, username, password)

    override suspend fun store(result: LoginResult.Success) {
        creds.setCarLogin(
            server = result.server,
            token = result.token,
            // Absent on servers with refresh disabled; the store drops any
            // previous login's rather than inheriting it.
            refreshToken = result.refreshToken,
            userId = result.userId,
            username = result.username
        )
    }
}

/**
 * The car-side sign-in, as state rather than as a callback.
 *
 * A PLAIN class taking a scope, not an androidx ViewModel: the donor
 * (`:wear`'s ConnectViewModel) is one because its three values arrive from
 * ANOTHER activity — the platform's remote input — and its composition can be
 * recreated while that activity is on top. The car form owns its own fields on
 * its own screen, so there is nothing to survive, and a ViewModel here would
 * cost this module a lifecycle-viewmodel dependency for a single object with a
 * StateFlow in it. The LOGIC below is the donor's, line for line; only the
 * three-step RemoteInput flow it drove is gone.
 *
 * The password is a parameter and a local, never a field: it is spent on one
 * request and must not survive it. Nothing in this module logs, and this class
 * least of all.
 */
class SignInViewModel(
    private val scope: CoroutineScope,
    private val backend: SignInBackend
) {

    private val _state = MutableStateFlow<SignInState>(SignInState.Idle)
    val state: StateFlow<SignInState> = _state.asStateFlow()

    /**
     * The three typed fields. A blank one is a field the user hasn't filled —
     * the car keyboard makes all three available at once, so unlike the watch
     * there is no "dismissed step", but there is nothing to send without all
     * three either.
     */
    fun signIn(server: CharSequence?, username: CharSequence?, password: CharSequence?) {
        // Working: the donor's re-entry guard — a second tap must not open a
        // second socket. Done: terminal, and the activity is already finishing.
        if (_state.value is SignInState.Working || _state.value is SignInState.Done) return
        val host = normalizeEntry(server)
        val user = username?.toString()?.trim().orEmpty()
        val secret = password?.toString().orEmpty()
        if (host == null || user.isEmpty() || secret.isEmpty()) {
            _state.value = SignInState.Error(INCOMPLETE)
            return
        }
        _state.value = SignInState.Working
        scope.launch {
            val result = try {
                backend.login(host, user, secret)
            } catch (e: CancellationException) {
                // The scope is going away (activity finished mid-login) — end
                // with it rather than writing an error into a dead screen.
                throw e
            } catch (t: Throwable) {
                // AbsApi.login does not throw; a Graph that isn't initialised
                // could. Either way the car is not signed in.
                LoginResult.Unreachable
            }
            if (result !is LoginResult.Success) {
                // message() is null for a success only, which this branch has
                // excluded; the elvis is the compiler's, not a case.
                _state.value = SignInState.Error(message(result) ?: SERVER_PROBLEM)
                return@launch
            }
            val stored = try {
                backend.store(result)
                true
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                // An unwritable store is the one failure that is neither the
                // server's nor the password's — and an uncaught one here would
                // take the app down on the sign-in screen.
                false
            }
            _state.value = if (stored) SignInState.Done else SignInState.Error(NOT_SAVED)
        }
    }

    /**
     * The copy, and the address rule.
     *
     * Both live here rather than in [AbsApi] because both are copy: the API
     * answers with a CASE, and the sentence for that case is a UI decision.
     * Pure, so the mapping is pinned by a JVM test — an error line that is
     * wrong is worse than no error line, and it can only be checked here.
     *
     * The four server-answer sentences are the phone's, verbatim
     * (screens/ConnectScreen.tsx, by way of `:wear`'s WatchLogin): a user who
     * mistypes a password in the car and again on the phone should be told the
     * same thing by both.
     */
    companion object {

        const val INVALID_CREDENTIALS = "Invalid username or password."
        const val UNREACHABLE = "Couldn't reach the server. Check the address and your connection."
        const val RATE_LIMITED = "Too many attempts. Please wait a moment and try again."
        const val SERVER_PROBLEM = "The server had a problem. Please try again."

        /** Not a server answer — the form was submitted with a field left blank. */
        const val INCOMPLETE = "Enter the server address, username and password."

        /**
         * Also not a server answer: the sign-in worked and the car couldn't
         * keep it. The one sentence NOT carried over verbatim — the donor's
         * names the watch ("this watch couldn't save it"), and the device noun
         * is the whole content of the line.
         */
        const val NOT_SAVED = "Signed in, but this car couldn't save it. Try again."

        /**
         * The "Use demo server" prefill (ARCHITECTURE.md §12 risk 1): a Play
         * reviewer with no self-hosted ABS instance otherwise sees an empty app.
         *
         * PLACEHOLDER. Which instance actually serves the review window — who
         * hosts it, what it is seeded with, how long it stays up — is the Wave 5
         * release runbook's decision and the contract's one open question for
         * the owner. When that lands, this constant and the test row that pins
         * it change together, on purpose: the value a reviewer types is not
         * something to discover from a diff.
         */
        const val DEMO_SERVER = "https://demo.tomesonic.example"

        /**
         * The typed address as an origin, or null when there is nothing to try.
         *
         * A scheme-less address gets one — https, not http: the fallback has to
         * be the safe one, and a self-hosted server on plain http is still
         * reachable by typing the scheme (which is why the manifest keeps
         * cleartext traffic on). The car's field is `textUri` and its keyboard
         * has a full row of punctuation, so this is a convenience here rather
         * than the necessity it is on a watch — but the rule is the donor's and
         * both clients must read one typed address the same way.
         *
         * [CredsRepository.normalizeServer] then trims whitespace and trailing
         * slashes — nothing more. A path segment SURVIVES on purpose: a
         * self-hosted ABS behind a reverse proxy can live under one
         * (https://host/abs), and every URL in the app is built by
         * concatenating a leading-slash path onto this value.
         */
        fun normalizeEntry(raw: CharSequence?): String? {
            val text = raw?.toString()?.trim().orEmpty()
            if (text.isEmpty()) return null
            // Scheme detection is CASE-INSENSITIVE (RFC 3986; pasted addresses
            // and some car keyboards shout), and the scheme is stored lowered —
            // "HTTPS://host" must not come out as "https://HTTPS://host".
            val schemeMatch = SCHEME.find(text)
            val withScheme = if (schemeMatch != null) {
                schemeMatch.groupValues[1].lowercase() + "://" +
                    text.substring(schemeMatch.value.length)
            } else {
                "https://$text"
            }
            return CredsRepository.normalizeServer(withScheme).ifEmpty { null }
        }

        private val SCHEME = Regex("^(https?)://", RegexOption.IGNORE_CASE)

        /** The line under the form. Null for a success — the activity finishes. */
        fun message(result: LoginResult): String? = when (result) {
            is LoginResult.Success -> null
            LoginResult.BadCredentials -> INVALID_CREDENTIALS
            LoginResult.RateLimited -> RATE_LIMITED
            LoginResult.ServerError -> SERVER_PROBLEM
            LoginResult.Unreachable -> UNREACHABLE
        }
    }
}
