package com.tomesonic.app.wear.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.tasks.await
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * The watch's only persistent store: DataStore("tomesonic_wear"), key table in
 * native/wear/ARCHITECTURE.md.
 *
 * v1 has NO watch-side login — server + access token arrive from the paired
 * phone over the Wearable Data Layer and land here. Two paths write them and
 * both go through [applyFromDataLayer] so they can't diverge:
 *  - [DataLayerListenerService], on every phone-side put, and
 *  - [refreshFromDataLayer], reading the DataItem ALREADY on the node (the
 *    listener only fires on changes, so an app installed or opened after the
 *    phone logged in would otherwise never see credentials at all).
 *
 * The DataStore is injected so tests can point it at a temp file; production
 * builds it once via [create] behind Graph's lazy singleton — two live DataStore
 * instances over one file is an error, not a merge.
 */
class CredsRepository(private val store: DataStore<Preferences>) {

    // A corrupt or unreadable file must not kill every collector — swallow IO
    // and behave like a fresh install; the phone re-delivers the creds.
    private val prefs: Flow<Preferences> = store.data.catch { e ->
        if (e is IOException) emit(emptyPreferences()) else throw e
    }

    /**
     * The current credentials, or null when the watch is not configured — the
     * frozen cross-wave interface. Null unless BOTH server and token are
     * non-blank: a half-written pair is exactly as useless as none, and the UI
     * routes on this single signal.
     *
     * distinctUntilChanged because DataStore re-emits the WHOLE preference set
     * on any write (a speed change, a resume bookmark), and re-emitting
     * identical creds would reset AbsClient.authFailed on every tick.
     */
    val creds: Flow<Creds?> = prefs.map { credsFrom(it) }.distinctUntilChanged()

    val playbackSpeed: Flow<Float> =
        prefs.map { it[KEY_SPEED] ?: DEFAULT_SPEED }.distinctUntilChanged()

    val lastItem: Flow<LastItem?> = prefs.map { p ->
        val id = p[KEY_LAST_ITEM]?.takeIf { it.isNotBlank() }
        if (id == null) null else LastItem(id, p[KEY_LAST_EPISODE]?.takeIf { it.isNotBlank() })
    }.distinctUntilChanged()

    /** Wave 3A's OfflineSessionQueue blob — stored here so the key table has one owner. */
    val offlineSessions: Flow<String?> = prefs.map { it[KEY_OFFLINE_SESSIONS] }.distinctUntilChanged()

    suspend fun set(server: String, token: String, userId: String, username: String) {
        store.edit { p ->
            p[KEY_SERVER] = normalizeServer(server)
            p[KEY_TOKEN] = token.trim()
            p[KEY_USER_ID] = userId
            p[KEY_USERNAME] = username
        }
    }

    /**
     * Logged out. Drops the creds AND the resume pointer (both are USER-scoped —
     * surfacing the previous account's book would be a leak), but keeps
     * `device_id` and `playback_speed`, which belong to the watch, not the user.
     */
    suspend fun clear() {
        store.edit { p ->
            p.remove(KEY_SERVER)
            p.remove(KEY_TOKEN)
            p.remove(KEY_USER_ID)
            p.remove(KEY_USERNAME)
            p.remove(KEY_LAST_ITEM)
            p.remove(KEY_LAST_EPISODE)
        }
    }

    /**
     * Stable per-install id for the ABS `deviceInfo.deviceId`. Minted once and
     * persisted: ABS keys listening sessions by it, so a new id per launch would
     * fragment this watch's stats into a new "device" every time.
     *
     * Suspend because minting is a DataStore write — the mint happens INSIDE
     * edit() so two concurrent callers can't each generate one.
     */
    suspend fun deviceId(): String {
        prefs.first()[KEY_DEVICE_ID]?.takeIf { it.isNotBlank() }?.let { return it }
        val updated = store.edit { p ->
            if (p[KEY_DEVICE_ID].isNullOrBlank()) p[KEY_DEVICE_ID] = UUID.randomUUID().toString()
        }
        return updated[KEY_DEVICE_ID] ?: ""
    }

    suspend fun setPlaybackSpeed(speed: Float) {
        // A non-finite or non-positive rate would persist and then wedge the
        // player on every launch — refuse it at the boundary (same guard the
        // phone's setPlaybackSpeed applies).
        if (!speed.isFinite() || speed <= 0f) return
        store.edit { it[KEY_SPEED] = speed }
    }

    suspend fun setLastItem(itemId: String?, episodeId: String?) {
        store.edit { p ->
            if (itemId.isNullOrBlank()) {
                p.remove(KEY_LAST_ITEM)
                p.remove(KEY_LAST_EPISODE)
            } else {
                p[KEY_LAST_ITEM] = itemId
                if (episodeId.isNullOrBlank()) p.remove(KEY_LAST_EPISODE)
                else p[KEY_LAST_EPISODE] = episodeId
            }
        }
    }

