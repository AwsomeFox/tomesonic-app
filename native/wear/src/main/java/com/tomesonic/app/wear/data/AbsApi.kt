package com.tomesonic.app.wear.data

import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

/**
 * `user.accessToken ?: user.token` — new servers answer the first, older ones
 * only the second, and the phone reads exactly this pair
 * (screens/ConnectScreen.tsx `finishLogin`). `/login` and `/auth/refresh`
 * answer in the same envelope, which is why this sits outside both parsers.
 */
internal fun absAccessToken(user: JSONObject?): String? =
    absStr(user, "accessToken") ?: absStr(user, "token")

/**
 * What a watch login attempt answered — the CASE, never the sentence. The
 * strings a user reads live in the UI layer (ui/WatchLogin.kt) with the rest of
 * the copy; this type exists so the mapping is one `when` instead of a decision
 * spread over a network call.
 */
sealed interface LoginResult {

    data class Success(
        val server: String,
        val token: String,
        val refreshToken: String?,
        val userId: String,
        val username: String
    ) : LoginResult

    /** 401/403 — and, per the phone, every other 4xx that isn't 429. */
    data object BadCredentials : LoginResult

    data object RateLimited : LoginResult

    /** 5xx, and a 200 whose body carried no token at all. */
    data object ServerError : LoginResult

    /** NO response: offline, DNS, TLS, a timeout, an address that isn't one. */
    data object Unreachable : LoginResult
}

/**
 * Typed wrappers over the exact ABS endpoints in native/wear/ARCHITECTURE.md's
 * "ABS API surface" section. Nothing here throws and nothing here reports an
 * error: a failure is an empty list, a null model, or `false`. Distinguishing
 * "offline" from "empty library" is [AbsClient.authFailed]'s job, and the only
 * distinction the watch UI can act on is "reconnect from phone".
 *
 * [login] is the one exception, and has to be: a sign-in screen that answered
 * every failure with silence would be unusable. It is also the one call that
 * runs WITHOUT credentials, against a server the user is still typing.
 */
