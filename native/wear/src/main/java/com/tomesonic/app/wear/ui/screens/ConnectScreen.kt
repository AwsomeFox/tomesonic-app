package com.tomesonic.app.wear.ui.screens

import android.app.RemoteInput
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import androidx.wear.input.RemoteInputIntentHelper
import com.tomesonic.app.wear.ui.ConnectViewModel
import com.tomesonic.app.wear.ui.DownloadsViewModel
import com.tomesonic.app.wear.ui.UiFormat
import com.tomesonic.app.wear.ui.components.AppMarkGlyph
import com.tomesonic.app.wear.ui.components.DownloadGlyph
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.TomeChip

/**
 * The three RemoteInput result keys. One intent carries all three, and the
 * platform chains the input steps in this order.
 */
private const val SERVER_KEY = "server"
private const val USERNAME_KEY = "username"
private const val PASSWORD_KEY = "password"

/**
 * The screen for a watch that cannot talk to a server, in its two flavours.
 *
 * The phone remains the PRIMARY path and keeps the prose: it is the one place
 * with a real keyboard, it is where most users already are, and its credentials
 * overwrite whatever the watch holds. What v2 adds under it is the escape
 * hatch — a watch-owned sign-in for a watch that is out on its own, and, in the
 * authFailed flavour, the on-wrist fix for a mirrored token that has died with
 * the phone nowhere near.
 *
 * There is no text field here and there cannot be one: typing on a watch is the
 * platform's job, and it does it in its OWN activity — three RemoteInputs in one
 * intent handed to [RemoteInputIntentHelper], which the system presents as three
 * chained steps offering voice, keyboard and handwriting according to what the
 * watch has. That RemoteInput is the PLATFORM one (android.app, API 20+, well
 * under this module's minSdk 30), not androidx.core's: the helper puts the
 * inputs into the intent as Parcelables for the system activity to read, and the
 * compat class is not one. (Same idiom as SearchScreen, one input to three.)
 *
 * The password step is as private as the platform's input activity makes it —
 * there is no masked remote input — but it is spent on one request and stored
 * nowhere.
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

    val connectViewModel: ConnectViewModel = viewModel()
    val login by connectViewModel.state.collectAsState()

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        // No data is a DISMISSED input (swipe back, cancel) — say nothing rather
        // than reporting an error for something the user chose not to do.
        result.data?.let { data ->
            val results = RemoteInput.getResultsFromIntent(data)
            connectViewModel.signIn(
                results?.getCharSequence(SERVER_KEY),
                results?.getCharSequence(USERNAME_KEY),
                results?.getCharSequence(PASSWORD_KEY)
            )
        }
    }

    var inputUnavailable by remember { mutableStateOf(false) }

    val openInput: () -> Unit = {
        val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(
            intent,
            listOf(
                RemoteInput.Builder(SERVER_KEY).setLabel("Server address").build(),
                RemoteInput.Builder(USERNAME_KEY).setLabel("Username").build(),
                RemoteInput.Builder(PASSWORD_KEY).setLabel("Password").build()
            )
        )
        // launch() THROWS when nothing on the watch handles the remote-input
        // action (ActivityNotFound/Security). That is a line of copy, not a
        // crash dialog — but only for Exceptions: an Error here is a real bug
        // and stays loud.
        try {
            launcher.launch(intent)
            inputUnavailable = false
        } catch (e: Exception) {
            inputUnavailable = true
        }
    }

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

        if (login.signingIn) {
            item { Note("Signing in…", modifier = Modifier.padding(top = 8.dp)) }
        } else {
            item {
                TomeChip(
                    label = "Sign in on watch",
                    secondaryLabel = "Server, username, password",
                    onClick = openInput,
                    modifier = Modifier.padding(top = 8.dp),
                    icon = { AppMarkGlyph(tint = MaterialTheme.colorScheme.primary, dim = 18.dp) }
                )
            }
        }

        login.error?.let { message ->
            item { Note(message, color = MaterialTheme.colorScheme.error) }
        }

        if (inputUnavailable) {
            item {
                Note(
                    "This watch has no way to take the details.",
                    color = MaterialTheme.colorScheme.error
                )
            }
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
