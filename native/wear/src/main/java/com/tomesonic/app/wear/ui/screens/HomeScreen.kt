package com.tomesonic.app.wear.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.tomesonic.app.wear.ui.HomeDownloadState
import com.tomesonic.app.wear.ui.HomeRow
import com.tomesonic.app.wear.ui.HomeSections
import com.tomesonic.app.wear.ui.HomeViewModel
import com.tomesonic.app.wear.ui.ResumeTarget
import com.tomesonic.app.wear.ui.SearchLogic
import com.tomesonic.app.wear.ui.UiFormat
import com.tomesonic.app.wear.ui.components.BookGlyph
import com.tomesonic.app.wear.ui.components.CoverImage
import com.tomesonic.app.wear.ui.components.DownloadGlyph
import com.tomesonic.app.wear.ui.components.DownloadedGlyph
import com.tomesonic.app.wear.ui.components.LinearProgress
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.PlayGlyph
import com.tomesonic.app.wear.ui.components.PodcastGlyph
import com.tomesonic.app.wear.ui.components.RefreshGlyph
import com.tomesonic.app.wear.ui.components.ScreenTitle
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.SearchGlyph
import com.tomesonic.app.wear.ui.components.SectionHeader
import com.tomesonic.app.wear.ui.components.SettingsGlyph
import com.tomesonic.app.wear.ui.components.TomeCard
import com.tomesonic.app.wear.ui.components.TomeChip
import com.tomesonic.app.wear.ui.components.coverModel

/**
 * The first screen: one book to resume, a few to continue, and a way into
 * everything else.
 *
 * Every row that names a book PLAYS it — this is a watch, and a screen that
 * costs two taps to hear anything has already lost to reaching for the phone.
 * Each row's TRAILING affordance is the exception (user-asked): it downloads
 * the row's book (or episode) in place, and once something is in flight or on
 * the watch it opens the item screen, where the real download states live.
 */
