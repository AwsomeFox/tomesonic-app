package com.tomesonic.app.wear.ui.screens

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import com.tomesonic.app.wear.ui.LibraryViewModel
import com.tomesonic.app.wear.ui.components.ChevronGlyph
import com.tomesonic.app.wear.ui.components.MediaRow
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.ScreenTitle
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.SearchGlyph
import com.tomesonic.app.wear.ui.components.TomeChip
import com.tomesonic.app.wear.ui.components.coverModel

/**
 * One library, paged.
 *
 * The "more" trigger is a real list ITEM rather than a scroll-position
 * calculation: a ScalingLazyColumn only composes what it can show, so an item at
 * the end of the list composing IS the definition of "the user scrolled to the
 * bottom" — and it survives every screen size and every item height without
 * arithmetic.
 */
@Composable
fun LibraryScreen(
    libraryId: String,
    onOpenItem: (String) -> Unit,
    onOpenSearch: (String) -> Unit
) {
    val viewModel: LibraryViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    LaunchedEffect(libraryId) { viewModel.start(libraryId) }

    ScrollScreen {
        item { ScreenTitle(state.name) }

        item {
            // Above the rows: search is the alternative to paging a library that
            // does not fit on a watch, so it cannot sit at the end of the paging.
            TomeChip(
                label = "Search",
                onClick = { onOpenSearch(libraryId) },
                icon = { SearchGlyph(tint = MaterialTheme.colorScheme.primary) }
            )
        }

        items(state.items.size) { index ->
            val summary = state.items[index]
            MediaRow(
                title = summary.title,
                subtitle = summary.authorName,
                progress = summary.progress,
                cover = coverModel(null, summary.id),
                onClick = { onOpenItem(summary.id) },
                trailing = { ChevronGlyph(tint = MaterialTheme.colorScheme.onSurfaceVariant) }
            )
        }

        if (!state.endReached) {
            item {
                // Keyed on the row count so the next page is requested each time
                // this item is pushed down and re-enters the viewport.
                LaunchedEffect(state.items.size) { viewModel.loadMore() }
                // Something has to occupy the trigger item even between pages,
                // or there is nothing for the list to compose and ask with.
                if (state.loading) Note("Loading…") else Spacer(Modifier.height(2.dp))
            }
        }

        if (state.items.isEmpty() && !state.loading) {
            item {
                Note("Nothing here yet — the server didn't answer, or the library is empty.")
            }
            item {
                TomeChip(
                    label = "Try again",
                    onClick = { viewModel.retry() },
                    modifier = Modifier.padding(top = 6.dp)
                )
            }
        }
    }
}
