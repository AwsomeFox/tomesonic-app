package com.tomesonic.app.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.tomesonic.app.MainActivity
import com.tomesonic.app.R
import com.tomesonic.app.device.DeviceManager
import com.tomesonic.app.managers.DownloadItemManager
import com.tomesonic.app.models.DownloadItem
import kotlinx.coroutines.*

/**
 * Foreground service that manages audiobook downloads in the background.
 * This service ensures downloads continue even when:
 * - The app is in the background
 * - The screen is turned off
 * - The user switches to other apps
 */
class DownloadService : Service() {
    private val tag = "DownloadService"
    private val binder = LocalBinder()

    // Wake lock to keep CPU running during downloads
    private var wakeLock: PowerManager.WakeLock? = null

    // Service scope for coroutines
    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    // Download manager instance
    var downloadItemManager: DownloadItemManager? = null

    companion object {
        private const val NOTIFICATION_ID = 1002
        private const val CHANNEL_ID = "download_service_channel"
        private const val CHANNEL_NAME = "Download Service"
        const val ACTION_CANCEL_DOWNLOAD = "com.tomesonic.app.ACTION_CANCEL_DOWNLOAD"

        // Service state
        var isRunning = false

        /**
         * Starts the download service
         */
        fun start(context: Context) {
            val intent = Intent(context, DownloadService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * Stops the download service
         */
        fun stop(context: Context) {
            val intent = Intent(context, DownloadService::class.java)
            context.stopService(intent)
        }
    }

    inner class LocalBinder : Binder() {
        fun getService(): DownloadService = this@DownloadService
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(tag, "DownloadService created")

        createNotificationChannel()

        // Acquire wake lock to prevent CPU from sleeping during downloads
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "TomeSonic::DownloadWakeLock"
        )

        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(tag, "DownloadService started")

        // Handle cancel action
        if (intent?.action == ACTION_CANCEL_DOWNLOAD) {
            Log.d(tag, "Cancel download action received")
            downloadItemManager?.cancelAllDownloads()
            stopServiceIfNoDownloads()
            return START_NOT_STICKY
        }

        // Start as foreground service with notification
        val notification = createNotification("Preparing downloads...", 0)
        startForeground(NOTIFICATION_ID, notification)

        // Acquire wake lock
        if (wakeLock?.isHeld == false) {
            wakeLock?.acquire(10 * 60 * 1000L) // 10 minutes max, will be released when downloads complete
            Log.d(tag, "Wake lock acquired")
        }

        // Service will be restarted if killed by system
        return START_STICKY
    }

    override fun onBind(intent: Intent): IBinder {
        return binder
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(tag, "DownloadService destroyed")

        // Release wake lock
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
            Log.d(tag, "Wake lock released")
        }

        // Cancel all coroutines
        serviceScope.cancel()

        isRunning = false
    }

    /**
     * Creates notification channel for the service
     */
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW // Low importance so it's not too intrusive
            ).apply {
                description = "Keeps download service running in background"
                setShowBadge(false)
            }

            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager?.createNotificationChannel(channel)
        }
    }

    /**
     * Creates a notification for the foreground service
     */
    fun createNotification(contentText: String, progress: Int): Notification {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("navigate_to", "downloads")
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Create cancel action
        val cancelIntent = Intent(this, DownloadCancelReceiver::class.java).apply {
            action = ACTION_CANCEL_DOWNLOAD
        }

        val cancelPendingIntent = PendingIntent.getBroadcast(
            this,
            0,
            cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Downloading audiobooks")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_download)
            .setProgress(100, progress, false)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .addAction(android.R.drawable.ic_delete, "Cancel", cancelPendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .build()
    }

    /**
     * Updates the foreground notification
     */
    fun updateNotification(contentText: String, progress: Int) {
        val notification = createNotification(contentText, progress)
        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager?.notify(NOTIFICATION_ID, notification)
    }

    /**
     * Sets the download manager for this service
     */
    fun setDownloadManager(manager: DownloadItemManager) {
        this.downloadItemManager = manager
        Log.d(tag, "Download manager set")
    }

    /**
     * Stops the service when downloads are complete
     */
    fun stopServiceIfNoDownloads() {
        serviceScope.launch(Dispatchers.Main) {
            delay(1000) // Small delay to ensure everything is cleaned up

            val hasActiveDownloads = downloadItemManager?.let { manager ->
                manager.downloadItemQueue.isNotEmpty() ||
                manager.currentDownloadItemParts.isNotEmpty()
            } ?: false

            if (!hasActiveDownloads) {
                Log.d(tag, "No active downloads, stopping service and dismissing notification")

                // Explicitly dismiss the notification
                val notificationManager = getSystemService(NotificationManager::class.java)
                notificationManager?.cancel(NOTIFICATION_ID)

                // Stop foreground and service
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                stopSelf()
            }
        }
    }
}
