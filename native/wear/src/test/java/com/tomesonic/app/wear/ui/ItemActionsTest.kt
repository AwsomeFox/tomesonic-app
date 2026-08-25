package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.PodcastEpisode
import com.tomesonic.app.wear.downloads.DownloadStatus
import com.tomesonic.app.wear.playback.PlayResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The item screen's decision tables, as tables.
 *
 * The download half exists because five states × two chips is exactly the kind
 * of matrix that rots one cell at a time; the play half exists because those
 * three sentences are the ONLY thing the watch can say about a failure, and each
 * has to keep pointing at the right fix.
 */
class ItemActionsTest {

    private val oneGigabyte = 1_288_490_188L

    // ---- download states ----------------------------------------------------

    @Test
    fun notDownloadedOffersBothWaysToStart() {
        val ui = ItemActions.forStatus(DownloadStatus.NotDownloaded, null)
        assertNull(ui.headline)
        assertNull(ui.progress)
        assertEquals("Download", ui.primary?.label)
        assertEquals(DownloadCommand.Enqueue, ui.primary?.command)
        assertEquals("Download now", ui.secondary?.label)
        assertEquals(DownloadCommand.EnqueueNow, ui.secondary?.command)
    }

    @Test
    fun queuedExplainsWhatItIsWaitingForAndOffersTheEscapeHatch() {
        // The default constraints are charger + unmetered network, so "queued"
        // can mean hours. Cancel and force must both be reachable from here.
        val ui = ItemActions.forStatus(DownloadStatus.Queued, null)
        assertEquals("Waiting for charger + Wi-Fi", ui.headline)
        assertEquals(DownloadCommand.Cancel, ui.primary?.command)
        assertEquals(DownloadCommand.EnqueueNow, ui.secondary?.command)
    }

    @Test
    fun downloadingShowsAPercentageAndOnlyCancel() {
        val ui = ItemActions.forStatus(DownloadStatus.Downloading(42), null)
        assertEquals("Downloading 42%", ui.headline)
        assertEquals(42, ui.progress)
        assertEquals(DownloadCommand.Cancel, ui.primary?.command)
        assertNull(ui.secondary)
    }

    @Test
    fun aProgressOutsideZeroToOneHundredStillDrawsABar() {
        assertEquals(100, ItemActions.forStatus(DownloadStatus.Downloading(140), null).progress)
        assertEquals(0, ItemActions.forStatus(DownloadStatus.Downloading(-5), null).progress)
        // The HEADLINE clamps too — "Downloading 140%" next to a bar pinned at
        // 100 is the inconsistency this test exists to keep out.
        assertEquals("Downloading 100%", ItemActions.forStatus(DownloadStatus.Downloading(140), null).headline)
        assertEquals("Downloading 0%", ItemActions.forStatus(DownloadStatus.Downloading(-5), null).headline)
    }

    @Test
    fun downloadedShowsTheSizeTheDeleteDecisionNeeds() {
        val ui = ItemActions.forStatus(DownloadStatus.Downloaded, oneGigabyte)
        assertEquals("Downloaded · 1.2 GB", ui.headline)
        assertEquals(DownloadCommand.Delete, ui.primary?.command)
        assertNull(ui.secondary)
    }

    @Test
    fun downloadedWithNoRecordedSizeStillReadsAsDownloaded() {
        assertEquals("Downloaded", ItemActions.forStatus(DownloadStatus.Downloaded, null).headline)
        assertEquals("Downloaded", ItemActions.forStatus(DownloadStatus.Downloaded, 0L).headline)
    }

    @Test
    fun failedOffersRetryFirstAndForceSecond() {
        val ui = ItemActions.forStatus(DownloadStatus.Failed, null)
        assertEquals("Download failed", ui.headline)
        assertEquals("Retry", ui.primary?.label)
        assertEquals(DownloadCommand.Enqueue, ui.primary?.command)
        assertEquals(DownloadCommand.EnqueueNow, ui.secondary?.command)
    }

    // ---- play precheck ------------------------------------------------------

    @Test
    fun aDownloadedBookPlaysWithNoServerAndNoToken() {
        assertEquals(
            PlayResult.Ok,
            ItemActions.precheck(hasCreds = false, downloaded = true, detailLoaded = false, trackCount = 0)
        )
    }

    @Test
    fun noCredentialsIsNotConfigured() {
        assertEquals(
            PlayResult.NotConfigured,
            ItemActions.precheck(hasCreds = false, downloaded = false, detailLoaded = true, trackCount = 3)
        )
    }

    @Test
    fun aFetchThatNeverArrivedNeedsNetwork() {
        assertEquals(
            PlayResult.NeedsNetwork,
            ItemActions.precheck(hasCreds = true, downloaded = false, detailLoaded = false, trackCount = 0)
        )
    }

