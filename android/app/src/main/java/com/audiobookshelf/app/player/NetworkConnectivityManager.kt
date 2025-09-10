package com.audiobookshelf.app.player

import android.content.Context
import android.net.*
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.audiobookshelf.app.data.Podcast
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.media.MediaManager
import com.audiobookshelf.app.plugins.AbsLogger
import com.audiobookshelf.app.server.ApiHandler

/**
 * Manages network connectivity monitoring and related functionality
 */
class NetworkConnectivityManager(
    private val context: Context,
    private val service: PlayerNotificationService
) {
    companion object {
        private const val TAG = "NetworkConnectivityManager"
    }

    var isUnmeteredNetwork = false
    var hasNetworkConnectivity = false // Not 100% reliable has internet

    private var connectivityManager: ConnectivityManager? = null
    private var forceReloadingAndroidAuto = false
    private var firstLoadDone = false

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        // Network capabilities have changed for the network
        override fun onCapabilitiesChanged(
            network: Network,
            networkCapabilities: NetworkCapabilities
        ) {
            super.onCapabilitiesChanged(network, networkCapabilities)

            isUnmeteredNetwork = networkCapabilities.hasCapability(
                NetworkCapabilities.NET_CAPABILITY_NOT_METERED
            )
            hasNetworkConnectivity = networkCapabilities.hasCapability(
                NetworkCapabilities.NET_CAPABILITY_VALIDATED
            ) && networkCapabilities.hasCapability(
                NetworkCapabilities.NET_CAPABILITY_INTERNET
            )

            Log.i(
                TAG,
                "Network capabilities changed. hasNetworkConnectivity=$hasNetworkConnectivity | isUnmeteredNetwork=$isUnmeteredNetwork"
            )

            service.clientEventEmitter?.onNetworkMeteredChanged(isUnmeteredNetwork)

            if (hasNetworkConnectivity) {
                handleNetworkRestored()
            }
        }
    }

    /**
     * Initializes network connectivity monitoring
     */
    fun initialize() {
        val networkRequest = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            .build()

        connectivityManager = context.getSystemService(ConnectivityManager::class.java) as ConnectivityManager
        connectivityManager?.registerNetworkCallback(networkRequest, networkCallback)

        Log.d(TAG, "Network connectivity monitoring initialized")
    }

    /**
     * Handles network restoration - forces Android Auto reload and syncs local sessions
     */
    private fun handleNetworkRestored() {
        // Force android auto loading if libraries are empty.
        // Lack of network connectivity is most likely reason for libraries being empty
        if (service.isBrowseTreeInitialized() &&
            firstLoadDone &&
            service.mediaManager.serverLibraries.isEmpty()
        ) {
            forceReloadingAndroidAuto = true
            service.notifyChildrenChanged("/")
        }

        // Send any queued local progress syncs when network is restored
        syncLocalSessionsOnNetworkRestore()
    }

    /**
     * Syncs local playback sessions when network is restored
     */
    private fun syncLocalSessionsOnNetworkRestore() {
        val unsyncedSessions = DeviceManager.dbManager.getPlaybackSessions()
        if (unsyncedSessions.isNotEmpty()) {
            service.apiHandler.sendSyncLocalSessions(unsyncedSessions) { success: Boolean, error: String? ->
                if (success) {
                    AbsLogger.info(TAG, "Network restored: Successfully synced ${unsyncedSessions.size} local sessions")
                    // Clear synced sessions from local storage, but keep the most recent one for offline local playback
                    val sortedSessions = unsyncedSessions.sortedByDescending { it.updatedAt }
                    val sessionsToRemove = if (sortedSessions.size > 1) sortedSessions.drop(1) else emptyList()
                    sessionsToRemove.forEach { session ->
                        DeviceManager.dbManager.removePlaybackSession(session.id)
                    }
                    if (sessionsToRemove.isNotEmpty()) {
                        AbsLogger.info(TAG, "Network restored: Kept most recent session (${sortedSessions.first().displayTitle}) for offline playback")
                    }
                } else {
                    AbsLogger.error(TAG, "Network restored: Failed to sync local sessions: $error")
                }
            }
        }
    }

    /**
     * Resumes from last session for Android Auto when it starts
     */
    fun resumeFromLastSessionForAndroidAuto() {
        try {
            Log.d(TAG, "Android Auto: Attempting to resume from last session (device or server)")

            // First check for local playback session saved on device
            val lastPlaybackSession = DeviceManager.deviceData.lastPlaybackSession
            if (lastPlaybackSession != null) {
                // Check if session has meaningful progress (not at the very beginning)
                val progress = lastPlaybackSession.currentTime / lastPlaybackSession.duration
                val isResumable = progress > 0.01

                if (isResumable) {
                    Log.d(TAG, "Android Auto: Found local playback session, resuming: ${lastPlaybackSession.displayTitle} at ${(progress * 100).toInt()}%")

                    // If connected to server, check if server has newer progress for same media
                    if (DeviceManager.checkConnectivity(context)) {
                        Log.d(TAG, "Android Auto: Checking server for potential newer session...")

                        service.checkServerSessionVsLocal(lastPlaybackSession) { shouldUseServer, serverSession ->
                            val sessionToUse = if (shouldUseServer && serverSession != null) {
                                Log.d(TAG, "Android Auto: Server session is newer, using server session")
                                serverSession
                            } else {
                                Log.d(TAG, "Android Auto: Using local session")
                                lastPlaybackSession
                            }

                            service.prepareSessionForAndroidAuto(sessionToUse, false)
                        }
                    } else {
                        // No connectivity, use local session
                        service.prepareSessionForAndroidAuto(lastPlaybackSession, false)
                    }
                    return
                } else {
                    Log.d(TAG, "Android Auto: Local session progress too low (${(progress * 100).toInt()}%), checking server instead")
                }
            }

            // No suitable local session found, check server for last session if connected
            if (!DeviceManager.checkConnectivity(context)) {
                Log.d(TAG, "Android Auto: No connectivity, cannot check server for last session")
                return
            }

            Log.d(TAG, "Android Auto: No suitable local session found, querying server for last session")

            // Use getCurrentUser to get user data which should include session information
            service.apiHandler.getCurrentUser { user ->
                if (user != null) {
                    Log.d(TAG, "Android Auto: Got user data from server")

                    try {
                        // Get the most recent media progress
                        if (user.mediaProgress.isNotEmpty()) {
                            val latestProgress = user.mediaProgress.maxByOrNull { it.lastUpdate }

                            if (latestProgress != null && latestProgress.currentTime > 0) {
                                Log.d(TAG, "Android Auto: Found recent progress: ${latestProgress.libraryItemId} at ${latestProgress.currentTime}s")

                                // Check if this library item is downloaded locally
                                val localLibraryItem = DeviceManager.dbManager.getLocalLibraryItemByLId(latestProgress.libraryItemId)

                                if (localLibraryItem != null) {
                                    Log.d(TAG, "Android Auto: Found local download for ${localLibraryItem.title}, using local copy")

                                    // Create a local playback session
                                    val deviceInfo = service.getDeviceInfo()
                                    val episode = if (latestProgress.episodeId != null && localLibraryItem.isPodcast) {
                                        val podcast = localLibraryItem.media as? Podcast
                                        podcast?.episodes?.find { ep -> ep.id == latestProgress.episodeId }
                                    } else null

                                    val localPlaybackSession = localLibraryItem.getPlaybackSession(episode, deviceInfo)
                                    // Override the current time with the server progress to sync position
                                    localPlaybackSession.currentTime = latestProgress.currentTime

                                    Log.d(TAG, "Android Auto: Resuming from local download: ${localLibraryItem.title} at ${latestProgress.currentTime}s")

                                    // Prepare the player in paused state with saved playback speed
                                    val savedPlaybackSpeed = service.mediaManager.getSavedPlaybackRate()
                                    Handler(Looper.getMainLooper()).post {
                                        if (service.mediaProgressSyncer.listeningTimerRunning) {
                                            service.mediaProgressSyncer.stop {
                                                service.preparePlayer(localPlaybackSession, false, savedPlaybackSpeed)
                                            }
                                        } else {
                                            service.mediaProgressSyncer.reset()
                                            service.preparePlayer(localPlaybackSession, false, savedPlaybackSpeed)
                                        }
                                    }
                                    return@getCurrentUser
                                }

                                // Not downloaded locally, stream from server if possible
                                Log.d(TAG, "Android Auto: Media not downloaded locally, attempting to stream from server")
                                // TODO: Implement server streaming functionality
                                Log.w(TAG, "Android Auto: Server streaming not yet implemented in NetworkConnectivityManager")
                            } else {
                                Log.d(TAG, "Android Auto: No recent progress found on server")
                            }
                        } else {
                            Log.d(TAG, "Android Auto: User has no media progress")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Android Auto: Error processing user data for session resume", e)
                    }
                } else {
                    Log.w(TAG, "Android Auto: Failed to get user data from server")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Android Auto: Error during session resume", e)
        }
    }

    /**
     * Sets the first load done flag
     */
    fun setFirstLoadDone(done: Boolean) {
        firstLoadDone = done
    }

    /**
     * Releases network connectivity resources
     */
    fun release() {
        try {
            connectivityManager?.unregisterNetworkCallback(networkCallback)
            Log.d(TAG, "Network connectivity monitoring released")
        } catch (error: Exception) {
            Log.e(TAG, "Error unregistering network listening callback $error")
        }
    }
}
