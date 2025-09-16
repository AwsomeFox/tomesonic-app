package com.audiobookshelf.app.player.viewmodel

import android.content.ComponentName
import android.content.Context
import android.util.Log
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.audiobookshelf.app.player.service.AudiobookMediaService
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages MediaController connection to the AudiobookMediaService
 */
@Singleton
class MediaControllerManagerImpl @Inject constructor(
    private val context: Context
) : MediaControllerManager {

    companion object {
        private const val TAG = "MediaControllerManager"
    }

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val _controller = MutableStateFlow<MediaController?>(null)
    override val controller: StateFlow<MediaController?> = _controller.asStateFlow()

    private var controllerFuture: ListenableFuture<MediaController>? = null

    init {
        connectToService()
    }

    private fun connectToService() {
        Log.d(TAG, "Connecting to AudiobookMediaService")

        val sessionToken = SessionToken(
            context,
            ComponentName(context, AudiobookMediaService::class.java)
        )

        controllerFuture = MediaController.Builder(context, sessionToken)
            .buildAsync()

        controllerFuture?.addListener({
            try {
                val mediaController = controllerFuture?.get()
                mediaController?.let {
                    Log.d(TAG, "MediaController connected successfully")
                    _controller.value = it
                    setupControllerListeners(it)
                } ?: Log.e(TAG, "MediaController is null after connection")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to connect MediaController: ${e.message}")
                // Retry connection after delay
                scope.launch {
                    delay(2000)
                    connectToService()
                }
            }
        }, MoreExecutors.directExecutor())
    }

    private fun setupControllerListeners(mediaController: MediaController) {
        // Add any additional listeners here
        Log.d(TAG, "Setting up MediaController listeners")

        // Example: Listen for connection state changes
        scope.launch {
            while (mediaController.isConnected) {
                // Monitor connection state
                delay(5000)
            }

            // Connection lost, attempt to reconnect
            Log.w(TAG, "MediaController connection lost, attempting to reconnect")
            _controller.value = null
            connectToService()
        }
    }

    fun release() {
        Log.d(TAG, "Releasing MediaController")

        _controller.value?.release()
        _controller.value = null

        controllerFuture?.cancel(true)
        controllerFuture = null

        scope.cancel()
    }
}

/**
 * Executor that runs tasks directly on the calling thread
 */
private object MoreExecutors {
    fun directExecutor(): java.util.concurrent.Executor {
        return java.util.concurrent.Executor { command -> command.run() }
    }
}
