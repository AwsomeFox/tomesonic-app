package com.audiobookshelf.app.player.cast

import android.content.Context
import android.util.Log
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.SessionAvailabilityListener
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastState
import com.google.android.gms.cast.framework.CastStateListener
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages Cast functionality and player switching for Media3
 */
@Singleton
class CastPlayerManager @Inject constructor(
    private val context: Context
) : SessionAvailabilityListener, CastStateListener {

    companion object {
        private const val TAG = "CastPlayerManager"
    }

    private var castContext: CastContext? = null
    private var _castPlayer: CastPlayer? = null

    // Cast state
    private val _isCastAvailable = MutableStateFlow(false)
    val isCastAvailable: StateFlow<Boolean> = _isCastAvailable.asStateFlow()

    private val _isCastConnected = MutableStateFlow(false)
    val isCastConnected: StateFlow<Boolean> = _isCastConnected.asStateFlow()

    private val _castDeviceName = MutableStateFlow<String?>(null)
    val castDeviceName: StateFlow<String?> = _castDeviceName.asStateFlow()

    // Callback for player switching
    private var playerSwitchListener: PlayerSwitchListener? = null

    // Player switching state
    var isSwitchingPlayer: Boolean = false

    val castPlayer: CastPlayer?
        get() = _castPlayer

    init {
        initializeCast()
    }

    private fun initializeCast() {
        try {
            Log.d(TAG, "Initializing Cast support")
            castContext = CastContext.getSharedInstance(context)

            _castPlayer = CastPlayer(castContext!!)
            _castPlayer?.setSessionAvailabilityListener(this)

            // Register for cast state changes
            castContext?.addCastStateListener(this)

            // Initialize cast state
            updateCastState(castContext?.castState ?: CastState.NO_DEVICES_AVAILABLE)

            Log.d(TAG, "Cast support initialized successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize Cast support: ${e.message}")
            _isCastAvailable.value = false
        }
    }

    // SessionAvailabilityListener implementation
    override fun onCastSessionAvailable() {
        Log.d(TAG, "Cast session became available")
        _isCastConnected.value = true

        castContext?.sessionManager?.currentCastSession?.let { session ->
            _castDeviceName.value = session.castDevice?.friendlyName
            Log.d(TAG, "Connected to Cast device: ${session.castDevice?.friendlyName}")
        }

        isSwitchingPlayer = true
        playerSwitchListener?.onSwitchToCastPlayer(_castPlayer!!)
    }

    override fun onCastSessionUnavailable() {
        Log.d(TAG, "Cast session became unavailable")
        _isCastConnected.value = false
        _castDeviceName.value = null

        isSwitchingPlayer = true
        playerSwitchListener?.onSwitchToLocalPlayer()
    }

    // CastStateListener implementation
    override fun onCastStateChanged(newState: Int) {
        Log.d(TAG, "Cast state changed: ${getCastStateString(newState)}")
        updateCastState(newState)
    }

    private fun updateCastState(castState: Int) {
        when (castState) {
            CastState.NO_DEVICES_AVAILABLE -> {
                _isCastAvailable.value = false
                _isCastConnected.value = false
            }
            CastState.NOT_CONNECTED -> {
                _isCastAvailable.value = true
                _isCastConnected.value = false
            }
            CastState.CONNECTING -> {
                _isCastAvailable.value = true
                _isCastConnected.value = false
            }
            CastState.CONNECTED -> {
                _isCastAvailable.value = true
                _isCastConnected.value = true
            }
        }
    }

    private fun getCastStateString(state: Int): String {
        return when (state) {
            CastState.NO_DEVICES_AVAILABLE -> "NO_DEVICES_AVAILABLE"
            CastState.NOT_CONNECTED -> "NOT_CONNECTED"
            CastState.CONNECTING -> "CONNECTING"
            CastState.CONNECTED -> "CONNECTED"
            else -> "UNKNOWN($state)"
        }
    }

    /**
     * Sets the listener for player switching events
     */
    fun setPlayerSwitchListener(listener: PlayerSwitchListener) {
        this.playerSwitchListener = listener
    }

    /**
     * Manually trigger connection to a Cast device
     */
    fun connectToCast() {
        Log.d(TAG, "Manual Cast connection requested")
        try {
            castContext?.let { context ->
                // This would typically open the Cast dialog
                // The actual implementation depends on your UI framework
                Log.d(TAG, "Cast context available, delegate to UI for device selection")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initiate Cast connection: ${e.message}")
        }
    }

    /**
     * Manually disconnect from Cast
     */
    fun disconnectFromCast() {
        Log.d(TAG, "Manual Cast disconnection requested")
        try {
            castContext?.sessionManager?.endCurrentSession(true)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to disconnect from Cast: ${e.message}")
        }
    }

    /**
     * Gets the current Cast session info
     */
    fun getCastSessionInfo(): CastSessionInfo? {
        return try {
            castContext?.sessionManager?.currentCastSession?.let { session ->
                CastSessionInfo(
                    deviceName = session.castDevice?.friendlyName ?: "Unknown Device",
                    deviceModel = session.castDevice?.modelName,
                    isConnected = true,
                    volume = session.volume,
                    isMuted = session.isMute
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get Cast session info: ${e.message}")
            null
        }
    }

    /**
     * Enhances MediaItems with Cast-specific metadata
     */
    fun enhanceMediaItemForCast(mediaItem: MediaItem): MediaItem {
        // Add any Cast-specific metadata or modifications
        return mediaItem
    }

    /**
     * Checks if the current MediaItem is suitable for Cast
     */
    fun isMediaItemCastable(mediaItem: MediaItem): Boolean {
        // Check if the media item can be played on Cast
        val uri = mediaItem.localConfiguration?.uri
        return uri != null && (uri.scheme == "http" || uri.scheme == "https")
    }

    /**
     * Gets Cast-compatible MediaItems from a list
     */
    fun filterCastableMediaItems(mediaItems: List<MediaItem>): List<MediaItem> {
        return mediaItems.filter { isMediaItemCastable(it) }
    }

    fun release() {
        Log.d(TAG, "Releasing CastPlayerManager")

        try {
            castContext?.removeCastStateListener(this)
            _castPlayer?.setSessionAvailabilityListener(null)
            _castPlayer?.release()
            _castPlayer = null
            castContext = null
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing Cast resources: ${e.message}")
        }

        playerSwitchListener = null
    }
}

/**
 * Interface for listening to player switching events
 */
interface PlayerSwitchListener {
    fun onSwitchToCastPlayer(castPlayer: CastPlayer)
    fun onSwitchToLocalPlayer()
}

/**
 * Information about the current Cast session
 */
data class CastSessionInfo(
    val deviceName: String,
    val deviceModel: String?,
    val isConnected: Boolean,
    val volume: Double,
    val isMuted: Boolean
)
