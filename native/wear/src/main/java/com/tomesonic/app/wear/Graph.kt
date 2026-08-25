package com.tomesonic.app.wear

import android.content.Context
import com.tomesonic.app.wear.data.AbsApi
import com.tomesonic.app.wear.data.AbsClient
import com.tomesonic.app.wear.data.CredsRepository
import com.tomesonic.app.wear.downloads.DownloadRepository

/**
 * The whole dependency graph: lazy singletons behind an application Context.
 * No Hilt, no Koin — the object count here is small enough that a DI framework
 * would cost more (annotation processing on every build) than it saves.
 *
 * Deliberately dumb: construction only. Anything that needs a lifecycle
 * (collectors, connections) owns its own scope.
 */
object Graph {

    @Volatile
    private var appContext: Context? = null

    /**
     * Called from MainApplication.onCreate, and defensively from any component
     * the system can start on its own (the Data Layer listener). Idempotent.
     */
    fun init(context: Context) {
        if (appContext == null) {
            synchronized(this) {
                if (appContext == null) appContext = context.applicationContext
            }
        }
    }

    private val context: Context
        get() = appContext
            ?: throw IllegalStateException("Graph.init(context) must run before the graph is used")

    /**
     * The wear apk's versionName, read from PackageManager rather than
     * BuildConfig: `buildFeatures.buildConfig` defaults to FALSE under AGP 8,
     * and the only thing that turns it on in this project is React Native's
     * Gradle plugin — which :app applies and :wear does not. PackageManager
     * returns the same derived version (phone versionName, see build.gradle)
     * with no build-file change.
     */
    val versionName: String by lazy {
        try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
                ?: FALLBACK_VERSION
        } catch (t: Throwable) {
            FALLBACK_VERSION
        }
    }

    val credsRepository: CredsRepository by lazy { CredsRepository.create(context) }

    val absClient: AbsClient by lazy {
        AbsClient(credsRepository, "${AbsClient.DEFAULT_USER_AGENT}/$versionName")
    }

    val absApi: AbsApi by lazy { AbsApi(absClient, credsRepository, versionName) }

    /**
     * On-watch downloads: the index file plus `filesDir/downloads`. Lazy like
     * everything else here — DownloadWorker resolves it in whatever process
     * WorkManager starts it in, and nothing reads the index until asked.
     */
    val downloadRepository: DownloadRepository by lazy { DownloadRepository.create(context) }

    private const val FALLBACK_VERSION = "0"
}
