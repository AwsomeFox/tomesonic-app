package com.tomesonic.app.wear.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import com.tomesonic.app.wear.ui.DownloadCommand
import com.tomesonic.app.wear.ui.ItemActions
import com.tomesonic.app.wear.ui.ItemViewModel
import com.tomesonic.app.wear.ui.UiFormat
import com.tomesonic.app.wear.ui.components.CoverImage
import com.tomesonic.app.wear.ui.components.DownloadGlyph
import com.tomesonic.app.wear.ui.components.DownloadedGlyph
import com.tomesonic.app.wear.ui.components.LinearProgress
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.PlayGlyph
import com.tomesonic.app.wear.ui.components.PrimaryChip
import com.tomesonic.app.wear.ui.components.RoundIconButton
import com.tomesonic.app.wear.ui.components.ScreenTitle
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.SectionHeader
import com.tomesonic.app.wear.ui.components.TomeChip
import com.tomesonic.app.wear.ui.components.TrashGlyph
import com.tomesonic.app.wear.ui.components.coverModel

/**
 * One book (or podcast), with the two verbs that matter: play it, keep it.
 *
 * A podcast's downloads are PER EPISODE — the item itself has no audio — so the
 * book's download section is replaced by one compact affordance on each episode
 * row: the row plays, a small trailing button runs whatever ItemActions.forStatus
 * offers for THAT episode, and the state line lives in the row's second line so
 * a list of ten episodes doesn't become a list of thirty rows.
 */
