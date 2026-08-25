package com.tomesonic.app.wear

import android.app.Application
import com.tomesonic.app.wear.playback.DownloadsLocalSource
import com.tomesonic.app.wear.playback.OfflineProgressQueue
import com.tomesonic.app.wear.playback.PlaybackWiring
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

// No notification channel here: media3's DefaultMediaNotificationProvider
// creates its own, and PlaybackService keeps the stock provider (see its
// header). A channel declared twice is a second, empty entry in Settings.
class MainApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
        // Composition seam: playback resolves downloaded books ONLY through this
        // plug (see DownloadsLocalSource). Installed synchronously — the process
        // always runs Application.onCreate before PlaybackService can resolve
        // anything, including cold starts from the media session.
        PlaybackWiring.localSource = DownloadsLocalSource(Graph.downloadRepository)
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            // Seed the download index into memory FIRST: the plug above answers
            // from the in-memory snapshot, and before this warm() a downloaded
            // book would resolve as "not downloaded" and stream.
            Graph.downloadRepository.warm()
            // DataLayerListenerService only fires on CHANGES, so a watch app
            // installed (or first opened) after the phone already logged in would
            // never receive credentials. Read whatever DataItem is already on the
            // node at every start; it's a no-op when the listener has already run.
            Graph.credsRepository.refreshFromDataLayer(this@MainApplication)
            // Flush trigger: app start. Progress banked while offline reaches the
            // server on the next launch even if the user never opens the player
            // (PlaybackService's own start/reconnect triggers only fire once
            // something plays). Ordered AFTER the creds read — a flush with no
            // token can only fail.
            OfflineProgressQueue.shared.flush(Graph.absApi)
        }
    }
}
