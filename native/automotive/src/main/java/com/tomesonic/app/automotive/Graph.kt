package com.tomesonic.app.automotive

import android.content.Context
import com.tomesonic.app.automotive.data.AbsApi
import com.tomesonic.app.automotive.data.AbsClient
import com.tomesonic.app.automotive.data.CredsRepository
import com.tomesonic.app.automotive.downloads.DownloadRepository

/**
 * The whole dependency graph: lazy singletons behind an application Context.
 * No Hilt, no Koin — the object count here is small enough that a DI framework
 * would cost more (annotation processing on every build) than it saves.
 *
 * Deliberately dumb: construction only. Anything that needs a lifecycle
 * (collectors, connections) owns its own scope.
 *
 * Declares only what has landed. Waves append; nothing here is reordered,
 * because a lazy singleton's construction order is the one thing a reader of
 * this file is entitled to take at face value.
 */
object Graph {

    @Volatile
    private var appContext: Context? = null

    /**
     * Called from [MainApplication.onCreate], and defensively from any component
     * the system can start on its own — AbsLibraryService is bound directly by
     * the car's Media Center, and Wave 3's browse paths resolve the graph from
     * inside it. Idempotent.
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
     * The car apk's versionName, read from PackageManager rather than
     * BuildConfig: `buildFeatures.buildConfig` defaults to FALSE under AGP 8,
     * and the only thing that turns it on in this project is React Native's
     * Gradle plugin — which :app applies and :automotive does not. PackageManager
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
     * On-car downloads: the index file plus `filesDir/downloads`. Lazy like
     * everything else here — DownloadWorker resolves it in whatever process
     * WorkManager starts it in, and nothing reads the index until asked.
     *
     * SessionManager and ProgressSyncer are deliberately NOT here, mirroring the
     * donor's Graph: both take the media3 Player as a constructor argument, so
     * they can only be built where the player is — AbsLibraryService.onCreate,
     * which owns the player's lifetime. What they DO resolve from this graph are
     * their own defaults (absApi, absClient, credsRepository), so the service
     * constructs them with three arguments and nothing else.
     */
    val downloadRepository: DownloadRepository by lazy { DownloadRepository.create(context) }

    private const val FALLBACK_VERSION = "0"
}
