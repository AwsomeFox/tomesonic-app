package com.tomesonic.app.wear.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.tomesonic.app.wear.Formatters
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.playback.PlayerConnection
import com.tomesonic.app.wear.ui.SpeedSteps
import com.tomesonic.app.wear.ui.VolumeController
import com.tomesonic.app.wear.ui.components.ChapterGlyph
import com.tomesonic.app.wear.ui.components.CoverImage
import com.tomesonic.app.wear.ui.components.DownloadedGlyph
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.PauseGlyph
import com.tomesonic.app.wear.ui.components.PlayGlyph
import com.tomesonic.app.wear.ui.components.ProgressArc
import com.tomesonic.app.wear.ui.components.RoundIconButton
import com.tomesonic.app.wear.ui.components.SeekGlyph
import com.tomesonic.app.wear.ui.components.coverModel
import com.tomesonic.app.wear.ui.theme.TomeSonicColors

/**
 * The player. Cover behind everything, progress around the edge, transport in
 * the middle — the layout a watch can use without looking at it twice.
 *
 * Every number on screen comes from PlayerConnection.state, which is
 * BOOK-absolute (the queue is one media item per track, so the player's own
 * position means nothing to a scrubber) and repolls once a second while anyone
 * is watching.
 *
 * VOLUME: the rotary crown, via compose-ui's `onRotaryScrollEvent` — the
 * stable input API rather than wear-foundation's rotary-scroll helpers, which
 * are built for scrollables and would have to be talked out of scrolling
 * something. Because a crown cannot be assumed (some watches have only buttons,
 * and an emulator has neither), the −/+ pair below is not a fallback for a
 * failed API but a second, always-present control.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PlayerScreen(player: PlayerConnection) {
    val state by player.state.collectAsState()
    val context = LocalContext.current
    val volume = remember(context) { VolumeController(context) }
    val focusRequester = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        try {
            focusRequester.requestFocus()
        } catch (t: Throwable) {
            // No focus target yet, or a watch that refuses it. The buttons work.
        }
    }

    val itemId = state.itemId
    // entryForNow is the non-suspending index read; MainApplication warms the
    // index at startup, so this answers correctly from the first frame.
    val downloaded = remember(itemId) {
        itemId != null && Graph.downloadRepository.entryForNow(itemId) != null
    }
    val fraction = if (state.durationMs > 0L) {
        (state.positionMs.toFloat() / state.durationMs.toFloat()).coerceIn(0f, 1f)
    } else {
        0f
    }
    val hasChapters = state.chapterCount > 1

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .onRotaryScrollEvent { event ->
                volume.onRotary(event.verticalScrollPixels)
                true
            }
            .focusRequester(focusRequester)
            .focusable()
    ) {
        CoverImage(
            // The session's own artwork first: a downloaded book carries a
            // file:// cover that renders with no network at all.
            model = state.coverUri ?: coverModel(null, itemId),
            modifier = Modifier.fillMaxSize(),
            shape = RectangleShape,
            alpha = 0.30f
        )
        // The scrim is the app background, not black: it keeps the whole screen
        // inside the same green-black the rest of the app sits on.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background.copy(alpha = 0.62f))
        )
        ProgressArc(
            fraction = fraction,
            modifier = Modifier.fillMaxSize(),
            strokeWidth = 4.dp
        )

        if (itemId == null && state.title.isBlank()) {
            Note(
                text = "Nothing playing yet",
                modifier = Modifier.align(Alignment.Center)
            )
            return@Box
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 18.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            // The chapter is the useful line; the book title is the fallback,
            // never both on the first line.
            Text(
                text = state.chapterTitle?.takeIf { it.isNotBlank() } ?: state.title,
                modifier = Modifier.fillMaxWidth(),
                color = TomeSonicColors.OnMedia,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            val second = if (state.chapterTitle.isNullOrBlank()) state.author else state.title
            if (!second.isNullOrBlank()) {
                Text(
                    text = second,
                    modifier = Modifier.fillMaxWidth(),
                    color = TomeSonicColors.OnMediaVariant,
                    style = MaterialTheme.typography.labelSmall,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            Spacer(Modifier.height(4.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                if (downloaded) {
                    DownloadedGlyph(tint = MaterialTheme.colorScheme.primary, dim = 11.dp)
                    Spacer(Modifier.width(4.dp))
                }
                Text(
                    text = "${Formatters.msToClock(state.positionMs)} / ${Formatters.msToClock(state.durationMs)}",
                    color = TomeSonicColors.OnMediaVariant,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1
                )
            }

            Spacer(Modifier.height(6.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                RoundIconButton(onClick = { player.seekBy(-30) }, diameter = 36.dp) {
                    SeekGlyph(
                        forward = false,
                        tint = MaterialTheme.colorScheme.onSurface,
                        dim = 20.dp
                    )
                }
                Spacer(Modifier.width(8.dp))
                RoundIconButton(
                    onClick = { player.playPause() },
                    diameter = 50.dp,
                    background = MaterialTheme.colorScheme.primary
                ) {
                    if (state.isPlaying) {
                        PauseGlyph(tint = MaterialTheme.colorScheme.onPrimary, dim = 22.dp)
                    } else {
                        PlayGlyph(tint = MaterialTheme.colorScheme.onPrimary, dim = 22.dp)
                    }
                }
                Spacer(Modifier.width(8.dp))
                RoundIconButton(onClick = { player.seekBy(30) }, diameter = 36.dp) {
                    SeekGlyph(
                        forward = true,
                        tint = MaterialTheme.colorScheme.onSurface,
                        dim = 20.dp
                    )
                }
            }

            Spacer(Modifier.height(5.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                // Chapter buttons only exist when there is more than one chapter
                // — on a single-chapter book they would silently do nothing.
                if (hasChapters) {
                    RoundIconButton(onClick = { player.prevChapter() }, diameter = 28.dp) {
                        ChapterGlyph(
                            forward = false,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            dim = 14.dp
                        )
                    }
                    Spacer(Modifier.width(6.dp))
                }
                SpeedChip(
                    speed = state.speed,
                    onClick = { player.setSpeed(SpeedSteps.next(state.speed)) }
                )
                if (hasChapters) {
                    Spacer(Modifier.width(6.dp))
                    RoundIconButton(onClick = { player.nextChapter() }, diameter = 28.dp) {
                        ChapterGlyph(
                            forward = true,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            dim = 14.dp
                        )
                    }
                }
            }

            Spacer(Modifier.height(4.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                VolumeButton(label = "−", onClick = { volume.lower() })
                Spacer(Modifier.width(14.dp))
                VolumeButton(label = "+", onClick = { volume.raise() })
            }
        }
    }
}

/** The speed cycle, as one tap. Long enough to read "1.25×" without wrapping. */
@Composable
private fun SpeedChip(speed: Float, onClick: () -> Unit) {
    RoundIconButton(
        onClick = onClick,
        diameter = 32.dp,
        background = MaterialTheme.colorScheme.secondaryContainer
    ) {
        Text(
            text = SpeedSteps.label(speed),
            color = MaterialTheme.colorScheme.onSecondaryContainer,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1
        )
    }
}

@Composable
private fun VolumeButton(label: String, onClick: () -> Unit) {
    RoundIconButton(onClick = onClick, diameter = 26.dp) {
        Text(
            text = label,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1
        )
    }
}
