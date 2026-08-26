package com.tomesonic.app.wear.ui.screens

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import com.tomesonic.app.wear.ui.DownloadsViewModel
import com.tomesonic.app.wear.ui.UiFormat
import com.tomesonic.app.wear.ui.components.ChevronGlyph
import com.tomesonic.app.wear.ui.components.MediaRow
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.ScreenTitle
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.SectionHeader
import com.tomesonic.app.wear.ui.components.coverModel

/**
 * What is actually on the watch — books and single podcast episodes in one list,
 * since both are one entry and one folder each.
 *
 * Rows lead to the item screen rather than playing directly — the reason to open
 * this list is usually to delete something, and the delete lives there (an
 * episode's on its own row of the podcast's episode list). (Home is where
 * tapping a book plays it.)
 */
@Composable
fun DownloadsScreen(onOpenItem: (String) -> Unit) {
    val viewModel: DownloadsViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    ScrollScreen {
        item { ScreenTitle("Downloads") }

        if (state.entries.isEmpty()) {
            if (state.loading) {
                item { Note("Loading…") }
            } else {
                item { Note("Nothing downloaded yet.") }
                item {
                    // The constraints are the surprising part, so the empty
                    // state explains them rather than the download button.
                    Note(
                        "Downloads wait for the charger and Wi-Fi. Open a book, " +
                            "tap Download — or \"Download now\" to skip the wait.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        items(state.entries.size) { index ->
            val entry = state.entries[index]
            // An EPISODE row names the episode and puts its podcast underneath —
            // "Ep 412" over "The Show · 24 MB" — because in a list of downloads
            // the podcast title is the one thing every one of its episodes
            // repeats. A book keeps its author line exactly as before.
            val episode = entry.episodeTitle?.takeIf { it.isNotBlank() }
            MediaRow(
                title = episode ?: entry.title,
                subtitle = listOfNotNull(
                    (if (episode != null) entry.title else entry.author)?.takeIf { it.isNotBlank() },
                    UiFormat.bytes(entry.bytes)
                ).joinToString(" · "),
                // Both keyed by the LIBRARY ITEM: an entry id is not something
                // the server (or the item screen) can be handed — for a book it
                // is the item id anyway.
                cover = coverModel(entry.coverPath, entry.libraryItemId),
                onClick = { onOpenItem(entry.libraryItemId) },
                trailing = { ChevronGlyph(tint = MaterialTheme.colorScheme.onSurfaceVariant) }
            )
        }

        if (state.entries.isNotEmpty()) {
            item { SectionHeader("Storage used") }
            item { Note(UiFormat.bytes(state.totalBytes)) }
        }
    }
}
