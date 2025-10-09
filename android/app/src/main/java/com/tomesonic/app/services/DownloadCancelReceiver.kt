package com.tomesonic.app.services

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Broadcast receiver that handles download cancellation from notification action
 */
class DownloadCancelReceiver : BroadcastReceiver() {
    private val tag = "DownloadCancelReceiver"

    companion object {
        const val ACTION_CANCEL_DOWNLOAD = "com.tomesonic.app.ACTION_CANCEL_DOWNLOAD"
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == ACTION_CANCEL_DOWNLOAD) {
            Log.d(tag, "Cancel download action received")

            // Send intent to stop the download service
            context?.let {
                val serviceIntent = Intent(it, DownloadService::class.java).apply {
                    action = ACTION_CANCEL_DOWNLOAD
                }
                it.startService(serviceIntent)
            }
        }
    }
}
