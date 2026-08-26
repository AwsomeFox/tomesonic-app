package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.LibrarySummary

/**
 * The two decisions search makes before it has any results: what HOME's Search
 * chip searches, and whether what came back from the input activity is worth a
 * request. Pure, so both are pinned by JVM tests rather than by a watch with a
 * microphone.
 */
object SearchLogic {

    /**
     * Longer than this is a dictation accident, not a title — the same cap
     * native/utils/formatSwitch.ts puts on its own library search.
     */
    const val MAX_QUERY = 60

    /**
     * Voice transcription arrives padded, and a cancelled dictation arrives
     * empty. A blank `q=` is not a search — it asks the server for the whole
     * library — so null here means "nothing to ask".
     */
    fun normalize(raw: CharSequence?): String? {
        val text = raw?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return null
        return if (text.length > MAX_QUERY) text.substring(0, MAX_QUERY).trim() else text
    }

    /**
     * Home's Search chip is scoped to a library the user never picked, so it
     * takes the first BOOK library, falling back to the only library when there
     * is exactly one.
     *
     * Null when neither rule fires: a chip that has to guess between two podcast
     * libraries is a chip that searches the wrong one, and home already carries
     * a chip per library to pick from.
     */
    fun defaultLibraryId(libraries: List<LibrarySummary>): String? {
        libraries.firstOrNull { it.mediaType == "book" }?.let { return it.id }
        return libraries.singleOrNull()?.id
    }
}
