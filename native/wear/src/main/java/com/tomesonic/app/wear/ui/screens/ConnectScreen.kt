package com.tomesonic.app.wear.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.tomesonic.app.wear.ui.DownloadsViewModel
import com.tomesonic.app.wear.ui.UiFormat
import com.tomesonic.app.wear.ui.components.AppMarkGlyph
import com.tomesonic.app.wear.ui.components.DownloadGlyph
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.TomeChip

/**
 * The screen for a watch that cannot talk to a server, in its two flavours.
 *
 * v1 has no watch-side login by design (the contract's `standalone=false`): the
 * server and token arrive from the paired phone over the Data Layer, so the only
 * honest instruction either flavour can give is "do it on the phone". The two
 * differ because the actions differ — one is "sign in", the other is "sign in
 * AGAIN", and telling a user who is already signed in to connect their watch
 * sends them looking for a setting that doesn't exist.
 *
 * Downloads stay reachable from here. A dead token doesn't unplay a book that is
 * already on the watch, and burying it behind a screen the user cannot dismiss
 * would be the one genuinely broken thing about this state.
 */
@Composable
fun ConnectScreen(
    authFailed: Boolean,
    onOpenDownloads: () -> Unit
) {
    val downloadsViewModel: DownloadsViewModel = viewModel()
    val downloads by downloadsViewModel.state.collectAsState()

    ScrollScreen {
        item {
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                AppMarkGlyph(tint = MaterialTheme.colorScheme.primary, dim = 44.dp)
            }
        }
        item {
            Text(
                text = "TomeSonic",
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp, bottom = 4.dp),
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center
            )
        }
        item {
            Note(
                text = if (authFailed) {
                    "Reconnect from your phone. Open TomeSonic there and sign in again."
                } else {
                    "Open TomeSonic on your phone to connect this watch."
                },
                color = if (authFailed) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                }
            )
        }
        if (downloads.entries.isNotEmpty()) {
            item {
                TomeChip(
                    label = "Downloads",
                    secondaryLabel = "${downloads.entries.size} on watch · ${UiFormat.bytes(downloads.totalBytes)}",
                    onClick = onOpenDownloads,
                    modifier = Modifier.padding(top = 10.dp),
                    icon = {
                        DownloadGlyph(tint = MaterialTheme.colorScheme.primary)
                    }
                )
            }
        }
    }
}
