package com.tomesonic.app.automotive

import android.app.Application
import com.tomesonic.app.automotive.playback.DownloadsLocalSource
import com.tomesonic.app.automotive.playback.OfflineProgressQueue
import com.tomesonic.app.automotive.playback.PlaybackWiring
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The process entry point, and the reason [Graph] can assume a Context.
 *
 * Mirrors :wear's MainApplication, which is where that module calls
 * [Graph.init]. The car has no launcher activity at all (ARCHITECTURE.md §5),
 * so every start of this process is a bind or a start of AbsLibraryService by
 * the Media Center — and Application.onCreate still runs first in every one of
 * them, which is exactly the property that makes a single init site enough.
 *
 * No notification channel here: media3 creates its own default channel, and one
 * declared twice is a second, empty entry in the car's app settings. (The
 * downloads channel is DownloadWorker's, created where it posts — WorkManager
 * can start that worker in a process that never reached this method.)
 */
class MainApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
        // Composition seam: playback resolves downloaded books ONLY through this
        // plug (see DownloadsLocalSource). Installed synchronously — the process
        // always runs Application.onCreate before AbsLibraryService can resolve
        // anything, including the cold start the Media Center triggers by
        // binding.
        PlaybackWiring.localSource = DownloadsLocalSource(Graph.downloadRepository)
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            // Seed the download index into memory FIRST: the plug above answers
            // from the in-memory snapshot, and before this warm() a downloaded
            // book would resolve as "not downloaded" and stream.
            Graph.downloadRepository.warm()
            // Flush trigger: app start. Progress banked while the car was out of
            // coverage reaches the server on the next start even if nothing is
            // played this trip — the service's own start/reconnect triggers only
            // fire once something plays.
            //
            // The donor reads credentials off the phone's Data Layer between
            // these two calls; there is no phone here, and CredsRepository is
            // already the only source (§3, §6), so the flush follows the warm
            // directly.
            OfflineProgressQueue.shared.flush(Graph.absApi)
        }
    }
}
