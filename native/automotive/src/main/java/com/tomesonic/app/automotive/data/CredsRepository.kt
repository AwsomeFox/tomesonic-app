package com.tomesonic.app.automotive.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * The car's only persistent store: DataStore("tomesonic_automotive"), keys
 * listed in the companion below and in ARCHITECTURE.md §3.
 *
 * Credentials arrive from exactly ONE place — the car's own login
 * ([setCarLogin], driven by Wave 4's SignInActivity), which holds a refresh
 * token and can therefore renew itself ([updateAccessToken]).
 *
 * That single owner is the whole difference from the :wear donor. The watch has
 * a second, PRIMARY source (the paired phone, over the Wearable Data Layer) and
 * a precedence rule to arbitrate them: phone credentials overwrite a watch
 * login, while a phone LOGOUT applies only to a phone-sourced session. There is
 * no phone in a car and no Data Layer, so `applyFromDataLayer`,
 * `refreshFromDataLayer`, the phone-mirror `set()` and the whole precedence
 * matrix are dropped rather than ported — see [CredsSource].
 *
 * The DataStore is injected so tests can point it at a temp file; production
 * builds it once via [create] behind Graph's lazy singleton — two live DataStore
 * instances over one file is an error, not a merge.
 */
class CredsRepository(private val store: DataStore<Preferences>) {

    // A corrupt or unreadable file must not kill every collector — swallow IO
    // and behave like a fresh install; the user signs in again while parked.
    private val prefs: Flow<Preferences> = store.data.catch { e ->
        if (e is IOException) emit(emptyPreferences()) else throw e
    }

    /**
     * The current credentials, or null when the car is not configured — the
     * frozen cross-wave interface. Null unless BOTH server and token are
     * non-blank: a half-written pair is exactly as useless as none, and the
     * browse tree routes on this single signal.
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

    /** Wave 3's OfflineProgressQueue blob — stored here so the key table has one owner. */
    val offlineSessions: Flow<String?> = prefs.map { it[KEY_OFFLINE_SESSIONS] }.distinctUntilChanged()

    /**
     * The car's login — the ONLY way credentials enter this store.
     *
     * Wipes user-scoped state when the identity changed ([wipeIfIdentityChanged])
     * and records the refresh token that makes the session renewable.
     */
    suspend fun setCarLogin(
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
            p[KEY_SOURCE] = SOURCE_CAR
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
     * The identity-change wipe. Kept as its own function — the donor shares it
     * between two login paths, and this module keeps the seam so the rule stays
     * one rule if a second one ever lands.
     *
     * A different server — or a different KNOWN user on the same server — is a
     * different account world: the resume pointer and the offline progress queue
     * are meaningless there, and the queue is worse than meaningless —
     * OfflineProgressQueue flushes it under whatever token is current, which
     * would post account A's listening as account B's. (The phone guards its own
     * offline queues by session identity for exactly this reason —
     * utils/progressSync.ts `sid`.) The userId leg only fires when BOTH sides
     * are non-blank: a server that answers a login without an id must never read
     * as "changed".
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
     * queue (all USER-scoped — surfacing the previous account's book on a shared
     * car's Media Center would be a leak, and a queue that survived a logout
     * would flush under whichever account signs in next). Keeps `device_id` and
     * `playback_speed`, which belong to the car, not the user. Unflushed offline
     * listening dies with the logout — same trade the phone makes with its
     * sid-guarded queues.
     */
    suspend fun clear() {
        store.edit { clearInto(it) }
    }

    /**
     * The logout removals, as one list. The donor shares this with its
     * conditional Data-Layer logout; here [clear] is the only caller, and the
     * seam is kept so the key list has exactly one home.
     */
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
     * fragment this car's stats into a new "device" every time.
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
                // Display fields for the playback-resumption affordance, which
                // the Media Center draws before this app has fetched anything.
                // Blank clears rather than writes, so a caller without a title
                // can't erase a good one with "".
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

    private fun credsFrom(p: Preferences): Creds? {
        val server = normalizeServer(p[KEY_SERVER] ?: "")
        val token = (p[KEY_TOKEN] ?: "").trim()
        if (server.isEmpty() || token.isEmpty()) return null
        return Creds(
            server = server,
            token = token,
            userId = p[KEY_USER_ID] ?: "",
            username = p[KEY_USERNAME] ?: "",
            source = CredsSource.CAR,
            // Read unconditionally: the donor gates this on a WATCH-sourced row
            // because a phone mirror's stale refresh token would renew a session
            // it never belonged to. With one owner there is no other session it
            // could belong to — and [clear] removes the token and the marker
            // together, so a row that has one has it from its own login.
            refreshToken = p[KEY_REFRESH_TOKEN]?.takeIf { it.isNotBlank() }
        )
    }

    companion object {
        const val DEFAULT_SPEED = 1.0f

        /**
         * The only `abs_source` value ever written, and — with a single
         * credential owner — never read back as a decision: [credsFrom] returns
         * [CredsSource.CAR] unconditionally. It is written anyway because the
         * contract's key table names `abs_source` (ARCHITECTURE.md §3) and
         * because a store whose rows carry no owner at all could not tell a
         * second owner's rows from these if one ever arrives.
         */
        const val SOURCE_CAR = "car"

        private const val DATASTORE_NAME = "tomesonic_automotive"

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
