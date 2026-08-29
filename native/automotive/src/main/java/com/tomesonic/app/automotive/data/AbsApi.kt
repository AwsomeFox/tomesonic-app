package com.tomesonic.app.automotive.data

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
 * What a login attempt answered — the CASE, never the sentence. The strings a
 * user reads live in the UI layer (Wave 4's sign-in view model, whose copy
 * comes verbatim from wear's ConnectViewModel and the phone's ConnectScreen
 * before it); this type exists so the mapping is one `when` instead of a
 * decision spread over a network call.
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
 * Typed wrappers over the ABS endpoints in ARCHITECTURE.md §4.4. Nothing here
 * throws and nothing here reports an error: a failure is an empty list, a null
 * model, or `false`. Distinguishing "offline" from "empty library" is
 * [AbsClient.authFailed]'s job, and the only distinction the car surface can act
 * on is whether to raise the Media Center's Sign in affordance (§6).
 *
 * [login] is the one exception, and has to be: a sign-in screen that answered
 * every failure with silence would be unusable. It is also the one call that
 * runs WITHOUT credentials, against a server the user is still typing.
 *
 * Everything above the "Browse-tree surface" divider is the wear donor,
 * unchanged in behavior. Below it are the endpoints §4.4 adds on top of that
 * surface (`/personalized`, `/authors`, `/series`, `/collections`, the
 * cross-library search) — added by Wave 3 for BrowseTree, on the browse socket
 * budget and returning org.json rows rather than models, for the reasons the
 * divider's comment gives.
 */