@Composable
fun HomeScreen(
    onPlay: (String, String?) -> Unit,
    onOpenLibrary: (String) -> Unit,
    onOpenSearch: (String) -> Unit,
    onOpenDownloads: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenItem: (String) -> Unit
) {
    val viewModel: HomeViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    // Re-entering home (back from the player, from settings) re-reads the
    // resume pointer, which the player has probably just moved.
    LaunchedEffect(Unit) { viewModel.refresh() }

    // Home's Search chip belongs to no library in particular, so it takes one
    // from the library chips the screen is already showing (SearchLogic owns
    // which); null hides the chip rather than searching a guess.
    val searchLibraryId = SearchLogic.defaultLibraryId(
        state.rows.mapNotNull { (it as? HomeRow.Library)?.library }
    )

    ScrollScreen {
        item { ScreenTitle("TomeSonic") }

        if (state.loading && state.rows.isEmpty()) {
            item { Note("Loading…") }
        }

        items(state.rows.size) { index ->
            when (val row = state.rows[index]) {
                is HomeRow.Resume -> ResumeCard(
                    target = row.target,
                    downloadState = HomeSections.downloadState(
                        state.downloads, state.requestedDownloads,
                        row.target.itemId, row.target.episodeId
                    ),
                    onClick = { onPlay(row.target.itemId, row.target.episodeId) },
                    onDownload = { viewModel.download(row.target.itemId, row.target.episodeId) },
                    onOpenItem = { onOpenItem(row.target.itemId) }
                )

                HomeRow.ContinueHeader -> SectionHeader("Continue Listening")

                is HomeRow.Continue -> TomeChip(
                    label = row.item.title,
                    secondaryLabel = row.item.authorName,
                    onClick = { onPlay(row.item.id, row.item.episodeId) },
                    icon = {
                        CoverImage(
                            model = coverModel(null, row.item.id),
                            modifier = Modifier.size(34.dp)
                        )
                    },
                    trailing = {
                        // The chip body plays; this is the row's second verb.
                        // It replaced a decorative play triangle — tap-to-play
                        // is already the whole chip.
                        HomeDownloadButton(
                            state = HomeSections.downloadState(
                                state.downloads, state.requestedDownloads,
                                row.item.id, row.item.episodeId
                            ),
                            onDownload = { viewModel.download(row.item.id, row.item.episodeId) },
                            onOpenItem = { onOpenItem(row.item.id) }
                        )
                    }
                )

                HomeRow.Offline -> Note("Offline — showing what's on the watch")

                is HomeRow.Downloads -> TomeChip(
                    label = "Downloads",
                    secondaryLabel = if (row.count > 0) "${row.count} on watch" else "Nothing yet",
                    onClick = onOpenDownloads,
                    icon = { DownloadGlyph(tint = MaterialTheme.colorScheme.primary) }
                )

                is HomeRow.Library -> TomeChip(
                    label = row.library.name,
                    onClick = { onOpenLibrary(row.library.id) },
                    icon = {
                        if (row.library.mediaType == "podcast") {
                            PodcastGlyph(tint = MaterialTheme.colorScheme.primary)
                        } else {
                            BookGlyph(tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                )

                HomeRow.Settings -> TomeChip(
                    label = "Settings",
                    onClick = onOpenSettings,
                    icon = { SettingsGlyph(tint = MaterialTheme.colorScheme.primary) }
                )
            }
        }

        searchLibraryId?.let { id ->
            item {
                // Last of the navigation chips rather than slotted among them:
                // HomeSections owns the row order and ends it with Settings, and
                // splitting that list here would put the order in two places.
                TomeChip(
                    label = "Search",
                    onClick = { onOpenSearch(id) },
                    icon = { SearchGlyph(tint = MaterialTheme.colorScheme.primary) }
                )
            }
        }
    }
}

/**
 * The resume card. Bigger than a chip on purpose: it is the one row that is
 * right nine times out of ten, and on a round screen the widest thing belongs
 * where the screen is widest — the middle, which is where a ScalingLazyColumn
 * puts the top of a short list.
 */
@Composable
private fun ResumeCard(
    target: ResumeTarget,
    downloadState: HomeDownloadState,
    onClick: () -> Unit,
    onDownload: () -> Unit,
    onOpenItem: () -> Unit
) {
    TomeCard(onClick = onClick, background = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CoverImage(
                model = coverModel(target.coverPath, target.itemId),
                modifier = Modifier.size(48.dp)
            )
            Spacer(Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = target.title,
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                val author = target.author
                if (!author.isNullOrBlank()) {
                    Text(
                        text = author,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            Spacer(Modifier.width(6.dp))
            PlayGlyph(tint = MaterialTheme.colorScheme.primary, dim = 18.dp)
        }
        val percent = UiFormat.percent(target.progress)
        run {
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // ResumeTarget.downloaded can be true off an ITEM-level entry
                // while an episode resume's own entry is absent — both signals
                // are shown when they disagree, because both are true.
                if (target.downloaded && downloadState != HomeDownloadState.Downloaded) {
                    DownloadedGlyph(tint = MaterialTheme.colorScheme.primary, dim = 12.dp)
                    Spacer(Modifier.width(6.dp))
                }
                if (percent != null) {
                    LinearProgress(
                        fraction = (target.progress ?: 0.0).toFloat(),
                        modifier = Modifier.weight(1f)
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = percent,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1
                    )
                } else {
                    Spacer(Modifier.weight(1f))
                }
                Spacer(Modifier.width(6.dp))
                HomeDownloadButton(
                    state = downloadState,
                    onDownload = onDownload,
                    onOpenItem = onOpenItem
                )
            }
        }
    }
}

/**
 * The rows' second verb, in one glyph: not on the watch → download it (default
 * constraints); requested or already here → open the item screen, where the
 * real states (progress, force, delete) live. Its own clickable inside a
 * clickable row — the inner target wins the tap, which is the entire point.
 */
@Composable
private fun HomeDownloadButton(
    state: HomeDownloadState,
    onDownload: () -> Unit,
    onOpenItem: () -> Unit
) {
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(CircleShape)
            .clickable(
                role = Role.Button,
                // An icon-only control is invisible to a screen reader without
                // this; the label names the VERB the tap performs in each state.
                onClickLabel = when (state) {
                    HomeDownloadState.None -> "Download"
                    HomeDownloadState.Requested -> "Open item, download in progress"
                    HomeDownloadState.Downloaded -> "Open downloaded item"
                },
                onClick = if (state == HomeDownloadState.None) onDownload else onOpenItem
            ),
        contentAlignment = Alignment.Center
    ) {
        when (state) {
            HomeDownloadState.None ->
                DownloadGlyph(tint = MaterialTheme.colorScheme.primary, dim = 16.dp)
            // The refresh mark, not a checkmark: the entry doesn't exist yet and
            // the worker may be waiting on charger + Wi-Fi.
            HomeDownloadState.Requested ->
                RefreshGlyph(tint = MaterialTheme.colorScheme.onSurfaceVariant, dim = 16.dp)
            HomeDownloadState.Downloaded ->
                DownloadedGlyph(tint = MaterialTheme.colorScheme.primary, dim = 16.dp)
        }
    }
}
