package com.audiobookshelf.app.player

import android.app.PendingIntent
import android.graphics.Bitmap
import androidx.media3.ui.PlayerNotificationManager
import androidx.media3.common.Player

// MIGRATION-DEFERRED: CAST - Stub implementation for Media3 migration
// Original functionality will be restored in Step 7 of migration
class AbMediaDescriptionAdapter : PlayerNotificationManager.MediaDescriptionAdapter {

  override fun createCurrentContentIntent(player: Player): PendingIntent? = null

  override fun getCurrentContentText(player: Player): CharSequence = ""

  override fun getCurrentContentTitle(player: Player): CharSequence = ""

  override fun getCurrentLargeIcon(
    player: Player,
    callback: PlayerNotificationManager.BitmapCallback
  ): Bitmap? = null
}
