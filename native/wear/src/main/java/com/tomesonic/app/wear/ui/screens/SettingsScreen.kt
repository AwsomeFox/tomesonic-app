package com.tomesonic.app.wear.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.tomesonic.app.wear.data.CredsSource
import com.tomesonic.app.wear.ui.SettingsViewModel
import com.tomesonic.app.wear.ui.UiFormat
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.RefreshGlyph
import com.tomesonic.app.wear.ui.components.ScreenTitle
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.StatusDot
import com.tomesonic.app.wear.ui.components.TomeCard
import com.tomesonic.app.wear.ui.components.TomeChip

/**
 * Everything the watch can tell you about itself, and the things it can do about
 * it.
 *
 * The sign-out row appears for a WATCH login only. A phone-mirrored session is
 * the phone's to end — the phone would push the same credentials straight back
 * over the Data Layer, so the row would read as broken. Which source is active
 * is therefore shown either way: it is what explains the row's absence.
 */
@Composable
fun SettingsScreen() {
    val viewModel: SettingsViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    // Two taps for a destructive verb, same shape as the item screen's delete.
    var confirmSignOut by remember { mutableStateOf(false) }

    ScrollScreen {
        item { ScreenTitle("Settings") }

        item {
            InfoCard(label = "Server", value = state.host ?: "Not connected") {
                StatusDot(
                    color = if (state.connected) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    }
                )
            }
        }

        state.username?.let { username ->
            item { InfoCard(label = "Signed in as", value = username) }
        }

        state.source?.let { source ->
            item {
                InfoCard(
                    label = "Signed in from",
                    value = when (source) {
                        CredsSource.PHONE -> "Phone"
                        CredsSource.WATCH -> "Watch"
                    }
                )
            }
        }

        item { InfoCard(label = "Storage used", value = UiFormat.bytes(state.storageBytes)) }

        item { InfoCard(label = "Version", value = state.version) }

        item {
            TomeChip(
                label = if (state.syncing) "Syncing…" else "Sync now",
                // Disabled while disconnected: a flush without a server or with
                // a rejected token can only fail, and the failure message would
                // just restate what the connection row above already says.
                secondaryLabel = if (state.connected) "Send offline progress" else "Connect to sync",
                enabled = !state.syncing && state.connected,
                onClick = { viewModel.syncNow() },
                icon = { RefreshGlyph(tint = MaterialTheme.colorScheme.primary) }
            )
        }

        state.syncMessage?.let { message ->
            item {
                Note(
                    text = message,
                    color = if (message == "Synced") {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    }
                )
            }
        }

        if (state.source == CredsSource.WATCH) {
            if (confirmSignOut) {
                item {
                    Note(
                        // The queue goes with the login (CredsRepository.clear),
                        // and a user who has been out of range deserves to know
                        // that before the tap, not after.
                        text = "Sign out? Unsent progress is dropped.",
                        color = MaterialTheme.colorScheme.error
                    )
                }
                item {
                    TomeChip(
                        label = "Sign out",
                        onClick = {
                            confirmSignOut = false
                            viewModel.signOut()
                        },
                        background = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer
                    )
                }
                item {
                    TomeChip(label = "Stay signed in", onClick = { confirmSignOut = false })
                }
            } else {
                item {
                    TomeChip(
                        label = "Sign out",
                        secondaryLabel = "This watch's own sign-in",
                        onClick = { confirmSignOut = true }
                    )
                }
            }
        }
    }
}

/**
 * A read-only fact. Label above value rather than beside it: a watch row is
 * about 150dp wide, and a server host beside its label is a host in three
 * characters and an ellipsis.
 */
@Composable
private fun InfoCard(
    label: String,
    value: String,
    leading: (@Composable () -> Unit)? = null
) {
    TomeCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) {
                leading()
                Spacer(Modifier.width(8.dp))
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = label,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1
                )
                Text(
                    text = value,
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}
