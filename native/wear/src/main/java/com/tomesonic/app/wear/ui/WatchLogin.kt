package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.CredsRepository
import com.tomesonic.app.wear.data.LoginResult

/**
 * The two things a watch sign-in decides before and after the network: what the
 * typed address actually means, and what the user is told when it fails.
 *
 * Both live here rather than in [com.tomesonic.app.wear.data.AbsApi] because
 * both are copy: the API answers with a CASE, and the sentence for that case is
 * a UI decision. Pure, so the mapping is pinned by a JVM test — an error line
 * that is wrong is worse than no error line, and it can only be checked here.
 *
 * The sentences are the phone's, verbatim (screens/ConnectScreen.tsx): a user
 * who mistypes a password on the watch and again on the phone should be told
 * the same thing by both.
 */
object WatchLogin {

    const val INVALID_CREDENTIALS = "Invalid username or password."
    const val UNREACHABLE = "Couldn't reach the server. Check the address and your connection."
    const val RATE_LIMITED = "Too many attempts. Please wait a moment and try again."
    const val SERVER_PROBLEM = "The server had a problem. Please try again."

    /** Not a server answer — the input came back with a step left blank. */
    const val INCOMPLETE = "Enter the server address, username and password."

    /** Also not a server answer: the sign-in worked and the watch couldn't keep it. */
    const val NOT_SAVED = "Signed in, but this watch couldn't save it. Try again."

    /**
     * The typed address as an origin, or null when there is nothing to try.
     *
     * A watch keyboard is a poor place to type "https://" and dictation never
     * produces it, so a scheme-less address gets one. https, not http: the
     * fallback has to be the safe one, and a self-hosted server on plain http
     * is still reachable by typing the scheme (which is why the manifest keeps
     * cleartext traffic on).
     *
     * Anything past the origin is dropped by [CredsRepository.normalizeServer] —
     * every URL in the app is built by concatenating a leading-slash path onto
     * this value.
     */
    fun normalizeEntry(raw: CharSequence?): String? {
        val text = raw?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return null
        val withScheme = if (text.startsWith("http://") || text.startsWith("https://")) {
            text
        } else {
            "https://$text"
        }
        return CredsRepository.normalizeServer(withScheme).ifEmpty { null }
    }

    /** The line under the chip. Null for a success — the app leaves this screen. */
    fun message(result: LoginResult): String? = when (result) {
        is LoginResult.Success -> null
        LoginResult.BadCredentials -> INVALID_CREDENTIALS
        LoginResult.RateLimited -> RATE_LIMITED
        LoginResult.ServerError -> SERVER_PROBLEM
        LoginResult.Unreachable -> UNREACHABLE
    }
}
