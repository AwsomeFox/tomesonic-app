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
import com.tomesonic.app.wear.ui.components.LinearProgress
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.PlayGlyph
import com.tomesonic.app.wear.ui.components.PrimaryChip
import com.tomesonic.app.wear.ui.components.ScreenTitle
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.SectionHeader
import com.tomesonic.app.wear.ui.components.TomeChip
import com.tomesonic.app.wear.ui.components.TrashGlyph
import com.tomesonic.app.wear.ui.components.coverModel

/**
 * One book (or podcast), with the two verbs that matter: play it, keep it.
 *
 * Podcasts get an episode list and NO download affordance — episode downloads
 * are an explicit v1 non-goal (see ARCHITECTURE.md), and a Download chip that
 * downloads the wrong thing is worse than no chip.
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

    val play: (String?) -> Unit = { episodeId ->
        val result = ItemActions.precheck(
            hasCreds = state.hasCreds,
            downloaded = state.downloaded,
            detailLoaded = state.detailLoaded,
            trackCount = state.trackCount,
            // Episode taps must not be judged by the ITEM's track list — a
            // podcast's is legitimately empty (see precheck).
            isEpisode = episodeId != null
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

        if (state.progress != null) {
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

        // --- podcast: recent episodes, play-only -----------------------------
        if (state.isPodcast) {
            if (state.episodes.isNotEmpty()) {
                item { SectionHeader("Recent episodes") }
                items(state.episodes.size) { index ->
                    val episode = state.episodes[index]
                    TomeChip(
                        label = episode.title,
                        secondaryLabel = episode.duration?.let { UiFormat.durationWords(it) },
                        onClick = { play(episode.id) },
                        trailing = { PlayGlyph(tint = MaterialTheme.colorScheme.primary, dim = 14.dp) }
                    )
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
