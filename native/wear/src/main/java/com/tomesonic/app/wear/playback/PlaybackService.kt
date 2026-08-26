package com.tomesonic.app.wear.playback

import android.app.PendingIntent
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.MainActivity
import android.util.Log
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The watch's one player.
 *
 * A MediaSessionService (not a bare Service) because that is what makes system
 * media controls, the ongoing notification, and Bluetooth/AVRCP keys work
 * without writing any of them — and what lets the UI drive playback through a
 * MediaController that survives the Activity.
 *
 * ONE ExoPlayer serves both sources: OkHttp (sharing AbsClient's authorized
 * client, so streams carry the Bearer token) wrapped in DefaultDataSource, so
 * the `file://` uris of a downloaded book resolve through the same player with
 * the same queue, seek and position semantics.
 *
 * The notification is [WearMediaNotificationProvider]'s rather than media3's
 * stock one, for the single reason that a Wear Ongoing Activity can only attach
 * to the notification THIS service posts. It keeps media3's channel, id and
 * layout, so nothing else about the notification moves.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    // The handler is load-bearing: children of this scope are fire-and-forget
    // command handlers, and an uncaught exception in one would reach the
    // DEFAULT handler and take the whole watch app down mid-listen. One bad
    // play must cost that tap, never the process.
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.IO +
            CoroutineExceptionHandler { _, t -> Log.w(TAG, "playback command failed", t) }
    )

    private lateinit var player: ExoPlayer
    private lateinit var sessions: SessionManager
    private var mediaSession: MediaSession? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        // The system can start this service on its own (a media button, a
        // controller binding) with no Application pass through Graph.
        Graph.init(this)

        // ONE http stack for the whole app: AbsClient's interceptor is where the
        // Bearer token and the 401 tracking live, and a second client here would
        // stream unauthenticated.
        val http = OkHttpDataSource.Factory(Graph.absClient.client)
        val dataSources = DefaultDataSource.Factory(this, http)

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    // SPEECH, not MUSIC: it is what gives an audiobook the right
                    // ducking behaviour against navigation and notifications.
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                /* handleAudioFocus= */ true
            )
            .setHandleAudioBecomingNoisy(true)
            // A watch dozes aggressively; without a network wake mode a streamed
            // book stalls the moment the screen goes off.
            .setWakeMode(C.WAKE_MODE_NETWORK)
            // Same 30s the UI's own ±30 buttons use — a media-key seek and an
            // on-screen seek must not move by different amounts.
            .setSeekBackIncrementMs(SEEK_INCREMENT_MS)
            .setSeekForwardIncrementMs(SEEK_INCREMENT_MS)
            .build()

        // ENABLED, never REQUIRED: offload is a battery optimisation, and
        // REQUIRED would refuse to play at all on a device whose codec can't do
        // it. Both sub-requirements are non-negotiable for an audiobook — speed
        // because 1.25x+ is the norm, gapless because the queue is one item per
        // track and a gap would land on every chapter boundary — so a device
        // that can't offload with them simply decodes normally.
        player.trackSelectionParameters = player.trackSelectionParameters
            .buildUpon()
            .setAudioOffloadPreferences(
                TrackSelectionParameters.AudioOffloadPreferences.Builder()
                    .setAudioOffloadMode(
                        TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED
                    )
                    .setIsGaplessSupportRequired(true)
                    .setIsSpeedChangeSupportRequired(true)
                    .build()
            )
            .build()

        sessions = SessionManager(
            player = player,
            // Built from the main executor rather than Dispatchers.Main: the wear
            // module doesn't declare kotlinx-coroutines-android, and this needs
            // nothing but coroutines-core.
            main = mainExecutor.asCoroutineDispatcher(),
            scope = scope
        )

        val openApp = openAppIntent()

        mediaSession = MediaSession.Builder(this, player)
            .setCallback(SessionCallback())
            .setSessionActivity(openApp)
            // Notification artwork rides the SAME authorized stack as the audio.
            // media3's stock loader builds its own http client, so a streamed
            // book's cover came back 401 and the notification showed none (the
            // v1 gap). `dataSources`, not the bare OkHttp factory: a DOWNLOADED
            // book's cover is a `file://` uri, which OkHttp alone cannot open.
            // The Context constructor is the trap here — it would quietly build
            // an unauthorized DefaultDataSource of its own.
            .setBitmapLoader(
                CacheBitmapLoader(
                    DataSourceBitmapLoader(
                        DataSourceBitmapLoader.DEFAULT_EXECUTOR_SERVICE.get(),
                        dataSources
                    )
                )
            )
            .build()

        // Installed before anything can play: media3 asks the provider for a
        // notification while promoting this service to the foreground, and a
        // provider that isn't there yet is a promotion with nothing to post.
        setMediaNotificationProvider(WearMediaNotificationProvider(this, openApp))

        registerNetworkCallback()
        // Flush trigger #1: service start. Anything listened offline lands as
        // soon as the watch has a route to the server.
        scope.launch { sessions.syncer.flushOfflineQueues() }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    /**
     * Standard media behaviour: swiping the app away must NOT stop audio. Only a
     * service with nothing to play is pointless — stop it so its notification
     * goes with it.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        val idle = !::player.isInitialized ||
            !player.playWhenReady ||
            player.mediaItemCount == 0 ||
            player.playbackState == Player.STATE_ENDED
        if (idle) stopSelf()
    }

    override fun onDestroy() {
        unregisterNetworkCallback()
        // onDestroy runs on the player's thread, which is exactly what
        // [SessionManager.release] needs: it reads the final position
        // synchronously and delivers it on a scope that outlives this service,
        // so teardown never waits on a network round trip.
        if (::sessions.isInitialized) sessions.release()
        mediaSession?.release()
        mediaSession = null
        if (::player.isInitialized) player.release()
        scope.cancel()
        super.onDestroy()
    }

    /**
     * Custom commands are how the UI asks for a BOOK rather than a media item:
     * resolving one means a download lookup and possibly a `/play` round trip,
     * which no Player command can express.
     */
    private inner class SessionCallback : MediaSession.Callback {

        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo
        ): MediaSession.ConnectionResult {
            // Extend media3's own answer rather than replacing it: the defaults
            // differ per controller kind (notification, Assistant, AVRCP bridge),
            // and hard-coding one set is how a controller ends up with different
            // transport controls than the app's own screen.
            val defaults = super.onConnect(session, controller)
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(
                    defaults.availableSessionCommands
                        .buildUpon()
                        .add(SessionCommand(ACTION_PLAY_ITEM, Bundle.EMPTY))
                        .add(SessionCommand(ACTION_STOP, Bundle.EMPTY))
                        .build()
                )
                .setAvailablePlayerCommands(defaults.availablePlayerCommands)
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle
        ): ListenableFuture<SessionResult> {
            when (customCommand.customAction) {
                ACTION_PLAY_ITEM -> {
                    val itemId = args.getString(EXTRA_ITEM_ID).orEmpty()
                    val episodeId = args.getString(EXTRA_EPISODE_ID)
                    // Answer immediately and resolve in the background: the
                    // network leg can take seconds, and a controller that blocks
                    // on it looks frozen.
                    if (itemId.isNotBlank()) scope.launch { sessions.play(itemId, episodeId) }
                }

                ACTION_STOP -> scope.launch { sessions.stop() }

                else -> return super.onCustomCommand(session, controller, customCommand, args)
            }
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
        },
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    private fun registerNetworkCallback() {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Flush trigger #3: a route to the server exists again.
                scope.launch { sessions.syncer.flushOfflineQueues() }
            }
        }
        try {
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (t: Throwable) {
            // A watch can refuse the registration (per-app callback limit).
            // Playback must not depend on it — the sync tick flushes too.
        }
    }

    private fun unregisterNetworkCallback() {
        val callback = networkCallback ?: return
        networkCallback = null
        try {
            getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback)
        } catch (t: Throwable) {
            // Already unregistered, or the service never took.
        }
    }

    companion object {
        /** Carries an itemId (+ optional episodeId); resolved by SessionManager. */
        const val ACTION_PLAY_ITEM = "com.tomesonic.app.wear.PLAY_ITEM"

        /**
         * Sibling of PLAY_ITEM. Player.stop() alone would leave the ABS session
         * open and the last 15s of listening unreported — closing it is
         * SessionManager's job, so stopping has to reach SessionManager.
         */
        const val ACTION_STOP = "com.tomesonic.app.wear.STOP"

        const val EXTRA_ITEM_ID = "itemId"
        const val EXTRA_EPISODE_ID = "episodeId"

        private const val TAG = "PlaybackService"

        /** The contract's transport: −30s / +30s, shared with PlaybackMath. */
        private val SEEK_INCREMENT_MS = (PlaybackMath.SEEK_SECONDS * 1000.0).toLong()
    }
}
