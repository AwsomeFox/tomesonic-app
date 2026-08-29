package com.tomesonic.app.automotive.data

/**
 * What a 401 means, decided before any socket is involved.
 *
 * Two decisions, both pure so the table they encode (refresh token × what
 * `/auth/refresh` answered) is pinned by a JVM test rather than by a live
 * server:
 *
 *  - [onUnauthorized] — whether a rejected request ends the session or is worth
 *    a refresh attempt. The watch's donor asks a second question first — is this
 *    a phone-mirrored credential, which carries the ACCESS token alone and so
 *    has nothing to refresh with? — and the car cannot: there is exactly one
 *    credential owner (ARCHITECTURE.md §6, [CredsSource]), so the stored refresh
 *    token is the whole test.
 *  - [classify] — whether an ATTEMPT killed it. Only a 401/403 from the refresh
 *    endpoint is definitive (ARCHITECTURE.md §4.4). A timeout, a 5xx, or a 200
 *    whose body carried no token is the server being unreachable or odd right
 *    now; signing the user out over one would strand a session that is still
 *    alive — and stranding it in a car means a Sign in prompt the driver cannot
 *    legally answer until they park. The phone draws exactly this line
 *    (utils/api.ts).
 */
internal object RefreshPolicy {

    /** What to do with a 401 from our own server. */
    enum class Action { TERMINAL, REFRESH }

    /** What a refresh attempt did. */
    enum class Outcome { SUCCESS, DEFINITIVE, TRANSIENT }

    fun onUnauthorized(creds: Creds?): Action = when {
        creds == null -> Action.TERMINAL
        // A login against a server with refresh disabled: the car's own session,
        // but with no way to renew. Terminal — sign in again from the parked
        // sign-in activity.
        creds.refreshToken.isNullOrBlank() -> Action.TERMINAL
        else -> Action.REFRESH
    }

    /**
     * [code] is null when there was NO response at all — offline, DNS, TLS, a
     * hung server. [accessToken] is what the body yielded, null when the
     * expected shape wasn't there.
     */
    fun classify(code: Int?, accessToken: String?): Outcome = when {
        code == null -> Outcome.TRANSIENT
        code == 401 || code == 403 -> Outcome.DEFINITIVE
        code == 200 && !accessToken.isNullOrBlank() -> Outcome.SUCCESS
        else -> Outcome.TRANSIENT
    }

    /** Only a definitive outcome may raise `AbsClient.authFailed`. */
    fun isAuthFailure(outcome: Outcome): Boolean = outcome == Outcome.DEFINITIVE
}