class AbsApi(
    private val client: AbsClient,
    private val credsRepository: CredsRepository,
    private val clientVersion: String = "0"
) {

    /**
     * The watch's own sign-in. `POST {server}/login`, exactly as the phone does
     * it (screens/ConnectScreen.tsx `handleLogin`).
     *
     * Rides AbsClient's BARE client: there is no token yet, and [server] may be
     * a different origin than any stored credentials — the one request in this
     * module a Bearer header must never touch.
     *
     * [password] is read here and nowhere else: it is not stored, not logged,
     * and not part of the result.
     */
    suspend fun login(server: String, username: String, password: String): LoginResult {
        val normalized = CredsRepository.normalizeServer(server)
        if (normalized.isEmpty()) return LoginResult.Unreachable
        val body = JSONObject()
            .put("username", username.trim())
            .put("password", password)
        val response = client.postBare(
            normalized + AbsClient.LOGIN_PATH,
            body,
            AbsClient.LOGIN_TIMEOUT_SECONDS
        )
        return parseLogin(normalized, response.code, response.body)
    }

    /** Book and podcast libraries only — the watch can't do anything with the rest. */
    suspend fun libraries(): List<LibrarySummary> {
        val root = parseObject(client.get("/api/libraries")) ?: return emptyList()
        val arr = root.optJSONArray("libraries") ?: return emptyList()
        val out = ArrayList<LibrarySummary>(arr.length())
        for (i in 0 until arr.length()) {
            val lib = LibrarySummary.fromJson(arr.optJSONObject(i)) ?: continue
            if (lib.mediaType == "book" || lib.mediaType == "podcast") out.add(lib)
        }
        return out
    }

    /**
     * `page` is ZERO-based, matching ABS. Sorted by title so paging is stable.
     *
     * NULL means the REQUEST failed (offline, 401, malformed body); an empty
     * list means the server answered and the page is genuinely empty. Paging
     * needs the difference: a transient failure must stay retryable, while a
     * real empty page is end-of-list. (The other list calls collapse both to
     * empty on purpose — their screens re-fetch wholesale.)
     */
    suspend fun libraryItems(libraryId: String, page: Int = 0, limit: Int = 50): List<ItemSummary>? {
        val path = "/api/libraries/${enc(libraryId)}/items" +
            "?limit=$limit&page=$page&minified=1&sort=media.metadata.title"
        val root = parseObject(client.get(path)) ?: return null
        return summaries(root.optJSONArray("results"))
    }

    /**
     * One library's search. `book` results then `podcast` results, server order,
     * capped at [limit] — a watch list is a glance, not a result page.
     *
     * NULL means the REQUEST failed, exactly as in [libraryItems]; an empty list
     * means the server answered and nothing matched. The search screen spends
     * that difference on a retry chip rather than on "No matches".
     */
    suspend fun search(
        libraryId: String,
        query: String,
        limit: Int = SEARCH_LIMIT
    ): List<ItemSummary>? {
        val path = "/api/libraries/${enc(libraryId)}/search?q=${enc(query)}&limit=$limit"
        return parseSearch(client.get(path), limit)
    }

    /** Continue Listening. Podcast rows carry `recentEpisode` -> ItemSummary.episodeId. */
    suspend fun itemsInProgress(limit: Int = 15): List<ItemSummary> {
        val root = parseObject(client.get("/api/me/items-in-progress?limit=$limit"))
            ?: return emptyList()
        return summaries(root.optJSONArray("libraryItems"))
    }

    suspend fun itemExpanded(itemId: String): ItemDetail? =
        ItemDetail.fromJson(parseObject(client.get("/api/items/${enc(itemId)}?expanded=1")))

    /**
     * Opens a server-side play session. The response's `contentUrl`s are
     * server-relative and stream with the Authorization header; HLS transcode
     * sessions come back in the same shape.
     */
    suspend fun startPlaySession(itemId: String, episodeId: String? = null): PlaySession? {
        val path = if (episodeId.isNullOrEmpty()) {
            "/api/items/${enc(itemId)}/play"
        } else {
            "/api/items/${enc(itemId)}/play/${enc(episodeId)}"
        }
        val body = playSessionBody(credsRepository.deviceId(), clientVersion)
        return PlaySession.fromJson(parseObject(client.postJson(path, body)))
    }

    /** Every 15s while playing, on pause, and on stop. */
    suspend fun syncSession(
        sessionId: String,
        currentTime: Double,
        timeListened: Double,
        duration: Double
    ): Boolean = client.postJson(
        "/api/session/${enc(sessionId)}/sync",
        syncBody(currentTime, timeListened, duration)
    ) != null

    /**
     * Closes the session — the phone does exactly this on every book switch and
     * on stop (utils/progressSync.closeSession), and skipping it leaks an open
     * ABS session plus up to 15s of listening stats per switch.
     */
    suspend fun closeSession(
        sessionId: String,
        currentTime: Double,
        timeListened: Double,
        duration: Double
    ): Boolean = client.postJson(
        "/api/session/${enc(sessionId)}/close",
        syncBody(currentTime, timeListened, duration)
    ) != null

    /**
     * Offline listening time. ABS upserts by session id and REPLACES
     * timeListening, so re-sending a grown day total is idempotent — Wave 3A's
     * queue builds the body (`wear-local_…` ids, never the phone's `local_…`).
     */
    suspend fun syncLocalSession(body: JSONObject): Boolean =
        client.postJson("/api/session/local", body) != null

    /** Offline positions. The body is the BARE array — verified in utils/abs/me.ts. */
    suspend fun batchUpdateProgress(payloads: JSONArray): Boolean =
        client.patchJson("/api/me/progress/batch/update", payloads) != null

    /**
     * Cover URL for Coil, which fetches it through the SAME authorized client —
     * hence no `token=` query param (the phone appends one; the watch keeps
     * URLs log-safe per the contract). Null when the watch isn't configured.
     */
    fun coverUrl(itemId: String, width: Int = 240): String? {
        val server = client.serverOrNull() ?: return null
        return "$server/api/items/${enc(itemId)}/cover?width=$width&format=webp"
    }

    private fun summaries(arr: JSONArray?): List<ItemSummary> {
        val a = arr ?: return emptyList()
        val out = ArrayList<ItemSummary>(a.length())
        for (i in 0 until a.length()) {
            ItemSummary.fromJson(a.optJSONObject(i))?.let { out.add(it) }
        }
        return out
    }

    companion object {
        const val CLIENT_NAME = "TomeSonic Wear"
        const val MEDIA_PLAYER = "exo-player"

        /** One screenful of results, per the contract's `limit=12`. */
        const val SEARCH_LIMIT = 12

        /** Books first, then podcasts — the merge order IS the contract. */
        private val SEARCH_SECTIONS = listOf("book", "podcast")

        /**
         * `/search` answers `{book:[{libraryItem,…}], podcast:[{libraryItem,…}]}` —
         * the wrapper shape native/utils/formatSwitch.ts already consumes, and
         * the reason these rows can't go through [summaries]. Podcast rows carry
         * no `recentEpisode` here, so their episodeId stays null.
         *
         * A row that isn't that shape costs its row; a body that isn't JSON
         * costs the whole call (null). Internal so the merge order and the cap
         * are pinned by a test rather than by a live server.
         */
        internal fun parseSearch(raw: String?, limit: Int): List<ItemSummary>? {
            val root = parseObject(raw) ?: return null
            if (limit <= 0) return emptyList()
            val out = ArrayList<ItemSummary>(limit)
            for (section in SEARCH_SECTIONS) {
                val arr = root.optJSONArray(section) ?: continue
                for (i in 0 until arr.length()) {
                    if (out.size >= limit) return out
                    val row = arr.optJSONObject(i) ?: continue
                    ItemSummary.fromJson(row.optJSONObject("libraryItem"))?.let { out.add(it) }
                }
            }
            return out
        }

        /**
         * `POST /login` reduced to a case. [code] is null when there was NO
         * response at all — the distinction between "the server said no" and
         * "there was no server" is the whole difference between two very
         * different instructions to the user.
         *
         * The order and the buckets are the phone's ConnectScreen mapping,
         * including its fallback: any other non-2xx reads as a credentials
         * problem, because nothing else the watch could say would be truer.
         *
         * Internal so both success shapes and all four failures are pinned by
         * fixtures rather than by a live server.
         */
        internal fun parseLogin(server: String, code: Int?, raw: String?): LoginResult {
            val status = code ?: return LoginResult.Unreachable
            return when {
                status == 401 || status == 403 -> LoginResult.BadCredentials
                status == 429 -> LoginResult.RateLimited
                status >= 500 -> LoginResult.ServerError
                status == 200 -> loginSuccess(server, raw)
                else -> LoginResult.BadCredentials
            }
        }

        private fun loginSuccess(server: String, raw: String?): LoginResult {
            val user = parseObject(raw)?.optJSONObject("user")
            // A 200 with no token is not an authentication answer: a proxy in
            // front of ABS that rewrote the body, or an interstitial page from
            // one the request never got past. Calling it bad credentials would
            // send the user to change a password that was never wrong.
            val token = absAccessToken(user) ?: return LoginResult.ServerError
            return LoginResult.Success(
                server = server,
                token = token,
                // Absent on servers with refresh disabled. The watch login then
                // simply has no refresh path and its 401s stay terminal.
                refreshToken = absStr(user, "refreshToken"),
                userId = absStr(user, "id").orEmpty(),
                username = absStr(user, "username").orEmpty()
            )
        }

        /**
         * Verbatim from store/usePlaybackStore.ts. Telling the server what we can
         * direct-play is what makes it return real tracks instead of an empty set.
         */
        val SUPPORTED_MIME_TYPES = listOf(
            "audio/flac",
            "audio/mpeg",
            "audio/mp3",
            "audio/mp4",
            "audio/m4a",
            "audio/m4b",
            "audio/aac",
            "audio/ogg",
            "audio/opus",
            "audio/webm",
            "audio/x-m4a"
        )

        /**
         * The `/play` request body. Pure and parameterised (Build fields are
         * defaults, not reads baked into the middle) so its shape is pinned by a
         * test rather than by a server round trip.
         */
        fun playSessionBody(
            deviceId: String,
            clientVersion: String,
            manufacturer: String = Build.MANUFACTURER,
            model: String = Build.MODEL,
            sdkVersion: Int = Build.VERSION.SDK_INT
        ): JSONObject {
            val deviceInfo = JSONObject()
                .put("deviceId", deviceId)
                .put("clientName", CLIENT_NAME)
                .put("clientVersion", clientVersion)
                .put("manufacturer", manufacturer)
                .put("model", model)
                .put("sdkVersion", sdkVersion)
            val mimeTypes = JSONArray()
            SUPPORTED_MIME_TYPES.forEach { mimeTypes.put(it) }
            return JSONObject()
                .put("deviceInfo", deviceInfo)
                .put("supportedMimeTypes", mimeTypes)
                .put("mediaPlayer", MEDIA_PLAYER)
                .put("forceDirectPlay", false)
                .put("forceTranscode", false)
        }

        fun syncBody(currentTime: Double, timeListened: Double, duration: Double): JSONObject =
            // absFinite: JSONObject.put THROWS on NaN/Infinity, and a player
            // reports both while a track is being torn down.
            JSONObject()
                .put("currentTime", absFinite(currentTime))
                .put("timeListened", absFinite(timeListened))
                .put("duration", absFinite(duration))

        fun parseObject(raw: String?): JSONObject? {
            val body = raw ?: return null
            return try {
                JSONObject(body)
            } catch (t: Throwable) {
                // An HTML error page from a reverse proxy, a truncated response —
                // indistinguishable from "no data" as far as the watch cares.
                null
            }
        }

        /**
         * One path segment. URLEncoder is form-encoding, so its "+" for a space
         * has to be repaired — ABS ids never contain one, but a caller-supplied
         * session id might.
         */
        fun enc(segment: String): String =
            URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
    }
}
