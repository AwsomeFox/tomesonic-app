package com.tomesonic.app.automotive.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * A response reduced to what the two token-free calls decide on: the status
 * code and the body. A NULL code means there was no response at all — offline,
 * DNS, TLS, a hung server — which is a different answer from any the server
 * could have given, and both callers branch on it.
 */
internal data class BareResponse(val code: Int?, val body: String?)

/**
 * The car's ONE HTTP client, and the only place a Bearer token is attached.
 *
 * Ported from :wear, which ported it from the phone's native ABS client (the
 * patched RNTP MusicService): same "return the body on 2xx, null on anything
 * else, never throw" contract, because every caller here is a browse or
 * playback path where an exception is strictly worse than an empty screen —
 * and on AAOS an empty screen still answers the Media Center inside its
 * ten-second content budget (DR-3) while a crash does not.
 *
 * OkHttp instead of HttpURLConnection so media3's OkHttp datasource can share
 * this exact client, and therefore the auth and the 401 tracking, rather than
 * re-deriving either. The watch's second reason — a Coil image loader — has no
 * analogue here: the car process fetches cover art itself and cannot attach a
 * header, which is why [AbsApi.coverUrl] carries its token in the query string
 * (ARCHITECTURE.md §4.4).
 *
 * A 401 is answered by ONE single-flight refresh and then one retry, per
 * [RefreshPolicy]. The watch additionally treats a 401 as terminal for
 * PHONE-mirrored credentials, which carry an access token alone; there is no
 * such source in a car (see [CredsSource]), so the only terminal 401 is one
 * against a login the server issued no refresh token for.
 *
 * Timeouts are the donor's, ported verbatim: 15 s connect / 30 s read. The
 * patched Android Auto service used 5 s/10 s, and ARCHITECTURE.md §7 keeps that
 * budget for the browse paths — but the thing that makes a tight ceiling safe
 * there is the stale-on-failure browse cache it sits behind, and Wave 3 lands
 * both together. Tightening the socket here first would only turn a slow
 * self-hosted server into no server at all, with nothing to fall back on.
 */
