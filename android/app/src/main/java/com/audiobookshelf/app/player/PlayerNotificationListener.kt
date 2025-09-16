package com.audiobookshelf.app.player

import android.app.Notification
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.media3.ui.PlayerNotificationManager

class PlayerNotificationListener(var playerNotificationService:PlayerNotificationService) : PlayerNotificationManager.NotificationListener {
  var tag = "PlayerNotificationListener"

  companion object {
    var isForegroundService = false
  }

  init {
    Log.d(tag, "🔧 PlayerNotificationListener CONSTRUCTOR called")
    Log.d(tag, "🔧 PlayerNotificationListener created for service: ${playerNotificationService}")
    Log.d(tag, "🔧 PlayerNotificationListener ready to receive notification callbacks")
  }

  override fun onNotificationPosted(
    notificationId: Int,
    notification: Notification,
    onGoing: Boolean) {

    Log.d(tag, "=== PlayerNotificationListener.onNotificationPosted ===")
    Log.d(tag, "Notification ID: $notificationId")
    Log.d(tag, "OnGoing: $onGoing")
    Log.d(tag, "isForegroundService: $isForegroundService")
    Log.d(tag, "Notification title: ${notification.extras?.getString(Notification.EXTRA_TITLE)}")
    Log.d(tag, "Notification text: ${notification.extras?.getString(Notification.EXTRA_TEXT)}")

    // CRITICAL DEBUG: Check notification properties that affect visibility
    Log.d(tag, "🔍 NOTIFICATION DEBUG:")
    Log.d(tag, "🔍 Notification category: ${notification.category}")
    Log.d(tag, "🔍 Notification group: ${notification.group}")
    Log.d(tag, "🔍 Notification channel: ${notification.channelId}")
    Log.d(tag, "🔍 Notification flags: ${notification.flags}")
    Log.d(tag, "🔍 Notification priority: ${notification.priority}")
    Log.d(tag, "🔍 Notification visibility: ${notification.visibility}")
    Log.d(tag, "🔍 Notification publicVersion: ${notification.publicVersion}")

    // Check if notification has actions
    if (notification.actions != null && notification.actions.isNotEmpty()) {
        Log.d(tag, "🔍 Notification has ${notification.actions.size} actions")
        notification.actions.forEachIndexed { index, action ->
            Log.d(tag, "🔍   Action $index: ${action.title}")
        }
    } else {
        Log.d(tag, "🔍 Notification has NO actions - this might prevent Android Auto detection")
    }

    // Check for media-related extras
    val extras = notification.extras
    if (extras != null) {
        Log.d(tag, "🔍 Notification extras keys: ${extras.keySet()}")
        if (extras.containsKey("android.mediaSession")) {
            Log.d(tag, "🔍 ✅ Notification contains mediaSession token")
        } else {
            Log.d(tag, "🔍 ❌ Notification missing mediaSession token - Android Auto won't detect it")
        }
    }

    // CRITICAL FIX: Check actual player state and force ongoing if player is playing
    val player = playerNotificationService.mPlayer
    val isPlayerPlaying = player?.isPlaying == true
    val isPlayerLoading = player?.isLoading == true
    val shouldBeOngoing = isPlayerPlaying || isPlayerLoading

    Log.d(tag, "🔧 PLAYER STATE CHECK:")
    Log.d(tag, "🔧 Player isPlaying: $isPlayerPlaying")
    Log.d(tag, "🔧 Player isLoading: $isPlayerLoading")
    Log.d(tag, "🔧 Should be ongoing: $shouldBeOngoing")

    // Force ongoing if player is actually playing but notification says otherwise
    val effectiveOngoing = onGoing || shouldBeOngoing

    if (effectiveOngoing != onGoing) {
      Log.w(tag, "⚠️  OVERRIDE: PlayerNotificationManager said onGoing=$onGoing but player state indicates shouldBeOngoing=$shouldBeOngoing")
      Log.w(tag, "⚠️  OVERRIDE: Forcing notification to be ongoing for Android Auto compatibility")
    }

    // CRITICAL FIX: Force higher priority and visibility to ensure notification is seen
    val enhancedNotification = notification.apply {
      // Force higher priority by modifying the notification directly
      priority = Notification.PRIORITY_HIGH
      flags = flags or Notification.FLAG_ONGOING_EVENT  // Ensure ongoing flag is set
    }

    Log.d(tag, "🔧 NOTIFICATION ENHANCEMENT:")
    Log.d(tag, "🔧 Enhanced priority: ${enhancedNotification.priority}")
    Log.d(tag, "🔧 Enhanced flags: ${enhancedNotification.flags}")
    Log.d(tag, "🔧 Enhanced ongoing: ${enhancedNotification.flags and Notification.FLAG_ONGOING_EVENT != 0}")

    if (effectiveOngoing && !isForegroundService) {
      // Start foreground service
      Log.d(tag, "Notification Posted $notificationId - Start Foreground | $notification")
      PlayerNotificationService.isClosed = false

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        playerNotificationService.startForeground(notificationId, enhancedNotification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        playerNotificationService.startForeground(notificationId, enhancedNotification)
      }
      isForegroundService = true
      Log.d(tag, "Successfully started foreground service with ENHANCED notification")
    } else if (effectiveOngoing && isForegroundService) {
      // Service is already in foreground, just update the notification
      Log.d(tag, "Notification posted $notificationId - Updating existing foreground notification")
      // The PlayerNotificationManager will automatically update the notification
    } else {
      Log.d(tag, "Notification posted $notificationId, not starting foreground - effectiveOngoing=$effectiveOngoing | isForegroundService=$isForegroundService")
      if (!effectiveOngoing) {
        Log.w(tag, "⚠️  ISSUE: Notification is NOT ongoing (effectiveOngoing=false)")
        Log.w(tag, "⚠️  Non-ongoing notifications don't appear in Android Auto media controls")
        Log.w(tag, "⚠️  This typically means the player is not in PLAYING state")
      }
    }
  }

  override fun onNotificationCancelled(
    notificationId: Int,
    dismissedByUser: Boolean
  ) {
    if (dismissedByUser) {
      Log.d(tag, "onNotificationCancelled dismissed by user")
      playerNotificationService.stopSelf()
      isForegroundService = false
    } else {
      Log.d(tag, "onNotificationCancelled not dismissed by user")

      if (playerNotificationService.castPlayerManager.isSwitchingPlayer) {
        // When switching from cast player to exo player and vice versa the notification is cancelled and posted again
          // so we don't want to cancel the playback during this switch
        Log.d(tag, "PNS is switching player")
        playerNotificationService.castPlayerManager.isSwitchingPlayer = false
      }
    }
  }
}