    suspend fun setOfflineSessions(json: String) {
        store.edit { it[KEY_OFFLINE_SESSIONS] = json }
    }

    /**
     * The ONE place a Data Layer payload becomes stored credentials — shared by
     * the listener and [refreshFromDataLayer] so "logout" can't mean two things.
     * Blank server or token IS the logout signal: the phone clears by putting
     * empty strings, deliberately not by deleting the DataItem.
     */
    suspend fun applyFromDataLayer(
        server: String?,
        token: String?,
        userId: String?,
        username: String?
    ) {
        val normalized = normalizeServer(server ?: "")
        val trimmedToken = (token ?: "").trim()
        if (normalized.isEmpty() || trimmedToken.isEmpty()) {
            clear()
        } else {
            set(normalized, trimmedToken, userId ?: "", username ?: "")
        }
    }

    /**
     * Reads the DataItem already sitting on this node. Covers the case the
     * listener structurally cannot: the watch app installed (or first opened)
     * AFTER the phone logged in, where no change event will ever fire.
     *
     * Best-effort like the phone's WearBridgeModule — no Play services, no
     * paired phone, a disconnected node: leave the stored creds untouched and
     * say nothing. Never throws.
     */
    suspend fun refreshFromDataLayer(context: Context) {
        var found = false
        var bestTs = Long.MIN_VALUE
        var server: String? = null
        var token: String? = null
        var userId: String? = null
        var username: String? = null
        try {
            val buffer = Wearable.getDataClient(context.applicationContext).dataItems.await()
            try {
                for (item in buffer) {
                    if (item.uri.path != CREDS_PATH) continue
                    val map = DataMapItem.fromDataItem(item).dataMap
                    // Several nodes can hold a copy; `ts` is the phone's put clock,
                    // so the largest one is the newest login/logout.
                    val ts = map.getLong(DL_KEY_TS, 0L)
                    if (found && ts < bestTs) continue
                    // Copy the values out BEFORE releasing the buffer they read from.
                    found = true
                    bestTs = ts
                    server = map.getString(DL_KEY_SERVER)
                    token = map.getString(DL_KEY_TOKEN)
                    userId = map.getString(DL_KEY_USER_ID)
                    username = map.getString(DL_KEY_USERNAME)
                }
            } finally {
                buffer.release()
            }
        } catch (t: Throwable) {
            return
        }
        if (!found) return
        applyFromDataLayer(server, token, userId, username)
    }

    private fun credsFrom(p: Preferences): Creds? {
        val server = normalizeServer(p[KEY_SERVER] ?: "")
        val token = (p[KEY_TOKEN] ?: "").trim()
        if (server.isEmpty() || token.isEmpty()) return null
        return Creds(server, token, p[KEY_USER_ID] ?: "", p[KEY_USERNAME] ?: "")
    }

    companion object {
        /** Data Layer contract — MUST match the phone's WearBridgeModule. */
        const val CREDS_PATH = "/tomesonic/creds"
        const val DL_KEY_SERVER = "server"
        const val DL_KEY_TOKEN = "token"
        const val DL_KEY_USER_ID = "userId"
        const val DL_KEY_USERNAME = "username"
        const val DL_KEY_TS = "ts"

        const val DEFAULT_SPEED = 1.0f

        private const val DATASTORE_NAME = "tomesonic_wear"

        private val KEY_SERVER = stringPreferencesKey("abs_server")
        private val KEY_TOKEN = stringPreferencesKey("abs_token")
        private val KEY_USER_ID = stringPreferencesKey("abs_user_id")
        private val KEY_USERNAME = stringPreferencesKey("abs_username")
        private val KEY_DEVICE_ID = stringPreferencesKey("device_id")
        private val KEY_SPEED = floatPreferencesKey("playback_speed")
        private val KEY_LAST_ITEM = stringPreferencesKey("last_item_id")
        private val KEY_LAST_EPISODE = stringPreferencesKey("last_episode_id")
        private val KEY_OFFLINE_SESSIONS = stringPreferencesKey("offline_sessions")

        /**
         * Origin only, no trailing slash — ALL of them, not just one. Every URL
         * is built by concatenating a leading-slash path onto this, so a stray
         * slash would produce `//api/...` and 404 the whole app.
         */
        fun normalizeServer(raw: String): String = raw.trim().trimEnd('/')

        /** Same file the `preferencesDataStore` delegate would produce, without its process-wide singleton. */
        fun create(context: Context): CredsRepository = CredsRepository(
            PreferenceDataStoreFactory.create(
                produceFile = {
                    File(
                        context.applicationContext.filesDir,
                        "datastore/$DATASTORE_NAME.preferences_pb"
                    )
                }
            )
        )
    }
}