    @Test
    fun anItemWithNoAudioHasNoTracks() {
        assertEquals(
            PlayResult.NoTracks,
            ItemActions.precheck(hasCreds = true, downloaded = false, detailLoaded = true, trackCount = 0)
        )
    }

    @Test
    fun aStreamableBookIsOk() {
        assertEquals(
            PlayResult.Ok,
            ItemActions.precheck(hasCreds = true, downloaded = false, detailLoaded = true, trackCount = 12)
        )
    }

    // A podcast's ITEM-level track list is legitimately empty (audio lives on
    // the episode rows), so episode taps must never be judged by trackCount —
    // the original table rejected every episode with NoTracks.

    @Test
    fun anEpisodeWithZeroItemTracksIsOk() {
        assertEquals(
            PlayResult.Ok,
            ItemActions.precheck(
                hasCreds = true, downloaded = false, detailLoaded = true,
                trackCount = 0, isEpisode = true
            )
        )
    }

    @Test
    fun anEpisodeWithoutCredsStillNeedsThePhone() {
        assertEquals(
            PlayResult.NotConfigured,
            ItemActions.precheck(
                hasCreds = false, downloaded = false, detailLoaded = true,
                trackCount = 0, isEpisode = true
            )
        )
    }

    @Test
    fun anEpisodeIgnoresTheItemsDownloadedState() {
        // The ITEM's download says nothing about THIS episode — they are
        // separate entries, and SessionManager resolves the episode's own.
        assertEquals(
            PlayResult.NotConfigured,
            ItemActions.precheck(
                hasCreds = false, downloaded = true, detailLoaded = true,
                trackCount = 0, isEpisode = true
            )
        )
    }

    @Test
    fun aDownloadedEpisodePlaysWithNoServerAndNoToken() {
        // The book rule, for episodes: SessionManager plays the entry off the
        // watch before it looks at credentials, so the screen must not refuse
        // first. This is the row that made `episodeDownloaded` exist.
        assertEquals(
            PlayResult.Ok,
            ItemActions.precheck(
                hasCreds = false, downloaded = false, detailLoaded = false,
                trackCount = 0, isEpisode = true, episodeDownloaded = true
            )
        )
    }

    @Test
    fun aDownloadedEpisodeIsOkWhateverTheItemLooksLike() {
        assertEquals(
            PlayResult.Ok,
            ItemActions.precheck(
                hasCreds = true, downloaded = false, detailLoaded = true,
                trackCount = 0, isEpisode = true, episodeDownloaded = true
            )
        )
    }

    @Test
    fun aDownloadedEpisodeSaysNothingAboutTheBook() {
        // `episodeDownloaded` is per-EPISODE state and must never leak into the
        // item's own play decision (a podcast is not playable as a book).
        assertEquals(
            PlayResult.NotConfigured,
            ItemActions.precheck(
                hasCreds = false, downloaded = false, detailLoaded = true,
                trackCount = 3, isEpisode = false, episodeDownloaded = true
            )
        )
    }

    @Test
    fun anEpisodeThatIsNotDownloadedStillNeedsThePhone() {
        // The default keeps every existing caller (and every other episode row)
        // on the streaming rule.
        assertEquals(
            PlayResult.NotConfigured,
            ItemActions.precheck(
                hasCreds = false, downloaded = false, detailLoaded = true,
                trackCount = 0, isEpisode = true, episodeDownloaded = false
            )
        )
    }

    @Test
    fun everyFailureHasExactlyOneSentenceAndSuccessHasNone() {
        assertNull(ItemActions.message(PlayResult.Ok))
        assertEquals("Connect to stream", ItemActions.message(PlayResult.NeedsNetwork))
        assertEquals("No audio in this item", ItemActions.message(PlayResult.NoTracks))
        assertEquals("Connect from your phone", ItemActions.message(PlayResult.NotConfigured))
    }

    // ---- podcast episodes ---------------------------------------------------

    @Test
    fun episodesComeBackNewestFirstAndCapped() {
        val episodes = (1..15).map {
            PodcastEpisode(id = "ep$it", title = "Episode $it", publishedAt = it.toLong(), duration = 600.0)
        }
        val recent = ItemActions.recentEpisodes(episodes)
        assertEquals(ItemActions.MAX_EPISODES, recent.size)
        assertEquals("ep15", recent.first().id)
        assertEquals("ep6", recent.last().id)
    }

    @Test
    fun anEpisodeWithNoPublishDateSortsLastRatherThanFirst() {
        val episodes = listOf(
            PodcastEpisode(id = "unknown", title = "Unknown", publishedAt = null, duration = null),
            PodcastEpisode(id = "old", title = "Old", publishedAt = 10L, duration = null),
            PodcastEpisode(id = "new", title = "New", publishedAt = 20L, duration = null)
        )
        assertEquals(
            listOf("new", "old", "unknown"),
            ItemActions.recentEpisodes(episodes).map { it.id }
        )
    }
}
