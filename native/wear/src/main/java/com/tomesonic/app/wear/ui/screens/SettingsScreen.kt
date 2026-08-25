package com.tomesonic.app.wear.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
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
 * Everything the watch can tell you about itself, and the one thing it can do
 * about it.
 *
 * No "disconnect" row: the phone owns the session (it puts empty credentials on
 * the Data Layer to log out), so a watch-side disconnect would leave the two
 * disagreeing about whether they are paired. A documented v1 non-goal.
 */
@Composable
fun SettingsScreen() {
    val viewModel: SettingsViewModel = viewModel()
    val state by viewModel.state.collectAsState()

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
