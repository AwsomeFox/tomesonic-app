package com.tomesonic.app.player

import android.app.Notification
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.media3.ui.PlayerNotificationManager

class PlayerNotificationListener(var playerNotificationService:PlayerNotificationService) : PlayerNotificationManager.NotificationListener {
  var tag = "PlayerNotificationListener"

  companion object {
    var isForegroundService = false
  }

  override fun onNotificationPosted(
    notificationId: Int,
    notification: Notification,
    onGoing: Boolean) {
    val enhancedNotification = buildWearEnhancedNotification(notification)

    if (onGoing && !isForegroundService) {
      // Start foreground service when media notification is posted
      Log.d(tag, "Notification Posted $notificationId - Start Foreground | $notification")
      PlayerNotificationService.isClosed = false

      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          playerNotificationService.startForeground(notificationId, enhancedNotification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
          playerNotificationService.startForeground(notificationId, enhancedNotification)
        }
        isForegroundService = true
        Log.d(tag, "Successfully started foreground service with media notification")
      } catch (e: Exception) {
        Log.e(tag, "Failed to start foreground service in notification listener: ${e.message}")
        // Don't set isForegroundService = true if we failed
      }
    } else if (onGoing && isForegroundService) {
      // Service is already in foreground, just update the notification
      Log.d(tag, "Notification posted $notificationId - Service already foreground, notification will be updated automatically")
      if (enhancedNotification !== notification) {
        NotificationManagerCompat.from(playerNotificationService).notify(notificationId, enhancedNotification)
      }
    } else {
      Log.d(tag, "Notification posted $notificationId, not ongoing - onGoing=$onGoing | isForegroundService=$isForegroundService")
    }
  }

  private fun buildWearEnhancedNotification(notification: Notification): Notification {
    val largeIconBitmap = extractLargeIconBitmap(notification) ?: return notification

    return try {
      val wearableExtender = NotificationCompat.WearableExtender()
        .setHintShowBackgroundOnly(true)
        .setBackground(largeIconBitmap)

      NotificationCompat.Builder.recoverBuilder(playerNotificationService, notification)
        .extend(wearableExtender)
        .build()
    } catch (e: Exception) {
      Log.w(tag, "Failed to apply WearableExtender background: ${e.message}")
      notification
    }
  }

  private fun extractLargeIconBitmap(notification: Notification): Bitmap? {
    val extras = notification.extras ?: return null

    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        extras.getParcelable(Notification.EXTRA_LARGE_ICON, Bitmap::class.java)
          ?: extras.getParcelable(Notification.EXTRA_LARGE_ICON_BIG, Bitmap::class.java)
          ?: notification.getLargeIcon()?.toBitmapSafe()
      } else {
        @Suppress("DEPRECATION")
        (extras.getParcelable(Notification.EXTRA_LARGE_ICON) as? Bitmap)
          ?: (extras.getParcelable(Notification.EXTRA_LARGE_ICON_BIG) as? Bitmap)
          ?: notification.getLargeIcon()?.toBitmapSafe()
      }
    } catch (e: Exception) {
      Log.w(tag, "Failed to read large icon bitmap from notification extras: ${e.message}")
      null
    }
  }

  private fun Icon.toBitmapSafe(): Bitmap? {
    return try {
      val drawable = loadDrawable(playerNotificationService) ?: return null
      if (drawable is BitmapDrawable && drawable.bitmap != null) {
        drawable.bitmap
      } else {
        val width = drawable.intrinsicWidth.coerceAtLeast(1)
        val height = drawable.intrinsicHeight.coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, canvas.width, canvas.height)
        drawable.draw(canvas)
        bitmap
      }
    } catch (e: Exception) {
      Log.w(tag, "Failed to convert Icon to Bitmap: ${e.message}")
      null
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

      // MIGRATION-DEFERRED: CAST
      /*
      if (playerNotificationService.castPlayerManager.isSwitchingPlayer) {
        // When switching from cast player to exo player and vice versa the notification is cancelled and posted again
          // so we don't want to cancel the playback during this switch
        Log.d(tag, "PNS is switching player")
        playerNotificationService.castPlayerManager.isSwitchingPlayer = false
      }
      */
    }
  }
}
