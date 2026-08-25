package com.tomesonic.app.wear.playback

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Bundle
import android.os.Handler
import androidx.core.app.NotificationCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaNotification
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaStyleNotificationHelper
import androidx.media3.session.R as Media3R
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.tomesonic.app.wear.data.ChapterMath
import java.util.concurrent.Executor

/**
 * The status line the watch face's Ongoing Activity chip carries.
 *
 * A pure choice with its own test because it is the only part of the chip that
 * can be WRONG, and both of its preferred inputs are routinely absent: a
 * single-file download has no chapter table at all (see
 * SessionManager.localChapters), and a process the system started from a media
 * button has no [ActiveSession] until something plays. media3 rebuilds the
 * notification on player EVENTS rather than on a timer, so whatever is picked
 * here is what a wrist shows until the next play/pause.
 */
object OngoingStatus {

    /** An empty status renders as a blank line on the watch face, so never emit one. */
    const val FALLBACK = "Playing"

    fun text(session: ActiveSession?, absoluteSeconds: Double, metadataTitle: String?): String {
        val chapter = ChapterMath.chapterAt(absoluteSeconds, session?.chapters)?.title
        return firstNamed(chapter, session?.title, metadataTitle) ?: FALLBACK
    }

    private fun firstNamed(vararg candidates: String?): String? =
        candidates.firstOrNull { !it.isNullOrBlank() }?.trim()
}

