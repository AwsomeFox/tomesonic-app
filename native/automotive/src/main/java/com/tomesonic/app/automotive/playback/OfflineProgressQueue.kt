package com.tomesonic.app.automotive.playback

import com.tomesonic.app.automotive.Graph
import com.tomesonic.app.automotive.data.AbsApi
import com.tomesonic.app.automotive.data.CredsRepository
import com.tomesonic.app.automotive.data.absDouble
import com.tomesonic.app.automotive.data.absFinite
import com.tomesonic.app.automotive.data.absLong
import com.tomesonic.app.automotive.data.absStr
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import kotlin.math.max
import kotlin.math.min

/**
 * The car's offline progress store — a Kotlin port of the phone's proven
 * two-queue scheme (utils/progressSync.ts), narrowed to the two queues the
 * contract names (ARCHITECTURE.md §8):
 *
 *  1. POSITION — one media-progress patch per item (latest wins), flushed as a
 *     single `PATCH /api/me/progress/batch/update` with a BARE array.
 *  2. LISTENING TIME — one CUMULATIVE record per item+day, id
 *     `automotive-local_<itemId>[-<episodeId>]_<YYYY-MM-DD>`, flushed one
 *     `POST /api/session/local` each. ABS upserts by id and REPLACES
 *     timeListening, so re-sending a grown day total is idempotent — which is
 *     exactly what makes a partial flush safe.
 *
 * Plus a third, NON-draining map the phone doesn't need: `resume`, the latest
 * local position per item under a `local_pos_` key. A downloaded book has no
 * server session to resume from, and the position queue empties the moment
 * connectivity returns — so resume needs its own home. It lives HERE, in the
 * one `offline_sessions` blob, because CredsRepository owns the preference key
 * table and this wave does not add keys to it.
 *
 * Blob shape (this class owns it):
 * ```json
 * {"v":1,
 *  "positions":{"li_1":{"libraryItemId":"li_1","currentTime":12.5,"duration":3600,"at":1750000000000}},
 *  "days":{"automotive-local_li_1_2026-08-24":{ ...record..., "syncedTimeListening":600 }},
 *  "resume":{"local_pos_li_1":12.5}}
 * ```
 *
 * Maps, not arrays: "latest position wins per item" and "one record per
 * item+day" ARE key collisions, so making the key the key removes the merge
 * step — and with it the class of bug where two entries for one item both
 * flush and the older one lands last.
 */
