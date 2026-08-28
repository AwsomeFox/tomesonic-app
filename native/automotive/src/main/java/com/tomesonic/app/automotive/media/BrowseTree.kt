package com.tomesonic.app.automotive.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
import com.tomesonic.app.automotive.data.AbsApi
import com.tomesonic.app.automotive.data.ItemDetail
import com.tomesonic.app.automotive.data.absStr
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "BrowseTree"

/**
 * One downloaded row, as the browse tree needs it — and nothing more.
 *
 * The tree's own view of a download, NOT the download index's record: it names
 * the four things a browse row is built from and the one predicate that decides
 * whether the row can exist at all. Keeping it here (rather than importing the
 * downloads module's entry type) is what lets Wave 3's two halves land
 * independently and lets every test in this file run without a download index.
 *
 * The mapping from the sibling module's `DownloadEntry` is mechanical —
 * `id`/`title`/`author`/`coverPath`/`libraryItemId`/`episodeId` are the same
 * fields, and [playable] is its `tracks.isNotEmpty()`.
 */
data class BrowseDownload(
    /** The entry key: a book's is its item id, an episode's is a composite. */
    val id: String,
    val title: String,
    val author: String?,
    /** A local `file://` path or bare `/path`; anything else is left alone. */
    val coverPath: String?,
    /** The ABS item this belongs to. Equals [id] for a book. */
    val libraryItemId: String = id,
    /** Null for a book; the podcast episode's id otherwise. */
    val episodeId: String? = null,
    /**
     * Whether local audio actually exists for this entry. False for a
     * badge-only record (a legacy mirror row, or an entry whose files were
     * evicted): it still earns a download badge on an online row, but it must
     * never appear in the offline Downloads folder as something tappable.
     */
    val playable: Boolean = true
)

/**
 * Where the Downloads folder gets its rows.
 *
 * A `fun interface` with an empty default so this file compiles, tests, and
 * ships correctness on its own: Wave 3's downloads module lands beside it and
 * the coordinator supplies the one-line adapter over the download index. The
 * tree deliberately cannot reach into a repository — it asks for a list, and
 * everything about WHEN that list is valid stays on the other side of the seam.
 *
 * Called on a browse-pool thread, once per uncached folder load, so it must be
 * an in-memory snapshot and not a disk scan.
 */
fun interface DownloadsSource {
    fun downloads(): List<BrowseDownload>
}

/**
 * Everything the tree fetches, as one blocking interface.
 *
 * Blocking because the browse pool's threads exist to block on I/O (media3
 * calls the browse callbacks on the main thread; the pool is what keeps them
 * off it), and an interface because it is the seam that lets the cache windows,
 * the orderings, the budgets and the offline shape be pinned by JVM tests
 * without a server. [AbsBrowseApi] is the one production implementation.
 *
 * Every method answers null for "the request failed" and an empty array for
 * "the server answered with nothing" — the difference the browse cache spends
 * on stale-vs-replace.
 */
interface BrowseApi {
    fun libraries(): JSONArray?
    fun items(
        libraryId: String,
        limit: Int,
        filterType: String? = null,
        filterValue: String? = null,
        sort: String? = null,
        desc: Boolean = false
    ): JSONArray?
    fun authors(libraryId: String): JSONArray?
    fun series(libraryId: String, limit: Int, sort: String? = null): JSONArray?
    fun collections(libraryId: String): JSONArray?
    fun collection(collectionId: String): JSONArray?
    fun personalized(libraryId: String, limit: Int = 25): JSONArray?
    fun itemsInProgress(limit: Int = 25): JSONArray?
    fun mediaProgress(): JSONArray?
    fun podcastItem(itemId: String): ItemDetail?
    fun search(query: String): JSONArray?

    /** The cover URL for a row, token in the query string (ARCHITECTURE.md §4.4). */
    fun coverUrl(itemId: String): String?
}

/**
 * [BrowseApi] over the real [AbsApi] — the browse socket budget, and the one
 * place a suspend data layer meets a blocking browse pool.
 *
 * `runBlocking` on a pool thread and nowhere else: the alternative is making
 * every node of the tree a suspend function and then bridging in the media3
 * callbacks anyway, which moves the same block one frame closer to the main
 * thread. AbsClient already does exactly this for the same reason (its OkHttp
 * interceptor cannot suspend).
 */
class AbsBrowseApi(private val api: AbsApi) : BrowseApi {

    override fun libraries(): JSONArray? = runBlocking { api.libraryRows() }

    override fun items(
        libraryId: String,
        limit: Int,
        filterType: String?,
        filterValue: String?,
        sort: String?,
        desc: Boolean
    ): JSONArray? = runBlocking { api.itemRows(libraryId, limit, filterType, filterValue, sort, desc) }

    override fun authors(libraryId: String): JSONArray? = runBlocking { api.authors(libraryId) }

    override fun series(libraryId: String, limit: Int, sort: String?): JSONArray? =
        runBlocking { api.series(libraryId, limit, sort) }

    override fun collections(libraryId: String): JSONArray? =
        runBlocking { api.collections(libraryId) }

    override fun collection(collectionId: String): JSONArray? =
        runBlocking { api.collection(collectionId) }

    override fun personalized(libraryId: String, limit: Int): JSONArray? =
        runBlocking { api.personalized(libraryId, limit) }

    override fun itemsInProgress(limit: Int): JSONArray? =
        runBlocking { api.itemsInProgressRows(limit) }

    override fun mediaProgress(): JSONArray? = runBlocking { api.mediaProgressRows() }

    override fun podcastItem(itemId: String): ItemDetail? = runBlocking { api.podcastItem(itemId) }

    override fun search(query: String): JSONArray? = runBlocking { api.searchAll(query) }

    override fun coverUrl(itemId: String): String? = api.coverUrl(itemId)
}

/**
 * The car's browse tree: the node grammar of ARCHITECTURE.md §4.2, the caches
 * and budgets of §7, and the MediaItems the Media Center renders.
 *
 * A port of the shipped Android Auto tree (the patched RNTP MusicService,
 * `absLoadChildren` / `absLoadChildrenUncached` and everything they call), with
 * the RN branches deleted — there is no JS in this process, so the credential
 * mirror, the HeadlessJs handoffs and the widget writes have no analogue here.
 * What survives is the hardening, which is the part that was learned rather
 * than designed:
 *
 *  - children cached 45 s fresh, served up to 10 min stale ON FAILURE, so a
 *    dead zone mid-drive keeps the tree browsable instead of blanking it;
 *  - `__DOWNLOADS__` never cached — it renders from local state, always live;
 *  - a 3-thread pool with a rejection fallback, so one slow folder cannot queue
 *    every later tap behind it and a callback racing teardown still completes;
 *  - eight inlined covers in Downloads, because the car subscribes to that node
 *    unpaginated and the combined bytes overflow the Binder transaction;
 *  - INTERNET **and** VALIDATED for "online", so a captive portal browses the
 *    downloads instead of hanging on fetches that will never return.
 *
 * Wave 3 adds what the car asks for on top (§7's DR-2/DR-3 additions): a
 * pre-warm on service create, and a last-good root persisted to disk so the
 * first browse after a cold start answers from a file rather than from a
 * network round trip.
 *
 * Thread-safety: everything here runs on the browse pool or on a caller's
 * thread; the caches are concurrent structures and the flags are volatile.
 * [onBrowseChanged] is the one call OUT of that world and is invoked from
 * whatever thread noticed the change — its implementation must hop to the main
 * looper before touching the session.
 */