class AbsApi(
    private val client: AbsClient,
    private val credsRepository: CredsRepository,
    private val clientVersion: String = "0"
) {

    /**
     * The car's own sign-in. `POST {server}/login`, exactly as the phone does
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

    /** Book and podcast libraries only — the car can't do anything with the rest. */
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
     * empty on purpose — their callers re-fetch wholesale.)
     */
    suspend fun libraryItems(libraryId: String, page: Int = 0, limit: Int = 50): List<ItemSummary>? {
        val path = "/api/libraries/${enc(libraryId)}/items" +
            "?limit=$limit&page=$page&minified=1&sort=media.metadata.title"
        val root = parseObject(client.get(path)) ?: return null
        return summaries(root.optJSONArray("results"))
    }

    /**
     * One library's search. `book` results then `podcast` results, server order,
     * capped at [limit] — a car browse row is a glance, not a result page.
     *
     * NULL means the REQUEST failed, exactly as in [libraryItems]; an empty list
     * means the server answered and nothing matched. The caller spends that
     * difference on a retry rather than on "No matches".
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
     * timeListening, so re-sending a grown day total is idempotent — Wave 3's
     * queue builds the body (`automotive-local_…` ids, never the phone's
     * `local_…` or the watch's `wear-local_…`; ARCHITECTURE.md §1).
     */
    suspend fun syncLocalSession(body: JSONObject): Boolean =
        client.postJson("/api/session/local", body) != null

    /** Offline positions. The body is the BARE array — verified in utils/abs/me.ts. */
    suspend fun batchUpdateProgress(payloads: JSONArray): Boolean =
        client.patchJson("/api/me/progress/batch/update", payloads) != null

    /**
     * Cover URL, with the token in the QUERY STRING.
     *
     * The one behavioral divergence from the wear donor, and it is the
     * contract's (ARCHITECTURE.md §4.4): the watch hands cover URLs to Coil,
     * which fetches them through [AbsClient.client] and therefore inherits the
     * Authorization header, so wear deliberately keeps its URLs log-safe. A car
     * cover URL goes into a MediaItem's artworkUri and is fetched by the MEDIA
     * CENTER's process, which cannot attach a header to it — a bare URL is
     * simply a cover that 401s. Null when the car isn't configured; the token
     * is omitted (not blanked) if the credential mirror hasn't filled yet.
     */
    fun coverUrl(itemId: String, width: Int = 240): String? {
        val server = client.serverOrNull() ?: return null
        val base = "$server/api/items/${enc(itemId)}/cover?width=$width&format=webp"
        val token = client.tokenOrNull()?.takeIf { it.isNotBlank() } ?: return base
        return "$base&token=${enc(token)}"
    }

    // ================= Browse-tree surface (ARCHITECTURE.md §4.4) =========
    //
    // Two things are deliberately different below this line.
    //
    // 1. Every fetch rides [AbsClient.getBrowse] — the 5 s connect / 10 s read
    //    budget of §7. These calls sit behind BrowseTree's stale-on-failure
    //    cache, which is the thing that makes a tight ceiling safe: a fetch
    //    that gives up serves a slightly older folder instead of spending the
    //    car's ten-second content budget (DR-3) on a spinner.
    //
    // 2. They return org.json rows, not the typed models above, and that is not
    //    laziness. The browse tree reads a WIDER set of fields than any model
    //    here carries — a library's server-assigned `icon`, an author's
    //    `numBooks`, a series entry's `sequence` and its first book's author, a
    //    progress row's `isFinished` — and every one of those reads is a
    //    byte-level port of the shipped Android Auto tree. Typing them would
    //    mean inventing six models whose only consumer is one file, and would
    //    put a second parse (and a second chance to diverge) between the donor
    //    and the port. The endpoint, the query string and the envelope key stay
    //    here, with the module's other HTTP; the field reads stay in BrowseTree,
    //    with the donor they came from.
    //
    // A null return keeps its meaning from the typed surface: the REQUEST
    // failed. An empty array means the server answered with nothing, and the
    // browse cache spends that difference (a failure serves stale, an empty
    // answer replaces).

    /** `GET /api/libraries` -> the `libraries` rows, `icon` and all. */
    suspend fun libraryRows(): JSONArray? =
        parseObject(client.getBrowse("/api/libraries"))?.optJSONArray("libraries")

    /**
     * `GET /api/libraries/{id}/items` -> the `results` rows, always minified.
     *
     * One method for every item list the tree draws (Recently Added, All Books,
     * Listen Again, an author's books, a series' books, a podcast library's
     * shows), because they differ only in filter, sort and cap.
     * [filterType]/[filterValue] are the ABS library-item filter pair — the
     * VALUE is base64'd and url-encoded here (see [absB64]), so callers pass
     * the raw entity id.
     */
    suspend fun itemRows(
        libraryId: String,
        limit: Int,
        filterType: String? = null,
        filterValue: String? = null,
        sort: String? = null,
        desc: Boolean = false
    ): JSONArray? {
        val path = StringBuilder("/api/libraries/${enc(libraryId)}/items?limit=$limit&minified=1")
        if (filterType != null && filterValue != null) {
            path.append("&filter=$filterType.${absB64(filterValue)}")
        }
        if (sort != null) path.append("&sort=$sort")
        if (desc) path.append("&desc=1")
        return results(client.getBrowse(path.toString()))
    }

    /** `GET /api/libraries/{id}/authors` -> the `authors` rows (name + numBooks). */
    suspend fun authors(libraryId: String): JSONArray? =
        parseObject(client.getBrowse("/api/libraries/${enc(libraryId)}/authors"))
            ?.optJSONArray("authors")

    /**
     * `GET /api/libraries/{id}/series` -> the `results` rows.
     *
     * Minified, but the rows still carry `books` — which is where the series
     * list gets the author it labels each row with, and where the
     * continue-series resolver gets its name -> id mapping.
     */
    suspend fun series(libraryId: String, limit: Int, sort: String? = null): JSONArray? {
        val path = StringBuilder("/api/libraries/${enc(libraryId)}/series?limit=$limit&minified=1")
        if (sort != null) path.append("&sort=$sort")
        return results(client.getBrowse(path.toString()))
    }

    /** `GET /api/libraries/{id}/collections` -> the `results` rows. */
    suspend fun collections(libraryId: String, limit: Int = 200): JSONArray? =
        results(client.getBrowse("/api/libraries/${enc(libraryId)}/collections?limit=$limit&minified=1"))

    /** `GET /api/collections/{id}` -> its `books`. Note: NOT a `results` envelope. */
    suspend fun collection(collectionId: String): JSONArray? =
        parseObject(client.getBrowse("/api/collections/${enc(collectionId)}"))
            ?.optJSONArray("books")

    /**
     * `GET /api/libraries/{id}/personalized` -> the shelves, as a BARE array
     * (no envelope). The tree wants the one whose `id` is `continue-series`.
     */
    suspend fun personalized(libraryId: String, limit: Int = 25): JSONArray? =
        parseArray(client.getBrowse("/api/libraries/${enc(libraryId)}/personalized?limit=$limit"))

    /**
     * `GET /api/me/items-in-progress` -> the `libraryItems` rows.
     *
     * The raw twin of [itemsInProgress]: Continue Listening needs `media` (to
     * filter ebook-only items) and `media.metadata.seriesName` (to find the
     * series you are mid-way through), neither of which [ItemSummary] carries.
     */
    suspend fun itemsInProgressRows(limit: Int = 25): JSONArray? =
        parseObject(client.getBrowse("/api/me/items-in-progress?limit=$limit"))
            ?.optJSONArray("libraryItems")

    /**
     * `GET /api/me` -> the `mediaProgress` rows: every position this user has,
     * in one request. The browse tree needs progress for nearly every row it
     * draws, and one cached fetch beats a per-item lookup on a flaky car link.
     */
    suspend fun mediaProgressRows(): JSONArray? =
        parseObject(client.getBrowse("/api/me"))?.optJSONArray("mediaProgress")

    /**
     * The expanded item, on the browse budget — the podcast folder's episode
     * list. Typed, unlike its neighbours here, because [ItemDetail] already
     * parses exactly what that folder draws (the show's title and its
     * episodes' id/title/publishedAt) and is already under test.
     */
    suspend fun podcastItem(itemId: String): ItemDetail? =
        ItemDetail.fromJson(parseObject(client.getBrowse("/api/items/${enc(itemId)}?expanded=1")))

    /**
     * Cross-library search (§4.4) -> the matched `libraryItem` rows, in
     * library order then server order.
     *
     * A fan-out over `GET /api/libraries/{id}/search`, which is what the donor
     * does and what ABS actually serves; the contract's one-line `/search?q=`
     * names the SURFACE, not a single endpoint. Books only, deliberately: this
     * feeds voice search (VC-1), where "play <title>" means an audiobook.
     *
     * Null only when the LIBRARY LIST could not be fetched — a library whose
     * own search fails costs that library's hits, not the whole query, exactly
     * as the donor's `continue` does. Rows are NOT de-duplicated here: the
     * caller drops repeats while it filters and builds, in one pass.
     */
    suspend fun searchAll(query: String, limit: Int = BROWSE_SEARCH_LIMIT): JSONArray? {
        val libraries = libraryRows() ?: return null
        val out = JSONArray()
        val q = enc(query)
        for (i in 0 until libraries.length()) {
            val libId = absStr(libraries.optJSONObject(i), "id") ?: continue
            val body = client.getBrowse("/api/libraries/${enc(libId)}/search?q=$q&limit=$limit")
            val books = parseObject(body)?.optJSONArray("book") ?: continue
            for (j in 0 until books.length()) {
                books.optJSONObject(j)?.optJSONObject("libraryItem")?.let { out.put(it) }
            }
        }
        return out
    }

    /** The `results` envelope every library-scoped list answers with. */
    private fun results(raw: String?): JSONArray? = parseObject(raw)?.optJSONArray("results")

    private fun summaries(arr: JSONArray?): List<ItemSummary> {
        val a = arr ?: return emptyList()
        val out = ArrayList<ItemSummary>(a.length())
        for (i in 0 until a.length()) {
            ItemSummary.fromJson(a.optJSONObject(i))?.let { out.add(it) }
        }
        return out
    }

    companion object {
        /** Frozen client identity — ARCHITECTURE.md §1. */
        const val CLIENT_NAME = "TomeSonic Automotive"
        const val MEDIA_PLAYER = "exo-player"

        /** One screenful of results, per the contract's `limit=12`. */
        const val SEARCH_LIMIT = 12

        /**
         * The browse/voice search cap, PER LIBRARY — the donor's `limit=20`.
         * Higher than [SEARCH_LIMIT] on purpose: this one is merged across
         * libraries and then paged by the car, rather than being one row.
         */
        const val BROWSE_SEARCH_LIMIT = 20

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
         * problem, because nothing else the app could say would be truer.
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
                // Absent on servers with refresh disabled. The login then simply
                // has no refresh path and its 401s stay terminal.
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
                // indistinguishable from "no data" as far as the car cares.
                null
            }
        }

        /**
         * A response that is a BARE array — `/personalized` is the only one.
         * Same contract as [parseObject]: a body that isn't the shape asked for
         * is indistinguishable from no data.
         */
        fun parseArray(raw: String?): JSONArray? {
            val body = raw ?: return null
            return try {
                JSONArray(body)
            } catch (t: Throwable) {
                null
            }
        }

        /**
         * An ABS library-item filter value: base64 of the entity id, then
         * url-encoded — what the web client sends, ported verbatim from the
         * donor's `absB64`. NO_WRAP matters: the default inserts newlines,
         * which url-encode into `%0A` and make the server match nothing.
         *
         * Internal so a test can pin the exact encoding without a live server —
         * a filter the server can't parse silently returns the WHOLE library,
         * which looks like a working screen full of the wrong books.
         */
        internal fun absB64(s: String): String =
            URLEncoder.encode(
                android.util.Base64.encodeToString(
                    s.toByteArray(Charsets.UTF_8),
                    android.util.Base64.NO_WRAP
                ),
                "UTF-8"
            )

        /**
         * One path segment. URLEncoder is form-encoding, so its "+" for a space
         * has to be repaired — ABS ids never contain one, but a caller-supplied
         * session id might.
         */
        fun enc(segment: String): String =
            URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
    }
}