class OfflineProgressQueue(
    private val credsRepository: CredsRepository,
    private val clock: () -> Long = System::currentTimeMillis,
    private val zone: () -> ZoneId = ZoneId::systemDefault,
    private val clientVersion: () -> String = { Graph.versionName }
) {

    // Every read-modify-write of the blob runs under this. DataStore serialises
    // its own edit(), but "read the blob, merge, write it back" spans two calls
    // — two concurrent syncs would otherwise each write their own merge and one
    // would silently win.
    private val lock = Mutex()

    /** The two flush routes, behind an interface so the queue is testable without a server. */
    interface Uploader {
        suspend fun batchUpdateProgress(payloads: JSONArray): Boolean
        suspend fun syncLocalSession(body: JSONObject): Boolean
    }

    // ---- writes -------------------------------------------------------------

    /**
     * Bank one progress sample. ONE blob write covers all three maps: the syncer
     * calls this every 15s, and three separate writes would be three DataStore
     * fsyncs per tick.
     *
     * `persistResume` is false on the ONLINE fallback path (a failed server sync
     * mirrors its position + seconds here): a server-backed session resumes from
     * PlaySession.currentTime, and a local marker left behind would outrank the
     * server's own answer on the next play.
     */
    suspend fun record(
        itemId: String,
        episodeId: String?,
        currentTime: Double,
        duration: Double,
        secondsListened: Double,
        title: String,
        author: String?,
        mediaType: String,
        persistResume: Boolean
    ) {
        if (itemId.isBlank()) return
        val now = clock()
        lock.withLock {
            val state = read()
            val key = itemKey(itemId, episodeId)

            // POSITION: latest wins, unconditionally. `at` exists for the flush's
            // TOCTOU check (a sample queued while the PATCH was in flight must
            // survive the removal), not for ordering — one writer, in order.
            if (currentTime.isFinite() && currentTime >= 0.0) {
                state.positions[key] = Position(
                    itemId = itemId,
                    episodeId = episodeId,
                    currentTime = currentTime,
                    duration = if (duration.isFinite() && duration > 0.0) duration else 0.0,
                    at = now
                )
                if (persistResume) state.resume[resumeKey(itemId, episodeId)] = currentTime
            }

            // LISTENING TIME: accumulate into this item's record for TODAY.
            val seconds = if (secondsListened.isFinite() && secondsListened > 0.0) secondsListened else 0.0
            if (seconds > 0.0) {
                val date = dateOf(now)
                val id = dayId(itemId, episodeId, date)
                val rec = state.days[id] ?: DayRecord(
                    id = id,
                    itemId = itemId,
                    episodeId = episodeId,
                    mediaType = mediaType,
                    displayTitle = title,
                    displayAuthor = author,
                    duration = 0.0,
                    date = date,
                    dayOfWeek = dayOfWeekOf(now),
                    timeListening = 0.0,
                    syncedTimeListening = 0.0,
                    currentTime = 0.0,
                    startedAt = now,
                    updatedAt = now
                )
                rec.timeListening += seconds
                if (currentTime.isFinite() && currentTime >= 0.0) rec.currentTime = currentTime
                if (duration.isFinite() && duration > 0.0) rec.duration = duration
                // A record created before the title was known still gets a
                // display name once one exists — ABS's "recent sessions" list is
                // otherwise blank for these.
                if (rec.displayTitle.isBlank()) rec.displayTitle = title
                if (rec.displayAuthor.isNullOrBlank()) rec.displayAuthor = author
                rec.updatedAt = now
                state.days[id] = rec
            }

            write(state)
        }
    }

    /** Local-playback resume marker only — for a seek that listened nothing. */
    suspend fun setResume(itemId: String, episodeId: String?, seconds: Double) {
        if (itemId.isBlank() || !seconds.isFinite() || seconds < 0.0) return
        lock.withLock {
            val state = read()
            state.resume[resumeKey(itemId, episodeId)] = seconds
            write(state)
        }
    }

    /** Where local playback of this item left off, or null if it never has. */
    suspend fun resumePosition(itemId: String, episodeId: String?): Double? =
        lock.withLock { read().resume[resumeKey(itemId, episodeId)] }

    // ---- flush --------------------------------------------------------------

    /** Production entry point. See the [Uploader] overload for the actual rules. */
    suspend fun flush(api: AbsApi): Boolean = flush(object : Uploader {
        override suspend fun batchUpdateProgress(payloads: JSONArray): Boolean =
            api.batchUpdateProgress(payloads)

        override suspend fun syncLocalSession(body: JSONObject): Boolean =
            api.syncLocalSession(body)
    })

    /**
     * Deliver everything queued. Returns true only when NOTHING is left owed —
     * callers read it as "the car is caught up", never as a retry signal (the
     * triggers are reconnect / the next sync / the next start).
     *
     * Removes ONLY what the server accepted. Positions go as one batch, so they
     * clear together or not at all; each day record clears on its own POST. A
     * record that fails stays exactly as it is — re-sending a GROWN cumulative
     * total is idempotent under ABS's upsert-and-replace, which is the whole
     * reason this queue survives a partial flush without transactions.
     */
    suspend fun flush(uploader: Uploader): Boolean {
        val owed = lock.withLock {
            val state = read()
            val positions = state.positions.values.toList()
            val days = state.days.values.filter { it.timeListening > it.syncedTimeListening }
            if (positions.isEmpty() && days.isEmpty()) {
                // Nothing owed: prune finished records from PREVIOUS days and leave.
                if (pruneSettledDays(state)) write(state)
                null
            } else {
                positions to days
            }
        } ?: return true
        val sentPositions = owed.first
        val owedDays = owed.second

        var allDelivered = true

        // POSITIONS — one PATCH with the bare array (verified in utils/abs/me.ts).
        var positionsDelivered = false
        if (sentPositions.isNotEmpty()) {
            val payloads = JSONArray()
            sentPositions.forEach { payloads.put(it.toPayload()) }
            positionsDelivered = uploader.batchUpdateProgress(payloads)
            if (!positionsDelivered) allDelivered = false
        }

        // LISTENING TIME — one POST per day record, independently retryable.
        val delivered = HashMap<String, Double>()
        if (owedDays.isNotEmpty()) {
            val device = deviceInfo()
            for (rec in owedDays) {
                val total = rec.timeListening
                if (uploader.syncLocalSession(rec.toPayload(device))) delivered[rec.id] = total
                else allDelivered = false
            }
        }

        // COMMIT — re-read: samples recorded while the requests were in flight
        // must survive, so every removal is conditional on what we actually sent.
        lock.withLock {
            val state = read()
            if (positionsDelivered) {
                for (sent in sentPositions) {
                    val current = state.positions[sent.key] ?: continue
                    if (current.at <= sent.at) state.positions.remove(sent.key)
                }
            }
            for ((id, sentTotal) in delivered) {
                val rec = state.days[id] ?: continue
                rec.syncedTimeListening = max(rec.syncedTimeListening, sentTotal)
            }
            pruneSettledDays(state)
            write(state)
        }
        return allDelivered
    }

    /**
     * Drop fully-delivered records for days that are OVER. Today's record stays:
     * later listening accumulates into the same server session id, and dropping
     * it would restart the day's total from zero and REPLACE the server's real
     * figure with that restart.
     */
    private fun pruneSettledDays(state: State): Boolean {
        val today = dateOf(clock())
        val gone = state.days.values
            .filter { it.date != today && it.timeListening <= it.syncedTimeListening }
            .map { it.id }
        gone.forEach { state.days.remove(it) }
        return gone.isNotEmpty()
    }

    private suspend fun deviceInfo(): JSONObject =
        // Reuse AbsApi's pinned builder rather than re-deriving the same six
        // fields: the local-session deviceInfo and the /play one must describe
        // the SAME device, or ABS files this car's stats under two of them.
        AbsApi.playSessionBody(credsRepository.deviceId(), clientVersion())
            .getJSONObject("deviceInfo")

    // ---- blob codec ---------------------------------------------------------

    /**
     * Parse the blob. A corrupt or half-written value is treated as EMPTY, never
     * thrown: this runs on the playback path, and losing a queue is strictly
     * better than a player that cannot start.
     */
    private suspend fun read(): State {
        val raw = credsRepository.offlineSessions.first()
        val state = State()
        val root = try {
            if (raw.isNullOrBlank()) null else JSONObject(raw)
        } catch (t: Throwable) {
            null
        } ?: return state

        root.optJSONObject("positions")?.let { positions ->
            for (key in positions.keys()) {
                Position.fromJson(positions.optJSONObject(key))?.let { state.positions[key] = it }
            }
        }
        root.optJSONObject("days")?.let { days ->
            for (key in days.keys()) {
                DayRecord.fromJson(days.optJSONObject(key))?.let { state.days[key] = it }
            }
        }
        root.optJSONObject("resume")?.let { resume ->
            for (key in resume.keys()) {
                val v = absDouble(resume, key) ?: continue
                if (v >= 0.0) state.resume[key] = v
            }
        }
        return state
    }

    private suspend fun write(state: State) {
        val positions = JSONObject()
        state.positions.forEach { (k, v) -> positions.put(k, v.toJson()) }
        val days = JSONObject()
        state.days.forEach { (k, v) -> days.put(k, v.toJson()) }
        val resume = JSONObject()
        state.resume.forEach { (k, v) -> resume.put(k, absFinite(v)) }
        credsRepository.setOfflineSessions(
            JSONObject()
                .put("v", BLOB_VERSION)
                .put("positions", positions)
                .put("days", days)
                .put("resume", resume)
                .toString()
        )
    }

    private fun dateOf(ts: Long): String =
        Instant.ofEpochMilli(ts).atZone(zone()).toLocalDate().toString()

    private fun dayOfWeekOf(ts: Long): String {
        // DayOfWeek.value is 1=Monday..7=Sunday; the phone indexes an English
        // array by JS getDay() (0=Sunday). `% 7` bridges the two so every client
        // labels the same day identically in ABS's stats.
        val dow = Instant.ofEpochMilli(ts).atZone(zone()).dayOfWeek.value
        return DAY_NAMES[dow % 7]
    }

    companion object {
        const val BLOB_VERSION = 1

        /** ABS PlayMethod.LOCAL — a file played off the device, not the server. */
        const val PLAY_METHOD_LOCAL = 3

        /**
         * The `automotive-` prefix is load-bearing (ARCHITECTURE.md §1): the
         * PHONE writes `local_<item>_<date>` and the WATCH `wear-local_…` for the
         * same item+day, ABS upserts by id, and a shared id would let one
         * device's total REPLACE another's. Three clients, three prefixes.
         */
        const val DAY_ID_PREFIX = "automotive-local_"

        const val RESUME_KEY_PREFIX = "local_pos_"

        private val DAY_NAMES = arrayOf(
            "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
        )

        /** Episodes queue independently of their podcast — same convention as /api/me. */
        fun itemKey(itemId: String, episodeId: String?): String =
            if (episodeId.isNullOrBlank()) itemId else "$itemId-$episodeId"

        fun dayId(itemId: String, episodeId: String?, date: String): String =
            "$DAY_ID_PREFIX${itemKey(itemId, episodeId)}_$date"

        fun resumeKey(itemId: String, episodeId: String?): String =
            "$RESUME_KEY_PREFIX${itemKey(itemId, episodeId)}"

        /** ONE instance per process — see the lock; two would each hold their own. */
        val shared: OfflineProgressQueue by lazy { OfflineProgressQueue(Graph.credsRepository) }
    }

    // ---- blob model -----------------------------------------------------

    private class State(
        val positions: LinkedHashMap<String, Position> = LinkedHashMap(),
        val days: LinkedHashMap<String, DayRecord> = LinkedHashMap(),
        val resume: LinkedHashMap<String, Double> = LinkedHashMap()
    )

    private class Position(
        val itemId: String,
        val episodeId: String?,
        val currentTime: Double,
        val duration: Double,
        val at: Long
    ) {
        val key: String get() = OfflineProgressQueue.itemKey(itemId, episodeId)

        fun toJson(): JSONObject = JSONObject()
            .put("libraryItemId", itemId)
            .putIfPresent("episodeId", episodeId)
            .put("currentTime", absFinite(currentTime))
            .put("duration", absFinite(duration))
            .put("at", at)

        /**
         * One element of the batch array. `duration`/`progress` are OMITTED when the
         * duration is unknown — the phone does the same, because a 0 duration would
         * overwrite the server's real one and zero the item's progress everywhere.
         */
        fun toPayload(): JSONObject {
            val payload = JSONObject()
                .put("libraryItemId", itemId)
                .putIfPresent("episodeId", episodeId)
                .put("currentTime", absFinite(currentTime))
            if (duration > 0.0) {
                payload.put("duration", absFinite(duration))
                payload.put("progress", min(1.0, max(0.0, currentTime / duration)))
            }
            return payload
        }

        companion object {
            fun fromJson(o: JSONObject?): Position? {
                val obj = o ?: return null
                val id = absStr(obj, "libraryItemId") ?: return null
                return Position(
                    itemId = id,
                    episodeId = absStr(obj, "episodeId"),
                    currentTime = absDouble(obj, "currentTime") ?: 0.0,
                    duration = absDouble(obj, "duration") ?: 0.0,
                    at = absLong(obj, "at") ?: 0L
                )
            }
        }
    }

    private class DayRecord(
        val id: String,
        val itemId: String,
        val episodeId: String?,
        val mediaType: String,
        var displayTitle: String,
        var displayAuthor: String?,
        var duration: Double,
        val date: String,
        val dayOfWeek: String,
        var timeListening: Double,
        var syncedTimeListening: Double,
        var currentTime: Double,
        val startedAt: Long,
        var updatedAt: Long
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("id", id)
            .put("libraryItemId", itemId)
            .putIfPresent("episodeId", episodeId)
            .put("mediaType", mediaType)
            .put("displayTitle", displayTitle)
            .putIfPresent("displayAuthor", displayAuthor)
            .put("duration", absFinite(duration))
            .put("date", date)
            .put("dayOfWeek", dayOfWeek)
            .put("timeListening", absFinite(timeListening))
            .put("syncedTimeListening", absFinite(syncedTimeListening))
            .put("currentTime", absFinite(currentTime))
            .put("startedAt", startedAt)
            .put("updatedAt", updatedAt)

        /**
         * The `POST /api/session/local` body, field-for-field from the contract.
         * `syncedTimeListening` is OURS and must not leak into it — it records how
         * much of `timeListening` the server has already been told.
         */
        fun toPayload(deviceInfo: JSONObject): JSONObject = JSONObject()
            .put("id", id)
            .put("libraryItemId", itemId)
            .putIfPresent("episodeId", episodeId)
            .put("mediaType", mediaType)
            .put("displayTitle", displayTitle)
            .put("displayAuthor", displayAuthor ?: "")
            .put("duration", absFinite(duration))
            .put("playMethod", OfflineProgressQueue.PLAY_METHOD_LOCAL)
            .put("mediaPlayer", AbsApi.MEDIA_PLAYER)
            .put("deviceInfo", deviceInfo)
            .put("date", date)
            .put("dayOfWeek", dayOfWeek)
            .put("timeListening", absFinite(timeListening))
            .put("currentTime", absFinite(currentTime))
            .put("startedAt", startedAt)
            .put("updatedAt", updatedAt)

        companion object {
            fun fromJson(o: JSONObject?): DayRecord? {
                val obj = o ?: return null
                val id = absStr(obj, "id") ?: return null
                val itemId = absStr(obj, "libraryItemId") ?: return null
                return DayRecord(
                    id = id,
                    itemId = itemId,
                    episodeId = absStr(obj, "episodeId"),
                    mediaType = absStr(obj, "mediaType") ?: "book",
                    displayTitle = absStr(obj, "displayTitle") ?: "",
                    displayAuthor = absStr(obj, "displayAuthor"),
                    duration = absDouble(obj, "duration") ?: 0.0,
                    date = absStr(obj, "date") ?: "",
                    dayOfWeek = absStr(obj, "dayOfWeek") ?: "",
                    timeListening = absDouble(obj, "timeListening") ?: 0.0,
                    syncedTimeListening = absDouble(obj, "syncedTimeListening") ?: 0.0,
                    currentTime = absDouble(obj, "currentTime") ?: 0.0,
                    startedAt = absLong(obj, "startedAt") ?: 0L,
                    updatedAt = absLong(obj, "updatedAt") ?: 0L
                )
            }
        }
    }
}

/** `put` that OMITS the key rather than writing a JSON null for an absent value. */
private fun JSONObject.putIfPresent(key: String, value: String?): JSONObject {
    if (!value.isNullOrEmpty()) put(key, value)
    return this
}
