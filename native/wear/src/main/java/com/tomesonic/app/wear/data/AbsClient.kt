package com.tomesonic.app.wear.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
 * The watch's ONE HTTP client, and the only place a Bearer token is attached.
 *
 * Ported from the phone's native ABS client (the patched RNTP MusicService):
 * same "return the body on 2xx, null on anything else, never throw" contract,
 * because every caller here is a UI or playback path where an exception is
 * strictly worse than an empty screen. Two things deliberately differ:
 *  - OkHttp instead of HttpURLConnection, so media3's OkHttp datasource and
 *    Coil share this exact client (and therefore the auth + the 401 tracking).
 *  - No token refresh. v1 never holds a refresh token — a 401 is terminal and
 *    surfaces as [authFailed], which the UI renders as "reconnect from phone".
 *
 * Timeouts are longer than the car client's (15s/30s vs 5s/10s): there is no
 * stale browse cache to fall back on here, and a watch on a weak BT/WiFi link
 * is genuinely slow rather than broken.
 */
class AbsClient(
    private val credsRepository: CredsRepository,
    private val userAgent: String = DEFAULT_USER_AGENT,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
) {

    // Synchronous mirror of the creds flow. Coil's fetchers and media3's
    // datasource build requests on their own threads and cannot suspend, so the
    // interceptor needs a non-suspending read.
    @Volatile
    private var snapshot: Creds? = null

    private val _authFailed = MutableStateFlow(false)

    /** True once the server has rejected our token. Reset by any 2xx and by a creds change. */
    val authFailed: StateFlow<Boolean> = _authFailed.asStateFlow()

    /**
     * Share this — do not build another. Wave 3A/4A hand it to
     * `OkHttpDataSource.Factory` and Coil's `ImageLoader`, which is the whole
     * point of decorating requests in an interceptor rather than at call sites.
     */
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(authInterceptor())
        .build()

    init {
        scope.launch {
            credsRepository.creds.collect { c ->
                snapshot = c
                // New credentials (or a logout) invalidate a previous rejection —
                // otherwise reconnecting from the phone leaves the watch stuck on
                // the "reconnect" screen forever.
                _authFailed.value = false
            }
        }
    }

    /** The current server origin, or null when the watch is not configured. */
    fun serverOrNull(): String? = snapshot?.server

    /** Absolute URL for a server-relative path (already-absolute urls pass through). */
    fun resolve(path: String): String? {
        val server = snapshot?.server ?: return null
        return if (path.startsWith("http://") || path.startsWith("https://")) path else server + path
    }

    /**
     * A ready-to-execute authorized request. For consumers that build their own
     * calls (a download stream, a datasource) but must not re-derive the auth.
     * Throws only on a malformed URL — pass something [resolve] produced.
     */
    fun authorizedRequest(url: String): Request {
        val builder = Request.Builder().url(url).header("User-Agent", userAgent)
        snapshot?.let { builder.header("Authorization", "Bearer ${it.token}") }
        return builder.build()
    }

    /**
     * The auth decoration, as an Interceptor so anything sharing [client] gets it.
     * Only OUR server is decorated: one client serves covers, media and API calls,
     * and a Bearer token must never ride a request to some other host.
     */
    fun authInterceptor(): Interceptor = object : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val original = chain.request()
            val creds = snapshot
            val builder = original.newBuilder().header("User-Agent", userAgent)
            if (creds != null &&
                original.header("Authorization") == null &&
                original.url.toString().startsWith(creds.server)
            ) {
                builder.header("Authorization", "Bearer ${creds.token}")
            }
            val response = chain.proceed(builder.build())
            when {
                response.code == 401 -> _authFailed.value = true
                response.isSuccessful -> _authFailed.value = false
            }
            return response
        }
    }

    suspend fun get(path: String): String? = execute("GET", path, null)

    suspend fun postJson(path: String, body: JSONObject): String? =
        execute("POST", path, body.toString().toRequestBody(JSON_MEDIA_TYPE))

    suspend fun patchJson(path: String, body: JSONObject): String? =
        execute("PATCH", path, body.toString().toRequestBody(JSON_MEDIA_TYPE))

    /** ABS's batch progress route takes a BARE array body (see utils/abs/me.ts). */
    suspend fun patchJson(path: String, body: JSONArray): String? =
        execute("PATCH", path, body.toString().toRequestBody(JSON_MEDIA_TYPE))

    private suspend fun execute(method: String, path: String, body: RequestBody?): String? {
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
                val request = Request.Builder()
                    .url(url)
                    .header("Authorization", "Bearer ${creds.token}")
                    .method(method, body)
                    .build()
                client.newCall(request).execute().use { response ->
                    // A 2xx with an empty body (session close, batch update) is a
                    // success — "" not null, so callers can test for null alone.
                    if (response.isSuccessful) response.body?.string() ?: "" else null
                }
            } catch (t: Throwable) {
                // Offline, DNS, TLS, a malformed server address — all the same
                // answer to every caller: no data this time.
                null
            }
        }
    }

    companion object {
        const val DEFAULT_USER_AGENT = "TomeSonic-Wear"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