class BrowseTree(
    context: Context,
    private val api: BrowseApi,
    /**
     * Swapped for the download index's adapter at integration; empty until
     * then, which renders an empty Downloads folder rather than a broken one.
     */
    var downloadsSource: DownloadsSource = DownloadsSource { emptyList() },
    /** Injected so the cache windows are testable without sleeping. */
    private val clock: () -> Long = { System.currentTimeMillis() },
    /**
     * "The tree changed — re-query it." Wired to
     * `MediaLibrarySession.notifyChildrenChanged`, which is main-thread-only.
     */
    private val onBrowseChanged: (reason: String) -> Unit = {}
) {

    private val appContext: Context = context.applicationContext

    /** The APPLICATION id (`com.tomesonic.app`), for `android.resource://` icons. */
    private val packageName: String = appContext.packageName

    // Small pool: a single slow request must not queue every subsequent browse
    // tap behind it (the car shows a spinner per folder). Three, not one, and
    // not unbounded — a head unit that opens four folders while one hangs still
    // gets three answers.
    private val executor: ExecutorService = Executors.newFixedThreadPool(BROWSE_THREADS)

    @Volatile
    private var released = false

    /** True while the framework says the default network reaches the internet. */
    @Volatile
    var online: Boolean = true
        private set

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private data class CacheEntry(
        val at: Long,
        val items: List<MediaItem>,
        /** A root restored from disk: serve it, then replace it (see [restoreRoot]). */
        val restored: Boolean = false
    )

    private val childrenCache = ConcurrentHashMap<String, CacheEntry>()

    /** `itemId -> mediaProgress` and `"itemId-episodeId" -> mediaProgress`. */
    private class ProgressMaps(
        val items: HashMap<String, JSONObject>,
        val episodes: HashMap<String, JSONObject>
    )

    @Volatile
    private var progressCache: Pair<Long, ProgressMaps>? = null

    /**
     * Bounded INSERTION-order (FIFO) cache, cap 30 — `accessOrder = false`, so
     * this is deliberately NOT an LRU: eviction ignores reads. `onSearch` fills
     * it and the paged `onGetSearchResult` reads it back, and overflow evicts
     * the OLDEST INSERTION rather than clearing everything (which is what an
     * earlier clear()-at-30 did, and which dropped the pending query's results
     * out from under the very call that was about to read them). Synchronized
     * because the browse pool writes it while a callback thread reads it.
     */
    private val searchCache: MutableMap<String, List<MediaItem>> =
        Collections.synchronizedMap(
            object : LinkedHashMap<String, List<MediaItem>>(16, 0.75f, false) {
                override fun removeEldestEntry(
                    eldest: MutableMap.MutableEntry<String, List<MediaItem>>
                ): Boolean = size > SEARCH_CACHE_CAP
            }
        )

    /** Decoded + re-compressed local covers, keyed by whatever asked for them. */
    private val artCache = ConcurrentHashMap<String, ByteArray>()

    @Volatile
    private var downloadsByKey: Map<String, BrowseDownload> = emptyMap()

    @Volatile
    private var downloadsByItem: Map<String, BrowseDownload> = emptyMap()

    /** One root refresh in flight at a time — see [loadChildren]'s restored branch. */
    private val rootRefreshInFlight = AtomicBoolean(false)

    /** One continue-series build in flight at a time — it is the N+1 (§7). */
    private val continueSeriesLock = Any()

    // ================= Service-facing surface =============================

    /**
     * Called from `AbsLibraryService.onCreate`. Seeds the connectivity flag,
     * restores the last-good root from disk (so the first `onGetChildren` after
     * a cold start answers from a file), and warms the real root plus the
     * progress map in the background — DR-2/DR-3: launch under 10 s, content
     * under 10 s, and the first tap should not be the first network request.
     *
     * Never blocks the caller: all of it is one pool task, and a pool that has
     * already been shut down simply drops it.
     */
    fun prewarm() {
        registerNetworkCallback()
        submit(onReject = { }) {
            restoreRoot()
            refreshRoot(notify = false)
            // The progress map backs nearly every row in the tree; fetching it
            // here means the first folder the user opens spends one request,
            // not two.
            progress()
        }
    }

    /** Symmetric with [prewarm] — call from `onDestroy`. */
    fun release() {
        released = true
        unregisterNetworkCallback()
        executor.shutdownNow()
    }

    /**
     * Submit browse work to the pool. Once the pool is shut down (service
     * teardown) `execute` throws [RejectedExecutionException] — a browse or
     * play callback racing teardown would then return a future that never
     * completes, hanging the controller. On rejection, [onReject] completes it
     * inline; every caller passes a cheap, no-disk fallback.
     */
    fun submit(onReject: () -> Unit, task: () -> Unit) {
        try {
            executor.execute(task)
        } catch (e: RejectedExecutionException) {
            Log.w(TAG, "browse executor rejected task; completing future inline", e)
            onReject()
        }
    }

    /** The browse root itself — a folder, not a list. */
    fun rootItem(): MediaItem = BrowseStyles.browsableItem(ROOT_ID, ROOT_TITLE)

    /**
     * `onGetItem`. A controller (the Media Center, the Assistant) may resolve an
     * id straight to an item before playing it, and a `play:` id must come back
     * PLAYABLE — a bare browsable folder named after the raw id is what makes a
     * voice play silently do nothing.
     */
    fun item(mediaId: String): MediaItem {
        if (!PlayMediaId.isPlayId(mediaId)) return BrowseStyles.browsableItem(mediaId, mediaId)
        refreshDownloads()
        val parsed = PlayMediaId.parse(mediaId)
        val entry = downloadEntry(parsed.itemId, parsed.episodeOrNull())
        return playableItem(
            mediaId = mediaId,
            coverItemId = parsed.itemId,
            title = entry?.title ?: "Audiobook",
            artist = entry?.author,
            subtitle = null
        )
    }

    /**
     * The cached children of one node.
     *
     * Fresh entries serve instantly; on a FAILED refresh (a dead zone mid-drive)
     * a stale entry keeps the tree browsable instead of blanking it. Downloads
     * render from local state and are never cached, and nothing is cached while
     * offline — an online tree must never be served offline, or the reverse.
     */
    fun loadChildren(parentId: String): List<MediaItem> {
        val cacheable = online && parentId != DOWNLOADS_ID
        val now = clock()
        if (cacheable) {
            childrenCache[parentId]?.let { c ->
                // A root read back from disk answers NOW and is replaced by a
                // real fetch in the background: the whole point of persisting it
                // is that the first browse after a cold start costs no network.
                if (c.restored) {
                    scheduleRootRefresh()
                    return c.items
                }
                if (now - c.at < CACHE_FRESH_MS) return c.items
            }
        }
        val fresh = loadChildrenUncached(parentId)
        if (cacheable) {
            if (fresh.isNotEmpty()) {
                childrenCache[parentId] = CacheEntry(now, fresh)
                if (parentId == ROOT_ID) persistRoot(fresh)
            } else {
                // Empty almost always means the fetch failed — serve the stale
                // copy if it is recent enough to still describe this library.
                childrenCache[parentId]?.let { c ->
                    if (now - c.at < CACHE_STALE_MS) {
                        Log.i(TAG, "serving stale children for $parentId")
                        return c.items
                    }
                }
            }
        }
        return fresh
    }

    /**
     * `onSearch`: run the query and cache it under its exact text, which is the
     * key `onGetSearchResult` will ask for.
     */
    fun search(query: String): List<MediaItem> {
        val results = searchUncached(query)
        // The map self-evicts its eldest entry past the cap, so just insert:
        // this query is now the NEWEST entry and survives any concurrent
        // inserts before onGetSearchResult reads it back.
        searchCache[query] = results
        Log.i(TAG, "search '$query' -> ${results.size} results")
        return results
    }

    /** `onGetSearchResult`: whatever [search] left behind, or nothing. */
    fun searchResults(query: String): List<MediaItem> = searchCache[query] ?: emptyList()

    /**
     * Drop everything cached and tell connected browsers to re-query.
     *
     * A connectivity flip invalidates the whole tree in both directions, and so
     * does a credential change: cached MediaItems embed the OLD token in their
     * cover URIs, which would otherwise render as blank tiles until they aged
     * out. Search results too — stale online hits must not be served offline.
     */
    fun invalidate(reason: String) {
        childrenCache.clear()
        progressCache = null
        searchCache.clear()
        onBrowseChanged(reason)
    }

    // ================= The tree ==========================================

    private fun loadChildrenUncached(parentId: String): List<MediaItem> {
        refreshDownloads()
        Log.i(TAG, "children parentId=$parentId online=$online")

        // OFFLINE: the whole tree collapses to the downloaded books, playable
        // from local files. When the network returns, the connectivity callback
        // invalidates and the online catalog comes back.
        if (!online) {
            return when (parentId) {
                ROOT_ID -> listOf(
                    browsable(
                        DOWNLOADS_ID,
                        "Downloads",
                        "Available offline",
                        iconRes = "aa_downloads"
                    )
                )
                else -> downloadsCategory()
            }
        }

        return when {
            parentId == ROOT_ID -> listOf(
                browsable(
                    CONTINUE_ID, "Continue Listening",
                    iconRes = "aa_continue", childPlayableStyle = BrowseStyles.STYLE_GRID
                ),
                browsable(
                    CONTINUE_SERIES_ID, "Continue Series",
                    iconRes = "aa_series", childBrowsableStyle = BrowseStyles.STYLE_GRID
                ),
                browsable(
                    DOWNLOADS_ID, "Downloads",
                    iconRes = "aa_downloads", childPlayableStyle = BrowseStyles.STYLE_GRID
                ),
                browsable(
                    LIBRARIES_ID, "Libraries",
                    iconRes = "aa_library", childBrowsableStyle = BrowseStyles.STYLE_CATEGORY_LIST
                )
            )
            parentId == CONTINUE_ID -> continueListening()
            parentId == CONTINUE_SERIES_ID -> continueSeries()
            parentId == DOWNLOADS_ID -> downloadsCategory()
            parentId == LIBRARIES_ID -> libraries()
            parentId.startsWith(LIB_PREFIX) -> libraryCategories(parentId)
            // Recently Added keeps RECENCY order — that IS the category. Every
            // other list below is alphabetical.
            parentId.startsWith(LATEST_PREFIX) -> itemsFromRows(
                api.items(
                    parentId.removePrefix(LATEST_PREFIX),
                    limit = 100, sort = "addedAt", desc = true
                )
            )
            parentId.startsWith(ALL_BOOKS_PREFIX) -> itemsFromRows(
                api.items(
                    parentId.removePrefix(ALL_BOOKS_PREFIX),
                    limit = 200, sort = "media.metadata.title"
                ),
                sortByTitle = true
            )
            parentId.startsWith(AUTHORS_PREFIX) -> authors(parentId.removePrefix(AUTHORS_PREFIX))
            // Finished books, alphabetical — quick re-listens without hunting
            // through the whole library.
            parentId.startsWith(LISTEN_AGAIN_PREFIX) -> itemsFromRows(
                api.items(
                    parentId.removePrefix(LISTEN_AGAIN_PREFIX),
                    limit = 200, filterType = "progress", filterValue = "finished"
                ),
                withProgress = true, sortByTitle = true
            )
            parentId.startsWith(AUTHOR_PREFIX) -> {
                val rest = parentId.removePrefix(AUTHOR_PREFIX)
                itemsFromRows(
                    api.items(
                        rest.substringBefore(':'),
                        limit = 200, filterType = "authors", filterValue = rest.substringAfter(':')
                    ),
                    withProgress = true
                ).sortedBy { title(it) }
            }
            parentId.startsWith(SERIES_LIST_PREFIX) ->
                seriesList(parentId.removePrefix(SERIES_LIST_PREFIX))
            // Inside a series: SEQUENCE order (book 1, 2, 3…) with "Book N"
            // subtitles and per-book finished/time-left, which is what you want
            // in a car.
            parentId.startsWith(SERIES_PREFIX) -> {
                val rest = parentId.removePrefix(SERIES_PREFIX)
                itemsFromRows(
                    api.items(
                        rest.substringBefore(':'),
                        limit = 200, filterType = "series", filterValue = rest.substringAfter(':'),
                        sort = "media.metadata.series.sequence"
                    ),
                    withProgress = true, sequenceSubtitle = true
                )
            }
            parentId.startsWith(COLLECTIONS_PREFIX) ->
                collections(parentId.removePrefix(COLLECTIONS_PREFIX))
            parentId.startsWith(COLLECTION_PREFIX) ->
                collection(parentId.removePrefix(COLLECTION_PREFIX))
            parentId.startsWith(PODCAST_PREFIX) ->
                podcastEpisodes(parentId.removePrefix(PODCAST_PREFIX))
            else -> emptyList()
        }
    }

    /** `__LIBRARIES__` — book libraries open into categories, podcast ones into a grid. */
    private fun libraries(): List<MediaItem> {
        val arr = api.libraries()
        if (arr == null) {
            Log.w(TAG, "/api/libraries returned null")
            return emptyList()
        }
        return (0 until arr.length()).mapNotNull { i ->
            val lib = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = absStr(lib, "id") ?: return@mapNotNull null
            val mediaType = absStr(lib, "mediaType") ?: "book"
            browsable(
                "$LIB_PREFIX$id:$mediaType",
                absStr(lib, "name") ?: "Library",
                // The library's SERVER-assigned icon, mapped exactly as the
                // in-app LibraryIcon component maps it.
                iconRes = BrowseStyles.libraryIconRes(absStr(lib, "icon"), mediaType),
                childBrowsableStyle = if (mediaType == "podcast") {
                    BrowseStyles.STYLE_GRID
                } else {
                    BrowseStyles.STYLE_CATEGORY_LIST
                }
            )
        }.sortedBy { title(it) }
    }

    /** `lib:{libraryId}:{mediaType}` — the fixed category set, or a podcast grid. */
    private fun libraryCategories(parentId: String): List<MediaItem> {
        val rest = parentId.removePrefix(LIB_PREFIX)
        val libId = rest.substringBefore(':')
        val mediaType = rest.substringAfter(':', "book")
        if (mediaType == "podcast") {
            val arr = api.items(libId, limit = 200) ?: return emptyList()
            return (0 until arr.length())
                .mapNotNull { podcastBrowsable(arr.optJSONObject(it)) }
                .sortedBy { title(it) }
        }
        return listOf(
            browsable(
                "$LATEST_PREFIX$libId", "Recently Added",
                iconRes = "aa_recent", childPlayableStyle = BrowseStyles.STYLE_GRID
            ),
            browsable(
                "$AUTHORS_PREFIX$libId", "Authors",
                iconRes = "aa_author", childBrowsableStyle = BrowseStyles.STYLE_CATEGORY_LIST
            ),
            browsable(
                "$SERIES_LIST_PREFIX$libId", "Series",
                iconRes = "aa_series", childBrowsableStyle = BrowseStyles.STYLE_CATEGORY_LIST
            ),
            browsable(
                "$COLLECTIONS_PREFIX$libId", "Collections",
                iconRes = "aa_collections", childBrowsableStyle = BrowseStyles.STYLE_CATEGORY_LIST
            ),
            browsable(
                "$LISTEN_AGAIN_PREFIX$libId", "Listen Again",
                iconRes = "aa_replay", childPlayableStyle = BrowseStyles.STYLE_GRID
            ),
            browsable(
                "$ALL_BOOKS_PREFIX$libId", "All Books",
                iconRes = "aa_books", childPlayableStyle = BrowseStyles.STYLE_GRID
            )
        )
    }

    private fun authors(libId: String): List<MediaItem> {
        val arr = api.authors(libId) ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val a = arr.optJSONObject(i) ?: return@mapNotNull null
            val n = a.optInt("numBooks", 0)
            browsable(
                "$AUTHOR_PREFIX$libId:${absStr(a, "id").orEmpty()}",
                absStr(a, "name") ?: "Author",
                subtitle = bookCount(n),
                iconRes = "aa_author",
                childPlayableStyle = BrowseStyles.STYLE_GRID
            )
        }.sortedBy { title(it) }
    }

    private fun seriesList(libId: String): List<MediaItem> {
        val arr = api.series(libId, limit = 500, sort = "name") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val s = arr.optJSONObject(i) ?: return@mapNotNull null
            val books = s.optJSONArray("books")
            val n = s.optInt("numBooks", books?.length() ?: 0)
            // "Series • Author" — the author of a series matters when scanning
            // the list and is visible nowhere else at this level.
            val author = books?.optJSONObject(0)
                ?.optJSONObject("media")?.optJSONObject("metadata")
                ?.let { absStr(it, "authorName") }
            val name = absStr(s, "name") ?: "Series"
            browsable(
                "$SERIES_PREFIX$libId:${absStr(s, "id").orEmpty()}",
                if (author.isNullOrEmpty()) name else "$name • $author",
                subtitle = bookCount(n),
                iconRes = "aa_series",
                childPlayableStyle = BrowseStyles.STYLE_GRID
            )
        }.sortedBy { title(it) }
    }

    private fun collections(libId: String): List<MediaItem> {
        val arr = api.collections(libId) ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val c = arr.optJSONObject(i) ?: return@mapNotNull null
            browsable(
                "$COLLECTION_PREFIX${absStr(c, "id").orEmpty()}",
                absStr(c, "name") ?: "Collection",
                iconRes = "aa_collections"
            )
        }.sortedBy { title(it) }
    }

    private fun collection(collectionId: String): List<MediaItem> {
        val arr = api.collection(collectionId) ?: return emptyList()
        val prog = progressItems()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            itemToMedia(o, prog[absStr(o, "id").orEmpty()])
        }.sortedBy { title(it) }
    }

    /**
     * Continue Listening: every in-progress book, annotated "author • Xh Ym
     * left". Ebook-only items and READING-only progress are filtered — this
     * category is about audio you can resume in the car.
     */
    private fun continueListening(): List<MediaItem> {
        val arr = api.itemsInProgress() ?: return emptyList()
        val prog = progressItems()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = absStr(o, "id") ?: return@mapNotNull null
            if (!hasAudio(o.optJSONObject("media"))) return@mapNotNull null
            val p = prog[id]
            // The ebook side of a dual-format book has progress but no
            // listening time — it does not belong in Continue LISTENING.
            if (p != null &&
                p.optDouble("currentTime", 0.0) <= 0.0 &&
                !p.optBoolean("isFinished", false)
            ) {
                return@mapNotNull null
            }
            val md = o.optJSONObject("media")?.optJSONObject("metadata")
            val title = absStr(md, "title") ?: "Audiobook"
            // The car renders the ARTIST line under the title for playable
            // items, so the progress line goes there as well as in the
            // subtitle — that is what guarantees it shows.
            val line = BrowseStyles.progressSubtitle(p, absStr(md, "authorName"))
            playableItem(PlayMediaId.format(id), id, title, line, line, p)
        }
    }

    /**
     * Continue Series: one folder per series you are ACTIVE in — merged from
     * (a) the server's between-books shelf and (b) the series of books
     * currently in progress, which is what the app's own bookshelf row shows.
     * Alphabetical by series name.
     *
     * This is the N+1 of the tree (a series list and an items query per active
     * series), and ARCHITECTURE.md §7 is explicit that it must never block the
     * root: it is reached only when the user opens `__CONTINUE_SERIES__`, it is
     * never part of the root's answer, and it is never pre-warmed. The lock
     * makes a second tap wait for the first build instead of starting a second
     * fan-out on another pool thread — with three threads, two concurrent
     * builds would leave one thread for the rest of the tree.
     */
    private fun continueSeries(): List<MediaItem> =
        synchronized(continueSeriesLock) { continueSeriesLocked() }

    /** [continueSeries]'s body, with the lock held — split only so it can return plainly. */
    private fun continueSeriesLocked(): List<MediaItem> {
        val libs = api.libraries() ?: return emptyList()

        data class Entry(val id: String, val name: String, val coverId: String)

        val entries = mutableListOf<Entry>()
        val seen = HashSet<String>()
        // (b)'s series carry only a NAME on the item — resolve name -> id
        // through each library's series list. Keyed "libId:name(lower)".
        val nameToId = HashMap<String, String>()

        for (i in 0 until libs.length()) {
            val lib = libs.optJSONObject(i) ?: continue
            val libId = absStr(lib, "id") ?: continue
            if ((absStr(lib, "mediaType") ?: "book") != "book") continue

            api.series(libId, limit = 1000)?.let { sArr ->
                for (j in 0 until sArr.length()) {
                    val s = sArr.optJSONObject(j) ?: continue
                    val sid = absStr(s, "id") ?: continue
                    val sname = absStr(s, "name") ?: continue
                    nameToId["$libId:${sname.lowercase()}"] = "$libId:$sid"
                }
            }

            // (a) The server's between-books shelf.
            api.personalized(libId)?.let { shelves ->
                for (j in 0 until shelves.length()) {
                    val shelf = shelves.optJSONObject(j) ?: continue
                    if (absStr(shelf, "id") != "continue-series") continue
                    val entities = shelf.optJSONArray("entities") ?: continue
                    for (k in 0 until entities.length()) {
                        val ent = entities.optJSONObject(k) ?: continue
                        val series = ent.optJSONObject("media")
                            ?.optJSONObject("metadata")
                            ?.optJSONObject("series") ?: continue
                        val sid = absStr(series, "id") ?: continue
                        if (!seen.add("$libId:$sid")) continue
                        entries.add(
                            Entry(
                                "$SERIES_PREFIX$libId:$sid",
                                absStr(series, "name") ?: "Series",
                                absStr(ent, "id").orEmpty()
                            )
                        )
                    }
                }
            }
        }

        // (b) Series of books currently in progress (audio progress only).
        api.itemsInProgress()?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                if (!hasAudio(o.optJSONObject("media"))) continue
                val md = o.optJSONObject("media")?.optJSONObject("metadata") ?: continue
                // seriesName can carry a "#seq" suffix — strip it for lookup.
                val rawName = absStr(md, "seriesName") ?: continue
                val name = rawName.replace(SERIES_SEQUENCE_SUFFIX, "").trim()
                val libId = absStr(o, "libraryId") ?: continue
                val key = nameToId["$libId:${name.lowercase()}"] ?: continue
                if (!seen.add(key)) continue
                entries.add(Entry("$SERIES_PREFIX$key", name, absStr(o, "id").orEmpty()))
            }
        }

        // "X of Y finished" — the most glanceable series fact there is while
        // driving, and affordable only because the set above is bounded to the
        // series you are actually in the middle of.
        val prog = progressItems()
        return entries
            .sortedBy { it.name.lowercase() }
            .map { e ->
                val libId = e.id.removePrefix(SERIES_PREFIX).substringBefore(':')
                val sid = e.id.substringAfterLast(':')
                var subtitle = "Series"
                api.items(libId, limit = 100, filterType = "series", filterValue = sid)?.let { arr ->
                    var total = 0
                    var finished = 0
                    for (i in 0 until arr.length()) {
                        val o = arr.optJSONObject(i) ?: continue
                        if (!hasAudio(o.optJSONObject("media"))) continue
                        total++
                        if (prog[absStr(o, "id").orEmpty()]
                                ?.optBoolean("isFinished", false) == true
                        ) {
                            finished++
                        }
                    }
                    if (total > 0) subtitle = "$finished of $total finished"
                }
                browsable(
                    e.id, e.name, subtitle,
                    coverItemId = e.coverId,
                    childPlayableStyle = BrowseStyles.STYLE_GRID
                )
            }
    }

    /**
     * Downloaded books as a browse category — playable OFFLINE from local
     * files.
     *
     * The car subscribes to this node WITHOUT pagination (page 0, pageSize
     * MAX), so every row crosses the Binder in ONE transaction. Inlined cover
     * bytes are tens of KB each, and enough offline books overflow the
     * transaction limit — which fails the whole node, offline, which is the one
     * time it is the only node there is. Only the first
     * [DOWNLOADS_ART_BUDGET] tiles carry artwork; the rest stay listed and
     * playable, just art-less.
     */
    private fun downloadsCategory(): List<MediaItem> {
        // No progress fetch while offline — the point of this folder is that it
        // answers without a server.
        val prog: Map<String, JSONObject> = if (online) progressItems() else emptyMap()
        return downloadsByKey.values
            // Badge-only rows have no local audio — they must not be tappable
            // in a folder whose whole promise is that it works offline.
            .filter { it.playable }
            .sortedBy { it.title.lowercase() }
            .mapIndexed { index, d ->
                val p = prog[d.libraryItemId]
                val line = BrowseStyles.progressSubtitle(p, d.author)
                playableItem(
                    mediaId = PlayMediaId.format(d.libraryItemId, d.episodeId),
                    coverItemId = d.libraryItemId,
                    title = d.title,
                    artist = line,
                    subtitle = line,
                    prog = p,
                    artKey = d.id,
                    inlineArt = index < DOWNLOADS_ART_BUDGET
                )
            }
    }

    private fun podcastBrowsable(o: JSONObject?): MediaItem? {
        val obj = o ?: return null
        val id = absStr(obj, "id") ?: return null
        val md = obj.optJSONObject("media")?.optJSONObject("metadata")
        return browsable(
            "$PODCAST_PREFIX$id",
            absStr(md, "title") ?: "Podcast",
            absStr(md, "author"),
            coverItemId = id,
            // Episode lists read best as text rows: the titles are long and the
            // art is the same tile on every one of them.
            childPlayableStyle = BrowseStyles.STYLE_LIST
        )
    }

    private fun podcastEpisodes(itemId: String): List<MediaItem> {
        val detail = api.podcastItem(itemId) ?: return emptyList()
        val epProg = progress().episodes
        // Newest first — that is how podcasts are consumed — capped so a
        // 500-episode feed does not drown the car UI.
        return detail.episodes
            .sortedByDescending { it.publishedAt ?: 0L }
            .take(PODCAST_EPISODE_CAP)
            .map { ep ->
                val p = epProg["$itemId-${ep.id}"]
                val line = BrowseStyles.progressSubtitle(p, detail.title)
                playableItem(
                    mediaId = PlayMediaId.format(itemId, ep.id),
                    coverItemId = itemId,
                    title = ep.title,
                    artist = line,
                    subtitle = line,
                    prog = p
                )
            }
    }

    /**
     * The shared "a page of library items" builder.
     *
     * [withProgress] annotates each row with its position (and hangs the native
     * badges off it), [sortByTitle] re-sorts alphabetically, and
     * [sequenceSubtitle] leads with "Book 3" instead of the author — inside a
     * series the author repeats on every tile and says nothing.
     */
    private fun itemsFromRows(
        rows: JSONArray?,
        withProgress: Boolean = false,
        sortByTitle: Boolean = false,
        sequenceSubtitle: Boolean = false
    ): List<MediaItem> {
        val arr = rows ?: return emptyList()
        val items: List<MediaItem> = if (!withProgress) {
            (0 until arr.length()).mapNotNull { itemToMedia(arr.optJSONObject(it)) }
        } else {
            val prog = progressItems()
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val id = absStr(o, "id") ?: return@mapNotNull null
                if (!hasAudio(o.optJSONObject("media"))) return@mapNotNull null
                val md = o.optJSONObject("media")?.optJSONObject("metadata")
                val title = absStr(md, "title") ?: "Audiobook"
                val author = absStr(md, "authorName")
                val lead = if (sequenceSubtitle) sequenceLabel(md) ?: author else author
                val p = prog[id]
                val line = BrowseStyles.progressSubtitle(p, lead)
                playableItem(PlayMediaId.format(id), id, title, line, line, p)
            }
        }
        return if (sortByTitle) items.sortedBy { title(it) } else items
    }

    private fun itemToMedia(o: JSONObject?, prog: JSONObject? = null): MediaItem? {
        val obj = o ?: return null
        val id = absStr(obj, "id") ?: return null
        // Ebook-only: filtered EVERYWHERE, not just here.
        if (!hasAudio(obj.optJSONObject("media"))) return null
        val md = obj.optJSONObject("media")?.optJSONObject("metadata")
        val title = absStr(md, "title") ?: absStr(obj, "title") ?: "Audiobook"
        return playableItem(
            mediaId = PlayMediaId.format(id),
            coverItemId = id,
            title = title,
            artist = absStr(md, "authorName"),
            subtitle = absStr(md, "seriesName"),
            prog = prog
        )
    }

    /** Voice/text search across every library -> playable books (VC-1). */
    private fun searchUncached(query: String): List<MediaItem> {
        val rows = api.search(query) ?: return emptyList()
        val prog = progressItems()
        val out = mutableListOf<MediaItem>()
        val seen = HashSet<String>()
        for (i in 0 until rows.length()) {
            val li = rows.optJSONObject(i) ?: continue
            val id = absStr(li, "id") ?: continue
            if (!seen.add(id)) continue
            if (!hasAudio(li.optJSONObject("media"))) continue
            val md = li.optJSONObject("media")?.optJSONObject("metadata")
            val title = absStr(md, "title") ?: "Audiobook"
            val p = prog[id]
            val line = BrowseStyles.progressSubtitle(p, absStr(md, "authorName"))
            out.add(playableItem(PlayMediaId.format(id), id, title, line, line, p))
        }
        return out
    }

    // ================= Progress ==========================================

    /**
     * The progress maps from `GET /api/me`, cached ~15 s: nearly every category
     * needs them, and re-fetching per drill-in wastes the one thing a car link
     * has least of.
     */
    private fun progress(): ProgressMaps {
        val now = clock()
        progressCache?.let { (at, p) -> if (now - at < PROGRESS_CACHE_MS) return p }
        val items = HashMap<String, JSONObject>()
        val episodes = HashMap<String, JSONObject>()
        api.mediaProgress()?.let { mp ->
            for (i in 0 until mp.length()) {
                val p = mp.optJSONObject(i) ?: continue
                val itemId = absStr(p, "libraryItemId") ?: continue
                // org.json GOTCHA: optString on an explicit JSON null returns
                // the STRING "null". Books carry `episodeId: null`, and reading
                // that as an episode key silently emptied the ITEMS map — no
                // time-left, no checkmarks, no finished counts anywhere.
                val epId = if (p.isNull("episodeId")) "" else p.optString("episodeId")
                if (epId.isNotEmpty()) episodes["$itemId-$epId"] = p else items[itemId] = p
            }
        }
        val result = ProgressMaps(items, episodes)
        // Only cache a NON-empty result: an offline fetch must not poison the
        // cache with emptiness for 15 s after the network comes back.
        if (items.isNotEmpty() || episodes.isNotEmpty()) progressCache = Pair(now, result)
        return result
    }

    private fun progressItems(): HashMap<String, JSONObject> = progress().items

    // ================= Downloads =========================================

    private fun refreshDownloads() {
        val rows = try {
            downloadsSource.downloads()
        } catch (t: Throwable) {
            // A download index mid-write must cost this browse cycle, not the
            // offline catalog: keep the last good snapshot.
            Log.w(TAG, "downloads source failed; keeping previous snapshot", t)
            return
        }
        downloadsByKey = rows.associateBy { it.id }
        // First entry wins, so a book's own row beats one of its episodes for
        // the item-level badge and cover.
        downloadsByItem = rows.associateBy { it.libraryItemId }
    }

    private fun downloadEntry(itemId: String, episodeId: String?): BrowseDownload? =
        downloadsByKey.values.firstOrNull {
            it.libraryItemId == itemId && it.episodeId == episodeId
        } ?: downloadsByItem[itemId]

    /**
     * Downloaded covers, decoded + scaled once and inlined as BYTES: the car's
     * process cannot read this app's private files, so a `file://` artwork URI
     * renders as a BLANK tile.
     */
    private fun localArtBytes(key: String): ByteArray? {
        artCache[key]?.let { return it }
        val cover = coverPathFor(key) ?: return null
        val path = cover.removePrefix("file://")
        // Only decode real filesystem paths. A non-file URI (http(s)://,
        // content://, …) would otherwise drive decodeFile into
        // exception-driven control flow and per-lookup log spam.
        if (!path.startsWith("/")) return null
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= ART_MAX_EDGE) sample *= 2
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            val bmp = BitmapFactory.decodeFile(path, opts) ?: return null
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, ART_JPEG_QUALITY, out)
            bmp.recycle()
            val bytes = out.toByteArray()
            if (artCache.size < ART_CACHE_CAP) artCache[key] = bytes
            bytes
        } catch (t: Throwable) {
            Log.w(TAG, "local art decode failed for $key", t)
            null
        }
    }

    private fun coverPathFor(key: String): String? =
        (downloadsByKey[key] ?: downloadsByItem[key])?.coverPath

    // ================= Item builders =====================================

    private fun browsable(
        id: String,
        title: String,
        subtitle: String? = null,
        coverItemId: String? = null,
        iconRes: String? = null,
        childPlayableStyle: Int? = null,
        childBrowsableStyle: Int? = null
    ): MediaItem = BrowseStyles.browsableItem(
        id = id,
        title = title,
        subtitle = subtitle,
        artworkUri = coverItemId?.let { coverUri(it) },
        iconUri = iconRes?.let { BrowseStyles.iconUri(packageName, it) },
        childPlayableStyle = childPlayableStyle,
        childBrowsableStyle = childBrowsableStyle
    )

    /**
     * Artwork rule, from the donor: the server's cover URL while online (the
     * car's process fetches http itself, with the token in the query string),
     * and offline the downloaded cover inlined as bytes — never a `file://`
     * URI, which renders as a blank tile.
     *
     * [artKey] is which entry's cover to inline; it differs from
     * [coverItemId] for a podcast EPISODE, whose downloaded cover lives under
     * the episode's own entry.
     */
    private fun playableItem(
        mediaId: String,
        coverItemId: String,
        title: String,
        artist: String?,
        subtitle: String?,
        prog: JSONObject? = null,
        artKey: String = coverItemId,
        inlineArt: Boolean = true
    ): MediaItem {
        val uri = if (online) coverUri(coverItemId) else null
        // inlineArt == false leaves the tile art-less on purpose (the Downloads
        // Binder budget) rather than falling back to a URI the car can't read.
        val bytes = if (uri == null && inlineArt) localArtBytes(artKey) else null
        return BrowseStyles.playableItem(
            mediaId = mediaId,
            title = title,
            artist = artist,
            subtitle = subtitle,
            prog = prog,
            artworkUri = uri,
            artworkBytes = bytes,
            downloaded = downloadsByItem.containsKey(coverItemId)
        )
    }

    private fun coverUri(itemId: String): Uri? = api.coverUrl(itemId)?.let { Uri.parse(it) }

    // ================= Persisted root (DR-3) =============================

    /**
     * The last-good ROOT, written to `filesDir` (DR-3, ARCHITECTURE.md §7).
     *
     * Honest about what it buys: today's online root is four fixed rows, so
     * this file is not what saves a network round trip — [prewarm] is. What it
     * removes is the cold start's dependence on ORDERING. The Media Center
     * binds this service and browses immediately, and that first
     * `onGetChildren` can land before the pre-warm task has seeded the
     * connectivity flag or the download snapshot; answering it from the rows
     * the car saw last time is strictly better than answering it from a state
     * that is still filling in. It is also the seam DR-3 asks for if the root
     * ever gains a row that depends on the server.
     *
     * Deliberately minimal — id, title, subtitle, icon name, child styles — and
     * deliberately BROWSABLE-only: those fields are the whole content of a
     * folder row. A playable row would mean persisting a cover URL, and a cover
     * URL carries the access token (§4.4); nothing here writes a credential to
     * a second file.
     */
    private fun persistRoot(children: List<MediaItem>) {
        try {
            val arr = JSONArray()
            children.forEach { item ->
                val md = item.mediaMetadata
                if (md.isBrowsable != true) return@forEach
                arr.put(
                    JSONObject()
                        .put("id", item.mediaId)
                        .put("title", md.title?.toString().orEmpty())
                        .put("type", TYPE_BROWSABLE)
                        .putOpt("subtitle", md.subtitle?.toString())
                        .putOpt("icon", rootIconFor(item.mediaId))
                        .putOpt("playableStyle", style(item, BrowseStyles.CONTENT_STYLE_PLAYABLE_HINT))
                        .putOpt("browsableStyle", style(item, BrowseStyles.CONTENT_STYLE_BROWSABLE_HINT))
                )
            }
            val doc = JSONObject()
                .put("version", ROOT_CACHE_VERSION)
                .put("at", clock())
                .put("children", arr)
            File(appContext.filesDir, ROOT_CACHE_FILE).writeText(doc.toString())
        } catch (t: Throwable) {
            // A root we could not persist costs the NEXT cold start a round
            // trip. It must never cost this browse.
            Log.w(TAG, "persisting root failed", t)
        }
    }

    /**
     * Reads that file back into the children cache, marked [CacheEntry.restored]
     * so the very next `loadChildren("__ROOT__")` serves it AND schedules the
     * real fetch that replaces it.
     *
     * Nothing is served from here while offline — [loadChildren] does not read
     * the cache at all in that state, so a root persisted online can never be
     * shown to a car that has no network.
     *
     * `internal` so the round trip is provable without racing [prewarm]'s pool
     * task: what a test needs to pin is the restore, not the scheduler.
     */
    internal fun restoreRoot() {
        if (childrenCache.containsKey(ROOT_ID)) return
        try {
            val file = File(appContext.filesDir, ROOT_CACHE_FILE)
            if (!file.exists()) return
            val doc = JSONObject(file.readText())
            // A version this build does not know is a format from another
            // build: ignore it rather than guessing, and the next successful
            // fetch overwrites it.
            if (doc.optInt("version") != ROOT_CACHE_VERSION) return
            val arr = doc.optJSONArray("children") ?: return
            val items = (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                if (absStr(o, "type") != TYPE_BROWSABLE) return@mapNotNull null
                val id = absStr(o, "id") ?: return@mapNotNull null
                browsable(
                    id = id,
                    title = absStr(o, "title") ?: return@mapNotNull null,
                    subtitle = absStr(o, "subtitle"),
                    iconRes = absStr(o, "icon"),
                    childPlayableStyle = o.optInt("playableStyle", 0).takeIf { it > 0 },
                    childBrowsableStyle = o.optInt("browsableStyle", 0).takeIf { it > 0 }
                )
            }
            if (items.isEmpty()) return
            childrenCache[ROOT_ID] = CacheEntry(clock(), items, restored = true)
            Log.i(TAG, "restored ${items.size} root rows from disk")
        } catch (t: Throwable) {
            Log.w(TAG, "restoring root failed", t)
        }
    }

    /** One child-style hint off a folder, or null when it carries none. */
    private fun style(item: MediaItem, key: String): Int? {
        val extras = item.mediaMetadata.extras ?: return null
        return if (extras.containsKey(key)) extras.getInt(key) else null
    }

    /** The icon a root row was built with — the one field a MediaItem cannot give back. */
    private fun rootIconFor(mediaId: String?): String? = when (mediaId) {
        CONTINUE_ID -> "aa_continue"
        CONTINUE_SERIES_ID -> "aa_series"
        DOWNLOADS_ID -> "aa_downloads"
        LIBRARIES_ID -> "aa_library"
        else -> null
    }

    private fun scheduleRootRefresh() {
        if (!rootRefreshInFlight.compareAndSet(false, true)) return
        submit(onReject = { rootRefreshInFlight.set(false) }) {
            try {
                refreshRoot(notify = true)
            } finally {
                rootRefreshInFlight.set(false)
            }
        }
    }

    /**
     * Fetches the real root and replaces whatever was cached. A failed fetch
     * changes nothing — the restored rows keep serving, and the next browse
     * tries again.
     */
    private fun refreshRoot(notify: Boolean) {
        if (released || !online) return
        val fresh = loadChildrenUncached(ROOT_ID)
        if (fresh.isEmpty()) return
        childrenCache[ROOT_ID] = CacheEntry(clock(), fresh)
        persistRoot(fresh)
        if (notify) onBrowseChanged("root refreshed")
    }

    // ================= Connectivity ======================================

    /**
     * Online means INTERNET **and** VALIDATED.
     *
     * A network becoming the default does NOT mean it reaches anything: a
     * captive-portal Wi-Fi and a no-service cellular attach both fire
     * `onAvailable` and both advertise NET_CAPABILITY_INTERNET. Treating those
     * as online pins the car to the online tree, whose fetches then hang — a
     * 45-second spinner where the downloaded books should have been.
     */
    private fun registerNetworkCallback() {
        if (networkCallback != null) return
        try {
            val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            // Seed from current state, so a cold start in a garage with no
            // signal browses offline immediately instead of after the first
            // failed fetch.
            online = cm.activeNetwork?.let { hasInternet(cm, it) } ?: false
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    update(hasInternet(cm, network), "network available")
                }

                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    update(validated(caps), "capabilities changed")
                }

                override fun onLost(network: Network) {
                    // The same INTERNET+VALIDATED question about whatever is
                    // left: a lingering captive-portal transport must not keep
                    // browse pinned online.
                    val still = cm.activeNetwork?.let { hasInternet(cm, it) } ?: false
                    update(still, "network lost")
                }
            }
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (t: Throwable) {
            Log.w(TAG, "network callback registration failed", t)
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            networkCallback?.let { cb ->
                val service = appContext.getSystemService(Context.CONNECTIVITY_SERVICE)
                (service as ConnectivityManager).unregisterNetworkCallback(cb)
            }
        } catch (_: Throwable) {
        }
        networkCallback = null
    }

    private fun hasInternet(cm: ConnectivityManager, network: Network): Boolean =
        cm.getNetworkCapabilities(network)?.let { validated(it) } == true

    private fun validated(caps: NetworkCapabilities): Boolean =
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

    /**
     * Flips the online flag and, on a real change, invalidates the tree.
     *
     * `internal` because the offline-tree tests drive it directly: seeding a
     * validated capability through a shadow ConnectivityManager would test
     * Robolectric, not this file's answer to being offline.
     */
    internal fun update(up: Boolean, reason: String) {
        if (up == online) return
        online = up
        invalidate(reason)
    }

    companion object {

        // ---- Parent-id grammar (ARCHITECTURE.md §4.2, verbatim) ----------
        // The exact node ids the car remembers between sessions: a rename here
        // orphans every saved shortcut and every voice target on every head
        // unit. A JVM test asserts this table against the contract's.

        const val ROOT_ID = "__ROOT__"
        const val CONTINUE_ID = "__CONTINUE__"
        const val CONTINUE_SERIES_ID = "__CONTINUE_SERIES__"
        const val DOWNLOADS_ID = "__DOWNLOADS__"
        const val LIBRARIES_ID = "__LIBRARIES__"

        /** `lib:{libraryId}:{mediaType}` */
        const val LIB_PREFIX = "lib:"

        /** `latest:{libraryId}` */
        const val LATEST_PREFIX = "latest:"

        /** `allbooks:{libraryId}` */
        const val ALL_BOOKS_PREFIX = "allbooks:"

        /** `listenagain:{libraryId}` */
        const val LISTEN_AGAIN_PREFIX = "listenagain:"

        /** `authors:{libraryId}` -> `author:{libraryId}:{authorId}` */
        const val AUTHORS_PREFIX = "authors:"
        const val AUTHOR_PREFIX = "author:"

        /** `serieslist:{libraryId}` -> `series:{libraryId}:{seriesId}` */
        const val SERIES_LIST_PREFIX = "serieslist:"
        const val SERIES_PREFIX = "series:"

        /** `collections:{libraryId}` -> `collection:{collectionId}` */
        const val COLLECTIONS_PREFIX = "collections:"
        const val COLLECTION_PREFIX = "collection:"

        /** `podcast:{itemId}` */
        const val PODCAST_PREFIX = "podcast:"

        private const val ROOT_TITLE = "TomeSonic"

        // ---- Budgets (ARCHITECTURE.md §7) -------------------------------

        /** Fresh window: a folder re-opened within it costs no network at all. */
        const val CACHE_FRESH_MS = 45_000L

        /** Stale window: how long a FAILED refresh may keep serving the old answer. */
        const val CACHE_STALE_MS = 10 * 60_000L

        const val PROGRESS_CACHE_MS = 15_000L

        /** Inlined covers in the unpaginated Downloads node — the Binder guard. */
        const val DOWNLOADS_ART_BUDGET = 8

        const val SEARCH_CACHE_CAP = 30

        private const val BROWSE_THREADS = 3
        private const val PODCAST_EPISODE_CAP = 50
        private const val ART_MAX_EDGE = 512
        private const val ART_JPEG_QUALITY = 82
        private const val ART_CACHE_CAP = 60

        private const val ROOT_CACHE_FILE = "automotive_browse_root.json"
        private const val ROOT_CACHE_VERSION = 1
        private const val TYPE_BROWSABLE = "browsable"

        /** " #3" / " #3.5" on a seriesName — stripped before a name lookup. */
        private val SERIES_SEQUENCE_SUFFIX = Regex("\\s+#[\\d.]+\\s*$")

        /**
         * The `[from, to)` bounds of one browse page.
         *
         * Returning the full list for every page made paginating head units
         * append the same rows again and again (the duplicate-rows bug). The
         * `toLong()` arithmetic is not decoration: `page * pageSize` overflows
         * Int for a hostile or merely large pair, and a negative `from` is an
         * IndexOutOfBounds inside the media3 callback. A page past the end
         * yields an EMPTY window (from == to), never an out-of-range one.
         */
        fun pageWindow(size: Int, page: Int, pageSize: Int): Pair<Int, Int> {
            val from = (page.toLong() * pageSize.toLong())
                .coerceIn(0L, size.toLong()).toInt()
            val to = (from.toLong() + pageSize.toLong())
                .coerceIn(from.toLong(), size.toLong()).toInt()
            return Pair(from, to)
        }

        /**
         * A book is browse-relevant only if it has AUDIO. Ebook-only items (and
         * the reading-only side of a dual-format book) are filtered everywhere
         * in this tree. Handles both the minified (`numTracks`/`numAudioFiles`)
         * and expanded (arrays) shapes of a media payload.
         */
        fun hasAudio(media: JSONObject?): Boolean {
            val m = media ?: return false
            if (m.optInt("numTracks", 0) > 0) return true
            if (m.optInt("numAudioFiles", 0) > 0) return true
            if ((m.optJSONArray("tracks")?.length() ?: 0) > 0) return true
            if ((m.optJSONArray("audioFiles")?.length() ?: 0) > 0) return true
            return m.optDouble("duration", 0.0) > 0.0
        }

        /**
         * "Book 3" from an item's series sequence. Series-filtered results carry
         * it in `metadata.series.sequence`; minified rows only have the
         * "Name #3" suffix on `seriesName`.
         */
        fun sequenceLabel(md: JSONObject?): String? {
            val seq = md?.optJSONObject("series")?.let { absStr(it, "sequence") }
                ?: absStr(md, "seriesName")?.substringAfterLast('#', "")?.trim()?.ifEmpty { null }
            return seq?.let { "Book $it" }
        }

        /** "1 book" / "7 books" / nothing at all — a count of zero says less than silence. */
        private fun bookCount(n: Int): String? = when {
            n <= 0 -> null
            n == 1 -> "1 book"
            else -> "$n books"
        }

        /** Sort key: a browse list is alphabetical the way a human reads it. */
        private fun title(item: MediaItem): String =
            (item.mediaMetadata.title ?: "").toString().lowercase()
    }
}