class AbsClient(
    private val credsRepository: CredsRepository,
    private val userAgent: String = DEFAULT_USER_AGENT,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
) {

    // Synchronous mirror of the creds flow. media3's datasource and the browse
    // pool build requests on their own threads and cannot suspend, so the
    // interceptor needs a non-suspending read.
    @Volatile
    private var snapshot: Creds? = null

    // The server origin, parsed once per creds change. The token-attach decision
    // compares scheme/host/port STRUCTURALLY against this — never by string
    // prefix: "http://abs.local" string-prefixes "http://abs.local.attacker.com"
    // and "http://10.0.0.5" prefixes "http://10.0.0.50", either of which would
    // hand the Bearer token to the wrong host.
    @Volatile
    private var serverUrl: HttpUrl? = null

    private val _authFailed = MutableStateFlow(false)

    /** True once the server has rejected our token. Reset by any 2xx and by a creds change. */
    val authFailed: StateFlow<Boolean> = _authFailed.asStateFlow()

    /**
     * Share this — do not build another. Wave 3 hands it to
     * `OkHttpDataSource.Factory`, which is the whole point of decorating
     * requests in an interceptor rather than at call sites.
     */
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(authInterceptor())
        .build()

    /**
     * The BROWSE view of [client]: same interceptor, same connection pool, same
     * dispatcher — only the socket ceilings differ (5 s connect / 10 s read,
     * ARCHITECTURE.md §7, the patched Auto service's budget verbatim).
     *
     * Two ceilings, not one, because the two paths fail differently. A browse
     * fetch sits behind BrowseTree's stale-on-failure cache: giving up at 10 s
     * costs a slightly older folder, while waiting 30 s costs the car's
     * ten-second content budget (DR-3) and shows a spinner instead of a
     * library. A media stream, a download or a progress sync has no such
     * fallback — cutting those off at 10 s on a slow self-hosted server would
     * turn "slow" into "broken", which is why [client] keeps the donor's
     * 15 s/30 s and Wave 3 tightens only what it also made recoverable.
     *
     * `newBuilder()` and not a fresh Builder: a second pool would mean a second
     * set of connections to the same server (and a second set of TLS
     * handshakes) for every folder the user opens.
     */
    private val browseClient: OkHttpClient = client.newBuilder()
        .connectTimeout(BROWSE_CONNECT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(BROWSE_READ_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * A SECOND client, with no interceptor and therefore no token and no 401
     * handling of its own. Both requests that ride it are requests the main
     * client structurally cannot make:
     *  - the REFRESH exchanges a token the server has just rejected. Sent
     *    through the interceptor it would carry that dead token, and its own
     *    401 would re-enter the refresh already running — the recursion is the
     *    trap this client exists to remove.
     *  - the car LOGIN happens before any token exists, and may target a
     *    different origin than the stored credentials — precisely the request a
     *    Bearer header must never decorate.
     *
     * Two clients, not three: the socket timeouts here are per-phase ceilings,
     * and each call additionally caps its TOTAL (the contract's 15s login / 20s
     * refresh) with `Call.timeout()` so a slow connect plus a slow read cannot
     * add up past it. One client means one connection pool and one dispatcher.
     */
    private val bareClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(BARE_CONNECT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(BARE_READ_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(BARE_READ_SECONDS, TimeUnit.SECONDS)
        .build()

    /** Serialises refreshes. Held across the network call — see [refreshBlocking]. */
    private val refreshLock = Any()

    init {
        scope.launch {
            credsRepository.creds.collect { c ->
                snapshot = c
                serverUrl = c?.server?.toHttpUrlOrNull()
                // New credentials (or a logout) invalidate a previous rejection —
                // otherwise signing in again would leave the session wedged in its
                // error state and the Media Center stuck on the Sign in affordance
                // forever.
                _authFailed.value = false
            }
        }
    }

    /**
     * True only when [url] is OUR server: same scheme, same host
     * (case-insensitive, per DNS), same effective port. HttpUrl.port already
     * substitutes the scheme default (80/443), so "http://abs.local" and
     * "http://abs.local:80/x" compare equal while ":8080" does not.
     */
    private fun isOurServer(url: HttpUrl): Boolean {
        val server = serverUrl ?: return false
        return sameOrigin(url, server)
    }

    /** The current server origin, or null when the car is not configured. */
    fun serverOrNull(): String? = snapshot?.server

    /**
     * The current access token, or null when the car is not configured.
     *
     * The one accessor the donor does not have, and it exists for exactly one
     * caller: [AbsApi.coverUrl], whose URL is handed to the Media Center's own
     * process to fetch. That process cannot attach an Authorization header, so
     * the token rides the query string (ARCHITECTURE.md §4.4). Reads the same
     * async mirror [serverOrNull] does — a cover URL built a frame before the
     * mirror fills is a cover that doesn't load, not a wrong request.
     *
     * `internal`, unlike its neighbour: every caller that can ever exist lives
     * in this module, and a plain read of the secret should not become API just
     * because one URL builder needs it.
     */
    internal fun tokenOrNull(): String? = snapshot?.token

    /** Absolute URL for a server-relative path (already-absolute urls pass through). */
    fun resolve(path: String): String? {
        val server = snapshot?.server ?: return null
        return if (path.startsWith("http://") || path.startsWith("https://")) path else server + path
    }

    /**
     * A ready-to-execute authorized request. For consumers that build their own
     * calls (a download stream, a datasource) but must not re-derive the auth.
     * Throws only on a malformed URL — pass something [resolve] produced.
     * The token is attached only when the URL's ORIGIN is our server (see
     * [isOurServer]) — a server-supplied absolute URL to any other host goes
     * out bare.
     */
    fun authorizedRequest(url: String): Request {
        val builder = Request.Builder().url(url).header("User-Agent", userAgent)
        val request = builder.build()
        val creds = snapshot
        return if (creds != null && isOurServer(request.url)) {
            request.newBuilder().header("Authorization", "Bearer ${creds.token}").build()
        } else {
            request
        }
    }

    /**
     * The auth decoration, as an Interceptor so anything sharing [client] gets it.
     * Only OUR server is decorated: one client serves covers, media and API calls,
     * and a Bearer token must never ride a request to some other host.
     *
     * Also the 401 handler for everything on this client — media streams,
     * downloads — which is why the refresh below is gated on the URL's ORIGIN
     * rather than on who attached the header: a download or a datasource
     * arrives here already authorized ([authorizedRequest]) and must renew too.
     */
    fun authInterceptor(): Interceptor = object : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val original = chain.request()
            val creds = snapshot
            val ours = isOurServer(original.url)
            val builder = original.newBuilder().header("User-Agent", userAgent)
            if (creds != null &&
                original.header("Authorization") == null &&
                ours
            ) {
                builder.header("Authorization", "Bearer ${creds.token}")
            }
            var response = chain.proceed(builder.build())

            var refreshAttempted = false
            if (response.code == 401 && ours && creds != null &&
                RefreshPolicy.onUnauthorized(creds) == RefreshPolicy.Action.REFRESH
            ) {
                refreshAttempted = true
                if (refreshBlocking(creds)) {
                    // Closed only once the retry is CERTAIN: the 401's body is
                    // an error page and its connection cannot be reused until it
                    // is released, but a refresh that fails must hand the caller
                    // a readable response rather than a consumed one.
                    response.close()
                    val token = currentTokenBlocking() ?: creds.token
                    response = chain.proceed(
                        builder.header("Authorization", "Bearer $token").build()
                    )
                    // A token minted a second ago and rejected anyway is not
                    // staleness — nothing another refresh could fix.
                    if (response.code == 401) _authFailed.value = true
                }
                // A refresh that failed already applied the definitive-vs-
                // transient rule; a transient one must leave the flag alone so
                // the next request retries.
            }

            when {
                response.isSuccessful -> _authFailed.value = false
                // The rule wherever no refresh was possible: the session is done.
                response.code == 401 && !refreshAttempted -> _authFailed.value = true
            }
            return response
        }
    }

    /**
     * Trades the refresh token for a new access token. Returns true when the
     * caller may retry — either this call renewed the session, or another
     * thread already had.
     *
     * Blocking on purpose: the interceptor runs on OkHttp's own threads, which
     * have no coroutine to suspend in and exist to block on I/O anyway. The
     * DataStore hops go through runBlocking for the same reason; the suspend
     * path reaches this through [refresh], which puts it on Dispatchers.IO
     * first, so there is ONE implementation of the rule.
     *
     * Single-flight: a screenful of covers plus a progress sync can 401
     * together. The lock serialises them and the re-read INSIDE it makes the
     * losers free — the token they were rejected with is already gone, so there
     * is nothing left to refresh. That re-read comes from the STORE, never from
     * [snapshot]: the collector filling the mirror runs on its own coroutine and
     * can still be holding the dead token, and a second refresh would spend a
     * refresh token ABS may have already rotated away — a 401 that would kill a
     * session which is perfectly alive.
     */
    private fun refreshBlocking(creds: Creds): Boolean =
        synchronized(refreshLock) { refreshLocked(creds) }

    /** [refreshBlocking]'s body, with the lock held — split only so it can return plainly. */
    private fun refreshLocked(creds: Creds): Boolean {
        val current = currentCredsBlocking() ?: return false
        if (current.token != creds.token) return true
        val refreshToken = current.refreshToken?.takeIf { it.isNotBlank() } ?: return false

        val response = postBareSync(
            url = current.server + REFRESH_PATH,
            body = JSONObject(),
            timeoutSeconds = REFRESH_TIMEOUT_SECONDS,
            headers = mapOf(HEADER_REFRESH_TOKEN to refreshToken)
        )
        val user = AbsApi.parseObject(response.body)?.optJSONObject("user")
        val access = absAccessToken(user)
        val outcome = RefreshPolicy.classify(response.code, access)
        if (outcome == RefreshPolicy.Outcome.SUCCESS && access != null) {
            // An ABSENT rotation means the token just used still works —
            // updateAccessToken keeps it rather than clearing it.
            runBlocking { credsRepository.updateAccessToken(access, absStr(user, "refreshToken")) }
            return true
        }
        if (RefreshPolicy.isAuthFailure(outcome)) _authFailed.value = true
        return false
    }

    /** [refreshBlocking] from a coroutine. One implementation; this only picks the thread. */
    private suspend fun refresh(creds: Creds): Boolean =
        withContext(Dispatchers.IO) { refreshBlocking(creds) }

    // Authoritative reads, not the async mirror: after a refresh persists, the
    // collector that fills `snapshot` has not necessarily run yet.
    private fun currentCredsBlocking(): Creds? = runBlocking { credsRepository.creds.first() }

    private fun currentTokenBlocking(): String? = currentCredsBlocking()?.token

    /** The mirror the interceptor reads is empty, so it can only have passed a 401 through. */
    private fun interceptorWasBlind(): Boolean = snapshot == null || serverUrl == null

    /**
     * A JSON POST carrying NO credentials, on [bareClient] — the one HTTP path
     * for the two token-free calls. [AbsApi] owns their endpoints and their
     * parsing; the sockets stay here, with the module's other sockets.
     *
     * Never throws: a null [BareResponse.code] IS the "no response at all" case
     * both callers must tell apart from an answer they didn't like.
     */
    private fun postBareSync(
        url: String,
        body: JSONObject,
        timeoutSeconds: Long,
        headers: Map<String, String> = emptyMap()
    ): BareResponse = try {
        val builder = Request.Builder()
            .url(url)
            .header("User-Agent", userAgent)
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
        headers.forEach { (name, value) -> builder.header(name, value) }
        val call = bareClient.newCall(builder.build())
        // The whole-call budget, so a redirect or a retry cannot multiply it.
        call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
        call.execute().use { response ->
            // Read on EVERY code: the failures carry a reason and the success
            // carries the token.
            BareResponse(response.code, response.body?.string())
        }
    } catch (t: Throwable) {
        BareResponse(null, null)
    }

    /** [postBareSync] from a coroutine — the login path. */
    internal suspend fun postBare(url: String, body: JSONObject, timeoutSeconds: Long): BareResponse =
        withContext(Dispatchers.IO) { postBareSync(url, body, timeoutSeconds) }

    suspend fun get(path: String): String? = execute("GET", path, null)

    /**
     * A GET on the BROWSE budget ([browseClient]) — same auth, same 401
     * handling, tighter sockets. `internal` because the only legitimate callers
     * are [AbsApi]'s browse-surface methods, which is where the decision
     * "this fetch is behind the browse cache" is actually made.
     */
    internal suspend fun getBrowse(path: String): String? =
        execute("GET", path, null, browseClient)

    suspend fun postJson(path: String, body: JSONObject): String? =
        execute("POST", path, body.toString().toRequestBody(JSON_MEDIA_TYPE))

    suspend fun patchJson(path: String, body: JSONObject): String? =
        execute("PATCH", path, body.toString().toRequestBody(JSON_MEDIA_TYPE))

    /** ABS's batch progress route takes a BARE array body (see utils/abs/me.ts). */
    suspend fun patchJson(path: String, body: JSONArray): String? =
        execute("PATCH", path, body.toString().toRequestBody(JSON_MEDIA_TYPE))

    /**
     * [http] defaults to [client], so every pre-Wave-3 caller keeps the exact
     * request it always made; the browse surface passes [browseClient] to swap
     * the socket ceilings and nothing else.
     */
    private suspend fun execute(
        method: String,
        path: String,
        body: RequestBody?,
        http: OkHttpClient = client
    ): String? {
        // Read through the flow rather than the snapshot: a call fired during the
        // first frames of a cold start would otherwise see a null snapshot the
        // collector hasn't filled yet and report "not configured".
        val creds = credsRepository.creds.first() ?: return null
        val url = if (path.startsWith("http://") || path.startsWith("https://")) {
            path
        } else {
            creds.server + path
        }
        return withContext(Dispatchers.IO) {
            try {
                val target = url.toHttpUrlOrNull() ?: return@withContext null
                // Origin-checked even here: every AbsApi path is a relative
                // constant today, but an absolute `path` passes straight through
                // the joiner above, and the token must never ride to another host.
                // Checked against THIS call's creds (not the async snapshot) so a
                // cold-start call never goes out bare and 401s spuriously.
                val server = creds.server.toHttpUrlOrNull()
                val authorize = server != null && sameOrigin(target, server)

                var response = http
                    .newCall(request(target, method, body, if (authorize) creds.token else null))
                    .execute()
                // The interceptor answers a 401 for every request on this client.
                // It cannot answer one fired before the credential mirror has
                // filled (cold start) — the single window where it sees no creds
                // and this path already holds them, because it read them through
                // the flow. Same policy, same single-flight core; the mirror
                // check is what keeps the two from BOTH refreshing one 401,
                // which against a hanging server would double the wait.
                if (response.code == 401 && authorize && interceptorWasBlind() &&
                    RefreshPolicy.onUnauthorized(creds) == RefreshPolicy.Action.REFRESH
                ) {
                    if (refresh(creds)) {
                        response.close()
                        val token = credsRepository.creds.first()?.token ?: creds.token
                        response = http.newCall(request(target, method, body, token)).execute()
                    }
                }
                response.use { r ->
                    // A 2xx with an empty body (session close, batch update) is a
                    // success — "" not null, so callers can test for null alone.
                    if (r.isSuccessful) r.body?.string() ?: "" else null
                }
            } catch (t: Throwable) {
                // Offline, DNS, TLS, a malformed server address — all the same
                // answer to every caller: no data this time.
                null
            }
        }
    }

    /**
     * One request, optionally authorized. [body] is always byte-array backed
     * (AbsApi builds it from a JSON string), which is what makes the retry above
     * legal — a streaming body could not be sent twice.
     */
    private fun request(url: HttpUrl, method: String, body: RequestBody?, token: String?): Request {
        val builder = Request.Builder().url(url).method(method, body)
        if (token != null) builder.header("Authorization", "Bearer $token")
        return builder.build()
    }

    companion object {
        const val DEFAULT_USER_AGENT = "TomeSonic-Automotive"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        /** Contract endpoints. Neither is under `/api` — both sit at the root. */
        private const val REFRESH_PATH = "/auth/refresh"
        internal const val LOGIN_PATH = "/login"

        /** The refresh token travels in its OWN header, never as a Bearer. */
        private const val HEADER_REFRESH_TOKEN = "x-refresh-token"

        /** Whole-call budgets from the contract. */
        internal const val LOGIN_TIMEOUT_SECONDS = 15L
        private const val REFRESH_TIMEOUT_SECONDS = 20L

        /** Per-phase ceilings under them, so neither phase can hang on its own. */
        private const val BARE_CONNECT_SECONDS = 15L
        private const val BARE_READ_SECONDS = 20L

        /**
         * The browse budget (ARCHITECTURE.md §7) — the patched Auto service's
         * `connectTimeout = 5000; readTimeout = 10000`, unchanged. Internal so a
         * test can assert the two ceilings are still the ones the contract names.
         */
        internal const val BROWSE_CONNECT_SECONDS = 5L
        internal const val BROWSE_READ_SECONDS = 10L

        /**
         * Origin equality: scheme + host (case-insensitive) + effective port.
         * Internal so tests can pin the exact semantics the token-attach
         * decision rides on.
         */
        internal fun sameOrigin(a: HttpUrl, b: HttpUrl): Boolean =
            a.scheme == b.scheme &&
                a.host.equals(b.host, ignoreCase = true) &&
                a.port == b.port
    }
}
