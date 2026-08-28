package com.tomesonic.app.automotive

import android.app.Application

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
 * declared twice is a second, empty entry in the car's app settings.
 *
 * Wave 3 adds what the donor does alongside this call — seeding the download
 * index before anything can resolve a downloaded book, and flushing the offline
 * progress queue on start. Neither exists yet, and a warm() of nothing would
 * only be a lie in a stack trace.
 */
class MainApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
    }
}
