package com.tomesonic.app.wear

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

// Wave 3A adds the playback notification channel here.
class MainApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
        // DataLayerListenerService only fires on CHANGES, so a watch app
        // installed (or first opened) after the phone already logged in would
        // never receive credentials. Read whatever DataItem is already on the
        // node at every start; it's a no-op when the listener has already run.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            Graph.credsRepository.refreshFromDataLayer(this@MainApplication)
        }
    }
}