/**
 * The media notification, built here rather than by media3's stock provider.
 *
 * The only reason to own it: a Wear Ongoing Activity — the chip a watch face
 * shows while something plays — attaches to the notification the media service
 * posts, and there is no way to reach media3's own builder from outside. The
 * layout stays the default one's (MediaStyle, the same channel, the same
 * notification id, the same small icon), so nothing about how the notification
 * reads or where its settings live changes.
 *
 * Two invariants this file must not lose:
 *  - it stays SYNCHRONOUS and never throws. media3 calls it while promoting the
 *    service to the foreground; an exception here is silence, not a missing
 *    chip, so the Ongoing Activity is attached inside a catch-all.
 *  - the notification stays startable-in-foreground: a small icon, a MediaStyle
 *    carrying the session token (Android 14 validates the mediaPlayback service
 *    type against it) and an immediate foreground-service behaviour.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class WearMediaNotificationProvider(
    context: Context,
    private val touchIntent: PendingIntent
) : MediaNotification.Provider {

    private val appContext: Context = context.applicationContext
    private val notifications: NotificationManager? =
        appContext.getSystemService(NotificationManager::class.java)

    private var pendingArtwork: ArtworkLoad? = null

    override fun createNotification(
        mediaSession: MediaSession,
        mediaButtonPreferences: ImmutableList<CommandButton>,
        actionFactory: MediaNotification.ActionFactory,
        onNotificationChangedCallback: MediaNotification.Provider.Callback
    ): MediaNotification {
        ensureChannel()

        val player = mediaSession.player
        val builder = NotificationCompat.Builder(appContext, DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID)

        // −30 / +30 flank play/pause, the same increments the player screen and
        // the media keys move by (PlaybackService's seek increments). Both are
        // declared by the player, so a session that offers neither simply shows
        // one button.
        var playPauseIndex = 0
        if (player.isCommandAvailable(Player.COMMAND_SEEK_BACK)) {
            builder.addAction(
                actionFactory.createMediaAction(
                    mediaSession,
                    IconCompat.createWithResource(appContext, Media3R.drawable.media3_icon_skip_back_30),
                    appContext.getString(Media3R.string.media3_controls_seek_back_description),
                    Player.COMMAND_SEEK_BACK
                )
            )
            playPauseIndex = 1
        }

        // Unconditional: a media notification with no transport is not one, and
        // the compact view below indexes exactly this action.
        val showPlay = Util.shouldShowPlayButton(player, mediaSession.showPlayButtonIfPlaybackIsSuppressed)
        builder.addAction(
            actionFactory.createMediaAction(
                mediaSession,
                IconCompat.createWithResource(
                    appContext,
                    if (showPlay) Media3R.drawable.media3_icon_play else Media3R.drawable.media3_icon_pause
                ),
                appContext.getString(
                    if (showPlay) {
                        Media3R.string.media3_controls_play_description
                    } else {
                        Media3R.string.media3_controls_pause_description
                    }
                ),
                Player.COMMAND_PLAY_PAUSE
            )
        )

        if (player.isCommandAvailable(Player.COMMAND_SEEK_FORWARD)) {
            builder.addAction(
                actionFactory.createMediaAction(
                    mediaSession,
                    IconCompat.createWithResource(appContext, Media3R.drawable.media3_icon_skip_forward_30),
                    appContext.getString(Media3R.string.media3_controls_seek_forward_description),
                    Player.COMMAND_SEEK_FORWARD
                )
            )
        }

        // Guarded exactly as the default provider guards it: a controller can
        // withhold metadata, and reading it anyway is how a notification ends up
        // named after nothing.
        val metadata = if (player.isCommandAvailable(Player.COMMAND_GET_METADATA)) player.mediaMetadata else null
        builder.setContentTitle(metadata?.title).setContentText(metadata?.artist)
        if (metadata != null) {
            loadArtwork(mediaSession, metadata, builder, onNotificationChangedCallback)
        }

        builder
            .setContentIntent(touchIntent)
            .setDeleteIntent(actionFactory.createNotificationDismissalIntent(mediaSession))
            .setOnlyAlertOnce(true)
            // No chronometer and no timestamp: on a watch the elapsed-time line
            // is the first thing to be wrong after a speed change or a seek.
            .setShowWhen(false)
            .setSmallIcon(SMALL_ICON)
            .setStyle(
                MediaStyleNotificationHelper.MediaStyle(mediaSession)
                    // One action collapsed, and it is the one a wrist reaches
                    // for; the seeks stay in the expanded view.
                    .setShowActionsInCompactView(playPauseIndex)
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // media3 owns the promotion and the dismissal; an ongoing flag it did
            // not set is what strands a notification after the service stops.
            .setOngoing(false)
            // Keeps the media notification out of the auto-group the download
            // worker's progress notification would otherwise pull it into.
            .setGroup(DefaultMediaNotificationProvider.GROUP_KEY)
            // A no-op below API 31; above it, the difference between the media
            // chip appearing on play and ten seconds later.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

        applyOngoingActivity(builder, player, metadata?.title?.toString())

        return MediaNotification(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID, builder.build())
    }

    /**
     * Nothing here publishes a custom action, so anything that arrives belongs to
     * the session — false means "deliver it there", the same answer the default
     * provider gives.
     */
    override fun handleCustomCommand(session: MediaSession, action: String, extras: Bundle): Boolean = false

    /**
     * The watch-face chip, attached to the builder before it is built.
     *
     * The whole body is guarded — reading the player included — because this is
     * decoration on a notification that must post either way: a watch face or
     * SysUI that refuses the extras must not be what stops the audio.
     */
    private fun applyOngoingActivity(
        builder: NotificationCompat.Builder,
        player: Player,
        metadataTitle: String?
    ) {
        try {
            val session = PlaybackState.active.value
            val status = OngoingStatus.text(session, absolutePositionSeconds(player, session), metadataTitle)
            val ongoing = OngoingActivity.Builder(
                appContext,
                DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID,
                builder
            )
                .setStaticIcon(SMALL_ICON)
                .setStatus(Status.forPart(Status.TextPart(status)))
                .setTouchIntent(touchIntent)
                .build()
            ongoing.apply(appContext)
        } catch (t: Throwable) {
            // The notification is complete without it.
        }
    }

    /**
     * Notification artwork through the SESSION's bitmap loader — the authorized
     * one PlaybackService installs. A load that is already done (the cache, i.e.
     * every rebuild after the first) lands in THIS notification; anything else
     * re-posts when it arrives, on the player's application thread because that
     * is the only thread media3 accepts a notification update from.
     */
    private fun loadArtwork(
        mediaSession: MediaSession,
        metadata: MediaMetadata,
        builder: NotificationCompat.Builder,
        onChanged: MediaNotification.Provider.Callback
    ) {
        // A load still in flight for an older build would re-post that older
        // notification; mark it dead rather than cancel it, so the shared cache
        // still keeps the bitmap.
        pendingArtwork?.discarded = true
        pendingArtwork = null

        val future = mediaSession.bitmapLoader.loadBitmapFromMetadata(metadata) ?: return
        if (future.isDone) {
            try {
                builder.setLargeIcon(Futures.getDone(future))
            } catch (t: Throwable) {
                // A cover the server (or the disk) would not give up is not a
                // reason to drop the notification with it.
            }
            return
        }

        val load = ArtworkLoad()
        pendingArtwork = load
        val handler = Handler(mediaSession.player.applicationLooper)
        future.addListener(
            {
                try {
                    if (!load.discarded) {
                        builder.setLargeIcon(Futures.getDone(future))
                        onChanged.onNotificationChanged(
                            MediaNotification(
                                DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID,
                                builder.build()
                            )
                        )
                    }
                } catch (t: Throwable) {
                    // Same as above, one looper iteration later.
                }
            },
            Executor { runnable -> handler.post(runnable) }
        )
    }

    /**
     * media3's own channel id and name. An upgrade must land on the channel the
     * user already has — a second id is a second, empty "Now playing" entry in
     * Settings and a fresh default importance.
     */
    private fun ensureChannel() {
        val manager = notifications ?: return
        if (manager.getNotificationChannel(DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID,
                appContext.getString(DefaultMediaNotificationProvider.DEFAULT_CHANNEL_NAME_RESOURCE_ID),
                // A book playing must never buzz a wrist.
                NotificationManager.IMPORTANCE_LOW
            )
        )
    }

    /** BOOK-absolute seconds: the queue is one media item per track. */
    private fun absolutePositionSeconds(player: Player, session: ActiveSession?): Double {
        if (session == null) return 0.0
        return ChapterMath.absolutePosition(
            session.tracks,
            player.currentMediaItemIndex,
            player.currentPosition / 1000.0
        ) ?: 0.0
    }

    /** One artwork load's liveness, flipped when a newer notification supersedes it. */
    private class ArtworkLoad {
        @Volatile
        var discarded = false
    }

    private companion object {
        /**
         * media3's own status-bar mark, which is what v1 shipped — the wear module
         * carries no notification drawable of its own, and the Ongoing Activity
         * chip must show the SAME icon as the notification it belongs to.
         */
        val SMALL_ICON = Media3R.drawable.media3_notification_small_icon
    }
}
