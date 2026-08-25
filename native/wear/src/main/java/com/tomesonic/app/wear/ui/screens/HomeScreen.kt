package com.tomesonic.app.wear.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.tomesonic.app.wear.ui.HomeRow
import com.tomesonic.app.wear.ui.HomeViewModel
import com.tomesonic.app.wear.ui.ResumeTarget
import com.tomesonic.app.wear.ui.UiFormat
import com.tomesonic.app.wear.ui.components.BookGlyph
import com.tomesonic.app.wear.ui.components.CoverImage
import com.tomesonic.app.wear.ui.components.DownloadGlyph
import com.tomesonic.app.wear.ui.components.DownloadedGlyph
import com.tomesonic.app.wear.ui.components.LinearProgress
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.PlayGlyph
import com.tomesonic.app.wear.ui.components.PodcastGlyph
import com.tomesonic.app.wear.ui.components.ScreenTitle
import com.tomesonic.app.wear.ui.components.ScrollScreen
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
 * The item screen is reachable from the library and from downloads, where
 * browsing is actually the point.
 */
@Composable
fun HomeScreen(
    onPlay: (String, String?) -> Unit,
    onOpenLibrary: (String) -> Unit,
    onOpenDownloads: () -> Unit,
    onOpenSettings: () -> Unit
) {
    val viewModel: HomeViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    // Re-entering home (back from the player, from settings) re-reads the
    // resume pointer, which the player has probably just moved.
    LaunchedEffect(Unit) { viewModel.refresh() }

    ScrollScreen {
        item { ScreenTitle("TomeSonic") }

        if (state.loading && state.rows.isEmpty()) {
            item { Note("Loading…") }
        }

        items(state.rows.size) { index ->
            when (val row = state.rows[index]) {
                is HomeRow.Resume -> ResumeCard(
                    target = row.target,
                    onClick = { onPlay(row.target.itemId, row.target.episodeId) }
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
                        PlayGlyph(tint = MaterialTheme.colorScheme.primary, dim = 14.dp)
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
    }
}

/**
 * The resume card. Bigger than a chip on purpose: it is the one row that is
 * right nine times out of ten, and on a round screen the widest thing belongs
 * where the screen is widest — the middle, which is where a ScalingLazyColumn
 * puts the top of a short list.
 */
@Composable
private fun ResumeCard(target: ResumeTarget, onClick: () -> Unit) {
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
        if (percent != null || target.downloaded) {
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (target.downloaded) {
                    DownloadedGlyph(tint = MaterialTheme.colorScheme.primary, dim = 12.dp)
                    Spacer(Modifier.width(6.dp))
                }
                LinearProgress(
                    fraction = (target.progress ?: 0.0).toFloat(),
                    modifier = Modifier.weight(1f)
                )
                if (percent != null) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = percent,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1
                    )
                }
            }
        }
    }
}
