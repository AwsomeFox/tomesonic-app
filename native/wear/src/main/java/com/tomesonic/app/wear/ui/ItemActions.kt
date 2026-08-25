package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.data.PodcastEpisode
import com.tomesonic.app.wear.downloads.DownloadStatus
import com.tomesonic.app.wear.playback.PlayResult

/** What tapping a download chip asks the repository to do. */
enum class DownloadCommand {
    /** `enqueue(id)` — the default constraints: charger + unmetered network. */
    Enqueue,

    /** `enqueue(id, force = true)` — drop the charger, accept any connection. */
    EnqueueNow,

    Cancel,

    /** Two taps on the item screen; the confirm step lives in the composable. */
    Delete
}

data class DownloadOption(val label: String, val command: DownloadCommand)

/**
 * One download state, fully rendered: a state line, a progress value when a bar
 * belongs on screen, and up to two chips.
 */
data class DownloadUi(
    val headline: String?,
    val progress: Int?,
    val primary: DownloadOption?,
    val secondary: DownloadOption?
)

/**
 * The item screen's two decision tables — what a download state offers, and what
 * a failed play attempt says.
 *
 * Both are pure so the whole matrix is a test rather than five hand-driven trips
 * through a real download queue.
 */
object ItemActions {

    /**
     * DownloadStatus -> labels + commands.
     *
     * "Download now" appears on three of the five states on purpose: the default
     * constraints (charger + WiFi, see DownloadRepository.enqueue) mean a normal
     * tap can sit there for hours, and the escape hatch has to be reachable from
     * the state where the user notices — which is Queued, not NotDownloaded.
     *
     * Downloaded shows the size because that is the number a delete decision is
     * made on; every other state has no size to show yet.
     */
    fun forStatus(status: DownloadStatus, bytes: Long?): DownloadUi = when (status) {
        DownloadStatus.NotDownloaded -> DownloadUi(
            headline = null,
            progress = null,
            primary = DownloadOption("Download", DownloadCommand.Enqueue),
            secondary = DownloadOption("Download now", DownloadCommand.EnqueueNow)
        )

        DownloadStatus.Queued -> DownloadUi(
            headline = "Waiting for charger + Wi-Fi",
            progress = null,
            primary = DownloadOption("Cancel", DownloadCommand.Cancel),
            secondary = DownloadOption("Download now", DownloadCommand.EnqueueNow)
        )

        is DownloadStatus.Downloading -> DownloadUi(
            headline = "Downloading ${status.progress}%",
            progress = status.progress.coerceIn(0, 100),
            primary = DownloadOption("Cancel", DownloadCommand.Cancel),
            secondary = null
        )

        DownloadStatus.Downloaded -> DownloadUi(
            headline = bytes?.takeIf { it > 0L }?.let { "Downloaded · ${UiFormat.bytes(it)}" }
                ?: "Downloaded",
            progress = null,
            primary = DownloadOption("Delete", DownloadCommand.Delete),
            secondary = null
        )

        DownloadStatus.Failed -> DownloadUi(
            headline = "Download failed",
            progress = null,
            primary = DownloadOption("Retry", DownloadCommand.Enqueue),
            secondary = DownloadOption("Download now", DownloadCommand.EnqueueNow)
        )
    }

    /**
     * Why a play attempt would fail, decided BEFORE asking for it.
     *
     * PlayerConnection.playItem is deliberately fire-and-forget (the service
     * answers the custom command immediately and resolves the session in the
     * background — see PlaybackService.onCustomCommand), so the UI's only door
     * to playback cannot hand a [PlayResult] back. Rather than invent a second
     * door, the screen re-derives the same three failures from the same three
     * facts SessionManager.resolve checks, in SessionManager's own order:
     * downloaded wins over everything, then credentials, then the fetch, then
     * the track list.
     *
     * A wrong guess costs a message, never a missed playback: everything except
     * [PlayResult.Ok] is a case where SessionManager would have failed too.
     */
    fun precheck(
        hasCreds: Boolean,
        downloaded: Boolean,
        detailLoaded: Boolean,
        trackCount: Int,
        isEpisode: Boolean = false
    ): PlayResult = when {
        // A podcast EPISODE never consults the item facts: its audio lives on
        // the episode row, not the item's track list (a podcast's item-level
        // trackCount is legitimately 0), and episodes always stream in v1
        // (downloads are book-only), so `downloaded` must not short-circuit to
        // Ok either — SessionManager streams episodes even when the item has a
        // download. The only thing streaming needs up front is credentials.
        isEpisode && !hasCreds -> PlayResult.NotConfigured
        isEpisode -> PlayResult.Ok
        // A downloaded book plays with no network and no token at all.
        downloaded -> PlayResult.Ok
        !hasCreds -> PlayResult.NotConfigured
        !detailLoaded -> PlayResult.NeedsNetwork
        trackCount <= 0 -> PlayResult.NoTracks
        else -> PlayResult.Ok
    }

    /** The sentence for a failure. Null for [PlayResult.Ok] — nothing to say. */
    fun message(result: PlayResult): String? = when (result) {
        PlayResult.Ok -> null
        PlayResult.NeedsNetwork -> "Connect to stream"
        PlayResult.NoTracks -> "No audio in this item"
        PlayResult.NotConfigured -> "Connect from your phone"
    }

    /** A podcast's newest episodes. More than this is a phone's job, not a watch's. */
    const val MAX_EPISODES = 10

    /**
     * Newest first. ABS returns episodes in publish order for some feeds and
     * ingest order for others, so the sort is ours; an episode with no
     * publishedAt sorts last rather than first, because an unknown date is far
     * more often a broken row than a brand new one.
     */
    fun recentEpisodes(
        episodes: List<PodcastEpisode>,
        cap: Int = MAX_EPISODES
    ): List<PodcastEpisode> = episodes
        .sortedByDescending { it.publishedAt ?: Long.MIN_VALUE }
        .take(cap)
}
