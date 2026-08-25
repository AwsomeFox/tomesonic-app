package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.ItemSummary

/**
 * Infinite scroll, as arithmetic.
 *
 * ABS pages are zero-based and stable-sorted by title (see AbsApi.libraryItems),
 * but a library that changes between two page fetches can still hand back a row
 * the watch already has — appending blind would render it twice and, worse, give
 * two list items the same key. Everything here is pure so those cases are pinned
 * by a test rather than discovered by scrolling a real library.
 */
object Pagination {

    /** Matches AbsApi.libraryItems' own default. */
    const val PAGE_SIZE = 50

    /**
     * Existing rows + a freshly fetched page, ids de-duplicated, ORDER of the
     * existing rows preserved (a re-sorted list under a scrolling finger is the
     * one thing worse than a duplicate).
     */
    fun append(existing: List<ItemSummary>, incoming: List<ItemSummary>): List<ItemSummary> {
        if (incoming.isEmpty()) return existing
        val seen = HashSet<String>(existing.size + incoming.size)
        existing.forEach { seen.add(it.id) }
        val out = ArrayList<ItemSummary>(existing.size + incoming.size)
        out.addAll(existing)
        incoming.forEach { if (seen.add(it.id)) out.add(it) }
        return out
    }

    /**
     * The end of the library: a SHORT page. ABS's `total` isn't trustworthy
     * across a page boundary (items can be added or hidden between requests),
     * and a short page is the one signal that means the same thing every time.
     *
     * An EMPTY page is the end too — including the very first one, which is how
     * an empty library and an offline fetch both stop asking.
     */
    fun isEnd(incoming: List<ItemSummary>, limit: Int = PAGE_SIZE): Boolean =
        incoming.size < limit

    /**
     * The page number to request next. Derived from the page just consumed
     * rather than from the row count, because de-duplication makes the row count
     * a liar (fetching page 1 after a de-dup would re-fetch page 0's tail
     * forever).
     */
    fun nextPage(lastPage: Int): Int = lastPage + 1
}
