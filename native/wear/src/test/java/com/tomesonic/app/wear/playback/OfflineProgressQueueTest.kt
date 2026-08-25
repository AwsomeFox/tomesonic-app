package com.tomesonic.app.wear.playback

import android.app.Application
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.tomesonic.app.wear.data.CredsRepository
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.time.ZoneId

/**
 * The offline queues — the watch's only defence against losing progress it can't
 * upload yet.
 *
 * Two properties are load-bearing and neither is observable on the device:
 *  - a PARTIAL flush must never drop what the server didn't take, and
 *  - the two payload shapes must match ABS exactly, because a rejected body is
 *    indistinguishable from "nothing was listened".
 *
 * Robolectric for org.json and DataStore's codec; the clock and zone are
 * injected so day keying is deterministic rather than "whatever today is".
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class OfflineProgressQueueTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var creds: CredsRepository
    private var now = INSTANT_2026_08_24_NOON

    private fun queue() = OfflineProgressQueue(
        credsRepository = creds,
        clock = { now },
        zone = { ZoneId.of("UTC") },
        clientVersion = { "1.2.3" }
    )

    @Before
    fun setUp() {
        // One store per test over its own temp file — DataStore treats two live
        // instances on one file as an error, not a merge.
        val file = File(tempFolder.root, "wear.preferences_pb")
        creds = CredsRepository(PreferenceDataStoreFactory.create(produceFile = { file }))
        now = INSTANT_2026_08_24_NOON
    }

    private class FakeUploader(
        var positionsSucceed: Boolean = true,
        var daySucceeds: (String) -> Boolean = { true }
    ) : OfflineProgressQueue.Uploader {
        val batches = ArrayList<JSONArray>()
        val days = ArrayList<JSONObject>()

        override suspend fun batchUpdateProgress(payloads: JSONArray): Boolean {
            batches.add(payloads)
            return positionsSucceed
        }

        override suspend fun syncLocalSession(body: JSONObject): Boolean {
            days.add(body)
            return daySucceeds(body.getString("id"))
        }
    }

    private suspend fun OfflineProgressQueue.listen(
        itemId: String,
        episodeId: String? = null,
        currentTime: Double,
        duration: Double = 3600.0,
        seconds: Double,
        title: String = "Dune",
        author: String? = "Frank Herbert"
    ) = record(
        itemId = itemId,
        episodeId = episodeId,
        currentTime = currentTime,
        duration = duration,
        secondsListened = seconds,
        title = title,
        author = author,
        mediaType = "book",
        persistResume = true
    )

    // ---- merge semantics ---------------------------------------------------

    @Test
    fun theLatestPositionWinsPerItem() = runBlocking {
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)
        queue.listen("li_1", currentTime = 25.0, seconds = 15.0)

        val uploader = FakeUploader()
        queue.flush(uploader)

        val batch = uploader.batches.single()
        assertEquals(1, batch.length())
        assertEquals(25.0, batch.getJSONObject(0).getDouble("currentTime"), 1e-9)
    }

    @Test
    fun episodesQueueIndependentlyOfTheirPodcast() = runBlocking {
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 5.0)
        queue.listen("li_1", episodeId = "ep_9", currentTime = 40.0, seconds = 5.0)

        val uploader = FakeUploader()
        queue.flush(uploader)

        val batch = uploader.batches.single()
        assertEquals(2, batch.length())
        val byEpisode = (0 until batch.length())
            .map { batch.getJSONObject(it) }
            .associateBy { it.optString("episodeId", "") }
        assertEquals(10.0, byEpisode[""]!!.getDouble("currentTime"), 1e-9)
        assertEquals(40.0, byEpisode["ep_9"]!!.getDouble("currentTime"), 1e-9)
        // The two day records are separate too.
        assertEquals(2, uploader.days.size)
    }

    @Test
    fun listeningTimeAccumulatesIntoOneRecordPerItemAndDay() = runBlocking {
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)
        queue.listen("li_1", currentTime = 25.0, seconds = 15.0)
        queue.listen("li_1", currentTime = 40.0, seconds = 15.0)

        val uploader = FakeUploader()
        queue.flush(uploader)

        val record = uploader.days.single()
        assertEquals("wear-local_li_1_2026-08-24", record.getString("id"))
        assertEquals(40.0, record.getDouble("timeListening"), 1e-9)
    }

    @Test
    fun crossingMidnightStartsANewDayRecord() = runBlocking {
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)
        now = INSTANT_2026_08_25_ONE_AM
        queue.listen("li_1", currentTime = 30.0, seconds = 20.0)

        val uploader = FakeUploader()
        queue.flush(uploader)

        val ids = uploader.days.map { it.getString("id") }.sorted()
        assertEquals(listOf("wear-local_li_1_2026-08-24", "wear-local_li_1_2026-08-25"), ids)
    }

    @Test
    fun theDayIdCarriesTheWearPrefixAndTheEpisode() {
        // The prefix is not decoration: the PHONE writes `local_<item>_<date>`
        // for the same item+day, ABS upserts by id, and a shared id would let one
        // device's total REPLACE the other's.
        assertEquals(
            "wear-local_li_1_2026-08-24",
            OfflineProgressQueue.dayId("li_1", null, "2026-08-24")
        )
        assertEquals(
            "wear-local_li_1-ep_9_2026-08-24",
            OfflineProgressQueue.dayId("li_1", "ep_9", "2026-08-24")
        )
    }

    // ---- payload shapes ----------------------------------------------------

    @Test
    fun thePositionPayloadIsExactlyTheBatchRouteShape() = runBlocking {
        val queue = queue()
        queue.listen("li_1", episodeId = "ep_9", currentTime = 900.0, duration = 3600.0, seconds = 30.0)

        val uploader = FakeUploader()
        queue.flush(uploader)

        val payload = uploader.batches.single().getJSONObject(0)
        assertEquals(
            setOf("libraryItemId", "episodeId", "currentTime", "duration", "progress"),
            payload.keys().asSequence().toSet()
        )
        assertEquals("li_1", payload.getString("libraryItemId"))
        assertEquals("ep_9", payload.getString("episodeId"))
        assertEquals(900.0, payload.getDouble("currentTime"), 1e-9)
        assertEquals(3600.0, payload.getDouble("duration"), 1e-9)
        assertEquals(0.25, payload.getDouble("progress"), 1e-9)
    }

    @Test
    fun aPositionWithNoKnownDurationOmitsDurationAndProgress() = runBlocking {
        // Sending duration 0 would overwrite the server's real one and zero the
        // item's progress on every device.
        val queue = queue()
        queue.listen("li_1", currentTime = 900.0, duration = 0.0, seconds = 30.0)

        val uploader = FakeUploader()
        queue.flush(uploader)

        val payload = uploader.batches.single().getJSONObject(0)
        assertEquals(setOf("libraryItemId", "currentTime"), payload.keys().asSequence().toSet())
    }

    @Test
    fun theLocalSessionPayloadIsExactlyTheContractsFieldList() = runBlocking {
        val queue = queue()
        queue.listen("li_1", currentTime = 900.0, duration = 3600.0, seconds = 45.0)

        val uploader = FakeUploader()
        queue.flush(uploader)

        val body = uploader.days.single()
        assertEquals(
            setOf(
                "id", "libraryItemId", "mediaType", "displayTitle", "displayAuthor",
                "duration", "playMethod", "mediaPlayer", "deviceInfo", "date",
                "dayOfWeek", "timeListening", "currentTime", "startedAt", "updatedAt"
            ),
            body.keys().asSequence().toSet()
        )
        assertEquals("wear-local_li_1_2026-08-24", body.getString("id"))
        assertEquals("li_1", body.getString("libraryItemId"))
        assertEquals("book", body.getString("mediaType"))
        assertEquals("Dune", body.getString("displayTitle"))
        assertEquals("Frank Herbert", body.getString("displayAuthor"))
        assertEquals(3600.0, body.getDouble("duration"), 1e-9)
        // PlayMethod.LOCAL — the file came off the device, not the server.
        assertEquals(3, body.getInt("playMethod"))
        assertEquals("exo-player", body.getString("mediaPlayer"))
        assertEquals("2026-08-24", body.getString("date"))
        assertEquals("Monday", body.getString("dayOfWeek"))
        assertEquals(45.0, body.getDouble("timeListening"), 1e-9)
        assertEquals(900.0, body.getDouble("currentTime"), 1e-9)

        // deviceInfo must describe the SAME device as the /play body, or ABS
        // files this watch's stats under two devices.
        val deviceInfo = body.getJSONObject("deviceInfo")
        assertEquals("TomeSonic Wear", deviceInfo.getString("clientName"))
        assertEquals("1.2.3", deviceInfo.getString("clientVersion"))
        assertTrue(deviceInfo.getString("deviceId").isNotBlank())
    }

    @Test
    fun theInternalDeliveredMarkerNeverLeaksIntoTheBody() = runBlocking {
        // syncedTimeListening is bookkeeping, not an ABS field.
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)
        val uploader = FakeUploader()
        queue.flush(uploader)
        queue.listen("li_1", currentTime = 20.0, seconds = 10.0)
        queue.flush(uploader)

        assertTrue(uploader.days.none { it.has("syncedTimeListening") })
        // Stored, though — otherwise every flush would re-POST every record.
        assertTrue(creds.offlineSessions.first()!!.contains("syncedTimeListening"))
    }

    // ---- partial flush -----------------------------------------------------

    @Test
    fun aRejectedBatchLeavesEveryPositionQueued() = runBlocking {
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)

        val failing = FakeUploader(positionsSucceed = false)
        assertFalse(queue.flush(failing))

        val retry = FakeUploader()
        assertTrue(queue.flush(retry))
        assertEquals(1, retry.batches.single().length())
        assertEquals(10.0, retry.batches.single().getJSONObject(0).getDouble("currentTime"), 1e-9)
    }

    @Test
    fun acceptedPositionsAreNotResentWhileARejectedDayRecordIs() = runBlocking {
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)

        val partial = FakeUploader(positionsSucceed = true, daySucceeds = { false })
        assertFalse(queue.flush(partial))

        val retry = FakeUploader()
        assertTrue(queue.flush(retry))
        // Positions landed already; only the listening record is still owed.
        assertTrue(retry.batches.isEmpty())
        assertEquals(1, retry.days.size)
        assertEquals(10.0, retry.days.single().getDouble("timeListening"), 1e-9)
    }

    @Test
    fun aRejectedDayRecordIsResentWithItsGrownTotal() = runBlocking {
        // Re-sending a GROWN cumulative total is idempotent — ABS upserts by id
        // and REPLACES timeListening — which is what makes retrying safe.
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)
        assertFalse(queue.flush(FakeUploader(daySucceeds = { false })))

        queue.listen("li_1", currentTime = 40.0, seconds = 30.0)
        val retry = FakeUploader()
        assertTrue(queue.flush(retry))
        assertEquals(40.0, retry.days.single().getDouble("timeListening"), 1e-9)
    }

    @Test
    fun aPositionRecordedDuringTheFlushSurvivesIt() = runBlocking {
        // TOCTOU: the syncer keeps ticking while the PATCH is in flight, and
        // blind-clearing the queue afterwards would eat the newer position.
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)

        val racing = object : OfflineProgressQueue.Uploader {
            override suspend fun batchUpdateProgress(payloads: JSONArray): Boolean {
                now += 1_000
                queue.listen("li_1", currentTime = 99.0, seconds = 1.0)
                return true
            }

            override suspend fun syncLocalSession(body: JSONObject) = true
        }
        queue.flush(racing)

        val retry = FakeUploader()
        queue.flush(retry)
        assertEquals(99.0, retry.batches.single().getJSONObject(0).getDouble("currentTime"), 1e-9)
    }

    @Test
    fun aFullyDeliveredDayIsKeptWhileItIsTodayAndDroppedOnceItIsNot() = runBlocking {
        val queue = queue()
        queue.listen("li_1", currentTime = 10.0, seconds = 10.0)
        assertTrue(queue.flush(FakeUploader()))
        // Today's record stays so later listening keeps accumulating into the
        // SAME server session rather than restarting its total at zero.
        assertTrue(creds.offlineSessions.first()!!.contains("wear-local_li_1_2026-08-24"))

        now = INSTANT_2026_08_25_ONE_AM
        assertTrue(queue.flush(FakeUploader()))
        assertFalse(creds.offlineSessions.first()!!.contains("wear-local_li_1_2026-08-24"))
    }

    @Test
    fun anEmptyQueueFlushesSuccessfullyWithoutCallingTheServer() = runBlocking {
        val uploader = FakeUploader()
        assertTrue(queue().flush(uploader))
        assertTrue(uploader.batches.isEmpty())
        assertTrue(uploader.days.isEmpty())
    }

    // ---- local resume ------------------------------------------------------

    @Test
    fun theLocalResumeMarkerSurvivesAFlushThatEmptiesThePositionQueue() = runBlocking {
        // A downloaded book has no server session to resume from, so this marker
        // is the ONLY resume point — draining it with the positions would restart
        // every downloaded book from zero after one reconnect.
        val queue = queue()
        queue.listen("li_1", currentTime = 123.5, seconds = 10.0)
        assertTrue(queue.flush(FakeUploader()))
        assertEquals(123.5, queue.resumePosition("li_1", null)!!, 1e-9)
    }

    @Test
    fun resumeIsKeyedPerItemAndEpisodeAndIsNullUntilSomethingPlays() = runBlocking {
        val queue = queue()
        assertNull(queue.resumePosition("li_1", null))
        queue.setResume("li_1", null, 42.0)
        queue.setResume("li_1", "ep_9", 7.0)
        assertEquals(42.0, queue.resumePosition("li_1", null)!!, 1e-9)
        assertEquals(7.0, queue.resumePosition("li_1", "ep_9")!!, 1e-9)
        assertNull(queue.resumePosition("li_2", null))
    }

    // ---- robustness --------------------------------------------------------

    @Test
    fun aCorruptBlobReadsAsEmptyRatherThanThrowing() = runBlocking {
        creds.setOfflineSessions("{not json at all")
        val queue = queue()
        assertNull(queue.resumePosition("li_1", null))
        assertTrue(queue.flush(FakeUploader()))
        // And it recovers: the next write replaces the garbage.
        queue.listen("li_1", currentTime = 5.0, seconds = 5.0)
        assertEquals(5.0, queue.resumePosition("li_1", null)!!, 1e-9)
    }

    @Test
    fun nothingIsQueuedForASampleWithNoItemOrNoListening() = runBlocking {
        val queue = queue()
        queue.listen("", currentTime = 10.0, seconds = 10.0)
        queue.listen("li_1", currentTime = 10.0, seconds = 0.0)

        val uploader = FakeUploader()
        queue.flush(uploader)
        // The position still queues (a seek while paused is real progress); the
        // day record does not, because nothing was listened to.
        assertEquals(1, uploader.batches.single().length())
        assertTrue(uploader.days.isEmpty())
    }

    private companion object {
        /** 2026-08-24T12:00:00Z — a Monday, so dayOfWeek is checkable. */
        const val INSTANT_2026_08_24_NOON = 1787572800000L

        /** 2026-08-25T01:00:00Z — the next UTC day (a Tuesday). */
        const val INSTANT_2026_08_25_ONE_AM = 1787619600000L
    }
}
