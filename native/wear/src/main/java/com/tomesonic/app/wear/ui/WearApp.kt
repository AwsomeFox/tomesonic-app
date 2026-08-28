package com.tomesonic.app.wear.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.MaterialTheme
import androidx.navigation.NavOptions
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import com.tomesonic.app.wear.DebugLaunch
import com.tomesonic.app.wear.LaunchRequests
import com.tomesonic.app.wear.ui.components.AppMarkGlyph
import com.tomesonic.app.wear.ui.components.LocalCoverLoader
import com.tomesonic.app.wear.ui.screens.ConnectScreen
import com.tomesonic.app.wear.ui.screens.DownloadsScreen
import com.tomesonic.app.wear.ui.screens.HomeScreen
import com.tomesonic.app.wear.ui.screens.ItemScreen
import com.tomesonic.app.wear.ui.screens.LibraryScreen
import com.tomesonic.app.wear.ui.screens.PlayerScreen
import com.tomesonic.app.wear.ui.screens.SearchScreen
import com.tomesonic.app.wear.ui.screens.SettingsScreen
import com.tomesonic.app.wear.ui.theme.TomeSonicWearTheme

/**
 * The whole app: theme, the one Coil loader, and the navigation graph.
 *
 * Two structural decisions worth the words:
 *
 * 1. The graph is REBUILT (via `key`) when the watch crosses the
 *    connected/disconnected line, rather than navigated across. Signing in and
 *    signing out are both "everything you were looking at is gone" — a fresh
 *    NavHost with the right start destination says that exactly, where a
 *    navigate-and-pop has to guess what was on the stack.
 *
 * 2. Nothing renders until the credential store has answered once
 *    ([RootState.loaded]). DataStore takes a few frames on a cold start, and
 *    without the gate every launch flashes "connect your watch" at a watch that
 *    is connected.
 */
@Composable
fun WearApp() {
    TomeSonicWearTheme {
        val root: RootViewModel = viewModel()
        val state by root.state.collectAsState()

        CompositionLocalProvider(LocalCoverLoader provides root.coverLoader) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.background)
            ) {
                if (!state.loaded) {
                    AppMarkGlyph(
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.align(Alignment.Center),
                        dim = 44.dp
                    )
                    return@Box
                }

                val connected = state.creds != null && !state.authFailed
                key(connected) {
                    val navController = rememberSwipeDismissableNavController()
                    val openPlayer: (String, String?) -> Unit = { itemId, episodeId ->
                        // Fire-and-forget by design: the service resolves the
                        // session in the background (see PlayerConnection), so
                        // the player screen opens immediately and fills in.
                        root.player.playItem(itemId, episodeId)
                        // singleTop: every Play/Resume converges on ONE player
                        // entry — a plain navigate stacked a duplicate per tap,
                        // and swipe-dismiss then unwound through stale players.
                        // NavOptions.Builder (not the ktx builder lambda) so the
                        // call compiles against navigation-runtime alone.
                        navController.navigate(
                            Routes.PLAYER,
                            NavOptions.Builder().setLaunchSingleTop(true).build()
                        )
                    }

                    // Two one-shot launch channels share this effect: the
                    // screenshot rig's DebugLaunch (debug builds only — see its
                    // FLAG_DEBUGGABLE gate) and the tile/complication taps in
                    // LaunchRequests, which ship in every build. Keyed on the
                    // REVISION, not Unit: a tile tap on an already-open app
                    // lands in MainActivity.onNewIntent long after a Unit-keyed
                    // effect has run and would never look again.
                    val launchRevision by LaunchRequests.revision.collectAsState()
                    if (connected) {
                        LaunchedEffect(launchRevision) {
                            // Consumed rather than observed — the rig asks for
                            // one screen and one book, once, on the launch that
                            // named them. navigate() rather than a start
                            // destination for arg routes: see DebugLaunch.route.
                            DebugLaunch.consumeNavigateRoute()?.let { navController.navigate(it) }
                            DebugLaunch.consumePlayItemId()?.let { root.player.playItem(it) }

                            // Tile / complication tap. A Resume with an item
                            // starts the book; a bare open-player (the
                            // complication) shows whatever is current.
                            LaunchRequests.consume()?.let { request ->
                                val itemId = request.playItemId
                                if (itemId != null) {
                                    openPlayer(itemId, request.playEpisodeId)
                                } else if (request.openPlayer) {
                                    navController.navigate(
                                        Routes.PLAYER,
                                        NavOptions.Builder().setLaunchSingleTop(true).build()
                                    )
                                }
                            }
                        }
                    }

                    SwipeDismissableNavHost(
                        navController = navController,
                        startDestination = DebugLaunch.route ?: Routes.startDestination(
                            hasCreds = state.creds != null,
                            authFailed = state.authFailed
                        ),
                        modifier = Modifier.fillMaxSize()
                    ) {
                        composable(Routes.CONNECT) {
                            ConnectScreen(
                                authFailed = state.authFailed,
                                onOpenDownloads = { navController.navigate(Routes.DOWNLOADS) }
                            )
                        }

                        composable(Routes.HOME) {
                            HomeScreen(
                                onPlay = openPlayer,
                                onOpenLibrary = { navController.navigate(Routes.library(it)) },
                                onOpenSearch = { navController.navigate(Routes.search(it)) },
                                onOpenDownloads = { navController.navigate(Routes.DOWNLOADS) },
                                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                                onOpenItem = { navController.navigate(Routes.item(it)) }
                            )
                        }

                        composable(Routes.LIBRARY_TEMPLATE) { entry ->
                            LibraryScreen(
                                libraryId = entry.arguments?.getString(Routes.ARG_ID).orEmpty(),
                                onOpenItem = { navController.navigate(Routes.item(it)) },
                                onOpenSearch = { navController.navigate(Routes.search(it)) }
                            )
                        }

                        composable(Routes.SEARCH_TEMPLATE) { entry ->
                            SearchScreen(
                                libraryId = entry.arguments?.getString(Routes.ARG_ID).orEmpty(),
                                onOpenItem = { navController.navigate(Routes.item(it)) }
                            )
                        }

                        composable(Routes.ITEM_TEMPLATE) { entry ->
                            ItemScreen(
                                itemId = entry.arguments?.getString(Routes.ARG_ID).orEmpty(),
                                onPlay = openPlayer
                            )
                        }

                        composable(Routes.PLAYER) {
                            PlayerScreen(player = root.player)
                        }

                        composable(Routes.DOWNLOADS) {
                            DownloadsScreen(
                                onOpenItem = { navController.navigate(Routes.item(it)) }
                            )
                        }

                        composable(Routes.SETTINGS) {
                            SettingsScreen()
                        }
                    }
                }
            }
        }
    }
}
