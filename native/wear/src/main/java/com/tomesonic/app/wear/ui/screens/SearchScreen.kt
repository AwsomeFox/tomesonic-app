package com.tomesonic.app.wear.ui.screens

import android.app.RemoteInput
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.input.RemoteInputIntentHelper
import com.tomesonic.app.wear.ui.SearchViewModel
import com.tomesonic.app.wear.ui.components.ChevronGlyph
import com.tomesonic.app.wear.ui.components.MediaRow
import com.tomesonic.app.wear.ui.components.Note
import com.tomesonic.app.wear.ui.components.ScreenTitle
import com.tomesonic.app.wear.ui.components.ScrollScreen
import com.tomesonic.app.wear.ui.components.SearchGlyph
import com.tomesonic.app.wear.ui.components.TomeChip
import com.tomesonic.app.wear.ui.components.coverModel

/** The RemoteInput result key, and the only name the result Bundle is read by. */
private const val QUERY_KEY = "search_query"

/**
 * One library, searched.
 *
 * There is no text field here and there cannot be one: typing on a watch is the
 * platform's job, and it does it in its OWN activity — ONE RemoteInput handed to
 * [RemoteInputIntentHelper], which offers voice, keyboard and handwriting
 * according to what the watch has. The screen's whole input handling is
 * therefore an activity result, not a state hoist.
 *
 * That RemoteInput is the PLATFORM one (android.app, API 20+, well under this
 * module's minSdk 30), not androidx.core's: the helper puts the inputs into the
 * intent as Parcelables for the system activity to read, and the compat class is
 * not one.
 *
 * The input opens on arrival rather than behind a chip: this screen exists only
 * to take a query, and a first tap that only asks for the second tap is a tap
 * this app can do without.
 */
@Composable
fun SearchScreen(
    libraryId: String,
    onOpenItem: (String) -> Unit
) {
    val viewModel: SearchViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        // No data is a DISMISSED input (swipe back, cancel) — leave whatever is
        // on screen alone rather than clearing it to an empty search.
        result.data?.let { data ->
            viewModel.search(RemoteInput.getResultsFromIntent(data)?.getCharSequence(QUERY_KEY))
        }
    }

    var inputUnavailable by remember(libraryId) { mutableStateOf(false) }

    val openInput: () -> Unit = {
        val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(
            intent,
            listOf(RemoteInput.Builder(QUERY_KEY).setLabel("Search").build())
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

    LaunchedEffect(libraryId) {
        viewModel.start(libraryId)
        // Once per library — the effect re-runs whenever this composition is
        // recreated, and the input activity is exactly what recreates it.
        if (viewModel.consumePrompt()) openInput()
    }

    ScrollScreen {
        item { ScreenTitle("Search") }

        if (state.query.isNotEmpty()) {
            // Echoed because the query came from a microphone as often as from a
            // keyboard, and a wrong transcription otherwise looks like a library
            // with nothing in it.
            item { Note("“${state.query}”") }
        } else if (!state.searching) {
            item { Note("Say or type a title or an author.") }
        }

        if (inputUnavailable) {
            item {
                Note(
                    "This watch has no way to take the query.",
                    color = MaterialTheme.colorScheme.error
                )
            }
        }

        if (state.searching) {
            item { Note("Loading…") }
        }

        items(state.results.size) { index ->
            val result = state.results[index]
            MediaRow(
                title = result.title,
                subtitle = result.authorName,
                progress = result.progress,
                cover = coverModel(null, result.id),
                onClick = { onOpenItem(result.id) },
                trailing = { ChevronGlyph(tint = MaterialTheme.colorScheme.onSurfaceVariant) }
            )
        }

        if (state.answered && state.results.isEmpty()) {
            item { Note("No matches") }
        }

        if (state.failed) {
            item { Note("Couldn't search — try again", color = MaterialTheme.colorScheme.error) }
            item {
                TomeChip(
                    label = "Try again",
                    onClick = { viewModel.retry() },
                    modifier = Modifier.padding(top = 6.dp)
                )
            }
        }

        if (!state.searching) {
            item {
                TomeChip(
                    label = if (state.query.isEmpty()) "Search" else "Search again",
                    onClick = openInput,
                    modifier = Modifier.padding(top = 6.dp),
                    icon = { SearchGlyph(tint = MaterialTheme.colorScheme.primary) }
                )
            }
        }
    }
}
