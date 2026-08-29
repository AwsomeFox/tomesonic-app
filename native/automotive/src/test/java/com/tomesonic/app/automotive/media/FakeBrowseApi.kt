package com.tomesonic.app.automotive.media

import com.tomesonic.app.automotive.data.ItemDetail
import org.json.JSONArray
import org.json.JSONObject
import java.util.Collections

/**
 * A [BrowseApi] with no server behind it — the fixture every BrowseTree test in
 * this package runs on.
 *
 * The seam exists for exactly this: the tree's cache windows, its orderings,
 * its budgets and its offline shape are behaviour ported from a shipped
 * service, and pinning them against a live ABS instance would pin the instance
 * instead. Every method records that it was called (which is how the
 * "continue-series never blocks the root" test proves a NEGATIVE) and answers
 * whatever the test set.
 *
 * Defaults are empty-but-present, not null: a null here means "the request
 * failed", and a test that wants that failure says so.
 *
 * The answer fields are named `…Answer` rather than after their methods so no
 * call site can be misread as recursion.
 */
class FakeBrowseApi : BrowseApi {

    /**
     * Method names, in call order. Synchronized because the pre-warm test reads
     * it from the test thread while the browse pool writes it.
     */
    val calls: MutableList<String> = Collections.synchronizedList(mutableListOf<String>())

    data class ItemsQuery(
        val libraryId: String,
        val limit: Int,
        val filterType: String?,
        val filterValue: String?,
        val sort: String?,
        val desc: Boolean
    )

    /** Every `items(...)` call, so a test can assert the filter and the sort. */
    val itemQueries = mutableListOf<ItemsQuery>()

    var librariesAnswer: JSONArray? = JSONArray()
    var authorsAnswer: JSONArray? = JSONArray()
    var seriesAnswer: JSONArray? = JSONArray()
    var collectionsAnswer: JSONArray? = JSONArray()
    var collectionAnswer: JSONArray? = JSONArray()
    var personalizedAnswer: JSONArray? = JSONArray()
    var itemsInProgressAnswer: JSONArray? = JSONArray()
    var mediaProgressAnswer: JSONArray? = JSONArray()
    var podcastAnswer: ItemDetail? = null
    var searchAnswer: JSONArray? = JSONArray()

    /** Answers `items(...)`; the query carries everything the tree asked for. */
    var itemsAnswer: (ItemsQuery) -> JSONArray? = { JSONArray() }

    var coverAnswer: (String) -> String? = { "https://abs.test/api/items/$it/cover?token=T" }

    override fun libraries(): JSONArray? {
        calls += "libraries"
        return librariesAnswer
    }

    override fun items(
        libraryId: String,
        limit: Int,
        filterType: String?,
        filterValue: String?,
        sort: String?,
        desc: Boolean
    ): JSONArray? {
        calls += "items"
        val query = ItemsQuery(libraryId, limit, filterType, filterValue, sort, desc)
        itemQueries += query
        return itemsAnswer(query)
    }

    override fun authors(libraryId: String): JSONArray? {
        calls += "authors"
        return authorsAnswer
    }

    override fun series(libraryId: String, limit: Int, sort: String?): JSONArray? {
        calls += "series"
        return seriesAnswer
    }

    override fun collections(libraryId: String): JSONArray? {
        calls += "collections"
        return collectionsAnswer
    }

    override fun collection(collectionId: String): JSONArray? {
        calls += "collection"
        return collectionAnswer
    }

    override fun personalized(libraryId: String, limit: Int): JSONArray? {
        calls += "personalized"
        return personalizedAnswer
    }

    override fun itemsInProgress(limit: Int): JSONArray? {
        calls += "itemsInProgress"
        return itemsInProgressAnswer
    }

    override fun mediaProgress(): JSONArray? {
        calls += "mediaProgress"
        return mediaProgressAnswer
    }

    override fun podcastItem(itemId: String): ItemDetail? {
        calls += "podcastItem"
        return podcastAnswer
    }

    override fun search(query: String): JSONArray? {
        calls += "search"
        return searchAnswer
    }

    override fun coverUrl(itemId: String): String? = coverAnswer(itemId)
}

// ---- Row builders: the ABS shapes the tree actually reads ----------------

/**
 * One minified library-item row. [numTracks] is what `hasAudio` sees, so 0
 * builds the ebook-only row every category is supposed to drop.
 */
fun itemRow(
    id: String,
    title: String,
    author: String? = null,
    seriesName: String? = null,
    sequence: String? = null,
    numTracks: Int = 1,
    libraryId: String? = null
): JSONObject {
    val metadata = JSONObject().put("title", title)
    author?.let { metadata.put("authorName", it) }
    seriesName?.let { metadata.put("seriesName", it) }
    sequence?.let { metadata.put("series", JSONObject().put("sequence", it)) }
    val media = JSONObject().put("numTracks", numTracks).put("metadata", metadata)
    val row = JSONObject().put("id", id).put("media", media)
    libraryId?.let { row.put("libraryId", it) }
    return row
}

/** One `GET /api/me` progress row. A book's `episodeId` is an EXPLICIT null. */
fun progressRow(
    itemId: String,
    currentTime: Double,
    duration: Double,
    isFinished: Boolean = false,
    episodeId: String? = null
): JSONObject {
    val row = JSONObject()
        .put("libraryItemId", itemId)
        .put("currentTime", currentTime)
        .put("duration", duration)
        .put("isFinished", isFinished)
    // put(key, null) REMOVES the key; the book rows this tree sees carry the
    // key WITH a JSON null in it, which is the whole point of the org.json
    // gotcha the progress map guards against.
    return row.put("episodeId", episodeId ?: JSONObject.NULL)
}

fun libraryRow(
    id: String,
    name: String,
    mediaType: String = "book",
    icon: String? = null
): JSONObject {
    val row = JSONObject().put("id", id).put("name", name).put("mediaType", mediaType)
    icon?.let { row.put("icon", it) }
    return row
}

fun jsonArray(vararg rows: JSONObject): JSONArray {
    val arr = JSONArray()
    rows.forEach { arr.put(it) }
    return arr
}
