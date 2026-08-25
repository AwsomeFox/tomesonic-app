package com.tomesonic.app.wear.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
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
 * Credentials arrive from two places, and the store remembers which:
 *  - the paired PHONE, over the Wearable Data Layer, through the two paths that
 *    both funnel into [applyFromDataLayer] so they can't diverge —
 *    [DataLayerListenerService] on every phone-side put, and
 *    [refreshFromDataLayer] reading the DataItem ALREADY on the node (the
 *    listener only fires on changes, so an app installed or opened after the
 *    phone logged in would otherwise never see credentials at all);
 *  - the WATCH's own login ([setWatchLogin]), which additionally holds a
 *    refresh token and can therefore renew itself ([updateAccessToken]).
 *
 * The phone stays PRIMARY: its credentials overwrite a watch login on arrival.
 * Its LOGOUT does not — that is the phone ending the phone's session, and a
 * watch login is a different ABS session it says nothing about.
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
        if (id == null) null else LastItem(
            id,
            p[KEY_LAST_EPISODE]?.takeIf { it.isNotBlank() },
            p[KEY_LAST_TITLE]?.takeIf { it.isNotBlank() },
            p[KEY_LAST_AUTHOR]?.takeIf { it.isNotBlank() }
        )
    }.distinctUntilChanged()

    /** Wave 3A's OfflineSessionQueue blob — stored here so the key table has one owner. */
    val offlineSessions: Flow<String?> = prefs.map { it[KEY_OFFLINE_SESSIONS] }.distinctUntilChanged()

    /** A phone-mirrored login. The signature v1 callers use, with v1's meaning. */
    suspend fun set(server: String, token: String, userId: String, username: String) {
        store.edit { p ->
            val newServer = normalizeServer(server)
            wipeIfIdentityChanged(p, newServer, userId)
            p[KEY_SERVER] = newServer
            p[KEY_TOKEN] = token.trim()
            p[KEY_USER_ID] = userId
            p[KEY_USERNAME] = username
            // A phone mirror REPLACES a watch login wholesale. The phone sends
            // an access token from ITS ABS session; a refresh token left behind
            // belongs to the watch session these credentials just displaced, and
            // spending it would renew a login the user is no longer in.
            p.remove(KEY_SOURCE)
            p.remove(KEY_REFRESH_TOKEN)
        }
    }

    /**
     * The watch's own login. Same identity rules as [set] — a different account
     * world is a different account world however the credentials arrived — plus
     * the refresh token that makes the session renewable.
     */
    suspend fun setWatchLogin(
        server: String,
        token: String,
        refreshToken: String?,
        userId: String,
        username: String
    ) {
        store.edit { p ->
            val newServer = normalizeServer(server)
            wipeIfIdentityChanged(p, newServer, userId)
            p[KEY_SERVER] = newServer
            p[KEY_TOKEN] = token.trim()
            p[KEY_USER_ID] = userId
            p[KEY_USERNAME] = username
            p[KEY_SOURCE] = SOURCE_WATCH
            // A server with refresh disabled hands back none. This login then
            // simply has no refresh path — and must not inherit the previous
            // login's, which would refresh into someone else's session.
            val rotated = refreshToken?.trim().orEmpty()
            if (rotated.isEmpty()) p.remove(KEY_REFRESH_TOKEN) else p[KEY_REFRESH_TOKEN] = rotated
        }
    }

    /**
     * A refresh result: the same session, a newer access token. Deliberately
     * NOT a login — no identity wipe, because nothing about the account changed
     * and wiping here would drop the resume pointer and the offline queue every
     * time a token aged out.
     *
     * A missing rotation is not an empty rotation: ABS rotates the refresh token
     * on some refreshes and not others, and an absent one means the token that
     * just worked still works (the phone's utils/api.ts makes the same call).
     */
    suspend fun updateAccessToken(token: String, refreshToken: String?) {
        val newToken = token.trim()
        if (newToken.isEmpty()) return
        store.edit { p ->
            // Nothing stored is nothing to renew: a refresh that landed after a
            // logout must not resurrect the credentials the logout removed.
            if ((p[KEY_SERVER] ?: "").isBlank() || (p[KEY_TOKEN] ?: "").isBlank()) return@edit
            p[KEY_TOKEN] = newToken
            val rotated = refreshToken?.trim().orEmpty()
            if (rotated.isNotEmpty()) p[KEY_REFRESH_TOKEN] = rotated
        }
    }

    /**
     * The identity-change wipe, in ONE place so the two login paths cannot drift
     * apart on what counts as a new account.
     *
     * A different server — or a different KNOWN user on the same server — is a
     * different account world: the resume pointer and the offline progress queue
     * are meaningless there, and the queue is worse than meaningless —
     * OfflineProgressQueue flushes it under whatever token is current, which
     * would post account A's listening as account B's. (The phone guards its own
     * offline queues by session identity for exactly this reason —
     * utils/progressSync.ts `sid`.) The userId leg only fires when BOTH sides
     * are non-blank: the phone bridge sends "" today, and a blank must never
     * read as "changed".
     */
    private fun wipeIfIdentityChanged(p: MutablePreferences, newServer: String, userId: String) {
        val oldServer = p[KEY_SERVER]
        val oldUser = p[KEY_USER_ID].orEmpty()
        val identityChanged =
            (oldServer != null && oldServer != newServer) ||
                (oldUser.isNotBlank() && userId.isNotBlank() && oldUser != userId)
        if (identityChanged) {
            p.remove(KEY_LAST_ITEM)
            p.remove(KEY_LAST_EPISODE)
            p.remove(KEY_LAST_TITLE)
            p.remove(KEY_LAST_AUTHOR)
            p.remove(KEY_OFFLINE_SESSIONS)
        }
    }

    /**
     * Logged out. Drops the creds, the resume pointer AND the offline progress
     * queue (all USER-scoped — surfacing the previous account's book would be a
     * leak, and a queue that survived a logout would flush under whichever
     * account logs in next). Keeps `device_id` and `playback_speed`, which
     * belong to the watch, not the user. Unflushed offline listening dies with
     * the logout — same trade the phone makes with its sid-guarded queues.
     */
    suspend fun clear() {
        store.edit { clearInto(it) }
    }

    /** The logout removals, shared with [applyFromDataLayer]'s conditional one. */
    private fun clearInto(p: MutablePreferences) {
        p.remove(KEY_SERVER)
        p.remove(KEY_TOKEN)
        p.remove(KEY_USER_ID)
        p.remove(KEY_USERNAME)
        p.remove(KEY_SOURCE)
        p.remove(KEY_REFRESH_TOKEN)
        p.remove(KEY_LAST_ITEM)
        p.remove(KEY_LAST_EPISODE)
        p.remove(KEY_LAST_TITLE)
        p.remove(KEY_LAST_AUTHOR)
        p.remove(KEY_OFFLINE_SESSIONS)
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

    suspend fun setLastItem(
        itemId: String?,
        episodeId: String?,
        title: String? = null,
        author: String? = null
    ) {
        store.edit { p ->
            if (itemId.isNullOrBlank()) {
                p.remove(KEY_LAST_ITEM)
                p.remove(KEY_LAST_EPISODE)
                p.remove(KEY_LAST_TITLE)
                p.remove(KEY_LAST_AUTHOR)
            } else {
                p[KEY_LAST_ITEM] = itemId
                if (episodeId.isNullOrBlank()) p.remove(KEY_LAST_EPISODE)
                else p[KEY_LAST_EPISODE] = episodeId
                // Display fields for renderers that live outside the app process
                // (the tile). Blank clears rather than writes, so a caller
                // without a title can't erase a good one with "".
                if (title.isNullOrBlank()) p.remove(KEY_LAST_TITLE)
                else p[KEY_LAST_TITLE] = title
                if (author.isNullOrBlank()) p.remove(KEY_LAST_AUTHOR)
                else p[KEY_LAST_AUTHOR] = author
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
     *
     * Precedence, per the v2 contract:
     *  - non-blank credentials ALWAYS apply. The phone is the primary source;
     *    its login overwrites a watch login (and drops the watch's refresh
     *    token with it — see [set]).
     *  - a logout applies ONLY to a phone-sourced session. Signing out on the
     *    phone ends the phone's ABS session; the watch's own login is a
     *    separate one, and ending it is [clear]'s job, from Settings.
     */
    suspend fun applyFromDataLayer(
        server: String?,
        token: String?,
        userId: String?,
        username: String?
    ) {
        val normalized = normalizeServer(server ?: "")
        val trimmedToken = (token ?: "").trim()
        if (normalized.isNotEmpty() && trimmedToken.isNotEmpty()) {
            set(normalized, trimmedToken, userId ?: "", username ?: "")
            return
        }
        store.edit { p ->
            // Read the source INSIDE the edit that acts on it. Deciding first
            // and clearing after would let a watch login that landed in between
            // be wiped by a decision taken before it existed.
            if (sourceFrom(p) != CredsSource.PHONE) return@edit
            clearInto(p)
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
        val source = sourceFrom(p)
        return Creds(
            server = server,
            token = token,
            userId = p[KEY_USER_ID] ?: "",
            username = p[KEY_USERNAME] ?: "",
            source = source,
            // Only a watch login has one. Reading it for a phone mirror would
            // resurrect a stale row into a session it does not belong to.
            refreshToken = if (source == CredsSource.WATCH) {
                p[KEY_REFRESH_TOKEN]?.takeIf { it.isNotBlank() }
            } else {
                null
            }
        )
    }

    /** Absent marker = phone: every v1 row, and every phone mirror since. */
    private fun sourceFrom(p: Preferences): CredsSource =
        if (p[KEY_SOURCE] == SOURCE_WATCH) CredsSource.WATCH else CredsSource.PHONE

    companion object {
        /** Data Layer contract — MUST match the phone's WearBridgeModule. */
        const val CREDS_PATH = "/tomesonic/creds"
        const val DL_KEY_SERVER = "server"
        const val DL_KEY_TOKEN = "token"
        const val DL_KEY_USER_ID = "userId"
        const val DL_KEY_USERNAME = "username"
        const val DL_KEY_TS = "ts"

        const val DEFAULT_SPEED = 1.0f

        /**
         * The only `abs_source` value ever WRITTEN. A phone mirror removes the
         * key instead of writing "phone", so absent and phone stay one state
         * rather than two that could disagree; anything that is not this marker
         * reads back as [CredsSource.PHONE].
         */
        const val SOURCE_WATCH = "watch"

        private const val DATASTORE_NAME = "tomesonic_wear"

        private val KEY_SERVER = stringPreferencesKey("abs_server")
        private val KEY_TOKEN = stringPreferencesKey("abs_token")
        private val KEY_USER_ID = stringPreferencesKey("abs_user_id")
        private val KEY_USERNAME = stringPreferencesKey("abs_username")
        private val KEY_SOURCE = stringPreferencesKey("abs_source")
        private val KEY_REFRESH_TOKEN = stringPreferencesKey("abs_refresh_token")
        private val KEY_DEVICE_ID = stringPreferencesKey("device_id")
        private val KEY_SPEED = floatPreferencesKey("playback_speed")
        private val KEY_LAST_ITEM = stringPreferencesKey("last_item_id")
        private val KEY_LAST_EPISODE = stringPreferencesKey("last_episode_id")
        private val KEY_LAST_TITLE = stringPreferencesKey("last_item_title")
        private val KEY_LAST_AUTHOR = stringPreferencesKey("last_item_author")
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