@Composable
fun ItemScreen(
    itemId: String,
    onPlay: (String, String?) -> Unit
) {
    val viewModel: ItemViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    LaunchedEffect(itemId) { viewModel.start(itemId) }

    var playMessage by remember(itemId) { mutableStateOf<String?>(null) }
    var confirmDelete by remember(itemId) { mutableStateOf(false) }
    // At most one episode is ever mid-confirm: the second tap has to be on the
    // chip the first tap raised, and two open confirmations would be two ways to
    // delete the wrong thing.
    var confirmEpisode by remember(itemId) { mutableStateOf<String?>(null) }

    val play: (String?) -> Unit = { episodeId ->
        val result = ItemActions.precheck(
            hasCreds = state.hasCreds,
            downloaded = state.downloaded,
            detailLoaded = state.detailLoaded,
            trackCount = state.trackCount,
            // Episode taps must not be judged by the ITEM's track list — a
            // podcast's is legitimately empty (see precheck).
            isEpisode = episodeId != null,
            episodeDownloaded = state.episodeDownloaded(episodeId)
        )
        val message = ItemActions.message(result)
        if (message == null) {
            playMessage = null
            onPlay(itemId, episodeId)
        } else {
            // Stay on the screen: the message is only useful next to the button
            // that produced it, and the player would have nothing to show.
            playMessage = message
        }
    }

    ScrollScreen {
        item {
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                CoverImage(
                    model = coverModel(state.coverPath, itemId),
                    modifier = Modifier.size(84.dp),
                    shape = RoundedCornerShape(12.dp)
                )
            }
        }

        item { ScreenTitle(if (state.title.isNotBlank()) state.title else "Loading…") }

        if (!state.author.isNullOrBlank()) {
            item { Note(state.author.orEmpty()) }
        }

        item {
            val duration = UiFormat.durationWords(state.duration)
            val percent = UiFormat.percent(state.progress)
            val line = listOfNotNull(duration.takeIf { it.isNotEmpty() }, percent).joinToString(" · ")
            if (line.isNotEmpty()) Note(line)
        }

        // > 0, not != null: a never-started book can carry an explicit server
        // position of 0.0, and UiFormat.percent already reads <= 0 as "no
        // progress" — an empty bar under a missing label is just noise. Same
        // rule MediaRow and the home resume card apply.
        if ((state.progress ?: 0.0) > 0.0) {
            item {
                LinearProgress(
                    fraction = (state.progress ?: 0.0).toFloat(),
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp)
                )
            }
        }

        if (!state.isPodcast) {
            item {
                PrimaryChip(
                    label = if ((state.progress ?: 0.0) > 0.01) "Resume" else "Play",
                    onClick = { play(null) },
                    modifier = Modifier.padding(top = 4.dp),
                    icon = { PlayGlyph(tint = MaterialTheme.colorScheme.onPrimaryContainer, dim = 16.dp) }
                )
            }
        }

        playMessage?.let { message ->
            item { Note(message, color = MaterialTheme.colorScheme.error) }
        }

        // --- podcast: recent episodes, each with its own download ------------
        if (state.isPodcast) {
            if (state.episodes.isNotEmpty()) {
                item { SectionHeader("Recent episodes") }
                state.episodes.forEach { episode ->
                    val download = state.episodeDownload(episode.id)
                    val ui = ItemActions.forStatus(download.status, download.bytes)
                    item {
                        TomeChip(
                            label = episode.title,
                            // Duration and download state share the one line the
                            // row already has: "42m · Downloading 30%".
                            secondaryLabel = listOfNotNull(
                                episode.duration
                                    ?.let { UiFormat.durationWords(it) }
                                    ?.takeIf { it.isNotEmpty() },
                                ui.headline
                            ).joinToString(" · ").takeIf { it.isNotEmpty() },
                            onClick = { play(episode.id) },
                            icon = { PlayGlyph(tint = MaterialTheme.colorScheme.primary, dim = 14.dp) },
                            trailing = {
                                // Its own tap target inside the row: the row
                                // plays, this runs the download command. Compose
                                // hands the tap to the innermost clickable, so
                                // the two never fire together.
                                ui.primary?.let { option ->
                                    RoundIconButton(
                                        onClick = {
                                            if (option.command == DownloadCommand.Delete) {
                                                confirmEpisode = episode.id
                                            } else {
                                                confirmEpisode = null
                                                viewModel.runCommand(option.command, episode.id)
                                            }
                                        },
                                        diameter = 34.dp
                                    ) {
                                        EpisodeDownloadGlyph(option.command)
                                    }
                                }
                            }
                        )
                    }
                    // The book's two-tap confirm, inline under the row that
                    // raised it — nothing else on the screen moves.
                    if (confirmEpisode == episode.id) {
                        item { Note("Delete this episode?", color = MaterialTheme.colorScheme.error) }
                        item {
                            TomeChip(
                                label = "Delete",
                                onClick = {
                                    confirmEpisode = null
                                    viewModel.runCommand(DownloadCommand.Delete, episode.id)
                                },
                                background = MaterialTheme.colorScheme.errorContainer,
                                contentColor = MaterialTheme.colorScheme.onErrorContainer,
                                icon = {
                                    TrashGlyph(
                                        tint = MaterialTheme.colorScheme.onErrorContainer,
                                        dim = 16.dp
                                    )
                                }
                            )
                        }
                        item { TomeChip(label = "Keep", onClick = { confirmEpisode = null }) }
                    }
                }
            } else if (!state.loading) {
                item { Note("No episodes — open this podcast on your phone.") }
            }
            return@ScrollScreen
        }

        // --- book: the download section --------------------------------------
        val download = ItemActions.forStatus(state.status, state.bytes)

        download.headline?.let { headline ->
            item { Note(headline) }
        }
        download.progress?.let { progress ->
            item {
                LinearProgress(
                    fraction = progress / 100f,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp)
                )
            }
        }

        if (confirmDelete) {
            item { Note("Delete this download?", color = MaterialTheme.colorScheme.error) }
            item {
                TomeChip(
                    label = "Delete",
                    onClick = {
                        confirmDelete = false
                        viewModel.runCommand(DownloadCommand.Delete)
                    },
                    background = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    icon = { TrashGlyph(tint = MaterialTheme.colorScheme.onErrorContainer, dim = 16.dp) }
                )
            }
            item {
                TomeChip(label = "Keep", onClick = { confirmDelete = false })
            }
        } else {
            download.primary?.let { option ->
                item {
                    TomeChip(
                        label = option.label,
                        onClick = {
                            if (option.command == DownloadCommand.Delete) {
                                confirmDelete = true
                            } else {
                                viewModel.runCommand(option.command)
                            }
                        },
                        icon = {
                            // Cancel is the one command with nothing to picture:
                            // a crossed-out download reads as "failed".
                            when (option.command) {
                                DownloadCommand.Delete ->
                                    TrashGlyph(tint = MaterialTheme.colorScheme.primary, dim = 16.dp)

                                DownloadCommand.Cancel -> Unit

                                else ->
                                    DownloadGlyph(tint = MaterialTheme.colorScheme.primary, dim = 16.dp)
                            }
                        }
                    )
                }
            }
            download.secondary?.let { option ->
                item {
                    TomeChip(
                        label = option.label,
                        // The escape hatch from "waiting for a charger": same
                        // job, no constraints (DownloadRepository.enqueue force).
                        secondaryLabel = "Ignores charger + Wi-Fi",
                        onClick = { viewModel.runCommand(option.command) }
                    )
                }
            }
        }
    }
}

/**
 * The episode row's trailing glyph: what the download IS, while the tap does
 * what [ItemActions.forStatus] offers. Queued and downloading share the plain
 * download mark in the muted tint — the row's second line is already carrying
 * "Waiting for charger + Wi-Fi" or a percentage, and a third symbol for a state
 * that is about to change reads as clutter at 34dp.
 */
@Composable
private fun EpisodeDownloadGlyph(command: DownloadCommand) {
    when (command) {
        DownloadCommand.Delete ->
            DownloadedGlyph(tint = MaterialTheme.colorScheme.primary, dim = 16.dp)

        DownloadCommand.Cancel ->
            DownloadGlyph(tint = MaterialTheme.colorScheme.onSurfaceVariant, dim = 16.dp)

        else -> DownloadGlyph(tint = MaterialTheme.colorScheme.primary, dim = 16.dp)
    }
}
