package com.tomesonic.app.managers

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.tomesonic.app.MainActivity
import com.tomesonic.app.R
import com.tomesonic.app.models.DownloadItem

/**
 * Manages download notifications to allow users to leave the app
 * while downloads continue in the background
 */
class DownloadNotificationManager(private val context: Context) {
    private val tag = "DownloadNotifManager"
    private val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    companion object {
        private const val CHANNEL_ID = "audiobookshelf_downloads"
        private const val CHANNEL_NAME = "Downloads"
        private const val NOTIFICATION_ID = 1001
    }

    init {
        createNotificationChannel()
    }

    /**
     * Creates the notification channel for download notifications (Android O and above)
     */
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT  // Normal importance for visibility
            ).apply {
                description = "Shows progress of downloading audiobooks"
                setShowBadge(true)
            }
            notificationManager.createNotificationChannel(channel)
            Log.d(tag, "Download notification channel created")
        }
    }

    /**
     * Shows or updates the download notification with current progress
     */
    fun showDownloadNotification(
        downloadItem: DownloadItem?,
        totalItems: Int,
        completedItems: Int,
        currentProgress: Int
    ) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("navigate_to", "downloads")
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = if (downloadItem != null) {
            "Downloading: ${downloadItem.media.metadata.title}"
        } else {
            "Download in progress"
        }

        val contentText = if (totalItems > 1) {
            "Item $completedItems of $totalItems • $currentProgress%"
        } else {
            "$currentProgress% complete"
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_download)
            .setProgress(100, currentProgress, false)
            .setOngoing(true) // Can't be dismissed while downloading
            .setContentIntent(pendingIntent)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        notificationManager.notify(NOTIFICATION_ID, notification)
        Log.d(tag, "Download notification updated: $contentText")
    }

    /**
     * Shows completion notification
     */
    fun showCompletionNotification(itemTitle: String, success: Boolean) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("navigate_to", "downloads")
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(if (success) "Download Complete" else "Download Failed")
            .setContentText(itemTitle)
            .setSmallIcon(R.drawable.ic_download) // Use download icon for both success and failure
            .setOngoing(false)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        notificationManager.notify(NOTIFICATION_ID, notification)
        Log.d(tag, "Download completion notification shown")
    }

    /**
     * Shows notification for multiple downloads completing
     */
    fun showMultipleCompletionNotification(completedCount: Int, failedCount: Int) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("navigate_to", "downloads")
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = "Downloads Complete"
        val text = if (failedCount > 0) {
            "$completedCount completed, $failedCount failed"
        } else {
            "$completedCount downloads completed successfully"
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_download)
            .setOngoing(false)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        notificationManager.notify(NOTIFICATION_ID, notification)
        Log.d(tag, "Multiple completion notification shown")
    }

    /**
     * Dismisses the download notification
     */
    fun dismissNotification() {
        notificationManager.cancel(NOTIFICATION_ID)
        Log.d(tag, "Download notification dismissed")
    }
}
